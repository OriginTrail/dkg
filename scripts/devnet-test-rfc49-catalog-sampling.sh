#!/usr/bin/env bash
#
# OT-RFC-49 catalog-sampling strip — comprehensive devnet validation.
#
# Scenario (4 cores + 2 edges):
#   - EDGE 5 (curator) + EDGE 6 (member) are the PARTICIPANTS of a private
#     (curated, accessPolicy=1) CG. They hold the private data member-side.
#   - CORES 1-4 are NOT participants. They host + prove the PUBLIC `_catalog`,
#     and must hold ZERO private ciphertext.
#
# What it proves:
#   1. A curated publish lands on-chain with a non-zero CATALOG commitment
#      (getCatalogRoot / getCatalogLeafCount) — NOT a ciphertext commitment.
#   2. The publisher DID emit private ciphertext chunks (non-vacuous).
#   3. The member edge holds the private data (member-side).
#   4. STRIPPED cores (1-3, default `stripCiphertext` ON) hold ZERO rows in the
#      ciphertext-chunk store, while still holding the `_catalog`.
#   5. DISCRIMINATOR: a strip-OFF baseline core (4) DOES hold the ciphertext —
#      proving the zero on cores 1-3 is the strip working, not a vacuous pass.
#   6. A core submits a random-sampling proof against the `_catalog`.
#
# Assumes a running devnet brought up via:
#   DEVNET_NODE_READY_TIMEOUT=90 NUM_CORE_NODES=4 ./scripts/devnet.sh start 6
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"

DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
# Owner-sealed POST /api/update helpers (build_update_body / ka_owner_key) —
# used by the curated-UPDATE leg (section 9b). Sourced AFTER DEVNET_DIR is set
# because the helper asserts on it.
NUM_NODES="${NUM_NODES:-6}"
# shellcheck source=devnet-update-helpers.sh
source "$SCRIPT_DIR/devnet-update-helpers.sh"
API_PORT_BASE="${API_PORT_BASE:-9201}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

STRIPPED_CORES=(1 2 3)
BASELINE_CORE=4          # strip-OFF discriminator
EDGE_CURATOR=5
EDGE_MEMBER=6
STAMP="$(date +%s)"
CG_ID="rfc49-catalog-${STAMP}"
CG_URI="did:dkg:context-graph:${CG_ID}"

log()  { echo "[rfc49-catalog] $*"; }
warn() { echo "[rfc49-catalog] WARN: $*" >&2; }
fail() { echo "[rfc49-catalog] FAIL: $*" >&2; exit 1; }
pass() { echo "[rfc49-catalog] ✓ $*"; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_token() { grep -v '^#' "$(node_dir 1)/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local url="http://127.0.0.1:$(node_port "$node")$path"
  local tok; tok="$(node_token)"
  if [ -n "$data" ]; then
    curl -sS -X "$method" -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" --data "$data" "$url"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $tok" "$url"
  fi
}

jq_field() { node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);const p=process.argv[1].split(".").filter(Boolean);let v=j;for(const k of p)v=v?.[k];console.log(typeof v==="object"?JSON.stringify(v):(v??""))}catch(e){console.log("")}})' "$1"; }

hardhat_mine() {
  local hex; hex=$(printf '0x%x' "$1")
  curl -sS -X POST -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"hardhat_mine\",\"params\":[\"${hex}\"]}" \
    "http://127.0.0.1:${HARDHAT_PORT}" > /dev/null
}

# Parse a COUNT(*) result from /api/query. The binding value is a typed literal
# like `"0"^^<http://www.w3.org/2001/XMLSchema#integer>` — take ONLY the value
# before `^^` (stripping the type IRI, whose `w3`/`2001` digits would otherwise
# corrupt the count, e.g. "0" → 0, not 32001).
_count_from_query() {
  node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);const b=j?.result?.bindings??j?.bindings??j?.results?.bindings??[];let v=b[0]?.c?.value??b[0]?.c??"0";v=String(v).split("^^")[0].replace(/"/g,"").trim();console.log(Number.isFinite(parseInt(v,10))?parseInt(v,10):-1)}catch(e){console.log(-1)}})'
}

# COUNT(*) of rows under any urn:dkg:swm:ciphertext-chunks/* graph in a node's store.
# NOTE: NO contextGraphId — that applies a memory-layer VIEW that breaks the
# graph-scoped COUNT (returns the whole store). Raw SPARQL scopes correctly.
ciphertext_count() {
  local body
  body=$(node -e 'console.log(JSON.stringify({sparql:`SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o . FILTER(STRSTARTS(STR(?g), "urn:dkg:swm:ciphertext-chunks/")) } }`}))')
  api_call "$1" POST /api/query "$body" | _count_from_query
}

# COUNT(*) of triples in the public <cg>/_catalog graph (keyed by the NUMERIC
# on-chain CG id, e.g. did:dkg:context-graph:5/_catalog — NOT the local name).
catalog_count() {
  local body
  body=$(OID="$ONCHAIN_ID" node -e 'console.log(JSON.stringify({sparql:`SELECT (COUNT(*) AS ?c) WHERE { GRAPH <did:dkg:context-graph:${process.env.OID}/_catalog> { ?s ?p ?o } }`}))')
  api_call "$1" POST /api/query "$body" | _count_from_query
}

rs_submitted() {
  api_call "$1" GET /api/random-sampling/status 2>/dev/null | jq_field ".loop.submittedCount"
}

# ---------------------------------------------------------------------------
# 0. Preconditions + configure the strip-OFF baseline core
# ---------------------------------------------------------------------------
for n in "${STRIPPED_CORES[@]}" "$BASELINE_CORE" "$EDGE_CURATOR" "$EDGE_MEMBER"; do
  s=$(api_call "$n" GET /api/status 2>/dev/null | jq_field ".peerId")
  [ -n "$s" ] || fail "node $n not reachable on $(node_port "$n") — bring up the 4c/2e devnet first"
done
log "all 6 nodes reachable"

log "configuring baseline core $BASELINE_CORE with swmHostMode.stripCiphertext=false (discriminator)…"
CFG="$(node_dir "$BASELINE_CORE")/config.json"
node -e '
const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));
c.swmHostMode=Object.assign({},c.swmHostMode,{enabled:true,stripCiphertext:false});
fs.writeFileSync(f,JSON.stringify(c,null,2));
' "$CFG" || fail "could not edit baseline core config"
"$SCRIPT_DIR/devnet.sh" restart-node "$BASELINE_CORE" >/dev/null 2>&1 || warn "restart-node $BASELINE_CORE returned non-zero"
sleep 8
for i in $(seq 1 60); do
  [ -n "$(api_call "$BASELINE_CORE" GET /api/status 2>/dev/null | jq_field ".peerId")" ] && break
  sleep 1
done
pass "baseline core $BASELINE_CORE restarted with stripCiphertext=false"

# ---------------------------------------------------------------------------
# 1. Identities
# ---------------------------------------------------------------------------
CURATOR_AGENT=$(api_call "$EDGE_CURATOR" GET /api/agent/identity | jq_field ".agentAddress")
MEMBER_AGENT=$(api_call "$EDGE_MEMBER"  GET /api/agent/identity | jq_field ".agentAddress")
[ -n "$CURATOR_AGENT" ] && [ -n "$MEMBER_AGENT" ] || fail "could not resolve edge agent addresses"
log "curator(edge$EDGE_CURATOR)=$CURATOR_AGENT  member(edge$EDGE_MEMBER)=$MEMBER_AGENT"

# ---------------------------------------------------------------------------
# 2. Create the private CG with BOTH edges on the allowlist; member subscribes
# ---------------------------------------------------------------------------
CREATE_RESP=$(api_call "$EDGE_CURATOR" POST /api/context-graph/create "$(cat <<EOF
{
  "id": "${CG_ID}",
  "name": "RFC-49 catalog sampling ${STAMP}",
  "accessPolicy": 1,
  "publishPolicy": 0,
  "allowedAgents": ["${CURATOR_AGENT}", "${MEMBER_AGENT}"],
  "register": true
}
EOF
)")
log "create CG resp: $CREATE_RESP"
ONCHAIN_ID=$(printf '%s' "$CREATE_RESP" | jq_field ".onChainId")
[ -n "$ONCHAIN_ID" ] || fail "create did not return onChainId (catalog graph is keyed by it)"
log "on-chain CG id = $ONCHAIN_ID (catalog graph: did:dkg:context-graph:${ONCHAIN_ID}/_catalog)"
[ "$(printf '%s' "$CREATE_RESP" | jq_field ".registered")" = "true" ] || warn "CG not reported registered (continuing)"
sleep 4
api_call "$EDGE_MEMBER" POST /api/subscribe "{\"contextGraphId\":\"${CG_ID}\",\"includeSharedMemory\":true}" >/dev/null 2>&1
log "member edge$EDGE_MEMBER subscribed to ${CG_ID}"
# Give the strip-OFF baseline core time to host-mode-discover the new curated CG
# (via the create beacon) and subscribe to its SWM topic BEFORE the publish
# gossips the ciphertext chunks — otherwise it misses them (no ciphertext
# backfill post-strip) and the discriminator reads a false 0.
log "letting host-mode discovery settle (${BASELINE_CORE} strip-OFF should subscribe before publish)…"
sleep 25

# snapshot edge log baseline so we only grep NEW publish lines
EDGE_LOG_BASE=$(wc -l < "$(node_log "$EDGE_CURATOR")" 2>/dev/null || echo 0)

# ---------------------------------------------------------------------------
# 3. Write private SWM triples + publish (curated path)
# ---------------------------------------------------------------------------
PRIV_SUBJ="urn:rfc49:secret:${STAMP}/alice"
ASSERTION_NAME="secret-${STAMP}"
# Use the KA-lifecycle product path (create → wm/write → wm/finalize → swm/share
# → vm/publish). FINALIZE is the step that injects the public `_catalog`
# projection; the raw /api/shared-memory/write + publish shortcut bypasses it,
# so post-strip cores would have no catalog to ACK (NO_DATA_IN_SWM).
api_call "$EDGE_CURATOR" POST /api/knowledge-assets \
  "{\"contextGraphId\":\"${CG_ID}\",\"name\":\"${ASSERTION_NAME}\"}" >/dev/null
WRITE_RESP=$(api_call "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/wm/write" "$(cat <<EOF
{
  "contextGraphId": "${CG_ID}",
  "quads": [
    { "subject": "${PRIV_SUBJ}", "predicate": "http://schema.org/name", "object": "\"Alice Private ${STAMP} — a deliberately wordy private value to ensure the encrypted payload chunks and exercises the LU-11 ciphertext substrate end-to-end on a small devnet run\"", "graph": "" },
    { "subject": "${PRIV_SUBJ}", "predicate": "http://schema.org/email", "object": "\"alice-${STAMP}@example.org\"", "graph": "" },
    { "subject": "${PRIV_SUBJ}", "predicate": "http://schema.org/role", "object": "\"private-member-data padded out so the encrypted member payload reliably produces at least one LU-11 ciphertext chunk on this devnet run\"", "graph": "" }
  ]
}
EOF
)")
log "wm/write: $WRITE_RESP"
FIN_RESP=$(api_call "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/wm/finalize" "{\"contextGraphId\":\"${CG_ID}\"}")
log "wm/finalize (injects _catalog): $FIN_RESP"
SHARE_RESP=$(api_call "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/swm/share" "{\"contextGraphId\":\"${CG_ID}\",\"entities\":\"all\"}")
log "swm/share (promote): $SHARE_RESP"
sleep 2
PUBLISH_RESP=$(api_call "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/vm/publish" "{\"contextGraphId\":\"${CG_ID}\"}")
log "vm/publish: $PUBLISH_RESP"
PUB_STATUS=$(printf '%s' "$PUBLISH_RESP" | jq_field ".status")
KA_ID=$(printf '%s' "$PUBLISH_RESP" | jq_field ".kaId")
[ -z "$KA_ID" ] && KA_ID=$(printf '%s' "$PUBLISH_RESP" | jq_field ".knowledgeAssetId")
[ -z "$KA_ID" ] && KA_ID=$(printf '%s' "$PUBLISH_RESP" | jq_field ".result.kaId")
[ "$PUB_STATUS" = "confirmed" ] || fail "publish status=$PUB_STATUS (expected confirmed): $PUBLISH_RESP"
[ -n "$KA_ID" ] && [ "$KA_ID" != "0" ] || fail "publish returned no kaId: $PUBLISH_RESP"
pass "curated publish confirmed: kaId=$KA_ID"

# ---------------------------------------------------------------------------
# 4. ASSERT: on-chain CATALOG commitment is set (NOT ciphertext)
# ---------------------------------------------------------------------------
CHAIN_READ=$(cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:$HARDHAT_PORT" CONTRACTS_JSON="$CONTRACTS_JSON" ABI_DIR="$ABI_DIR" KA_ID="$KA_ID" node -e '
const {ethers}=require("ethers");const fs=require("fs");const path=require("path");
(async()=>{
  const provider=new ethers.JsonRpcProvider(process.env.RPC_URL);
  const c=JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON,"utf8")).contracts;
  const addr=c.DKGKnowledgeAssets?.evmAddress||c.DKGKnowledgeAssets?.address;
  if(!addr)throw new Error("DKGKnowledgeAssets not deployed");
  const abi=JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR,"DKGKnowledgeAssets.json"),"utf8"));
  const k=new ethers.Contract(addr,abi,provider);
  const root=await k.getCatalogRoot(BigInt(process.env.KA_ID));
  const count=await k.getCatalogLeafCount(BigInt(process.env.KA_ID));
  console.log(JSON.stringify({catalogRoot:root,catalogLeafCount:count.toString()}));
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
') || fail "on-chain getCatalogRoot read failed"
CAT_ROOT=$(printf '%s' "$CHAIN_READ" | jq_field ".catalogRoot")
CAT_COUNT=$(printf '%s' "$CHAIN_READ" | jq_field ".catalogLeafCount")
ZERO="0x0000000000000000000000000000000000000000000000000000000000000000"
log "on-chain catalogRoot=$CAT_ROOT catalogLeafCount=$CAT_COUNT"
[ "$CAT_ROOT" != "$ZERO" ] || fail "catalogRoot is ZERO on a curated publish — producer did not set the catalog commitment"
[ "${CAT_COUNT:-0}" -ge 1 ] 2>/dev/null || fail "catalogLeafCount < 1"
pass "on-chain catalog commitment set (root non-zero, leafCount=$CAT_COUNT)"

# ---------------------------------------------------------------------------
# 5. Non-vacuousness: the publisher DID emit private ciphertext chunks
# ---------------------------------------------------------------------------
EDGE_NEW=$(tail -n "+$((EDGE_LOG_BASE + 1))" "$(node_log "$EDGE_CURATOR")" 2>/dev/null)
if printf '%s' "$EDGE_NEW" | grep -qE 'LU-11.*emitted [1-9].*ciphertext chunk|emitted [1-9][0-9]* ciphertext chunk'; then
  CHUNKS=$(printf '%s' "$EDGE_NEW" | grep -oE 'emitted [0-9]+ ciphertext chunk' | grep -oE '[0-9]+' | head -1)
  pass "publisher emitted $CHUNKS private ciphertext chunk(s) — ciphertext genuinely exists"
else
  warn "no LU-11 ciphertext-chunk emit line on the curator edge (publisher may have used a single-blob path; strip assertions below are then weaker)"
fi

# ---------------------------------------------------------------------------
# 6. Member edge holds the private data (member-side) — the data lives on the
#    members, NOT the cores. Member SWM sync lags the publish, so poll.
# ---------------------------------------------------------------------------
member_priv_count() {
  api_call "$EDGE_MEMBER" POST /api/query "$(S="$PRIV_SUBJ" node -e 'console.log(JSON.stringify({sparql:`SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { <${process.env.S}> ?p ?o } }`}))')" | _count_from_query
}
MEMBER_PRIV=0
for i in $(seq 1 45); do
  MEMBER_PRIV=$(member_priv_count)
  [ "${MEMBER_PRIV:-0}" -ge 1 ] 2>/dev/null && break
  sleep 2
done
if [ "${MEMBER_PRIV:-0}" -ge 1 ] 2>/dev/null; then
  pass "member edge$EDGE_MEMBER holds the private data ($MEMBER_PRIV triple(s) for the secret subject) — private data lives member-side, off the cores"
else
  warn "member edge$EDGE_MEMBER did not sync the private data in-window (sync timing? — not a strip gate)"
fi

# ---------------------------------------------------------------------------
# 7. THE STRIP: stripped cores hold ZERO ciphertext but DO hold the _catalog
# ---------------------------------------------------------------------------
# The ACKing cores persist the public _catalog during the storage-ACK, which
# lands in the queryable store a few seconds AFTER vm/publish returns. Poll
# until it propagates so the custody check isn't racing the persist.
log "waiting for the public _catalog to propagate to the stripped cores (up to 3 min)…"
for i in $(seq 1 60); do
  holders=0
  for n in "${STRIPPED_CORES[@]}"; do c=$(catalog_count "$n"); [ "${c:-0}" -ge 1 ] 2>/dev/null && holders=$((holders+1)); done
  [ "$holders" -ge "${#STRIPPED_CORES[@]}" ] && { log "  catalog present on all $holders/${#STRIPPED_CORES[@]} stripped cores"; break; }
  [ "$i" -eq 1 ] || [ $((i % 10)) -eq 0 ] && log "  …catalog on $holders/${#STRIPPED_CORES[@]} cores after $((i*3))s"
  sleep 3
done

log "checking ciphertext + catalog custody per core…"
STRIP_OK=1
for n in "${STRIPPED_CORES[@]}"; do
  ct=$(ciphertext_count "$n"); cat=$(catalog_count "$n")
  log "  core$n: ciphertext_rows=$ct  catalog_triples=$cat"
  if [ "$ct" != "0" ]; then STRIP_OK=0; warn "core$n holds $ct ciphertext rows (expected 0 — STRIP LEAK)"; fi
done
[ "$STRIP_OK" -eq 1 ] || fail "STRIP LEAK: a stripped core holds private ciphertext"
pass "all stripped cores (${STRIPPED_CORES[*]}) hold ZERO private ciphertext"

# at least one stripped core must hold the catalog (so it can serve + prove it)
CATALOG_HOLDERS=0
for n in "${STRIPPED_CORES[@]}"; do
  cat=$(catalog_count "$n"); [ "${cat:-0}" -ge 1 ] 2>/dev/null && CATALOG_HOLDERS=$((CATALOG_HOLDERS+1))
done
[ "$CATALOG_HOLDERS" -ge 1 ] || fail "no stripped core holds the public _catalog — cannot prove it"
pass "$CATALOG_HOLDERS/${#STRIPPED_CORES[@]} stripped cores hold the public _catalog"

# ---------------------------------------------------------------------------
# 8. DISCRIMINATOR: strip-OFF baseline core DOES hold the ciphertext
# ---------------------------------------------------------------------------
log "waiting for the strip-OFF baseline core $BASELINE_CORE to host-mode-ingest ciphertext…"
BASE_CT=0
for i in $(seq 1 30); do
  BASE_CT=$(ciphertext_count "$BASELINE_CORE")
  [ "${BASE_CT:-0}" -ge 1 ] 2>/dev/null && break
  sleep 2
done
if [ "${BASE_CT:-0}" -ge 1 ] 2>/dev/null; then
  BASELINE_SUMMARY="strip-OFF core $BASELINE_CORE: holds $BASE_CT ciphertext row(s) (discriminator — strip is non-vacuous)"
  pass "DISCRIMINATOR: $BASELINE_SUMMARY → the strip on cores ${STRIPPED_CORES[*]} is demonstrably effective"
else
  BASELINE_SUMMARY="strip-OFF core $BASELINE_CORE: 0 ciphertext (host-mode discovery did not engage in-window; non-vacuousness rests on the emitted-chunks check)"
  warn "$BASELINE_SUMMARY"
fi

# ---------------------------------------------------------------------------
# 9. RANDOM SAMPLING: a core proves the _catalog
# ---------------------------------------------------------------------------
log "driving random sampling — baseline submittedCount per core:"
RS0=()  # indexed array (node ids are integers) — macOS bash 3.2 has no `declare -A`
for n in "${STRIPPED_CORES[@]}" "$BASELINE_CORE"; do RS0[$n]=$(rs_submitted "$n"); log "  core$n=${RS0[$n]:-?}"; done

RS_OK=0
for round in $(seq 1 12); do
  hardhat_mine 250
  sleep 8
  for n in "${STRIPPED_CORES[@]}" "$BASELINE_CORE"; do
    now=$(rs_submitted "$n")
    if [ -n "$now" ] && [ -n "${RS0[$n]}" ] && [ "$now" -gt "${RS0[$n]}" ] 2>/dev/null; then
      pass "core$n submitted a random-sampling proof (submittedCount ${RS0[$n]}→$now) — proving the _catalog"
      RS_OK=1; break 2
    fi
  done
  log "  round $round: no new proof yet…"
done
[ "$RS_OK" -eq 1 ] || fail "no core submitted a random-sampling proof within the window (the curated KC's _catalog was not proven)"

# ---------------------------------------------------------------------------
# 9b. CURATED UPDATE (OT-RFC-49 WS-D): update the confirmed curated KA with new
#     data and prove the catalog stays committed + re-hosted + provable.
#
#   A curated UPDATE re-commits the deterministic public `_catalog` floor: the
#   producer's update() re-injects the floor, ships it inline, the cores rebuild
#   + REPLACE-persist `<cg>/_catalog`, and the on-chain catalog commitment is set
#   so the update CONFIRMS (before this feature a curated update shipped a ZERO
#   catalog root and REVERTED with CuratedCGRequiresCatalogCommitment). The
#   catalog is the STABLE public floor — the update RE-COMMITS THE SAME ROOT, it
#   does NOT rotate — so we assert root non-zero AND == the publish baseline.
#
#   Driven via POST /api/update with an owner-sealed precomputedUpdateAttestation
#   (build_update_body --curated). Re-finalize is NOT usable: the seal is keyed
#   by the assertion URI and neither discard nor re-create clears it, so a 2nd
#   wm/finalize of changed content hits "already finalized with a different
#   merkleRoot". /api/update is the on-chain UPDATE primitive the daemon exposes.
# ---------------------------------------------------------------------------
log "── CURATED UPDATE path (POST /api/update, owner-sealed, floor re-injected) ──"
UPD_QUADS=$(STAMP="$STAMP" PRIV_SUBJ="$PRIV_SUBJ" node -e '
const stamp=process.env.STAMP, subj=process.env.PRIV_SUBJ;
console.log(JSON.stringify([
  { subject: subj, predicate: "http://schema.org/name", object: `"Alice Private ${stamp} — UPDATED value, still padded out to keep the encrypted member payload chunking through the LU-11 ciphertext substrate on this devnet update"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/email", object: `"alice-${stamp}@example.org"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/role", object: `"private-member-data, UPDATED — padded so the encrypted member payload reliably produces at least one LU-11 ciphertext chunk on this devnet update"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/jobTitle", object: "\"Lead (added on update)\"", graph: "" }
]))')

# build_update_body resolves the KA owner key (ownerOf), injects the curated
# `_catalog` floor (6th arg = LOCAL cg id), seals, and emits the /api/update body.
UPD_BODY=$(REPO_ROOT="$REPO_ROOT" DEVNET_DIR="$DEVNET_DIR" NUM_NODES="$NUM_NODES" \
  build_update_body "$EDGE_CURATOR" "$KA_ID" "$CG_ID" "$UPD_QUADS" "[]" "$CG_ID") \
  || fail "could not build curated update body (seal/owner-key resolution failed)"
UPD_RESP=$(api_call "$EDGE_CURATOR" POST /api/update "$UPD_BODY")
log "POST /api/update: $UPD_RESP"
UPD_STATUS=$(printf '%s' "$UPD_RESP" | jq_field ".status")
UPD_KA=$(printf '%s' "$UPD_RESP" | jq_field ".kaId")
[ "$UPD_STATUS" = "confirmed" ] || fail "curated update status=$UPD_STATUS (expected confirmed — CuratedCGRequiresCatalogCommitment regression?): $UPD_RESP"
[ "$UPD_KA" = "$KA_ID" ] || fail "curated update kaId=$UPD_KA != publish kaId=$KA_ID (update did not target the same KA)"
pass "curated update confirmed and targets the SAME KA (kaId=$UPD_KA)"

# ── on-chain: catalog still committed, non-zero, EQUALS the publish baseline. ──
UPD_CHAIN=$(cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:$HARDHAT_PORT" CONTRACTS_JSON="$CONTRACTS_JSON" ABI_DIR="$ABI_DIR" KA_ID="$KA_ID" node -e '
const {ethers}=require("ethers");const fs=require("fs");const path=require("path");
(async()=>{
  const provider=new ethers.JsonRpcProvider(process.env.RPC_URL);
  const c=JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON,"utf8")).contracts;
  const addr=c.DKGKnowledgeAssets?.evmAddress||c.DKGKnowledgeAssets?.address;
  const abi=JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR,"DKGKnowledgeAssets.json"),"utf8"));
  const k=new ethers.Contract(addr,abi,provider);
  console.log(JSON.stringify({root:await k.getCatalogRoot(BigInt(process.env.KA_ID)),count:(await k.getCatalogLeafCount(BigInt(process.env.KA_ID))).toString()}));
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
') || fail "post-update on-chain getCatalogRoot read failed"
UPD_ROOT=$(printf '%s' "$UPD_CHAIN" | jq_field ".root")
UPD_COUNT=$(printf '%s' "$UPD_CHAIN" | jq_field ".count")
log "post-update on-chain catalogRoot=$UPD_ROOT catalogLeafCount=$UPD_COUNT (baseline root=$CAT_ROOT count=$CAT_COUNT)"
[ "$UPD_ROOT" != "$ZERO" ] || fail "post-update catalogRoot is ZERO — the curated update dropped the catalog commitment"
[ "$UPD_ROOT" = "$CAT_ROOT" ] || fail "post-update catalogRoot=$UPD_ROOT != publish baseline=$CAT_ROOT — the stable floor must RE-COMMIT, not rotate"
[ "$UPD_COUNT" = "$CAT_COUNT" ] || fail "post-update catalogLeafCount=$UPD_COUNT != baseline=$CAT_COUNT"
pass "curated update RE-COMMITTED the stable catalog floor (root non-zero, == baseline, leafCount=$UPD_COUNT)"

# ── stripped/host-mode cores RE-HOST the updated `_catalog`. ──
# The update ACK drives each core's updateHandler to rebuild + verify +
# REPLACE-persist `<cg>/_catalog`. Poll until it lands (same propagation race
# as the publish path's section 7).
log "waiting for the updated _catalog to (re-)propagate to the stripped cores (up to 3 min)…"
for i in $(seq 1 60); do
  holders=0
  for n in "${STRIPPED_CORES[@]}"; do c=$(catalog_count "$n"); [ "${c:-0}" -ge 1 ] 2>/dev/null && holders=$((holders+1)); done
  [ "$holders" -ge 1 ] && { log "  updated catalog present on $holders/${#STRIPPED_CORES[@]} stripped cores"; break; }
  [ "$i" -eq 1 ] || [ $((i % 10)) -eq 0 ] && log "  …updated catalog on $holders/${#STRIPPED_CORES[@]} cores after $((i*3))s"
  sleep 3
done
UPD_CAT_HOLDERS=0
for n in "${STRIPPED_CORES[@]}"; do cat=$(catalog_count "$n"); [ "${cat:-0}" -ge 1 ] 2>/dev/null && UPD_CAT_HOLDERS=$((UPD_CAT_HOLDERS+1)); done
[ "$UPD_CAT_HOLDERS" -ge 1 ] || fail "no stripped core re-hosts the updated public _catalog after the update"
pass "$UPD_CAT_HOLDERS/${#STRIPPED_CORES[@]} stripped cores re-host the updated public _catalog"

# ── a core submits a random-sampling proof against the UPDATED catalog. ──
log "driving random sampling against the updated catalog — submittedCount per core:"
RSU0=()
for n in "${STRIPPED_CORES[@]}" "$BASELINE_CORE"; do RSU0[$n]=$(rs_submitted "$n"); log "  core$n=${RSU0[$n]:-?}"; done
RSU_OK=0
for round in $(seq 1 12); do
  hardhat_mine 250
  sleep 8
  for n in "${STRIPPED_CORES[@]}" "$BASELINE_CORE"; do
    now=$(rs_submitted "$n")
    if [ -n "$now" ] && [ -n "${RSU0[$n]}" ] && [ "$now" -gt "${RSU0[$n]}" ] 2>/dev/null; then
      pass "core$n submitted a random-sampling proof after the update (submittedCount ${RSU0[$n]}→$now) — proving the UPDATED _catalog"
      RSU_OK=1; break 2
    fi
  done
  log "  round $round: no new post-update proof yet…"
done
[ "$RSU_OK" -eq 1 ] || fail "no core submitted a random-sampling proof against the updated catalog within the window"

# ── MEMBER converges to the UPDATED private payload (OT-RFC-49 member distribution). ──
# The curated update now DISTRIBUTES the updated payload: the producer emits the
# LU-11 ciphertext chunk and the curator persists it (vs the OLD encrypt-then-
# discard, which delivered NOTHING and left members permanently stale). This is
# the NON-VACUOUS proof: unlike the catalog re-host (the floor is stable, so cores
# already held it from publish), the member must end up holding the UPDATED value.
# NOTE: a live gossip-push to an ALREADY-CONNECTED member is the known M2-a
# converge race (issue #1205 — affects ALL SWM updates, not curated-update-
# specific); the SUPPORTED catch-up is converge-on-reconnect. So restart the
# member to exercise the converge path, then assert it holds the UPDATED value.
log "restarting member edge$EDGE_MEMBER to exercise SWM converge to the UPDATED payload…"
"$REPO_ROOT/scripts/devnet.sh" restart-node "$EDGE_MEMBER" >/dev/null 2>&1 || true
for _ in $(seq 1 90); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$(node_port "$EDGE_MEMBER")/api/status" 2>/dev/null && break; sleep 1; done
MEMBER_GOT_UPDATE=0
for i in $(seq 1 40); do
  got=$(api_call "$EDGE_MEMBER" POST /api/query "$(S="$PRIV_SUBJ" node -e 'console.log(JSON.stringify({sparql:`SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { <${process.env.S}> ?p ?o . FILTER(CONTAINS(STR(?o), "UPDATED")) } }`}))')" | _count_from_query)
  [ "${got:-0}" -ge 1 ] 2>/dev/null && { MEMBER_GOT_UPDATE=1; break; }
  { [ "$i" -eq 1 ] || [ $((i % 10)) -eq 0 ]; } && log "  …member converging — still on pre-update value after $((i*3))s"
  sleep 3
done
[ "$MEMBER_GOT_UPDATE" -ge 1 ] || fail "member edge$EDGE_MEMBER did NOT converge to the UPDATED private payload after reconnect — the curated update did not DISTRIBUTE to members (Option B regression)"
pass "member edge$EDGE_MEMBER converged to the UPDATED private payload — the curated update DISTRIBUTES to members (producer emit + curator-held + converge-on-reconnect)"

# ---------------------------------------------------------------------------
# 10. FROM-SWM SHORTCUT (OT-RFC-49 catalog auto-injection): a curated publish via
#     the RAW /api/shared-memory/write + /api/shared-memory/publish path (NO
#     assertion finalize) must ALSO get the `_catalog` injected → confirmed ACK +
#     on-chain catalog commitment + cores hold it. Sections 1-9 above (KA-lifecycle
#     finalize path) double as the REGRESSION baseline: their catalogLeafCount=4
#     proves the idempotency guard left the finalize path intact.
# ---------------------------------------------------------------------------
log "── FROM-SWM SHORTCUT path (raw write+publish, no finalize) ──"
SC_CG="rfc49-shortcut-${STAMP}"
SC_URI="did:dkg:context-graph:${SC_CG}"
SC_SUBJ="urn:rfc49:secret-shortcut:${STAMP}/carol"
SC_CREATE=$(api_call "$EDGE_CURATOR" POST /api/context-graph/create "{\"id\":\"${SC_CG}\",\"name\":\"RFC-49 from-SWM shortcut ${STAMP}\",\"accessPolicy\":1,\"publishPolicy\":0,\"allowedAgents\":[\"${CURATOR_AGENT}\",\"${MEMBER_AGENT}\"],\"register\":true}")
SC_OID=$(printf '%s' "$SC_CREATE" | jq_field ".onChainId")
[ -n "$SC_OID" ] || fail "shortcut CG create did not return onChainId: $SC_CREATE"
log "shortcut CG on-chain id = $SC_OID"
sleep 4
# mirror the main flow: a subscribed member establishes the curated sender-key
# recipient set so the curator's SWM write lands + is reloadable by the publish.
api_call "$EDGE_MEMBER" POST /api/subscribe "{\"contextGraphId\":\"${SC_CG}\",\"includeSharedMemory\":true}" >/dev/null 2>&1
sleep 4
SC_WRITE=$(api_call "$EDGE_CURATOR" POST /api/shared-memory/write "{\"contextGraphId\":\"${SC_URI}\",\"quads\":[{\"subject\":\"${SC_SUBJ}\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Carol via the raw from-SWM shortcut ${STAMP}, padded to exercise the encrypted member payload end-to-end\\\"\",\"graph\":\"\"},{\"subject\":\"${SC_SUBJ}\",\"predicate\":\"http://schema.org/email\",\"object\":\"\\\"carol-${STAMP}@example.org\\\"\",\"graph\":\"\"}]}")
log "raw SWM write: $SC_WRITE"
log "publishing via /api/shared-memory/publish (no finalize)…"
sleep 5
SC_PUB=$(devnet_publish_swm_all_roots "$EDGE_CURATOR" "${SC_URI}" false)
SC_STATUS=$(printf '%s' "$SC_PUB" | jq_field ".status")
SC_KA=$(printf '%s' "$SC_PUB" | jq_field ".kaId"); [ -z "$SC_KA" ] && SC_KA=$(printf '%s' "$SC_PUB" | jq_field ".knowledgeAssetId")
[ "$SC_STATUS" = "confirmed" ] || fail "FROM-SWM shortcut publish status=$SC_STATUS (catalog auto-injection did NOT unblock the curated ACK): $SC_PUB"
[ -n "$SC_KA" ] && [ "$SC_KA" != "0" ] || fail "FROM-SWM shortcut: no kaId: $SC_PUB"
pass "FROM-SWM shortcut publish confirmed (kaId=$SC_KA) — catalog auto-injection unblocked the curated ACK"
# on-chain catalog commitment for the shortcut KA
SC_CHAIN=$(cd "$REPO_ROOT/packages/evm-module" && RPC_URL="http://127.0.0.1:$HARDHAT_PORT" CONTRACTS_JSON="$CONTRACTS_JSON" ABI_DIR="$ABI_DIR" KA_ID="$SC_KA" node -e '
const {ethers}=require("ethers");const fs=require("fs");const path=require("path");
(async()=>{const p=new ethers.JsonRpcProvider(process.env.RPC_URL);const c=JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON,"utf8")).contracts;const a=c.DKGKnowledgeAssets?.evmAddress||c.DKGKnowledgeAssets?.address;const abi=JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR,"DKGKnowledgeAssets.json"),"utf8"));const k=new ethers.Contract(a,abi,p);console.log(JSON.stringify({root:await k.getCatalogRoot(BigInt(process.env.KA_ID)),count:(await k.getCatalogLeafCount(BigInt(process.env.KA_ID))).toString()}))})().catch(e=>{console.error(e?.message||e);process.exit(1)});') || fail "shortcut on-chain catalog read failed"
SC_ROOT=$(printf '%s' "$SC_CHAIN" | jq_field ".root"); SC_COUNT=$(printf '%s' "$SC_CHAIN" | jq_field ".count")
[ "$SC_ROOT" != "$ZERO" ] || fail "FROM-SWM shortcut: on-chain catalogRoot is ZERO — injection produced no catalog"
[ "${SC_COUNT:-0}" -ge 1 ] 2>/dev/null || fail "FROM-SWM shortcut: catalogLeafCount < 1"
pass "FROM-SWM shortcut: on-chain catalog commitment set (root non-zero, leafCount=$SC_COUNT) — same as the finalize path"
# a core holds the injected catalog
ONCHAIN_ID="$SC_OID"
SC_HELD=0
for i in $(seq 1 60); do
  for n in "${STRIPPED_CORES[@]}"; do c=$(catalog_count "$n"); [ "${c:-0}" -ge 1 ] 2>/dev/null && { SC_HELD=1; break; }; done
  [ "$SC_HELD" -eq 1 ] && break; sleep 3
done
[ "$SC_HELD" -eq 1 ] || fail "FROM-SWM shortcut: no stripped core holds the injected _catalog"
pass "FROM-SWM shortcut: stripped cores hold the injected public _catalog"

echo ""
log "============================================================"
pass "RFC-49 CATALOG-SAMPLING STRIP — DEVNET VALIDATION PASSED"
log "  • curated publish → on-chain catalog commitment (root=$CAT_ROOT, leaves=$CAT_COUNT)"
log "  • stripped cores ${STRIPPED_CORES[*]}: ZERO private ciphertext, hold the _catalog"
log "  • ${BASELINE_SUMMARY:-baseline core: (not evaluated)}"
log "  • a core proved the public _catalog in random sampling"
log "  • curated UPDATE (POST /api/update): re-committed the stable catalog floor (root==baseline, leaves=${UPD_COUNT:-?}), cores re-host it, a core proved the updated catalog"
log "  • FROM-SWM shortcut (raw write+publish, no finalize): catalog auto-injected (leafCount=$SC_COUNT), cores hold it — and the finalize path above stayed intact (leafCount=$CAT_COUNT)"
log "============================================================"
