import crypto from 'crypto';
import { createEmailMessage, createEmailWithNodemailer } from './utl.js';
import { evaluateTrackingMode } from './lawful-tracking-policy.js';
import {
  publishUportalPixel,
  uportalConfigFromEnv,
  type UportalClientConfig,
  type UportalPixelPublication,
} from './uportal-client.js';
import {
  appendTrackedSendRecord,
  trackedSendLedgerPath,
  type TrackedSendLedgerInput,
  type TrackedSendLedgerRecord,
  type TrackedSendMode,
  type UportalSendBinding,
} from './tracked-send-ledger.js';

export interface TrackedNoticeSendInput {
  recipients: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: string[];
  trackingMode?: TrackedSendMode;
  recipientNoticeOrConsent?: boolean;
  threadId?: string;
  inReplyTo?: string;
}

export interface TrackedNoticeSendResult {
  sendId: string;
  recipient: string;
  trackingMode: TrackedSendMode;
  status: 'SENT' | 'PROVIDER_ACCEPTED_READBACK_FAILED' | 'SEND_FAILED';
  gmailMessageId?: string;
  gmailThreadId?: string;
  providerAcceptedAt?: string;
  uportal?: UportalSendBinding;
  failure?: TrackedSendLedgerRecord['failure'];
  ledgerPath: string;
  ledgerRecord: TrackedSendLedgerRecord;
}

interface GmailLike {
  users: {
    messages: {
      send(args: Record<string, unknown>): Promise<{ data?: { id?: string | null; threadId?: string | null } }>;
      get(args: Record<string, unknown>): Promise<{ data?: {
        id?: string | null;
        threadId?: string | null;
        internalDate?: string | null;
        payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
      } }>;
    };
  };
}

export interface TrackedNoticeSendDeps {
  now?: () => Date;
  randomHex?: (bytes: number) => string;
  uportalConfig?: UportalClientConfig;
  publishPixel?: typeof publishUportalPixel;
  appendRecord?: (input: TrackedSendLedgerInput) => TrackedSendLedgerRecord;
  ledgerPath?: () => string;
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textAsHtml(value: string): string {
  return `<div>${escapeHtml(value).replace(/\r?\n/g, '<br>')}</div>`;
}

function internalDateIso(internalDate: string | null | undefined, fallback: Date): string {
  if (internalDate && /^\d+$/.test(internalDate)) {
    const parsed = new Date(Number(internalDate));
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback.toISOString();
}

function uportalBinding(publication: UportalPixelPublication): UportalSendBinding {
  return {
    publicationId: publication.publicationId,
    token: publication.token,
    shortId: publication.shortId || undefined,
    shortUrl: publication.shortUrl || undefined,
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function sendTrackedNotices(
  gmail: GmailLike,
  input: TrackedNoticeSendInput,
  deps: TrackedNoticeSendDeps = {},
): Promise<TrackedNoticeSendResult[]> {
  const recipients = [...new Set(input.recipients.map(value => value.trim()).filter(Boolean))];
  if (!recipients.length) throw new Error('At least one recipient is required.');
  if (!input.subject.trim()) throw new Error('Subject is required.');
  if (!input.body.trim() && !input.htmlBody?.trim()) throw new Error('Email body is required.');
  if (input.threadId && recipients.length !== 1) {
    throw new Error('Threaded tracked sends require exactly one recipient so recipient identity remains unambiguous.');
  }

  const trackingMode = input.trackingMode || 'PROVIDER_STATE';
  const policy = evaluateTrackingMode(trackingMode, input.recipientNoticeOrConsent || false);
  if (!policy.allowed) throw new Error(`Tracking mode refused by policy: ${policy.rationale}`);

  const appendRecord = deps.appendRecord || appendTrackedSendRecord;
  const ledgerPath = deps.ledgerPath || trackedSendLedgerPath;
  const now = deps.now || (() => new Date());
  const random = deps.randomHex || randomHex;
  const publishPixel = deps.publishPixel || publishUportalPixel;
  const results: TrackedNoticeSendResult[] = [];

  for (const recipient of recipients) {
    const sendId = random(16);
    let publication: UportalPixelPublication | undefined;
    let binding: UportalSendBinding | undefined;

    if (trackingMode === 'CONSENTED_FIRST_PARTY_PIXEL') {
      try {
        const published = await publishPixel(
          deps.uportalConfig || uportalConfigFromEnv(),
          {
            publicationId: `notice-${sendId}`,
            token: random(16),
            subject: input.subject,
            recipients: [recipient],
          },
        );
        publication = published;
        binding = uportalBinding(published);
        appendRecord({
          sendId,
          recipient,
          subject: input.subject,
          trackingMode,
          status: 'TRACKER_PUBLISHED',
          uportal: binding,
        });
      } catch (error) {
        const failure = { stage: 'UPORTAL_PUBLISH' as const, message: failureMessage(error) };
        const ledgerRecord = appendRecord({
          sendId,
          recipient,
          subject: input.subject,
          trackingMode,
          status: 'SEND_FAILED',
          failure,
        });
        results.push({
          sendId,
          recipient,
          trackingMode,
          status: 'SEND_FAILED',
          failure,
          ledgerPath: ledgerPath(),
          ledgerRecord,
        });
        continue;
      }
    }

    const htmlBody = publication
      ? `${input.htmlBody?.trim() || textAsHtml(input.body)}\n${publication.html}`
      : input.htmlBody;
    const mimeType = htmlBody ? 'multipart/alternative' : 'text/plain';
    const mailArgs = {
      to: [recipient],
      subject: input.subject,
      body: input.body,
      htmlBody,
      mimeType,
      cc: undefined,
      bcc: undefined,
      threadId: input.threadId,
      inReplyTo: input.inReplyTo,
      attachments: input.attachments || [],
    };

    let raw: string;
    try {
      raw = mailArgs.attachments.length
        ? await createEmailWithNodemailer(mailArgs)
        : createEmailMessage(mailArgs);
    } catch (error) {
      const failure = { stage: 'GMAIL_SEND' as const, message: `MIME construction failed: ${failureMessage(error)}` };
      const ledgerRecord = appendRecord({
        sendId,
        recipient,
        subject: input.subject,
        trackingMode,
        status: 'SEND_FAILED',
        uportal: binding,
        failure,
      });
      results.push({ sendId, recipient, trackingMode, status: 'SEND_FAILED', uportal: binding, failure, ledgerPath: ledgerPath(), ledgerRecord });
      continue;
    }

    let sentId: string | undefined;
    let responseThreadId: string | undefined;
    const acceptedAt = now();
    try {
      const requestBody: { raw: string; threadId?: string } = { raw: base64Url(raw) };
      if (input.threadId) requestBody.threadId = input.threadId;
      const sent = await gmail.users.messages.send({ userId: 'me', requestBody });
      sentId = sent.data?.id || undefined;
      responseThreadId = sent.data?.threadId || undefined;
      if (!sentId) throw new Error('Gmail send returned no message ID.');
    } catch (error) {
      const failure = { stage: 'GMAIL_SEND' as const, message: failureMessage(error) };
      const ledgerRecord = appendRecord({
        sendId,
        recipient,
        subject: input.subject,
        trackingMode,
        status: 'SEND_FAILED',
        uportal: binding,
        failure,
      });
      results.push({ sendId, recipient, trackingMode, status: 'SEND_FAILED', uportal: binding, failure, ledgerPath: ledgerPath(), ledgerRecord });
      continue;
    }

    try {
      const readback = await gmail.users.messages.get({
        userId: 'me',
        id: sentId,
        format: 'metadata',
        metadataHeaders: ['Subject', 'To', 'Date', 'Message-ID'],
      });
      const gmailThreadId = readback.data?.threadId || responseThreadId;
      const providerAcceptedAt = internalDateIso(readback.data?.internalDate, acceptedAt);
      const ledgerRecord = appendRecord({
        sendId,
        recipient,
        subject: input.subject,
        trackingMode,
        status: 'SENT',
        gmailMessageId: sentId,
        gmailThreadId,
        providerAcceptedAt,
        uportal: binding,
      });
      results.push({
        sendId,
        recipient,
        trackingMode,
        status: 'SENT',
        gmailMessageId: sentId,
        gmailThreadId,
        providerAcceptedAt,
        uportal: binding,
        ledgerPath: ledgerPath(),
        ledgerRecord,
      });
    } catch (error) {
      const failure = { stage: 'GMAIL_READBACK' as const, message: failureMessage(error) };
      const ledgerRecord = appendRecord({
        sendId,
        recipient,
        subject: input.subject,
        trackingMode,
        status: 'PROVIDER_ACCEPTED_READBACK_FAILED',
        gmailMessageId: sentId,
        gmailThreadId: responseThreadId,
        providerAcceptedAt: acceptedAt.toISOString(),
        uportal: binding,
        failure,
      });
      results.push({
        sendId,
        recipient,
        trackingMode,
        status: 'PROVIDER_ACCEPTED_READBACK_FAILED',
        gmailMessageId: sentId,
        gmailThreadId: responseThreadId,
        providerAcceptedAt: acceptedAt.toISOString(),
        uportal: binding,
        failure,
        ledgerPath: ledgerPath(),
        ledgerRecord,
      });
    }
  }

  return results;
}
