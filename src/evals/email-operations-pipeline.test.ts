import assert from 'node:assert/strict';
import { analyzeThreadMessages } from '../email-operations-pipeline.js';
import { evaluateTrackingMode } from '../lawful-tracking-policy.js';

function msg(id: string, threadId: string, from: string, to: string, subject: string, iso: string, text: string, labels: string[] = [], attachment = false) {
  return {
    id,
    threadId,
    internalDate: String(Date.parse(iso)),
    labelIds: labels,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } },
        ...(attachment ? [{ filename: 'response.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 100 } }] : []),
      ],
    },
  };
}

const own = 'owner@example.com';

{
  const messages = [
    msg('s1', 't1', own, 'team@example.org', 'Request', '2026-09-01T10:00:00Z', 'Please provide the requested material.', ['SENT']),
    msg('r1', 't1', 'team@example.org', own, 'Re: Request', '2026-09-01T12:00:00Z', 'We received your request and forwarded it to the Records Office. Reference number REF-2026-4815.'),
    msg('r2', 't1', 'records@example.org', own, 'Re: Request', '2026-09-02T09:00:00Z', 'Attached are responsive records from our office.', [], true),
  ] as any;
  const result = analyzeThreadMessages(messages, own, 72, Date.parse('2026-09-02T10:00:00Z'));
  assert.equal(result.stages.SENT, true);
  assert.equal(result.stages.ACKNOWLEDGED, true);
  assert.equal(result.stages.ROUTED, true);
  assert.equal(result.stages.REFERENCE_NUMBER, true);
  assert.equal(result.stages.RECORDS_EVIDENCE_RECEIVED, true);
  assert.equal(result.followUpDue, false);
  assert.equal(result.timeline.every(e => e.evidenceSha256.length === 64), true);
}

{
  const result = analyzeThreadMessages([
    msg('s1', 't2', own, 'silent@example.org', 'Status request', '2026-09-01T10:00:00Z', 'Please advise.', ['SENT']),
  ] as any, own, 24, Date.parse('2026-09-03T10:00:00Z'));
  assert.equal(result.followUpDue, true);
  assert.equal(result.stages.FOLLOW_UP_DUE, true);
}

{
  const result = analyzeThreadMessages([
    msg('s1', 't3', own, 'closed@example.org', 'Notice', '2026-09-01T10:00:00Z', 'Notice', ['SENT']),
    msg('b1', 't3', 'system@example.org', own, 'Delivery Status Notification', '2026-09-01T10:01:00Z', 'Delivery failed: recipient rejected.'),
  ] as any, own, 1, Date.parse('2026-09-03T10:00:00Z'));
  assert.equal(result.deliveryState, 'BOUNCED_OR_REJECTED');
  assert.equal(result.stages.DELIVERY_EXCEPTION, true);
}

{
  assert.equal(evaluateTrackingMode('PROVIDER_STATE').allowed, true);
  assert.equal(evaluateTrackingMode('CONSENTED_FIRST_PARTY_PIXEL', false).allowed, false);
  assert.equal(evaluateTrackingMode('CONSENTED_FIRST_PARTY_PIXEL', true).allowed, true);
}

console.log('email operations pipeline tests passed');
