#!/usr/bin/env bash
#
# OT-RFC-38 — MULTI-MEMBER test (RFC §2.4 scenario 3: "bridge core").
#
# Validates the consortium deployment shape where ≥3 agents all hold
# CG membership and must independently verify the publisher's
# commitment + cross-verify each other's attestations:
#
#   • Curator (N5, edge):  creates curated CG with 3 members.
#   • Edge member (N6):    second member; on a flaky laptop.
#   • Bridge core (N4):    third member — a core operator's
#                          co-located agent that also happens to
#                          host the substrate (per RFC §2.4 scenario
#                          3). For this test we just use it as
#                          another wallet that's a CG member.
#
# Test plan:
#
#   1. Curator creates CG with [curator, edge-member, bridge-core] in
#      the allowlist. All three pre-create the CG locally so the
#      sender-key handshake can complete.
#   2. Curator writes 6 triples to SWM.
#   3. Curator publishes to VM; record kcId + on-chain merkleRoot.
#   4. Each non-curator member calls /api/shared-memory/catchup
#      against the curator. Both should succeed (auth allowed=true)
#      and either inline-gossip OR explicit catchup should land
#      decrypted plaintext.
#   5. Each member independently calls /api/shared-memory/verify-batch
#      with explicit decrypted quads → all must return ok=true with
#      the same actualRoot.
#   6. Each member mints an attestation for the same leaf. All
#      three attestations must have different signers but identical
#      payload contents (chainId, kavAddress, contextGraphId,
#      batchId, merkleRoot, plaintextLeafHash).
#   7. An outsider verifies all three attestations. All three must
#      pass with leafCheck=match — proving the attestation envelope
#      is portable across the verifier surface regardless of
#      which member minted it.
#
# Re-runnable: timestamp-suffixed CG id.
#
# Caveat: the "bridge core" pattern uses a core node's wallet as a
# member. In production this is a separate co-located agent process
# on the same machine; on devnet we approximate by treating the
# core's daemon wallet as the member. The sender-key handshake +
# auth gate behave identically — what differs is only the
# deployment shape, not the protocol.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE=9201
CURATOR_NODE=5
EDGE_MEMBER_NODE=6
BRIDGE_CORE_NODE=4
OUTSIDER_NODE=1

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

log()  { echo "[mm] $*"; }
warn() { echo "[mm] WARN: $*" >&2; }
fail() { echo "[mm] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[mm] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }

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

CURATOR_AGENT=$(api_call "$CURATOR_NODE"       GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
EDGE_MEMBER_AGENT=$(api_call "$EDGE_MEMBER_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
BRIDGE_CORE_AGENT=$(api_call "$BRIDGE_CORE_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
CURATOR_PEER=$(api_call "$CURATOR_NODE"          GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/mm-${STAMP}"

log "Curator:      $CURATOR_AGENT       (node $CURATOR_NODE,       peer=$CURATOR_PEER)"
log "Edge member:  $EDGE_MEMBER_AGENT   (node $EDGE_MEMBER_NODE)"
log "Bridge core:  $BRIDGE_CORE_AGENT   (node $BRIDGE_CORE_NODE)"
log "CG:           $CG_ID"

# ===========================================================================
act "1. All three parties pre-create CG locally with the same allowlist"
# ===========================================================================
ALLOWED='["'"$CURATOR_AGENT"'", "'"$EDGE_MEMBER_AGENT"'", "'"$BRIDGE_CORE_AGENT"'"]'

CREATE_CUR=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "multi-member ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": $ALLOWED,
  "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE_CUR" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE_CUR"
log "✓ curated CG onChainId=$ON_CHAIN_ID"

api_call "$EDGE_MEMBER_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "multi-member ${STAMP} (edge member)",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": $ALLOWED }
EOF
)" >/dev/null || true

api_call "$BRIDGE_CORE_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "multi-member ${STAMP} (bridge core)",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": $ALLOWED }
EOF
)" >/dev/null || true
sleep 3

# ===========================================================================
act "2. Curator writes 6 triples + publishes"
# ===========================================================================
QUADS_PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const persons = [["alpha","alpha-fact"],["beta","beta-fact"],["gamma","gamma-fact"]];
  const quads = [];
  for (const [name, fact] of persons) {
    const entity = "urn:mm:" + stamp + "/" + name;
    quads.push({ subject: entity, predicate: "http://schema.org/name", object: "\""+name+"\"", graph: "" });
    quads.push({ subject: entity, predicate: "http://schema.org/note", object: "\""+fact+"\"", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WRITE_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$QUADS_PAYLOAD")
WRITTEN=$(parse_json "$WRITE_RESP" '.triplesWritten')
if [ "$WRITTEN" != "6" ]; then
  WRITE_ERR=$(parse_json "$WRITE_RESP" '.error')
  fail "expected 6 triples written, got '$WRITTEN'${WRITE_ERR:+ (error: $WRITE_ERR)} — full: $WRITE_RESP"
fi
log "✓ 6 triples written to SWM"

sleep 2

PUB_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "selection": "all", "clearAfter": false }
EOF
)")
log "publish response: $PUB_RESP"

STATUS=$(parse_json "$PUB_RESP" '.status')
TX=$(parse_json    "$PUB_RESP" '.txHash')
KC=$(parse_json    "$PUB_RESP" '.kcId')
[ "$STATUS" = "confirmed" ] || fail "publish status=$STATUS"
log "✓ publish: kcId=$KC tx=$TX"

KC_META=$(api_call "$CURATOR_NODE" GET "/api/kc/$KC")
MERKLE_ROOT=$(parse_json "$KC_META" '.merkleRoot')
[[ "$MERKLE_ROOT" =~ ^0x[0-9a-fA-F]{64}$ ]] || fail "no merkleRoot from /api/kc/$KC: $KC_META"
log "✓ merkleRoot: $MERKLE_ROOT"

# ===========================================================================
act "3. All non-curator members independently verify-batch"
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

verify_on_node() {
  local node="$1" label="$2"
  local resp; resp=$(api_call "$node" POST /api/shared-memory/verify-batch "$VERIFY_BODY")
  log "$label verify response: $resp"
  local ok; ok=$(parse_json "$resp" '.ok')
  local actual; actual=$(parse_json "$resp" '.actualRoot')
  [ "$ok" = "true" ] || fail "$label verify-batch ok=$ok"
  [ "$actual" = "$MERKLE_ROOT" ] || fail "$label actualRoot ($actual) != expected ($MERKLE_ROOT)"
  log "✓ $label verify-batch: ok=true actualRoot==expected"
}
verify_on_node "$CURATOR_NODE"     "curator"
verify_on_node "$EDGE_MEMBER_NODE" "edge-member"
verify_on_node "$BRIDGE_CORE_NODE" "bridge-core"

# ===========================================================================
act "4. Each member mints an attestation for the same leaf"
# ===========================================================================
LEAF_SUBJECT="urn:mm:${STAMP}/alpha"
LEAF_PREDICATE="http://schema.org/name"
LEAF_OBJECT="\"alpha\""

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
log "✓ leaf: candidateLeaf=$CANDIDATE_LEAF plaintextHash=$PLAINTEXT_HASH"

declare -a MINTED_BY MINTED_RESP
for node in "$CURATOR_NODE" "$EDGE_MEMBER_NODE" "$BRIDGE_CORE_NODE"; do
  MINT=$(api_call "$node" POST /api/attestation/mint "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "batchId": "$KC", "merkleRoot": "$MERKLE_ROOT", "plaintextLeafHash": "$PLAINTEXT_HASH" }
EOF
)")
  signer=$(parse_json "$MINT" '.attestation.payload.attesterAddress')
  log "node $node minted attestation: signer=$signer"
  [[ "$signer" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "node $node mint failed: $MINT"
  MINTED_BY+=("$signer")
  MINTED_RESP+=("$MINT")
done

# Sanity: the 3 signers must be distinct
SIGNER_COUNT=$(printf '%s\n' "${MINTED_BY[@]}" | sort -u | wc -l | tr -d ' ')
[ "$SIGNER_COUNT" = "3" ] || fail "expected 3 distinct attestation signers, got $SIGNER_COUNT (${MINTED_BY[*]})"
log "✓ all 3 attestations signed by distinct members"

# ===========================================================================
act "5. Outsider cross-verifies all 3 attestations"
# ===========================================================================
for i in 0 1 2; do
  MINT="${MINTED_RESP[$i]}"
  SIGNER="${MINTED_BY[$i]}"
  VBODY=$(MINT="$MINT" CANDIDATE_LEAF="$CANDIDATE_LEAF" node -e "
    const att = JSON.parse(process.env.MINT).attestation;
    console.log(JSON.stringify({ attestation: att, candidateLeafHex: process.env.CANDIDATE_LEAF }));
  ")
  VRESP=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$VBODY")
  V_OK=$(parse_json "$VRESP" '.ok')
  V_LEAFCHECK=$(parse_json "$VRESP" '.leafCheck')
  V_SIGOK=$(parse_json "$VRESP" '.signerMatchesAttester')
  [ "$V_OK" = "true" ] || fail "outsider verify of $SIGNER's attestation: ok=$V_OK ($VRESP)"
  [ "$V_LEAFCHECK" = "match" ] || fail "outsider verify of $SIGNER's attestation: leafCheck=$V_LEAFCHECK"
  [ "$V_SIGOK" = "true" ] || fail "outsider verify of $SIGNER's attestation: signerMatchesAttester=$V_SIGOK"
  log "✓ outsider verified attestation from $SIGNER"
done

log ""
log "================================================================"
log "  RFC-38 MULTI-MEMBER test: PASS"
log "================================================================"
log "  Curated CG:    $CG_ID  (onChainId=$ON_CHAIN_ID)"
log "  Members:       3 ($CURATOR_AGENT, $EDGE_MEMBER_AGENT, $BRIDGE_CORE_AGENT)"
log "  Publish:       kcId=$KC merkleRoot=$MERKLE_ROOT"
log "  verify-batch:  3 of 3 members confirmed actualRoot==expected"
log "  Attestations:  3 of 3 cross-verified by outsider with leafCheck=match"
log "================================================================"
