export interface UportalClientConfig {
  baseUrl: string;
  userToken: string;
  authHeader?: string;
}

export interface UportalActivityFilters {
  publicationId?: string;
  token?: string;
  event?: string;
  from?: string;
  to?: string;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  maxPages?: number;
}

export interface UportalActivityPage {
  page: number;
  limit: number;
  total: number;
  hasNext: boolean;
  items: Record<string, unknown>[];
}

export interface UportalActivityResult {
  source: 'uportal';
  endpoint: string;
  publicationId?: string;
  token?: string;
  pagesFetched: number;
  totalReported: number;
  items: Record<string, unknown>[];
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function uportalConfigFromEnv(): UportalClientConfig {
  return {
    baseUrl: requiredEnv('UPORTAL_BASE_URL'),
    userToken: requiredEnv('UPORTAL_USER_TOKEN'),
    authHeader: process.env.UPORTAL_AUTH_HEADER?.trim() || 'X-User-Token',
  };
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('UPORTAL_BASE_URL must use http or https');
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function positiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error('UPORTAL pagination values must be positive integers');
  return Math.min(value, max);
}

function extractActivityPage(payload: unknown, requestedPage: number, requestedLimit: number): UportalActivityPage {
  if (!payload || typeof payload !== 'object') throw new Error('UPORTAL returned a non-object response');
  const root = payload as Record<string, unknown>;
  if (root.status === 'error') {
    const message = Array.isArray(root.message)
      ? root.message.map(item => typeof item === 'object' && item ? String((item as Record<string, unknown>).text || '') : String(item)).filter(Boolean).join('; ')
      : String(root.message || 'UPORTAL activity request failed');
    throw new Error(message || 'UPORTAL activity request failed');
  }

  const message = Array.isArray(root.message) && root.message.length ? root.message[0] : undefined;
  const candidate = message && typeof message === 'object'
    ? message as Record<string, unknown>
    : root.data && typeof root.data === 'object'
      ? root.data as Record<string, unknown>
      : root;
  const items = Array.isArray(candidate.items)
    ? candidate.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
  return {
    page: typeof candidate.page === 'number' ? candidate.page : requestedPage,
    limit: typeof candidate.limit === 'number' ? candidate.limit : requestedLimit,
    total: typeof candidate.total === 'number' ? candidate.total : items.length,
    hasNext: candidate.has_next === true || candidate.hasNext === true,
    items,
  };
}

export async function fetchUportalActivity(
  config: UportalClientConfig,
  filters: UportalActivityFilters,
  fetchImpl: typeof fetch = fetch,
): Promise<UportalActivityResult> {
  const baseUrl = normalizedBaseUrl(config.baseUrl);
  const authHeader = (config.authHeader || 'X-User-Token').trim();
  if (!authHeader || /[\r\n]/.test(authHeader)) throw new Error('Invalid UPORTAL auth header');
  if (!config.userToken?.trim()) throw new Error('UPORTAL user token is required');

  const limit = positiveInt(filters.limit, 200, 500);
  const maxPages = positiveInt(filters.maxPages, 10, 100);
  const endpoint = `${baseUrl}/api/admin/activity/list`;
  const items: Record<string, unknown>[] = [];
  let totalReported = 0;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const body: Record<string, unknown> = {
      page,
      limit,
      sort_order: filters.sortOrder || 'asc',
    };
    if (filters.publicationId) body.publication_id = filters.publicationId;
    if (filters.token) body.token = filters.token;
    if (filters.event) body.event = filters.event;
    if (filters.from) body.from = filters.from;
    if (filters.to) body.to = filters.to;

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [authHeader]: config.userToken,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`UPORTAL activity request failed with HTTP ${response.status}`);
    const pagePayload = extractActivityPage(await response.json(), page, limit);
    pagesFetched += 1;
    totalReported = Math.max(totalReported, pagePayload.total);
    items.push(...pagePayload.items);
    if (!pagePayload.hasNext) break;
  }

  return {
    source: 'uportal',
    endpoint,
    publicationId: filters.publicationId,
    token: filters.token,
    pagesFetched,
    totalReported,
    items,
  };
}
