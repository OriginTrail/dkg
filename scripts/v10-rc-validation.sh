#!/usr/bin/env bash
set -euo pipefail

AUTH="${DKG_AUTH:-i4xSYqGXePm6DCCc6WHPfnccw2cb8iv9Z3dg5HBNY}"
H="Authorization: Bearer $AUTH"
PASS=0; FAIL=0; WARN=0; TOTAL=0

ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $*"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $*"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️  $*"; }

api() { curl -s -H "$H" "$@"; }
post() { local port=$1; shift; api -X POST "http://127.0.0.1:$port$@"; }
get()  { local port=$1; shift; api "http://127.0.0.1:$port$@"; }

section() { echo ""; echo "━━━ $* ━━━"; }

q()  { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"$3\",\"graph\":\"\"}"; }
ql() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"\\\"$3\\\"\",\"graph\":\"\"}"; }

CG="devnet-test"

section "1. NODE HEALTH & CONNECTIVITY"

for port in 9201 9202 9203 9204 9205; do
  STATUS=$(get $port /api/status 2>/dev/null || echo '{}')
  NAME=$(echo "$STATUS" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("name","?"))' 2>/dev/null || echo 'error')
  ROLE=$(echo "$STATUS" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("nodeRole","?"))' 2>/dev/null || echo 'error')
  if [ "$NAME" != "error" ] && [ "$NAME" != "?" ]; then
    ok "Node $port ($NAME, $ROLE) healthy"
  else
    fail "Node $port unreachable"
  fi
done

AGENTS=$(get 9201 /api/agents 2>/dev/null || echo '{}')
PEER_COUNT=$(echo "$AGENTS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("agents",[])))' 2>/dev/null || echo 0)
if [ "$PEER_COUNT" -ge 4 ]; then
  ok "Node 1 sees $PEER_COUNT peers (expected ≥4)"
else
  fail "Node 1 sees only $PEER_COUNT peers (expected ≥4)"
fi

section "2. CONTEXT GRAPH CREATION"

CG2="v10-validation-$(date +%s)"
CG_CREATE=$(post 9201 /api/context-graph/create -H "Content-Type: application/json" -d "{\"id\":\"$CG2\",\"name\":\"V10 Validation CG\"}")
if echo "$CG_CREATE" | python3 -c 'import sys,json;d=json.load(sys.stdin);exit(0 if "created" in d or "uri" in d else 1)' 2>/dev/null; then
  ok "Context graph '$CG2' created on node 1"
else
  fail "Context graph create failed: $CG_CREATE"
fi

section "3. PUBLISH TO VERIFIED MEMORY (public quads)"

PUB_RESULT=$(post 9201 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [
    $(q 'urn:v10:alice' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),
    $(ql 'urn:v10:alice' 'http://schema.org/name' 'Alice V10'),
    $(ql 'urn:v10:alice' 'http://schema.org/jobTitle' 'Protocol Engineer')
  ]
}")
PUB_STATUS=$(echo "$PUB_RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo 'error')
PUB_KCID=$(echo "$PUB_RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("kcId","?"))' 2>/dev/null || echo '?')
if [ "$PUB_STATUS" = "confirmed" ]; then
  ok "Publish confirmed, kcId=$PUB_KCID"
else
  fail "Publish status=$PUB_STATUS: $PUB_RESULT"
fi

sleep 3

section "4. PUBLISH WITH PRIVATE TRIPLES"

PRIV_RESULT=$(post 9201 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [
    $(q 'urn:v10:bob' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),
    $(ql 'urn:v10:bob' 'http://schema.org/name' 'Bob V10')
  ],
  \"privateQuads\": [
    $(ql 'urn:v10:bob' 'http://schema.org/email' 'bob@secret.test'),
    $(ql 'urn:v10:bob' 'http://schema.org/telephone' '+1-555-PRIVATE')
  ]
}")
PRIV_STATUS=$(echo "$PRIV_RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo 'error')
if [ "$PRIV_STATUS" = "confirmed" ]; then
  ok "Publish with private triples confirmed"
else
  fail "Private publish status=$PRIV_STATUS"
fi

sleep 3

echo ""
echo "--- 4b: Private triples NOT visible on other nodes ---"
for PORT in 9202 9203 9204; do
  LEAK=$(post $PORT /api/query -H "Content-Type: application/json" -d "{
    \"sparql\": \"SELECT ?o WHERE { <urn:v10:bob> <http://schema.org/email> ?o }\",
    \"contextGraphId\": \"$CG\"
  }")
  BINDINGS=$(echo "$LEAK" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo '?')
  if [ "$BINDINGS" = "0" ]; then
    ok "Node $PORT: no private triple leak"
  else
    fail "Node $PORT: private triple leaked! ($BINDINGS bindings)"
  fi
done

echo ""
echo "--- 4c: Private triples visible on publisher (node 1) ---"
PRIV_LOCAL=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?o WHERE { <urn:v10:bob> <http://schema.org/email> ?o }\",
  \"contextGraphId\": \"$CG\"
}")
PRIV_LOCAL_COUNT=$(echo "$PRIV_LOCAL" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo '0')
if [ "$PRIV_LOCAL_COUNT" = "1" ]; then
  ok "Publisher (node 1) can see own private triples"
else
  fail "Publisher cannot see own private triples (got $PRIV_LOCAL_COUNT bindings)"
fi

section "5. GOSSIP REPLICATION — public data on other nodes"

for PORT in 9202 9203 9204; do
  REP=$(post $PORT /api/query -H "Content-Type: application/json" -d "{
    \"sparql\": \"SELECT ?name WHERE { <urn:v10:alice> <http://schema.org/name> ?name }\",
    \"contextGraphId\": \"$CG\"
  }")
  NAME_VAL=$(echo "$REP" | python3 -c 'import sys,json;b=json.load(sys.stdin).get("result",{}).get("bindings",[]);print(b[0]["name"] if b else "EMPTY")' 2>/dev/null || echo 'error')
  if echo "$NAME_VAL" | grep -q "Alice"; then
    ok "Node $PORT: replicated Alice data"
  else
    fail "Node $PORT: Alice data not found (got: $NAME_VAL)"
  fi
done

section "6. SHARED WORKING MEMORY (SWM)"

SWM_RESULT=$(post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [
    $(q 'urn:v10:draft-report' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Report'),
    $(ql 'urn:v10:draft-report' 'http://schema.org/name' 'Q1 Analysis Draft'),
    $(ql 'urn:v10:draft-report' 'http://schema.org/description' 'Work in progress analysis')
  ]
}")
SWM_STATUS=$(echo "$SWM_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("shareOperationId","?"))' 2>/dev/null || echo 'error')
if [ "$SWM_STATUS" != "error" ] && [ "$SWM_STATUS" != "?" ]; then
  ok "SWM write succeeded, opId=$SWM_STATUS"
else
  fail "SWM write failed: $SWM_RESULT"
fi

sleep 2

echo ""
echo "--- 6b: Query SWM data on node 1 ---"
SWM_Q=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <urn:v10:draft-report> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"includeSharedMemory\": true
}")
SWM_FOUND=$(echo "$SWM_Q" | python3 -c 'import sys,json;b=json.load(sys.stdin).get("result",{}).get("bindings",[]);print(b[0]["name"] if b else "EMPTY")' 2>/dev/null || echo 'error')
if echo "$SWM_FOUND" | grep -q "Q1 Analysis"; then
  ok "SWM data queryable on node 1"
else
  fail "SWM data not found on node 1 (got: $SWM_FOUND)"
fi

echo ""
echo "--- 6c: SWM data replicated to node 2 ---"
sleep 3
SWM_REP=$(post 9202 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <urn:v10:draft-report> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"includeSharedMemory\": true
}")
SWM_REP_FOUND=$(echo "$SWM_REP" | python3 -c 'import sys,json;b=json.load(sys.stdin).get("result",{}).get("bindings",[]);print(b[0]["name"] if b else "EMPTY")' 2>/dev/null || echo 'error')
if echo "$SWM_REP_FOUND" | grep -q "Q1 Analysis"; then
  ok "SWM data replicated to node 2"
else
  warn "SWM data not yet on node 2 (may need more time): $SWM_REP_FOUND"
fi

section "7. WORKING MEMORY ASSERTIONS"

echo "--- 7a: Create assertion ---"
WM_CREATE=$(post 9201 /api/assertion/create -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"name\": \"research-notes\"
}")
WM_URI=$(echo "$WM_CREATE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("assertionUri","?"))' 2>/dev/null || echo 'error')
if [ "$WM_URI" != "error" ] && [ "$WM_URI" != "?" ]; then
  ok "WM assertion created: $WM_URI"
else
  fail "WM assertion create failed: $WM_CREATE"
fi

echo "--- 7b: Write to assertion ---"
WM_WRITE=$(post 9201 /api/assertion/research-notes/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [
    $(q 'urn:v10:finding-1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/ScholarlyArticle'),
    $(ql 'urn:v10:finding-1' 'http://schema.org/name' 'Local Finding'),
    $(ql 'urn:v10:finding-1' 'http://schema.org/abstract' 'This is a WM-only research note')
  ]
}")
if echo "$WM_WRITE" | python3 -c 'import sys,json;d=json.load(sys.stdin);exit(0 if d.get("written",0) > 0 or "ok" in str(d) else 1)' 2>/dev/null; then
  ok "WM assertion write succeeded"
else
  fail "WM assertion write failed: $WM_WRITE"
fi

echo "--- 7c: Query assertion ---"
WM_QUERY=$(post 9201 /api/assertion/research-notes/query -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\"
}")
WM_COUNT=$(echo "$WM_QUERY" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else d.get("count",len(d.get("quads",[]))))' 2>/dev/null || echo '0')
if [ "$WM_COUNT" != "0" ]; then
  ok "WM assertion query returned $WM_COUNT quads"
else
  fail "WM assertion query empty"
fi

echo "--- 7d: WM data NOT visible on other nodes ---"
WM_LEAK=$(post 9202 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <urn:v10:finding-1> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\"
}")
WM_LEAK_COUNT=$(echo "$WM_LEAK" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo '?')
if [ "$WM_LEAK_COUNT" = "0" ]; then
  ok "WM data correctly isolated — not visible on node 2"
else
  fail "WM data leaked to node 2 ($WM_LEAK_COUNT bindings)"
fi

section "8. PROMOTE WM → SWM"

WM_PROMOTE=$(post 9201 /api/assertion/research-notes/promote -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\"
}")
PROMOTE_COUNT=$(echo "$WM_PROMOTE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("promotedCount","?"))' 2>/dev/null || echo 'error')
if [ "$PROMOTE_COUNT" != "error" ] && [ "$PROMOTE_COUNT" != "?" ] && [ "$PROMOTE_COUNT" != "0" ]; then
  ok "Promoted $PROMOTE_COUNT quads from WM to SWM"
else
  fail "Promote failed: $WM_PROMOTE"
fi

section "9. PUBLISH FROM SWM → VM"

sleep 2
ENSHRINE=$(post 9201 /api/shared-memory/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\"
}")
ENS_STATUS=$(echo "$ENSHRINE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo 'error')
ENS_KCID=$(echo "$ENSHRINE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("kcId","?"))' 2>/dev/null || echo '?')
if [ "$ENS_STATUS" = "confirmed" ]; then
  ok "Publish from SWM confirmed, kcId=$ENS_KCID"
else
  warn "Publish from SWM status=$ENS_STATUS (may need different endpoint): $ENSHRINE"
fi

section "10. SUB-GRAPHS"

echo "--- 10a: Create sub-graph ---"
SG_CREATE=$(post 9201 /api/sub-graph/create -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"subGraphName\": \"decisions\"
}")
if echo "$SG_CREATE" | python3 -c 'import sys,json;d=json.load(sys.stdin);exit(0 if d.get("created") or "ok" in str(d).lower() or "decisions" in str(d) else 1)' 2>/dev/null; then
  ok "Sub-graph 'decisions' created"
else
  fail "Sub-graph create failed: $SG_CREATE"
fi

echo "--- 10b: Publish to sub-graph ---"
SG_PUB=$(post 9201 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"subGraphName\": \"decisions\",
  \"quads\": [
    $(q 'urn:v10:decision-1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Action'),
    $(ql 'urn:v10:decision-1' 'http://schema.org/name' 'Adopt V10 Protocol'),
    $(ql 'urn:v10:decision-1' 'http://schema.org/description' 'Board approved V10 migration')
  ]
}")
SG_PUB_STATUS=$(echo "$SG_PUB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null || echo 'error')
if [ "$SG_PUB_STATUS" = "confirmed" ]; then
  ok "Sub-graph publish confirmed"
else
  fail "Sub-graph publish status=$SG_PUB_STATUS: $SG_PUB"
fi

sleep 3

echo "--- 10c: Query sub-graph specifically ---"
SG_Q=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <urn:v10:decision-1> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"subGraphName\": \"decisions\"
}")
SG_FOUND=$(echo "$SG_Q" | python3 -c 'import sys,json;b=json.load(sys.stdin).get("result",{}).get("bindings",[]);print(b[0]["name"] if b else "EMPTY")' 2>/dev/null || echo 'error')
if echo "$SG_FOUND" | grep -q "Adopt V10"; then
  ok "Sub-graph query returned correct data"
else
  fail "Sub-graph query failed: $SG_FOUND"
fi

echo "--- 10d: Sub-graph data isolated from root graph ---"
SG_ROOT=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <urn:v10:decision-1> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\"
}")
SG_ROOT_COUNT=$(echo "$SG_ROOT" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo '?')
if [ "$SG_ROOT_COUNT" = "0" ]; then
  ok "Sub-graph data correctly isolated from root graph"
else
  warn "Sub-graph data found in root graph ($SG_ROOT_COUNT bindings) — may be expected depending on query behavior"
fi

section "11. QUERY VIEWS"

echo "--- 11a: Query with view=verified-memory ---"
VM_Q=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <urn:v10:alice> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"view\": \"verified-memory\"
}")
VM_FOUND=$(echo "$VM_Q" | python3 -c 'import sys,json;b=json.load(sys.stdin).get("result",{}).get("bindings",[]);print(b[0]["name"] if b else "EMPTY")' 2>/dev/null || echo 'error')
if echo "$VM_FOUND" | grep -q "Alice"; then
  ok "Verified-memory view: Alice data found"
else
  fail "Verified-memory view: Alice data missing (got: $VM_FOUND)"
fi

echo "--- 11b: Query with view=shared-working-memory ---"
SWM_VIEW=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <urn:v10:draft-report> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"view\": \"shared-working-memory\"
}")
SWM_VIEW_FOUND=$(echo "$SWM_VIEW" | python3 -c 'import sys,json;b=json.load(sys.stdin).get("result",{}).get("bindings",[]);print(b[0]["name"] if b else "EMPTY")' 2>/dev/null || echo 'error')
if echo "$SWM_VIEW_FOUND" | grep -q "Q1 Analysis"; then
  ok "Shared-working-memory view: draft report found"
else
  warn "SWM view: draft report not found (may have been promoted/published already): $SWM_VIEW_FOUND"
fi

echo "--- 11c: Query with invalid view returns 400 ---"
BAD_VIEW=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:9201/api/query -H "$H" -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?s WHERE { ?s ?p ?o } LIMIT 1\",
  \"contextGraphId\": \"$CG\",
  \"view\": \"invalid-view\"
}")
if [ "$BAD_VIEW" = "400" ]; then
  ok "Invalid view correctly returns 400"
else
  fail "Invalid view returned $BAD_VIEW (expected 400)"
fi

section "12. CONDITIONAL SHARE (CAS)"

CAS_RESULT=$(post 9201 /api/shared-memory/conditional-write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [
    $(ql 'urn:v10:counter' 'http://schema.org/value' 'initial-value')
  ],
  \"conditions\": []
}")
CAS_OP=$(echo "$CAS_RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("shareOperationId","?"))' 2>/dev/null || echo 'error')
if [ "$CAS_OP" != "error" ] && [ "$CAS_OP" != "?" ]; then
  ok "Conditional share succeeded, opId=$CAS_OP"
else
  fail "Conditional share failed: $CAS_RESULT"
fi

section "13. INTER-NODE MESSAGING"

NODE2_PEER=$(get 9202 /api/status | python3 -c 'import sys,json;print(json.load(sys.stdin).get("peerId",""))' 2>/dev/null)
if [ -n "$NODE2_PEER" ]; then
  CHAT_RESULT=$(post 9201 /api/chat -H "Content-Type: application/json" -d "{
    \"recipientPeerId\": \"$NODE2_PEER\",
    \"text\": \"Hello from V10 validation test!\"
  }")
  DELIVERED=$(echo "$CHAT_RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("delivered",False))' 2>/dev/null || echo 'error')
  if [ "$DELIVERED" = "True" ]; then
    ok "Chat message delivered to node 2"
  else
    fail "Chat delivery failed: $CHAT_RESULT"
  fi
else
  fail "Could not get node 2 peerId"
fi

section "14. SKILL.MD ENDPOINT"

SKILL=$(get 9201 /.well-known/skill.md 2>/dev/null || echo '')
if echo "$SKILL" | grep -q "assertion"; then
  ok "SKILL.md served and contains 'assertion' terminology"
else
  fail "SKILL.md missing or doesn't contain assertion terminology"
fi

section "15. AGENT PROFILES"

PROFILE=$(get 9201 /api/profile 2>/dev/null || echo '{}')
if echo "$PROFILE" | python3 -c 'import sys,json;d=json.load(sys.stdin);exit(0 if d.get("name") or d.get("peerId") else 1)' 2>/dev/null; then
  ok "Agent profile endpoint works"
else
  warn "Agent profile returned: $PROFILE"
fi

section "SUMMARY"
echo ""
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Warnings: $WARN"
echo "  Total: $TOTAL"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 ALL TESTS PASSED"
else
  echo "  ⚠️  $FAIL TESTS FAILED — review above"
fi
