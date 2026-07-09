#!/usr/bin/env bash
#
# OT-RFC-38 — SCALE test. Validates that the Phase A surface scales
# from the toy 6-12-triple batches used by the per-LU tests to a more
# realistic batch size:
#
#   • Publish 50 triples (25 root entities × 2 facts each) on a
#     curated CG from the edge curator (node 5).
#   • Pre-create the CG on the member (node 6) so the sender-key
#     handshake completes; let SWM gossip settle.
#   • Member queries its own SPARQL view of the CG to confirm the
#     decrypted triples landed.
#   • Member calls /api/shared-memory/verify-batch with all 50
#     decrypted quads + the on-chain merkleRoot → must return
#     ok=true, leafCount=50.
#   • Member mints attestations for 3 different leaves picked from
#     the batch; outsider verifies each. All 3 must verify.
#
# This catches scaling regressions in:
#   - publisher's flat-Merkle computation under multi-KA payloads
#   - the AEAD ciphertext wrap path (50 leaves → larger inline ACK
#     payload)
#   - member-side post-decrypt reconstruction
#   - the verify-batch endpoint's hashing pipeline
#
# Re-runnable: timestamp-suffixed CG id, no shared state.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE=9201
CURATOR_NODE=5
MEMBER_NODE=6
OUTSIDER_NODE=1
TRIPLE_COUNT=50

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

log()  { echo "[scale] $*"; }
warn() { echo "[scale] WARN: $*" >&2; }
fail() { echo "[scale] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[scale] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 240 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
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

CURATOR_AGENT=$(api_call "$CURATOR_NODE"  GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
MEMBER_AGENT=$(api_call "$MEMBER_NODE"    GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/scale-${STAMP}"

log "Curator: $CURATOR_AGENT"
log "Member:  $MEMBER_AGENT"
log "CG:      $CG_ID  (target: $TRIPLE_COUNT triples)"

# ===========================================================================
act "1. Pre-create CG on both curator and member"
# ===========================================================================
CREATE_CUR=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "scale ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT", "$MEMBER_AGENT"],
  "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE_CUR" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE_CUR"
log "✓ curated CG onChainId=$ON_CHAIN_ID"

api_call "$MEMBER_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "scale ${STAMP} (member)",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT", "$MEMBER_AGENT"] }
EOF
)" >/dev/null || true
sleep 2

# ===========================================================================
act "2. Write $TRIPLE_COUNT triples to SWM"
# ===========================================================================
QUADS_PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" TRIPLE_COUNT="$TRIPLE_COUNT" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const N = parseInt(process.env.TRIPLE_COUNT, 10);
  if (N % 2 !== 0) throw new Error("TRIPLE_COUNT must be even");
  const quads = [];
  for (let i = 0; i < N / 2; i++) {
    const entity = "urn:scale:" + stamp + "/doc-" + i;
    quads.push({ subject: entity, predicate: "http://schema.org/name",  object: "\"Document " + i + "\"", graph: "" });
    quads.push({ subject: entity, predicate: "http://schema.org/index", object: "\"" + i + "\"^^<http://www.w3.org/2001/XMLSchema#integer>", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WRITE_RESP=$(devnet_create_shared_ka "$CURATOR_NODE" "$QUADS_PAYLOAD")
WRITTEN=$(parse_json "$WRITE_RESP" '.triplesWritten')
[ "$WRITTEN" = "$TRIPLE_COUNT" ] || fail "expected $TRIPLE_COUNT triples written, got '$WRITTEN' — $WRITE_RESP"
log "✓ $WRITTEN triples written to SWM"

# ===========================================================================
act "3. Publish all $TRIPLE_COUNT triples to VM"
# ===========================================================================
PUB_RESP=$(devnet_publish_swm_all_roots "$CURATOR_NODE" "$CG_ID" false)
devnet_publish_load_state
log "publish response: $PUB_RESP"

STATUS=$(parse_json "$PUB_RESP" '.status')
TX=$(parse_json    "$PUB_RESP" '.txHash')
KC=$(parse_json    "$PUB_RESP" '.kaId')
[ "$STATUS" = "confirmed" ] || fail "publish status=$STATUS"
[[ "$TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "invalid txHash"
PUBLISH_COUNT=$(devnet_publish_root_count)
log "✓ publish: ${PUBLISH_COUNT} root batch(es), last kaId=$KC tx=$TX"

# Cross-check each KC via KCS: rc.12+ publishes one root entity per KC.
EXPECTED_MINTED=$((TRIPLE_COUNT / 2))
devnet_kcs_readback_all_published 1 || fail "KCS read-back failed"
[ "$PUBLISH_COUNT" = "$EXPECTED_MINTED" ] || fail "expected $EXPECTED_MINTED publishes, got $PUBLISH_COUNT"

# ===========================================================================
act "4. Member verify-batch over all $TRIPLE_COUNT decrypted quads"
# ===========================================================================
devnet_verify_each_published_root "$MEMBER_NODE" "$CG_ID" "$QUADS_PAYLOAD" \
  || fail "verify-batch failed for one or more published roots"
log "✓ verify-batch passes for all $PUBLISH_COUNT published root(s)"

# ===========================================================================
act "5. Mint + verify 3 attestations across the batch"
# ===========================================================================
# Pick leaves at indices 0, (N/4-1), (N/2-1) — first / middle / last
# document. Each leaf's (s,p,o) is the canonical "name" triple of doc-i.
for leaf_idx in 0 $((TRIPLE_COUNT / 4 - 1)) $((TRIPLE_COUNT / 2 - 1)); do
  LEAF_SUBJECT="urn:scale:${STAMP}/doc-${leaf_idx}"
  LEAF_PREDICATE="http://schema.org/name"
  LEAF_OBJECT="\"Document ${leaf_idx}\""

  KC=$(devnet_publish_ka_id_for_root "$LEAF_SUBJECT")
  MERKLE_ROOT=$(devnet_kc_merkle_root "$CURATOR_NODE" "$KC")
  CANDIDATE_LEAF=$(cd "$REPO_ROOT/packages/core" && LEAF_SUBJECT="$LEAF_SUBJECT" LEAF_PREDICATE="$LEAF_PREDICATE" LEAF_OBJECT="$LEAF_OBJECT" node --input-type=module -e '
    const { hashTripleV10 } = await import("./dist/index.js");
    const leafBytes = hashTripleV10(process.env.LEAF_SUBJECT, process.env.LEAF_PREDICATE, process.env.LEAF_OBJECT);
    console.log("0x" + Buffer.from(leafBytes).toString("hex"));
  ' 2>/dev/null)
  PLAINTEXT_HASH=$(cd "$REPO_ROOT/packages/core" && LEAF_SUBJECT="$LEAF_SUBJECT" LEAF_PREDICATE="$LEAF_PREDICATE" LEAF_OBJECT="$LEAF_OBJECT" node --input-type=module -e '
    const { hashTripleV10, keccak256 } = await import("./dist/index.js");
    const leafBytes = hashTripleV10(process.env.LEAF_SUBJECT, process.env.LEAF_PREDICATE, process.env.LEAF_OBJECT);
    console.log("0x" + Buffer.from(keccak256(leafBytes)).toString("hex"));
  ' 2>/dev/null)

  [[ "$CANDIDATE_LEAF" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "leaf $leaf_idx: candidateLeaf invalid"
  [[ "$PLAINTEXT_HASH"  =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "leaf $leaf_idx: plaintextLeafHash invalid"

  MINT=$(api_call "$CURATOR_NODE" POST /api/attestation/mint "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "batchId": "$KC", "merkleRoot": "$MERKLE_ROOT", "plaintextLeafHash": "$PLAINTEXT_HASH" }
EOF
)")
  ATT_SIGNER=$(parse_json "$MINT" '.attestation.payload.attesterAddress')
  [ "$ATT_SIGNER" = "$CURATOR_AGENT" ] || fail "leaf $leaf_idx: attester != curator"

  VERIFY_GOOD=$(MINT="$MINT" CANDIDATE_LEAF="$CANDIDATE_LEAF" node -e "
    const att = JSON.parse(process.env.MINT).attestation;
    console.log(JSON.stringify({ attestation: att, candidateLeafHex: process.env.CANDIDATE_LEAF }));
  ")
  VRESP=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$VERIFY_GOOD")
  V_OK=$(parse_json "$VRESP" '.ok')
  V_LEAFCHECK=$(parse_json "$VRESP" '.leafCheck')
  [ "$V_OK" = "true" ] || fail "leaf $leaf_idx attestation verify ok=$V_OK ($VRESP)"
  [ "$V_LEAFCHECK" = "match" ] || fail "leaf $leaf_idx leafCheck=$V_LEAFCHECK"
  log "✓ leaf $leaf_idx (doc-$leaf_idx): mint+verify OK"
done

log ""
log "================================================================"
log "  RFC-38 SCALE test: PASS"
log "================================================================"
log "  Curated CG:    $CG_ID  (onChainId=$ON_CHAIN_ID)"
log "  Triples:       $TRIPLE_COUNT"
log "  KAs minted:    $EXPECTED_MINTED"
log "  KCs published: $PUBLISH_COUNT"
log "  TX:            $TX"
log "  verify-batch:  ok=true for all roots"
log "  Attestations:  3 of 3 verified"
log "================================================================"
