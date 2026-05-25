#!/usr/bin/env bash
#
# OT-RFC-38 / LU-9 — devnet API validation for member-attested
# verification tokens.
#
# Scenarios:
#
#   1. ROUND-TRIP — Curator publishes a public CG batch. Curator (as
#      member of its own CG) mints an attestation for a specific leaf
#      using POST /api/attestation/mint. An "outsider" node (another
#      edge node that isn't in the CG's allowlist) calls
#      POST /api/attestation/verify with the attestation and the
#      candidate leaf bytes → must return ok=true, leafCheck=match.
#
#   2. TAMPERED LEAF — Outsider verifies with WRONG leaf bytes →
#      ok=false, leafCheck=mismatch.
#
#   3. TAMPERED PAYLOAD — Outsider tampers with `attestedAt` →
#      ok=false (signature recovery fails).
#
#   4. WRONG SIGNER — Outsider tampers with `attesterAddress` →
#      ok=false, signerMatchesAttester=false.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
OUTSIDER_NODE=6   # outsider edge node (different agent address)

log()  { echo "[lu9-validate] $*"; }
warn() { echo "[lu9-validate] WARN: $*" >&2; }
fail() { echo "[lu9-validate] FAIL: $*" >&2; exit 1; }

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
OUTSIDER_AGENT=$(api_call "$OUTSIDER_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

log "Curator: $CURATOR_AGENT (node $CURATOR_NODE)"
log "Outsider: $OUTSIDER_AGENT (node $OUTSIDER_NODE)"

STAMP=$(date +%s)
CG="${CURATOR_AGENT}/lu9-pub-${STAMP}"

log "Curator creates public CG $CG..."
CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG", "name": "LU-9 public ${STAMP}",
  "accessPolicy": 0, "publishPolicy": 1, "register": true }
EOF
)")
ON_CHAIN_CG=$(parse_json "$CREATE" '.onChainId')
[ -n "$ON_CHAIN_CG" ] || fail "CG create failed: $CREATE"
log "✓ CG registered onChainId=$ON_CHAIN_CG"

log "Curator writes a single SWM triple..."
LEAF_SUBJECT="urn:lu9/fact-${STAMP}"
LEAF_PREDICATE="http://schema.org/headline"
LEAF_OBJECT='"Bloomberg-shaped fact"'
QUADS=$(node -e "
  console.log(JSON.stringify({
    contextGraphId: '$CG',
    quads: [{ subject: '$LEAF_SUBJECT', predicate: '$LEAF_PREDICATE', object: '$LEAF_OBJECT', graph: '' }]
  }));
")
WRITE_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$QUADS")
[ "$(parse_json "$WRITE_RESP" '.triplesWritten')" = "1" ] || fail "expected 1 triple written: $WRITE_RESP"
log "✓ Wrote 1 triple"

log "Curator publishes selection to VM..."
PUB_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{ "contextGraphId": "$CG", "selection": "all", "epochs": 1 }
EOF
)")
log "publish response: $PUB_RESP"
KC_ID=$(parse_json "$PUB_RESP" '.kcId')
[ -n "$KC_ID" ] || fail "no kcId: $PUB_RESP"

log "Fetching merkleRoot for KC #$KC_ID..."
KC_RESP=$(api_call "$CURATOR_NODE" GET "/api/kc/$KC_ID")
MERKLE_ROOT=$(parse_json "$KC_RESP" '.merkleRoot')
[ -n "$MERKLE_ROOT" ] || fail "no merkleRoot: $KC_RESP"
log "✓ merkleRoot=$MERKLE_ROOT"

# The plaintext leaf hash the curator attests to. We compute it
# locally using the V10 leaf-hash function (keccak256 of the canonical
# nquad form) to mirror exactly what the publisher computed at publish
# time. The agent module exports `hashTripleV10` from
# `@origintrail-official/dkg-core` so we re-run that here in a
# throwaway node script to keep this test self-contained.
# Use the published ESM module from packages/core; run from that
# directory so node resolves the import map correctly.
LEAF_HASH=$(cd "$REPO_ROOT/packages/core" && LEAF_SUBJECT="$LEAF_SUBJECT" LEAF_PREDICATE="$LEAF_PREDICATE" LEAF_OBJECT="$LEAF_OBJECT" node --input-type=module -e '
  const { hashTripleV10, keccak256 } = await import("./dist/index.js");
  const leafBytes = hashTripleV10(process.env.LEAF_SUBJECT, process.env.LEAF_PREDICATE, process.env.LEAF_OBJECT);
  const leafHash = keccak256(leafBytes);
  console.log("0x" + Buffer.from(leafHash).toString("hex"));
' 2>&1)
[ -n "$LEAF_HASH" ] || fail "could not compute leaf hash (need dkg-core for hashTripleV10/keccak256)"
log "✓ plaintextLeafHash=$LEAF_HASH"

# Also compute the canonical leaf bytes — the "candidate leaf"
# bytes that the outsider passes to verify, so the verifier can run
# `keccak256(candidateLeaf) === plaintextLeafHash`. The candidate
# leaf IS the output of hashTripleV10 (the V10 leaf format is exactly
# `hashTripleV10(s,p,o)`); the second keccak256 we apply in mint+verify
# is the outer wrap around the leaf for the merkle layer's leaf-hash
# slot.
CANDIDATE_LEAF=$(cd "$REPO_ROOT/packages/core" && LEAF_SUBJECT="$LEAF_SUBJECT" LEAF_PREDICATE="$LEAF_PREDICATE" LEAF_OBJECT="$LEAF_OBJECT" node --input-type=module -e '
  const { hashTripleV10 } = await import("./dist/index.js");
  const leafBytes = hashTripleV10(process.env.LEAF_SUBJECT, process.env.LEAF_PREDICATE, process.env.LEAF_OBJECT);
  console.log("0x" + Buffer.from(leafBytes).toString("hex"));
' 2>/dev/null)
log "✓ candidateLeaf=$CANDIDATE_LEAF"

# ===========================================================================
# SCENARIO 1 — Roundtrip happy path.
# ===========================================================================

log ""
log "================================================================"
log "  SCENARIO 1: ROUND-TRIP (mint → verify ok=true)"
log "================================================================"

MINT_RESP=$(api_call "$CURATOR_NODE" POST /api/attestation/mint "$(cat <<EOF
{ "contextGraphId": "$CG",
  "batchId": "$KC_ID",
  "merkleRoot": "$MERKLE_ROOT",
  "plaintextLeafHash": "$LEAF_HASH" }
EOF
)")
log "mint response: $MINT_RESP"
ATT_SIG=$(parse_json "$MINT_RESP" '.attestation.signature')
[ -n "$ATT_SIG" ] || fail "mint did not return a signature: $MINT_RESP"
log "✓ attestation minted (signature=$ATT_SIG)"

VERIFY_BODY=$(MINT_RESP="$MINT_RESP" CANDIDATE_LEAF="$CANDIDATE_LEAF" node -e '
  const j = JSON.parse(process.env.MINT_RESP);
  console.log(JSON.stringify({
    attestation: j.attestation,
    candidateLeafHex: process.env.CANDIDATE_LEAF
  }));
')
VERIFY1=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$VERIFY_BODY")
log "outsider verify: $VERIFY1"
VERIFY1_OK=$(parse_json "$VERIFY1" '.ok')
VERIFY1_LEAF=$(parse_json "$VERIFY1" '.leafCheck')
[ "$VERIFY1_OK" = "true" ] || fail "expected ok=true, got $VERIFY1_OK"
[ "$VERIFY1_LEAF" = "match" ] || fail "expected leafCheck=match, got $VERIFY1_LEAF"
log "✓ Scenario 1: roundtrip verification PASSED"

# ===========================================================================
# SCENARIO 2 — Tampered leaf.
# ===========================================================================

log ""
log "================================================================"
log "  SCENARIO 2: TAMPERED LEAF (leafCheck=mismatch)"
log "================================================================"

WRONG_LEAF=$(cd "$REPO_ROOT/packages/core" && LEAF_PREDICATE="$LEAF_PREDICATE" node --input-type=module -e '
  const { hashTripleV10 } = await import("./dist/index.js");
  const leafBytes = hashTripleV10("urn:lu9/wrong", process.env.LEAF_PREDICATE, "\"Different fact\"");
  console.log("0x" + Buffer.from(leafBytes).toString("hex"));
' 2>/dev/null)
VERIFY_BODY_WRONG=$(MINT_RESP="$MINT_RESP" WRONG_LEAF="$WRONG_LEAF" node -e '
  const j = JSON.parse(process.env.MINT_RESP);
  console.log(JSON.stringify({
    attestation: j.attestation,
    candidateLeafHex: process.env.WRONG_LEAF
  }));
')
VERIFY2=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$VERIFY_BODY_WRONG")
log "tampered-leaf verify: $VERIFY2"
VERIFY2_OK=$(parse_json "$VERIFY2" '.ok')
VERIFY2_LEAF=$(parse_json "$VERIFY2" '.leafCheck')
[ "$VERIFY2_OK" = "false" ] || fail "expected ok=false, got $VERIFY2_OK"
[ "$VERIFY2_LEAF" = "mismatch" ] || fail "expected leafCheck=mismatch, got $VERIFY2_LEAF"
log "✓ Scenario 2: tampered leaf correctly rejected"

# ===========================================================================
# SCENARIO 3 — Tampered payload (attestedAt bumped, signature invalid).
# ===========================================================================

log ""
log "================================================================"
log "  SCENARIO 3: TAMPERED PAYLOAD (signature recovery should mismatch)"
log "================================================================"

TAMPERED_ATT=$(MINT_RESP="$MINT_RESP" node -e '
  const j = JSON.parse(process.env.MINT_RESP);
  const att = JSON.parse(JSON.stringify(j.attestation));
  att.payload.attestedAt = att.payload.attestedAt + 1;
  console.log(JSON.stringify({ attestation: att }));
')
VERIFY3=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$TAMPERED_ATT")
log "tampered-payload verify: $VERIFY3"
VERIFY3_OK=$(parse_json "$VERIFY3" '.ok')
VERIFY3_MATCH=$(parse_json "$VERIFY3" '.signerMatchesAttester')
[ "$VERIFY3_OK" = "false" ] || fail "expected ok=false, got $VERIFY3_OK"
[ "$VERIFY3_MATCH" = "false" ] || fail "expected signerMatchesAttester=false, got $VERIFY3_MATCH"
log "✓ Scenario 3: tampered payload correctly rejected"

# ===========================================================================
# SCENARIO 4 — Wrong attester address.
# ===========================================================================

log ""
log "================================================================"
log "  SCENARIO 4: WRONG SIGNER (attesterAddress flipped to outsider)"
log "================================================================"

WRONG_SIGNER_ATT=$(MINT_RESP="$MINT_RESP" OUTSIDER_AGENT="$OUTSIDER_AGENT" node -e '
  const j = JSON.parse(process.env.MINT_RESP);
  const att = JSON.parse(JSON.stringify(j.attestation));
  att.payload.attesterAddress = process.env.OUTSIDER_AGENT;
  console.log(JSON.stringify({ attestation: att }));
')
VERIFY4=$(api_call "$OUTSIDER_NODE" POST /api/attestation/verify "$WRONG_SIGNER_ATT")
log "wrong-signer verify: $VERIFY4"
VERIFY4_OK=$(parse_json "$VERIFY4" '.ok')
VERIFY4_MATCH=$(parse_json "$VERIFY4" '.signerMatchesAttester')
[ "$VERIFY4_OK" = "false" ] || fail "expected ok=false, got $VERIFY4_OK"
[ "$VERIFY4_MATCH" = "false" ] || fail "expected signerMatchesAttester=false, got $VERIFY4_MATCH"
log "✓ Scenario 4: wrong-signer attestation correctly rejected"

log ""
log "================================================================"
log "  LU-9 devnet API validation: PASS"
log "================================================================"
log "  CG:           did:dkg:context-graph:$CG (onChainId=$ON_CHAIN_CG)"
log "  KC:           $KC_ID  merkleRoot=$MERKLE_ROOT"
log "  Attestation:  by $CURATOR_AGENT for leaf hash $LEAF_HASH"
log "  Scenarios:    1 ok, 2 leaf-mismatch, 3 payload-tamper, 4 wrong-signer"
log "================================================================"
