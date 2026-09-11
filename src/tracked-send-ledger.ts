import fs from 'fs';
import os from 'os';
import path from 'path';
import { sha256Canonical } from './notice-evidence.js';

export type TrackedSendStatus =
  | 'TRACKER_PUBLISHED'
  | 'SENT'
  | 'PROVIDER_ACCEPTED_READBACK_FAILED'
  | 'SEND_FAILED';
export type TrackedSendMode = 'PROVIDER_STATE' | 'EXPLICIT_RECEIPT_REQUEST' | 'CONSENTED_FIRST_PARTY_PIXEL';

export interface UportalSendBinding {
  publicationId: string;
  token: string;
  shortId?: string;
  shortUrl?: string;
}

export interface TrackedSendLedgerRecord {
  schema: 'glaciereq.tracked-send-ledger.v1';
  sequence: number;
  recordedAt: string;
  sendId: string;
  recipient: string;
  subject: string;
  trackingMode: TrackedSendMode;
  status: TrackedSendStatus;
  gmailMessageId?: string;
  gmailThreadId?: string;
  providerAcceptedAt?: string;
  uportal?: UportalSendBinding;
  failure?: {
    stage: 'UPORTAL_PUBLISH' | 'GMAIL_SEND' | 'GMAIL_READBACK';
    message: string;
  };
  previousRecordSha256: string;
  recordSha256: string;
}

export interface TrackedSendLedgerInput {
  sendId: string;
  recipient: string;
  subject: string;
  trackingMode: TrackedSendMode;
  status: TrackedSendStatus;
  gmailMessageId?: string;
  gmailThreadId?: string;
  providerAcceptedAt?: string;
  uportal?: UportalSendBinding;
  failure?: TrackedSendLedgerRecord['failure'];
}

const DEFAULT_PATH = path.join(os.homedir(), '.gmail-mcp', 'ops', 'tracked-send-ledger.jsonl');

function validateRecord(record: TrackedSendLedgerRecord, expectedSequence: number, previous: string): void {
  if (record.schema !== 'glaciereq.tracked-send-ledger.v1') throw new Error(`Unknown tracked-send schema at sequence ${expectedSequence}`);
  if (record.sequence !== expectedSequence) throw new Error(`Tracked-send ledger sequence discontinuity at ${expectedSequence}`);
  if (record.previousRecordSha256 !== previous) throw new Error(`Tracked-send ledger chain discontinuity at sequence ${record.sequence}`);
  const { recordSha256, ...unsigned } = record;
  const computed = sha256Canonical(unsigned);
  if (computed !== recordSha256) throw new Error(`Tracked-send ledger hash mismatch at sequence ${record.sequence}`);
}

export function readTrackedSendLedger(filePath = DEFAULT_PATH): TrackedSendLedgerRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const records = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as TrackedSendLedgerRecord);
  let previous = 'GENESIS';
  records.forEach((record, index) => {
    validateRecord(record, index + 1, previous);
    previous = record.recordSha256;
  });
  return records;
}

export function appendTrackedSendRecord(
  input: TrackedSendLedgerInput,
  filePath = DEFAULT_PATH,
): TrackedSendLedgerRecord {
  const records = readTrackedSendLedger(filePath);
  const previous = records.length ? records[records.length - 1].recordSha256 : 'GENESIS';
  const unsigned = {
    schema: 'glaciereq.tracked-send-ledger.v1' as const,
    sequence: records.length + 1,
    recordedAt: new Date().toISOString(),
    ...input,
    previousRecordSha256: previous,
  };
  const record: TrackedSendLedgerRecord = { ...unsigned, recordSha256: sha256Canonical(unsigned) };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

export function latestTrackedSendRecords(filePath = DEFAULT_PATH): TrackedSendLedgerRecord[] {
  const latest = new Map<string, TrackedSendLedgerRecord>();
  for (const record of readTrackedSendLedger(filePath)) latest.set(record.sendId, record);
  return [...latest.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function successfulTrackedSendsForThread(
  threadId: string,
  filePath = DEFAULT_PATH,
): TrackedSendLedgerRecord[] {
  if (!threadId) return [];
  return latestTrackedSendRecords(filePath)
    .filter(record => record.status === 'SENT' && record.gmailThreadId === threadId)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export function trackedSendLedgerPath(): string {
  return DEFAULT_PATH;
}
