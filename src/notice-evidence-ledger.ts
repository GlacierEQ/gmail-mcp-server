import fs from 'fs';
import os from 'os';
import path from 'path';
import { NoticeEvidenceRecord, sha256Canonical } from './notice-evidence.js';

export interface NoticeEvidenceLedgerRecord {
  schema: 'glaciereq.notice-evidence-ledger.v1';
  sequence: number;
  recordedAt: string;
  threadId: string;
  noticeRecordDigestSha256: string;
  noticeRecord: NoticeEvidenceRecord;
  previousRecordSha256: string;
  recordSha256: string;
}

const DEFAULT_PATH = path.join(os.homedir(), '.gmail-mcp', 'ops', 'notice-evidence-ledger.jsonl');

function durableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function durableNoticeRecord(noticeRecord: NoticeEvidenceRecord): NoticeEvidenceRecord {
  const durable = durableJson(noticeRecord);
  const { recordDigestSha256: _oldDigest, ...unsigned } = durable;
  const digest = sha256Canonical(unsigned);
  durable.recordDigestSha256 = digest;
  // Keep the caller-visible record aligned with the exact JSON that is persisted.
  noticeRecord.recordDigestSha256 = digest;
  return durable;
}

export function readNoticeEvidenceLedger(filePath = DEFAULT_PATH): NoticeEvidenceLedgerRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  const records = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as NoticeEvidenceLedgerRecord);
  let previous = 'GENESIS';
  records.forEach((record, index) => {
    if (record.sequence !== index + 1) throw new Error(`Notice ledger sequence discontinuity at record ${index + 1}`);
    if (record.previousRecordSha256 !== previous) throw new Error(`Notice ledger chain discontinuity at sequence ${record.sequence}`);
    if (record.noticeRecordDigestSha256 !== record.noticeRecord.recordDigestSha256) {
      throw new Error(`Notice record digest mismatch at sequence ${record.sequence}`);
    }
    const { recordDigestSha256, ...noticeUnsigned } = record.noticeRecord;
    if (sha256Canonical(noticeUnsigned) !== recordDigestSha256) {
      throw new Error(`Persisted Notice Evidence content hash mismatch at sequence ${record.sequence}`);
    }
    const { recordSha256, ...unsigned } = record;
    const computed = sha256Canonical(unsigned);
    if (computed !== recordSha256) throw new Error(`Notice ledger hash mismatch at sequence ${record.sequence}`);
    previous = recordSha256;
  });
  return records;
}

export function appendNoticeEvidenceRecord(
  noticeRecord: NoticeEvidenceRecord,
  filePath = DEFAULT_PATH,
): NoticeEvidenceLedgerRecord {
  const records = readNoticeEvidenceLedger(filePath);
  const previous = records.length ? records[records.length - 1].recordSha256 : 'GENESIS';
  const durableRecord = durableNoticeRecord(noticeRecord);
  const unsigned = {
    schema: 'glaciereq.notice-evidence-ledger.v1' as const,
    sequence: records.length + 1,
    recordedAt: new Date().toISOString(),
    threadId: durableRecord.threadId,
    noticeRecordDigestSha256: durableRecord.recordDigestSha256,
    noticeRecord: durableRecord,
    previousRecordSha256: previous,
  };
  const record: NoticeEvidenceLedgerRecord = { ...unsigned, recordSha256: sha256Canonical(unsigned) };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

export function latestNoticeEvidenceRecords(filePath = DEFAULT_PATH): NoticeEvidenceLedgerRecord[] {
  const latest = new Map<string, NoticeEvidenceLedgerRecord>();
  for (const record of readNoticeEvidenceLedger(filePath)) latest.set(record.threadId, record);
  return [...latest.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function noticeEvidenceLedgerPath(): string {
  return DEFAULT_PATH;
}
