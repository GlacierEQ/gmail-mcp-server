import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { analyzeThreadMessages } from '../email-operations-pipeline.js';
import { assessDuty, buildNoticeEvidenceRecord, normalizeUportalEvent } from '../notice-evidence.js';
import { appendNoticeEvidenceRecord, readNoticeEvidenceLedger } from '../notice-evidence-ledger.js';

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
        ...(attachment ? [{ filename: 'records.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 100 } }] : []),
      ],
    },
  };
}

const own = 'owner@example.com';

const rawUportalEvent = {
  ts: '2026-09-02T12:00:00Z',
  event: 'open',
  publication: 'mail-notice-001',
  token: 'recipient-a',
  uid: 'device-cookie-id',
  file: { seq: 3, name: 'device-cookie-id_3.json' },
  request: {
    ip: '203.0.113.7',
    xff: '203.0.113.7',
    ip_prefix: '203.0.113.0/24',
    ua: 'Example Browser',
    ua_normalized: 'example browser',
    referer: 'https://example.invalid',
    accept_language: 'en-US',
    language_normalized: 'en-us',
  },
  device_guess: {
    key: 'fingerprint-a',
    network_key: 'fingerprint-b',
    source: 'cookie',
    confidence: 'high',
    has_uid: true,
  },
  cookies: { has_uid: true, has_page: false, has_pw: false },
  meta: {
    type: 'pixel',
    short_id: 'Abc123xyz',
    subj: 'Formal records request',
    mails: ['records@example.org'],
    actor: 'actor-1234567890123456',
    owner: 'owner-1234567890123456',
    created_by: 'actor-1234567890123456',
    published_at: '2026-09-01T10:00:00Z',
  },
  counter: { decremented: false, remaining_before: '-1', remaining_after: '-1' },
};

{
  const observation = normalizeUportalEvent(rawUportalEvent as any);
  assert.equal(observation.event, 'open');
  assert.equal(observation.publicationId, 'mail-notice-001');
  assert.deepEqual(observation.recipients, ['records@example.org']);
  assert.equal(observation.sourcePayloadSha256.length, 64);
  assert.equal(observation.evidenceSha256.length, 64);
  assert.equal(observation.privacy.discardedSensitiveFields.includes('request.ip'), true);
  assert.equal(observation.privacy.discardedSensitiveFields.includes('device_guess.key'), true);
  assert.equal('request' in (observation as any), false);
  assert.equal('uid' in (observation as any), false);
}

{
  const snapshot = analyzeThreadMessages([
    msg('s1', 'thread-overdue', own, 'records@example.org', 'Formal records request', '2026-09-01T10:00:00Z', 'Please produce the requested records.', ['SENT']),
  ] as any, own, 72, Date.parse('2026-09-20T10:00:00Z'));
  const observation = normalizeUportalEvent(rawUportalEvent as any);
  const duty = {
    id: 'records-response-clock',
    authority: {
      label: 'Example records response rule',
      citation: 'Example Rule § 10',
      jurisdiction: 'Example',
    },
    requiredAction: 'Provide the required response.',
    trigger: 'SENT' as const,
    deadline: {
      unit: 'BUSINESS_DAYS' as const,
      value: 10,
      holidays: ['2026-09-07'],
    },
    satisfaction: 'SUBSTANTIVE_RESPONSE' as const,
  };
  const assessment = assessDuty(snapshot, [observation], duty, Date.parse('2026-09-20T10:00:00Z'));
  assert.equal(assessment.status, 'OVERDUE');
  assert.equal(assessment.dueAt, '2026-09-16T10:00:00.000Z');

  const record = buildNoticeEvidenceRecord(snapshot, [observation], duty, Date.parse('2026-09-20T10:00:00Z'));
  assert.equal(record.recordDigestSha256.length, 64);
  assert.equal(record.assertions.find(a => a.proposition.includes('legally sufficient service'))?.truthState, 'NOT_ESTABLISHED');
  assert.equal(record.assertions.find(a => a.proposition.includes('controlled UPORTAL publication'))?.truthState, 'OBSERVED');
  assert.equal(record.assertions.find(a => a.proposition.includes('personally read'))?.truthState, 'NOT_ESTABLISHED');
  assert.equal(record.dutyAssessment?.status, 'OVERDUE');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-evidence-'));
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const first = appendNoticeEvidenceRecord(record, ledgerPath);
  assert.equal(first.sequence, 1);
  assert.equal(first.previousRecordSha256, 'GENESIS');
  assert.equal(first.recordSha256.length, 64);
  const readback = readNoticeEvidenceLedger(ledgerPath);
  assert.equal(readback.length, 1);
  assert.equal(readback[0].recordSha256, first.recordSha256);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const snapshot = analyzeThreadMessages([
    msg('s1', 'thread-ack', own, 'agency@example.org', 'Notice', '2026-09-01T10:00:00Z', 'Notice and request.', ['SENT']),
    msg('r1', 'thread-ack', 'agency@example.org', own, 'Re: Notice', '2026-09-01T12:00:00Z', 'We received your request and acknowledge receipt.'),
  ] as any, own, 72, Date.parse('2026-09-01T13:00:00Z'));
  const duty = {
    id: 'ack-clock',
    authority: { label: 'Example acknowledgement rule', citation: 'Example § 1' },
    requiredAction: 'Acknowledge receipt.',
    trigger: 'SENT' as const,
    deadline: { unit: 'HOURS' as const, value: 24 },
    satisfaction: 'ACKNOWLEDGEMENT' as const,
  };
  const assessment = assessDuty(snapshot, [], duty, Date.parse('2026-09-01T13:00:00Z'));
  assert.equal(assessment.status, 'SATISFIED');
  assert.equal(assessment.satisfiedAt, '2026-09-01T12:00:00.000Z');
}

console.log('notice evidence tests passed');
