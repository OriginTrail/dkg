#!/usr/bin/env bash
#
# Post-rc.12 devnet regression for PR #879.
#
# Public + open context graphs intentionally replicate readable SWM triples
# to subscribed peers. Import-artifact read routes must therefore relax the
# owner guard for cross-agent READS on that policy combo, while still:
#   - letting the owner read source markdown bytes normally;
#   - reporting honest non-owner metadata (`ownerGuardRelaxed=true`);
#   - returning 404 rather than 403 when the non-owner lacks source bytes;
#   - rejecting non-owner semantic-enrichment WRITES.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
OWNER_NODE="${OWNER_NODE:-1}"
READER_NODE="${READER_NODE:-2}"
SYNC_TIMEOUT_S="${SYNC_TIMEOUT_S:-90}"

log()  { echo "[import-artifact-po] $*"; }
warn() { echo "[import-artifact-po] WARN: $*" >&2; }
fail() { echo "[import-artifact-po] FAIL: $*" >&2; exit 1; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

api_capture() {
  local node="$1" method="$2" path="$3" data="${4:-}" body_out="$5" code_out="$6"
  local port token tmp code body
  port="$(node_port "$node")"
  token="$(node_token "$node")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/import-artifact-po-XXXXXX")"
  if [ -n "$data" ]; then
    code="$(curl -sS --max-time 60 -o "$tmp" -w "%{http_code}" \
      -X "$method" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d "$data" \
      "http://127.0.0.1:${port}${path}" 2>/dev/null || echo "000")"
  else
    code="$(curl -sS --max-time 60 -o "$tmp" -w "%{http_code}" \
      -X "$method" \
      -H "Authorization: Bearer $token" \
      "http://127.0.0.1:${port}${path}" 2>/dev/null || echo "000")"
  fi
  body="$(cat "$tmp")"
  rm -f "$tmp"
  printf -v "$body_out" '%s' "$body"
  printf -v "$code_out" '%s' "$code"
}

json_get() {
  node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const path = process.argv[1].split(".");
        let v = j;
        for (const p of path) v = v?.[p];
        if (v === undefined || v === null) return;
        if (typeof v === "object") console.log(JSON.stringify(v));
        else console.log(String(v));
      } catch {
        process.exit(1);
      }
    });
  ' "$1"
}

urlenc() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

log "Owner node=$OWNER_NODE, reader node=$READER_NODE"

OWNER_IDENTITY=""
api_capture "$OWNER_NODE" GET /api/agent/identity "" OWNER_IDENTITY owner_code
[ "$owner_code" = "200" ] || fail "owner identity failed: HTTP $owner_code $OWNER_IDENTITY"
OWNER_AGENT="$(printf '%s' "$OWNER_IDENTITY" | json_get agentAddress)"
[ -n "$OWNER_AGENT" ] || fail "owner identity missing agentAddress: $OWNER_IDENTITY"

STAMP="$(date +%s)"
CG_ID="${OWNER_AGENT}/import-artifact-po-${STAMP}"
ASSERTION_NAME="import-artifact-po-${STAMP}"
MARKER="public-open import artifact ${STAMP}"

log "Creating public+open CG $CG_ID"
CREATE_BODY=$(cat <<EOF
{ "id": "$CG_ID", "name": "import artifact public open $STAMP",
  "accessPolicy": 0, "publishPolicy": 1, "register": true }
EOF
)
CREATE_RESP=""
api_capture "$OWNER_NODE" POST /api/context-graph/create "$CREATE_BODY" CREATE_RESP create_code
[ "$create_code" = "200" ] || fail "context graph create failed: HTTP $create_code $CREATE_RESP"
ON_CHAIN="$(printf '%s' "$CREATE_RESP" | json_get onChainId)"
[ -n "$ON_CHAIN" ] || fail "context graph create response missing onChainId: $CREATE_RESP"
log "Created CG on-chain id=$ON_CHAIN"

log "Subscribing reader node to public+open CG"
SUB_BODY="{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}"
SUB_OK=0
for _ in $(seq 1 30); do
  SUB_RESP=""
  api_capture "$READER_NODE" POST /api/context-graph/subscribe "$SUB_BODY" SUB_RESP sub_code
  if [ "$sub_code" = "200" ]; then
    SUB_OK=1
    break
  fi
  sleep 2
done
[ "$SUB_OK" = "1" ] || fail "reader subscribe failed: HTTP ${sub_code:-?} ${SUB_RESP:-}"
log "Reader subscribed"

TMP_MD="$(mktemp "${TMPDIR:-/tmp}/import-artifact-po-XXXXXX.md")"
trap 'rm -f "$TMP_MD"' EXIT
cat > "$TMP_MD" <<EOF
# Import Artifact Public Open

$MARKER
EOF

log "Importing markdown into owner assertion $ASSERTION_NAME"
IMPORT_TMP="$(mktemp "${TMPDIR:-/tmp}/import-artifact-po-import-XXXXXX")"
owner_port="$(node_port "$OWNER_NODE")"
owner_token="$(node_token "$OWNER_NODE")"
import_code="$(curl -sS --max-time 90 -o "$IMPORT_TMP" -w "%{http_code}" \
  -H "Authorization: Bearer $owner_token" \
  -F "file=@${TMP_MD};type=text/markdown" \
  -F "contextGraphId=${CG_ID}" \
  -F "contentType=text/markdown" \
  "http://127.0.0.1:${owner_port}/api/assertion/$(urlenc "$ASSERTION_NAME")/import-file" 2>/dev/null || echo "000")"
IMPORT_RESP="$(cat "$IMPORT_TMP")"
rm -f "$IMPORT_TMP"
[ "$import_code" = "200" ] || fail "import-file failed: HTTP $import_code $IMPORT_RESP"
ASSERTION_URI="$(printf '%s' "$IMPORT_RESP" | json_get assertionUri)"
FILE_HASH="$(printf '%s' "$IMPORT_RESP" | json_get fileHash)"
[ -n "$ASSERTION_URI" ] || fail "import response missing assertionUri: $IMPORT_RESP"
[ -n "$FILE_HASH" ] || fail "import response missing fileHash: $IMPORT_RESP"
log "Imported assertionUri=$ASSERTION_URI fileHash=$FILE_HASH"

log "Owner self-read must return markdown bytes without ownerGuardRelaxed"
READ_BODY="{\"contextGraphId\":\"$CG_ID\",\"assertionUri\":\"$ASSERTION_URI\",\"assertionName\":\"$ASSERTION_NAME\",\"maxBytes\":65536}"
OWNER_READ=""
api_capture "$OWNER_NODE" POST /api/assertion/import-artifact/read-markdown "$READ_BODY" OWNER_READ owner_read_code
[ "$owner_read_code" = "200" ] || fail "owner read-markdown failed: HTTP $owner_read_code $OWNER_READ"
OWNER_RELAXED="$(printf '%s' "$OWNER_READ" | json_get artifact.ownerGuardRelaxed || true)"
OWNER_MARKDOWN="$(printf '%s' "$OWNER_READ" | json_get markdown || true)"
[ -z "$OWNER_RELAXED" ] || fail "owner read unexpectedly surfaced ownerGuardRelaxed=$OWNER_RELAXED"
printf '%s' "$OWNER_MARKDOWN" | grep -F "$MARKER" >/dev/null \
  || fail "owner markdown did not contain marker"
log "Owner markdown read OK"

log "Promoting imported assertion to SWM so subscribed peer can resolve metadata"
PROMOTE_RESP=""
api_capture "$OWNER_NODE" POST "/api/assertion/$(urlenc "$ASSERTION_NAME")/promote" \
  "{\"contextGraphId\":\"$CG_ID\"}" PROMOTE_RESP promote_code
[ "$promote_code" = "200" ] || fail "promote failed: HTTP $promote_code $PROMOTE_RESP"
log "Promote response: $PROMOTE_RESP"

log "Polling reader resolve for ownerGuardRelaxed=true (timeout ${SYNC_TIMEOUT_S}s)"
deadline=$(( $(date +%s) + SYNC_TIMEOUT_S ))
RESOLVE_RESP=""
resolve_code="000"
while [ "$(date +%s)" -lt "$deadline" ]; do
  api_capture "$READER_NODE" POST /api/assertion/import-artifact/resolve "$READ_BODY" RESOLVE_RESP resolve_code
  if [ "$resolve_code" = "200" ]; then
    break
  fi
  if [ "$resolve_code" = "403" ]; then
    fail "reader resolve got 403 owner guard denial on public+open CG: $RESOLVE_RESP"
  fi
  sleep 3
done
[ "$resolve_code" = "200" ] || fail "reader resolve never succeeded: HTTP $resolve_code $RESOLVE_RESP"
READER_RELAXED="$(printf '%s' "$RESOLVE_RESP" | json_get artifact.ownerGuardRelaxed || true)"
[ "$READER_RELAXED" = "true" ] \
  || fail "reader resolve did not surface ownerGuardRelaxed=true: $RESOLVE_RESP"
log "Reader resolve OK with ownerGuardRelaxed=true"

log "Reader read-markdown must not 403; current expected shape is 404 until bytes replicate"
READER_READ=""
api_capture "$READER_NODE" POST /api/assertion/import-artifact/read-markdown "$READ_BODY" READER_READ reader_read_code
case "$reader_read_code" in
  200)
    warn "reader has source bytes locally; byte replication may now be implemented"
    ;;
  404)
    rr_relaxed="$(printf '%s' "$READER_READ" | json_get artifact.ownerGuardRelaxed || true)"
    [ "$rr_relaxed" = "true" ] \
      || fail "reader 404 did not include ownerGuardRelaxed artifact: $READER_READ"
    log "Reader read-markdown returned expected 404 with ownerGuardRelaxed metadata"
    ;;
  403)
    fail "reader read-markdown got 403 owner guard denial on public+open CG: $READER_READ"
    ;;
  *)
    fail "reader read-markdown unexpected HTTP $reader_read_code: $READER_READ"
    ;;
esac

log "Reader semantic-enrichment write must stay forbidden"
SEM_BODY=$(cat <<EOF
{ "contextGraphId": "$CG_ID", "assertionUri": "$ASSERTION_URI", "assertionName": "$ASSERTION_NAME",
  "semanticQuads": [
    { "subject": "urn:semantic:$STAMP", "predicate": "http://schema.org/name", "object": "\"forbidden\"" }
  ] }
EOF
)
SEM_RESP=""
api_capture "$READER_NODE" POST /api/assertion/semantic-enrichment/write "$SEM_BODY" SEM_RESP sem_code
[ "$sem_code" = "403" ] \
  || fail "semantic-enrichment write should be 403 for non-owner, got HTTP $sem_code $SEM_RESP"

log "PASS: public+open import-artifact read relaxation works without opening writes"
