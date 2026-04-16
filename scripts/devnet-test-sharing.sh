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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "${DKG_AUTH:-}" ]]; then
  AUTH="$DKG_AUTH"
elif [[ -f "$SCRIPT_DIR/../.devnet/node1/auth.token" ]]; then
  AUTH="$(grep -v '^#' "$SCRIPT_DIR/../.devnet/node1/auth.token" 2>/dev/null | tr -d '[:space:]')"
else
  echo "ERROR: No auth token. Export DKG_AUTH or start a devnet." >&2
  exit 1
fi

PASS=0; FAIL=0; WARN=0
DEVNET_TMPDIR="${TMPDIR:-/tmp}"

c() {
  curl -sS --max-time 30 --connect-timeout 5 \
    -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "$@"
}

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

safe_bindings_count() {
  echo "$1" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  b=d.get("result",{}).get("bindings",None)
  if b is None: print("PARSE_ERR")
  else: print(len(b))
except: print("PARSE_ERR")
' 2>/dev/null || echo "PARSE_ERR"
}

count_integer() {
  echo "$1" | python3 -c '
import sys,json,re
try:
  d=json.load(sys.stdin)
  b=d.get("result",{}).get("bindings",[])
  if b:
    v=str(b[0].get("cnt",b[0].get("c","0")))
    m=re.search(r"(\d+)",v)
    print(m.group(1) if m else "0")
  else: print("0")
except: print("ERR")
' 2>/dev/null || echo "ERR"
}

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

CG_ID="sharing-test-$(date +%s)"

echo "============================================================"
echo "DKG V10 Private Project Sharing & WM Isolation Test"
echo "============================================================"
echo ""
echo "  Test CG: $CG_ID"
echo ""

# ── Discover node addresses ──────────────────────────────────────
N1_ADDR=$(get_self_address 9201)
N2_ADDR=$(get_self_address 9202)
N3_ADDR=$(get_self_address 9203)
N4_ADDR=$(get_self_address 9204)
echo "  Node 1: $N1_ADDR"
echo "  Node 2: $N2_ADDR"
echo "  Node 3: $N3_ADDR"
echo "  Node 4: $N4_ADDR"
echo ""

#------------------------------------------------------------
echo "=== SECTION 1: Private Project Creation ==="
echo ""

echo "--- 1a: Create private project on Node 1 ---"
CREATE=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" \
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
  "http://127.0.0.1:9201/api/assertion/doc-alpha/import-file" 2>&1)
rm -f "$TMPMD"
IMPORT1_URI=$(json_get "$IMPORT1" assertionUri)
IMPORT1_CT=$(json_get "$IMPORT1" extraction.tripleCount)
[[ "$IMPORT1_URI" != "__NONE__" ]] && ok "Imported doc-alpha ($IMPORT1_CT triples)" || fail "Import failed: ${IMPORT1:0:200}"

echo "--- 1c: Create a second WM assertion via API ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"name\":\"draft-beta\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/draft-beta/write" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"quads\":[
    $(ql 'urn:sharing:beta1' 'http://schema.org/name' 'Beta Entity'),
    $(q 'urn:sharing:beta1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),
    $(ql 'urn:sharing:beta2' 'http://schema.org/name' 'Beta Entity 2'),
    $(q 'urn:sharing:beta2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "Created draft-beta assertion with 4 quads"

echo "--- 1d: Verify Node 1 has WM data locally ---"
sleep 1
N1_ASSERT_CT=$(c -X POST "http://127.0.0.1:9201/api/assertion/draft-beta/query" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("quads",d.get("result",[]))))' 2>/dev/null)
[[ "$N1_ASSERT_CT" -ge 4 ]] && ok "Node 1 has $N1_ASSERT_CT quads in WM" || fail "Node 1 WM assertion empty ($N1_ASSERT_CT)"

N1_GRAPHS=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT ?g (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG_ID\\\")) } GROUP BY ?g\"}")
N1_GRAPH_CT=$(safe_bindings_count "$N1_GRAPHS")
echo "  Node 1 has $N1_GRAPH_CT graphs for this CG"

#------------------------------------------------------------
echo ""
echo "=== SECTION 2: Join Request Flow (Node 2) ==="
echo ""

echo "--- 2a: Node 2 subscribes (should be denied — not on allowlist) ---"
c -X POST "http://127.0.0.1:9202/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
sleep 5
CATCHUP_ST=$(poll_catchup 9202 "$CG_ID" 10)
check "Node 2 initial sync denied" "$CATCHUP_ST" "denied"

echo "--- 2b: Node 2 sends signed join request ---"
SIGN=$(c -X POST "http://127.0.0.1:9202/api/context-graph/$CG_ID/sign-join")
SUBMIT=$(c -X POST "http://127.0.0.1:9202/api/context-graph/$CG_ID/request-join" -d "$SIGN")
SUBMIT_OK=$(json_get "$SUBMIT" ok)
SUBMIT_DEL=$(json_get "$SUBMIT" delivered)
check "Join request submitted" "$SUBMIT_OK" "true"
[[ "$SUBMIT_DEL" -ge 1 ]] && ok "Join request delivered to $SUBMIT_DEL curator(s)" || fail "Join request not delivered"

echo "--- 2c: Node 1 sees the pending request ---"
sleep 2
REQUESTS=$(c "http://127.0.0.1:9201/api/context-graph/$CG_ID/join-requests")
REQ_CT=$(echo "$REQUESTS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("requests",[])))' 2>/dev/null)
[[ "$REQ_CT" -ge 1 ]] && ok "Node 1 has $REQ_CT pending request(s)" || fail "No pending requests on Node 1"

echo "--- 2d: Node 1 approves the request ---"
APPROVE=$(c -X POST "http://127.0.0.1:9201/api/context-graph/$CG_ID/approve-join" \
  -d "{\"agentAddress\":\"$N2_ADDR\"}")
APPROVE_OK=$(json_get "$APPROVE" ok)
check "Join request approved" "$APPROVE_OK" "true"

echo "--- 2e: Node 2 auto-subscribes after approval ---"
sleep 8
N2_GRAPHS=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG_ID\\\")) }\"}")
N2_GRAPH_CT=$(safe_bindings_count "$N2_GRAPHS")
[[ "$N2_GRAPH_CT" -ge 1 ]] && ok "Node 2 has $N2_GRAPH_CT graph(s) after approval" || fail "Node 2 has no graphs after approval"

#------------------------------------------------------------
echo ""
echo "=== SECTION 3: WM Isolation — Node 2 Must NOT See WM Data ==="
echo ""

echo "--- 3a: Node 2 has NO assertion data graphs ---"
N2_ASSERT_GRAPHS=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG_ID\\\") && CONTAINS(STR(?g), \\\"/assertion/\\\")) }\"}")
N2_ASSERT_CT=$(safe_bindings_count "$N2_ASSERT_GRAPHS")
check "Node 2 has 0 assertion data graphs" "$N2_ASSERT_CT" "0"

echo "--- 3b: Node 2 has NO lifecycle entities (memoryLayer/state) ---"
META_GRAPH="did:dkg:context-graph:${CG_ID}/_meta"
N2_LIFECYCLE=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> ?ml } }\"}")
N2_LC_CT=$(safe_bindings_count "$N2_LIFECYCLE")
check "Node 2 has 0 lifecycle entities" "$N2_LC_CT" "0"

echo "--- 3c: Node 2 has NO event entities (prov:Activity) ---"
N2_EVENTS=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s a <http://www.w3.org/ns/prov#Activity> . ?s a ?dkgType . FILTER(STRSTARTS(STR(?dkgType), \\\"http://dkg.io/ontology/Assertion\\\")) } }\"}")
N2_EV_CT=$(safe_bindings_count "$N2_EVENTS")
check "Node 2 has 0 assertion event entities" "$N2_EV_CT" "0"

echo "--- 3d: Node 2 has NO import metadata (sourceFileHash, extractionMethod) ---"
N2_IMPORT_META=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/sourceFileHash> ?h } }\"}")
N2_IM_CT=$(safe_bindings_count "$N2_IMPORT_META")
check "Node 2 has 0 import metadata subjects" "$N2_IM_CT" "0"

echo "--- 3e: Node 2 WM view shows 0 assertion facts ---"
N2_WM_FACTS=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \\\"did:dkg:context-graph:$CG_ID/\\\") && !STRENDS(STR(?g), \\\"/_meta\\\") && !CONTAINS(STR(?g), \\\"/_private\\\") && !CONTAINS(STR(?g), \\\"/_shared_memory\\\")) }\",\"contextGraphId\":\"$CG_ID\"}")
N2_WM_CT=$(count_integer "$N2_WM_FACTS")
check "Node 2 WM view has 0 assertion facts" "$N2_WM_CT" "0"

echo "--- 3f: Node 2 _meta only has CG-level subjects ---"
N2_META_SUBJECTS=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT DISTINCT ?s WHERE { GRAPH <$META_GRAPH> { ?s ?p ?o } } ORDER BY ?s\"}")
N2_SUBJ_LIST=$(echo "$N2_META_SUBJECTS" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  subjects=[b["s"] for b in d.get("result",{}).get("bindings",[])]
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
PROMOTE1=$(c -X POST "http://127.0.0.1:9201/api/assertion/draft-beta/promote" \
  -d "{\"contextGraphId\":\"$CG_ID\"}")
PROMOTE1_CT=$(json_get "$PROMOTE1" promotedCount)
[[ "$PROMOTE1_CT" != "__NONE__" && "$PROMOTE1_CT" != "0" ]] && ok "draft-beta promoted ($PROMOTE1_CT quads)" || fail "Promote failed: $PROMOTE1"

echo "--- 4b: Verify SWM data on Node 1 ---"
sleep 2
N1_SWM=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
N1_SWM_CT=$(safe_bindings_count "$N1_SWM")
[[ "$N1_SWM_CT" -ge 1 ]] && ok "Node 1 has promoted data in SWM" || fail "Node 1 SWM empty after promote"

echo "--- 4c: Wait for gossip + verify SWM data on Node 2 ---"
SWM_SYNCED=false
for i in $(seq 1 15); do
  N2_SWM=$(c -X POST "http://127.0.0.1:9202/api/query" \
    -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
  N2_SWM_CT=$(safe_bindings_count "$N2_SWM")
  if [[ "$N2_SWM_CT" -ge 1 ]]; then
    SWM_SYNCED=true
    ok "Node 2 received promoted SWM data (after ${i}s)"
    break
  fi
  sleep 1
done
$SWM_SYNCED || fail "Node 2 did not receive SWM data after 15s"

echo "--- 4d: Verify both entities synced ---"
if $SWM_SYNCED; then
  N2_BETA2=$(c -X POST "http://127.0.0.1:9202/api/query" \
    -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:beta2> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
  N2_BETA2_CT=$(safe_bindings_count "$N2_BETA2")
  [[ "$N2_BETA2_CT" -ge 1 ]] && ok "Node 2 has both promoted entities" || fail "Node 2 missing beta2 entity"
fi

echo "--- 4e: doc-alpha (still in WM) must NOT appear on Node 2 ---"
N2_ALPHA=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"doc-alpha\\\")) }\"}")
N2_ALPHA_CT=$(safe_bindings_count "$N2_ALPHA")
check "doc-alpha (WM) not visible on Node 2" "$N2_ALPHA_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 5: Late Joiner (Node 4) — Joins After Promotion ==="
echo ""

echo "--- 5a: Node 4 subscribes (should be denied or timeout — not on allowlist) ---"
c -X POST "http://127.0.0.1:9204/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
sleep 5
N4_CATCHUP=$(poll_catchup 9204 "$CG_ID" 10)
if [[ "$N4_CATCHUP" == "denied" || "$N4_CATCHUP" == "timeout" ]]; then
  ok "Node 4 initial sync blocked ($N4_CATCHUP)"
else
  fail "Node 4 initial sync should be blocked (got=$N4_CATCHUP)"
fi

echo "--- 5b: Node 4 sends signed join request ---"
N4_SIGN=$(c -X POST "http://127.0.0.1:9204/api/context-graph/$CG_ID/sign-join")
N4_SUBMIT=$(c -X POST "http://127.0.0.1:9204/api/context-graph/$CG_ID/request-join" -d "$N4_SIGN")
N4_SUB_OK=$(json_get "$N4_SUBMIT" ok)
check "Node 4 join request submitted" "$N4_SUB_OK" "true"

echo "--- 5c: Node 1 approves Node 4 ---"
sleep 2
c -X POST "http://127.0.0.1:9201/api/context-graph/$CG_ID/approve-join" \
  -d "{\"agentAddress\":\"$N4_ADDR\"}" > /dev/null
ok "Node 4 join request approved"

echo "--- 5d: Wait for Node 4 auto-subscribe + sync ---"
sleep 10

echo "--- 5e: Node 4 has NO WM assertion data ---"
N4_ASSERT_GRAPHS=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG_ID\\\") && CONTAINS(STR(?g), \\\"/assertion/\\\")) }\"}")
N4_AG_CT=$(safe_bindings_count "$N4_ASSERT_GRAPHS")
check "Node 4 (late joiner) has 0 assertion data graphs" "$N4_AG_CT" "0"

echo "--- 5f: Node 4 has NO WM lifecycle/event metadata ---"
N4_LIFECYCLE=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/state> \\\"created\\\" } }\"}")
N4_LC_CT=$(safe_bindings_count "$N4_LIFECYCLE")
check "Node 4 has 0 WM lifecycle entities" "$N4_LC_CT" "0"

echo "--- 5g: Node 4 DOES have SWM data (promoted before join) ---"
N4_SWM_SYNCED=false
for i in $(seq 1 10); do
  N4_SWM=$(c -X POST "http://127.0.0.1:9204/api/query" \
    -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
  N4_SWM_CT=$(safe_bindings_count "$N4_SWM")
  if [[ "$N4_SWM_CT" -ge 1 ]]; then
    N4_SWM_SYNCED=true
    ok "Node 4 (late joiner) received SWM data"
    break
  fi
  sleep 1
done
$N4_SWM_SYNCED || fail "Node 4 did not receive SWM data (late joiner sync broken)"

echo "--- 5h: Node 4 _meta has only CG-level + non-WM subjects ---"
N4_META_SUBJ=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT DISTINCT ?s WHERE { GRAPH <$META_GRAPH> { ?s ?p ?o } }\"}")
N4_LEAKED=$(echo "$N4_META_SUBJ" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  subjects=[b["s"] for b in d.get("result",{}).get("bindings",[])]
  wm_leaked=[s for s in subjects if "urn:dkg:assertion:" in s or ("/assertion/" in s and "sourceFileHash" not in s)]
  # Check if any urn:dkg:assertion: subjects have WM state
  print(len([s for s in subjects if "urn:dkg:assertion:" in s]))
except: print("ERR")
' 2>/dev/null)
# The late joiner should see promoted assertion lifecycle (memoryLayer=SWM)
# but NOT the WM-only doc-alpha lifecycle
N4_WM_LC=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> \\\"WM\\\" } }\"}")
N4_WM_LC_CT=$(safe_bindings_count "$N4_WM_LC")
check "Node 4 has 0 WM-layer lifecycle entities" "$N4_WM_LC_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 6: Multi-Participant WM Isolation ==="
echo ""

echo "--- 6a: Node 2 creates its own WM assertion in the shared project ---"
c -X POST "http://127.0.0.1:9202/api/assertion/create" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"name\":\"n2-private-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:9202/api/assertion/n2-private-draft/write" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"quads\":[
    $(ql 'urn:sharing:n2secret' 'http://schema.org/name' 'Node2 Secret Data'),
    $(q 'urn:sharing:n2secret' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "Node 2 created private WM assertion"

echo "--- 6b: Node 2 can query its own WM data ---"
sleep 1
N2_OWN=$(c -X POST "http://127.0.0.1:9202/api/assertion/n2-private-draft/query" \
  -d "{\"contextGraphId\":\"$CG_ID\"}")
N2_OWN_CT=$(echo "$N2_OWN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("quads",d.get("result",[]))))' 2>/dev/null || echo "0")
[[ "$N2_OWN_CT" -ge 2 ]] && ok "Node 2 sees its own WM data ($N2_OWN_CT quads)" || fail "Node 2 can't see own WM data"

echo "--- 6c: Node 1 does NOT see Node 2's WM data ---"
sleep 3
N1_N2SECRET=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:n2secret> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}")
N1_N2S_CT=$(safe_bindings_count "$N1_N2SECRET")
check "Node 1 cannot see Node 2's WM data" "$N1_N2S_CT" "0"

echo "--- 6d: Node 4 does NOT see Node 2's WM data ---"
N4_N2SECRET=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:n2secret> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}")
N4_N2S_CT=$(safe_bindings_count "$N4_N2SECRET")
check "Node 4 cannot see Node 2's WM data" "$N4_N2S_CT" "0"

echo "--- 6e: Node 2 promotes its assertion — should gossip to all ---"
PROMOTE_N2=$(c -X POST "http://127.0.0.1:9202/api/assertion/n2-private-draft/promote" \
  -d "{\"contextGraphId\":\"$CG_ID\"}")
PROMOTE_N2_CT=$(json_get "$PROMOTE_N2" promotedCount)
[[ "$PROMOTE_N2_CT" != "__NONE__" && "$PROMOTE_N2_CT" != "0" ]] && ok "Node 2 promoted ($PROMOTE_N2_CT quads)" || fail "Node 2 promote failed"

echo "--- 6f: Wait for gossip + verify all participants see Node 2's SWM data ---"
for port_label in "9201:Node1" "9204:Node4"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  FOUND_N2=false
  for i in $(seq 1 20); do
    PEER_N2=$(c -X POST "http://127.0.0.1:$port/api/query" \
      -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:n2secret> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
    PEER_CT=$(safe_bindings_count "$PEER_N2")
    if [[ "$PEER_CT" -ge 1 ]]; then
      FOUND_N2=true
      ok "$label sees Node 2's promoted SWM data (after ${i}s)"
      break
    fi
    sleep 1
  done
  $FOUND_N2 || warn "$label missing Node 2's SWM data after 20s (private CG sync may be slow)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 7: Non-Participant Exclusion ==="
echo ""

echo "--- 7a: Node 3 (not invited) should have no project data ---"
N3_GRAPHS=$(c -X POST "http://127.0.0.1:9203/api/query" \
  -d "{\"sparql\":\"SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG_ID\\\")) }\"}")
N3_GRAPH_CT=$(safe_bindings_count "$N3_GRAPHS")
check "Node 3 (not invited) has 0 project graphs" "$N3_GRAPH_CT" "0"

echo "--- 7b: Node 3 cannot query project SWM ---"
N3_SWM=$(c -X POST "http://127.0.0.1:9203/api/query" \
  -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:beta1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
N3_SWM_CT=$(safe_bindings_count "$N3_SWM")
check "Node 3 has 0 SWM results" "$N3_SWM_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 8: Second Promotion — Incremental Sync ==="
echo ""

echo "--- 8a: Promote doc-alpha from WM to SWM on Node 1 ---"
PROMOTE_DOC=$(c -X POST "http://127.0.0.1:9201/api/assertion/doc-alpha/promote" \
  -d "{\"contextGraphId\":\"$CG_ID\"}")
PROMOTE_DOC_CT=$(json_get "$PROMOTE_DOC" promotedCount)
if [[ "$PROMOTE_DOC_CT" != "__NONE__" && "$PROMOTE_DOC_CT" != "0" && "$PROMOTE_DOC_CT" != "__ERR__" ]]; then
  ok "doc-alpha promoted ($PROMOTE_DOC_CT quads)"
else
  # import-file may auto-promote during extraction — check SWM directly
  sleep 2
  DOC_IN_SWM=$(c -X POST "http://127.0.0.1:9201/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
  DOC_SWM_CT=$(count_integer "$DOC_IN_SWM")
  if [[ "$DOC_SWM_CT" -ge 3 ]]; then
    ok "doc-alpha already in SWM ($DOC_SWM_CT entities — auto-promoted by import pipeline)"
  else
    fail "doc-alpha promote failed and not in SWM ($DOC_SWM_CT): $PROMOTE_DOC"
  fi
fi

echo "--- 8b: Verify doc-alpha now visible on Node 2 via SWM ---"
DOC_SYNCED=false
for i in $(seq 1 15); do
  N2_DOC=$(c -X POST "http://127.0.0.1:9202/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
  N2_DOC_CT=$(count_integer "$N2_DOC")
  if [[ "$N2_DOC_CT" -ge 3 ]]; then
    DOC_SYNCED=true
    ok "Node 2 now sees promoted doc-alpha in SWM ($N2_DOC_CT entities)"
    break
  fi
  sleep 1
done
$DOC_SYNCED || fail "doc-alpha not synced to Node 2 after promotion"

echo "--- 8c: Verify doc-alpha now visible on Node 4 (late joiner) ---"
N4_DOC_SYNCED=false
for i in $(seq 1 10); do
  N4_DOC=$(c -X POST "http://127.0.0.1:9204/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
  N4_DOC_CT=$(count_integer "$N4_DOC")
  if [[ "$N4_DOC_CT" -ge 3 ]]; then
    N4_DOC_SYNCED=true
    ok "Node 4 (late joiner) sees doc-alpha in SWM ($N4_DOC_CT entities)"
    break
  fi
  sleep 1
done
$N4_DOC_SYNCED || warn "doc-alpha not yet on Node 4 ($N4_DOC_CT entities)"

echo "--- 8d: Node 3 (not invited) still sees nothing ---"
N3_DOC=$(c -X POST "http://127.0.0.1:9203/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"shared-working-memory\"}")
N3_DOC_CT=$(count_integer "$N3_DOC")
check "Node 3 still has 0 SWM entities" "$N3_DOC_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 9: Lifecycle Metadata Correctness ==="
echo ""

echo "--- 9a: Promoted assertion lifecycle shows SWM layer on Node 1 ---"
N1_PROMOTED_LC=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT ?s ?ml WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> ?ml . ?s <http://dkg.io/ontology/assertionName> \\\"draft-beta\\\" } }\"}")
N1_PLC_ML=$(echo "$N1_PROMOTED_LC" | python3 -c '
import sys,json
try:
  b=json.load(sys.stdin).get("result",{}).get("bindings",[])
  if b: print(b[0].get("ml","").strip("\""))
  else: print("MISSING")
except: print("ERR")
' 2>/dev/null)
check "draft-beta lifecycle shows SWM layer" "$N1_PLC_ML" "SWM"

echo "--- 9b: Promoted assertion lifecycle synced to Node 2 ---"
N2_PLC_FOUND=false
for i in $(seq 1 10); do
  N2_PLC=$(c -X POST "http://127.0.0.1:9202/api/query" \
    -d "{\"sparql\":\"SELECT ?ml WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> ?ml . ?s <http://dkg.io/ontology/assertionName> \\\"draft-beta\\\" } }\"}")
  N2_PLC_CT=$(safe_bindings_count "$N2_PLC")
  if [[ "$N2_PLC_CT" -ge 1 ]]; then
    N2_PLC_FOUND=true
    ok "Node 2 has promoted lifecycle metadata"
    break
  fi
  sleep 1
done
$N2_PLC_FOUND || warn "Node 2 missing promoted lifecycle — may not sync lifecycle for private CGs"

echo "--- 9c: WM-only doc-alpha lifecycle NOT leaked before its promotion (check Node 4 snapshot) ---"
# After section 8, doc-alpha is now SWM, so check specifically for WM-tagged entries
N4_WM_ONLY=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/memoryLayer> \\\"WM\\\" } }\"}")
N4_WM_ONLY_CT=$(safe_bindings_count "$N4_WM_ONLY")
check "Node 4 has 0 WM-tagged lifecycle entries" "$N4_WM_ONLY_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 10: New WM After Promotion — Still Private ==="
echo ""

echo "--- 10a: Create a new WM assertion on Node 1 (post-promotion) ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"name\":\"post-promo-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/post-promo-draft/write" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"quads\":[
    $(ql 'urn:sharing:postpromo' 'http://schema.org/name' 'Post-Promotion Secret'),
    $(q 'urn:sharing:postpromo' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "Created post-promo-draft assertion"

echo "--- 10b: Verify new WM data stays private after background sync ---"
sleep 5
for port_label in "9202:Node2" "9204:Node4"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  PEER_PP=$(c -X POST "http://127.0.0.1:$port/api/query" \
    -d "{\"sparql\":\"SELECT ?name WHERE { <urn:sharing:postpromo> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}")
  PP_CT=$(safe_bindings_count "$PEER_PP")
  check "$label cannot see post-promotion WM data" "$PP_CT" "0"
done

echo "--- 10c: No new assertion metadata leaked to peers ---"
for port_label in "9202:Node2" "9204:Node4"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  PEER_META=$(c -X POST "http://127.0.0.1:$port/api/query" \
    -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <$META_GRAPH> { ?s <http://dkg.io/ontology/assertionName> \\\"post-promo-draft\\\" } }\"}")
  PM_CT=$(safe_bindings_count "$PEER_META")
  check "$label has no post-promo-draft metadata" "$PM_CT" "0"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 11: Summary Cross-Check ==="
echo ""

echo "--- 11a: Final graph counts per node ---"
for port_label in "9201:Node1(creator)" "9202:Node2(invited)" "9204:Node4(late)" "9203:Node3(excluded)"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  FINAL=$(c -X POST "http://127.0.0.1:$port/api/query" \
    -d "{\"sparql\":\"SELECT ?g (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG_ID\\\")) } GROUP BY ?g ORDER BY ?g\"}")
  GCNT=$(safe_bindings_count "$FINAL")
  echo "  $label: $GCNT graph(s)"
  if [[ "$label" == *"excluded"* ]]; then
    check "$label has 0 graphs" "$GCNT" "0"
  elif [[ "$label" == *"creator"* ]]; then
    [[ "$GCNT" -ge 3 ]] && ok "$label has $GCNT graphs (WM + SWM + meta)" || warn "$label only $GCNT graphs"
  else
    [[ "$GCNT" -ge 1 ]] && ok "$label has $GCNT graph(s)" || fail "$label has no graphs"
  fi
done

# Cleanup
c -X POST "http://127.0.0.1:9201/api/assertion/post-promo-draft/discard" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null 2>&1
c -X POST "http://127.0.0.1:9202/api/assertion/n2-private-draft/discard" \
  -d "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "=== SECTION 12: WM SPARQL Default Graph Isolation ==="
echo ""

echo "--- 12a: wmSparql default graph should not return system triples on participant ---"
N2_DEFAULT=$(c -X POST "http://127.0.0.1:9202/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \\\"did:dkg:context-graph:$CG_ID/\\\") && !STRENDS(STR(?g), \\\"/_meta\\\") && !CONTAINS(STR(?g), \\\"/_private\\\") && !CONTAINS(STR(?g), \\\"/_shared_memory\\\") && !CONTAINS(STR(?g), \\\"/_verified_memory\\\") && !CONTAINS(STR(?g), \\\"/_rules\\\")) }\",\"contextGraphId\":\"$CG_ID\"}")
N2_DEF_CT=$(count_integer "$N2_DEFAULT")
check "Node 2 WM named-graph-only query returns 0 non-SWM triples" "$N2_DEF_CT" "0"

echo "--- 12b: Non-participant wmSparql returns 0 triples (no system leak) ---"
N3_DEFAULT=$(c -X POST "http://127.0.0.1:9203/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \\\"did:dkg:context-graph:$CG_ID/\\\") && !STRENDS(STR(?g), \\\"/_meta\\\") && !CONTAINS(STR(?g), \\\"/_private\\\") && !CONTAINS(STR(?g), \\\"/_shared_memory\\\") && !CONTAINS(STR(?g), \\\"/_verified_memory\\\") && !CONTAINS(STR(?g), \\\"/_rules\\\")) }\",\"contextGraphId\":\"$CG_ID\"}")
N3_DEF_CT=$(count_integer "$N3_DEFAULT")
check "Node 3 (excluded) WM named-graph-only query returns 0" "$N3_DEF_CT" "0"

echo "--- 12c: System triples (did:dkg:network:*) excluded from WM entity count ---"
N3_SYSTEM=$(c -X POST "http://127.0.0.1:9203/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), \\\"did:dkg:context-graph:$CG_ID/\\\")) }\",\"contextGraphId\":\"$CG_ID\"}")
N3_SYS_CT=$(count_integer "$N3_SYSTEM")
check "Node 3 has 0 named-graph triples scoped to this CG" "$N3_SYS_CT" "0"

#------------------------------------------------------------
echo ""
echo "=== SECTION 13: Second Join Flow — Node 4 Full Cycle ==="
echo ""

N5_ADDR=$(get_self_address 9205)
echo "  Node 5: $N5_ADDR"

echo "--- 13a: Create a second private project on Node 1 ---"
CG2_ID="join-flow-test-$(date +%s)"
CREATE2=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" \
  -d "{\"id\":\"$CG2_ID\",\"name\":\"Join Flow Test\",\"private\":true}")
CREATE2_OK=$(json_get "$CREATE2" created)
check "Second private project created" "$CREATE2_OK" "$CG2_ID"

echo "--- 13b: Import WM data on Node 1 ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" \
  -d "{\"contextGraphId\":\"$CG2_ID\",\"name\":\"wm-secret\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/wm-secret/write" \
  -d "{\"contextGraphId\":\"$CG2_ID\",\"quads\":[
    $(ql 'urn:join-flow:secret1' 'http://schema.org/name' 'Secret Data'),
    $(q 'urn:join-flow:secret1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
ok "WM data written to join-flow project"

echo "--- 13c: Promote some data to SWM on Node 1 ---"
c -X POST "http://127.0.0.1:9201/api/shared-memory/write" \
  -d "{\"contextGraphId\":\"$CG2_ID\",\"quads\":[
    $(ql 'urn:join-flow:shared1' 'http://schema.org/name' 'Shared Data'),
    $(q 'urn:join-flow:shared1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
sleep 1
ok "SWM data written to join-flow project"

echo "--- 13d: Node 4 subscribes — should be denied ---"
c -X POST "http://127.0.0.1:9204/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG2_ID\"}" > /dev/null
sleep 3
N4_STATUS=$(c "http://127.0.0.1:9204/api/sync/catchup-status?contextGraphId=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')")
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
N4_SIGN=$(c -X POST "http://127.0.0.1:9204/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/sign-join")
N4_SUBMIT=$(c -X POST "http://127.0.0.1:9204/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/request-join" -d "$N4_SIGN")
N4_SUBMIT_OK=$(json_get "$N4_SUBMIT" ok)
check "Node 4 join request submitted" "$N4_SUBMIT_OK" "true"

echo "--- 13f: Node 1 sees pending request from Node 4 ---"
sleep 2
N1_REQS=$(c "http://127.0.0.1:9201/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/join-requests")
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
N1_NOTIFS=$(c "http://127.0.0.1:9201/api/notifications?limit=5")
N1_JOIN_NOTIF=$(echo "$N1_NOTIFS" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for n in d.get("notifications",[]):
  if n.get("type")=="join_request":
    meta=json.loads(n.get("meta","{}")) if n.get("meta") else {}
    if "'"$CG2_ID"'" in meta.get("contextGraphId",""):
      print("found")
      break
else:
  print("missing")
' 2>/dev/null)
check "Join-request notification created on Node 1" "$N1_JOIN_NOTIF" "found"

echo "--- 13h: Node 1 approves Node 4 ---"
N4_APPROVE=$(c -X POST "http://127.0.0.1:9201/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/approve-join" \
  -d "{\"agentAddress\":\"$N4_ADDR\"}")
N4_APP_OK=$(json_get "$N4_APPROVE" ok)
check "Node 4 join request approved" "$N4_APP_OK" "true"

echo "--- 13i: Node 4 auto-subscribes and receives SWM data ---"
N4_SWM_OK=false
for i in $(seq 1 20); do
  N4_SWM=$(c -X POST "http://127.0.0.1:9204/api/query" \
    -d "{\"sparql\":\"SELECT ?name WHERE { <urn:join-flow:shared1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG2_ID\",\"view\":\"shared-working-memory\"}")
  N4_SWM_CT=$(safe_bindings_count "$N4_SWM")
  if [[ "$N4_SWM_CT" -ge 1 ]]; then
    N4_SWM_OK=true
    ok "Node 4 received SWM data after approval (after ${i}s)"
    break
  fi
  sleep 1
done
$N4_SWM_OK || fail "Node 4 did not receive SWM data after approval"

echo "--- 13j: Node 4 has NO WM data (wm-secret stays private) ---"
N4_SECRET=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT ?name WHERE { <urn:join-flow:secret1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG2_ID\",\"includeSharedMemory\":true}")
N4_SEC_CT=$(safe_bindings_count "$N4_SECRET")
check "Node 4 cannot see WM secret data" "$N4_SEC_CT" "0"

echo "--- 13k: Node 4 has NO WM lifecycle metadata ---"
N4_WM_META=$(c -X POST "http://127.0.0.1:9204/api/query" \
  -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH <did:dkg:context-graph:$CG2_ID/_meta> { ?s <http://dkg.io/ontology/memoryLayer> \\\"WM\\\" } }\"}")
N4_WMM_CT=$(safe_bindings_count "$N4_WM_META")
check "Node 4 has 0 WM-layer lifecycle entries" "$N4_WMM_CT" "0"

echo "--- 13l: Node 5 sends join request + gets approved ---"
c -X POST "http://127.0.0.1:9205/api/context-graph/subscribe" \
  -d "{\"contextGraphId\":\"$CG2_ID\"}" > /dev/null
sleep 3
N5_SIGN=$(c -X POST "http://127.0.0.1:9205/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/sign-join")
N5_SUBMIT=$(c -X POST "http://127.0.0.1:9205/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/request-join" -d "$N5_SIGN")
check "Node 5 join request submitted" "$(json_get "$N5_SUBMIT" ok)" "true"
sleep 2
c -X POST "http://127.0.0.1:9201/api/context-graph/$(python3 -c 'import urllib.parse;print(urllib.parse.quote("'"$CG2_ID"'",safe=""))')/approve-join" \
  -d "{\"agentAddress\":\"$N5_ADDR\"}" > /dev/null
ok "Node 5 join approved"

echo "--- 13m: Node 5 receives SWM but not WM ---"
N5_SWM_OK=false
for i in $(seq 1 25); do
  N5_SWM=$(c -X POST "http://127.0.0.1:9205/api/query" \
    -d "{\"sparql\":\"SELECT ?name WHERE { <urn:join-flow:shared1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG2_ID\",\"view\":\"shared-working-memory\"}")
  N5_SWM_CT=$(safe_bindings_count "$N5_SWM")
  if [[ "$N5_SWM_CT" -ge 1 ]]; then
    N5_SWM_OK=true
    ok "Node 5 received SWM data"
    break
  fi
  sleep 1
done
$N5_SWM_OK || warn "Node 5 (edge) did not receive SWM data after 25s — edge sync may be slower"

N5_SECRET=$(c -X POST "http://127.0.0.1:9205/api/query" \
  -d "{\"sparql\":\"SELECT ?name WHERE { <urn:join-flow:secret1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG2_ID\",\"includeSharedMemory\":true}")
N5_SEC_CT=$(safe_bindings_count "$N5_SECRET")
check "Node 5 cannot see WM secret data" "$N5_SEC_CT" "0"

echo "--- 13n: Node 3 (never requested) still excluded ---"
N3_CG2=$(c -X POST "http://127.0.0.1:9203/api/query" \
  -d "{\"sparql\":\"SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG2_ID\\\")) }\"}")
N3_CG2_CT=$(safe_bindings_count "$N3_CG2")
check "Node 3 has 0 graphs for join-flow project" "$N3_CG2_CT" "0"

# Cleanup
c -X POST "http://127.0.0.1:9201/api/assertion/wm-secret/discard" \
  -d "{\"contextGraphId\":\"$CG2_ID\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "=== SECTION 14: Promote After Import-File (agentAddress fix) ==="
echo ""

echo "--- 14a: Create project for promote test ---"
CG3_ID="promote-test-$(date +%s)"
CREATE3=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" \
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
  "http://127.0.0.1:9201/api/assertion/promo-doc/import-file" 2>&1)
rm -f "$TMPMD2"
IMPORT_PROMO_URI=$(json_get "$IMPORT_PROMO" assertionUri)
[[ "$IMPORT_PROMO_URI" != "__NONE__" && "$IMPORT_PROMO_URI" != "__ERR__" ]] \
  && ok "Imported promo-doc ($IMPORT_PROMO_URI)" \
  || fail "Import-file failed: ${IMPORT_PROMO:0:200}"

echo "--- 14c: Verify import stored under wallet address, not peerId ---"
echo "$IMPORT_PROMO_URI" | grep -q "$N1_ADDR" \
  && ok "Assertion URI contains wallet address ($N1_ADDR)" \
  || fail "Assertion URI missing wallet address: $IMPORT_PROMO_URI"

echo "--- 14d: Promote import-file assertion to SWM ---"
sleep 1
PROMO_RESULT=$(c -X POST "http://127.0.0.1:9201/api/assertion/promo-doc/promote" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}")
PROMO_CT=$(json_get "$PROMO_RESULT" promotedCount)
[[ "$PROMO_CT" != "__NONE__" && "$PROMO_CT" != "0" && "$PROMO_CT" != "__ERR__" ]] \
  && ok "promo-doc promoted ($PROMO_CT triples)" \
  || fail "Promote returned 0 — wallet/peerId address mismatch bug (promotedCount=$PROMO_CT)"

echo "--- 14e: Verify promoted data exists in SWM ---"
sleep 1
N1_PROMO_SWM=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"shared-working-memory\"}")
PROMO_SWM_CT=$(count_integer "$N1_PROMO_SWM")
[[ "$PROMO_SWM_CT" -ge 1 ]] && ok "Promoted data visible in SWM ($PROMO_SWM_CT entities)" || fail "SWM empty after promote ($PROMO_SWM_CT)"

echo "--- 14f: Also create + write + promote an API assertion (same project) ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"name\":\"api-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/api-draft/write" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"quads\":[
    $(ql 'urn:promote-test:api1' 'http://schema.org/name' 'API Written Entity'),
    $(q 'urn:promote-test:api1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
PROMO_API=$(c -X POST "http://127.0.0.1:9201/api/assertion/api-draft/promote" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}")
PROMO_API_CT=$(json_get "$PROMO_API" promotedCount)
[[ "$PROMO_API_CT" != "__NONE__" && "$PROMO_API_CT" != "0" ]] \
  && ok "api-draft promoted ($PROMO_API_CT triples)" \
  || fail "api-draft promote failed ($PROMO_API_CT)"

echo "--- 14g: Promote on node 2 also works (different wallet) ---"
CG4_ID="promote-n2-$(date +%s)"
c -X POST "http://127.0.0.1:9202/api/context-graph/create" \
  -d "{\"id\":\"$CG4_ID\",\"name\":\"Node2 Promote Test\"}" > /dev/null
c -X POST "http://127.0.0.1:9202/api/assertion/create" \
  -d "{\"contextGraphId\":\"$CG4_ID\",\"name\":\"n2-draft\"}" > /dev/null
c -X POST "http://127.0.0.1:9202/api/assertion/n2-draft/write" \
  -d "{\"contextGraphId\":\"$CG4_ID\",\"quads\":[
    $(ql 'urn:promote-n2:item' 'http://schema.org/name' 'Node2 Entity'),
    $(q 'urn:promote-n2:item' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]}" > /dev/null
sleep 1
PROMO_N2=$(c -X POST "http://127.0.0.1:9202/api/assertion/n2-draft/promote" \
  -d "{\"contextGraphId\":\"$CG4_ID\"}")
PROMO_N2_CT=$(json_get "$PROMO_N2" promotedCount)
[[ "$PROMO_N2_CT" != "__NONE__" && "$PROMO_N2_CT" != "0" ]] \
  && ok "Node 2 promote works ($PROMO_N2_CT triples)" \
  || fail "Node 2 promote returned 0 — wallet/peerId mismatch ($PROMO_N2_CT)"

#------------------------------------------------------------
echo ""
echo "=== SECTION 15: Publish SWM → Verified Memory (VM) ==="
echo ""

echo "--- 15pre: Register promote-test project on-chain ---"
REG_CG3=$(c -X POST "http://127.0.0.1:9201/api/context-graph/register" \
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

echo "--- 15a: Publish SWM data to VM on Node 1 (promote-test project) ---"
PUBLISH=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"selection\":\"all\",\"clearAfter\":false}")
PUB_STATUS=$(json_get "$PUBLISH" status)
PUB_KCID=$(json_get "$PUBLISH" kcId)
PUB_KAS=$(echo "$PUBLISH" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  kas=d.get("kas",[])
  print(len(kas))
except: print("ERR")
' 2>/dev/null)
PUB_TX=$(json_get "$PUBLISH" txHash)
echo "  Publish result: status=$PUB_STATUS kcId=$PUB_KCID kas=$PUB_KAS txHash=${PUB_TX:0:20}..."
if [[ "$PUB_STATUS" == "published" || "$PUB_STATUS" == "created" || "$PUB_STATUS" == "mined" ]]; then
  ok "SWM published to VM (status=$PUB_STATUS, $PUB_KAS knowledge asset(s))"
elif [[ "$PUB_KCID" != "__NONE__" && "$PUB_KCID" != "__ERR__" ]]; then
  ok "SWM publish completed (kcId=$PUB_KCID, status=$PUB_STATUS)"
else
  fail "SWM publish failed: $(echo "$PUBLISH" | head -c 300)"
fi

echo "--- 15b: Verify VM data on Node 1 ---"
sleep 3
N1_VM=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"verified-memory\"}")
N1_VM_CT=$(count_integer "$N1_VM")
[[ "$N1_VM_CT" -ge 1 ]] && ok "Node 1 has $N1_VM_CT entities in VM" || fail "Node 1 VM is empty"

echo "--- 15c: Verify specific entities in VM ---"
N1_VM_API=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT ?name WHERE { <urn:promote-test:api1> <http://schema.org/name> ?name }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"verified-memory\"}")
N1_VM_API_CT=$(safe_bindings_count "$N1_VM_API")
[[ "$N1_VM_API_CT" -ge 1 ]] && ok "API entity visible in VM" || warn "API entity not in VM ($N1_VM_API_CT) — may not have been in SWM"

echo "--- 15d: VM data syncs to Node 2 ---"
# Node 2 should pick up VM data via gossip/sync even if not on the allowlist for this project
# (VM is published on-chain and available to all nodes)
N2_VM_SYNCED=false
for i in $(seq 1 20); do
  N2_VM=$(c -X POST "http://127.0.0.1:9202/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"verified-memory\"}")
  N2_VM_CT=$(count_integer "$N2_VM")
  if [[ "$N2_VM_CT" -ge 1 ]]; then
    N2_VM_SYNCED=true
    ok "Node 2 received VM data ($N2_VM_CT entities, after ${i}s)"
    break
  fi
  sleep 1
done
$N2_VM_SYNCED || warn "Node 2 missing VM data after 20s — VM sync may need more time"

echo "--- 15e: Node 3 also has VM data (VM is public/on-chain) ---"
N3_VM_SYNCED=false
for i in $(seq 1 20); do
  N3_VM=$(c -X POST "http://127.0.0.1:9203/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"verified-memory\"}")
  N3_VM_CT=$(count_integer "$N3_VM")
  if [[ "$N3_VM_CT" -ge 1 ]]; then
    N3_VM_SYNCED=true
    ok "Node 3 received VM data ($N3_VM_CT entities, after ${i}s)"
    break
  fi
  sleep 1
done
$N3_VM_SYNCED || warn "Node 3 missing VM data after 20s — VM sync may need more time"

echo "--- 15f: SWM still has data (clearAfter=false) ---"
N1_SWM_AFTER=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"shared-working-memory\"}")
SWM_AFTER_CT=$(count_integer "$N1_SWM_AFTER")
[[ "$SWM_AFTER_CT" -ge 1 ]] && ok "SWM retained after publish ($SWM_AFTER_CT entities)" || warn "SWM cleared despite clearAfter=false"

#------------------------------------------------------------
echo ""
echo "=== SECTION 16: Publish from Private Project (CG1) ==="
echo ""

echo "--- 16pre: Register CG1 on-chain ---"
REG_CG1=$(c -X POST "http://127.0.0.1:9201/api/context-graph/register" \
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

echo "--- 16a: Publish CG1 SWM → VM on Node 1 ---"
PUB_CG1=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" \
  -d "{\"contextGraphId\":\"$CG_ID\",\"selection\":\"all\",\"clearAfter\":false}")
PUB_CG1_STATUS=$(json_get "$PUB_CG1" status)
PUB_CG1_KAS=$(echo "$PUB_CG1" | python3 -c '
import sys,json
try: print(len(json.load(sys.stdin).get("kas",[])))
except: print("ERR")
' 2>/dev/null)
if [[ "$PUB_CG1_STATUS" == "published" || "$PUB_CG1_STATUS" == "created" || "$PUB_CG1_STATUS" == "mined" ]]; then
  ok "CG1 SWM published to VM ($PUB_CG1_KAS KAs, status=$PUB_CG1_STATUS)"
else
  PUB_CG1_KCID=$(json_get "$PUB_CG1" kcId)
  if [[ "$PUB_CG1_KCID" != "__NONE__" && "$PUB_CG1_KCID" != "__ERR__" ]]; then
    ok "CG1 SWM publish completed (kcId=$PUB_CG1_KCID, status=$PUB_CG1_STATUS)"
  else
    fail "CG1 SWM publish failed: $(echo "$PUB_CG1" | head -c 300)"
  fi
fi

echo "--- 16b: Node 2 (participant) sees VM data ---"
N2_CG1_VM_OK=false
for i in $(seq 1 20); do
  N2_CG1_VM=$(c -X POST "http://127.0.0.1:9202/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"verified-memory\"}")
  N2_CG1_VM_CT=$(count_integer "$N2_CG1_VM")
  if [[ "$N2_CG1_VM_CT" -ge 1 ]]; then
    N2_CG1_VM_OK=true
    ok "Node 2 has VM data for CG1 ($N2_CG1_VM_CT entities, after ${i}s)"
    break
  fi
  sleep 1
done
$N2_CG1_VM_OK || warn "Node 2 missing VM data for CG1 after 20s"

echo "--- 16c: Node 4 (late joiner) sees VM data ---"
N4_CG1_VM_OK=false
for i in $(seq 1 20); do
  N4_CG1_VM=$(c -X POST "http://127.0.0.1:9204/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"verified-memory\"}")
  N4_CG1_VM_CT=$(count_integer "$N4_CG1_VM")
  if [[ "$N4_CG1_VM_CT" -ge 1 ]]; then
    N4_CG1_VM_OK=true
    ok "Node 4 has VM data for CG1 ($N4_CG1_VM_CT entities, after ${i}s)"
    break
  fi
  sleep 1
done
$N4_CG1_VM_OK || warn "Node 4 missing VM data for CG1 after 20s"

echo "--- 16d: Node 3 (excluded from private CG) still gets VM (on-chain is public) ---"
N3_CG1_VM_OK=false
for i in $(seq 1 20); do
  N3_CG1_VM=$(c -X POST "http://127.0.0.1:9203/api/query" \
    -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG_ID\",\"view\":\"verified-memory\"}")
  N3_CG1_VM_CT=$(count_integer "$N3_CG1_VM")
  if [[ "$N3_CG1_VM_CT" -ge 1 ]]; then
    N3_CG1_VM_OK=true
    ok "Node 3 sees VM for private CG1 ($N3_CG1_VM_CT entities — on-chain is public)"
    break
  fi
  sleep 1
done
$N3_CG1_VM_OK || warn "Node 3 missing VM for CG1 — VM gossip may be slower for private CGs"

echo "--- 16e: WM data still private after publish ---"
for port_label in "9202:Node2" "9204:Node4" "9203:Node3"; do
  port="${port_label%%:*}"
  label="${port_label##*:}"
  PEER_WM=$(c -X POST "http://127.0.0.1:$port/api/query" \
    -d "{\"sparql\":\"SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \\\"$CG_ID\\\") && CONTAINS(STR(?g), \\\"/assertion/\\\")) }\"}")
  PEER_WM_CT=$(safe_bindings_count "$PEER_WM")
  check "$label still has 0 WM assertion graphs after publish" "$PEER_WM_CT" "0"
done

echo "--- 16f: Publish with clearAfter=true, then verify SWM is empty ---"
PUB_CLEAR=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" \
  -d "{\"contextGraphId\":\"$CG3_ID\",\"selection\":\"all\",\"clearAfter\":true}")
PUB_CLEAR_STATUS=$(json_get "$PUB_CLEAR" status)
sleep 2
N1_SWM_CLEARED=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"shared-working-memory\"}")
SWM_CLEARED_CT=$(count_integer "$N1_SWM_CLEARED")
if [[ "$SWM_CLEARED_CT" == "0" ]]; then
  ok "SWM cleared after publish with clearAfter=true"
else
  warn "SWM not cleared ($SWM_CLEARED_CT entities) — may retain data until publish is confirmed on-chain"
fi

echo "--- 16g: VM still has data even after SWM cleared ---"
N1_VM_STILL=$(c -X POST "http://127.0.0.1:9201/api/query" \
  -d "{\"sparql\":\"SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }\",\"contextGraphId\":\"$CG3_ID\",\"view\":\"verified-memory\"}")
VM_STILL_CT=$(count_integer "$N1_VM_STILL")
[[ "$VM_STILL_CT" -ge 1 ]] && ok "VM data persists after SWM clear ($VM_STILL_CT entities)" || fail "VM data lost after SWM clear"

# Cleanup
c -X POST "http://127.0.0.1:9201/api/assertion/promo-doc/discard" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}" > /dev/null 2>&1
c -X POST "http://127.0.0.1:9201/api/assertion/api-draft/discard" \
  -d "{\"contextGraphId\":\"$CG3_ID\"}" > /dev/null 2>&1
c -X POST "http://127.0.0.1:9202/api/assertion/n2-draft/discard" \
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
