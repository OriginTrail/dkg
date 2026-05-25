#!/usr/bin/env bash
#
# OT-RFC-38 / LU-5 regression sweep — same flow but with a PUBLIC CG.
# Confirms the gate-drop in dkg-publisher.ts (OT-RFC-38 §1.1) didn't
# accidentally break the public-CG publish path (which already worked
# pre-RFC-38).
#
# Differences from devnet-test-rfc38-lu5.sh:
#   - accessPolicy: 0 (public), publishPolicy: 1 (open)
#   - no allowedAgents
#   - edge log MUST NOT show the LU-5 chain-key AEAD wrap (public CG
#     doesn't encrypt the inline payload)
#
# Same node API surface, same on-chain read-back.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE=9201
EDGE_CURATOR_NODE=5

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

log()  { echo "[lu5-pub-validate] $*"; }
warn() { echo "[lu5-pub-validate] WARN: $*" >&2; }
fail() { echo "[lu5-pub-validate] FAIL: $*" >&2; exit 1; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }
node_log()    { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

CURATOR_IDENTITY=$(api_call "$EDGE_CURATOR_NODE" GET /api/agent/identity)
CURATOR_AGENT=$(printf '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

STAMP=$(date +%s)
CG_LOCAL_ID="${CURATOR_AGENT}/lu5-public-${STAMP}"

EDGE_BASELINE=$(wc -l < "$(node_log "$EDGE_CURATOR_NODE")" 2>/dev/null | tr -d ' ' || echo 0)

log "Creating PUBLIC CG '$CG_LOCAL_ID' on node $EDGE_CURATOR_NODE..."
CREATE_RESP=$(api_call "$EDGE_CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "${CG_LOCAL_ID}", "name": "LU-5 public regression ${STAMP}",
  "accessPolicy": 0, "publishPolicy": 1, "register": true }
EOF
)")
ON_CHAIN_ID=$(printf '%s' "$CREATE_RESP" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j.registered)process.exit(1);console.log(j.onChainId)})') \
  || fail "create+register failed: $CREATE_RESP"
log "Public CG onChainId=$ON_CHAIN_ID"

log "Writing public quads to SWM..."
WRITE_RESP=$(api_call "$EDGE_CURATOR_NODE" POST /api/shared-memory/write "$(cat <<EOF
{ "contextGraphId": "${CG_LOCAL_ID}",
  "quads": [
    { "subject": "urn:lu5pub:${STAMP}/a", "predicate": "http://schema.org/name", "object": "\"PublicA\"", "graph": "" },
    { "subject": "urn:lu5pub:${STAMP}/b", "predicate": "http://schema.org/name", "object": "\"PublicB\"", "graph": "" }
  ] }
EOF
)")
printf '%s' "$WRITE_RESP" | grep -qE '"triplesWritten":[1-9]' || fail "public SWM write failed: $WRITE_RESP"
sleep 2

log "Publishing public CG to VM..."
PUBLISH_RESP=$(api_call "$EDGE_CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{ "contextGraphId": "${CG_LOCAL_ID}", "selection": "all", "clearAfter": false }
EOF
)")
log "publish response: $PUBLISH_RESP"

parse_json() { printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const v=j$2;console.log(v==null?'':v)}catch(e){process.exit(1)}})"; }

STATUS=$(parse_json "$PUBLISH_RESP" ".status")
TX=$(parse_json    "$PUBLISH_RESP" ".txHash")
KC=$(parse_json    "$PUBLISH_RESP" ".kcId")

[ "$STATUS" = "confirmed" ] || fail "expected status=confirmed, got '$STATUS'"
[[ "$TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "invalid txHash '$TX'"
log "✓ public publish landed: kcId=$KC tx=$TX"

# Verify on-chain
(
cd "$REPO_ROOT/packages/evm-module" && \
RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" CONTRACTS_JSON="$CONTRACTS_JSON" ABI_DIR="$EVM_ABI_DIR" BATCH_ID="$KC" \
node -e '
const { ethers } = require("ethers");
const fs = require("fs"); const path = require("path");
(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const kcs = new ethers.Contract(contracts.KnowledgeCollectionStorage.evmAddress,
    JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "KnowledgeCollectionStorage.json"), "utf8")), provider);
  const [merkleRoots, , minted, byteSize] = await kcs.getKnowledgeCollectionMetadata(BigInt(process.env.BATCH_ID));
  if (!merkleRoots || merkleRoots.length === 0) throw new Error("no merkleRoots");
  console.log("KC read-back OK: merkleRoots=" + merkleRoots.length + " byteSize=" + byteSize + " minted=" + minted);
})().catch(e => { console.error(e?.message || e); process.exit(1); });
'
) || fail "KC read-back failed"

# Critical regression guard: a public CG MUST NOT trigger the LU-5
# chain-key AEAD wrap path.
EDGE_NEW=$(tail -n "+$((EDGE_BASELINE + 1))" "$(node_log "$EDGE_CURATOR_NODE")")
if printf '%s' "$EDGE_NEW" | grep -qE "LU-5: curated CG ${CG_LOCAL_ID//\//\\/} .* wrapping inline ACK payload"; then
  fail "regression: public CG triggered LU-5 chain-key AEAD wrap (should ONLY fire for curated CGs)"
fi
log "✓ public CG correctly skipped the LU-5 encryption path"

# Public publishes use byteSize from plaintext (no [ciphertext] marker)
if printf '%s' "$EDGE_NEW" | grep -qE "byteSize=[0-9]+ \[ciphertext\]"; then
  warn "public CG publish log mentions [ciphertext] — verify byteSize override is curated-only"
fi

log ""
log "================================================================"
log "  LU-5 public-CG regression: PASS"
log "================================================================"
log "  Public CG:     did:dkg:context-graph:${CG_LOCAL_ID}  (onChainId=$ON_CHAIN_ID)"
log "  KC:            $KC"
log "  TX:            $TX"
log "================================================================"
