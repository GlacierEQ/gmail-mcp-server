import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EmailOperationalSnapshot } from './email-operations-pipeline.js';
import { TrackingMode } from './lawful-tracking-policy.js';

export interface EmailTrackingLedgerRecord {
  schema: 'glaciereq.email-tracking-ledger.v1';
  sequence: number;
  recordedAt: string;
  threadId: string;
  trackingMode: TrackingMode;
  sourceEvidenceDigestSha256: string;
  snapshot: EmailOperationalSnapshot;
  previousRecordSha256: string;
  recordSha256: string;
}

const DEFAULT_PATH = path.join(os.homedir(), '.gmail-mcp', 'ops', 'email-tracking-ledger.jsonl');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${canonical(object[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

export function readTrackingLedger(filePath = DEFAULT_PATH): EmailTrackingLedgerRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const records = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as EmailTrackingLedgerRecord);
  let previous = 'GENESIS';
  records.forEach((record, index) => {
    if (record.sequence !== index + 1) throw new Error(`Ledger sequence discontinuity at record ${index + 1}`);
    if (record.previousRecordSha256 !== previous) throw new Error(`Ledger chain discontinuity at sequence ${record.sequence}`);
    const { recordSha256, ...unsigned } = record;
    const computed = digest(unsigned);
    if (computed !== recordSha256) throw new Error(`Ledger hash mismatch at sequence ${record.sequence}`);
    previous = recordSha256;
  });
  return records;
}

export function appendTrackingSnapshot(
  snapshot: EmailOperationalSnapshot,
  trackingMode: TrackingMode = 'PROVIDER_STATE',
  filePath = DEFAULT_PATH,
): EmailTrackingLedgerRecord {
  const records = readTrackingLedger(filePath);
  const previous = records.length ? records[records.length - 1].recordSha256 : 'GENESIS';
  const unsigned = {
    schema: 'glaciereq.email-tracking-ledger.v1' as const,
    sequence: records.length + 1,
    recordedAt: new Date().toISOString(),
    threadId: snapshot.threadId,
    trackingMode,
    sourceEvidenceDigestSha256: snapshot.evidenceDigestSha256,
    snapshot,
    previousRecordSha256: previous,
  };
  const record: EmailTrackingLedgerRecord = { ...unsigned, recordSha256: digest(unsigned) };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

export function latestTrackedThreads(filePath = DEFAULT_PATH): EmailTrackingLedgerRecord[] {
  const latest = new Map<string, EmailTrackingLedgerRecord>();
  for (const record of readTrackingLedger(filePath)) latest.set(record.threadId, record);
  return [...latest.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function trackingLedgerPath(): string {
  return DEFAULT_PATH;
}
