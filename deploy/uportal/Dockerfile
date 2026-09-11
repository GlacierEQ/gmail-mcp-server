# GlacierEQ evidentiary UPORTAL runtime.
# Upstream source and shhoook are commit-pinned for reproducibility.
ARG UPORTAL_COMMIT=f66b4f2fd72be1012cb9e18f7155560d66faa4b5
ARG SHHOOOK_COMMIT=1f39484cb9f9a513ae8fb232d5ec26f91b3cdd29

FROM alpine:3.20 AS source
ARG UPORTAL_COMMIT
RUN apk add --no-cache git ca-certificates python3 && \
    git clone https://github.com/mopkob1/uportal.git /src && \
    git -C /src checkout --detach "$UPORTAL_COMMIT" && \
    test "$(git -C /src rev-parse HEAD)" = "$UPORTAL_COMMIT"
COPY patch-upstream.sh /patch-upstream.sh
RUN chmod 755 /patch-upstream.sh && /patch-upstream.sh /src

FROM golang:1.24-alpine AS shhoook-builder
ARG SHHOOOK_COMMIT
RUN apk add --no-cache git ca-certificates && \
    git clone https://github.com/mopkob1/shhoook.git /src && \
    git -C /src checkout --detach "$SHHOOOK_COMMIT" && \
    test "$(git -C /src rev-parse HEAD)" = "$SHHOOOK_COMMIT"
WORKDIR /src
RUN set -eu; \
    mkdir -p /out; \
    if find /src/src -maxdepth 1 -type f -name '*.go' | grep -q .; then cd /src/src; else cd /src; fi; \
    CGO_ENABLED=0 GOOS=linux GO111MODULE=off go build -o /out/shhoook .; \
    test -x /out/shhoook

FROM node:22-alpine AS admin-builder
ARG UPORTAL_BASE_URL=https://localhost
ARG UPORTAL_UI_LANG=en
WORKDIR /src/admin
ENV VITE_UPORTAL_DEFAULT_SERVER_URL=${UPORTAL_BASE_URL}
COPY --from=source /src/admin/package*.json ./
RUN npm ci
COPY --from=source /src/admin ./
RUN set -eu; \
    npm run build -- --base=/ui/; \
    lang="$(printf '%s' "${UPORTAL_UI_LANG:-en}" | tr '[:upper:]' '[:lower:]' | cut -d- -f1)"; \
    case "$lang" in ru|en|es) ;; *) lang="en" ;; esac; \
    node -e "const fs=require('fs'); const p='dist/index.html'; const lang=process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(\"localStorage.getItem('uportal_lang') || 'en'\", \"localStorage.getItem('uportal_lang') || '\" + lang + \"'\"));" "$lang"

FROM alpine:3.20 AS plugin-builder
RUN apk add --no-cache jq zip sed
WORKDIR /src/plugin/source
ARG UPORTAL_PLUGIN_DEFAULT_BASE_URL
ARG UPORTAL_BASE_URL=https://localhost
ARG UPORTAL_DOMAIN=localhost
ARG UPORTAL_UI_LANG=en
COPY --from=source /src/VERSION /src/VERSION
COPY --from=source /src/plugin/source ./
RUN set -eu; \
    base="${UPORTAL_PLUGIN_DEFAULT_BASE_URL:-${UPORTAL_BASE_URL:-}}"; \
    if [ -z "$base" ]; then base="https://${UPORTAL_DOMAIN}"; fi; \
    base="${base%/}"; \
    lang="$(printf '%s' "${UPORTAL_UI_LANG:-en}" | tr '[:upper:]' '[:lower:]' | cut -d- -f1)"; \
    case "$lang" in ru|en|es) ;; *) lang="en" ;; esac; \
    find . -type f -exec sed -i \
      -e "s|http://localhost:8080/api/admin/dictionary|$base/api/admin/dictionary|g" \
      -e "s|http://localhost:8080/link-fallback|$base/link-fallback|g" \
      -e "s|http://localhost:8080|$base|g" \
      {} +; \
    jq --arg lang "$lang" '.preferred = $lang | .default = $lang' captions.json > captions.json.tmp; \
    mv captions.json.tmp captions.json; \
    sh scripts/pack.sh

FROM debian:bookworm-slim
ARG UPORTAL_COMMIT
ENV DEBIAN_FRONTEND=noninteractive \
    UPORTAL_EVIDENCE_MINIMAL=1 \
    UPORTAL_DISABLE_COMMERCIAL_BRIDGE=1 \
    UPORTAL_UI_LANG=en
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl jq bash inotify-tools nginx libnginx-mod-http-js pandoc procps; \
    rm -rf /var/lib/apt/lists/*
COPY --from=source /src/runtime /opt/uportal/runtime
COPY --from=source /src/VERSION /opt/uportal/VERSION
COPY --from=source /src/deploy/self-hosted-docker-compose/docker/uportal/nginx.conf /etc/nginx/nginx.conf
COPY --from=source /src/deploy/self-hosted-docker-compose/docker/uportal/entrypoint.sh /usr/local/bin/uportal-container-entrypoint
COPY --from=shhoook-builder /out/shhoook /usr/local/bin/shhoook
COPY --from=admin-builder /src/admin/dist /opt/uportal/build/admin
COPY --from=plugin-builder /src/plugin/uportal-link-inserter.xpi /opt/uportal/build/plugin/uportal-link-inserter.xpi
RUN set -eu; \
    chmod 755 /usr/local/bin/uportal-container-entrypoint /usr/local/bin/shhoook; \
    find /opt/uportal/runtime/scripts -maxdepth 1 -type f -name '*.sh' -exec chmod 755 {} \; ; \
    find /opt/uportal/runtime/service-workers -maxdepth 1 -type f -name '*.sh' -exec chmod 755 {} \; ; \
    mkdir -p /opt/uportal/git; \
    printf '%s\n' "$UPORTAL_COMMIT" > /opt/uportal/git/HEAD

VOLUME ["/data/files"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 CMD curl -fsS http://127.0.0.1:8080/ui/ >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/uportal-container-entrypoint"]
