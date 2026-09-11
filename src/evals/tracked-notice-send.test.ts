import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sendTrackedNotices } from '../tracked-notice-send.js';
import {
  appendTrackedSendRecord,
  latestTrackedSendRecords,
  readTrackedSendLedger,
  type TrackedSendLedgerInput,
} from '../tracked-send-ledger.js';

function tempLedger(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gmail-tracked-${name}-`));
  return path.join(dir, 'ledger.jsonl');
}

function ledgerDeps(filePath: string) {
  return {
    appendRecord: (input: TrackedSendLedgerInput) => appendTrackedSendRecord(input, filePath),
    ledgerPath: () => filePath,
  };
}

function decodeRaw(raw: string): string {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

async function main() {
  {
    const filePath = tempLedger('provider');
    const sentBodies: string[] = [];
    let counter = 0;
    const gmail = {
      users: { messages: {
        send: async (args: any) => {
          counter += 1;
          sentBodies.push(decodeRaw(args.requestBody.raw));
          return { data: { id: `m-${counter}`, threadId: `t-${counter}` } };
        },
        get: async (args: any) => ({
          data: { id: args.id, threadId: `t-${String(args.id).split('-')[1]}`, internalDate: '1789142400000', payload: { headers: [] } },
        }),
      } },
    } as any;

    const result = await sendTrackedNotices(
      gmail,
      {
        recipients: ['alpha@example.test', 'beta@example.test', 'alpha@example.test'],
        subject: 'Notice',
        body: 'Evidence notice body',
        trackingMode: 'PROVIDER_STATE',
      },
      {
        ...ledgerDeps(filePath),
        randomHex: (() => {
          let value = 0;
          return () => `send${++value}`;
        })(),
        now: () => new Date('2026-09-11T17:00:00Z'),
      },
    );

    assert.equal(result.length, 2);
    assert.deepEqual(result.map(item => item.status), ['SENT', 'SENT']);
    assert.equal(sentBodies.length, 2);
    assert.match(sentBodies[0], /To: alpha@example\.test/);
    assert.doesNotMatch(sentBodies[0], /beta@example\.test/);
    assert.match(sentBodies[1], /To: beta@example\.test/);
    assert.doesNotMatch(sentBodies[1], /alpha@example\.test/);
    assert.equal(readTrackedSendLedger(filePath).length, 2);
    assert.equal(latestTrackedSendRecords(filePath).every(item => item.status === 'SENT'), true);
  }

  {
    const filePath = tempLedger('pixel');
    let publishCalls = 0;
    let sentRaw = '';
    const gmail = {
      users: { messages: {
        send: async (args: any) => {
          sentRaw = decodeRaw(args.requestBody.raw);
          return { data: { id: 'pixel-message', threadId: 'pixel-thread' } };
        },
        get: async () => ({ data: { id: 'pixel-message', threadId: 'pixel-thread', internalDate: '1789142400000', payload: { headers: [] } } }),
      } },
    } as any;

    const result = await sendTrackedNotices(
      gmail,
      {
        recipients: ['recipient@example.test'],
        subject: 'Tracked notice',
        body: 'Tracked notice body',
        trackingMode: 'CONSENTED_FIRST_PARTY_PIXEL',
        recipientNoticeOrConsent: true,
      },
      {
        ...ledgerDeps(filePath),
        randomHex: (() => {
          const values = ['sendbinding', 'recipienttoken'];
          return () => values.shift() || 'fallback';
        })(),
        uportalConfig: { baseUrl: 'https://tracker.example.test', userToken: 'secret' },
        publishPixel: (async (_config: any, input: any) => {
          publishCalls += 1;
          assert.equal(input.recipients.length, 1);
          assert.equal(input.recipients[0], 'recipient@example.test');
          return {
            source: 'uportal',
            type: 'pixel',
            status: 'active',
            publicationId: input.publicationId,
            token: input.token,
            shortId: 'abc123XYZ',
            shortUrl: 'https://tracker.example.test/s/abc123XYZ',
            subject: input.subject,
            recipients: input.recipients,
            html: '<img src="https://tracker.example.test/s/abc123XYZ" width="1" height="1" alt="" />',
          };
        }) as any,
      },
    );

    assert.equal(publishCalls, 1);
    assert.equal(result[0].status, 'SENT');
    assert.equal(result[0].uportal?.publicationId, 'notice-sendbinding');
    assert.match(sentRaw, /multipart\/alternative/);
    assert.match(sentRaw, /tracker\.example\.test\/s\/abc123XYZ/);
    const chain = readTrackedSendLedger(filePath);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].status, 'TRACKER_PUBLISHED');
    assert.equal(chain[1].status, 'SENT');
    assert.equal(chain[1].uportal?.token, 'recipienttoken');
  }

  {
    const filePath = tempLedger('readback');
    const gmail = {
      users: { messages: {
        send: async () => ({ data: { id: 'accepted-message', threadId: 'accepted-thread' } }),
        get: async () => { throw new Error('provider readback temporarily unavailable'); },
      } },
    } as any;

    const result = await sendTrackedNotices(
      gmail,
      {
        recipients: ['recipient@example.test'],
        subject: 'Readback distinction',
        body: 'Body',
      },
      {
        ...ledgerDeps(filePath),
        randomHex: () => 'sendreadback',
        now: () => new Date('2026-09-11T17:05:00Z'),
      },
    );
    assert.equal(result[0].status, 'PROVIDER_ACCEPTED_READBACK_FAILED');
    assert.equal(result[0].gmailMessageId, 'accepted-message');
    assert.equal(result[0].gmailThreadId, 'accepted-thread');
    assert.equal(result[0].failure?.stage, 'GMAIL_READBACK');
    assert.equal(latestTrackedSendRecords(filePath)[0].status, 'PROVIDER_ACCEPTED_READBACK_FAILED');
  }

  {
    let sendCalled = false;
    const gmail = {
      users: { messages: {
        send: async () => { sendCalled = true; return { data: { id: 'should-not-send' } }; },
        get: async () => ({ data: {} }),
      } },
    } as any;

    await assert.rejects(
      () => sendTrackedNotices(gmail, {
        recipients: ['recipient@example.test'],
        subject: 'No consent',
        body: 'Body',
        trackingMode: 'CONSENTED_FIRST_PARTY_PIXEL',
        recipientNoticeOrConsent: false,
      }),
      /refused by policy/i,
    );
    assert.equal(sendCalled, false);
  }

  {
    const filePath = tempLedger('tamper');
    appendTrackedSendRecord({
      sendId: 'tamper-1',
      recipient: 'recipient@example.test',
      subject: 'Tamper test',
      trackingMode: 'PROVIDER_STATE',
      status: 'SENT',
      gmailMessageId: 'm1',
      gmailThreadId: 't1',
    }, filePath);
    const text = fs.readFileSync(filePath, 'utf8').replace('Tamper test', 'Tampered subject');
    fs.writeFileSync(filePath, text, 'utf8');
    assert.throws(() => readTrackedSendLedger(filePath), /hash mismatch/i);
  }

  console.log('tracked notice send tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
