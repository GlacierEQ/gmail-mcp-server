#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { reconcileEmailObligation } from './reconcile-email-state.js';
import { scanEmailOperations, trackEmailThread } from './email-operations-pipeline.js';
import { evaluateTrackingMode } from './lawful-tracking-policy.js';
import { appendTrackingSnapshot, latestTrackedThreads, trackingLedgerPath } from './email-tracking-ledger.js';

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');

const ReconcileEmailObligationSchema = z.object({
  messageId: z.string().describe('Inbound Gmail message ID that may create an obligation'),
  sentInventoryComplete: z.boolean().optional().default(false),
  maxCrossThreadResults: z.number().int().min(1).max(500).optional().default(100),
});

const TrackEmailThreadSchema = z.object({
  threadId: z.string().describe('Gmail thread ID to hydrate into the operational state machine'),
  followUpAfterHours: z.number().positive().max(24 * 365).optional().default(72),
  persist: z.boolean().optional().default(false).describe('Append the resulting snapshot to the tamper-evident local tracking ledger.'),
  trackingMode: z.enum(['PROVIDER_STATE', 'EXPLICIT_RECEIPT_REQUEST', 'CONSENTED_FIRST_PARTY_PIXEL']).optional().default('PROVIDER_STATE'),
  recipientNoticeOrConsent: z.boolean().optional().default(false),
});

const ScanEmailOperationsSchema = z.object({
  query: z.string().optional().default('newer_than:30d'),
  maxThreads: z.number().int().min(1).max(100).optional().default(50),
  followUpAfterHours: z.number().positive().max(24 * 365).optional().default(72),
  openOnly: z.boolean().optional().default(false),
});

const TrackingPolicySchema = z.object({
  mode: z.enum(['PROVIDER_STATE', 'EXPLICIT_RECEIPT_REQUEST', 'CONSENTED_FIRST_PARTY_PIXEL']),
  recipientNoticeOrConsent: z.boolean().optional().default(false),
});

const ListTrackedThreadsSchema = z.object({});

async function loadOAuthClient(): Promise<OAuth2Client> {
  if (!fs.existsSync(OAUTH_PATH)) throw new Error(`OAuth keys not found at ${OAUTH_PATH}; authenticate with the primary gmail-mcp server first.`);
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error(`Gmail credentials not found at ${CREDENTIALS_PATH}; authenticate with the primary gmail-mcp server first.`);
  const keysContent = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf8'));
  const keys = keysContent.installed || keysContent.web;
  if (!keys) throw new Error('Invalid OAuth keys file: expected installed or web credentials.');
  const client = new OAuth2Client(keys.client_id, keys.client_secret, 'http://localhost:3000/oauth2callback');
  client.setCredentials(JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')));
  return client;
}

async function main() {
  const auth = await loadOAuthClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const server = new Server(
    { name: 'glaciereq-gmail-ops', version: '1.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reconcile_email_obligation',
        description: 'Determine whether an inbound message created an obligation, whether Casey already responded, response latency, and whether another search is actually required.',
        inputSchema: zodToJsonSchema(ReconcileEmailObligationSchema),
      },
      {
        name: 'track_email_thread',
        description: 'Hydrate one Gmail thread into SENT → delivery exception → ACKNOWLEDGED → ROUTED → REFERENCE_NUMBER → ASSIGNED_OFFICE → SUBSTANTIVE_RESPONSE → RECORDS_EVIDENCE_RECEIVED → FOLLOW_UP_DUE. Optionally append the snapshot to a hash-chained forensic ledger.',
        inputSchema: zodToJsonSchema(TrackEmailThreadSchema),
      },
      {
        name: 'scan_email_operations',
        description: 'Scan multiple Gmail threads for operational state, response latency, references, routing/assignment, attachments/evidence, delivery exceptions, and follow-up actions.',
        inputSchema: zodToJsonSchema(ScanEmailOperationsSchema),
      },
      {
        name: 'list_tracked_email_threads',
        description: 'Read and verify the append-only email tracking ledger, returning the latest persisted state for every tracked Gmail thread.',
        inputSchema: zodToJsonSchema(ListTrackedThreadsSchema),
      },
      {
        name: 'evaluate_email_tracking_policy',
        description: 'Evaluate provider-state, explicit receipt, or consented first-party pixel tracking under GlacierEQ privacy guardrails. Covert pixel fingerprinting, raw IP retention, precise geolocation, and third-party behavioral profiling are prohibited.',
        inputSchema: zodToJsonSchema(TrackingPolicySchema),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      switch (request.params.name) {
        case 'reconcile_email_obligation': {
          const input = ReconcileEmailObligationSchema.parse(request.params.arguments);
          const result = await reconcileEmailObligation(gmail, input);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'track_email_thread': {
          const input = TrackEmailThreadSchema.parse(request.params.arguments);
          const policy = evaluateTrackingMode(input.trackingMode, input.recipientNoticeOrConsent);
          if (!policy.allowed) throw new Error(`Tracking mode refused by policy: ${policy.rationale}`);
          const snapshot = await trackEmailThread(gmail, input.threadId, input.followUpAfterHours);
          const persisted = input.persist ? appendTrackingSnapshot(snapshot, input.trackingMode) : null;
          const result = {
            snapshot,
            trackingPolicy: policy,
            persistence: persisted ? { ledgerPath: trackingLedgerPath(), ledgerRecord: persisted } : null,
          };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'scan_email_operations': {
          const input = ScanEmailOperationsSchema.parse(request.params.arguments);
          let result = await scanEmailOperations(gmail, input.query, input.maxThreads, input.followUpAfterHours);
          if (input.openOnly) result = result.filter(item => item.openAction !== null || item.followUpDue);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'list_tracked_email_threads': {
          ListTrackedThreadsSchema.parse(request.params.arguments || {});
          const result = { ledgerPath: trackingLedgerPath(), trackedThreads: latestTrackedThreads() };
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        case 'evaluate_email_tracking_policy': {
          const input = TrackingPolicySchema.parse(request.params.arguments);
          const result = evaluateTrackingMode(input.mode, input.recipientNoticeOrConsent);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error('GlacierEQ Gmail ops server error:', error);
  process.exit(1);
});
