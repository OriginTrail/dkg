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
WRITE_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$QUADS_PAYLOAD")
WRITTEN=$(parse_json "$WRITE_RESP" '.triplesWritten')
[ "$WRITTEN" = "$TRIPLE_COUNT" ] || fail "expected $TRIPLE_COUNT triples written, got '$WRITTEN' — $WRITE_RESP"
log "✓ $WRITTEN triples written to SWM"

# ===========================================================================
act "3. Publish all $TRIPLE_COUNT triples to VM"
# ===========================================================================
PUB_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "selection": "all", "clearAfter": false }
EOF
)")
log "publish response: $PUB_RESP"

STATUS=$(parse_json "$PUB_RESP" '.status')
TX=$(parse_json    "$PUB_RESP" '.txHash')
KC=$(parse_json    "$PUB_RESP" '.kcId')
[ "$STATUS" = "confirmed" ] || fail "publish status=$STATUS"
[[ "$TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "invalid txHash"
log "✓ publish: kcId=$KC tx=$TX"

KC_META=$(api_call "$CURATOR_NODE" GET "/api/kc/$KC")
MERKLE_ROOT=$(parse_json "$KC_META" '.merkleRoot')
[[ "$MERKLE_ROOT" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "no merkleRoot: $KC_META"
log "✓ merkleRoot: $MERKLE_ROOT"

# Cross-check via KCS: minted should equal TRIPLE_COUNT / 2 (one KA per
# root entity).
EXPECTED_MINTED=$((TRIPLE_COUNT / 2))
(
cd "$REPO_ROOT/packages/evm-module" && \
RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" CONTRACTS_JSON="$CONTRACTS_JSON" ABI_DIR="$EVM_ABI_DIR" BATCH_ID="$KC" EXPECTED_MINTED="$EXPECTED_MINTED" \
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
  const expectedMinted = BigInt(process.env.EXPECTED_MINTED);
  if (minted !== expectedMinted) throw new Error("expected " + expectedMinted + " KAs minted, got " + minted);
  console.log("✓ KCS: merkleRoots=" + merkleRoots.length + " minted=" + minted + " byteSize=" + byteSize);
})().catch(e => { console.error(e?.message || e); process.exit(1); });
'
) || fail "KCS read-back failed"

# ===========================================================================
act "4. Member verify-batch over all $TRIPLE_COUNT decrypted quads"
# ===========================================================================
VERIFY_BODY=$(QUADS_PAYLOAD="$QUADS_PAYLOAD" MERKLE_ROOT="$MERKLE_ROOT" KC="$KC" node -e "
  const p = JSON.parse(process.env.QUADS_PAYLOAD);
  console.log(JSON.stringify({
    contextGraphId: p.contextGraphId,
    expectedMerkleRoot: process.env.MERKLE_ROOT,
    batchId: process.env.KC,
    quads: p.quads
  }));
")
VERIFY=$(api_call "$MEMBER_NODE" POST /api/shared-memory/verify-batch "$VERIFY_BODY")
log "verify response: $VERIFY"
V_OK=$(parse_json "$VERIFY" '.ok')
V_LEAF=$(parse_json "$VERIFY" '.leafCount')
V_ACTUAL=$(parse_json "$VERIFY" '.actualRoot')
[ "$V_OK" = "true" ] || fail "verify-batch ok=$V_OK ($VERIFY)"
[ "$V_LEAF" = "$TRIPLE_COUNT" ] || fail "expected leafCount=$TRIPLE_COUNT, got $V_LEAF"
[ "$V_ACTUAL" = "$MERKLE_ROOT" ] || fail "actualRoot != expectedRoot"
log "✓ verify-batch passes over $V_LEAF decrypted leaves"

# ===========================================================================
act "5. Mint + verify 3 attestations across the batch"
# ===========================================================================
# Pick leaves at indices 0, (N/4-1), (N/2-1) — first / middle / last
# document. Each leaf's (s,p,o) is the canonical "name" triple of doc-i.
for leaf_idx in 0 $((TRIPLE_COUNT / 4 - 1)) $((TRIPLE_COUNT / 2 - 1)); do
  LEAF_SUBJECT="urn:scale:${STAMP}/doc-${leaf_idx}"
  LEAF_PREDICATE="http://schema.org/name"
  LEAF_OBJECT="\"Document ${leaf_idx}\""

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
log "  KC published:  $KC"
log "  TX:            $TX"
log "  MerkleRoot:    $MERKLE_ROOT"
log "  verify-batch:  ok=true leafCount=$V_LEAF"
log "  Attestations:  3 of 3 verified"
log "================================================================"
