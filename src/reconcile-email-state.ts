import { gmail_v1 } from 'googleapis';

export type EmailResponseState =
  | 'RESPONDED'
  | 'UNRESPONDED_PROVEN'
  | 'UNRESPONDED_NOT_ESTABLISHED'
  | 'NO_OBLIGATION_DETECTED';

export interface ReconcileEmailInput {
  messageId: string;
  sentInventoryComplete?: boolean;
  maxCrossThreadResults?: number;
}

export interface ReconcileEmailResult {
  inboundMessageId: string;
  threadId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  obligationDetected: boolean;
  obligationSignals: string[];
  priorOutboundMessageId?: string;
  priorOutboundAt?: string;
  recipientResponseLatencySeconds?: number;
  ourResponseMessageId?: string;
  ourResponseAt?: string;
  ourResponseLatencySeconds?: number;
  responseState: EmailResponseState;
  evidenceBasis: string[];
  newSearchRequired: boolean;
}

const OBLIGATION_PATTERNS: Array<[string, RegExp]> = [
  ['please-confirm', /\bplease\s+confirm\b/i],
  ['confirm-receipt', /\bconfirm\s+receipt\b/i],
  ['please-reply', /\bplease\s+(?:reply|respond|advise|provide|send|let me know)\b/i],
  ['action-required', /\baction required\b/i],
  ['would-you-please', /\bwould you please\b/i],
];

function header(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBase64Url(data?: string | null): string {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function extractBody(part?: gmail_v1.Schema$MessagePart | null): string {
  if (!part) return '';
  let text = '';
  if (part.mimeType === 'text/plain' && part.body?.data) text += decodeBase64Url(part.body.data);
  if (part.parts) text += part.parts.map(extractBody).join('\n');
  if (!text && part.body?.data) text += decodeBase64Url(part.body.data);
  return text;
}

function normalizeSubject(subject: string): string {
  return subject.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
}

function emailAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return (angle ? angle[1] : value).trim().toLowerCase();
}

function parseInternalDate(message: gmail_v1.Schema$Message): number {
  if (message.internalDate) return Number(message.internalDate);
  const date = Date.parse(header(message, 'date'));
  return Number.isFinite(date) ? date : 0;
}

function asIso(ms: number): string {
  return new Date(ms).toISOString();
}

async function getFull(gmail: gmail_v1.Gmail, id: string): Promise<gmail_v1.Schema$Message> {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return res.data;
}

async function profileEmail(gmail: gmail_v1.Gmail): Promise<string> {
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return (profile.data.emailAddress || '').toLowerCase();
}

export async function reconcileEmailObligation(
  gmail: gmail_v1.Gmail,
  input: ReconcileEmailInput,
): Promise<ReconcileEmailResult> {
  const inbound = await getFull(gmail, input.messageId);
  const me = await profileEmail(gmail);
  const subject = header(inbound, 'subject');
  const senderRaw = header(inbound, 'from');
  const sender = emailAddress(senderRaw);
  const receivedMs = parseInternalDate(inbound);
  const body = extractBody(inbound.payload);
  const searchableText = `${subject}\n${body}`;
  const obligationSignals = OBLIGATION_PATTERNS.filter(([, p]) => p.test(searchableText)).map(([name]) => name);
  const obligationDetected = obligationSignals.length > 0;
  const evidenceBasis: string[] = [`inbound:${input.messageId}`];

  const result: ReconcileEmailResult = {
    inboundMessageId: input.messageId,
    threadId: inbound.threadId || '',
    subject,
    sender,
    receivedAt: asIso(receivedMs),
    obligationDetected,
    obligationSignals,
    responseState: obligationDetected ? 'UNRESPONDED_NOT_ESTABLISHED' : 'NO_OBLIGATION_DETECTED',
    evidenceBasis,
    newSearchRequired: false,
  };

  if (!obligationDetected) return result;

  // First: exact thread chronology. This is the highest-confidence evidence.
  if (inbound.threadId) {
    const thread = await gmail.users.threads.get({ userId: 'me', id: inbound.threadId, format: 'full' });
    const messages = (thread.data.messages || []).sort((a, b) => parseInternalDate(a) - parseInternalDate(b));
    const priorSentMessages = messages.filter(m =>
      (m.labelIds || []).includes('SENT') && parseInternalDate(m) < receivedMs
    );
    const priorSent = priorSentMessages.length > 0 ? priorSentMessages[priorSentMessages.length - 1] : undefined;
    if (priorSent?.id) {
      const priorMs = parseInternalDate(priorSent);
      result.priorOutboundMessageId = priorSent.id;
      result.priorOutboundAt = asIso(priorMs);
      result.recipientResponseLatencySeconds = Math.max(0, Math.round((receivedMs - priorMs) / 1000));
      evidenceBasis.push(`prior-outbound-thread:${priorSent.id}`);
    }

    const laterSent = messages.find(m =>
      (m.labelIds || []).includes('SENT') && parseInternalDate(m) > receivedMs
    );
    if (laterSent?.id) {
      const sentMs = parseInternalDate(laterSent);
      result.ourResponseMessageId = laterSent.id;
      result.ourResponseAt = asIso(sentMs);
      result.ourResponseLatencySeconds = Math.max(0, Math.round((sentMs - receivedMs) / 1000));
      result.responseState = 'RESPONDED';
      result.newSearchRequired = false;
      evidenceBasis.push(`response-exact-thread:${laterSent.id}`);
      return result;
    }
  }

  // Second: cross-thread fallback. Replies can be sent as clean standalone messages.
  const normalized = normalizeSubject(subject);
  const afterSeconds = Math.max(0, Math.floor(receivedMs / 1000) - 60);
  const query = `in:sent to:${sender} after:${afterSeconds}`;
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: input.maxCrossThreadResults || 100,
  });

  for (const candidate of list.data.messages || []) {
    if (!candidate.id) continue;
    const sent = await getFull(gmail, candidate.id);
    if (parseInternalDate(sent) <= receivedMs) continue;
    if (emailAddress(header(sent, 'from')) !== me && !(sent.labelIds || []).includes('SENT')) continue;
    if (normalizeSubject(header(sent, 'subject')) !== normalized) continue;

    const sentMs = parseInternalDate(sent);
    result.ourResponseMessageId = sent.id || undefined;
    result.ourResponseAt = asIso(sentMs);
    result.ourResponseLatencySeconds = Math.max(0, Math.round((sentMs - receivedMs) / 1000));
    result.responseState = 'RESPONDED';
    result.newSearchRequired = false;
    evidenceBasis.push(`response-cross-thread:${sent.id}`);
    return result;
  }

  if (input.sentInventoryComplete === true) {
    result.responseState = 'UNRESPONDED_PROVEN';
    result.newSearchRequired = false;
    evidenceBasis.push('sent-inventory-complete:no-response-found');
  } else {
    result.responseState = 'UNRESPONDED_NOT_ESTABLISHED';
    result.newSearchRequired = true;
    evidenceBasis.push('sent-inventory-incomplete:no-response-found');
  }

  return result;
}
