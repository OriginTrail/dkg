#!/usr/bin/env bash
#
# SWM late-joiner sub-graph backfill — devnet regression for PR #885.
#
# Reproduces the gap that motivated PR #885 against a freshly built local
# devnet and asserts both fixes:
#
#   Gap 2 (sub-graph blind spot in sync responder)
#     Pre-PR-885 the workspace branch only queried the CG-root SWM
#     graph. Anything published into a sub-graph
#     (`<cgPrefix>/<sub>/_shared_memory`) was invisible to a sync
#     requester. A late joiner who joined AFTER the curator wrote
#     into a sub-graph received `sharedMemory=0` and an empty SPARQL
#     count for that sub-graph. After the fix, both root + sub-graph
#     SWM flow through.
#
#   Gap 1 (approve-time `_meta` race against SWM gossip subscribe)
#     Pre-PR-885 the `join-approved` handler called
#     `subscribeToContextGraph` synchronously, which queued an SWM
#     gossip subscribe whose `canReadContextGraph` check ran against
#     a not-yet-synced local `_meta` and emitted a misleading
#     `SWM gossip subscription denied for "<cg>": local node is not
#     authorized` warning before `refreshMetaSyncedFlags` self-healed
#     it. After the fix the SWM gossip subscribe is deferred until
#     `_meta` lands; no spurious WARN.
#
# Scenario:
#   • CURATOR (N5) creates curated CG with allowlist=[CURATOR] only.
#     The late joiner is NOT in the initial allowlist — it joins
#     later via signed `requestJoin → approveJoin`, exactly the
#     flow that triggered the gap on the live testnet.
#   • CURATOR creates a sub-graph `ai-tools` and publishes 5 SWM
#     triples into it. CURATOR also publishes 3 SWM triples into the
#     CG-root SWM as a control set (so the test fails distinguishably
#     when only one of the two graphs flows back).
#   • LATE_JOINER (N1) signs a join delegation, sends `request-join`
#     to CURATOR, CURATOR approves.
#   • Wait for the post-approval sync to settle.
#   • LATE_JOINER SPARQLs the CG it just joined:
#       - sub-graph `ai-tools` SWM count → MUST be 5
#       - root SWM count                  → MUST be 3
#       - total                           → MUST be 8
#   • LATE_JOINER daemon log MUST NOT contain a `SWM gossip
#     subscription denied for "<cg>": local node is not authorized`
#     line for this specific CG — confirms Gap 1 self-heal lands
#     before the misleading WARN ever fires.
#
# Talks ONLY to the daemon HTTP API. Re-runnable: every CG id is
# timestamp-suffixed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CURATOR_NODE="${CURATOR_NODE:-5}"
LATE_JOINER_NODE="${LATE_JOINER_NODE:-1}"
SUB_GRAPH_NAME="${SUB_GRAPH_NAME:-ai-tools}"
SUB_GRAPH_TRIPLES="${SUB_GRAPH_TRIPLES:-5}"
ROOT_TRIPLES="${ROOT_TRIPLES:-3}"
POST_APPROVAL_WAIT_S="${POST_APPROVAL_WAIT_S:-10}"

log()  { echo "[swm-lj-sg] $*"; }
warn() { echo "[swm-lj-sg] WARN: $*" >&2; }
fail() { echo "[swm-lj-sg] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[swm-lj-sg] === $1 ==="; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }
node_log()    { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 60 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
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

# Bare numeric value out of a SPARQL bindings response. Matches the
# helper used by the existing rfc38-late-joiner script so behaviour
# stays consistent across the suite.
sparql_count() {
  printf '%s' "$1" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try {
        const j = JSON.parse(d);
        const b = (j && j.result && j.result.bindings && j.result.bindings[0]) || {};
        const raw = b.n || b.cnt || b.count || "";
        const m = String(raw).match(/^"?(-?\d+)"?/);
        console.log(m ? m[1] : "");
      } catch { console.log(""); }
    });
  '
}

build_swm_payload() {
  local cg_id="$1" n="$2" label="$3" sub_graph="${4:-}"
  CG_ID="$cg_id" N="$n" LABEL="$label" SUB="$sub_graph" node -e '
    const cgId = process.env.CG_ID;
    const n = parseInt(process.env.N, 10);
    const label = process.env.LABEL;
    const sub = process.env.SUB || "";
    const quads = [];
    for (let i = 0; i < n; i++) {
      quads.push({
        subject: "urn:swm-lj-sg:" + label + ":e" + i,
        predicate: "http://schema.org/name",
        object: "\"value-" + label + "-" + i + "\"",
        graph: "did:dkg:context-graph:" + cgId,
      });
    }
    const out = { contextGraphId: cgId, quads };
    if (sub) out.subGraphName = sub;
    console.log(JSON.stringify(out));
  '
}

CURATOR_IDENTITY=$(api_call "$CURATOR_NODE" GET /api/agent/identity)
CURATOR_AGENT=$(printf '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
CURATOR_PEER=$(printf  '%s' "$CURATOR_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
LATE_JOINER_IDENTITY=$(api_call "$LATE_JOINER_NODE" GET /api/agent/identity)
LATE_JOINER_AGENT=$(printf '%s' "$LATE_JOINER_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
LATE_JOINER_PEER=$(printf  '%s' "$LATE_JOINER_IDENTITY" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')

log "Curator:     $CURATOR_AGENT (node $CURATOR_NODE, peer=$CURATOR_PEER)"
log "Late joiner: $LATE_JOINER_AGENT (node $LATE_JOINER_NODE, peer=$LATE_JOINER_PEER)"

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/swm-lj-sg-${STAMP}"

# ===========================================================================
act "STEP 1: curator creates CG with allowlist=[curator] only (late joiner NOT pre-allowlisted)"
# ===========================================================================
CR=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "swm-lj-sg ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT"],
  "register": true }
EOF
)")
ON_CHAIN=$(parse_json "$CR" '.onChainId')
[ -n "$ON_CHAIN" ] || fail "curator CG create failed: $CR"
log "✓ created curated CG: onChainId=$ON_CHAIN"

# ===========================================================================
act "STEP 2: curator creates sub-graph \"$SUB_GRAPH_NAME\""
# ===========================================================================
SG_RESP=$(api_call "$CURATOR_NODE" POST /api/sub-graph/create "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "subGraphName": "$SUB_GRAPH_NAME" }
EOF
)")
SG_CREATED=$(parse_json "$SG_RESP" '.created')
[ "$SG_CREATED" = "$SUB_GRAPH_NAME" ] || fail "sub-graph create failed: $SG_RESP"
log "✓ sub-graph \"$SUB_GRAPH_NAME\" created"

# ===========================================================================
act "STEP 3: curator publishes $SUB_GRAPH_TRIPLES SWM triples into sub-graph + $ROOT_TRIPLES into root"
# ===========================================================================
SUB_PAYLOAD=$(build_swm_payload "$CG_ID" "$SUB_GRAPH_TRIPLES" "sub" "$SUB_GRAPH_NAME")
WROTE_SUB=$(devnet_create_shared_ka "$CURATOR_NODE" "$SUB_PAYLOAD")
TRIPLES_WROTE_SUB=$(parse_json "$WROTE_SUB" '.triplesWritten')
[ "$TRIPLES_WROTE_SUB" = "$SUB_GRAPH_TRIPLES" ] \
  || fail "expected $SUB_GRAPH_TRIPLES sub-graph triplesWritten, got '$TRIPLES_WROTE_SUB' (response: $WROTE_SUB)"
log "✓ wrote $SUB_GRAPH_TRIPLES SWM triples into sub-graph \"$SUB_GRAPH_NAME\""

ROOT_PAYLOAD=$(build_swm_payload "$CG_ID" "$ROOT_TRIPLES" "root" "")
WROTE_ROOT=$(devnet_create_shared_ka "$CURATOR_NODE" "$ROOT_PAYLOAD")
TRIPLES_WROTE_ROOT=$(parse_json "$WROTE_ROOT" '.triplesWritten')
[ "$TRIPLES_WROTE_ROOT" = "$ROOT_TRIPLES" ] \
  || fail "expected $ROOT_TRIPLES root triplesWritten, got '$TRIPLES_WROTE_ROOT' (response: $WROTE_ROOT)"
log "✓ wrote $ROOT_TRIPLES SWM triples into CG root"

# Sanity-check the curator can see what it just wrote (proves the
# fixtures are real, not just write-side ACKs).
QC_SUB=$(api_call "$CURATOR_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "subGraphName": "$SUB_GRAPH_NAME", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
NC_SUB=$(sparql_count "$QC_SUB")
[ "$NC_SUB" = "$SUB_GRAPH_TRIPLES" ] \
  || fail "curator's own sub-graph SWM count was '$NC_SUB', expected $SUB_GRAPH_TRIPLES"
QC_ROOT=$(api_call "$CURATOR_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
NC_ROOT=$(sparql_count "$QC_ROOT")
[ "$NC_ROOT" = "$ROOT_TRIPLES" ] \
  || fail "curator's own root SWM count was '$NC_ROOT', expected $ROOT_TRIPLES"
log "✓ curator can locally see sub-graph=$NC_SUB + root=$NC_ROOT"

# ===========================================================================
act "STEP 4: late joiner signs a join delegation"
# ===========================================================================
SIGN_RESP=$(api_call "$LATE_JOINER_NODE" POST "/api/context-graph/$(printf '%s' "$CG_ID" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(encodeURIComponent(d)))')/sign-join" "{}")
SIGN_OK=$(parse_json "$SIGN_RESP" '.ok')
[ "$SIGN_OK" = "true" ] || fail "sign-join failed: $SIGN_RESP"
DELEGATION_JSON=$(printf '%s' "$SIGN_RESP" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(d).delegation)))')
log "✓ late joiner signed delegation (agent=$LATE_JOINER_AGENT)"

# ===========================================================================
act "STEP 5: late joiner sends request-join to curator (peer=$CURATOR_PEER)"
# ===========================================================================
REQ_BODY=$(DELEGATION="$DELEGATION_JSON" CURATOR_PEER="$CURATOR_PEER" node -e '
  const out = {
    delegation: JSON.parse(process.env.DELEGATION),
    curatorPeerId: process.env.CURATOR_PEER,
    agentName: "swm-lj-sg-test",
  };
  console.log(JSON.stringify(out));
')
REQ_RESP=$(api_call "$LATE_JOINER_NODE" POST "/api/context-graph/$(printf '%s' "$CG_ID" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(encodeURIComponent(d)))')/request-join" "$REQ_BODY")
REQ_STATUS=$(parse_json "$REQ_RESP" '.status')
[ "$REQ_STATUS" = "pending" ] \
  || fail "request-join expected status=pending, got '$REQ_STATUS' (response: $REQ_RESP)"
log "✓ join request delivered to curator"

# Curator processes the inbound delegation asynchronously; give it a
# moment to land in the pending queue before approving.
sleep 2

# ===========================================================================
act "STEP 6: curator approves the join"
# ===========================================================================
APPROVE_RESP=$(api_call "$CURATOR_NODE" POST "/api/context-graph/$(printf '%s' "$CG_ID" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(encodeURIComponent(d)))')/approve-join" "$(cat <<EOF
{ "agentAddress": "$LATE_JOINER_AGENT" }
EOF
)")
APPROVE_STATUS=$(parse_json "$APPROVE_RESP" '.status')
[ "$APPROVE_STATUS" = "approved" ] \
  || fail "approve-join expected status=approved, got '$APPROVE_STATUS' (response: $APPROVE_RESP)"
log "✓ curator approved late joiner"

# ===========================================================================
act "STEP 7: wait ${POST_APPROVAL_WAIT_S}s for join-approved notification + post-approval sync to settle"
# ===========================================================================
log "  (approve-join → notifyJoinApproval → late joiner runImmediatePostApprovalSync → catchup)"
sleep "$POST_APPROVAL_WAIT_S"

# ===========================================================================
act "STEP 8: late joiner queries SWM — sub-graph + root MUST both be present"
# ===========================================================================
Q_SUB=$(api_call "$LATE_JOINER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "subGraphName": "$SUB_GRAPH_NAME", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
N_SUB=$(sparql_count "$Q_SUB")
log "  late joiner sub-graph \"$SUB_GRAPH_NAME\" SWM count: $N_SUB (expect $SUB_GRAPH_TRIPLES)"

Q_ROOT=$(api_call "$LATE_JOINER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
N_ROOT=$(sparql_count "$Q_ROOT")
log "  late joiner root SWM count: $N_ROOT (expect $ROOT_TRIPLES)"

# Surface both numbers up-front so a failure run shows the full
# picture (e.g. sub=0 + root=3 is the EXACT pre-fix signature; sub=5
# + root=3 is the post-fix signature; sub=0 + root=0 means the join
# flow itself broke).
if [ "$N_ROOT" != "$ROOT_TRIPLES" ]; then
  fail "late joiner root SWM count was '$N_ROOT', expected $ROOT_TRIPLES (root SWM backfill is the BASELINE — if this fails, the join/catchup flow itself broke, not gap 2)"
fi
if [ "$N_SUB" != "$SUB_GRAPH_TRIPLES" ]; then
  fail "late joiner sub-graph SWM count was '$N_SUB', expected $SUB_GRAPH_TRIPLES (this is the EXACT gap 2 regression signature — root flowed but sub-graph did not, because the sync responder's SPARQL only matched the root SWM URI). PR #885's sync-handler.ts patch is missing or broken."
fi
log "✓ STEP 8: late joiner sees sub-graph=$N_SUB AND root=$N_ROOT — gap 2 closed"

# ===========================================================================
act "STEP 9: late joiner daemon log MUST NOT contain the gap-1 misleading WARN for this CG"
# ===========================================================================
LATE_LOG=$(node_log "$LATE_JOINER_NODE")
if [ ! -f "$LATE_LOG" ]; then
  warn "late joiner log file not found at $LATE_LOG — skipping gap 1 assertion"
else
  # The exact text emitted by `reconcileSharedMemoryGossipSubscription`
  # at the point that PR #885 closes. Anchored to the CG_ID so we
  # don't false-positive on unrelated CGs that happened to be
  # exercised by the same daemon during this run. `grep ... || true`
  # because grep exits 1 when there are zero matches — which is the
  # success case for this assertion, not an error.
  DENIED_HITS=$(grep -F "SWM gossip subscription denied for \"$CG_ID\": local node is not authorized" "$LATE_LOG" 2>/dev/null | wc -l | tr -d '[:space:]' || true)
  : "${DENIED_HITS:=0}"
  if [ "$DENIED_HITS" != "0" ]; then
    fail "gap 1 regression: late joiner emitted $DENIED_HITS 'SWM gossip subscription denied for \"$CG_ID\"' line(s). PR #885's deferSharedMemoryGossipSubscribe path is missing or broken. (Without the fix the count is reliably ≥1.)"
  fi
  log "✓ STEP 9: zero spurious 'SWM gossip subscription denied' lines for this CG — gap 1 closed"
fi

echo ""
log "============================================================"
log "PASS: SWM late-joiner sub-graph backfill works end-to-end."
log "  Gap 2 (sub-graph blind spot in sync responder)  — closed."
log "  Gap 1 (approve-time _meta race for SWM gossip)  — closed."
log "  CG: $CG_ID"
log "  triples: sub-graph=$N_SUB, root=$N_ROOT"
log "============================================================"
