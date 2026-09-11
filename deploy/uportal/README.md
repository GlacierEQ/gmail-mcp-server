# GlacierEQ Evidentiary UPORTAL

This directory builds the live first-party engagement sensor used by `gmail-ops-mcp`.
It is pinned to UPORTAL `f66b4f2fd72be1012cb9e18f7155560d66faa4b5` (0.2.54) and shhoook `1f39484cb9f9a513ae8fb232d5ec26f91b3cdd29`.

## Evidence profile

The image preserves UPORTAL publication/token/event/timestamp metadata needed to correlate controlled-resource access with an outbound Gmail notice. The GlacierEQ patch deliberately disables persistent recipient UID cookies and discards raw IP/X-Forwarded-For/User-Agent/Accept-Language/referrer/cookie inputs before raw event records are written. The default commercial plugin bridge callback is disabled.

This sensor does **not** assert that a tracker event proves a named human read an email, that provider acceptance proves delivery, or that email constitutes formal legal service. Those propositions remain separate in Notice Evidence.

## Runtime

The container listens on port `8080` and requires a persistent volume mounted at `/data/files`.

Required runtime configuration:

- `UPORTAL_DOMAIN` — public host name, without scheme.
- `UPORTAL_BASE_URL` / `UPORTAL_PUBLIC_BASE_URL` / `UPORTAL_SHORT_BASE_URL` — normally the same `https://<host>` URL.
- `UPORTAL_ADMIN_SECRET` — high-entropy provider secret.
- `UPORTAL_FIRST_USER_TOKEN` — high-entropy provider secret shared only with the Gmail ops runtime as `UPORTAL_USER_TOKEN`.

Recommended configuration:

- `UPORTAL_EVIDENCE_MINIMAL=1`
- `UPORTAL_DISABLE_COMMERCIAL_BRIDGE=1`
- `UPORTAL_UI_LANG=en`
- `UPORTAL_FALLBACK_URL=https://<host>/link-fallback`
- `UPORTAL_DOWNLOAD_SALT`, `UPORTAL_STAT_SECRET`, `UPORTAL_PAGE_SECRET`, `UPORTAL_INTERNAL_KEY` — independent high-entropy secrets.

The upstream entrypoint persists first-run state under `/data/files/uportal`. This build accepts `UPORTAL_FIRST_USER_TOKEN` so deployment automation can provision a stable user token without reading a secret from logs; token logging is removed from the image.

## Gmail ops client

The Gmail runtime must receive, through its secret manager rather than source control:

- `UPORTAL_BASE_URL=https://<host>`
- `UPORTAL_USER_TOKEN=<same value as UPORTAL_FIRST_USER_TOKEN>`
- `UPORTAL_AUTH_HEADER=X-User-Token`
- `UPORTAL_CLIENT_UID=glaciereq-gmail-ops`
- `UPORTAL_CLIENT_TYPE=web`

UPORTAL requires `X-UPortal-Client-Uid` and `X-UPortal-Client-Type` for publish endpoints; the GlacierEQ client sends both.

## Provider deployment

Use the repository subdirectory `deploy/uportal` as the build context and `Dockerfile` as the image definition. Attach durable storage at `/data/files`, expose container port `8080`, generate the secrets above in the hosting provider, then assign an HTTPS public domain.

After the domain exists, redeploy with `UPORTAL_DOMAIN` and `UPORTAL_BASE_URL` set to that final domain so the built admin UI and Thunderbird package point to the correct instance.

## Required readback before operational use

A deployment is not considered live until all of the following succeed:

1. HTTPS `GET /ui/` returns a successful response.
2. Authenticated `POST /api/admin/publish/pixel` with `X-User-Token`, `X-UPortal-Client-Uid`, and `X-UPortal-Client-Type` returns a publication ID, token, short URL, and pixel HTML.
3. Authenticated `POST /api/admin/activity/list` can query the test publication.
4. The test activity payload, if generated, contains no retained raw network/device identifiers under the evidence-minimal profile.
5. The Gmail MCP client can use the same base URL and user token without putting the secret in request bodies or evidence records.

No real third-party email is required for this deployment verification.
