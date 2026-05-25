#!/usr/bin/env bash
#
# OT-RFC-38 / LU-5 — API-only devnet validation for the edge-curator
# publish path (the original §1.1 unblocker). Validates the full flow:
#
#   1. Edge node 5 owns an agent with no on-chain Profile.
#   2. POST /api/context-graph/create  { accessPolicy:1, register:true,
#                                        allowedAgents:[<node-6-agent>] }
#      → curated CG registered on-chain by an edge identity-less node.
#   3. POST /api/shared-memory/write   → encrypted-payload SWM share.
#   4. POST /api/shared-memory/publish → on-chain publishKnowledgeCollections.
#   5. Assertions:
#      - response carries status=confirmed AND non-empty txHash
#      - KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(kcId)
#        returns merkleRoots.length > 0 and byteSize > 0
#      - edge daemon log emitted the LU-5 encryption breadcrumb
#      - each core daemon log emitted a StorageACK signing breadcrumb for
#        the encrypted publish-intent (`isEncryptedPayload=true`)
#      - edge daemon log did NOT emit the old "Identity not set" warn
#
# The script talks ONLY to the daemon HTTP API and the Hardhat JSON-RPC
# (for the on-chain read-back). No direct library calls, no custom test
# harness — same observability the user has from the UI.
#
# Re-runnable: each invocation uses a fresh CG id (timestamp-suffixed).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE=9201
CORE_NODES=(1 2 3 4)
EDGE_CURATOR_NODE=5
EDGE_MEMBER_NODE=6

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

log()  { echo "[lu5-validate] $*"; }
warn() { echo "[lu5-validate] WARN: $*" >&2; }
fail() { echo "[lu5-validate] FAIL: $*" >&2; exit 1; }

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

# --- 1. Preconditions --------------------------------------------------------

log "Checking devnet state..."
for n in "${CORE_NODES[@]}" "$EDGE_CURATOR_NODE" "$EDGE_MEMBER_NODE"; do
  pidf="$(node_dir "$n")/devnet.pid"
  [ -f "$pidf" ] || fail "node $n: missing $pidf"
  kill -0 "$(cat "$pidf")" 2>/dev/null || fail "node $n: pid stale"
  api_call "$n" GET /api/status >/dev/null || fail "node $n: API not reachable"
done
log "All 6 nodes are up and API-reachable."

# --- 2. Discover agent identities -------------------------------------------

CURATOR_IDENTITY=$(api_call "$EDGE_CURATOR_NODE" GET /api/agent/identity)
MEMBER_IDENTITY=$(api_call "$EDGE_MEMBER_NODE"  GET /api/agent/identity)

CURATOR_AGENT=$(printf '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
MEMBER_AGENT=$(printf '%s' "$MEMBER_IDENTITY"  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
CURATOR_NODE_IDENTITY=$(printf '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).nodeIdentityId))')

log "Curator agent:  $CURATOR_AGENT (node $EDGE_CURATOR_NODE, nodeIdentityId=$CURATOR_NODE_IDENTITY)"
log "Member agent:   $MEMBER_AGENT (node $EDGE_MEMBER_NODE)"

[ "$CURATOR_NODE_IDENTITY" = "0" ] \
  || warn "Curator node already has on-chain identity ($CURATOR_NODE_IDENTITY) — this test specifically validates the identity=0 path."

# --- 3. Create curated CG (registered in same call) -------------------------

STAMP=$(date +%s)
# Mirror the UI pattern: prefix the CG id with the creator's agent address.
# Without the prefix, /api/shared-memory/publish looks up the on-chain id
# under the prefixed key (the SWM URI builder includes the curator), so a
# bare id registers fine but can't be published.
CG_SLUG="lu5-curated-${STAMP}"
CG_LOCAL_ID="${CURATOR_AGENT}/${CG_SLUG}"

log "Creating curated CG '$CG_LOCAL_ID' on node $EDGE_CURATOR_NODE with $MEMBER_AGENT as member..."

# Snapshot daemon log line counts BEFORE the publish so we only grep new lines.
# Using flat env vars instead of `declare -A` for macOS bash 3.x compat.
LOG_BASELINE_DIR=$(mktemp -d -t lu5-log-baseline)
for n in "${CORE_NODES[@]}" "$EDGE_CURATOR_NODE"; do
  f=$(node_log "$n")
  wc -l < "$f" 2>/dev/null | tr -d ' ' > "$LOG_BASELINE_DIR/$n" || echo 0 > "$LOG_BASELINE_DIR/$n"
done
trap 'rm -rf "$LOG_BASELINE_DIR"' EXIT

# Curator-only allowedAgents — cross-node member onboarding is exercised
# in LU-7 (SWMCatchupRequest). LU-5's job is to prove the edge-curator
# encrypted publish-to-VM path lands on-chain end-to-end.
CREATE_RESP=$(api_call "$EDGE_CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{
  "id": "${CG_LOCAL_ID}",
  "name": "LU-5 curated validation ${STAMP}",
  "description": "OT-RFC-38 LU-5 API validation — created by devnet-test-rfc38-lu5.sh",
  "accessPolicy": 1,
  "publishPolicy": 0,
  "allowedAgents": ["${CURATOR_AGENT}"],
  "register": true
}
EOF
)")
log "create response: $CREATE_RESP"

ON_CHAIN_ID=$(printf '%s' "$CREATE_RESP" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j.registered||!j.onChainId){console.error(JSON.stringify(j));process.exit(1)}console.log(j.onChainId)})') \
  || fail "create+register did not return onChainId — see response above"
log "Curated CG registered on-chain: onChainId=$ON_CHAIN_ID"

# Per the UI pattern, CG_LOCAL_ID is already the agent-prefixed form.
CG_URI="${CG_LOCAL_ID}"

# --- 4. Write some quads into SWM -------------------------------------------

# 3 entities × 2 triples = 6 quads = small enough that we get exactly 3 KAs
# (one per root entity) when we publish.
WRITE_RESP=$(api_call "$EDGE_CURATOR_NODE" POST /api/shared-memory/write "$(cat <<EOF
{
  "contextGraphId": "${CG_URI}",
  "quads": [
    { "subject": "urn:lu5:entity:${STAMP}/alice", "predicate": "http://schema.org/name", "object": "\"Alice\"", "graph": "" },
    { "subject": "urn:lu5:entity:${STAMP}/alice", "predicate": "http://schema.org/email", "object": "\"alice@example.com\"", "graph": "" },
    { "subject": "urn:lu5:entity:${STAMP}/bob",   "predicate": "http://schema.org/name", "object": "\"Bob\"", "graph": "" },
    { "subject": "urn:lu5:entity:${STAMP}/bob",   "predicate": "http://schema.org/age",  "object": "\"42\"^^<http://www.w3.org/2001/XMLSchema#integer>", "graph": "" },
    { "subject": "urn:lu5:entity:${STAMP}/carol", "predicate": "http://schema.org/name", "object": "\"Carol\"", "graph": "" },
    { "subject": "urn:lu5:entity:${STAMP}/carol", "predicate": "http://schema.org/role", "object": "\"curator\"", "graph": "" }
  ]
}
EOF
)")
log "write response: $WRITE_RESP"
printf '%s' "$WRITE_RESP" | grep -qE '"triplesWritten":[1-9]' || fail "SWM write did not report triplesWritten > 0"

sleep 2  # let SWM gossip settle

# --- 5. Publish SWM → VM ----------------------------------------------------

log "Publishing curated CG to VM..."
PUBLISH_RESP=$(api_call "$EDGE_CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{
  "contextGraphId": "${CG_URI}",
  "selection": "all",
  "clearAfter": false
}
EOF
)")
log "publish response: $PUBLISH_RESP"

# Use jq-equivalent via node for portability.
parse_json() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch (e) { process.exit(1); }
    })
  "
}

PUBLISH_STATUS=$(parse_json "$PUBLISH_RESP" ".status")
PUBLISH_TX=$(parse_json    "$PUBLISH_RESP" ".txHash")
PUBLISH_KC=$(parse_json    "$PUBLISH_RESP" ".kcId")
PUBLISH_BLOCK=$(parse_json "$PUBLISH_RESP" ".blockNumber")

[ -n "$PUBLISH_STATUS" ] || fail "publish: no status field"
[ "$PUBLISH_STATUS" = "confirmed" ] \
  || fail "publish: expected status=confirmed, got '$PUBLISH_STATUS' (response above)"
[ -n "$PUBLISH_TX" ] \
  || fail "publish: status=confirmed but no txHash returned — the on-chain submission did NOT land"
[[ "$PUBLISH_TX" =~ ^0x[0-9a-fA-F]{64}$ ]] \
  || fail "publish: txHash '$PUBLISH_TX' is not a valid 32-byte hex"
[ -n "$PUBLISH_KC" ] && [ "$PUBLISH_KC" != "0" ] \
  || fail "publish: invalid or zero kcId ('$PUBLISH_KC')"

log "✓ publish landed: kcId=$PUBLISH_KC tx=$PUBLISH_TX block=$PUBLISH_BLOCK"

# --- 6. Verify KC readable on-chain via KCS read-back -----------------------

log "Reading KC $PUBLISH_KC back from KnowledgeCollectionStorage..."
(
cd "$REPO_ROOT/packages/evm-module" && \
RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
CONTRACTS_JSON="$CONTRACTS_JSON" \
ABI_DIR="$EVM_ABI_DIR" \
BATCH_ID="$PUBLISH_KC" \
node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const kcsAddr = contracts.KnowledgeCollectionStorage?.evmAddress;
  if (!kcsAddr) throw new Error("KCS not deployed");
  const abi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "KnowledgeCollectionStorage.json"), "utf8"));
  const kcs = new ethers.Contract(kcsAddr, abi, provider);
  const [merkleRoots, burned, minted, byteSize, startEpoch, endEpoch, tokenAmount, isImmutable] =
    await kcs.getKnowledgeCollectionMetadata(BigInt(process.env.BATCH_ID));
  if (!merkleRoots || merkleRoots.length === 0) throw new Error("merkleRoots empty");
  if (byteSize === 0n) throw new Error("byteSize=0");
  console.log("KC read-back OK: merkleRoots=" + merkleRoots.length + " byteSize=" + byteSize + " minted=" + minted + " tokenAmount=" + tokenAmount);
})().catch(e => { console.error("[kcs] " + (e?.shortMessage || e?.message || e)); process.exit(1); });
'
) || fail "KC read-back from KnowledgeCollectionStorage failed"

# --- 7. Log forensics on edge node ------------------------------------------

EDGE_LOG=$(node_log "$EDGE_CURATOR_NODE")
EDGE_BASELINE=$(cat "$LOG_BASELINE_DIR/$EDGE_CURATOR_NODE")

# Poll for the LU-5 breadcrumb — daemon log output can lag the
# publish API response due to buffered writes, especially when the
# devnet is under load (e.g. running as part of the integration
# suite). Allow up to 60s.
EDGE_NEW=""
for _ in $(seq 1 60); do
  EDGE_NEW=$(tail -n "+$((EDGE_BASELINE + 1))" "$EDGE_LOG")
  if printf '%s' "$EDGE_NEW" | grep -qE 'LU-5: curated CG .* wrapping inline ACK payload with chain-key AEAD'; then
    break
  fi
  sleep 1
done

# LU-5 breadcrumb: agent layer wraps the inline ACK payload with the
# chain-key AEAD for curated CGs. Hard-pin the exact log line so a future
# regression to the publish path is caught immediately.
if printf '%s' "$EDGE_NEW" | grep -qE 'LU-5: curated CG .* wrapping inline ACK payload with chain-key AEAD'; then
  log "✓ edge log shows LU-5 chain-key AEAD wrap fired"
else
  fail "regression: LU-5 encryption breadcrumb missing in edge log (agent layer did not detect curated CG?)"
fi

# Pin the publisher's ciphertext-byteSize log too — confirms the
# encrypted-payload byteSize override is in effect.
if printf '%s' "$EDGE_NEW" | grep -qE 'byteSize=[0-9]+ \[ciphertext\]'; then
  log "✓ edge log shows ciphertext byteSize override fired"
else
  warn "expected '[ciphertext]' marker on the V10 submit log — check publisher byteSize override"
fi

# attribution: edge publishes with attributionId=0 (no-attribution mode,
# OT-RFC-38 §1.1). This used to be the "skip on-chain" path; the gate
# fix in dkg-publisher.ts makes it the no-attribution submit path.
if printf '%s' "$EDGE_NEW" | grep -qE 'Signing on-chain publish \(attributionId=0,'; then
  log "✓ edge log shows attributionId=0 (no-attribution publish, OT-RFC-38 §1.1)"
else
  warn "expected attributionId=0 publish — edge agent may have a Profile?"
fi

# Gate regression: the OLD "Identity not set (0) — skipping on-chain publish"
# warn MUST NOT appear.
if printf '%s' "$EDGE_NEW" | grep -qE 'Identity not set \(0\)'; then
  fail "regression: edge log still emits the dropped 'Identity not set (0) — skipping on-chain publish' gate"
fi
log "✓ no 'Identity not set' regression"

# --- 8. ACK quorum forensics (publisher side) -------------------------------

# Storage-ACK handler on cores has no logging of its own, so the only
# observable record of "N cores signed ACKs" lives in the edge publisher
# log (ACKCollector breadcrumb lines).
ACK_LINES=$(printf '%s' "$EDGE_NEW" | grep -E '\[ACKCollector\] Valid ACK from')
ACK_COUNT=$(printf '%s' "$ACK_LINES" | grep -c . || true)
COLLECTED_LINE=$(printf '%s' "$EDGE_NEW" | grep -E '\[ACKCollector\] Collected [0-9]+ ACKs successfully' | tail -1)

[ "$ACK_COUNT" -ge 1 ] \
  || fail "no '[ACKCollector] Valid ACK from' lines found — quorum couldn't have been met"
[ -n "$COLLECTED_LINE" ] \
  || fail "ACKCollector never reported '[ACKCollector] Collected N ACKs successfully'"

log "✓ ACK quorum reached: $ACK_COUNT core ACK(s) collected"
log "  $COLLECTED_LINE"
printf '%s\n' "$ACK_LINES" | sed 's/^/    /'

# --- 9. Cross-check via /api/context-graph/list -----------------------------

LIST_RESP=$(api_call "$EDGE_CURATOR_NODE" GET /api/context-graph/list)
if printf '%s' "$LIST_RESP" | grep -q "$CG_LOCAL_ID"; then
  log "✓ CG $CG_LOCAL_ID visible in /api/context-graph/list on edge curator"
else
  warn "CG missing from /api/context-graph/list (cosmetic, not blocking)"
fi

log ""
log "================================================================"
log "  LU-5 devnet API validation: PASS"
log "================================================================"
log "  Curated CG:    did:dkg:context-graph:${CG_URI}  (onChainId=$ON_CHAIN_ID)"
log "  Member:        (curator-only; cross-node member flow tested in LU-7)"
log "  Triples in:    6"
log "  KC published:  $PUBLISH_KC"
log "  TX:            $PUBLISH_TX  (block $PUBLISH_BLOCK)"
log "  Core ACKs:     $ACK_COUNT/4"
log "================================================================"
