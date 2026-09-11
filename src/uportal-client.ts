export interface UportalClientConfig {
  baseUrl: string;
  userToken: string;
  authHeader?: string;
  clientUid?: string;
  clientType?: 'web' | 'plugin';
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

export interface UportalPixelPublishInput {
  publicationId: string;
  token: string;
  subject: string;
  recipients: string[];
  freshUntil?: string;
  remainingClicks?: number;
  fallbackUrl?: string;
  sticky?: boolean;
  lang?: 'auto' | 'en' | 'ru' | 'es';
  templateSet?: string;
}

export interface UportalPixelPublication {
  source: 'uportal';
  type: 'pixel';
  status: string;
  publicationId: string;
  token: string;
  shortId: string;
  shortUrl: string;
  subject: string;
  recipients: string[];
  html: string;
  publishedResponseSha256?: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function uportalConfigFromEnv(): UportalClientConfig {
  const configuredType = process.env.UPORTAL_CLIENT_TYPE?.trim().toLowerCase();
  if (configuredType && !['web', 'plugin'].includes(configuredType)) {
    throw new Error('UPORTAL_CLIENT_TYPE must be web or plugin');
  }
  return {
    baseUrl: requiredEnv('UPORTAL_BASE_URL'),
    userToken: requiredEnv('UPORTAL_USER_TOKEN'),
    authHeader: process.env.UPORTAL_AUTH_HEADER?.trim() || 'X-User-Token',
    clientUid: process.env.UPORTAL_CLIENT_UID?.trim() || 'glaciereq-gmail-ops',
    clientType: (configuredType as 'web' | 'plugin' | undefined) || 'web',
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

function validatedAuthHeader(config: UportalClientConfig): string {
  const authHeader = (config.authHeader || 'X-User-Token').trim();
  if (!authHeader || /[\r\n]/.test(authHeader)) throw new Error('Invalid UPORTAL auth header');
  if (!config.userToken?.trim()) throw new Error('UPORTAL user token is required');
  return authHeader;
}

function publishClientHeaders(config: UportalClientConfig): Record<string, string> {
  const clientUid = (config.clientUid || 'glaciereq-gmail-ops').trim();
  const clientType = config.clientType || 'web';
  if (!clientUid || /[\r\n]/.test(clientUid)) throw new Error('Invalid UPORTAL client UID');
  if (!['web', 'plugin'].includes(clientType)) throw new Error('Invalid UPORTAL client type');
  return {
    'X-UPortal-Client-Uid': clientUid,
    'X-UPortal-Client-Type': clientType,
  };
}

function positiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error('UPORTAL pagination values must be positive integers');
  return Math.min(value, max);
}

function errorText(root: Record<string, unknown>): string {
  if (Array.isArray(root.message)) {
    const joined = root.message
      .map(item => typeof item === 'object' && item ? String((item as Record<string, unknown>).text || '') : String(item))
      .filter(Boolean)
      .join('; ');
    if (joined) return joined;
  }
  if (typeof root.message === 'string' && root.message) return root.message;
  if (typeof root.error === 'string' && root.error) return root.error;
  return 'UPORTAL request failed';
}

function successMessage(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') throw new Error('UPORTAL returned a non-object response');
  const root = payload as Record<string, unknown>;
  if (root.status === 'error') throw new Error(errorText(root));
  const message = Array.isArray(root.message) && root.message.length ? root.message[0] : undefined;
  if (message && typeof message === 'object') return message as Record<string, unknown>;
  if (root.data && typeof root.data === 'object') return root.data as Record<string, unknown>;
  return root;
}

function extractActivityPage(payload: unknown, requestedPage: number, requestedLimit: number): UportalActivityPage {
  const candidate = successMessage(payload);
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
  const authHeader = validatedAuthHeader(config);
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim())
    : [];
}

export async function publishUportalPixel(
  config: UportalClientConfig,
  input: UportalPixelPublishInput,
  fetchImpl: typeof fetch = fetch,
): Promise<UportalPixelPublication> {
  const baseUrl = normalizedBaseUrl(config.baseUrl);
  const authHeader = validatedAuthHeader(config);
  const clientHeaders = publishClientHeaders(config);
  if (!input.publicationId.trim()) throw new Error('UPORTAL publicationId is required');
  if (!input.token.trim()) throw new Error('UPORTAL token is required');
  if (!input.subject.trim()) throw new Error('UPORTAL subject is required');
  if (!input.recipients.length || input.recipients.some(recipient => !recipient.trim())) {
    throw new Error('UPORTAL pixel requires at least one recipient');
  }

  const endpoint = `${baseUrl}/api/admin/publish/pixel`;
  const body = {
    type: 'pixel',
    status: 'active',
    publication_id: input.publicationId,
    token: input.token,
    short: '',
    subj: input.subject,
    mails: input.recipients,
    fresh_until: input.freshUntil || '-1',
    remaining_clicks: String(input.remainingClicks ?? -1),
    fallback_url: input.fallbackUrl || '',
    sticky: input.sticky ? '1' : '',
    lang: input.lang || 'en',
    template_set: input.templateSet || 'default',
  };

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [authHeader]: config.userToken,
      ...clientHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`UPORTAL pixel publish failed with HTTP ${response.status}`);
  const candidate = successMessage(await response.json());

  const publicationId = String(candidate.publication_id || input.publicationId);
  const token = String(candidate.token || input.token);
  const shortId = String(candidate.short_id || '');
  const shortUrl = String(candidate.short_url || candidate.short || candidate.shortlink || '');
  const html = String(candidate.html || '');
  const subject = String(candidate.subj || input.subject);
  const recipients = stringArray(candidate.mails).length ? stringArray(candidate.mails) : input.recipients;
  if (!publicationId || !token || !html) throw new Error('UPORTAL pixel publish response is missing publication binding or HTML');

  return {
    source: 'uportal',
    type: 'pixel',
    status: String(candidate.status || 'active'),
    publicationId,
    token,
    shortId,
    shortUrl,
    subject,
    recipients,
    html,
  };
}
