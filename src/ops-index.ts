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

const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const OAUTH_PATH = process.env.GMAIL_OAUTH_PATH || path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = process.env.GMAIL_CREDENTIALS_PATH || path.join(CONFIG_DIR, 'credentials.json');

const ReconcileEmailObligationSchema = z.object({
  messageId: z.string().describe('Inbound Gmail message ID that may create an obligation'),
  sentInventoryComplete: z.boolean().optional().default(false).describe(
    'Set true only when the caller knows the relevant Sent inventory is exhaustive; enables a proven unresponded state without another search.'
  ),
  maxCrossThreadResults: z.number().int().min(1).max(500).optional().default(100).describe(
    'Maximum Sent candidates checked when a reply may have been sent as a standalone message.'
  ),
});

async function loadOAuthClient(): Promise<OAuth2Client> {
  if (!fs.existsSync(OAUTH_PATH)) {
    throw new Error(`OAuth keys not found at ${OAUTH_PATH}; authenticate with the primary gmail-mcp server first.`);
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Gmail credentials not found at ${CREDENTIALS_PATH}; authenticate with the primary gmail-mcp server first.`);
  }

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
    {
      name: 'glaciereq-gmail-ops',
      version: '1.0.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reconcile_email_obligation',
        description:
          'Hydrates an inbound Gmail message, exact thread chronology, and cross-thread Sent candidates to determine whether it created an obligation, whether Casey already responded, both response latencies when available, and whether another search is actually required.',
        inputSchema: zodToJsonSchema(ReconcileEmailObligationSchema),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (request.params.name !== 'reconcile_email_obligation') {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }
      const input = ReconcileEmailObligationSchema.parse(request.params.arguments);
      const result = await reconcileEmailObligation(gmail, input);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`,
          },
        ],
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error('GlacierEQ Gmail ops server error:', error);
  process.exit(1);
});
