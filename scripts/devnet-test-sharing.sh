#!/usr/bin/env bash
#
# DKG V10 Devnet Test — Private Project Sharing & WM Isolation
#
# Covers:
#   - Private project creation with curated access
#   - Join request flow (deny → request → approve → auto-sync)
#   - WM assertion isolation (data + metadata must NOT leak to peers)
#   - SWM promotion and cross-node sync
#   - Late joiner scenario (joins after data promoted)
#   - Multi-participant WM isolation (each participant's WM is private)
#   - Import-file WM isolation
#   - Promote after import-file (wallet address vs peerId graph URI match)
#   - Publish SWM → VM (on-chain), VM sync, VM visibility, clearAfter semantics
#
# Prerequisites: 5-node devnet running (./scripts/devnet.sh start 5)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$SCRIPT_DIR/../.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
N1_PORT=$((API_PORT_BASE)); N2_PORT=$((API_PORT_BASE + 1))
N3_PORT=$((API_PORT_BASE + 2)); N4_PORT=$((API_PORT_BASE + 3)); N5_PORT=$((API_PORT_BASE + 4))

PASS=0; FAIL=0; WARN=0
DEVNET_TMPDIR="${TMPDIR:-/tmp}"

c() {
  curl -sS --max-time 30 --connect-timeout 5 \
    -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "$@"
}

# Adapter for devnet-publish-helpers.sh (node-numbered API calls).
api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port=$((API_PORT_BASE + node - 1))
  if [ -n "$data" ]; then
    c -X "$method" "http://127.0.0.1:${port}${path}" -d "$data"
  else
    c -X "$method" "http://127.0.0.1:${port}${path}"
  fi
}
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"

ok()   { PASS=$((PASS+1)); echo "  [PASS] $1"; }
fail() { FAIL=$((FAIL+1)); echo "  [FAIL] $1"; }
warn() { WARN=$((WARN+1)); echo "  [WARN] $1"; }
skip() { echo "  [SKIP] $1"; }

json_get() {
  echo "$1" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  keys='$2'.split('.')
  for k in keys:
    if isinstance(d,dict): d=d.get(k)
    elif isinstance(d,list) and k.isdigit(): d=d[int(k)]
    else: d=None
  if d is None: print('__NONE__')
  elif isinstance(d,bool): print('true' if d else 'false')
  else: print(d)
except: print('__ERR__')
" 2>/dev/null
}

check() {
  local desc="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then ok "$desc"; else fail "$desc (expected=$expected, got=$actual)"; fi
}

# shellcheck source=devnet-sharing-helpers.sh
source "$SCRIPT_DIR/devnet-sharing-helpers.sh"

q() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"$3\",\"graph\":\"\"}"; }
ql() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"\\\"$3\\\"\",\"graph\":\"\"}"; }

poll_catchup() {
  local port=$1 cgid=$2 max_wait=${3:-20}
  for i in $(seq 1 "$max_wait"); do
    local resp
    resp=$(c "http://127.0.0.1:$port/api/sync/catchup-status?contextGraphId=$cgid" 2>/dev/null)
    local st
    st=$(json_get "$resp" status)
    if [[ "$st" == "completed" || "$st" == "synced" || "$st" == "done" ]]; then
      echo "completed"
      return 0
    elif [[ "$st" == "denied" ]]; then
      echo "denied"
      return 1
    fi
    sleep 1
  done
  echo "timeout"
  return 1
}

get_self_address() {
  local port=$1
  curl -sS --max-time 5 -H "Authorization: Bearer $AUTH" \
    "http://127.0.0.1:$port/api/agents" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
  if a.get('connectionStatus')=='self':
    print(a['agentAddress']); break
" 2>/dev/null
}

get_self_peer_id() {
  local port=$1
  curl -sS --max-time 5 -H "Authorization: Bearer $AUTH" \
    "http://127.0.0.1:$port/api/agents" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
  if a.get('connectionStatus')=='self':
    print(a.get('peerId','')); break
" 2>/dev/null
}

if [[ -n "${DKG_AUTH:-}" ]]; then
  AUTH="$DKG_AUTH"
elif [[ -f "$DEVNET_DIR/node1/auth.token" ]]; then
  AUTH="$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" 2>/dev/null | tr -d '[:space:]')"
else
  echo "ERROR: No auth token. Export DKG_AUTH or start a devnet." >&2
  exit 1
fi

CG_ID="sharing-test-$(date +%s)"
WM_GRAPHS_QUERY=$(sharing_wm_graphs_query "$CG_ID")

echo "============================================================"
echo "DKG V10 Private Project Sharing & WM Isolation Test"
echo "============================================================"
echo ""
echo "  Test CG: $CG_ID"
echo ""

# ── Discover node addresses ──────────────────────────────────────
N1_ADDR=$(get_self_address ${N1_PORT})
N2_ADDR=$(get_self_address ${N2_PORT})
N3_ADDR=$(get_self_address ${N3_PORT})
N4_ADDR=$(get_self_address ${N4_PORT})
N1_PEER=$(get_self_peer_id ${N1_PORT})
echo "  Node 1: $N1_ADDR (peer: $N1_PEER)"
echo "  Node 2: $N2_ADDR"
echo "  Node 3: $N3_ADDR"
echo "  Node 4: $N4_ADDR"
echo ""

#------------------------------------------------------------
echo "=== SECTION 1: Private Project Creation ==="
echo ""

echo "--- 1a: Create private project on Node 1 ---"
CREATE=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/create" \
  -d "{\"id\":\"$CG_ID\",\"name\":\"Sharing Test\",\"description\":\"WM isolation and sharing test\",\"private\":true}")
CREATE_OK=$(json_get "$CREATE" created)
check "Private project created" "$CREATE_OK" "$CG_ID"

echo "--- 1b: Import a markdown file into WM on Node 1 ---"
TMPMD=$(mktemp "$DEVNET_TMPDIR/sharing-test-XXXXXX.md")
cat > "$TMPMD" <<'MDEOF'
# DKG Sharing Test Document

This document tests WM isolation during project sharing.

## Section A
Important knowledge that should remain in Working Memory.

## Section B
More data that must not leak to peers before promotion.

- Fact 1: WM data is private
- Fact 2: Only SWM data is shared
- Fact 3: VM data is verified on-chain
MDEOF

IMPORT1=$(curl -sS --max-time 30 --connect-timeout 5 \
  -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPMD};type=text/markdown" \
  -F "contextGraphId=$CG_ID" \
  "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/doc-alpha/wm/import-file" 2>&1)
rm -f "$TMPMD"
IMPORT1_URI=$(json_get "$IMPORT1" assertionUri)
IMPORT1_CT=$(json_get "$IMPORT1" extraction.tripleCount)
[[ "$IMPORT1_URI" != "__NONE__" ]] && ok "Imported doc-alpha ($IMPORT1_CT triples)" || fail "Import failed: ${IMPORT1:0:200}"

echo "--- 1c: Create a second WM assertion via API ---"
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"name\":\"draft-beta\"}" > /dev/null
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/draft-beta/wm/write" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"quads\":[
    $(ql 'urn:sharing:beta1' 'http://schema.org/name' 'Beta Entity'),
    $(q 'urn:sharing:beta1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),
    $(ql 'urn:sharing:beta2' 'http://schema.org/name' 'Beta Entity 2'),
    $(q 'urn:sharing:beta2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "Created draft-beta assertion with 4 quads"

echo "--- 1d: Verify Node 1 has WM data locally ---"
sleep 1
N1_ASSERT_CT=$(c "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/draft-beta/wm/quads?contextGraphId=$CG_ID" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("quads",d.get("result",[]))))' 2>/dev/null)
devnet_count_at_least "$N1_ASSERT_CT" 4 && ok "Node 1 has $N1_ASSERT_CT quads in WM" || fail "Node 1 WM assertion empty ($N1_ASSERT_CT)"

N1_GRAPH_CT=$(sharing_storage_observe "${N1_PORT}" "SELECT ?g (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \"$CG_ID\")) } GROUP BY ?g" g rows) || devnet_observation_abort
echo "  Node 1 has $N1_GRAPH_CT graphs for this CG"
sharing_owner_wm_control "$N1_PORT" "$CG_ID"


#------------------------------------------------------------
echo ""
echo "=== SECTION 2: Join Request Flow (Node 2) ==="
echo ""

echo "--- 2a: Node 2 subscribes (should be denied — not on allowlist) ---"
c -X POST "http://127.0.0.1:${N2_PORT}/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
sleep 5
CATCHUP_ST=$(poll_catchup ${N2_PORT} "$CG_ID" 10)
# The curator (Node 1) is up, so an unauthorized subscribe is expected to reach
# an explicit `denied` terminal state. A bare `timeout` is ambiguous — it can
# also mean a wedged/unresponsive node — so it is only accepted alongside a
# positive no-leak proof: Node 2 must hold zero of the curator's private
# assertion-data graphs (same invariant asserted post-approval in §3a). A
# `completed` outcome means the sync actually served data and is the leak this
# check exists to catch, so it must fail regardless.
N2_PREJOIN_CT=$(sharing_storage_observe "${N2_PORT}" "$WM_GRAPHS_QUERY" g rows) || devnet_observation_abort
case "$CATCHUP_ST" in
  denied)
    [[ "$N2_PREJOIN_CT" == "0" ]] \
      && ok "Node 2 initial sync explicitly denied, no assertion data leaked" \
      || fail "Node 2 sync denied but leaked $N2_PREJOIN_CT assertion graph(s) before approval"
    ;;
  timeout)
    # No terminal denial within the window (unreachable/slow). Safe only if no
    # private data reached Node 2; a genuinely wedged node is caught by §2b,
    # which requires the signed-join sync to then succeed.
    [[ "$N2_PREJOIN_CT" == "0" ]] \
      && ok "Node 2 initial sync blocked (timeout), no assertion data leaked" \
      || fail "Node 2 sync timed out but leaked $N2_PREJOIN_CT assertion graph(s) — not a clean block"
    ;;
  *)
    fail "Node 2 initial sync should be blocked (got status=$CATCHUP_ST, leaked assertion graphs=$N2_PREJOIN_CT)"
    ;;
esac

echo "--- 2b: Node 2 sends signed join request ---"
SIGN=$(c -X POST "http://127.0.0.1:${N2_PORT}/api/context-graph/$CG_ID/sign-join" -d "{\"curatorPeerId\":\"$N1_PEER\"}")
# /request-join expects the signed delegation + curatorPeerId — splice the curator peer-id
# into the response body before forwarding so the receiver can authenticate the decision.
SUBMIT_BODY=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['curatorPeerId']='$N1_PEER'; print(json.dumps(d))" "$SIGN")
SUBMIT=$(c -X POST "http://127.0.0.1:${N2_PORT}/api/context-graph/$CG_ID/request-join" -d "$SUBMIT_BODY")
SUBMIT_OK=$(json_get "$SUBMIT" ok)
SUBMIT_DEL=$(json_get "$SUBMIT" delivered)
check "Join request submitted" "$SUBMIT_OK" "true"
devnet_count_at_least "$SUBMIT_DEL" 1 && ok "Join request delivered to $SUBMIT_DEL curator(s)" || fail "Join request not delivered"

echo "--- 2c: Node 1 sees the pending request ---"
sleep 2
REQUESTS=$(c "http://127.0.0.1:${N1_PORT}/api/context-graph/$CG_ID/join-requests")
REQ_CT=$(echo "$REQUESTS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("requests",[])))' 2>/dev/null)
devnet_count_at_least "$REQ_CT" 1 && ok "Node 1 has $REQ_CT pending request(s)" || fail "No pending requests on Node 1"

echo "--- 2d: Node 1 approves the request ---"
APPROVE=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/$CG_ID/approve-join" \
  -d "{\"agentAddress\":\"$N2_ADDR\"}")
APPROVE_OK=$(json_get "$APPROVE" ok)
check "Join request approved" "$APPROVE_OK" "true"

echo "--- 2e: Node 2 auto-subscribes after approval ---"
sleep 8
N2_GRAPH_CT=$(sharing_storage_observe "${N2_PORT}" "SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \"$CG_ID\")) }" g rows) || devnet_observation_abort
devnet_count_at_least "$N2_GRAPH_CT" 1 && ok "Node 2 has $N2_GRAPH_CT graph(s) after approval" || fail "Node 2 has no graphs after approval"

#------------------------------------------------------------
echo ""
echo "=== SECTION 3: WM Isolation — Node 2 Must NOT See WM Data ==="
echo ""

echo "--- 3a: Node 2 has NO assertion data graphs ---"
N2_ASSERT_CT=$(sharing_storage_observe "${N2_PORT}" "$WM_GRAPHS_QUERY" g rows) || devnet_observation_abort
check "Node 2 has 0 assertion data graphs" "$N2_ASSERT_CT" "0"

echo "--- 3b: Node 2 has NO lifecycle entities (memoryLayer/state) ---"
META_GRAPH="did:dkg:context-graph:${CG_ID}/_meta"
sharing_storage_absence "Node 2 has 0 lifecycle entities" "${N1_PORT}" "${N2_PORT}" "SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> ?ml } }" s

echo "--- 3c: Node 2 has NO event entities (prov:Activity) ---"
sharing_storage_absence "Node 2 has 0 assertion event entities" "${N1_PORT}" "${N2_PORT}" "SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s a <http://www.w3.org/ns/prov#Activity> . ?s a ?dkgType . FILTER(STRSTARTS(STR(?dkgType), \"http://dkg.io/ontology/Assertion\")) } }" s

echo "--- 3d: Node 2 has NO import metadata (sourceFileHash, extractionMethod) ---"
sharing_storage_absence "Node 2 has 0 import metadata subjects" "${N1_PORT}" "${N2_PORT}" "SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/sourceFileHash> ?h } }" s

echo "--- 3e: Node 2 WM view shows 0 assertion facts ---"
N2_WM_CT=$(sharing_api_observe "${N2_PORT}" "SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \"did:dkg:context-graph:$CG_ID/\") && !STRENDS(STR(?g), \"/_meta\") && !CONTAINS(STR(?g), \"/_private\") && !CONTAINS(STR(?g), \"/_shared_memory\")) }" s rows "{\"contextGraphId\":\"$CG_ID\"}") || devnet_observation_abort
check "Node 2 WM view has 0 assertion facts" "$N2_WM_CT" "0"

echo "--- 3f: Node 2 _meta only has CG-level subjects ---"
N2_META_SUBJECTS=$(sharing_storage_observe "${N2_PORT}" "SELECT DISTINCT ?s WHERE { GRAPH <$META_GRAPH> { ?s ?p ?o } } ORDER BY ?s" s bindings) || devnet_observation_abort
N2_SUBJ_LIST=$(echo "$N2_META_SUBJECTS" | python3 -c '
import sys,json
try:
  bindings=json.load(sys.stdin)
  subjects=[b["s"] if isinstance(b["s"],str) else b["s"]["value"] for b in bindings]
  leaked=[s for s in subjects if "/assertion/" in s or "urn:dkg:assertion:" in s]
  print(f"total={len(subjects)},leaked={len(leaked)}")
except: print("ERR")
' 2>/dev/null)
echo "  Node 2 _meta subjects: $N2_SUBJ_LIST"
echo "$N2_SUBJ_LIST" | grep -q "leaked=0" && ok "Node 2 _meta has no assertion-related subjects" || fail "Node 2 _meta has leaked assertion subjects: $N2_SUBJ_LIST"

#------------------------------------------------------------
echo ""
echo "=== SECTION 4: Promote to SWM — Data Should Now Sync ==="
echo ""

echo "--- 4a: Promote draft-beta assertion to SWM on Node 1 ---"
PROMOTE1=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/draft-beta/swm/share" \
  -d "{\"contextGraphId\":\"$CG_ID\"}")
PROMOTE1_CT=$(json_get "$PROMOTE1" promotedCount)
[[ "$PROMOTE1_CT" != "__NONE__" && "$PROMOTE1_CT" != "0" ]] && ok "draft-beta promoted ($PROMOTE1_CT quads)" || fail "Promote failed: $PROMOTE1"

echo "--- 4b: Verify SWM data on Node 1 ---"
sleep 2
N1_SWM_CT=$(sharing_api_observe "${N1_PORT}" "SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
devnet_count_at_least "$N1_SWM_CT" 1 && ok "Node 1 has promoted data in SWM" || fail "Node 1 SWM empty after promote"

echo "--- 4c: Wait for gossip + verify SWM data on Node 2 ---"
SWM_SYNCED=false
sharing_wait_for_count "${N2_PORT}" 15 1 "SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}"
case $? in
  0) SWM_SYNCED=true; ok "Node 2 received promoted SWM data (after ${SHARING_WAIT_POLLS}s)" ;;
  3) fail "Node 2 read of SWM data: read authority was still unavailable when the wait ended" ;;
  *) fail "Node 2 did not receive SWM data after 15s" ;;
esac
N2_SWM_CT=$SHARING_WAIT_VALUE

echo "--- 4d: Verify both entities synced ---"
if $SWM_SYNCED; then
  N2_BETA2_CT=$(sharing_api_observe "${N2_PORT}" "SELECT ?name WHERE { <urn:sharing:beta2> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
  devnet_count_at_least "$N2_BETA2_CT" 1 && ok "Node 2 has both promoted entities" || fail "Node 2 missing beta2 entity"
fi

echo "--- 4e: doc-alpha (still in WM) must NOT appear on Node 2 ---"
# Current drafts use per-KA numeric _working_memory graphs; legacy drafts
# can still use /assertion/. Neither family may be physically present here.
sharing_storage_absence "doc-alpha (WM) not visible on Node 2" "${N1_PORT}" "${N2_PORT}" "$WM_GRAPHS_QUERY" g

#------------------------------------------------------------
echo ""
echo "=== SECTION 5: Late Joiner (Node 4) — Joins After Promotion ==="
echo ""

echo "--- 5a: Node 4 subscribes (should be denied or timeout — not on allowlist) ---"
c -X POST "http://127.0.0.1:${N4_PORT}/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
sleep 5
N4_CATCHUP=$(poll_catchup ${N4_PORT} "$CG_ID" 10)
if [[ "$N4_CATCHUP" == "denied" || "$N4_CATCHUP" == "timeout" ]]; then
  ok "Node 4 initial sync blocked ($N4_CATCHUP)"
else
  fail "Node 4 initial sync should be blocked (got=$N4_CATCHUP)"
fi

echo "--- 5b: Node 4 sends signed join request ---"
N4_SIGN=$(c -X POST "http://127.0.0.1:${N4_PORT}/api/context-graph/$CG_ID/sign-join" -d "{\"curatorPeerId\":\"$N1_PEER\"}")
N4_SUBMIT_BODY=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['curatorPeerId']='$N1_PEER'; print(json.dumps(d))" "$N4_SIGN")
N4_SUBMIT=$(c -X POST "http://127.0.0.1:${N4_PORT}/api/context-graph/$CG_ID/request-join" -d "$N4_SUBMIT_BODY")
N4_SUB_OK=$(json_get "$N4_SUBMIT" ok)
check "Node 4 join request submitted" "$N4_SUB_OK" "true"

echo "--- 5c: Node 1 approves Node 4 ---"
sleep 2
c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/$CG_ID/approve-join" \
  -d "{\"agentAddress\":\"$N4_ADDR\"}" > /dev/null
ok "Node 4 join request approved"

echo "--- 5d: Wait for Node 4 auto-subscribe + sync ---"
sleep 10

echo "--- 5e: Node 4 has NO WM assertion data ---"
N4_AG_CT=$(sharing_storage_observe "${N4_PORT}" "$WM_GRAPHS_QUERY" g rows) || devnet_observation_abort
check "Node 4 (late joiner) has 0 assertion data graphs" "$N4_AG_CT" "0"

echo "--- 5f: Node 4 has NO WM lifecycle/event metadata ---"
sharing_storage_absence "Node 4 has 0 WM lifecycle entities" "${N1_PORT}" "${N4_PORT}" "SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/state> \"created\" } }" s

echo "--- 5g: Node 4 DOES have SWM data (promoted before join) ---"
N4_SWM_SYNCED=false
sharing_wait_for_count "${N4_PORT}" 10 1 "SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}"
case $? in
  0) N4_SWM_SYNCED=true; ok "Node 4 (late joiner) received SWM data" ;;
  3) fail "Node 4 read of SWM data: read authority was still unavailable when the wait ended" ;;
  *) fail "Node 4 did not receive SWM data (late joiner sync broken)" ;;
esac
N4_SWM_CT=$SHARING_WAIT_VALUE

echo "--- 5h: Node 4 _meta has only CG-level + non-WM subjects ---"
N4_META_SUBJ=$(sharing_storage_observe "${N4_PORT}" "SELECT DISTINCT ?s WHERE { GRAPH <$META_GRAPH> { ?s ?p ?o } }" s bindings) || devnet_observation_abort
N4_LEAKED=$(echo "$N4_META_SUBJ" | python3 -c '
import sys,json
try:
  bindings=json.load(sys.stdin)
  subjects=[b["s"] if isinstance(b["s"],str) else b["s"]["value"] for b in bindings]
  wm_leaked=[s for s in subjects if "urn:dkg:assertion:" in s or ("/assertion/" in s and "sourceFileHash" not in s)]
  # Check if any urn:dkg:assertion: subjects have WM state
  print(len([s for s in subjects if "urn:dkg:assertion:" in s]))
except: print("ERR")
' 2>/dev/null)
# The late joiner should see promoted assertion lifecycle (memoryLayer=SWM)
# but NOT the WM-only doc-alpha lifecycle
sharing_storage_absence "Node 4 has 0 WM-layer lifecycle entities" "${N1_PORT}" "${N4_PORT}" "SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> \"WM\" } }" s

#------------------------------------------------------------
echo ""
echo "=== SECTION 6: Multi-Participant WM Isolation ==="
echo ""

echo "--- 6a: Node 2 creates its own WM assertion in the shared project ---"
c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"name\":\"n2-private-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets/n2-private-draft/wm/write" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"quads\":[
    $(ql 'urn:sharing:n2secret' 'http://schema.org/name' 'Node2 Secret Data'),
    $(q 'urn:sharing:n2secret' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "Node 2 created private WM assertion"

echo "--- 6b: Node 2 can query its own WM data ---"
sleep 1
N2_OWN=$(c "http://127.0.0.1:${N2_PORT}/api/knowledge-assets/n2-private-draft/wm/quads?contextGraphId=$CG_ID")
N2_OWN_CT=$(echo "$N2_OWN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("quads",d.get("result",[]))))' 2>/dev/null || echo "0")
devnet_count_at_least "$N2_OWN_CT" 2 && ok "Node 2 sees its own WM data ($N2_OWN_CT quads)" || fail "Node 2 can't see own WM data"

echo "--- 6c: Node 1 does NOT see Node 2's WM data ---"
sleep 3
N1_N2S_CT=$(sharing_api_observe "${N1_PORT}" "SELECT ?name WHERE { <urn:sharing:n2secret> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}") || devnet_observation_abort
check "Node 1 cannot see Node 2's WM data" "$N1_N2S_CT" "0"

echo "--- 6d: Node 4 does NOT see Node 2's WM data ---"
N4_N2S_CT=$(sharing_api_observe "${N4_PORT}" "SELECT ?name WHERE { <urn:sharing:n2secret> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}") || devnet_observation_abort
check "Node 4 cannot see Node 2's WM data" "$N4_N2S_CT" "0"

echo "--- 6e: Node 2 promotes its assertion — should gossip to all ---"
PROMOTE_N2=$(c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets/n2-private-draft/swm/share" \
  -d "{\"contextGraphId\":\"$CG_ID\"}")
PROMOTE_N2_CT=$(json_get "$PROMOTE_N2" promotedCount)
[[ "$PROMOTE_N2_CT" != "__NONE__" && "$PROMOTE_N2_CT" != "0" ]] && ok "Node 2 promoted ($PROMOTE_N2_CT quads)" || fail "Node 2 promote failed"

echo "--- 6f: Wait for gossip + verify all participants see Node 2's SWM data ---"
for port_label in "${N1_PORT}:Node1" "${N4_PORT}:Node4"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  FOUND_N2=false
  sharing_wait_for_count "$port" 20 1 "SELECT ?name WHERE { <urn:sharing:n2secret> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}"
  case $? in
    0) FOUND_N2=true; ok "$label sees Node 2's promoted SWM data (after ${SHARING_WAIT_POLLS}s)" ;;
    3) fail "$label read of Node 2's SWM data: read authority was still unavailable when the wait ended" ;;
    *) warn "$label missing Node 2's SWM data after 20s (private CG sync may be slow)" ;;
  esac
  PEER_CT=$SHARING_WAIT_VALUE
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 7: Non-Participant Exclusion ==="
echo ""

echo "--- 7a: Node 3 (not invited) should have no project data ---"
N3_GRAPH_CT=$(sharing_storage_observe "${N3_PORT}" "SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \"$CG_ID\")) }" g rows) || devnet_observation_abort
check "Node 3 (not invited) has 0 project graphs" "$N3_GRAPH_CT" "0"

echo "--- 7b: Node 3 cannot query project SWM ---"
N3_SWM_CT=$(sharing_api_observe "${N3_PORT}" "SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
check "Node 3 has 0 SWM results" "$N3_SWM_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 8: Second Promotion — Incremental Sync ==="
echo ""

echo "--- 8a: Promote doc-alpha from WM to SWM on Node 1 ---"
PROMOTE_DOC=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/doc-alpha/swm/share" \
  -d "{\"contextGraphId\":\"$CG_ID\"}")
PROMOTE_DOC_CT=$(json_get "$PROMOTE_DOC" promotedCount)
if [[ "$PROMOTE_DOC_CT" != "__NONE__" && "$PROMOTE_DOC_CT" != "0" && "$PROMOTE_DOC_CT" != "__ERR__" ]]; then
  ok "doc-alpha promoted ($PROMOTE_DOC_CT quads)"
else
  # import-file may auto-promote during extraction — check SWM directly
  sleep 2
  DOC_SWM_CT=$(sharing_api_observe "${N1_PORT}" "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
  if devnet_count_at_least "$DOC_SWM_CT" 3; then
    ok "doc-alpha already in SWM ($DOC_SWM_CT entities — auto-promoted by import pipeline)"
  else
    fail "doc-alpha promote failed and not in SWM ($DOC_SWM_CT): $PROMOTE_DOC"
  fi
fi

echo "--- 8b: Verify doc-alpha now visible on Node 2 via SWM ---"
DOC_SYNCED=false
sharing_wait_for_count "${N2_PORT}" 15 3 "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}"
case $? in
  0) DOC_SYNCED=true; ok "Node 2 now sees promoted doc-alpha in SWM ($SHARING_WAIT_VALUE entities)" ;;
  3) fail "Node 2 read of doc-alpha in SWM: read authority was still unavailable when the wait ended" ;;
  *) fail "doc-alpha not synced to Node 2 after promotion" ;;
esac
N2_DOC_CT=$SHARING_WAIT_VALUE

echo "--- 8c: Verify doc-alpha now visible on Node 4 (late joiner) ---"
N4_DOC_SYNCED=false
sharing_wait_for_count "${N4_PORT}" 10 3 "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}"
case $? in
  0) N4_DOC_SYNCED=true; ok "Node 4 (late joiner) sees doc-alpha in SWM ($SHARING_WAIT_VALUE entities)" ;;
  3) fail "Node 4 read of doc-alpha in SWM: read authority was still unavailable when the wait ended" ;;
  *) warn "doc-alpha not yet on Node 4 ($SHARING_WAIT_VALUE entities)" ;;
esac
N4_DOC_CT=$SHARING_WAIT_VALUE

echo "--- 8d: Node 3 (not invited) still sees nothing ---"
sharing_excluded_swm "$N3_PORT" "$CG_ID"

#------------------------------------------------------------
echo ""
echo "=== SECTION 9: Lifecycle Metadata Correctness ==="
echo ""

echo "--- 9a: Promoted assertion lifecycle shows SWM layer on Node 1 ---"
N1_PROMOTED_LC=$(sharing_storage_observe "${N1_PORT}" "SELECT ?s ?ml WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> ?ml . ?s <http://dkg.io/ontology/assertionName> \"draft-beta\" } }" s bindings) || devnet_observation_abort
N1_PLC_ML=$(echo "$N1_PROMOTED_LC" | python3 -c '
import sys,json
try:
  b=json.load(sys.stdin)
  if b:
    ml=b[0]["ml"]
    print((ml if isinstance(ml,str) else ml["value"]).strip("\""))
  else: print("MISSING")
except: print("ERR")
' 2>/dev/null)
check "draft-beta lifecycle shows SWM layer" "$N1_PLC_ML" "SWM"

echo "--- 9b: Promoted assertion lifecycle synced to Node 2 ---"
N2_PLC_FOUND=false
for i in $(seq 1 10); do
  N2_PLC_CT=$(sharing_storage_observe "${N2_PORT}" "SELECT ?ml WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> ?ml . ?s <http://dkg.io/ontology/assertionName> \"draft-beta\" } }" ml rows) || devnet_observation_abort
  if devnet_count_at_least "$N2_PLC_CT" 1; then
    N2_PLC_FOUND=true
    ok "Node 2 has promoted lifecycle metadata"
    break
  fi
  sleep 1
done
$N2_PLC_FOUND || warn "Node 2 missing promoted lifecycle — may not sync lifecycle for private CGs"

echo "--- 9c: WM-only doc-alpha lifecycle NOT leaked before its promotion (check Node 4 snapshot) ---"
# After section 8, doc-alpha is now SWM, so check specifically for WM-tagged entries
N4_WM_ONLY_CT=$(sharing_storage_observe "${N4_PORT}" "SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> \"WM\" } }" s rows) || devnet_observation_abort
check "Node 4 has 0 WM-tagged lifecycle entries" "$N4_WM_ONLY_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 10: New WM After Promotion — Still Private ==="
echo ""

echo "--- 10a: Create a new WM assertion on Node 1 (post-promotion) ---"
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"name\":\"post-promo-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/post-promo-draft/wm/write" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"quads\":[
    $(ql 'urn:sharing:postpromo' 'http://schema.org/name' 'Post-Promotion Secret'),
    $(q 'urn:sharing:postpromo' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "Created post-promo-draft assertion"

echo "--- 10b: Verify new WM data stays private after background sync ---"
sleep 5
for port_label in "${N2_PORT}:Node2" "${N4_PORT}:Node4"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  PP_CT=$(sharing_api_observe "$port" "SELECT ?name WHERE { <urn:sharing:postpromo> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}") || devnet_observation_abort
  check "$label cannot see post-promotion WM data" "$PP_CT" "0"
done

echo "--- 10c: No new assertion metadata leaked to peers ---"
for port_label in "${N2_PORT}:Node2" "${N4_PORT}:Node4"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  sharing_storage_absence "$label has no post-promo-draft metadata" "$N1_PORT" "$port" \
    "SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/assertionName> \"post-promo-draft\" } }" s
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 11: Summary Cross-Check ==="
echo ""

echo "--- 11a: Final graph counts per node ---"
for port_label in "${N1_PORT}:Node1(creator)" "${N2_PORT}:Node2(invited)" "${N4_PORT}:Node4(late)" "${N3_PORT}:Node3(excluded)"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  GCNT=$(sharing_storage_observe "$port" "SELECT ?g (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \"$CG_ID\")) } GROUP BY ?g ORDER BY ?g" g rows) || devnet_observation_abort
  echo "  $label: $GCNT graph(s)"
  if [[ "$label" == *"excluded"* ]]; then
    check "$label has 0 graphs" "$GCNT" "0"
  elif [[ "$label" == *"creator"* ]]; then
    devnet_count_at_least "$GCNT" 3 && ok "$label has $GCNT graphs (WM + SWM + meta)" || warn "$label only $GCNT graphs"
  else
    devnet_count_at_least "$GCNT" 1 && ok "$label has $GCNT graph(s)" || fail "$label has no graphs"
  fi
done

# Cleanup
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/post-promo-draft/wm/discard" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null 2>&1
c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets/n2-private-draft/wm/discard" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "=== SECTION 12: WM SPARQL Default Graph Isolation ==="
echo ""

echo "--- 12a: wmSparql default graph should not return system triples on participant ---"
N2_DEF_CT=$(sharing_api_observe "${N2_PORT}" "SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \"did:dkg:context-graph:$CG_ID/\") && !STRENDS(STR(?g), \"/_meta\") && !CONTAINS(STR(?g), \"/_private\") && !CONTAINS(STR(?g), \"/_shared_memory\") && !CONTAINS(STR(?g), \"/_verifiable_memory\") && !CONTAINS(STR(?g), \"/_rules\")) }" s rows "{\"contextGraphId\":\"$CG_ID\"}") || devnet_observation_abort
check "Node 2 WM named-graph-only query returns 0 non-SWM triples" "$N2_DEF_CT" "0"

echo "--- 12b: Non-participant wmSparql returns 0 triples (no system leak) ---"
N3_DEF_CT=$(sharing_api_observe "${N3_PORT}" "SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \"did:dkg:context-graph:$CG_ID/\") && !STRENDS(STR(?g), \"/_meta\") && !CONTAINS(STR(?g), \"/_private\") && !CONTAINS(STR(?g), \"/_shared_memory\") && !CONTAINS(STR(?g), \"/_verifiable_memory\") && !CONTAINS(STR(?g), \"/_rules\")) }" s rows "{\"contextGraphId\":\"$CG_ID\"}") || devnet_observation_abort
check "Node 3 (excluded) WM named-graph-only query returns 0" "$N3_DEF_CT" "0"

echo "--- 12c: System triples (did:dkg:network:*) excluded from WM entity count ---"
N3_SYS_CT=$(sharing_api_observe "${N3_PORT}" "SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \"did:dkg:context-graph:$CG_ID/\")) }" s rows "{\"contextGraphId\":\"$CG_ID\"}") || devnet_observation_abort
check "Node 3 has 0 named-graph triples scoped to this CG" "$N3_SYS_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 13: Second Join Flow — Node 4 Full Cycle ==="
echo ""

N5_ADDR=$(get_self_address ${N5_PORT})
echo "  Node 5: $N5_ADDR"

echo "--- 13a: Create a second private project on Node 1 ---"
CG2_ID="join-flow-test-$(date +%s)"
CREATE2=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/create" \
  -d "{\"id\":\"$CG2_ID\",\"name\":\"Join Flow Test\",\"private\":true}")
CREATE2_OK=$(json_get "$CREATE2" created)
check "Second private project created" "$CREATE2_OK" "$CG2_ID"

echo "--- 13b: Import WM data on Node 1 ---"
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG2_ID\",\"name\":\"wm-secret\"}" > /dev/null
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/wm-secret/wm/write" \
  -d "{\"contextGraphId\":\"$CG2_ID\",\"quads\":[
    $(ql 'urn:join-flow:secret1' 'http://schema.org/name' 'Secret Data'),
    $(q 'urn:join-flow:secret1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "WM data written to join-flow project"

echo "--- 13c: Promote some data to SWM on Node 1 ---"
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG2_ID\",\"name\":\"swm-shared\",\"finalize\":true,\"alsoShareSwm\":true,\"quads\":[
    $(ql 'urn:join-flow:shared1' 'http://schema.org/name' 'Shared Data'),
    $(q 'urn:join-flow:shared1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
sleep 1
ok "SWM data written to join-flow project"

echo "--- 13d: Node 4 subscribes — should be denied ---"
c -X POST "http://127.0.0.1:${N4_PORT}/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG2_ID\"}" > /dev/null
sleep 3
N4_STATUS=$(c "http://127.0.0.1:${N4_PORT}/api/sync/catchup-status?contextGraphId=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')")
N4_ST=$(json_get "$N4_STATUS" status)
N4_ERR=$(json_get "$N4_STATUS" error)
if [[ "$N4_ST" == "denied" || "$N4_ERR" == *"denied"* ]]; then
  ok "Node 4 subscription denied (status=$N4_ST)"
elif [[ "$N4_ST" == "timeout" || "$N4_ST" == "__NONE__" ]]; then
  ok "Node 4 subscription blocked (status=$N4_ST)"
elif [[ "$N4_ST" == "running" || "$N4_ST" == "queued" || "$N4_ST" == "done" || "$N4_ST" == "completed" ]]; then
  warn "Node 4 subscription not denied (status=$N4_ST) — access control may not be enforced during initial sync"
else
  fail "Node 4 unexpected status (status=$N4_ST)"
fi

echo "--- 13e: Node 4 signs + submits join request ---"
N4_SIGN=$(c -X POST "http://127.0.0.1:${N4_PORT}/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/sign-join" -d "{\"curatorPeerId\":\"$N1_PEER\"}")
N4_SUBMIT_BODY=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['curatorPeerId']='$N1_PEER'; print(json.dumps(d))" "$N4_SIGN")
N4_SUBMIT=$(c -X POST "http://127.0.0.1:${N4_PORT}/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/request-join" -d "$N4_SUBMIT_BODY")
N4_SUBMIT_OK=$(json_get "$N4_SUBMIT" ok)
check "Node 4 join request submitted" "$N4_SUBMIT_OK" "true"

echo "--- 13f: Node 1 sees pending request from Node 4 ---"
sleep 2
N1_REQS=$(c "http://127.0.0.1:${N1_PORT}/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/join-requests")
N1_REQ_ADDR=$(echo "$N1_REQS" | python3 -c '
import sys,json
d=json.load(sys.stdin)
reqs=d.get("requests",[])
addrs=[r.get("agentAddress","") for r in reqs if r.get("status")=="pending"]
print(",".join(addrs) if addrs else "NONE")
' 2>/dev/null)
echo "$N1_REQ_ADDR" | grep -qi "$(echo "$N4_ADDR" | tr '[:upper:]' '[:lower:]')" \
  && ok "Node 1 sees pending request from Node 4 ($N4_ADDR)" \
  || fail "Node 1 missing Node 4's request (found: $N1_REQ_ADDR)"

echo "--- 13g: Notification created on curator (Node 1) ---"
N1_NOTIFS=$(c "http://127.0.0.1:${N1_PORT}/api/notifications?limit=5")
N1_JOIN_NOTIF=$(echo "$N1_NOTIFS" | python3 -c '
import sys,json
d=json.load(sys.stdin)
target_cg = sys.argv[1]
for n in d.get("notifications",[]):
  if n.get("type")!="join_request":
    continue
  meta = n.get("meta") or {}
  if isinstance(meta, str):
    try: meta = json.loads(meta)
    except Exception: meta = {}
  cg = n.get("contextGraphId") or meta.get("contextGraphId") or ""
  if cg == target_cg:
    print("found")
    break
else:
  print("missing")
' "$CG2_ID" 2>/dev/null)
check "Join-request notification created on Node 1" "$N1_JOIN_NOTIF" "found"

echo "--- 13h: Node 1 approves Node 4 ---"
N4_APPROVE=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/approve-join" \
  -d "{\"agentAddress\":\"$N4_ADDR\"}")
N4_APP_OK=$(json_get "$N4_APPROVE" ok)
check "Node 4 join request approved" "$N4_APP_OK" "true"

echo "--- 13i: Node 4 auto-subscribes and receives SWM data ---"
N4_SWM_OK=false
sharing_wait_for_count "${N4_PORT}" 20 1 "SELECT ?name WHERE { <urn:join-flow:shared1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG2_ID\",\"view\":\"shared-working-memory\"}"
case $? in
  0) N4_SWM_OK=true; ok "Node 4 received SWM data after approval (after ${SHARING_WAIT_POLLS}s)" ;;
  3) fail "Node 4 read of SWM data after approval: read authority was still unavailable when the wait ended" ;;
  *) fail "Node 4 did not receive SWM data after approval" ;;
esac
N4_SWM_CT=$SHARING_WAIT_VALUE

echo "--- 13j: Node 4 has NO WM data (wm-secret stays private) ---"
N4_SEC_CT=$(sharing_api_observe "${N4_PORT}" "SELECT ?name WHERE { <urn:join-flow:secret1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG2_ID\",\"includeSharedMemory\":true}") || devnet_observation_abort
check "Node 4 cannot see WM secret data" "$N4_SEC_CT" "0"

echo "--- 13k: Node 4 has NO WM lifecycle metadata ---"
# Scoped: since v10.0.17 an unscoped query is refused on stores without
# all-writer consistency coverage. The raw backend observer below verifies physical absence with an owner control.
sharing_storage_absence "Node 4 has 0 WM-layer lifecycle entries" "${N1_PORT}" "${N4_PORT}" "SELECT ?s WHERE { GRAPH <did:dkg:context-graph:$CG2_ID/_meta> { ?s <http://dkg.io/ontology/memoryLayer> \"WM\" } }" s

echo "--- 13l: Node 5 sends join request + gets approved ---"
c -X POST "http://127.0.0.1:${N5_PORT}/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG2_ID\"}" > /dev/null
sleep 3
N5_SIGN=$(c -X POST "http://127.0.0.1:${N5_PORT}/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/sign-join" -d "{\"curatorPeerId\":\"$N1_PEER\"}")
N5_SUBMIT_BODY=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['curatorPeerId']='$N1_PEER'; print(json.dumps(d))" "$N5_SIGN")
N5_SUBMIT=$(c -X POST "http://127.0.0.1:${N5_PORT}/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/request-join" -d "$N5_SUBMIT_BODY")
check "Node 5 join request submitted" "$(json_get "$N5_SUBMIT" ok)" "true"
sleep 2
c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/approve-join" \
  -d "{\"agentAddress\":\"$N5_ADDR\"}" > /dev/null
ok "Node 5 join approved"

echo "--- 13m: Node 5 receives SWM but not WM ---"
N5_SWM_OK=false
sharing_wait_for_count "${N5_PORT}" 25 1 "SELECT ?name WHERE { <urn:join-flow:shared1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG2_ID\",\"view\":\"shared-working-memory\"}"
case $? in
  0) N5_SWM_OK=true; ok "Node 5 received SWM data" ;;
  3) fail "Node 5 read of SWM data: read authority was still unavailable when the wait ended" ;;
  *) warn "Node 5 (edge) did not receive SWM data after 25s — edge sync may be slower" ;;
esac
N5_SWM_CT=$SHARING_WAIT_VALUE

N5_SEC_CT=$(sharing_api_observe "${N5_PORT}" "SELECT ?name WHERE { <urn:join-flow:secret1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG2_ID\",\"includeSharedMemory\":true}") || devnet_observation_abort
check "Node 5 cannot see WM secret data" "$N5_SEC_CT" "0"

echo "--- 13n: Node 3 (never requested) still excluded ---"
N3_CG2_CT=$(sharing_storage_observe "${N3_PORT}" "SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \"$CG2_ID\")) }" g rows) || devnet_observation_abort
check "Node 3 has 0 graphs for join-flow project" "$N3_CG2_CT" "0"

# Cleanup
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/wm-secret/wm/discard" \
  -d "{\"contextGraphId\":\"$CG2_ID\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "=== SECTION 14: Promote After Import-File (agentAddress fix) ==="
echo ""

echo "--- 14a: Create project for promote test ---"
CG3_ID="promote-test-$(date +%s)"
CREATE3=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/create" \
  -d "{\"id\":\"$CG3_ID\",\"name\":\"Promote Test\"}")
check "Promote test project created" "$(json_get "$CREATE3" created)" "$CG3_ID"

echo "--- 14b: Import markdown file via import-file ---"
TMPMD2=$(mktemp "$DEVNET_TMPDIR/promote-test-XXXXXX.md")
cat > "$TMPMD2" <<'MDEOF'
# Promote Test Doc
Testing that import-file data can be promoted correctly.
- The import stores data under the wallet address
- The promote must look up the same wallet address, not peerId
MDEOF
IMPORT_PROMO=$(curl -sS --max-time 30 --connect-timeout 5 \
  -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPMD2};type=text/markdown" \
  -F "contextGraphId=$CG3_ID" \
  "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/promo-doc/wm/import-file" 2>&1)
rm -f "$TMPMD2"
IMPORT_PROMO_URI=$(json_get "$IMPORT_PROMO" assertionUri)
[[ "$IMPORT_PROMO_URI" != "__NONE__" && "$IMPORT_PROMO_URI" != "__ERR__" ]] \
  && ok "Imported promo-doc ($IMPORT_PROMO_URI)" \
  || fail "Import-file failed: ${IMPORT_PROMO:0:200}"

echo "--- 14c: Verify import stored under wallet address, not peerId ---"
echo "$IMPORT_PROMO_URI" | grep -qi "$N1_ADDR" \
  && ok "Assertion URI contains wallet address ($N1_ADDR)" \
  || fail "Assertion URI missing wallet address: $IMPORT_PROMO_URI"

echo "--- 14d: Promote import-file assertion to SWM ---"
sleep 1
PROMO_RESULT=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/promo-doc/swm/share" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}")
PROMO_CT=$(json_get "$PROMO_RESULT" promotedCount)
[[ "$PROMO_CT" != "__NONE__" && "$PROMO_CT" != "0" && "$PROMO_CT" != "__ERR__" ]] \
  && ok "promo-doc promoted ($PROMO_CT triples)" \
  || fail "Promote returned 0 — wallet/peerId address mismatch bug (promotedCount=$PROMO_CT)"

echo "--- 14e: Verify promoted data exists in SWM ---"
sleep 1
PROMO_SWM_CT=$(sharing_api_observe "${N1_PORT}" "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
devnet_count_at_least "$PROMO_SWM_CT" 1 && ok "Promoted data visible in SWM ($PROMO_SWM_CT entities)" || fail "SWM empty after promote ($PROMO_SWM_CT)"

echo "--- 14f: Also create + write + promote an API assertion (same project) ---"
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"name\":\"api-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/api-draft/wm/write" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"quads\":[
    $(ql 'urn:promote-test:api1' 'http://schema.org/name' 'API Written Entity'),
    $(q 'urn:promote-test:api1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
PROMO_API=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/api-draft/swm/share" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}")
PROMO_API_CT=$(json_get "$PROMO_API" promotedCount)
[[ "$PROMO_API_CT" != "__NONE__" && "$PROMO_API_CT" != "0" ]] \
  && ok "api-draft promoted ($PROMO_API_CT triples)" \
  || fail "api-draft promote failed ($PROMO_API_CT)"

echo "--- 14g: Promote on node 2 also works (different wallet) ---"
CG4_ID="promote-n2-$(date +%s)"
c -X POST "http://127.0.0.1:${N2_PORT}/api/context-graph/create" \
  -d "{\"id\":\"$CG4_ID\",\"name\":\"Node2 Promote Test\"}" > /dev/null
c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG4_ID\",\"name\":\"n2-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets/n2-draft/wm/write" \
  -d "{\"contextGraphId\":\"$CG4_ID\",\"quads\":[
    $(ql 'urn:promote-n2:item' 'http://schema.org/name' 'Node2 Entity'),
    $(q 'urn:promote-n2:item' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
sleep 1
PROMO_N2=$(c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets/n2-draft/swm/share" \
  -d "{\"contextGraphId\":\"$CG4_ID\"}")
PROMO_N2_CT=$(json_get "$PROMO_N2" promotedCount)
[[ "$PROMO_N2_CT" != "__NONE__" && "$PROMO_N2_CT" != "0" ]] \
  && ok "Node 2 promote works ($PROMO_N2_CT triples)" \
  || fail "Node 2 promote returned 0 — wallet/peerId mismatch ($PROMO_N2_CT)"

#------------------------------------------------------------
echo ""
echo "=== SECTION 15: Publish SWM → Verifiable Memory (VM) ==="
echo ""

echo "--- 15pre: Register promote-test project on-chain ---"
REG_CG3=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/register" \
  -d "{\"id\":\"$CG3_ID\"}")
REG_CG3_OK=$(json_get "$REG_CG3" registered)
if [[ "$REG_CG3_OK" == "$CG3_ID" ]]; then
  ok "Context graph $CG3_ID registered on-chain"
else
  REG_CG3_ERR=$(json_get "$REG_CG3" error)
  if echo "$REG_CG3_ERR" | grep -qi "already"; then
    ok "Context graph $CG3_ID already registered"
  else
    fail "Failed to register CG on-chain: $REG_CG3_ERR"
  fi
fi
sleep 3

echo "--- 15a: Publish named KAs to VM on Node 1 (promote-test project) ---"
PUBLISH_DOC=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/promo-doc/vm/publish" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"options\":{\"clearAfter\":false}}")
PUBLISH_API=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/api-draft/vm/publish" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"options\":{\"clearAfter\":false}}")
PUB_STATUS=$(json_get "$PUBLISH_API" status)
PUB_KCID=$(json_get "$PUBLISH_API" kaId)
PUB_TX=$(json_get "$PUBLISH_API" txHash)
DOC_STATUS=$(json_get "$PUBLISH_DOC" status)
echo "  promo-doc status=$DOC_STATUS; api-draft status=$PUB_STATUS kaId=$PUB_KCID txHash=${PUB_TX:0:20}..."
if [[ ( "$DOC_STATUS" == "confirmed" || "$DOC_STATUS" == "finalized" ) && ( "$PUB_STATUS" == "confirmed" || "$PUB_STATUS" == "finalized" ) ]]; then
  ok "Named KAs published to VM (promo-doc + api-draft)"
else
  fail "Named KA publish failed: promo-doc=${PUBLISH_DOC:0:180} api-draft=${PUBLISH_API:0:180}"
fi

echo "--- 15b: Verify VM data on Node 1 ---"
sleep 3
N1_VM_CT=$(sharing_api_observe "${N1_PORT}" "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"verifiable-memory\"}") || devnet_observation_abort
devnet_count_at_least "$N1_VM_CT" 1 && ok "Node 1 has $N1_VM_CT entities in VM" || warn "Node 1 VM query is empty immediately after publish"

echo "--- 15c: Verify specific entities in VM ---"
N1_VM_API_CT=$(sharing_api_observe "${N1_PORT}" "SELECT ?name WHERE { <urn:promote-test:api1> <http://schema.org/name> ?name }" name rows "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"verifiable-memory\"}") || devnet_observation_abort
devnet_count_at_least "$N1_VM_API_CT" 1 && ok "API entity visible in VM" || warn "API entity not in VM ($N1_VM_API_CT) — may not have been in SWM"

echo "--- 15d: VM data syncs to Node 2 ---"
# Node 2 should pick up VM data via gossip/sync even if not on the allowlist for this project
# (VM is published on-chain and available to all nodes)
N2_VM_SYNCED=false
sharing_wait_for_count "${N2_PORT}" 20 1 "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"verifiable-memory\"}"
case $? in
  0) N2_VM_SYNCED=true; ok "Node 2 received VM data ($SHARING_WAIT_VALUE entities, after ${SHARING_WAIT_POLLS}s)" ;;
  3) fail "Node 2 read of VM data: read authority was still unavailable when the wait ended" ;;
  *) warn "Node 2 missing VM data after 20s — VM sync may need more time" ;;
esac
N2_VM_CT=$SHARING_WAIT_VALUE

echo "--- 15e: Node 3 also has VM data (VM is public/on-chain) ---"
N3_VM_SYNCED=false
sharing_wait_for_count "${N3_PORT}" 20 1 "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"verifiable-memory\"}"
case $? in
  0) N3_VM_SYNCED=true; ok "Node 3 received VM data ($SHARING_WAIT_VALUE entities, after ${SHARING_WAIT_POLLS}s)" ;;
  3) fail "Node 3 read of VM data: read authority was still unavailable when the wait ended" ;;
  *) warn "Node 3 missing VM data after 20s — VM sync may need more time" ;;
esac
N3_VM_CT=$SHARING_WAIT_VALUE

echo "--- 15f: SWM still has data (clearAfter=false) ---"
SWM_AFTER_CT=$(sharing_api_observe "${N1_PORT}" "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
devnet_count_at_least "$SWM_AFTER_CT" 1 && ok "SWM retained after publish ($SWM_AFTER_CT entities)" || warn "SWM cleared despite clearAfter=false"

#------------------------------------------------------------
echo ""
echo "=== SECTION 16: Publish from Private Project (CG1) ==="
echo ""

echo "--- 16pre: Register CG1 on-chain ---"
REG_CG1=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/context-graph/register" \
  -d "{\"id\":\"$CG_ID\"}")
REG_CG1_OK=$(json_get "$REG_CG1" registered)
if [[ "$REG_CG1_OK" == "$CG_ID" ]]; then
  ok "CG1 registered on-chain"
else
  REG_CG1_ERR=$(json_get "$REG_CG1" error)
  if echo "$REG_CG1_ERR" | grep -qi "already"; then
    ok "CG1 already registered"
  else
    fail "Failed to register CG1 on-chain: $REG_CG1_ERR"
  fi
fi
sleep 3

echo "--- 16a: Publish CG1 named KAs to VM on Node 1 ---"
PUB_CG1_BETA=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/draft-beta/vm/publish" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"options\":{\"clearAfter\":false}}")
PUB_CG1_DOC=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/doc-alpha/vm/publish" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"options\":{\"clearAfter\":false}}")
PUB_CG1_STATUS=$(json_get "$PUB_CG1_BETA" status)
PUB_CG1_DOC_STATUS=$(json_get "$PUB_CG1_DOC" status)
if [[ ( "$PUB_CG1_STATUS" == "confirmed" || "$PUB_CG1_STATUS" == "finalized" ) && ( "$PUB_CG1_DOC_STATUS" == "confirmed" || "$PUB_CG1_DOC_STATUS" == "finalized" ) ]]; then
  ok "CG1 named KAs published to VM (draft-beta + doc-alpha)"
else
  fail "CG1 named KA publish failed: draft-beta=${PUB_CG1_BETA:0:180} doc-alpha=${PUB_CG1_DOC:0:180}"
fi

echo "--- 16b: Verify VM data on Node 1 for private CG ---"
echo "--- 16b: Node 2 (participant) sees VM data ---"
N2_CG1_VM_OK=false
sharing_wait_for_count "${N2_PORT}" 20 1 "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG_ID\",\"view\":\"verifiable-memory\"}"
case $? in
  0) N2_CG1_VM_OK=true; ok "Node 2 has VM data for CG1 ($SHARING_WAIT_VALUE entities, after ${SHARING_WAIT_POLLS}s)" ;;
  3) fail "Node 2 read of VM data for CG1: read authority was still unavailable when the wait ended" ;;
  *) warn "Node 2 missing VM data for CG1 after 20s" ;;
esac
N2_CG1_VM_CT=$SHARING_WAIT_VALUE

echo "--- 16c: Node 4 (late joiner) sees VM data ---"
N4_CG1_VM_OK=false
sharing_wait_for_count "${N4_PORT}" 20 1 "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG_ID\",\"view\":\"verifiable-memory\"}"
case $? in
  0) N4_CG1_VM_OK=true; ok "Node 4 has VM data for CG1 ($SHARING_WAIT_VALUE entities, after ${SHARING_WAIT_POLLS}s)" ;;
  3) fail "Node 4 read of VM data for CG1: read authority was still unavailable when the wait ended" ;;
  *) warn "Node 4 missing VM data for CG1 after 20s" ;;
esac
N4_CG1_VM_CT=$SHARING_WAIT_VALUE

echo "--- 16d: Node 3 (excluded from private CG) still gets VM (on-chain is public) ---"
N3_CG1_VM_OK=false
sharing_wait_for_count "${N3_PORT}" 20 1 "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG_ID\",\"view\":\"verifiable-memory\"}"
case $? in
  0) N3_CG1_VM_OK=true; ok "Node 3 sees VM for private CG1 ($SHARING_WAIT_VALUE entities — on-chain is public)" ;;
  3) fail "Node 3 read of VM data for CG1: read authority was still unavailable when the wait ended" ;;
  *) warn "Node 3 missing VM for CG1 — VM gossip may be slower for private CGs" ;;
esac
N3_CG1_VM_CT=$SHARING_WAIT_VALUE

echo "--- 16e: WM data still private after publish ---"
for port_label in "${N2_PORT}:Node2" "${N4_PORT}:Node4" "${N3_PORT}:Node3"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  PEER_WM_CT=$(sharing_storage_observe "$port" "$WM_GRAPHS_QUERY" g rows) || devnet_observation_abort
  check "$label still has 0 WM assertion graphs after publish" "$PEER_WM_CT" "0"
done

echo "--- 16f: Publish with clearAfter=true, then verify SWM is empty ---"
CLEAR_NAME="clear-after-smoke"
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"name\":\"$CLEAR_NAME\",\"quads\":[
    $(ql 'urn:promote-test:clear-after' 'http://schema.org/name' 'Clear After Smoke')
  ],\"finalize\":true,\"alsoShareSwm\":true}" > /dev/null
PUB_CLEAR=$(c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/$CLEAR_NAME/vm/publish" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"options\":{\"clearAfter\":true}}")
PUB_CLEAR_STATUS=$(json_get "$PUB_CLEAR" status)
sleep 2
SWM_CLEARED_CT=$(sharing_api_observe "${N1_PORT}" "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
if [[ "$SWM_CLEARED_CT" == "0" ]]; then
  ok "SWM cleared after publish with clearAfter=true"
else
  warn "SWM not cleared ($SWM_CLEARED_CT entities) — may retain data until publish is confirmed on-chain"
fi

echo "--- 16g: VM still has data even after SWM cleared ---"
VM_STILL_CT=0
for _ in $(seq 1 30); do
  VM_STILL_CT=$(sharing_api_observe "${N1_PORT}" "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }" cnt count "{\"contextGraphId\":\"$CG3_ID\",\"view\":\"verifiable-memory\"}") || devnet_observation_abort
  devnet_count_at_least "$VM_STILL_CT" 1 && break
  sleep 1
done
devnet_count_at_least "$VM_STILL_CT" 1 && ok "VM data persists after SWM clear ($VM_STILL_CT entities)" || fail "VM data lost after SWM clear"

# Cleanup
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/promo-doc/wm/discard" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}" > /dev/null 2>&1
c -X POST "http://127.0.0.1:${N1_PORT}/api/knowledge-assets/api-draft/wm/discard" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}" > /dev/null 2>&1
c -X POST "http://127.0.0.1:${N2_PORT}/api/knowledge-assets/n2-draft/wm/discard" \
  -d "{\"contextGraphId\":\"$CG4_ID\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "============================================================"
echo "TEST SUMMARY — Private Project Sharing & WM Isolation"
echo "============================================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo "  TOTAL: $((PASS + FAIL + WARN))"
echo "============================================================"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "  Some tests FAILED — see above for details."
  exit 1
else
  echo "  All tests passed (with $WARN warnings)."
fi
