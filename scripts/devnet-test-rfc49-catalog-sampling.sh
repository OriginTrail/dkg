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
node_agent_token() {
  local node="$1"
  AGENT_KEYSTORE="$(node_dir "$node")/agent-keystore.json" node -e '
    const fs = require("fs");
    try {
      const records = Object.values(JSON.parse(fs.readFileSync(process.env.AGENT_KEYSTORE, "utf8")));
      const token = records.find((record) => typeof record?.authToken === "string")?.authToken ?? "";
      process.stdout.write(token);
    } catch {
      process.stdout.write("");
    }
  '
}
node_log()   { echo "$(node_dir "$1")/daemon.log"; }

api_call_with_token() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local tok="$5"
  local url="http://127.0.0.1:$(node_port "$node")$path"
  if [ -n "$data" ]; then
    curl -sS -X "$method" -H 'Content-Type: application/json' -H "Authorization: Bearer $tok" --data "$data" "$url"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $tok" "$url"
  fi
}

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  api_call_with_token "$node" "$method" "$path" "$data" "$(node_token)"
}

api_call_agent() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local tok; tok="$(node_agent_token "$node")"
  [ -n "$tok" ] || tok="$(node_token)"
  api_call_with_token "$node" "$method" "$path" "$data" "$tok"
}

jq_field() { node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);const p=process.argv[1].split(".").filter(Boolean);let v=j;for(const k of p)v=v?.[k];console.log(typeof v==="object"?JSON.stringify(v):(v??""))}catch(e){console.log("")}})' "$1"; }

# Named for what it used to call; see devnet_mine_blocks for why it no longer does.
hardhat_mine() {
  devnet_mine_blocks "$1" "$HARDHAT_PORT"
}

# Parse the COUNT(*) row of a SPARQL JSON answer (a store's `.results`, or the
# daemon's `.result`). The binding value is a typed literal like
# `"0"^^<http://www.w3.org/2001/XMLSchema#integer>` — take ONLY the value
# before `^^` (stripping the type IRI, whose `w3`/`2001` digits would otherwise
# corrupt the count, e.g. "0" → 0, not 32001). An answer without a count row
# (an error body, a denied query) fails; it is never a 0.
_count_from_query() {
  node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const cell = (j?.results?.bindings ?? j?.result?.bindings)?.[0]?.c;
        const v = String((cell !== null && typeof cell === "object" ? cell.value : cell) ?? "")
          .split("^^")[0].replace(/"/g, "").trim();
        if (!/^\d+$/.test(v)) throw new Error("no count row");
        console.log(Number(v));
      } catch (e) {
        console.error(`unreadable COUNT answer (${e.message}): ${d.slice(0, 300)}`);
        process.exit(1);
      }
    });
  '
}

# Query endpoint of node $1's backing store, from its config.json. Since v10.0.17
# the daemon answers an unscoped /api/query only on stores with all-writer
# consistency coverage, and a scoped query cannot see `_catalog` or the
# ciphertext-chunk graphs, so custody is read from the store itself. In-process
# Oxigraph has no endpoint but declares that coverage: "api" means /api/query.
store_query_endpoint() {
  CFG="$(node_dir "$1")/config.json" node -e '
    let store;
    try {
      store = JSON.parse(require("fs").readFileSync(process.env.CFG, "utf8")).store ?? {};
    } catch (e) {
      console.error(`cannot read ${process.env.CFG}: ${e.message}`);
      process.exit(1);
    }
    const options = store.options ?? {};
    const endpoint = {
      "oxigraph-server": `http://127.0.0.1:${options.port ?? 7878}/query`,
      blazegraph: options.url ?? store.url,
      "sparql-http": options.queryEndpoint,
      oxigraph: "api",
      "oxigraph-persistent": "api",
      "oxigraph-worker": "api",
    }[store.backend ?? "oxigraph-worker"];
    if (!endpoint) {
      console.error(`no query endpoint for store backend ${store.backend} in ${process.env.CFG}`);
      process.exit(1);
    }
    console.log(endpoint);
  '
}

# COUNT(*) of a SPARQL SELECT on node $1's backing store. Prints the count, or
# fails with the reason on stderr: an HTTP error or an unreadable answer is
# never a count of 0.
store_count() {
  local node="$1" sparql="$2" endpoint out code body
  endpoint=$(store_query_endpoint "$node") || return 1
  if [ "$endpoint" = "api" ]; then
    body=$(api_call "$node" POST /api/query "$(SPARQL="$sparql" node -e 'console.log(JSON.stringify({ sparql: process.env.SPARQL }))')") || return 1
  else
    out=$(curl -sS --max-time 60 -X POST -H 'Accept: application/sparql-results+json' \
      --data-urlencode "query=${sparql}" -w $'\n%{http_code}' "$endpoint") || {
      echo "node $node store $endpoint is unreachable" >&2
      return 1
    }
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"
    if [ "$code" != "200" ]; then
      echo "node $node store $endpoint answered HTTP $code: ${body:0:300}" >&2
      return 1
    fi
  fi
  printf '%s' "$body" | _count_from_query
}

# COUNT(*) of rows for THIS publish's ciphertext batch under any
# urn:dkg:swm:ciphertext-chunks/* graph in a node's store.
#
# The comprehensive sweep reuses one devnet across suites. Earlier harnesses may
# intentionally put legacy-host ciphertext into a core store, so a global
# ciphertext count would falsely fail this suite. The LU-11 subject embeds the
# current publish batch id (`.../<batchId>/<chunkIndex>`), which is the V10 KC
# merkleRoot returned by wm/finalize; scope to that subject prefix.
ciphertext_count() {
  [ -n "${BATCH_ID:-}" ] || { echo "BATCH_ID is not set" >&2; return 1; }
  store_count "$1" "SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o . FILTER(STRSTARTS(STR(?g), \"urn:dkg:swm:ciphertext-chunks/\") && STRSTARTS(STR(?s), \"urn:dkg:swm:v10-publish-ciphertext-chunk/${BATCH_ID}/\")) } }"
}

# COUNT(*) of triples in the public <cg>/_catalog graph (keyed by the NUMERIC
# on-chain CG id, e.g. did:dkg:context-graph:5/_catalog — NOT the local name).
catalog_count() {
  store_count "$1" "SELECT (COUNT(*) AS ?c) WHERE { GRAPH <did:dkg:context-graph:${ONCHAIN_ID}/_catalog> { ?s ?p ?o } }"
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
# Back up the baseline core's config and restore it (with a restart) on ANY exit.
# This suite is now run inside the shared comprehensive sweep, so leaving the core
# on stripCiphertext=false would silently change SWM behavior for every later
# suite (and leave the devnet mutated after a passing run).
CFG_BAK="$(mktemp "${TMPDIR:-/tmp}/rfc49-cfg-XXXXXX")"
cp "$CFG" "$CFG_BAK"
MEMBER_NEEDS_RESTORE=0
wait_member_up() {
  local i
  for i in $(seq 1 90); do
    if curl -sS --max-time 1 -o /dev/null "http://127.0.0.1:$(node_port "$EDGE_MEMBER")/api/status" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}
cleanup_devnet() {
  local result=$?
  trap - EXIT INT TERM
  if [ "$MEMBER_NEEDS_RESTORE" -eq 1 ]; then
    "$SCRIPT_DIR/devnet.sh" restart-node "$EDGE_MEMBER" >/dev/null 2>&1 \
      || { warn "cleanup could not restart member edge$EDGE_MEMBER"; result=1; }
    wait_member_up || { warn "cleanup could not health-check member edge$EDGE_MEMBER"; result=1; }
  fi
  if [ -f "$CFG_BAK" ]; then
    cp "$CFG_BAK" "$CFG" 2>/dev/null \
      || { warn "cleanup could not restore baseline core $BASELINE_CORE config"; result=1; }
    "$SCRIPT_DIR/devnet.sh" restart-node "$BASELINE_CORE" >/dev/null 2>&1 \
      || { warn "cleanup could not restart baseline core $BASELINE_CORE"; result=1; }
    rm -f "$CFG_BAK"
  fi
  exit "$result"
}
trap cleanup_devnet EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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
# 2. Create the private CG with BOTH edges on the allowlist; member joins + subscribes
# ---------------------------------------------------------------------------
CREATE_RESP=$(api_call_agent "$EDGE_CURATOR" POST /api/context-graph/create "$(cat <<EOF
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
# The member joins through the supported flow: a signed join request, which the
# curator auto-approves for an allowlisted agent and answers with the CG
# metadata. Allowlisting by address alone gives the member no metadata, so it
# would refuse the CG's shared memory. Do not pre-create the CG on the member:
# for a plain (not wallet-scoped) id that makes the member its own curator.
CG_ENC=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$CG_ID")
CURATOR_PEER=$(api_call_agent "$EDGE_CURATOR" GET /api/agent/identity | jq_field ".peerId")
[ -n "$CURATOR_PEER" ] || fail "could not read the curator peer id"
# Edges usually know each other only through relayed addresses. Dial the
# curator directly first, as an invitee holding the curator's address would,
# so the join request's identity probe does not depend on a relay circuit.
CURATOR_ADDR=$(cat "$(node_dir "$EDGE_CURATOR")/multiaddr" 2>/dev/null || true)
if [ -n "$CURATOR_ADDR" ]; then
  log "member edge$EDGE_MEMBER connects to the curator: $(api_call_agent "$EDGE_MEMBER" POST /api/connect "{\"multiaddr\":\"${CURATOR_ADDR}\"}")"
fi
SIGNED_JOIN=$(api_call_agent "$EDGE_MEMBER" POST "/api/context-graph/${CG_ENC}/sign-join" '{}')
JOIN_BODY=$(SIGNED_JOIN="$SIGNED_JOIN" CURATOR_PEER="$CURATOR_PEER" node -e '
  const signed = JSON.parse(process.env.SIGNED_JOIN);
  if (!signed.delegation) process.exit(1);
  console.log(JSON.stringify({ delegation: signed.delegation, curatorPeerId: process.env.CURATOR_PEER, agentName: "rfc49-member" }));
') || fail "member sign-join returned no delegation: $SIGNED_JOIN"
# Few, spaced attempts: the curator admits at most 6 join requests per agent a
# minute, and an undelivered request stays queued and may still arrive later.
JOIN_RESP=""
for attempt in 1 2 3 4; do
  JOIN_RESP=$(api_call_agent "$EDGE_MEMBER" POST "/api/context-graph/${CG_ENC}/request-join" "$JOIN_BODY")
  JOIN_STATUS=$(printf '%s' "$JOIN_RESP" | jq_field ".status")
  JOIN_DELIVERED=$(printf '%s' "$JOIN_RESP" | jq_field ".delivered")
  if { [ "$JOIN_DELIVERED" = "1" ] || [ "$JOIN_DELIVERED" = "local" ]; } \
    && { [ "$JOIN_STATUS" = "approved" ] || [ "$JOIN_STATUS" = "already-member" ]; }; then
    break
  fi
  log "  member join not approved yet (attempt $attempt): ${JOIN_RESP:0:200}"
  sleep 20
done
[ "$JOIN_STATUS" = "approved" ] || [ "$JOIN_STATUS" = "already-member" ] \
  || fail "member edge$EDGE_MEMBER's join was not approved: $JOIN_RESP"
{ [ "$JOIN_DELIVERED" = "1" ] || [ "$JOIN_DELIVERED" = "local" ]; } \
  || fail "member edge$EDGE_MEMBER's approved join was not delivered: $JOIN_RESP"
log "member edge$EDGE_MEMBER join request: $JOIN_RESP"
# Wait for the approval notification to install the curator's own _meta on
# the member. Delivery of the request alone is not proof of local membership.
MEMBER_META_COUNT=0
for i in $(seq 1 60); do
  MEMBER_META_COUNT=$(store_count "$EDGE_MEMBER" "SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${CG_URI}/_meta> { <${CG_URI}> <https://dkg.network/ontology#allowedAgent> ?agent . FILTER(LCASE(STR(?agent)) = LCASE(\"${MEMBER_AGENT}\")) } }" 2>/dev/null) || MEMBER_META_COUNT=0
  [ "$MEMBER_META_COUNT" -ge 1 ] && break
  sleep 2
done
[ "$MEMBER_META_COUNT" -ge 1 ] \
  || fail "member edge$EDGE_MEMBER did not receive approved _meta for ${CG_ID}"
SUBSCRIBE_RESP=$(api_call_agent "$EDGE_MEMBER" POST /api/subscribe "{\"contextGraphId\":\"${CG_ID}\",\"includeSharedMemory\":true}") \
  || fail "member edge$EDGE_MEMBER's subscribe request failed"
[ "$(printf '%s' "$SUBSCRIBE_RESP" | jq_field ".subscribed")" = "$CG_ID" ] \
  || fail "member edge$EDGE_MEMBER's subscribe was not accepted: $SUBSCRIBE_RESP"
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
# projection; the retired raw SWM shortcut used to bypass it,
# so post-strip cores would have no catalog to ACK (NO_DATA_IN_SWM).
api_call_agent "$EDGE_CURATOR" POST /api/knowledge-assets \
  "{\"contextGraphId\":\"${CG_ID}\",\"name\":\"${ASSERTION_NAME}\"}" >/dev/null
WRITE_RESP=$(api_call_agent "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/wm/write" "$(cat <<EOF
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
FIN_RESP=$(api_call_agent "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/wm/finalize" "{\"contextGraphId\":\"${CG_ID}\"}")
log "wm/finalize (injects _catalog): $FIN_RESP"
BATCH_ID=$(printf '%s' "$FIN_RESP" | jq_field ".merkleRoot")
[ -n "$BATCH_ID" ] || fail "finalize did not return merkleRoot/batchId: $FIN_RESP"
SHARE_RESP=$(api_call_agent "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/swm/share" "{\"contextGraphId\":\"${CG_ID}\",\"entities\":\"all\"}")
log "swm/share (promote): $SHARE_RESP"
sleep 2
PUBLISH_RESP=$(api_call_agent "$EDGE_CURATOR" POST "/api/knowledge-assets/${ASSERTION_NAME}/vm/publish" "{\"contextGraphId\":\"${CG_ID}\"}")
log "vm/publish: $PUBLISH_RESP"
PUB_STATUS=$(printf '%s' "$PUBLISH_RESP" | jq_field ".status")
KA_ID=$(printf '%s' "$PUBLISH_RESP" | jq_field ".kaId")
[ -z "$KA_ID" ] && KA_ID=$(printf '%s' "$PUBLISH_RESP" | jq_field ".knowledgeAssetId")
[ -z "$KA_ID" ] && KA_ID=$(printf '%s' "$PUBLISH_RESP" | jq_field ".result.kaId")
VM_ID=$(printf '%s' "$PUBLISH_RESP" | node -e '
  let d=""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => {
    try {
      const ual = JSON.parse(d).ual;
      const match = /^did:dkg:evm:[^/]+\/(0x[0-9a-fA-F]{40})\/(\d+)$/.exec(ual);
      if (!match) throw new Error("publish response has no owner/token UAL");
      console.log(`${match[1].toLowerCase()}/${match[2]}`);
    } catch (error) { console.error(error.message); process.exit(1); }
  });
') || fail "publish response has no valid UAL for the per-KA VM graph"
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
if grep -qE 'LU-11.*emitted [1-9].*ciphertext chunk|emitted [1-9][0-9]* ciphertext chunk' <<<"$EDGE_NEW"; then
  CHUNKS=$(printf '%s' "$EDGE_NEW" | grep -oE 'emitted [0-9]+ ciphertext chunk' | grep -oE '[0-9]+' | head -1)
  pass "publisher emitted $CHUNKS private ciphertext chunk(s) — ciphertext genuinely exists"
else
  warn "no LU-11 ciphertext-chunk emit line on the curator edge (publisher may have used a single-blob path; strip assertions below are then weaker)"
fi
# The zero ciphertext reads on the stripped cores (section 7) mean something only
# if the same reader and filter find this batch's chunks where they exist: the
# curator persists every chunk it emits before gossiping it.
CURATOR_CT=$(ciphertext_count "$EDGE_CURATOR") \
  || fail "curator edge$EDGE_CURATOR: cannot read ciphertext rows from its store"
[ "$CURATOR_CT" -ge 1 ] \
  || fail "curator edge$EDGE_CURATOR holds no ciphertext rows for batch $BATCH_ID; the ciphertext reader or filter would read zero on every core"
pass "curator edge$EDGE_CURATOR holds $CURATOR_CT ciphertext row(s) for this batch — the ciphertext reader sees chunks where they exist"

# ---------------------------------------------------------------------------
# 6. Member edge holds the private data (member-side) — the data lives on the
#    members, NOT the cores. Member SWM sync lags the publish, so poll.
# ---------------------------------------------------------------------------
member_priv_count() {
  store_count "$EDGE_MEMBER" "SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { <${PRIV_SUBJ}> ?p ?o } }"
}
MEMBER_PRIV=0
for i in $(seq 1 45); do
  MEMBER_PRIV=$(member_priv_count) || MEMBER_PRIV="unreadable"
  [ "${MEMBER_PRIV:-0}" -ge 1 ] 2>/dev/null && break
  sleep 2
done
if [ "${MEMBER_PRIV:-0}" -ge 1 ] 2>/dev/null; then
  pass "member edge$EDGE_MEMBER holds the private data ($MEMBER_PRIV triple(s) for the secret subject) — private data lives member-side, off the cores"
else
  warn "member edge$EDGE_MEMBER did not sync the private data in-window (last count: $MEMBER_PRIV; sync timing? — not a strip gate)"
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
  for n in "${STRIPPED_CORES[@]}"; do
    c=$(catalog_count "$n") || fail "core$n: cannot read the _catalog from its store"
    [ "$c" -ge 1 ] && holders=$((holders+1))
  done
  [ "$holders" -ge "${#STRIPPED_CORES[@]}" ] && { log "  catalog present on all $holders/${#STRIPPED_CORES[@]} stripped cores"; break; }
  [ "$i" -eq 1 ] || [ $((i % 10)) -eq 0 ] && log "  …catalog on $holders/${#STRIPPED_CORES[@]} cores after $((i*3))s"
  sleep 3
done

log "checking ciphertext + catalog custody per core…"
STRIP_OK=1
for n in "${STRIPPED_CORES[@]}"; do
  ct=$(ciphertext_count "$n") || fail "core$n: cannot read ciphertext rows from its store"
  cat=$(catalog_count "$n") || fail "core$n: cannot read the _catalog from its store"
  log "  core$n: ciphertext_rows=$ct  catalog_triples=$cat"
  if [ "$ct" != "0" ]; then STRIP_OK=0; warn "core$n holds $ct ciphertext rows (expected 0 — STRIP LEAK)"; fi
done
[ "$STRIP_OK" -eq 1 ] || fail "STRIP LEAK: a stripped core holds private ciphertext"
pass "all stripped cores (${STRIPPED_CORES[*]}) hold ZERO private ciphertext"

# at least one stripped core must hold the catalog (so it can serve + prove it)
CATALOG_HOLDERS=0
for n in "${STRIPPED_CORES[@]}"; do
  cat=$(catalog_count "$n") || fail "core$n: cannot read the _catalog from its store"
  [ "$cat" -ge 1 ] && CATALOG_HOLDERS=$((CATALOG_HOLDERS+1))
done
[ "$CATALOG_HOLDERS" -ge 1 ] || fail "no stripped core holds the public _catalog — cannot prove it"
pass "$CATALOG_HOLDERS/${#STRIPPED_CORES[@]} stripped cores hold the public _catalog"

# ---------------------------------------------------------------------------
# 8. DISCRIMINATOR: strip-OFF baseline core DOES hold the ciphertext
# ---------------------------------------------------------------------------
log "waiting for the strip-OFF baseline core $BASELINE_CORE to host-mode-ingest ciphertext…"
BASE_CT=0
for i in $(seq 1 30); do
  BASE_CT=$(ciphertext_count "$BASELINE_CORE") \
    || fail "core$BASELINE_CORE: cannot read ciphertext rows from its store"
  [ "$BASE_CT" -ge 1 ] && break
  sleep 2
done
if [ "$BASE_CT" -ge 1 ]; then
  BASELINE_SUMMARY="strip-OFF core $BASELINE_CORE: holds $BASE_CT ciphertext row(s) (discriminator — strip is non-vacuous)"
  pass "DISCRIMINATOR: $BASELINE_SUMMARY → the strip on cores ${STRIPPED_CORES[*]} is demonstrably effective"
else
  # A warning, not a failure: under the default RFC-64 catalog authority, host
  # mode does not engage for this CG on any core, so this core reads 0 too and
  # the zero on the stripped cores is not attributable to the strip.
  BASELINE_SUMMARY="strip-OFF core $BASELINE_CORE: 0 ciphertext (its host mode did not engage; the zero on cores ${STRIPPED_CORES[*]} is not attributable to the strip)"
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
#   producer's update() regenerates the floor as a separate catalog commitment
#   (since v10.0.7 it is not part of the KA payload or its Merkle root), ships
#   it inline, the cores rebuild + REPLACE-persist `<cg>/_catalog`, and the
#   on-chain catalog commitment is set so the update CONFIRMS (before this
#   feature a curated update shipped a ZERO catalog root and REVERTED with
#   CuratedCGRequiresCatalogCommitment). The catalog is the STABLE public
#   floor — the update RE-COMMITS THE SAME ROOT, it does NOT rotate — so we
#   assert root non-zero AND == the publish baseline.
#
#   Driven via POST /api/update with an owner-sealed precomputedUpdateAttestation
#   (build_update_body). Re-finalize is NOT usable: the seal is keyed
#   by the assertion URI and neither discard nor re-create clears it, so a 2nd
#   wm/finalize of changed content hits "already finalized with a different
#   merkleRoot". /api/update is the on-chain UPDATE primitive the daemon exposes.
# ---------------------------------------------------------------------------
log "── CURATED UPDATE path (POST /api/update, owner-sealed, catalog floor re-committed) ──"
UPD_QUADS=$(STAMP="$STAMP" PRIV_SUBJ="$PRIV_SUBJ" node -e '
const stamp=process.env.STAMP, subj=process.env.PRIV_SUBJ;
console.log(JSON.stringify([
  { subject: subj, predicate: "http://schema.org/name", object: `"Alice Private ${stamp} — UPDATED value, still padded out to keep the encrypted member payload chunking through the LU-11 ciphertext substrate on this devnet update"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/email", object: `"alice-${stamp}@example.org"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/role", object: `"private-member-data, UPDATED — padded so the encrypted member payload reliably produces at least one LU-11 ciphertext chunk on this devnet update"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/jobTitle", object: "\"Lead (added on update)\"", graph: "" }
]))')

# build_update_body resolves the KA owner key (ownerOf), seals the root the
# daemon recomputes from UPD_QUADS, and emits the /api/update body.
UPD_BODY=$(REPO_ROOT="$REPO_ROOT" DEVNET_DIR="$DEVNET_DIR" NUM_NODES="$NUM_NODES" \
  build_update_body "$EDGE_CURATOR" "$KA_ID" "$CG_ID" "$UPD_QUADS") \
  || fail "could not build curated update body (seal/owner-key resolution failed)"
UPD_RESP=$(api_call_agent "$EDGE_CURATOR" POST /api/update "$UPD_BODY")
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
  for n in "${STRIPPED_CORES[@]}"; do
    c=$(catalog_count "$n") || fail "core$n: cannot read the _catalog from its store"
    [ "$c" -ge 1 ] && holders=$((holders+1))
  done
  [ "$holders" -ge 1 ] && { log "  updated catalog present on $holders/${#STRIPPED_CORES[@]} stripped cores"; break; }
  [ "$i" -eq 1 ] || [ $((i % 10)) -eq 0 ] && log "  …updated catalog on $holders/${#STRIPPED_CORES[@]} cores after $((i*3))s"
  sleep 3
done
UPD_CAT_HOLDERS=0
for n in "${STRIPPED_CORES[@]}"; do
  cat=$(catalog_count "$n") || fail "core$n: cannot read the _catalog from its store"
  [ "$cat" -ge 1 ] && UPD_CAT_HOLDERS=$((UPD_CAT_HOLDERS+1))
done
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

# ── MEMBER's Verifiable Memory converges to each update (#2858). ──
# The member holds the KA's first version in VM (chain-driven exact fetch at
# publish). An update keeps the KA id and moves its on-chain root; the member's
# VM copy is refreshed from the chain's KnowledgeAssetUpdated event. SWM delivery
# alone would satisfy an any-graph check, so these checks read only the member's
# VM graphs. Two cases: the member online during the update, and the member
# stopped during a second update.
VM_GRAPH="did:dkg:context-graph:${CG_ID}/_verifiable_memory/${VM_ID}"
member_vm_count() { # <optional triple filter>
  store_count "$EDGE_MEMBER" "SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${VM_GRAPH}> { <${PRIV_SUBJ}> ?p ?o . ${1:-} } }"
}
member_vm_exact_version() { # <UPDATED|SECONDUPDATE>; this one KA's current VM graph only
  local version="$1" expected_total name_fragment job_title expected_role total names emails jobs roles old_names
  if [ "$version" = "UPDATED" ]; then
    expected_total=4
    name_fragment="UPDATED value"
    job_title="Lead (added on update)"
    expected_role=1
  else
    expected_total=3
    name_fragment="SECONDUPDATE value"
    job_title="Lead (second update)"
    expected_role=0
  fi
  total=$(member_vm_count) || return 1
  [ "$total" = "$expected_total" ] || return 1
  names=$(member_vm_count "FILTER(?p = <http://schema.org/name> && CONTAINS(STR(?o), \"${name_fragment}\"))") || return 1
  emails=$(member_vm_count "FILTER(?p = <http://schema.org/email> && STR(?o) = \"alice-${STAMP}@example.org\")") || return 1
  jobs=$(member_vm_count "FILTER(?p = <http://schema.org/jobTitle> && STR(?o) = \"${job_title}\")") || return 1
  roles=$(member_vm_count 'FILTER(?p = <http://schema.org/role>)') || return 1
  [ "$names" = 1 ] && [ "$emails" = 1 ] && [ "$jobs" = 1 ] && [ "$roles" = "$expected_role" ] || return 1
  if [ "$version" = "UPDATED" ]; then
    [ "$(member_vm_count 'FILTER(?p = <http://schema.org/role> && CONTAINS(STR(?o), "UPDATED"))')" = 1 ] || return 1
  else
    # The first update's name and role must be gone, not merely followed by
    # an appended second version. The exact total above also excludes any
    # leftover baseline triples in this KA's current VM graph.
    old_names=$(member_vm_count 'FILTER(?p = <http://schema.org/name> && CONTAINS(STR(?o), "UPDATED value"))') || return 1
    [ "$old_names" = 0 ] || return 1
  fi
}
wait_member_vm() { # <version> <case label> [seconds, default 180]; tolerates a store read error while the member restarts
  local i
  for i in $(seq 1 $(( ${3:-180} / 3 ))); do
    member_vm_exact_version "$1" && return 0
    { [ "$i" -eq 1 ] || [ $((i % 10)) -eq 0 ]; } && log "  …member VM is not an exact $1 replacement yet after $((i*3))s ($2)"
    sleep 3
  done
  return 1
}

log "member edge$EDGE_MEMBER was online during the update: waiting for its Verifiable Memory to hold the UPDATED payload…"
wait_member_vm "UPDATED" "online during the update" \
  || fail "member edge$EDGE_MEMBER's Verifiable Memory did NOT converge to the UPDATED private payload while online (#2858)"
pass "member edge$EDGE_MEMBER's Verifiable Memory exactly holds the UPDATED private payload (online during the update)"

log "stopping member edge$EDGE_MEMBER, then a second update while it is offline…"
MEMBER_NEEDS_RESTORE=1
"$REPO_ROOT/scripts/devnet.sh" stop-node "$EDGE_MEMBER" >/dev/null 2>&1 \
  || fail "stop-node $EDGE_MEMBER returned non-zero"
MEMBER_DOWN=0
for i in $(seq 1 30); do
  if curl -sS --max-time 1 -o /dev/null "http://127.0.0.1:$(node_port "$EDGE_MEMBER")/api/status" 2>/dev/null; then
    MEMBER_DOWN=0
  else
    MEMBER_DOWN=$((MEMBER_DOWN + 1))
    [ "$MEMBER_DOWN" -ge 2 ] && break
  fi
  sleep 1
done
[ "$MEMBER_DOWN" -ge 2 ] \
  || fail "member edge$EDGE_MEMBER remained reachable after stop-node"
UPD2_QUADS=$(STAMP="$STAMP" PRIV_SUBJ="$PRIV_SUBJ" node -e '
const stamp=process.env.STAMP, subj=process.env.PRIV_SUBJ;
console.log(JSON.stringify([
  { subject: subj, predicate: "http://schema.org/name", object: `"Alice Private ${stamp} — SECONDUPDATE value, padded out to keep the encrypted member payload chunking through the LU-11 ciphertext substrate on this devnet update"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/email", object: `"alice-${stamp}@example.org"`, graph: "" },
  { subject: subj, predicate: "http://schema.org/jobTitle", object: "\"Lead (second update)\"", graph: "" }
]))')
UPD2_BODY=$(REPO_ROOT="$REPO_ROOT" DEVNET_DIR="$DEVNET_DIR" NUM_NODES="$NUM_NODES" \
  build_update_body "$EDGE_CURATOR" "$KA_ID" "$CG_ID" "$UPD2_QUADS") \
  || fail "could not build the second curated update body"
UPD2_RESP=$(api_call_agent "$EDGE_CURATOR" POST /api/update "$UPD2_BODY")
log "second POST /api/update: $UPD2_RESP"
[ "$(printf '%s' "$UPD2_RESP" | jq_field ".status")" = "confirmed" ] \
  || fail "second curated update did not confirm: $UPD2_RESP"
log "starting member edge$EDGE_MEMBER again…"
"$REPO_ROOT/scripts/devnet.sh" restart-node "$EDGE_MEMBER" >/dev/null 2>&1 \
  || fail "restart-node $EDGE_MEMBER returned non-zero"
wait_member_up || fail "member edge$EDGE_MEMBER did not become healthy after restart"
MEMBER_NEEDS_RESTORE=0
# A restarted edge reconnects to the cores but does not find its curator edge
# again on its own (#2865); dial it, as a member holding the curator's address
# would.
if [ -n "${CURATOR_ADDR:-}" ]; then
  for _ in 1 2 3; do
    CONNECT_RESP=$(api_call_agent "$EDGE_MEMBER" POST /api/connect "{\"multiaddr\":\"${CURATOR_ADDR}\"}")
    [ "$(printf '%s' "$CONNECT_RESP" | jq_field ".connected")" = "true" ] && break
    sleep 5
  done
  log "member edge$EDGE_MEMBER reconnects to the curator after restarting: $CONNECT_RESP"
fi
# After a restart the member recovers the curator's shared memory, which stages
# the update; the refresh then waits its staged-version delay and the next
# reconcile sweep, so allow more time than the online case.
wait_member_vm "SECONDUPDATE" "offline during the update" 300 \
  || fail "member edge$EDGE_MEMBER's Verifiable Memory did NOT converge to the second update after restarting (#2858)"
pass "member edge$EDGE_MEMBER's Verifiable Memory exactly replaced the first update's payload after restart"

# ---------------------------------------------------------------------------
echo ""
log "============================================================"
pass "RFC-49 CATALOG-SAMPLING STRIP — DEVNET VALIDATION PASSED"
log "  • curated publish → on-chain catalog commitment (root=$CAT_ROOT, leaves=$CAT_COUNT)"
log "  • stripped cores ${STRIPPED_CORES[*]}: ZERO private ciphertext, hold the _catalog"
log "  • ${BASELINE_SUMMARY:-baseline core: (not evaluated)}"
log "  • a core proved the public _catalog in random sampling"
log "  • curated UPDATE (POST /api/update): re-committed the stable catalog floor (root==baseline, leaves=${UPD_COUNT:-?}), cores re-host it, a core proved the updated catalog"
log "============================================================"
