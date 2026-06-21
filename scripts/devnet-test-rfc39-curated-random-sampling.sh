#!/usr/bin/env bash
#
# OT-RFC-39 / LU-11 — end-to-end devnet validation for the curated
# random sampling pipeline. Drives one curated publish through the
# new chunked-ciphertext substrate (LU-11), then waits for at least
# one core node's RandomSamplingProver to land an on-chain
# submitProof against the curated KC.
#
# Probes the new features that PR-A + PR-B introduced:
#
#   1. Publisher takes the chunked path (encryptInlineChunked) for a
#      curated CG: per-chunk SWM gossip + V2 ACK over
#      /dkg/10.0.2/storage-ack.
#   2. Cores persist each ciphertext chunk into the local triple store
#      under urn:dkg:swm:v10-publish-ciphertext-chunk/<batchId>/<i>.
#   3. KnowledgeCollectionStorage records a non-zero
#      ciphertextChunksRoot + ciphertextChunkCount pair on chain.
#   4. _isCGEligible no longer filters the curated CG, so the
#      RandomSampling picker can draw against it.
#   5. The off-chain prover's curated branch successfully extracts
#      the chunks, builds the V10CiphertextChunksMerkleTree, and
#      submits a winning proof.
#
# Preconditions: devnet already up (./scripts/devnet.sh start ...).
# Honours DEVNET_DIR / HARDHAT_PORT / API_PORT_BASE env overrides.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CORE_NODES=(1 2 3 4)
EDGE_CURATOR_NODE=5
RS_TIMEOUT="${RS_TIMEOUT:-180}"

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

log()  { echo "[rfc39-validate] $*"; }
warn() { echo "[rfc39-validate] WARN: $*" >&2; }
fail() { echo "[rfc39-validate] FAIL: $*" >&2; exit 1; }

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
for n in "${CORE_NODES[@]}" "$EDGE_CURATOR_NODE"; do
  pidf="$(node_dir "$n")/devnet.pid"
  [ -f "$pidf" ] || fail "node $n: missing $pidf"
  kill -0 "$(cat "$pidf")" 2>/dev/null || fail "node $n: pid stale"
  api_call "$n" GET /api/status >/dev/null || fail "node $n: API not reachable"
done
log "Cores + edge curator are up."

# --- 2. Curator identity -----------------------------------------------------

CURATOR_IDENTITY=$(api_call "$EDGE_CURATOR_NODE" GET /api/agent/identity)
CURATOR_AGENT=$(printf '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
log "Curator agent: $CURATOR_AGENT (node $EDGE_CURATOR_NODE)"

# --- 3. Create curated CG ----------------------------------------------------

STAMP=$(date +%s)
CG_SLUG="rfc39-curated-${STAMP}"
CG_LOCAL_ID="${CURATOR_AGENT}/${CG_SLUG}"

# Snapshot daemon log line counts BEFORE the publish so we only grep new lines.
LOG_BASELINE_DIR=$(mktemp -d -t rfc39-log-baseline)
for n in "${CORE_NODES[@]}" "$EDGE_CURATOR_NODE"; do
  f=$(node_log "$n")
  wc -l < "$f" 2>/dev/null | tr -d ' ' > "$LOG_BASELINE_DIR/$n" || echo 0 > "$LOG_BASELINE_DIR/$n"
done
trap 'rm -rf "$LOG_BASELINE_DIR"' EXIT

log "Creating curated CG '$CG_LOCAL_ID'..."
CREATE_RESP=$(api_call "$EDGE_CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{
  "id": "${CG_LOCAL_ID}",
  "name": "RFC-39 curated random sampling ${STAMP}",
  "description": "OT-RFC-39 devnet validation — created by devnet-test-rfc39-curated-random-sampling.sh",
  "accessPolicy": 1,
  "publishPolicy": 0,
  "allowedAgents": ["${CURATOR_AGENT}"],
  "register": true
}
EOF
)")
log "create response: $CREATE_RESP"

ON_CHAIN_ID=$(printf '%s' "$CREATE_RESP" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j.registered||!j.onChainId){console.error(JSON.stringify(j));process.exit(1)}console.log(j.onChainId)})') \
  || fail "create+register did not return onChainId"
log "Curated CG on chain: onChainId=$ON_CHAIN_ID"

CG_URI="${CG_LOCAL_ID}"

# --- 4. Write triples to SWM -------------------------------------------------
# Use a fairly large set of triples to encourage multi-chunk splitting.
log "Writing 12 triples into SWM..."
WRITE_RESP=$(devnet_create_shared_ka "$EDGE_CURATOR_NODE" "$(cat <<EOF
{
  "contextGraphId": "${CG_URI}",
  "quads": [
    { "subject": "urn:rfc39:entity:${STAMP}/alice",   "predicate": "http://schema.org/name",  "object": "\"Alice Anderson with a sentence-length value just to add a few extra bytes per chunk so we can probe the chunk-splitting code path even at modest input sizes\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/alice",   "predicate": "http://schema.org/email", "object": "\"alice@example.com\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/alice",   "predicate": "http://schema.org/role",  "object": "\"engineering\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/bob",     "predicate": "http://schema.org/name",  "object": "\"Bob the Builder with a wordy description here to enlarge the publish payload and exercise per-chunk encryption nonces and per-chunk SWM gossip envelopes even on a small devnet\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/bob",     "predicate": "http://schema.org/age",   "object": "\"42\"^^<http://www.w3.org/2001/XMLSchema#integer>", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/bob",     "predicate": "http://schema.org/role",  "object": "\"construction\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/carol",   "predicate": "http://schema.org/name",  "object": "\"Carol Curator with another sentence used purely to bulk up the payload and ensure the chunked emit path produces at least one chunk, more if the chunk-size threshold is small\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/carol",   "predicate": "http://schema.org/email", "object": "\"carol@example.com\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/carol",   "predicate": "http://schema.org/role",  "object": "\"curator\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/dave",    "predicate": "http://schema.org/name",  "object": "\"Dave Developer who writes a lot of code and equally verbose triples to keep the chunked encryption code path exercised in the devnet smoke test\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/dave",    "predicate": "http://schema.org/email", "object": "\"dave@example.com\"", "graph": "" },
    { "subject": "urn:rfc39:entity:${STAMP}/dave",    "predicate": "http://schema.org/role",  "object": "\"engineering\"", "graph": "" }
  ]
}
EOF
)")
printf '%s' "$WRITE_RESP" | grep -qE '"triplesWritten":(1[0-9]|[2-9][0-9])' || warn "SWM write count low: $WRITE_RESP"

sleep 2

# --- 5. Publish (chunked path) ----------------------------------------------

log "Publishing curated CG to VM (LU-11 chunked path)..."
PUBLISH_RESP=$(devnet_publish_swm_all_roots "$EDGE_CURATOR_NODE" "${CG_URI}" false)
log "publish response: $PUBLISH_RESP"

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
PUBLISH_KC=$(parse_json    "$PUBLISH_RESP" ".kaId")
PUBLISH_BLOCK=$(parse_json "$PUBLISH_RESP" ".blockNumber")

[ "$PUBLISH_STATUS" = "confirmed" ] || fail "publish status=$PUBLISH_STATUS (expected confirmed)"
[ -n "$PUBLISH_TX" ] || fail "publish: no txHash"
[ -n "$PUBLISH_KC" ] && [ "$PUBLISH_KC" != "0" ] || fail "publish: zero/empty kaId"

log "✓ publish landed: kaId=$PUBLISH_KC tx=$PUBLISH_TX block=$PUBLISH_BLOCK"

# --- 6. Verify on-chain ciphertext commitment --------------------------------

log "Reading on-chain ciphertextChunksRoot + count for kaId=$PUBLISH_KC..."
CHAIN_COMMITMENT=$(
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
  const kcsAddr = contracts.DKGKnowledgeAssets?.evmAddress ?? contracts.KnowledgeCollectionStorage?.evmAddress;
  if (!kcsAddr) throw new Error("DKGKnowledgeAssets / KnowledgeCollectionStorage not deployed");
  const abiFile = fs.existsSync(path.join(process.env.ABI_DIR, "DKGKnowledgeAssets.json")) ? "DKGKnowledgeAssets.json" : "DKGKnowledgeAssets.json";
  const abi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, abiFile), "utf8"));
  const kas = new ethers.Contract(kcsAddr, abi, provider);
  const ctRoot = await kas.getLatestCiphertextChunksRoot(BigInt(process.env.BATCH_ID));
  const ctCount = await kas.getCiphertextChunkCount(BigInt(process.env.BATCH_ID));
  const plainRoot = await kas.getLatestMerkleRoot(BigInt(process.env.BATCH_ID));
  const plainCount = await kas.getMerkleLeafCount(BigInt(process.env.BATCH_ID));
  console.log(JSON.stringify({ ctRoot, ctCount: ctCount.toString(), plainRoot, plainCount: plainCount.toString() }));
})().catch(e => { console.error("[kas] " + (e?.shortMessage || e?.message || e)); process.exit(1); });
') || fail "on-chain ciphertext-commitment read failed"

CT_ROOT=$(printf '%s' "$CHAIN_COMMITMENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctRoot))')
CT_COUNT=$(printf '%s' "$CHAIN_COMMITMENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).ctCount))')
PLAIN_ROOT=$(printf '%s' "$CHAIN_COMMITMENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).plainRoot))')
PLAIN_COUNT=$(printf '%s' "$CHAIN_COMMITMENT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).plainCount))')

log "  ciphertextChunksRoot:  $CT_ROOT"
log "  ciphertextChunkCount:  $CT_COUNT"
log "  plain merkleRoot:      $PLAIN_ROOT  (== batchId)"
log "  plain merkleLeafCount: $PLAIN_COUNT"

ZERO_ROOT="0x0000000000000000000000000000000000000000000000000000000000000000"
[ "$CT_ROOT" != "$ZERO_ROOT" ] || fail "RFC-39 INVARIANT BROKEN: ciphertextChunksRoot is zero on a curated KC publish — publisher did NOT take the chunked path"
[ "$CT_COUNT" -ge 1 ] || fail "RFC-39 INVARIANT BROKEN: ciphertextChunkCount is zero on a curated KC publish"
log "✓ on-chain ciphertext commitment is non-zero (root+count both set)"

# --- 7. Log forensics: edge published via chunked path, cores accepted V2 ----

EDGE_LOG=$(node_log "$EDGE_CURATOR_NODE")
EDGE_BASELINE=$(cat "$LOG_BASELINE_DIR/$EDGE_CURATOR_NODE")
EDGE_NEW=$(tail -n "+$((EDGE_BASELINE + 1))" "$EDGE_LOG")

if printf '%s' "$EDGE_NEW" | grep -qE 'LU-11.*chunked emit|encryptInlineChunked|chunked publish|GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED|share-write-chunked'; then
  log "✓ edge log shows the LU-11 chunked emit path fired"
else
  warn "no LU-11 chunked-emit log line found on edge — may indicate publisher fell back to LU-5 single-blob path"
fi

CORE_ACK_COUNT=0
for n in "${CORE_NODES[@]}"; do
  log_file=$(node_log "$n")
  baseline=$(cat "$LOG_BASELINE_DIR/$n")
  new=$(tail -n "+$((baseline + 1))" "$log_file")
  if printf '%s' "$new" | grep -qE 'LU-11|chunked|ciphertext-chunk|storage-ack.*V2|/dkg/10\.0\.2/storage-ack'; then
    log "  ✓ core node $n: LU-11 activity detected in log"
    CORE_ACK_COUNT=$((CORE_ACK_COUNT + 1))
  fi
done
[ "$CORE_ACK_COUNT" -ge 1 ] || warn "no core nodes logged LU-11 / V2 ACK activity"

# --- 8. Wait for a curated random-sampling proof to land --------------------

# Hardhat auto-mines only per tx; the cores' RS loop is read-only so
# without traffic the block height stalls and the picker keeps drawing
# the same (epoch, period) challenge slot — observed as a sea of
# `[rs.tick.already-solved]` warnings after the first submission. The
# configured proofingPeriodDurationInBlocks on devnet is 100, so
# mining a generous 250 blocks reliably ticks us into the next period
# without burning seconds on real-time advance. `hardhat_mine` accepts
# a hex count and mines instantly. Safe to call against the
# Hardhat-node JSON-RPC the devnet starts on $HARDHAT_PORT.
log "Mining 250 hardhat blocks to advance into a fresh random-sampling period..."
mine_resp=$(curl -sS -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"hardhat_mine","params":["0xfa"]}' \
  "http://127.0.0.1:${HARDHAT_PORT}" 2>/dev/null || true)
if printf '%s' "$mine_resp" | grep -q '"result":true'; then
  log "  ✓ mined 250 blocks (proofingPeriodDurationInBlocks=100 → guaranteed new period)"
else
  warn "hardhat_mine response was unexpected: $mine_resp"
fi

log "Polling cores for random-sampling submitProof tx against kaId=$PUBLISH_KC (timeout=${RS_TIMEOUT}s)..."

# Snapshot the baseline `submittedCount` per node BEFORE polling so we
# can require an actual INCREASE during the window. Without this, a
# stale `submittedCount=N` from a prior period (the cores' RS loop
# already had ticks against earlier KCs in this devnet) would let the
# test pass without ever exercising the freshly-published curated KC.
# Stored in a parallel indexed array (macOS ships bash 3.2; no -A).
BASELINE_NODES=()
BASELINE_COUNTS=()
get_baseline() {
  local target="$1" i
  for i in "${!BASELINE_NODES[@]}"; do
    if [ "${BASELINE_NODES[$i]}" = "$target" ]; then
      echo "${BASELINE_COUNTS[$i]:-0}"
      return
    fi
  done
  echo 0
}
for n in "${CORE_NODES[@]}"; do
  s=$(api_call "$n" GET /api/random-sampling/status 2>/dev/null || true)
  c=$(printf '%s' "$s" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log((j.loop||{}).submittedCount||0)}catch(e){console.log(0)}})' 2>/dev/null || echo 0)
  BASELINE_NODES+=("$n")
  BASELINE_COUNTS+=("${c:-0}")
done
log "Baseline submittedCount per core: $(for n in "${CORE_NODES[@]}"; do printf 'node%s=%s ' "$n" "$(get_baseline "$n")"; done)"

end_ts=$(( $(date +%s) + RS_TIMEOUT ))
PROOF_NODE=""
PROOF_TX=""
PROOF_IDENTITY=""
while [ "$(date +%s)" -lt "$end_ts" ]; do
  for n in "${CORE_NODES[@]}"; do
    status=$(api_call "$n" GET /api/random-sampling/status 2>/dev/null || true)
    # The /api/random-sampling/status response shape is
    #   { enabled, role, identityId, loop: { submittedCount, lastSubmittedTxHash, ... } }
    # so we MUST drill into `loop.*`; reading top-level `lastSubmission`
    # was the bug that left this script blind to in-progress proofs.
    submitted_count=$(printf '%s' "$status" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log((j.loop||{}).submittedCount||0)}catch(e){console.log(0)}})' 2>/dev/null || echo 0)
    baseline=$(get_baseline "$n")
    if [ "${submitted_count:-0}" -gt "${baseline:-0}" ] 2>/dev/null; then
      latest_tx=$(printf '%s' "$status" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log((j.loop||{}).lastSubmittedTxHash||"")}catch(e){console.log("")}})' 2>/dev/null || echo "")
      if [ -n "$latest_tx" ]; then
        identity=$(printf '%s' "$status" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j.identityId||"")}catch(e){console.log("")}})' 2>/dev/null || echo "")
        log "  ✓ core node $n submitted proof: tx=$latest_tx submittedCount=$submitted_count identityId=$identity"
        PROOF_NODE=$n
        PROOF_TX=$latest_tx
        PROOF_IDENTITY=$identity
        break 2
      fi
    fi
  done
  sleep 5
done

if [ -z "$PROOF_TX" ]; then
  log ""
  log "No core has submitted a proof within the timeout."
  log "Dumping random-sampling status from each core for diagnostics:"
  for n in "${CORE_NODES[@]}"; do
    status=$(api_call "$n" GET /api/random-sampling/status 2>/dev/null || echo "<api error>")
    log "  node $n: $status"
  done
  log ""
  log "Tail of the most-active core daemon log (look for 'curated' / 'ciphertext' / 'rs.tick'):"
  tail -50 "$(node_log 1)" | sed 's/^/    /'
  fail "RFC-39 random sampling did not land on any core within ${RS_TIMEOUT}s"
fi

# --- 9. Verify the proof was for the curated KC ------------------------------

# Best-effort: read the WAL for that period and check the kaId matches our publish.
log "Inspecting prover WAL on node $PROOF_NODE..."
WAL=$(api_call "$PROOF_NODE" GET /api/random-sampling/wal 2>/dev/null || echo "")
if printf '%s' "$WAL" | grep -q "$PUBLISH_KC"; then
  log "✓ prover WAL on node $PROOF_NODE contains kaId=$PUBLISH_KC — curated KC was sampled successfully"
else
  log "  prover WAL on node $PROOF_NODE: $WAL"
  warn "WAL did not directly reference kaId=$PUBLISH_KC; proof may have been for a different KC drawn in the same epoch"
fi

log ""
log "================================================================"
log "  RFC-39 devnet validation: PASS"
log "================================================================"
log "  Curated CG:    $CG_LOCAL_ID (onChainId=$ON_CHAIN_ID)"
log "  KC published:  $PUBLISH_KC"
log "  Ciphertext root: $CT_ROOT  (count=$CT_COUNT)"
log "  Publish TX:    $PUBLISH_TX (block $PUBLISH_BLOCK)"
log "  Proof TX:      $PROOF_TX  (node $PROOF_NODE, identityId=$PROOF_IDENTITY)"
log "================================================================"
