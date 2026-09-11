import crypto from 'crypto';
import { gmail_v1 } from 'googleapis';

export type EmailOperationalStage =
  | 'SENT'
  | 'DELIVERY_EXCEPTION'
  | 'ACKNOWLEDGED'
  | 'ROUTED'
  | 'REFERENCE_NUMBER'
  | 'ASSIGNED_OFFICE'
  | 'SUBSTANTIVE_RESPONSE'
  | 'RECORDS_EVIDENCE_RECEIVED'
  | 'FOLLOW_UP_DUE';

export interface EmailTimelineEvent {
  messageId: string;
  threadId: string;
  direction: 'OUTBOUND' | 'INBOUND';
  at: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  labels: string[];
  attachments: string[];
  evidenceSha256: string;
}

export interface EmailOperationalSnapshot {
  schema: 'glaciereq.email-operations.v1';
  generatedAt: string;
  threadId: string;
  normalizedSubject: string;
  participants: string[];
  stages: Partial<Record<EmailOperationalStage, boolean>>;
  deliveryState: 'BOUNCED_OR_REJECTED' | 'NO_PROVIDER_EXCEPTION_OBSERVED' | 'UNKNOWN';
  referenceNumbers: string[];
  assignedOfficeSignals: string[];
  routingSignals: string[];
  acknowledgementSignals: string[];
  lastOutboundAt?: string;
  lastInboundAt?: string;
  responseLatencySeconds?: number;
  followUpDueAt?: string;
  followUpDue: boolean;
  openAction: string | null;
  timeline: EmailTimelineEvent[];
  evidenceDigestSha256: string;
}

const ACK_RE = /\b(received|receipt|acknowledg(?:e|ed|ement)|thank you for (?:your|the) (?:email|message)|confirm(?:ed|ation)?)\b/i;
const ROUTE_RE = /\b(referred|forwarded|routed|transferred|sent to|assigned to|redirected)\b/i;
const OFFICE_RE = /\b(?:office|division|unit|section|department|bureau|branch|counsel|investigator|analyst|specialist)\b[^\n,.]{0,80}/gi;
const REFERENCE_RE = /\b(?:reference|ref(?:erence)?|case|ticket|request|complaint|incident|tracking|confirmation)\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{3,})\b/gi;
const BOUNCE_RE = /\b(delivery status notification|undeliverable|mail delivery subsystem|address not found|user unknown|recipient rejected|delivery failed|550\s+5\.|554\s+5\.)\b/i;

function header(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function decode(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function body(part?: gmail_v1.Schema$MessagePart | null): string {
  if (!part) return '';
  const parts = part.parts?.map(body).filter(Boolean) || [];
  if (part.mimeType === 'text/plain' && part.body?.data) return [decode(part.body.data), ...parts].join('\n');
  if (parts.length) return parts.join('\n');
  return part.body?.data ? decode(part.body.data) : '';
}

function attachments(part?: gmail_v1.Schema$MessagePart | null): string[] {
  if (!part) return [];
  const here = part.filename && part.body?.attachmentId ? [part.filename] : [];
  return [...here, ...(part.parts?.flatMap(attachments) || [])];
}

function emailAddress(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1] : value).trim().toLowerCase();
}

function addressList(value: string): string[] {
  return value.split(',').map(emailAddress).filter(Boolean);
}

function timestamp(message: gmail_v1.Schema$Message): number {
  if (message.internalDate) return Number(message.internalDate);
  const parsed = Date.parse(header(message, 'date'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSubject(value: string): string {
  return value.replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, '').trim().toLowerCase();
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractMatches(re: RegExp, text: string): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) out.push((match[1] || match[0]).trim());
  return uniq(out);
}

export function analyzeThreadMessages(
  messages: gmail_v1.Schema$Message[],
  ownAddress: string,
  followUpAfterHours = 72,
  nowMs = Date.now(),
): EmailOperationalSnapshot {
  if (!messages.length) throw new Error('Cannot analyze an empty email thread');
  const own = ownAddress.toLowerCase();
  const sorted = [...messages].sort((a, b) => timestamp(a) - timestamp(b));
  const timeline: EmailTimelineEvent[] = sorted.map(message => {
    const from = emailAddress(header(message, 'from'));
    const raw = {
      messageId: message.id || '',
      threadId: message.threadId || '',
      direction: (from === own || (message.labelIds || []).includes('SENT')) ? 'OUTBOUND' as const : 'INBOUND' as const,
      at: new Date(timestamp(message)).toISOString(),
      from,
      to: addressList(header(message, 'to')),
      subject: header(message, 'subject'),
      snippet: body(message.payload) || message.snippet || '',
      labels: message.labelIds || [],
      attachments: attachments(message.payload),
    };
    return { ...raw, evidenceSha256: sha256(raw) };
  });

  const outbound = timeline.filter(e => e.direction === 'OUTBOUND');
  const inbound = timeline.filter(e => e.direction === 'INBOUND');
  const inboundText = inbound.map(e => `${e.subject}\n${e.snippet}`).join('\n');
  const allText = timeline.map(e => `${e.subject}\n${e.snippet}`).join('\n');
  const bounced = BOUNCE_RE.test(allText);
  const references = extractMatches(REFERENCE_RE, inboundText);
  const offices = extractMatches(OFFICE_RE, inboundText);
  const routing = inbound.filter(e => ROUTE_RE.test(`${e.subject}\n${e.snippet}`)).map(e => e.messageId);
  const acknowledgements = inbound.filter(e => ACK_RE.test(`${e.subject}\n${e.snippet}`)).map(e => e.messageId);
  const evidenceMessages = inbound.filter(e => e.attachments.length > 0);
  const substantive = inbound.some(e => {
    const text = e.snippet.replace(/\s+/g, ' ').trim();
    return text.length >= 180 || references.length > 0 || offices.length > 0 || evidenceMessages.length > 0;
  });

  const lastOutbound = outbound[outbound.length - 1];
  const lastInbound = inbound[inbound.length - 1];
  const lastOutboundMs = lastOutbound ? Date.parse(lastOutbound.at) : undefined;
  const lastInboundMs = lastInbound ? Date.parse(lastInbound.at) : undefined;
  const responseLatencySeconds = lastOutboundMs !== undefined && lastInboundMs !== undefined && lastInboundMs >= lastOutboundMs
    ? Math.round((lastInboundMs - lastOutboundMs) / 1000)
    : undefined;

  const dueMs = lastOutboundMs !== undefined ? lastOutboundMs + followUpAfterHours * 3600_000 : undefined;
  const hasInboundAfterLastOutbound = lastOutboundMs !== undefined
    ? inbound.some(e => Date.parse(e.at) > lastOutboundMs)
    : false;
  const followUpDue = Boolean(dueMs !== undefined && nowMs >= dueMs && !hasInboundAfterLastOutbound && !bounced);

  const stages: Partial<Record<EmailOperationalStage, boolean>> = {
    SENT: outbound.length > 0,
    DELIVERY_EXCEPTION: bounced,
    ACKNOWLEDGED: acknowledgements.length > 0,
    ROUTED: routing.length > 0,
    REFERENCE_NUMBER: references.length > 0,
    ASSIGNED_OFFICE: offices.length > 0,
    SUBSTANTIVE_RESPONSE: substantive,
    RECORDS_EVIDENCE_RECEIVED: evidenceMessages.length > 0,
    FOLLOW_UP_DUE: followUpDue,
  };

  let openAction: string | null = null;
  if (bounced) openAction = 'Repair delivery route before substantive follow-up.';
  else if (followUpDue) openAction = 'Follow up: no inbound response was observed after the configured interval.';
  else if (acknowledgements.length && !substantive) openAction = 'Acknowledged but not substantively resolved; await or calendar substantive follow-up.';
  else if (routing.length && !references.length) openAction = 'Routing observed; obtain reference/tracking number and assigned office if material.';
  else if (references.length && !substantive) openAction = 'Reference number obtained; continue tracking for substantive response or records.';

  const digestInput = timeline.map(e => e.evidenceSha256);
  return {
    schema: 'glaciereq.email-operations.v1',
    generatedAt: new Date(nowMs).toISOString(),
    threadId: sorted[0].threadId || '',
    normalizedSubject: normalizeSubject(header(sorted[0], 'subject')),
    participants: uniq(timeline.flatMap(e => [e.from, ...e.to])).sort(),
    stages,
    deliveryState: bounced ? 'BOUNCED_OR_REJECTED' : outbound.length ? 'NO_PROVIDER_EXCEPTION_OBSERVED' : 'UNKNOWN',
    referenceNumbers: references,
    assignedOfficeSignals: offices,
    routingSignals: routing,
    acknowledgementSignals: acknowledgements,
    lastOutboundAt: lastOutbound?.at,
    lastInboundAt: lastInbound?.at,
    responseLatencySeconds,
    followUpDueAt: dueMs === undefined ? undefined : new Date(dueMs).toISOString(),
    followUpDue,
    openAction,
    timeline,
    evidenceDigestSha256: sha256(digestInput),
  };
}

export async function trackEmailThread(
  gmail: gmail_v1.Gmail,
  threadId: string,
  followUpAfterHours = 72,
): Promise<EmailOperationalSnapshot> {
  const [thread, profile] = await Promise.all([
    gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }),
    gmail.users.getProfile({ userId: 'me' }),
  ]);
  const own = profile.data.emailAddress || '';
  if (!own) throw new Error('Unable to determine Gmail profile address');
  return analyzeThreadMessages(thread.data.messages || [], own, followUpAfterHours);
}

export async function scanEmailOperations(
  gmail: gmail_v1.Gmail,
  query = 'newer_than:30d',
  maxThreads = 50,
  followUpAfterHours = 72,
): Promise<EmailOperationalSnapshot[]> {
  const list = await gmail.users.threads.list({ userId: 'me', q: query, maxResults: Math.min(maxThreads, 100) });
  const ids = (list.data.threads || []).map(t => t.id).filter((id): id is string => Boolean(id));
  const snapshots: EmailOperationalSnapshot[] = [];
  for (const id of ids) snapshots.push(await trackEmailThread(gmail, id, followUpAfterHours));
  return snapshots.sort((a, b) => (b.lastOutboundAt || b.lastInboundAt || '').localeCompare(a.lastOutboundAt || a.lastInboundAt || ''));
}
