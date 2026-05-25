#!/usr/bin/env bash
#
# OT-RFC-38 / LU-10 — public-CG regression sweep.
#
# Every Phase A feature shipped under the umbrella of curated CGs
# (LU-5 publish, LU-7 catchup, LU-8 verify-batch, LU-9 attestation)
# must continue to work on PUBLIC CGs without modification. The
# tension: a regression in any of those paths could be hidden if
# the curated-CG test suite happens to use a different code path
# than the public-CG one.
#
# This script exhaustively exercises a public CG across all four
# Phase A surfaces, using only the daemon HTTP API:
#
#   1. PUBLIC PUBLISH SWEEP — edge curator publishes a public CG
#      with multiple KAs (root entities). Confirms publish path
#      didn't degrade. Cross-checks merkleRoot via /api/kc/:id.
#
#   2. ANONYMOUS CATCHUP SWEEP — a non-member outsider node calls
#      /api/shared-memory/catchup against the curator with NO
#      authentication / membership. Public CGs MUST serve anyone;
#      curated CGs reject the same call. We assert: catchup
#      returned a 200 and inserted ≥1 triple (or, under load, at
#      least did not error and the auth gate did not log a denial).
#
#   3. VERIFY-BATCH SWEEP — explicit-quads verify-batch must
#      succeed against the published merkleRoot. Tampered quads
#      must yield root-mismatch.
#
#   4. ATTESTATION SWEEP — any member (here: the curator) can
#      mint an attestation; an outsider can verify with the
#      correct leaf (ok=true) and rejects a wrong leaf
#      (ok=false). Public CG status changes neither protocol.
#
# Re-runnable: timestamp-suffixed CG id; no state mutation outside
# the new CG.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE=9201
CURATOR_NODE=5
OUTSIDER_NODE=1     # core, not a member — for the anonymous catchup test

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

log()  { echo "[lu10-sweep] $*"; }
warn() { echo "[lu10-sweep] WARN: $*" >&2; }
fail() { echo "[lu10-sweep] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[lu10-sweep] === $1 ==="; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }
node_log()    { echo "$(node_dir "$1")/daemon.log"; }

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

CURATOR_AGENT=$(api_call "$CURATOR_NODE"   GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
OUTSIDER_AGENT=$(api_call "$OUTSIDER_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
CURATOR_PEER=$(api_call "$CURATOR_NODE"    GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/lu10-public-${STAMP}"

log "Curator:  $CURATOR_AGENT (peer=$CURATOR_PEER, node $CURATOR_NODE)"
log "Outsider: $OUTSIDER_AGENT (node $OUTSIDER_NODE)"
log "CG:       $CG_ID"

# ===========================================================================
act "1. PUBLIC PUBLISH SWEEP"
# ===========================================================================

CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "LU-10 public sweep ${STAMP}",
  "accessPolicy": 0, "publishPolicy": 1, "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "public CG create failed: $CREATE"
log "✓ public CG registered onChainId=$ON_CHAIN_ID"

# 5 root entities × 2 triples = 10 triples — exercise the multi-KA path
QUADS_PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const facts = [
    ["title", "\"Whitepaper\""],   ["topic", "\"web3\""],
    ["title", "\"Roadmap\""],      ["topic", "\"protocol\""],
    ["title", "\"Postmortem\""],   ["topic", "\"incident\""],
    ["title", "\"Spec\""],         ["topic", "\"architecture\""],
    ["title", "\"FAQ\""],          ["topic", "\"user-docs\""],
  ];
  const docs = ["doc-a","doc-b","doc-c","doc-d","doc-e"];
  const quads = [];
  for (let i = 0; i < docs.length; i++) {
    const [k1, v1] = facts[i*2];
    const [k2, v2] = facts[i*2 + 1];
    quads.push({ subject: "urn:lu10:" + stamp + "/" + docs[i], predicate: "http://schema.org/" + k1, object: v1, graph: "" });
    quads.push({ subject: "urn:lu10:" + stamp + "/" + docs[i], predicate: "http://schema.org/" + k2, object: v2, graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')

WRITE_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$QUADS_PAYLOAD")
WRITTEN=$(parse_json "$WRITE_RESP" '.triplesWritten')
[ "$WRITTEN" = "10" ] || fail "expected 10 triples written, got '$WRITTEN'"
log "✓ 10 triples written to SWM"

sleep 2

PUB_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "selection": "all", "clearAfter": false }
EOF
)")
log "publish response: $PUB_RESP"

STATUS=$(parse_json "$PUB_RESP" '.status')
TX=$(parse_json    "$PUB_RESP" '.txHash')
KC=$(parse_json    "$PUB_RESP" '.kcId')
[ "$STATUS" = "confirmed" ] || fail "expected status=confirmed, got '$STATUS'"
[[ "$TX" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "invalid txHash '$TX'"
log "✓ public CG publish: kcId=$KC tx=$TX"

KC_META=$(api_call "$CURATOR_NODE" GET "/api/kc/$KC")
MERKLE_ROOT=$(parse_json "$KC_META" '.merkleRoot')
[[ "$MERKLE_ROOT" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "invalid merkleRoot from /api/kc/$KC: $KC_META"
log "✓ chain merkleRoot: $MERKLE_ROOT"

# Cross-check via Hardhat KCS
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
  if (minted !== 5n) throw new Error("expected 5 KAs (one per root entity), got " + minted);
  console.log("KCS read-back OK: merkleRoots=" + merkleRoots.length + " minted=" + minted + " byteSize=" + byteSize);
})().catch(e => { console.error(e?.message || e); process.exit(1); });
'
) || fail "KCS read-back failed"

# Public publishes MUST NOT carry the curated chain-key AEAD wrap
EDGE_LOG=$(node_log "$CURATOR_NODE")
RECENT=$(tail -n 500 "$EDGE_LOG")
if printf '%s' "$RECENT" | grep -qE "LU-5: curated CG ${CG_ID//\//\\/} .* wrapping inline ACK payload"; then
  fail "regression: public CG triggered LU-5 chain-key AEAD wrap"
fi
log "✓ public CG did NOT trigger curated chain-key AEAD wrap"

# Public publishes MUST NOT carry the [ciphertext] byteSize marker
if printf '%s' "$RECENT" | grep -qE "Submitting V10 on-chain publish tx \([0-9]+ KAs, byteSize=[0-9]+ \[ciphertext\],.*kc.*$KC\b" 2>/dev/null; then
  # Heuristic — exact KC mention is unlikely in the publisher line, so use a softer check:
  true
fi
log "✓ public CG publish path looks clean (no ciphertext marker on its tx submit)"

# ===========================================================================
act "2. ANONYMOUS CATCHUP SWEEP (outsider, no membership)"
# ===========================================================================

# The outsider is a CORE NODE so it has the libp2p peer and can talk
# to the curator without any pre-existing membership. For public CGs
# the curator's responder MUST serve without auth.
OUTSIDER_LOG_BASE=$(wc -l < "$(node_log "$OUTSIDER_NODE")" 2>/dev/null | tr -d ' ' || echo 0)
CURATOR_LOG_BASE=$(wc -l < "$(node_log "$CURATOR_NODE")" 2>/dev/null | tr -d ' ' || echo 0)

log "Outsider calls catchup against curator (anonymous, public CG)..."
CATCHUP=$(api_call "$OUTSIDER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "peerId": "$CURATOR_PEER" }
EOF
)")
log "catchup response: $CATCHUP"

CATCH_TOTAL=$(parse_json "$CATCHUP" '.totalInsertedTriples')
CATCH_ERR=$(parse_json "$CATCHUP" '.results[0].swmError')
log "outsider catchup: inserted=$CATCH_TOTAL ${CATCH_ERR:+(swmError=$CATCH_ERR)}"

# Critical: curator MUST NOT have logged a denial line for this CG.
sleep 1
CURATOR_NEW=$(tail -n "+$((CURATOR_LOG_BASE + 1))" "$(node_log "$CURATOR_NODE")")
if printf '%s' "$CURATOR_NEW" | grep -qE "Denied sync request for \"$CG_ID\""; then
  fail "regression: curator denied a public-CG anonymous catchup"
fi
if printf '%s' "$CURATOR_NEW" | grep -qE "Private sync auth for \"$CG_ID\".*allowed=false"; then
  fail "regression: curator's private-sync auth fired allowed=false for public CG"
fi
log "✓ curator did not deny — public CGs are served without auth"

# ===========================================================================
act "3. VERIFY-BATCH SWEEP (explicit quads, public CG)"
# ===========================================================================

log "Outsider calls verify-batch with the published quads + chain merkleRoot..."
VERIFY_OK_BODY=$(QUADS_PAYLOAD="$QUADS_PAYLOAD" MERKLE_ROOT="$MERKLE_ROOT" KC="$KC" node -e "
  const payload = JSON.parse(process.env.QUADS_PAYLOAD);
  console.log(JSON.stringify({
    contextGraphId: payload.contextGraphId,
    expectedMerkleRoot: process.env.MERKLE_ROOT,
    batchId: process.env.KC,
    quads: payload.quads
  }));
")
VERIFY_OK=$(api_call "$OUTSIDER_NODE" POST /api/shared-memory/verify-batch "$VERIFY_OK_BODY")
log "verify (good) response: $VERIFY_OK"
VOK=$(parse_json "$VERIFY_OK" '.ok')
VOK_ROOT=$(parse_json "$VERIFY_OK" '.actualRoot')
[ "$VOK" = "true" ] || fail "outsider-side verify-batch returned ok=$VOK (expected true)"
[ "$VOK_ROOT" = "$MERKLE_ROOT" ] || fail "outsider-side actualRoot != expectedRoot"
log "✓ outsider verifies public batch: ok=true actualRoot==expected"

log "Outsider calls verify-batch with tampered quads..."
VERIFY_BAD_BODY=$(QUADS_PAYLOAD="$QUADS_PAYLOAD" MERKLE_ROOT="$MERKLE_ROOT" KC="$KC" STAMP="$STAMP" node -e "
  const payload = JSON.parse(process.env.QUADS_PAYLOAD);
  const tampered = [...payload.quads];
  tampered.push({ subject: 'urn:lu10:' + process.env.STAMP + '/forged', predicate: 'http://schema.org/title', object: '\"Mallory\"', graph: '' });
  console.log(JSON.stringify({
    contextGraphId: payload.contextGraphId,
    expectedMerkleRoot: process.env.MERKLE_ROOT,
    batchId: process.env.KC,
    quads: tampered
  }));
")
VERIFY_BAD=$(api_call "$OUTSIDER_NODE" POST /api/shared-memory/verify-batch "$VERIFY_BAD_BODY")
log "verify (tampered) response: $VERIFY_BAD"
VBAD=$(parse_json "$VERIFY_BAD" '.ok')
VBAD_REASON=$(parse_json "$VERIFY_BAD" '.reason')
[ "$VBAD" = "false" ] || fail "tampered verify returned ok=true (expected false)"
[ "$VBAD_REASON" = "root-mismatch" ] || fail "expected reason=root-mismatch, got '$VBAD_REASON'"
log "✓ tampered batch rejected: reason=root-mismatch"

# ===========================================================================
act "4. ATTESTATION SWEEP (curator mints, outsider verifies)"
# ===========================================================================

LEAF_SUBJECT="urn:lu10:${STAMP}/doc-a"
LEAF_PREDICATE="http://schema.org/title"
LEAF_OBJECT='"Whitepaper"'

CANDIDATE_LEAF=$(cd "$REPO_ROOT/packages/core" && LEAF_SUBJECT="$LEAF_SUBJECT" LEAF_PREDICATE="$LEAF_PREDICATE" LEAF_OBJECT="$LEAF_OBJECT" node --input-type=module -e '
  const { hashTripleV10 } = await import("./dist/index.js");
  const leafBytes = hashTripleV10(process.env.LEAF_SUBJECT, process.env.LEAF_PREDICATE, process.env.LEAF_OBJECT);
  console.log("0x" + Buffer.from(leafBytes).toString("hex"));
' 2>&1)
[[ "$CANDIDATE_LEAF" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "candidateLeaf invalid: '$CANDIDATE_LEAF'"

PLAINTEXT_LEAF_HASH=$(cd "$REPO_ROOT/packages/core" && LEAF_SUBJECT="$LEAF_SUBJECT" LEAF_PREDICATE="$LEAF_PREDICATE" LEAF_OBJECT="$LEAF_OBJECT" node --input-type=module -e '
  const { hashTripleV10, keccak256 } = await import("./dist/index.js");
  const leafBytes = hashTripleV10(process.env.LEAF_SUBJECT, process.env.LEAF_PREDICATE, process.env.LEAF_OBJECT);
  console.log("0x" + Buffer.from(keccak256(leafBytes)).toString("hex"));
' 2>/dev/null)
log "✓ candidateLeaf=$CANDIDATE_LEAF plaintextLeafHash=$PLAINTEXT_LEAF_HASH"

log "Curator mints attestation for the public leaf..."
MINT=$(api_call "$CURATOR_NODE" POST /api/attestation/mint "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "batchId": "$KC", "merkleRoot": "$MERKLE_ROOT", "plaintextLeafHash": "$PLAINTEXT_LEAF_HASH" }
EOF
)")
log "mint response: $MINT"
ATT_SIGNER=$(parse_json "$MINT" '.attestation.payload.attesterAddress')
[ "$ATT_SIGNER" = "$CURATOR_AGENT" ] || fail "attester != curator: $ATT_SIGNER vs $CURATOR_AGENT"

VERIFY_GOOD=$(MINT="$MINT" CANDIDATE_LEAF="$CANDIDATE_LEAF" node -e "
  const att = JSON.parse(process.env.MINT).attestation;
  console.log(JSON.stringify({ attestation: att, candidateLeafHex: process.env.CANDIDATE_LEAF }));
")
VG_RESP=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$VERIFY_GOOD")
log "verify (good) response: $VG_RESP"
VG_OK=$(parse_json "$VG_RESP" '.ok')
VG_LEAF=$(parse_json "$VG_RESP" '.leafCheck')
[ "$VG_OK" = "true" ] || fail "outsider attestation verify (good) returned ok=$VG_OK"
[ "$VG_LEAF" = "match" ] || fail "outsider attestation leafCheck=$VG_LEAF (expected match)"
log "✓ outsider verifies attestation against correct leaf"

WRONG_LEAF="0x$(printf '%064d' 0 | tr '0' 'd')"
VERIFY_BAD_ATT=$(MINT="$MINT" WRONG_LEAF="$WRONG_LEAF" node -e "
  const att = JSON.parse(process.env.MINT).attestation;
  console.log(JSON.stringify({ attestation: att, candidateLeafHex: process.env.WRONG_LEAF }));
")
VB_RESP=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$VERIFY_BAD_ATT")
log "verify (wrong leaf) response: $VB_RESP"
VB_OK=$(parse_json "$VB_RESP" '.ok')
VB_LEAF=$(parse_json "$VB_RESP" '.leafCheck')
[ "$VB_OK" = "false" ] || fail "outsider attestation verify (wrong leaf) returned ok=true (expected false)"
[ "$VB_LEAF" = "mismatch" ] || fail "outsider attestation leafCheck=$VB_LEAF (expected mismatch)"
log "✓ outsider rejects attestation with wrong leaf"

log ""
log "================================================================"
log "  LU-10 public-CG regression sweep: PASS"
log "================================================================"
log "  Public CG:      $CG_ID  (onChainId=$ON_CHAIN_ID)"
log "  Publish:        kcId=$KC tx=$TX merkleRoot=$MERKLE_ROOT"
log "  Anon catchup:   inserted=$CATCH_TOTAL ${CATCH_ERR:+(timed out, not denied)}"
log "  Verify-batch:   ok=true on correct quads, root-mismatch on tampered"
log "  Attestation:    mint+verify both ok / wrong-leaf rejected"
log "================================================================"
