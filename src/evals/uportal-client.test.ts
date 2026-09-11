import assert from 'node:assert/strict';
import { fetchUportalActivity, publishUportalPixel } from '../uportal-client.js';

async function main() {
  {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init || {} });
      const body = JSON.parse(String(init?.body || '{}'));
      const page = body.page;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          message: [{
            page,
            limit: 2,
            total: 3,
            has_next: page === 1,
            items: page === 1
              ? [
                  { ts: '2026-09-01T10:00:00Z', event: 'open', publication: 'pub-1', token: 'recipient-1' },
                  { ts: '2026-09-01T10:05:00Z', event: 'content', publication: 'pub-1', token: 'recipient-1' },
                ]
              : [{ ts: '2026-09-01T10:06:00Z', event: 'download', publication: 'pub-1', token: 'recipient-1' }],
          }],
        }),
      } as any;
    }) as typeof fetch;

    const result = await fetchUportalActivity(
      { baseUrl: 'https://tracker.example.test/', userToken: 'secret-token', authHeader: 'X-User-Token' },
      { publicationId: 'pub-1', token: 'recipient-1', limit: 2, maxPages: 5 },
      mockFetch,
    );

    assert.equal(result.endpoint, 'https://tracker.example.test/api/admin/activity/list');
    assert.equal(result.pagesFetched, 2);
    assert.equal(result.totalReported, 3);
    assert.equal(result.items.length, 3);
    assert.equal(calls.length, 2);

    const firstHeaders = calls[0].init.headers as Record<string, string>;
    assert.equal(firstHeaders['X-User-Token'], 'secret-token');
    const firstBody = JSON.parse(String(calls[0].init.body));
    assert.equal(firstBody.publication_id, 'pub-1');
    assert.equal(firstBody.token, 'recipient-1');
    assert.equal(firstBody.sort_order, 'asc');
    assert.equal(String(calls[0].init.body).includes('secret-token'), false);
  }

  {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init || {} });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          message: [{
            type: 'pixel',
            status: 'active',
            publication_id: 'notice-send1',
            token: 'recipient-token',
            short_id: 'AbC123xYz',
            short_url: 'https://tracker.example.test/s/AbC123xYz',
            subj: 'Evidence notice',
            mails: ['records@example.test'],
            html: '<img src="https://tracker.example.test/s/AbC123xYz" width="1" height="1" alt="" />',
          }],
        }),
      } as any;
    }) as typeof fetch;

    const result = await publishUportalPixel(
      {
        baseUrl: 'https://tracker.example.test/',
        userToken: 'secret-token',
        clientUid: 'glaciereq-gmail-ops',
        clientType: 'web',
      },
      {
        publicationId: 'notice-send1',
        token: 'recipient-token',
        subject: 'Evidence notice',
        recipients: ['records@example.test'],
      },
      mockFetch,
    );

    assert.equal(result.publicationId, 'notice-send1');
    assert.equal(result.token, 'recipient-token');
    assert.equal(result.shortId, 'AbC123xYz');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://tracker.example.test/api/admin/publish/pixel');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-User-Token'], 'secret-token');
    assert.equal(headers['X-UPortal-Client-Uid'], 'glaciereq-gmail-ops');
    assert.equal(headers['X-UPortal-Client-Type'], 'web');
    assert.equal(String(calls[0].init.body).includes('secret-token'), false);
  }

  {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'error', message: [{ text: 'user token inactive' }] }),
    } as any)) as typeof fetch;

    await assert.rejects(
      () => fetchUportalActivity(
        { baseUrl: 'https://tracker.example.test', userToken: 'secret-token' },
        { publicationId: 'pub-1' },
        mockFetch,
      ),
      /user token inactive/,
    );
  }

  {
    const mockFetch = (async () => ({ ok: false, status: 503 } as any)) as typeof fetch;
    await assert.rejects(
      () => fetchUportalActivity(
        { baseUrl: 'https://tracker.example.test', userToken: 'secret-token' },
        { publicationId: 'pub-1' },
        mockFetch,
      ),
      /HTTP 503/,
    );
  }

  console.log('uportal client tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
