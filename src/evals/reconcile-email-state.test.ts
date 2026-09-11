import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEmailObligation } from '../reconcile-email-state.js';

function msg(id: string, threadId: string, internalDate: number, labels: string[], from: string, to: string, subject: string, body: string) {
  return {
    id,
    threadId,
    internalDate: String(internalDate),
    labelIds: labels,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(internalDate).toUTCString() },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from(body, 'utf8').toString('base64url') },
    },
  };
}

function gmailMock(messages: Record<string, any>, threads: Record<string, any[]>, sentSearchIds: string[] = []) {
  return {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'casey@example.com' } }),
      messages: {
        get: async ({ id }: { id: string }) => ({ data: messages[id] }),
        list: async () => ({ data: { messages: sentSearchIds.map(id => ({ id })) } }),
      },
      threads: {
        get: async ({ id }: { id: string }) => ({ data: { messages: threads[id] || [] } }),
      },
    },
  } as any;
}

test('exact-thread reconciliation calculates both response latencies', async () => {
  const t0 = Date.UTC(2026, 8, 8, 6, 47, 0);
  const prior = msg('outbound-1', 'thread-1', t0, ['SENT'], 'casey@example.com', 'evelyn@example.com', 'Urgent Referral Request', 'Please help.');
  const inbound = msg('inbound-1', 'thread-1', t0 + 10 * 3600_000 + 8 * 60_000, ['INBOX'], 'Evelyn <evelyn@example.com>', 'casey@example.com', 'Re: Urgent Referral Request', 'Please confirm receipt.');
  const reply = msg('reply-1', 'thread-1', t0 + 12 * 3600_000, ['SENT'], 'casey@example.com', 'evelyn@example.com', 'Re: Urgent Referral Request', 'Confirmed.');
  const gmail = gmailMock(
    { 'inbound-1': inbound, 'outbound-1': prior, 'reply-1': reply },
    { 'thread-1': [prior, inbound, reply] },
  );

  const result = await reconcileEmailObligation(gmail, { messageId: 'inbound-1' });
  assert.equal(result.responseState, 'RESPONDED');
  assert.equal(result.priorOutboundMessageId, 'outbound-1');
  assert.equal(result.recipientResponseLatencySeconds, 36480);
  assert.equal(result.ourResponseMessageId, 'reply-1');
  assert.equal(result.ourResponseLatencySeconds, 6720);
  assert.equal(result.newSearchRequired, false);
});

test('cross-thread sent fallback catches standalone reply', async () => {
  const t0 = Date.UTC(2026, 8, 9, 16, 55, 0);
  const inbound = msg('inbound-2', 'thread-2', t0, ['INBOX'], 'Evelyn <evelyn@example.com>', 'casey@example.com', 'Re: Employment/Labor Counsel Referral Request', 'Please confirm receipt.');
  const standalone = msg('reply-2', 'thread-3', t0 + 2 * 3600_000, ['SENT'], 'casey@example.com', 'evelyn@example.com', 'Re: Employment/Labor Counsel Referral Request', 'Confirmed.');
  const gmail = gmailMock(
    { 'inbound-2': inbound, 'reply-2': standalone },
    { 'thread-2': [inbound] },
    ['reply-2'],
  );

  const result = await reconcileEmailObligation(gmail, { messageId: 'inbound-2' });
  assert.equal(result.responseState, 'RESPONDED');
  assert.equal(result.ourResponseMessageId, 'reply-2');
  assert.ok(result.evidenceBasis.includes('response-cross-thread:reply-2'));
});

test('complete sent inventory proves an unresponded obligation without requesting another search', async () => {
  const t0 = Date.UTC(2026, 8, 10, 12, 0, 0);
  const inbound = msg('inbound-3', 'thread-4', t0, ['INBOX'], 'records@example.com', 'casey@example.com', 'Records Request', 'Action required: please respond.');
  const gmail = gmailMock({ 'inbound-3': inbound }, { 'thread-4': [inbound] });

  const result = await reconcileEmailObligation(gmail, { messageId: 'inbound-3', sentInventoryComplete: true });
  assert.equal(result.responseState, 'UNRESPONDED_PROVEN');
  assert.equal(result.newSearchRequired, false);
});

test('incomplete sent inventory preserves uncertainty instead of inventing absence', async () => {
  const t0 = Date.UTC(2026, 8, 10, 12, 0, 0);
  const inbound = msg('inbound-4', 'thread-5', t0, ['INBOX'], 'records@example.com', 'casey@example.com', 'Records Request', 'Would you please provide confirmation?');
  const gmail = gmailMock({ 'inbound-4': inbound }, { 'thread-5': [inbound] });

  const result = await reconcileEmailObligation(gmail, { messageId: 'inbound-4' });
  assert.equal(result.responseState, 'UNRESPONDED_NOT_ESTABLISHED');
  assert.equal(result.newSearchRequired, true);
});
