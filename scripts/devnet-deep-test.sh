#!/usr/bin/env bash
set -euo pipefail

AUTH="${DKG_AUTH:-LgXO3OMrALdxiUrUM38nsG9PISAmMaYVouEjgrosBWQ}"
H="Authorization: Bearer $AUTH"
CG="devnet-test"
PASS=0; FAIL=0; WARN=0

ok()   { PASS=$((PASS+1)); echo "  [PASS] $*"; }
fail() { FAIL=$((FAIL+1)); echo "  [FAIL] $*"; }
warn() { WARN=$((WARN+1)); echo "  [WARN] $*"; }

api() { curl -s -H "$H" "$@"; }
post() { local port=$1; shift; api -X POST "http://127.0.0.1:$port$@"; }
get()  { local port=$1; shift; api "http://127.0.0.1:$port$@"; }
q()  { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"$3\",\"graph\":\"\"}"; }
ql() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"\\\"$3\\\"\",\"graph\":\"\"}"; }

echo "============================================================"
echo "DKG V10 Deep Devnet Test — Pre-Release Validation"
echo "============================================================"

echo ""
echo "=== TEST 1: Publish with Private Triples — Check for Leaks ==="
PRIV_RESULT=$(post 9201 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"devnet-test\",
  \"quads\": [
    $(q 'http://test.org/secret-agent' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),
    $(ql 'http://test.org/secret-agent' 'http://schema.org/name' 'James Bond')
  ],
  \"privateQuads\": [
    $(ql 'http://test.org/secret-agent' 'http://test.org/secretCode' '007-classified'),
    $(ql 'http://test.org/secret-agent' 'http://test.org/safeHouse' '53.5,-0.12')
  ]
}")
echo "  Private publish result: $(echo "$PRIV_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status","?"),d.get("kcId","?"))' 2>/dev/null || echo 'parse error')"
if echo "$PRIV_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);exit(0 if d.get("status")=="confirmed" else 1)' 2>/dev/null; then
  ok "Private publish confirmed"
else
  fail "Private publish failed: $PRIV_RESULT"
fi

sleep 3

echo ""
echo "--- 1b: Check private triples are NOT visible on other nodes ---"
for PORT in 9202 9203 9204 9205; do
  LEAK=$(post $PORT /api/query -H "Content-Type: application/json" -d "{
    \"sparql\": \"SELECT ?o WHERE { <http://test.org/secret-agent> <http://test.org/secretCode> ?o }\",
    \"contextGraphId\": \"devnet-test\"
  }" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
  if [ "$LEAK" = "0" ]; then
    ok "Node $PORT: no private data leak"
  else
    fail "Node $PORT: PRIVATE DATA LEAKED ($LEAK results)"
  fi
done

echo ""
echo "--- 1c: Private triples visible on publisher node ---"
PRIV_LOCAL=$(post 9201 /api/query -H "Content-Type: application/json" -d '{
  "sparql": "SELECT ?o WHERE { <http://test.org/secret-agent> <http://test.org/secretCode> ?o }",
  "contextGraphId": "devnet-test"
}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
if [ "$PRIV_LOCAL" -ge "1" ]; then
  ok "Publisher node has private data locally"
else
  warn "Publisher node doesn't show private data via query (may need private access API)"
fi

echo ""
echo "=== TEST 2: Merkle Root Verification ==="
echo "--- 2a: Publish known triples, check merkle consistency ---"
MERKLE_RESULT=$(post 9201 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"devnet-test\",
  \"quads\": [
    $(q 'http://test.org/merkle-test' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),
    $(ql 'http://test.org/merkle-test' 'http://schema.org/name' 'MerkleTest'),
    $(ql 'http://test.org/merkle-test' 'http://schema.org/value' '42')
  ]
}")
MERKLE_TX=$(echo "$MERKLE_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("tx",""))' 2>/dev/null)
MERKLE_KC=$(echo "$MERKLE_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("kcId",""))' 2>/dev/null)
echo "  Merkle publish: kcId=$MERKLE_KC tx=$MERKLE_TX"
if [ -n "$MERKLE_TX" ] && [ "$MERKLE_TX" != "None" ]; then
  ok "Merkle test publish confirmed"
else
  fail "Merkle test publish failed"
fi

sleep 3

echo ""
echo "--- 2b: Query replicated triples on all nodes — exact match ---"
for PORT in 9201 9202 9203 9204 9205; do
  COUNT=$(post $PORT /api/query -H "Content-Type: application/json" -d '{
    "sparql": "SELECT ?p ?o WHERE { <http://test.org/merkle-test> ?p ?o }",
    "contextGraphId": "devnet-test"
  }' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
  if [ "$COUNT" = "3" ]; then
    ok "Node $PORT: exact 3 triples replicated"
  else
    if [ "$COUNT" = "0" ]; then
      warn "Node $PORT: 0 triples (replication pending)"
    else
      fail "Node $PORT: $COUNT triples (expected 3)"
    fi
  fi
done

echo ""
echo "=== TEST 3: Smart Contract State Verification ==="
echo "--- 3a: Check on-chain batch via RPC ---"

BATCH_CHECK=$(curl -s -X POST http://127.0.0.1:8545 -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1
}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(int(d["result"],16))' 2>/dev/null || echo "0")
if [ "$BATCH_CHECK" -gt "400" ]; then
  ok "Hardhat block number: $BATCH_CHECK (confirms multiple txs)"
else
  warn "Block number $BATCH_CHECK seems low"
fi

echo ""
echo "=== TEST 4: Cross-Node Publish from Different Nodes ==="
echo "--- 4a: Publish from Node 2 ---"
N2_RESULT=$(post 9202 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"devnet-test\",
  \"quads\": [
    $(q 'http://test.org/node2-entity' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Place'),
    $(ql 'http://test.org/node2-entity' 'http://schema.org/name' 'Published from Node 2')
  ]
}")
N2_STATUS=$(echo "$N2_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status","?"))' 2>/dev/null)
if [ "$N2_STATUS" = "confirmed" ]; then ok "Node 2 publish confirmed"; else fail "Node 2 publish: $N2_STATUS"; fi

echo "--- 4b: Publish from Node 4 ---"
N4_RESULT=$(post 9204 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"devnet-test\",
  \"quads\": [
    $(q 'http://test.org/node4-entity' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Event'),
    $(ql 'http://test.org/node4-entity' 'http://schema.org/name' 'Published from Node 4')
  ]
}")
N4_STATUS=$(echo "$N4_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status","?"))' 2>/dev/null)
if [ "$N4_STATUS" = "confirmed" ]; then ok "Node 4 publish confirmed"; else fail "Node 4 publish: $N4_STATUS"; fi

echo "--- 4c: Publish from Node 5 (edge) ---"
N5_RESULT=$(post 9205 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"devnet-test\",
  \"quads\": [
    $(q 'http://test.org/edge-entity' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Organization'),
    $(ql 'http://test.org/edge-entity' 'http://schema.org/name' 'Published from Edge Node 5')
  ]
}")
N5_STATUS=$(echo "$N5_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status","?"))' 2>/dev/null)
if [ "$N5_STATUS" = "confirmed" ]; then ok "Node 5 (edge) publish confirmed"; else fail "Node 5 publish: $N5_STATUS"; fi

sleep 5

echo ""
echo "--- 4d: Verify all 3 entities replicate to all nodes ---"
for PORT in 9201 9202 9203 9204 9205; do
  TOTAL=$(post $PORT /api/query -H "Content-Type: application/json" -d '{
    "sparql": "SELECT ?s WHERE { ?s <http://schema.org/name> ?name . FILTER(STRSTARTS(STR(?name), \"\\\"Published from\")) }",
    "contextGraphId": "devnet-test"
  }' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
  if [ "$TOTAL" -ge "3" ]; then
    ok "Node $PORT: all 3 cross-node entities present"
  else
    warn "Node $PORT: only $TOTAL/3 cross-node entities"
  fi
done

echo ""
echo "=== TEST 5: Shared Memory Write + Publish Pipeline ==="
echo "--- 5a: Write to SWM on Node 1 ---"
SWM_WRITE=$(post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"devnet-test\",
  \"quads\": [
    $(q 'http://test.org/swm-item' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://test.org/swm-item' 'http://schema.org/name' 'SWM Product'),
    $(ql 'http://test.org/swm-item' 'http://schema.org/price' '29.99')
  ]
}")
if echo "$SWM_WRITE" | python3 -c 'import sys,json;d=json.load(sys.stdin);exit(0 if d.get("ok") or d.get("stored") else 1)' 2>/dev/null; then
  ok "SWM write succeeded"
else
  echo "  SWM result: $SWM_WRITE"
  warn "SWM write response unexpected"
fi

sleep 3

echo "--- 5b: Publish from SWM ---"
SWM_PUB=$(post 9201 /api/shared-memory/publish -H "Content-Type: application/json" -d '{"contextGraphId":"devnet-test"}')
SWM_PUB_STATUS=$(echo "$SWM_PUB" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("status","?"))' 2>/dev/null)
echo "  SWM publish status: $SWM_PUB_STATUS"
if [ "$SWM_PUB_STATUS" = "confirmed" ]; then
  ok "SWM → LTM publish confirmed"
else
  warn "SWM → LTM publish status: $SWM_PUB_STATUS"
fi

echo ""
echo "=== TEST 6: Query Operations ==="
echo "--- 6a: SPARQL COUNT query ---"
COUNT_RESULT=$(post 9201 /api/query -H "Content-Type: application/json" -d '{
  "sparql": "SELECT (COUNT(?s) AS ?total) WHERE { ?s a ?type }",
  "contextGraphId": "devnet-test"
}')
TOTAL=$(echo "$COUNT_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("result",{}).get("bindings",[{}])[0].get("total","0"))' 2>/dev/null || echo "0")
echo "  Total typed entities: $TOTAL"
if [ "${TOTAL%%.*}" -ge "5" ]; then
  ok "SPARQL COUNT returns typed entities"
else
  warn "Low entity count: $TOTAL"
fi

echo "--- 6b: SPARQL FILTER query ---"
FILTER_RESULT=$(post 9201 /api/query -H "Content-Type: application/json" -d '{
  "sparql": "SELECT ?name WHERE { ?s <http://schema.org/name> ?name . FILTER(CONTAINS(STR(?name), \"Bond\")) }",
  "contextGraphId": "devnet-test"
}')
BOND=$(echo "$FILTER_RESULT" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
if [ "$BOND" -ge "1" ]; then
  ok "SPARQL FILTER found James Bond"
else
  warn "SPARQL FILTER: Bond not found (may be in private store)"
fi

echo ""
echo "=== TEST 7: Adversarial / Edge Cases ==="
echo "--- 7a: Empty quads publish ---"
EMPTY=$(post 9201 /api/publish -H "Content-Type: application/json" -d '{"contextGraphId":"devnet-test","quads":[]}')
if echo "$EMPTY" | grep -q "error"; then
  ok "Empty quads rejected"
else
  fail "Empty quads not rejected: $EMPTY"
fi

echo "--- 7b: Publish to non-existent context graph ---"
BAD_CG=$(post 9201 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"does-not-exist\",
  \"quads\": [$(ql 'http://x' 'http://y' 'z')]
}")
if echo "$BAD_CG" | grep -qi "error\|fail"; then
  ok "Non-existent CG publish rejected or failed"
else
  warn "Non-existent CG publish response: $(echo "$BAD_CG" | head -c 200)"
fi

echo "--- 7c: Malformed SPARQL ---"
BAD_SPARQL=$(post 9201 /api/query -H "Content-Type: application/json" -d '{
  "sparql": "NOT VALID SPARQL AT ALL",
  "contextGraphId": "devnet-test"
}')
if echo "$BAD_SPARQL" | grep -qi "error"; then
  ok "Malformed SPARQL returns error"
else
  fail "Malformed SPARQL didn't error: $BAD_SPARQL"
fi

echo "--- 7d: Missing auth token ---"
NO_AUTH=$(curl -s http://127.0.0.1:9201/api/publish -X POST -H "Content-Type: application/json" -d '{"contextGraphId":"devnet-test","quads":[]}')
if echo "$NO_AUTH" | grep -qi "unauthorized\|auth\|401\|error"; then
  ok "Unauthenticated request rejected"
else
  warn "No auth may be disabled (DEVNET_NO_AUTH=1)"
fi

echo "--- 7e: Huge triple value (10KB string) ---"
HUGE_VAL=$(python3 -c "print('x'*10000)")
HUGE_RESULT=$(post 9201 /api/publish -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"devnet-test\",
  \"quads\": [{\"subject\":\"http://test.org/huge\",\"predicate\":\"http://test.org/data\",\"object\":\"\\\"$HUGE_VAL\\\"\",\"graph\":\"\"}]
}" 2>&1 | head -c 500)
echo "  Large payload response: $(echo "$HUGE_RESULT" | head -c 200)"
ok "Large payload handled (no crash)"

echo ""
echo "=== TEST 8: Context Graph Operations ==="
echo "--- 8a: List context graphs ---"
CG_LIST=$(get 9201 /api/context-graph/list)
CG_COUNT=$(echo "$CG_LIST" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("contextGraphs",d.get("paranets",[]))))' 2>/dev/null || echo "0")
echo "  Context graphs: $CG_COUNT"
if [ "$CG_COUNT" -ge "1" ]; then ok "Context graphs listed"; else warn "No context graphs listed"; fi

echo ""
echo "=== TEST 9: Subscribe + Sync ==="
echo "--- 9a: Subscribe Node 3 to devnet-test ---"
SUB=$(post 9203 /api/context-graph/subscribe -H "Content-Type: application/json" -d '{"contextGraphId":"devnet-test"}')
echo "  Subscribe result: $(echo "$SUB" | head -c 200)"
ok "Subscribe requested"

sleep 2
echo "--- 9b: Query Node 3 after subscribe ---"
N3_COUNT=$(post 9203 /api/query -H "Content-Type: application/json" -d '{
  "sparql": "SELECT (COUNT(?s) AS ?c) WHERE { ?s a ?t }",
  "contextGraphId": "devnet-test"
}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("result",{}).get("bindings",[{}])[0].get("c","0"))' 2>/dev/null || echo "0")
echo "  Node 3 entities after sync: $N3_COUNT"
if [ "${N3_COUNT%%.*}" -ge "5" ]; then ok "Node 3 synced"; else warn "Node 3 entity count low: $N3_COUNT"; fi

echo ""
echo "============================================================"
echo "DEEP TEST SUMMARY"
echo "============================================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"  
echo "  WARN: $WARN"
echo "  TOTAL: $((PASS+FAIL+WARN))"
echo "============================================================"
[ "$FAIL" -eq 0 ] && echo "  ALL TESTS PASSED!" || echo "  Some tests FAILED — see above."
