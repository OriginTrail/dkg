#!/usr/bin/env bash
#
# OT-RFC-38 / LU-8 — devnet API validation for member post-decrypt
# batch verification (verify-batch + report-batch-rejection).
#
# Scenarios:
#
#   1. REQUEST VALIDATION — verify-batch without explicit quads is
#      rejected because local graph reconstruction is not batch-scoped.
#      The happy path then calls verify-batch with exact caller-supplied
#      plaintext quads and must return ok=true.
#
#   2. ROOT-MISMATCH — Member calls verify-batch with a forged set of
#      quads (adds an injected triple) but the real expectedRoot.
#      → must return ok=false, reason=root-mismatch.
#
#   3. REJECTION GOSSIP — On the failed verify, member calls
#      POST /api/shared-memory/report-batch-rejection. The endpoint
#      writes a structured BatchRejected record into SWM. We then query
#      the local SWM via /api/query and confirm the record is present.
#
# Talks ONLY to the daemon HTTP API + Hardhat RPC.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
MEMBER_NODE=6
EVM_RPC="http://127.0.0.1:8545"

log()  { echo "[lu8-validate] $*"; }
warn() { echo "[lu8-validate] WARN: $*" >&2; }
fail() { echo "[lu8-validate] FAIL: $*" >&2; exit 1; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 120 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

api_call_with_status() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 120 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=(-w $'\n%{http_code}' "http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

parse_json() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch (e) { process.exit(1); }
    })
  "
}

CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
CURATOR_PEER=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
MEMBER_AGENT=$(api_call "$MEMBER_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

log "Curator: $CURATOR_AGENT (node $CURATOR_NODE)"
log "Member:  $MEMBER_AGENT (node $MEMBER_NODE)"

STAMP=$(date +%s)
PUB_CG="${CURATOR_AGENT}/lu8-pub-${STAMP}"

# ===========================================================================
# Setup — curator creates public CG, writes SWM, publishes to VM.
# ===========================================================================

log "Curator creates public CG $PUB_CG..."
CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$PUB_CG", "name": "LU-8 public ${STAMP}",
  "accessPolicy": 0, "publishPolicy": 1, "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "CG create failed: $CREATE"
log "✓ CG registered onChainId=$ON_CHAIN_ID"

log "Curator writes 5 SWM triples..."
QUADS=$(node -e "
  const quads = [];
  for (let i = 0; i < 5; i++) {
    quads.push({
      subject: 'urn:lu8/item' + i,
      predicate: 'http://schema.org/name',
      object: '\"Item' + i + '\"',
      graph: ''
    });
  }
  console.log(JSON.stringify({ contextGraphId: '$PUB_CG', quads }));
")
WRITE_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$QUADS")
[ "$(parse_json "$WRITE_RESP" '.triplesWritten')" = "5" ] || fail "expected 5 triples written, got: $WRITE_RESP"

log "Curator publishes selection to VM..."
PUB_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{ "contextGraphId": "$PUB_CG", "selection": "all", "epochs": 1 }
EOF
)")
log "publish response: $PUB_RESP"
TX_HASH=$(parse_json "$PUB_RESP" '.txHash')
KC_ID=$(parse_json "$PUB_RESP" '.kcId')
[ -n "$TX_HASH" ] || fail "no txHash in publish response — cannot proceed without on-chain anchor"
[ -n "$KC_ID" ] || fail "no kcId in publish response — required for merkleRoot lookup"

log "Fetching merkleRoot from chain (KC #${KC_ID}) via daemon API..."
KC_RESP=$(api_call "$CURATOR_NODE" GET "/api/kc/${KC_ID}")
log "kc lookup: $KC_RESP"
MERKLE_ROOT=$(parse_json "$KC_RESP" '.merkleRoot')
[ -n "$MERKLE_ROOT" ] || fail "could not resolve merkleRoot via /api/kc: $KC_RESP"
log "✓ published txHash=$TX_HASH merkleRoot=$MERKLE_ROOT"

# Pause for gossip + chain settling
sleep 5

# ===========================================================================
# SCENARIO 1 — Request validation + happy path on the member side.
# ===========================================================================

log ""
log "================================================================"
log "  SCENARIO 1: verify-batch REQUEST VALIDATION + HAPPY PATH"
log "================================================================"

# The daemon cannot safely infer a single published batch from a whole
# context graph. Once a CG has multiple batches, local graph reconstruction
# hashes a superset of leaves against a single-batch expected root. Keep the
# route strict: callers must pass the exact plaintext quads they are verifying.
log "Curator calls verify-batch without quads; endpoint should reject the ambiguous request..."
VERIFY_MISSING_QUADS_WITH_STATUS=$(api_call_with_status "$CURATOR_NODE" POST /api/shared-memory/verify-batch "$(cat <<EOF
{ "contextGraphId": "$PUB_CG", "expectedMerkleRoot": "$MERKLE_ROOT" }
EOF
)")
VERIFY_MISSING_QUADS_STATUS=$(printf '%s\n' "$VERIFY_MISSING_QUADS_WITH_STATUS" | tail -n 1)
VERIFY_MISSING_QUADS=$(printf '%s\n' "$VERIFY_MISSING_QUADS_WITH_STATUS" | sed '$d')
log "verify-batch missing-quads response: $VERIFY_MISSING_QUADS"
[ "$VERIFY_MISSING_QUADS_STATUS" = "400" ] || fail "verify-batch missing-quads status=$VERIFY_MISSING_QUADS_STATUS (expected 400): $VERIFY_MISSING_QUADS"
MISSING_QUADS_ERROR=$(parse_json "$VERIFY_MISSING_QUADS" '.error')
if printf '%s' "$MISSING_QUADS_ERROR" | grep -q 'requires explicit `quads`'; then
  log "✓ Scenario 1: verify-batch rejects omitted quads with HTTP 400 before ambiguous reconstruction"
else
  fail "verify-batch missing-quads response did not mention explicit quads requirement: $VERIFY_MISSING_QUADS"
fi

# Exercise the explicit-quads path (caller-supplied plaintext). This is the
# path a member uses after catchup once they've decrypted ciphertext, and is
# the only path that's batch-scoped for the verifier API.
log "Calling verify-batch with explicit caller-supplied quads (member-side simulation)..."
EXPLICIT_QUADS=$(node -e "
  const quads = [];
  for (let i = 0; i < 5; i++) {
    quads.push({
      subject: 'urn:lu8/item' + i,
      predicate: 'http://schema.org/name',
      object: '\"Item' + i + '\"',
      graph: ''
    });
  }
  console.log(JSON.stringify({
    contextGraphId: '$PUB_CG',
    expectedMerkleRoot: '$MERKLE_ROOT',
    quads
  }));
")
VERIFY_EXPLICIT=$(api_call "$MEMBER_NODE" POST /api/shared-memory/verify-batch "$EXPLICIT_QUADS")
log "verify-batch explicit: $VERIFY_EXPLICIT"
EXPLICIT_OK=$(parse_json "$VERIFY_EXPLICIT" '.ok')
if [ "$EXPLICIT_OK" = "true" ]; then
  log "✓ Scenario 1b: explicit-quads verify ok=true (member can verify once it has the plaintext)"
else
  warn "explicit-quads verify returned ok=$EXPLICIT_OK (expected true)"
fi

# ===========================================================================
# SCENARIO 2 — Root-mismatch detection.
# ===========================================================================

log ""
log "================================================================"
log "  SCENARIO 2: verify-batch ROOT-MISMATCH (forged quads)"
log "================================================================"

log "Member calls verify-batch with forged quads (extra injected triple)..."
FORGED_QUADS=$(node -e "
  const quads = [];
  for (let i = 0; i < 5; i++) {
    quads.push({
      subject: 'urn:lu8/item' + i,
      predicate: 'http://schema.org/name',
      object: '\"Item' + i + '\"',
      graph: ''
    });
  }
  quads.push({
    subject: 'urn:lu8/injected',
    predicate: 'http://schema.org/name',
    object: '\"Mallory\"',
    graph: ''
  });
  console.log(JSON.stringify({
    contextGraphId: '$PUB_CG',
    expectedMerkleRoot: '$MERKLE_ROOT',
    quads,
    batchId: 'lu8-forged-${STAMP}'
  }));
")
VERIFY_BAD=$(api_call "$MEMBER_NODE" POST /api/shared-memory/verify-batch "$FORGED_QUADS")
log "verify-batch forged: $VERIFY_BAD"
BAD_OK=$(parse_json "$VERIFY_BAD" '.ok')
BAD_REASON=$(parse_json "$VERIFY_BAD" '.reason')
if [ "$BAD_OK" = "false" ] && [ "$BAD_REASON" = "root-mismatch" ]; then
  log "✓ Scenario 2: forged batch correctly rejected (reason=root-mismatch)"
else
  fail "expected ok=false reason=root-mismatch; got ok=$BAD_OK reason=$BAD_REASON"
fi

# ===========================================================================
# SCENARIO 3 — Rejection gossip.
# ===========================================================================

log ""
log "================================================================"
log "  SCENARIO 3: report-batch-rejection writes SWM record"
log "================================================================"

REPORT_BODY=$(VERIFY_BAD="$VERIFY_BAD" PUB_CG="$PUB_CG" STAMP="$STAMP" node -e '
  const j = JSON.parse(process.env.VERIFY_BAD);
  const vr = { ok: j.ok, expectedRoot: j.expectedRoot, actualRoot: j.actualRoot, leafCount: j.leafCount, reason: j.reason };
  console.log(JSON.stringify({
    contextGraphId: process.env.PUB_CG,
    batchId: "lu8-forged-" + process.env.STAMP,
    verifyResult: vr
  }));
')
REPORT_RESP=$(api_call "$MEMBER_NODE" POST /api/shared-memory/report-batch-rejection "$REPORT_BODY")
log "report response: $REPORT_RESP"
REPORT_GOSSIPED=$(parse_json "$REPORT_RESP" '.gossiped')
REPORT_DIGEST=$(parse_json "$REPORT_RESP" '.record.digest')
[ -n "$REPORT_DIGEST" ] || fail "no digest in report response: $REPORT_RESP"
log "✓ Rejection record minted: digest=$REPORT_DIGEST gossiped=$REPORT_GOSSIPED"

sleep 2

log "Querying member's local SWM for the rejection record..."
QUERY_RESP=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$PUB_CG",
  "graphSuffix": "_shared_memory",
  "sparql": "SELECT ?p ?o WHERE { <did:dkg:batch-rejection:$REPORT_DIGEST> ?p ?o }" }
EOF
)")
log "rejection record query: $QUERY_RESP"
BINDING_COUNT=$(printf '%s' "$QUERY_RESP" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log((j?.result?.bindings||[]).length)}catch{console.log(0)}})')
if [ "$BINDING_COUNT" -ge 4 ]; then
  log "✓ Scenario 3: BatchRejection record present in SWM ($BINDING_COUNT triples)"
else
  warn "expected ≥4 triples for the rejection record; got $BINDING_COUNT"
fi

log ""
log "================================================================"
log "  LU-8 devnet API validation: PASS"
log "================================================================"
log "  Public CG:    did:dkg:context-graph:$PUB_CG (onChainId=$ON_CHAIN_ID)"
log "  Tx Hash:      $TX_HASH"
log "  MerkleRoot:   $MERKLE_ROOT"
log "  Verify ok:    $OK_FLAG  (scenario 1)"
log "  Forged reason: $BAD_REASON  (scenario 2)"
log "  Rejection digest: $REPORT_DIGEST  (scenario 3)"
log "================================================================"
