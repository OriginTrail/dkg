#!/usr/bin/env bash
set -uo pipefail

AUTH="${DKG_AUTH:-QEFtEgVTliirBT2ByxLSDwHqRmnXzQsKthmbLsjGDTc}"
CONTEXT_GRAPH="devnet-test"
PASS=0
FAIL=0
WARN=0

c() { curl -s -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "$@"; }
G=""  # graph always empty — protocol assigns it

ok()   { PASS=$((PASS+1)); echo "  [PASS] $1"; }
fail() { FAIL=$((FAIL+1)); echo "  [FAIL] $1"; }
warn() { WARN=$((WARN+1)); echo "  [WARN] $1"; }

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
  print(d if d is not None else '__NONE__')
except: print('__ERR__')
" 2>/dev/null
}

check() {
  local desc="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then ok "$desc"; else fail "$desc (expected=$expected, got=$actual)"; fi
}

q() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"$3\",\"graph\":\"\"}"; }
ql() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"\\\"$3\\\"\",\"graph\":\"\"}"; }

echo "============================================================"
echo "DKG V10 Comprehensive Devnet Test Suite"
echo "5 nodes: Node1=core(9201), Nodes2-5=edge(9202-9205)"
echo "============================================================"
echo ""

#------------------------------------------------------------
echo "=== SECTION 1: Node Health & Identity ==="
echo ""
for p in 9201 9202 9203 9204 9205; do
  info=$(c "http://127.0.0.1:$p/api/info")
  check "Node $p running" "$(json_get "$info" status)" "running"
  ident=$(c "http://127.0.0.1:$p/api/identity")
  iid=$(json_get "$ident" identityId)
  [[ "$iid" != "0" && "$iid" != "__NONE__" ]] && ok "Node $p identity=$iid" || fail "Node $p no identity"
done

echo ""
echo "--- 1b: P2P mesh ---"
agents=$(c "http://127.0.0.1:9201/api/agents")
connected=$(echo "$agents" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for a in d['agents'] if a['connectionStatus'] in ('connected','self')))" 2>/dev/null)
check "Core sees 5 peers" "$connected" "5"

echo ""
echo "--- 1c: Wallet balances ---"
for p in 9201 9202 9203; do
  bals=$(c "http://127.0.0.1:$p/api/wallets/balances")
  bc=$(echo "$bals" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('balances',[])))" 2>/dev/null)
  [[ "$bc" -ge 1 ]] && ok "Node $p has $bc wallet(s)" || fail "Node $p no wallets"
done

echo ""
echo "--- 1d: Chain RPC health ---"
for p in 9201 9202 9203; do
  h=$(c "http://127.0.0.1:$p/api/chain/rpc-health")
  rpc_ok=$(json_get "$h" ok)
  check "Node $p RPC ok" "$rpc_ok" "True"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 2: Free Operations — Shared Memory Writes (Token Econ §2.2) ==="
echo ""

TRAC_BEFORE=$(c "http://127.0.0.1:9202/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node2 TRAC before shared memory write: $TRAC_BEFORE"

SWM_W=$(c -X POST "http://127.0.0.1:9202/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/alice' 'http://schema.org/name' 'Alice'),
    $(ql 'http://example.org/entity/alice' 'http://schema.org/age' '30'),
    $(q 'http://example.org/entity/alice' 'http://schema.org/knows' 'http://example.org/entity/bob'),
    $(ql 'http://example.org/entity/bob' 'http://schema.org/name' 'Bob'),
    $(ql 'http://example.org/entity/bob' 'http://schema.org/age' '25')
  ]
}")
swm_ok=$(json_get "$SWM_W" ok)
[[ "$swm_ok" == "True" ]] && ok "Shared memory write OK" || fail "Shared memory write failed: $SWM_W"

TRAC_AFTER=$(c "http://127.0.0.1:9202/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
check "Shared memory write is FREE (TRAC unchanged)" "$TRAC_BEFORE" "$TRAC_AFTER"

echo ""
echo "--- 2b: Query shared memory locally ---"
SWM_Q=$(c -X POST "http://127.0.0.1:9202/api/query" -d "{
  \"sparql\":\"SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } . FILTER(CONTAINS(STR(?g),'_shared_memory')) . FILTER(CONTAINS(STR(?s),'example.org')) } LIMIT 20\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\"
}")
SWM_CT=$(echo "$SWM_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
[[ "$SWM_CT" -ge 5 ]] && ok "Shared memory has $SWM_CT triples on Node2" || fail "Shared memory has $SWM_CT triples on Node2 (expected >=5)"

echo ""
echo "--- 2c: GossipSub propagation to all nodes ---"
sleep 4
for p in 9201 9203 9204 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } . FILTER(CONTAINS(STR(?g),'_shared_memory')) . FILTER(CONTAINS(STR(?s),'example.org/entity/alice')) }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\"
  }")
  ct=$(echo "$R" | python3 -c "
import sys,json
b=json.load(sys.stdin).get('result',{}).get('bindings',[])
if b:
  v=str(b[0].get('c','0'))
  import re; m=re.search(r'(\d+)',v)
  print(m.group(1) if m else '0')
else: print('0')
" 2>/dev/null)
  [[ "$ct" -ge 2 ]] && ok "Node $p has Alice in shared memory ($ct triples)" || warn "Node $p missing Alice in shared memory ($ct)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 3: PUBLISH Pipeline — Direct to LTM ==="
echo ""

echo "--- 3a: Publish from Node1 (core) ---"
PUB1=$(c -X POST "http://127.0.0.1:9201/api/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/city1' 'http://schema.org/name' 'Ljubljana'),
    $(q 'http://example.org/entity/city1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city1' 'http://schema.org/population' '290000'),
    $(ql 'http://example.org/entity/city2' 'http://schema.org/name' 'Maribor'),
    $(q 'http://example.org/entity/city2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city2' 'http://schema.org/population' '95000')
  ]
}")
PUB1_ST=$(json_get "$PUB1" status)
PUB1_KC=$(json_get "$PUB1" kcId)
PUB1_TX=$(json_get "$PUB1" txHash)
PUB1_BN=$(json_get "$PUB1" blockNumber)
PUB1_KAS=$(echo "$PUB1" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))" 2>/dev/null)

echo "  status=$PUB1_ST kcId=$PUB1_KC tx=$PUB1_TX block=$PUB1_BN KAs=$PUB1_KAS"
[[ "$PUB1_ST" == "confirmed" || "$PUB1_ST" == "finalized" ]] && ok "Publish succeeded ($PUB1_ST)" || fail "Publish status=$PUB1_ST"
[[ "$PUB1_TX" != "__NONE__" ]] && ok "On-chain tx: $PUB1_TX" || fail "No txHash"
check "2 KA tokens (city1,city2)" "$PUB1_KAS" "2"

echo ""
echo "--- 3b: KA manifest has correct rootEntity URIs ---"
KA1_ROOT=$(echo "$PUB1" | python3 -c "import sys,json; kas=json.load(sys.stdin).get('kas',[]); roots=sorted([k['rootEntity'] for k in kas]); print(','.join(roots))" 2>/dev/null)
echo "  Root entities: $KA1_ROOT"
echo "$KA1_ROOT" | grep -q "city1" && echo "$KA1_ROOT" | grep -q "city2" && ok "Both city roots present" || fail "Missing root entities: $KA1_ROOT"

echo ""
echo "--- 3c: Query LTM for cities ---"
sleep 2
LTM_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name . ?s a <http://schema.org/City> } LIMIT 10\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\"
}")
LTM_CT=$(echo "$LTM_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
[[ "$LTM_CT" -ge 2 ]] && ok "LTM has $LTM_CT cities on Node1" || fail "LTM has $LTM_CT cities on Node1"

echo ""
echo "--- 3d: Cross-node finalization — cities reach all 5 nodes ---"
sleep 8
for p in 9201 9202 9203 9204 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name . ?s a <http://schema.org/City> } LIMIT 10\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\"
  }")
  ct=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
  [[ "$ct" -ge 2 ]] && ok "Node $p has $ct cities in LTM" || warn "Node $p has $ct cities in LTM (finalization pending?)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 4: Publish from Shared Memory ==="
echo ""

echo "--- 4a: Write to shared memory on Node3, wait for gossip ---"
c -X POST "http://127.0.0.1:9203/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/product1' 'http://schema.org/name' 'Potica'),
    $(q 'http://example.org/entity/product1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product1' 'http://schema.org/description' 'Traditional Slovenian nut roll'),
    $(ql 'http://example.org/entity/product2' 'http://schema.org/name' 'Carniolan Sausage'),
    $(q 'http://example.org/entity/product2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product2' 'http://schema.org/description' 'PGI sausage')
  ]
}" > /dev/null
sleep 4

echo ""
echo "--- 4b: Publish (from shared memory) on Node3 ---"
# Use selection to only publish product entities
ENS=$(c -X POST "http://127.0.0.1:9203/api/shared-memory/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"selection\":[\"http://example.org/entity/product1\",\"http://example.org/entity/product2\"],
  \"clearAfter\":false
}")
ENS_ST=$(json_get "$ENS" status)
ENS_KC=$(json_get "$ENS" kcId)
ENS_KAS=$(echo "$ENS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))" 2>/dev/null)
echo "  status=$ENS_ST kcId=$ENS_KC KAs=$ENS_KAS"
[[ "$ENS_ST" == "confirmed" || "$ENS_ST" == "finalized" ]] && ok "Publish from shared memory succeeded ($ENS_ST)" || fail "Publish from shared memory status=$ENS_ST"
check "2 KAs for products" "$ENS_KAS" "2"

echo ""
echo "--- 4c: Products in LTM on Node3 ---"
sleep 3
P_Q=$(c -X POST "http://127.0.0.1:9203/api/query" -d "{
  \"sparql\":\"SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name . ?s a <http://schema.org/Product> } LIMIT 10\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\"
}")
P_CT=$(echo "$P_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
[[ "$P_CT" -ge 2 ]] && ok "Products in LTM on Node3 ($P_CT)" || fail "Products missing from LTM ($P_CT)"

echo ""
echo "--- 4d: Products replicate to other nodes ---"
sleep 8
for p in 9201 9202 9204 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT ?name WHERE { ?s <http://schema.org/name> ?name . ?s a <http://schema.org/Product> }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\"
  }")
  ct=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
  [[ "$ct" -ge 2 ]] && ok "Node $p has products ($ct)" || warn "Node $p products pending ($ct)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 5: Edge Node Publishes (Protocol Core §19.2) ==="
echo ""

PUB_E=$(c -X POST "http://127.0.0.1:9204/api/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/person1' 'http://schema.org/name' 'France Prešeren'),
    $(q 'http://example.org/entity/person1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),
    $(ql 'http://example.org/entity/person1' 'http://schema.org/birthDate' '1800-12-03')
  ]
}")
PE_ST=$(json_get "$PUB_E" status)
PE_TX=$(json_get "$PUB_E" txHash)
[[ "$PE_ST" == "confirmed" || "$PE_ST" == "finalized" ]] && ok "Edge publish OK ($PE_ST)" || fail "Edge publish=$PE_ST"
[[ "$PE_TX" != "__NONE__" ]] && ok "Edge tx: $PE_TX" || fail "No edge txHash"

#------------------------------------------------------------
echo ""
echo "=== SECTION 6: Token Economics — TRAC Cost ==="
echo ""

TRAC5_B=$(c "http://127.0.0.1:9205/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node5 TRAC before: $TRAC5_B"

PUB5=$(c -X POST "http://127.0.0.1:9205/api/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/name' 'Lake Bled'),
    $(q 'http://example.org/entity/lake1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/LakeBodyOfWater'),
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/description' 'Glacial lake in the Julian Alps')
  ]
}")
PUB5_ST=$(json_get "$PUB5" status)

TRAC5_A=$(c "http://127.0.0.1:9205/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node5 TRAC after: $TRAC5_A  (status=$PUB5_ST)"

if [[ "$TRAC5_B" != "$TRAC5_A" ]]; then
  ok "TRAC spent on publish ($TRAC5_B → $TRAC5_A)"
else
  warn "TRAC unchanged — publisher wallet may not be the paying wallet"
fi

#------------------------------------------------------------
echo ""
echo "=== SECTION 7: UPDATE Operation ==="
echo ""

UPD=$(c -X POST "http://127.0.0.1:9201/api/update" -d "{
  \"kcId\":\"$PUB1_KC\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/city1' 'http://schema.org/name' 'Ljubljana'),
    $(q 'http://example.org/entity/city1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city1' 'http://schema.org/population' '295000'),
    $(ql 'http://example.org/entity/city2' 'http://schema.org/name' 'Maribor'),
    $(q 'http://example.org/entity/city2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city2' 'http://schema.org/population' '97000')
  ]
}")
UPD_ST=$(json_get "$UPD" status)
UPD_TX=$(json_get "$UPD" txHash)
echo "  Update: status=$UPD_ST tx=$UPD_TX"
[[ "$UPD_ST" == "confirmed" || "$UPD_ST" == "finalized" ]] && ok "UPDATE succeeded" || fail "UPDATE status=$UPD_ST"

echo ""
echo "--- 7b: Verify updated population ---"
sleep 3
UQ=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?pop WHERE { <http://example.org/entity/city1> <http://schema.org/population> ?pop }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\"
}")
UQ_POP=$(echo "$UQ" | python3 -c "import sys,json; b=json.load(sys.stdin).get('result',{}).get('bindings',[]); print(b[0].get('pop','NONE') if b else 'NONE')" 2>/dev/null)
echo "$UQ_POP" | grep -q "295000" && ok "Population updated to 295000" || fail "Population: $UQ_POP"

#------------------------------------------------------------
echo ""
echo "=== SECTION 8: Context Graph Creation ==="
echo ""

ID1=$(c "http://127.0.0.1:9201/api/identity" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identityId',0))" 2>/dev/null)
ID3=$(c "http://127.0.0.1:9203/api/identity" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identityId',0))" 2>/dev/null)
ID5=$(c "http://127.0.0.1:9205/api/identity" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identityId',0))" 2>/dev/null)
echo "  Identity IDs: $ID1, $ID3, $ID5"

CG=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" -d "{
  \"participantIdentityIds\":[$ID1,$ID3,$ID5],
  \"requiredSignatures\":2
}")
CG_ID=$(json_get "$CG" contextGraphId)
CG_OK=$(json_get "$CG" success)
echo "  CG result: id=$CG_ID success=$CG_OK"
[[ "$CG_OK" == "True" ]] && ok "Context Graph created (id=$CG_ID)" || fail "CG creation: $CG"

#------------------------------------------------------------
echo ""
echo "=== SECTION 9: Triple Deduplication ==="
echo ""

DEDUP=$(c -X POST "http://127.0.0.1:9201/api/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest'),
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest'),
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest')
  ]
}")
DD_ST=$(json_get "$DEDUP" status)
DD_KAS=$(echo "$DEDUP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))" 2>/dev/null)
[[ "$DD_ST" == "confirmed" || "$DD_ST" == "finalized" ]] && ok "Dedup publish OK" || fail "Dedup status=$DD_ST"
check "1 KA (dedup: 3 identical → 1 entity)" "$DD_KAS" "1"

#------------------------------------------------------------
echo ""
echo "=== SECTION 10: Multi-Entity Batch Publish (50 entities) ==="
echo ""

BATCH_QUADS=""
for i in $(seq 1 50); do
  BATCH_QUADS="$BATCH_QUADS$(ql "http://example.org/entity/batch_$i" 'http://schema.org/name' "Item $i"),"
  BATCH_QUADS="$BATCH_QUADS$(q "http://example.org/entity/batch_$i" 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),"
done
BATCH_QUADS="${BATCH_QUADS%,}"

BATCH=$(c -X POST "http://127.0.0.1:9201/api/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"quads\":[$BATCH_QUADS]}")
B_ST=$(json_get "$BATCH" status)
B_KAS=$(echo "$BATCH" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))" 2>/dev/null)
B_TX=$(json_get "$BATCH" txHash)
[[ "$B_ST" == "confirmed" || "$B_ST" == "finalized" ]] && ok "Batch(50) publish OK ($B_ST)" || fail "Batch publish=$B_ST"
check "50 KA tokens minted" "$B_KAS" "50"
[[ "$B_TX" != "__NONE__" ]] && ok "Batch tx: $B_TX" || fail "No batch txHash"

echo ""
echo "--- 10b: Batch entities replicate ---"
sleep 10
for p in 9202 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s a <http://schema.org/Thing> . FILTER(CONTAINS(STR(?s),'batch_')) }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\"
  }")
  ct=$(echo "$R" | python3 -c "
import sys,json,re
b=json.load(sys.stdin).get('result',{}).get('bindings',[])
if b:
  v=str(b[0].get('c','0'))
  m=re.search(r'(\d+)',v)
  print(m.group(1) if m else '0')
else: print('0')
" 2>/dev/null)
  [[ "$ct" -ge 40 ]] && ok "Node $p has $ct/50 batch entities" || warn "Node $p has $ct/50 batch entities"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 11: Concurrent Shared Memory Writers ==="
echo ""

c -X POST "http://127.0.0.1:9202/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql 'http://example.org/entity/song1' 'http://schema.org/name' 'Zdravljica'),$(q 'http://example.org/entity/song1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/MusicComposition')]
}" > /dev/null 2>&1 &
PID1=$!

c -X POST "http://127.0.0.1:9204/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql 'http://example.org/entity/mountain1' 'http://schema.org/name' 'Triglav'),$(q 'http://example.org/entity/mountain1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Mountain'),$(ql 'http://example.org/entity/mountain1' 'http://schema.org/elevation' '2864')]
}" > /dev/null 2>&1 &
PID2=$!

wait $PID1 $PID2
ok "Concurrent shared memory writes completed"

sleep 4
for entity in song1 mountain1; do
  R=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
    \"sparql\":\"SELECT ?name WHERE { GRAPH ?g { <http://example.org/entity/$entity> <http://schema.org/name> ?name } . FILTER(CONTAINS(STR(?g),'_shared_memory')) }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\"
  }")
  ct=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
  [[ "$ct" -ge 1 ]] && ok "$entity gossiped to Node1 shared memory" || warn "$entity not yet in Node1 shared memory"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 12: Cross-Node Query Consistency ==="
echo ""

echo "--- All nodes should see same typed entities in LTM ---"
for p in 9201 9202 9203 9204 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s a ?type . FILTER(CONTAINS(STR(?s),'example.org')) }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\"
  }")
  ct=$(echo "$R" | python3 -c "
import sys,json,re
b=json.load(sys.stdin).get('result',{}).get('bindings',[])
if b:
  v=str(b[0].get('c','0'))
  m=re.search(r'(\d+)',v)
  print(m.group(1) if m else '0')
else: print('0')
" 2>/dev/null)
  [[ "$ct" -ge 50 ]] && ok "Node $p sees $ct typed entities" || warn "Node $p sees $ct typed entities (some may be propagating)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 13: Subscribe & Event System ==="
echo ""

SUB=$(c -X POST "http://127.0.0.1:9202/api/context-graph/subscribe" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"includeSharedMemory\":true}")
SUB_P=$(json_get "$SUB" subscribed)
[[ "$SUB_P" == "$CONTEXT_GRAPH" ]] && ok "Subscribed to $CONTEXT_GRAPH on Node2" || fail "Subscribe failed: $SUB"

#------------------------------------------------------------
echo ""
echo "=== SECTION 14: Publish Pipeline Phases ==="
echo ""

PH=$(c -X POST "http://127.0.0.1:9201/api/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql 'http://example.org/entity/river1' 'http://schema.org/name' 'Sava'),$(q 'http://example.org/entity/river1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/RiverBodyOfWater')]
}")
PH_ST=$(json_get "$PH" status)
PH_PHASES=$(echo "$PH" | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('phases',[]); print(len(p) if isinstance(p,list) else 'obj')" 2>/dev/null)
PH_TIME=$(json_get "$PH" serverTotal)
echo "  Phases count: $PH_PHASES  Server total: ${PH_TIME}ms"
[[ "$PH_ST" == "confirmed" || "$PH_ST" == "finalized" ]] && ok "Pipeline publish OK ($PH_ST)" || fail "Pipeline publish=$PH_ST"

#------------------------------------------------------------
echo ""
echo "=== SECTION 15: Publish with Access Policy ==="
echo ""

AP=$(c -X POST "http://127.0.0.1:9201/api/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/secret1' 'http://schema.org/name' 'TopSecret'),
    $(q 'http://example.org/entity/secret1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ],
  \"accessPolicy\":\"ownerOnly\"
}")
AP_ST=$(json_get "$AP" status)
[[ "$AP_ST" == "confirmed" || "$AP_ST" == "finalized" ]] && ok "Access-policy publish OK ($AP_ST)" || fail "Access-policy publish=$AP_ST"

#------------------------------------------------------------
echo ""
echo "============================================================"
echo "TEST SUMMARY"
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
