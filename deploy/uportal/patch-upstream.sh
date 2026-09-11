#!/usr/bin/env sh
set -eu

ROOT="${1:-/src}"
TRACK="$ROOT/runtime/scripts/uportal-track-event.sh"
PORTAL="$ROOT/runtime/njs/portal.js"
ENTRY="$ROOT/deploy/self-hosted-docker-compose/docker/uportal/entrypoint.sh"

for file in "$TRACK" "$PORTAL" "$ENTRY"; do
  [ -f "$file" ] || { echo "missing upstream UPORTAL file: $file" >&2; exit 1; }
done

python3 - "$TRACK" "$PORTAL" "$ENTRY" <<'PY'
from pathlib import Path
import sys

track = Path(sys.argv[1])
portal = Path(sys.argv[2])
entry = Path(sys.argv[3])

# Evidence-minimal runtime: preserve event/publication/token/timestamp metadata while
# refusing storage of raw network, browser, persistent-UID, and fingerprint inputs.
text = track.read_text()
needle = 'ACCEPT_LANGUAGE_B64="${17:-}"\n'
insert = '''ACCEPT_LANGUAGE_B64="${17:-}"

# GlacierEQ evidence-minimal profile. Raw recipient network/device telemetry is
# deliberately discarded before any event record or device key is produced.
if [ "${UPORTAL_EVIDENCE_MINIMAL:-1}" = "1" ]; then
  IP=""
  XFF=""
  UA=""
  REFERER=""
  ACCEPT_LANGUAGE=""
  RAW_UID=""
  PAGE_COOKIE=""
  PW_COOKIE=""
  UA_B64=""
  REFERER_B64=""
  ACCEPT_LANGUAGE_B64=""
fi
'''
if 'GlacierEQ evidence-minimal profile' not in text:
    if needle not in text:
        raise SystemExit('UPORTAL track-event contract changed: insertion anchor missing')
    text = text.replace(needle, insert, 1)
track.write_text(text)

# Do not issue a durable cross-request recipient UID cookie in this deployment.
text = portal.read_text()
needle = 'function ensureUidCookie(r) {\n'
replacement = '''function ensureUidCookie(r) {
    // GlacierEQ evidence-minimal profile: recipient identity is publication/token
    // scoped; do not create or persist a cross-request browser UID.
    return 'nouid';
'''
if 'GlacierEQ evidence-minimal profile: recipient identity' not in text:
    if needle not in text:
        raise SystemExit('UPORTAL portal contract changed: UID function anchor missing')
    text = text.replace(needle, replacement, 1)
portal.write_text(text)

# Community UPORTAL normally attempts a vendor bridge call for the Thunderbird
# plugin redirect. For an evidentiary deployment, keep that integration disabled
# by default; the locally built plugin remains available.
text = entry.read_text()
needle = 'register_plugin_commercial_redirect() {\n'
replacement = '''register_plugin_commercial_redirect() {
  if [ "${UPORTAL_DISABLE_COMMERCIAL_BRIDGE:-1}" = "1" ]; then
    return 1
  fi
'''
if 'UPORTAL_DISABLE_COMMERCIAL_BRIDGE' not in text:
    if needle not in text:
        raise SystemExit('UPORTAL entrypoint contract changed: commercial bridge anchor missing')
    text = text.replace(needle, replacement, 1)

# Allow the hosting provider to inject a stable first-user token so the Gmail MCP
# can use it without scraping deployment logs. If absent, preserve upstream random generation.
needle = '  first_user_token="$(rand_hex | cut -c1-48)"\n'
replacement = '  first_user_token="${UPORTAL_FIRST_USER_TOKEN:-$(rand_hex | cut -c1-48)}"\n'
if 'UPORTAL_FIRST_USER_TOKEN' not in text:
    if needle not in text:
        raise SystemExit('UPORTAL entrypoint contract changed: first-user token anchor missing')
    text = text.replace(needle, replacement, 1)

# Never print credentials into provider logs.
needle = '  echo "admin token: $ADMIN_SECRET"\n  echo "first user token: $first_user_token"\n'
replacement = '  echo "UPORTAL bootstrap credentials initialized"\n'
if needle in text:
    text = text.replace(needle, replacement, 1)
entry.write_text(text)
PY

# Fail closed if the hardening did not land.
grep -q 'GlacierEQ evidence-minimal profile' "$TRACK"
grep -q "return 'nouid'" "$PORTAL"
grep -q 'UPORTAL_DISABLE_COMMERCIAL_BRIDGE' "$ENTRY"
grep -q 'UPORTAL_FIRST_USER_TOKEN' "$ENTRY"
if grep -q 'echo "first user token:' "$ENTRY"; then
  echo 'UPORTAL token log redaction failed' >&2
  exit 1
fi
