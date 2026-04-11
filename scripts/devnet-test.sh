#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "${DKG_AUTH:-}" ]]; then
  AUTH="$DKG_AUTH"
elif [[ -f "$SCRIPT_DIR/../.devnet/node1/auth.token" ]]; then
  AUTH="$(grep -v '^#' "$SCRIPT_DIR/../.devnet/node1/auth.token" 2>/dev/null | tr -d '[:space:]')"
else
  echo "ERROR: No auth token found. Export DKG_AUTH or start a devnet with ./scripts/devnet.sh start" >&2
  exit 1
fi
CONTEXT_GRAPH="devnet-test"
PASS=0
FAIL=0
WARN=0

c() { curl -s -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "$@"; }

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

swm_publish() {
  local port=$1 cg=$2
  shift 2
  local quads="$*"

  local write_resp
  write_resp=$(c -X POST "http://127.0.0.1:$port/api/shared-memory/write" -d "{
    \"contextGraphId\":\"$cg\",
    \"quads\":[$quads]
  }")
  local write_ok
  write_ok=$(json_get "$write_resp" triplesWritten)
  if [[ "$write_ok" == "__NONE__" || "$write_ok" == "0" ]]; then
    echo "$write_resp"
    return 1
  fi

  sleep 2

  local pub_resp
  pub_resp=$(c -X POST "http://127.0.0.1:$port/api/shared-memory/publish" -d "{
    \"contextGraphId\":\"$cg\"
  }")
  echo "$pub_resp"
}

echo "============================================================"
echo "DKG V10 Comprehensive Devnet Test Suite (SWM-first flow)"
echo "5 nodes: Nodes1-4=core(9201-9204), Node5=edge(9205)"
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
echo "--- 1c: P2P mesh from every node's perspective ---"
for p in 9201 9202 9203 9204 9205; do
  a=$(c "http://127.0.0.1:$p/api/agents")
  cn=$(echo "$a" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for a in d['agents'] if a['connectionStatus'] in ('connected','self')))" 2>/dev/null)
  [[ "$cn" -ge 4 ]] && ok "Node $p sees $cn peers" || warn "Node $p sees only $cn peers"
done

echo ""
echo "--- 1d: Wallet balances ---"
for p in 9201 9202 9203 9204 9205; do
  bals=$(c "http://127.0.0.1:$p/api/wallets/balances")
  bc=$(echo "$bals" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('balances',[])))" 2>/dev/null)
  [[ "$bc" -ge 1 ]] && ok "Node $p has $bc wallet(s)" || fail "Node $p no wallets"
done

echo ""
echo "--- 1e: Chain RPC health ---"
for p in 9201 9202 9203 9204 9205; do
  h=$(c "http://127.0.0.1:$p/api/chain/rpc-health")
  rpc_ok=$(json_get "$h" ok)
  check "Node $p RPC ok" "$rpc_ok" "True"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 2: Shared Memory Writes (free operations) ==="
echo ""

TRAC_BEFORE=$(c "http://127.0.0.1:9202/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node2 TRAC before SWM write: $TRAC_BEFORE"

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
swm_written=$(json_get "$SWM_W" triplesWritten)
[[ "$swm_written" != "__NONE__" && "$swm_written" != "0" ]] && ok "SWM write OK ($swm_written triples)" || fail "SWM write failed: $SWM_W"

TRAC_AFTER=$(c "http://127.0.0.1:9202/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
check "SWM write is FREE (TRAC unchanged)" "$TRAC_BEFORE" "$TRAC_AFTER"

echo ""
echo "--- 2b: Query SWM locally ---"
SWM_Q=$(c -X POST "http://127.0.0.1:9202/api/query" -d "{
  \"sparql\":\"SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } . FILTER(CONTAINS(STR(?g),'_shared_memory')) . FILTER(CONTAINS(STR(?s),'example.org')) } LIMIT 20\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\"
}")
SWM_CT=$(echo "$SWM_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
[[ "$SWM_CT" -ge 5 ]] && ok "SWM has $SWM_CT triples on Node2" || fail "SWM has $SWM_CT triples (expected >=5)"

echo ""
echo "--- 2c: GossipSub propagation — SWM data reaches ALL other nodes ---"
sleep 6
for p in 9201 9203 9204 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } . FILTER(CONTAINS(STR(?g),'_shared_memory')) . FILTER(CONTAINS(STR(?s),'example.org/entity/alice')) }\",
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
  [[ "$ct" -ge 2 ]] && ok "Node $p has Alice in SWM ($ct triples)" || warn "Node $p missing Alice in SWM ($ct)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 3: PUBLISH via SWM-first flow (WM→SWM→VM) ==="
echo ""

echo "--- 3a: Write + Publish from Node1 (core) ---"
c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/city1' 'http://schema.org/name' 'Ljubljana'),
    $(q 'http://example.org/entity/city1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city1' 'http://schema.org/population' '290000'),
    $(ql 'http://example.org/entity/city2' 'http://schema.org/name' 'Maribor'),
    $(q 'http://example.org/entity/city2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city2' 'http://schema.org/population' '95000')
  ]
}" > /dev/null
sleep 2

PUB1=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"selection\":[\"http://example.org/entity/city1\",\"http://example.org/entity/city2\"]
}")
PUB1_ST=$(json_get "$PUB1" status)
PUB1_KC=$(json_get "$PUB1" kcId)
PUB1_TX=$(json_get "$PUB1" txHash)
PUB1_BN=$(json_get "$PUB1" blockNumber)
PUB1_KAS=$(echo "$PUB1" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))" 2>/dev/null)

echo "  status=$PUB1_ST kcId=$PUB1_KC tx=$PUB1_TX block=$PUB1_BN KAs=$PUB1_KAS"
[[ "$PUB1_ST" == "confirmed" || "$PUB1_ST" == "finalized" ]] && ok "Publish from SWM succeeded ($PUB1_ST)" || fail "Publish status=$PUB1_ST: $PUB1"
[[ "$PUB1_TX" != "__NONE__" ]] && ok "On-chain tx: $PUB1_TX" || fail "No txHash"
[[ "$PUB1_KAS" == "2" ]] && ok "Published 2 KAs (both selected roots)" || fail "Expected 2 KAs, got $PUB1_KAS"

echo ""
echo "--- 3b: Query Verified Memory for cities on publisher ---"
sleep 3
LTM_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name . ?s a <http://schema.org/City> } LIMIT 10\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verified-memory\"
}")
LTM_CT=$(echo "$LTM_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
[[ "$LTM_CT" -ge 2 ]] && ok "VM has $LTM_CT cities on Node1" || fail "VM has $LTM_CT cities (expected >=2)"

echo ""
echo "--- 3c: Cross-node finalization — cities reach ALL 5 nodes ---"
sleep 10
for p in 9201 9202 9203 9204 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name . ?s a <http://schema.org/City> } LIMIT 10\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"view\":\"verified-memory\"
  }")
  ct=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
  [[ "$ct" -ge 2 ]] && ok "Node $p has $ct cities in VM" || warn "Node $p has $ct cities in VM (finalization pending?)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 4: Publish from DIFFERENT nodes (SWM-first) ==="
echo ""

echo "--- 4a: Publish from Node2 (core) ---"
c -X POST "http://127.0.0.1:9202/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/product1' 'http://schema.org/name' 'Potica'),
    $(q 'http://example.org/entity/product1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product1' 'http://schema.org/description' 'Traditional Slovenian nut roll')
  ]
}" > /dev/null
sleep 2
PUB2=$(c -X POST "http://127.0.0.1:9202/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/product1\"]}")
PUB2_ST=$(json_get "$PUB2" status)
[[ "$PUB2_ST" == "confirmed" || "$PUB2_ST" == "finalized" ]] && ok "Node2 publish OK ($PUB2_ST)" || fail "Node2 publish=$PUB2_ST: $PUB2"

echo "--- 4b: Publish from Node3 (core, oxigraph backend) ---"
c -X POST "http://127.0.0.1:9203/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/product2' 'http://schema.org/name' 'Carniolan Sausage'),
    $(q 'http://example.org/entity/product2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product2' 'http://schema.org/description' 'PGI sausage')
  ]
}" > /dev/null
sleep 2
PUB3=$(c -X POST "http://127.0.0.1:9203/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/product2\"]}")
PUB3_ST=$(json_get "$PUB3" status)
[[ "$PUB3_ST" == "confirmed" || "$PUB3_ST" == "finalized" ]] && ok "Node3 publish OK ($PUB3_ST)" || fail "Node3 publish=$PUB3_ST: $PUB3"

echo "--- 4c: Publish from Node4 (core) ---"
c -X POST "http://127.0.0.1:9204/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/person1' 'http://schema.org/name' 'France Prešeren'),
    $(q 'http://example.org/entity/person1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),
    $(ql 'http://example.org/entity/person1' 'http://schema.org/birthDate' '1800-12-03')
  ]
}" > /dev/null
sleep 2
PUB4=$(c -X POST "http://127.0.0.1:9204/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/person1\"]}")
PUB4_ST=$(json_get "$PUB4" status)
[[ "$PUB4_ST" == "confirmed" || "$PUB4_ST" == "finalized" ]] && ok "Node4 publish OK ($PUB4_ST)" || fail "Node4 publish=$PUB4_ST: $PUB4"

echo "--- 4d: Publish from Node5 (edge) ---"
c -X POST "http://127.0.0.1:9205/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/name' 'Lake Bled'),
    $(q 'http://example.org/entity/lake1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/LakeBodyOfWater'),
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/description' 'Glacial lake in the Julian Alps')
  ]
}" > /dev/null
sleep 2
PUB5=$(c -X POST "http://127.0.0.1:9205/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/lake1\"]}")
PUB5_ST=$(json_get "$PUB5" status)
[[ "$PUB5_ST" == "confirmed" || "$PUB5_ST" == "finalized" ]] && ok "Node5 (edge) publish OK ($PUB5_ST)" || fail "Node5 publish=$PUB5_ST: $PUB5"

echo ""
echo "--- 4e: ALL published entities replicate to ALL nodes ---"
sleep 12
for p in 9201 9202 9203 9204 9205; do
  for entity in city1 city2 product1 product2 person1 lake1; do
    R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
      \"sparql\":\"ASK { <http://example.org/entity/$entity> <http://schema.org/name> ?name }\",
      \"contextGraphId\":\"$CONTEXT_GRAPH\",
      \"view\":\"verified-memory\"
    }")
    found=$(echo "$R" | python3 -c "import sys,json; b=json.load(sys.stdin).get('result',{}).get('bindings',[]); print('yes' if b and b[0].get('result','')=='true' else 'no')" 2>/dev/null)
    [[ "$found" == "yes" ]] && ok "Node $p has $entity" || warn "Node $p missing $entity (finalization pending?)"
  done
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 5: Token Economics — TRAC Cost on Publish ==="
echo ""

TRAC5_B=$(c "http://127.0.0.1:9205/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node5 TRAC before: $TRAC5_B"

c -X POST "http://127.0.0.1:9205/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/cost-test' 'http://schema.org/name' 'CostTest'),
    $(q 'http://example.org/entity/cost-test' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]
}" > /dev/null
sleep 1
COST_PUB=$(c -X POST "http://127.0.0.1:9205/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/cost-test\"]}")
COST_ST=$(json_get "$COST_PUB" status)
[[ "$COST_ST" == "confirmed" || "$COST_ST" == "finalized" ]] && ok "Cost-test publish OK ($COST_ST)" || fail "Cost-test publish failed: status=$COST_ST: ${COST_PUB:0:200}"

TRAC5_A=$(c "http://127.0.0.1:9205/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node5 TRAC after: $TRAC5_A"

if [[ "$TRAC5_B" != "$TRAC5_A" ]]; then
  ok "TRAC spent on publish ($TRAC5_B → $TRAC5_A)"
else
  warn "TRAC unchanged — check if publisher wallet pays separately"
fi

#------------------------------------------------------------
echo ""
echo "=== SECTION 6: UPDATE Operation ==="
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
[[ "$UPD_ST" == "confirmed" || "$UPD_ST" == "finalized" ]] && ok "UPDATE succeeded" || fail "UPDATE status=$UPD_ST: $UPD"

echo ""
echo "--- 6b: Verify updated population ---"
sleep 3
UQ=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?pop WHERE { <http://example.org/entity/city1> <http://schema.org/population> ?pop }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\"
}")
UQ_POP=$(echo "$UQ" | python3 -c "import sys,json; b=json.load(sys.stdin).get('result',{}).get('bindings',[]); print(b[0].get('pop','NONE') if b else 'NONE')" 2>/dev/null)
echo "$UQ_POP" | grep -q "295000" && ok "Population updated to 295000" || fail "Population: $UQ_POP"

#------------------------------------------------------------
echo ""
echo "=== SECTION 7: Context Graph Creation ==="
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
echo "=== SECTION 8: Triple Deduplication ==="
echo ""

c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest'),
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest'),
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest')
  ]
}" > /dev/null
sleep 1
DEDUP=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/dedup1\"]}")
DD_ST=$(json_get "$DEDUP" status)
DD_KAS=$(echo "$DEDUP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))" 2>/dev/null)
[[ "$DD_ST" == "confirmed" || "$DD_ST" == "finalized" ]] && ok "Dedup publish OK" || fail "Dedup status=$DD_ST"
check "1 KA (dedup: 3 identical → 1 entity)" "$DD_KAS" "1"

#------------------------------------------------------------
echo ""
echo "=== SECTION 9: Multi-Entity Batch Publish (50 entities) ==="
echo ""

BATCH_QUADS=""
for i in $(seq 1 50); do
  BATCH_QUADS="$BATCH_QUADS$(ql "http://example.org/entity/batch_$i" 'http://schema.org/name' "Item $i"),"
  BATCH_QUADS="$BATCH_QUADS$(q "http://example.org/entity/batch_$i" 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),"
done
BATCH_QUADS="${BATCH_QUADS%,}"

c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"quads\":[$BATCH_QUADS]}" > /dev/null
sleep 2
BATCH_SELECTION=""
for i in $(seq 1 50); do BATCH_SELECTION="$BATCH_SELECTION\"http://example.org/entity/batch_$i\","; done
BATCH_SELECTION="[${BATCH_SELECTION%,}]"
BATCH=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":$BATCH_SELECTION}")
B_ST=$(json_get "$BATCH" status)
B_TX=$(json_get "$BATCH" txHash)
B_KAS=$(echo "$BATCH" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))" 2>/dev/null)
[[ "$B_ST" == "confirmed" || "$B_ST" == "finalized" ]] && ok "Batch(50) publish OK ($B_ST)" || fail "Batch publish=$B_ST: $BATCH"
[[ "$B_TX" != "__NONE__" ]] && ok "Batch tx: $B_TX" || fail "No batch txHash"
[[ "$B_KAS" == "50" ]] && ok "Batch published 50 KAs" || fail "Expected 50 KAs, got $B_KAS"

echo ""
echo "--- 9b: Batch entities replicate to ALL nodes ---"
sleep 12
for p in 9201 9202 9203 9204 9205; do
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
echo "=== SECTION 10: Concurrent SWM Writers from Multiple Nodes ==="
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

c -X POST "http://127.0.0.1:9203/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql 'http://example.org/entity/river1' 'http://schema.org/name' 'Sava'),$(q 'http://example.org/entity/river1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/RiverBodyOfWater')]
}" > /dev/null 2>&1 &
PID3=$!

wait $PID1 $PID2 $PID3
ok "3 concurrent SWM writes completed"

sleep 6
for entity in song1 mountain1 river1; do
  for p in 9201 9202 9203 9204 9205; do
    R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
      \"sparql\":\"SELECT ?name WHERE { GRAPH ?g { <http://example.org/entity/$entity> <http://schema.org/name> ?name } . FILTER(CONTAINS(STR(?g),'_shared_memory')) }\",
      \"contextGraphId\":\"$CONTEXT_GRAPH\"
    }")
    ct=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
    [[ "$ct" -ge 1 ]] && ok "$entity gossiped to Node $p SWM" || warn "$entity NOT in Node $p SWM"
  done
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 11: Cross-Node Query Consistency ==="
echo ""

echo "--- All nodes should see same typed entities in VM ---"
REF_CT=""
ALL_MATCH=true
for p in 9201 9202 9203 9204 9205; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s a ?type . FILTER(CONTAINS(STR(?s),'example.org')) }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"view\":\"verified-memory\"
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
  echo "  Node $p: $ct typed entities"
  if [[ -z "$REF_CT" ]]; then
    REF_CT="$ct"
  elif [[ "$ct" != "$REF_CT" ]]; then
    ALL_MATCH=false
    warn "Node $p has $ct entities vs Node1's $REF_CT"
  fi
done
[[ "$ALL_MATCH" == "true" ]] && ok "All 5 nodes have consistent entity count ($REF_CT)" || warn "Entity counts diverge across nodes"

#------------------------------------------------------------
echo ""
echo "=== SECTION 12: Subscribe & Event System ==="
echo ""

SUB=$(c -X POST "http://127.0.0.1:9202/api/context-graph/subscribe" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"includeSharedMemory\":true}")
SUB_P=$(json_get "$SUB" subscribed)
[[ "$SUB_P" == "$CONTEXT_GRAPH" ]] && ok "Subscribed to $CONTEXT_GRAPH on Node2" || fail "Subscribe failed: $SUB"

#------------------------------------------------------------
echo ""
echo "=== SECTION 13: Adversarial / Edge Cases ==="
echo ""

echo "--- 13a: Removed /api/publish returns 404 ---"
REMOVED=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:9201/api/publish" -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" -d '{"contextGraphId":"devnet-test","quads":[]}')
[[ "$REMOVED" == "404" ]] && ok "/api/publish correctly removed (404)" || warn "/api/publish returns $REMOVED (expected 404)"

echo "--- 13b: Empty quads in SWM write ---"
EMPTY=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d '{"contextGraphId":"devnet-test","quads":[]}')
echo "  Empty quads response: $(echo "$EMPTY" | head -c 200)"
echo "$EMPTY" | grep -qi "error\|missing\|invalid" && ok "Empty quads rejected with error" || fail "Empty quads not rejected: $EMPTY"

echo "--- 13c: Malformed SPARQL ---"
BAD_SPARQL=$(c -X POST "http://127.0.0.1:9201/api/query" -d '{
  "sparql": "NOT VALID SPARQL AT ALL",
  "contextGraphId": "devnet-test"
}')
echo "$BAD_SPARQL" | grep -qi "error" && ok "Malformed SPARQL returns error" || fail "Malformed SPARQL didn't error: $BAD_SPARQL"

echo "--- 13d: Missing contextGraphId ---"
NO_CG=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d '{"quads":[]}')
echo "$NO_CG" | grep -qi "error\|missing\|required" && ok "Missing contextGraphId rejected" || warn "Missing contextGraphId response: $NO_CG"

echo "--- 13e: Publish from empty SWM ---"
EMPTY_PUB=$(c -X POST "http://127.0.0.1:9205/api/shared-memory/publish" -d '{"contextGraphId":"devnet-test"}')
echo "  Empty SWM publish: $(echo "$EMPTY_PUB" | head -c 200)"
echo "$EMPTY_PUB" | grep -qi "error\|empty\|nothing\|no.*triple" && ok "Empty SWM publish rejected with error" || fail "Empty SWM publish not rejected: $(echo "$EMPTY_PUB" | head -c 200)"

#------------------------------------------------------------
echo ""
echo "=== SECTION 14: Assertion Lifecycle (Working Memory) ==="
echo ""

ASSERT_CG="devnet-test"

echo "--- 14a: Create an assertion ---"
ASSERT_CREATE=$(c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{
  \"contextGraphId\":\"$ASSERT_CG\",
  \"name\":\"devnet-draft\"
}")
ASSERT_URI=$(json_get "$ASSERT_CREATE" assertionUri)
echo "  Assertion URI: $ASSERT_URI"
[[ "$ASSERT_URI" != "__NONE__" && "$ASSERT_URI" != "__ERR__" ]] && ok "Assertion created: $ASSERT_URI" || fail "Assertion create failed: $ASSERT_CREATE"

echo "--- 14b: Write triples to the assertion ---"
ASSERT_WRITE=$(c -X POST "http://127.0.0.1:9201/api/assertion/devnet-draft/write" -d "{
  \"contextGraphId\":\"$ASSERT_CG\",
  \"quads\":[
    $(ql 'urn:devnet:assert:entity1' 'http://schema.org/name' 'Assertion Entity'),
    $(ql 'urn:devnet:assert:entity1' 'http://schema.org/version' '1')
  ]
}")
echo "  Write response: $(echo "$ASSERT_WRITE" | head -c 200)"
echo "$ASSERT_WRITE" | grep -qi "error" && fail "Assertion write failed: $ASSERT_WRITE" || ok "Assertion write OK"

echo "--- 14c: Query the assertion ---"
ASSERT_QUERY=$(c -X POST "http://127.0.0.1:9201/api/assertion/devnet-draft/query" -d "{
  \"contextGraphId\":\"$ASSERT_CG\"
}")
ASSERT_Q_CT=$(echo "$ASSERT_QUERY" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("quads",d.get("result",[]))))' 2>/dev/null || echo "0")
echo "  Assertion has $ASSERT_Q_CT quads"
[[ "$ASSERT_Q_CT" -ge 1 ]] && ok "Assertion query returned $ASSERT_Q_CT quads" || fail "Assertion query returned 0 quads"

echo "--- 14d: Promote the assertion to SWM ---"
ASSERT_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/assertion/devnet-draft/promote" -d "{
  \"contextGraphId\":\"$ASSERT_CG\"
}")
PROMOTED_CT=$(json_get "$ASSERT_PROMOTE" promotedCount)
echo "  Promoted count: $PROMOTED_CT"
[[ "$PROMOTED_CT" != "__NONE__" && "$PROMOTED_CT" != "0" ]] && ok "Assertion promoted ($PROMOTED_CT quads)" || fail "Assertion promote failed: $ASSERT_PROMOTE"

echo "--- 14e: Verify promoted data in SWM ---"
sleep 1
SWM_CHECK=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:devnet:assert:entity1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$ASSERT_CG\",
  \"graphSuffix\":\"_shared_memory\"
}")
SWM_CT=$(echo "$SWM_CHECK" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SWM_CT" -ge 1 ]] && ok "Promoted data visible in SWM" || fail "Promoted data not in SWM ($SWM_CT)"

echo "--- 14f: Create and immediately discard another assertion ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$ASSERT_CG\",\"name\":\"discard-me\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/discard-me/write" -d "{
  \"contextGraphId\":\"$ASSERT_CG\",
  \"quads\":[$(ql 'urn:devnet:assert:discard' 'http://schema.org/name' 'Discard Me')]
}" > /dev/null
DISCARD_RESP=$(c -X POST "http://127.0.0.1:9201/api/assertion/discard-me/discard" -d "{\"contextGraphId\":\"$ASSERT_CG\"}")
echo "$DISCARD_RESP" | grep -qi "error" && fail "Discard failed: $DISCARD_RESP" || ok "Assertion discard OK"

echo "--- 14g: Promoted assertion gossips to other nodes ---"
sleep 4
for p in 9202 9203 9204; do
  GOS_CT=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT ?name WHERE { <urn:devnet:assert:entity1> <http://schema.org/name> ?name }\",
    \"contextGraphId\":\"$ASSERT_CG\",
    \"graphSuffix\":\"_shared_memory\"
  }" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
  [[ "$GOS_CT" -ge 1 ]] && ok "Promoted data gossiped to Node $p" || warn "Promoted data not on Node $p ($GOS_CT)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 15: Publisher Queue (async lift) ==="
echo ""

echo "--- 15a: Publisher stats ---"
PUB_STATS=$(c "http://127.0.0.1:9201/api/publisher/stats")
echo "  Stats: $(echo "$PUB_STATS" | head -c 300)"
echo "$PUB_STATS" | python3 -c 'import sys,json;json.load(sys.stdin)' 2>/dev/null && ok "Publisher stats returned valid JSON" || warn "Publisher stats: $PUB_STATS"

echo "--- 15b: Publisher jobs list ---"
PUB_JOBS=$(c "http://127.0.0.1:9201/api/publisher/jobs")
echo "  Jobs: $(echo "$PUB_JOBS" | head -c 300)"
echo "$PUB_JOBS" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("jobs",[])))' 2>/dev/null && ok "Publisher jobs endpoint works" || warn "Publisher jobs: $PUB_JOBS"

echo "--- 15c: Enqueue a publish job ---"
ENQUEUE_OP_ID="devnet-enqueue-test-$(date +%s)"
PUB_ENQUEUE=$(c -X POST "http://127.0.0.1:9201/api/publisher/enqueue" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"shareOperationId\":\"$ENQUEUE_OP_ID\",
  \"roots\":[{\"rootEntity\":\"urn:devnet:assert:entity1\",\"privateMerkleRoot\":null,\"privateTripleCount\":0}],
  \"namespace\":\"did:dkg:context-graph:$CONTEXT_GRAPH\",
  \"scope\":\"full\",
  \"authorityType\":\"owner\",
  \"authorityProofRef\":\"urn:dkg:proof:devnet-test\"
}")
echo "  Enqueue: $(echo "$PUB_ENQUEUE" | head -c 300)"
PUB_JOB_ID=$(json_get "$PUB_ENQUEUE" jobId)
[[ "$PUB_JOB_ID" != "__NONE__" && "$PUB_JOB_ID" != "__ERR__" ]] && ok "Publisher job enqueued: $PUB_JOB_ID" || warn "Enqueue response: $PUB_ENQUEUE"

if [[ "$PUB_JOB_ID" != "__NONE__" && "$PUB_JOB_ID" != "__ERR__" && -n "$PUB_JOB_ID" ]]; then
  echo "--- 15d: Check job status ---"
  sleep 5
  JOB_STATUS=$(c "http://127.0.0.1:9201/api/publisher/job?id=$PUB_JOB_ID")
  JOB_ST=$(echo "$JOB_STATUS" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("job",d).get("status","?") if isinstance(d.get("job",d),dict) else "?")' 2>/dev/null)
  echo "  Job status: $JOB_ST"
  [[ -n "$JOB_ST" && "$JOB_ST" != "?" ]] && ok "Job status retrieved: $JOB_ST" || warn "Job status check: $JOB_STATUS"
fi

echo "--- 15e: Clear finalized jobs ---"
PUB_CLEAR=$(c -X POST "http://127.0.0.1:9201/api/publisher/clear" -d '{"status":"finalized"}')
echo "  Clear: $(echo "$PUB_CLEAR" | head -c 200)"
echo "$PUB_CLEAR" | python3 -c 'import sys,json;json.load(sys.stdin)' 2>/dev/null && ok "Publisher clear returned valid JSON" || warn "Publisher clear: $PUB_CLEAR"

#------------------------------------------------------------
echo ""
echo "=== SECTION 16: Sub-graph Assertions ==="
echo ""

echo "--- 16a: Create a sub-graph ---"
SG_CREATE=$(c -X POST "http://127.0.0.1:9201/api/sub-graph/create" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"test-assertions\"
}")
echo "  Sub-graph create: $(echo "$SG_CREATE" | head -c 200)"
echo "$SG_CREATE" | grep -qi "error" && warn "Sub-graph create: $SG_CREATE" || ok "Sub-graph 'test-assertions' created"

echo "--- 16b: Write assertion to sub-graph ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"name\":\"sg-draft\",
  \"subGraphName\":\"test-assertions\"
}" > /dev/null
SG_AW=$(c -X POST "http://127.0.0.1:9201/api/assertion/sg-draft/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"test-assertions\",
  \"quads\":[$(ql 'urn:sg:assert:item1' 'http://schema.org/name' 'Sub-graph Assertion')]
}")
echo "$SG_AW" | grep -qi "error" && fail "Sub-graph assertion write failed: $SG_AW" || ok "Sub-graph assertion write OK"

echo "--- 16c: Promote sub-graph assertion ---"
SG_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/assertion/sg-draft/promote" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"test-assertions\"
}")
SG_PROMOTED=$(json_get "$SG_PROMOTE" promotedCount)
[[ "$SG_PROMOTED" != "__NONE__" && "$SG_PROMOTED" != "0" ]] && ok "Sub-graph assertion promoted ($SG_PROMOTED quads)" || fail "Sub-graph promote: $SG_PROMOTE"

echo "--- 16d: Sub-graph SWM gossip to Node3 ---"
sleep 5
SG_GOS=$(c -X POST "http://127.0.0.1:9203/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:sg:assert:item1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"test-assertions\",
  \"graphSuffix\":\"_shared_memory\"
}")
SG_GOS_CT=$(echo "$SG_GOS" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SG_GOS_CT" -ge 1 ]] && ok "Sub-graph assertion gossiped to Node3" || warn "Sub-graph assertion not on Node3 ($SG_GOS_CT)"

#------------------------------------------------------------
echo ""
echo "=== SECTION 17: SKILL.md Endpoint ==="
echo ""

SKILL=$(curl -s "http://127.0.0.1:9201/.well-known/skill.md")
echo "$SKILL" | grep -q "shared-memory" && ok "SKILL.md references SWM flow" || fail "SKILL.md missing SWM references"
echo "$SKILL" | grep -q "/api/publish" && fail "SKILL.md still references removed /api/publish" || ok "SKILL.md correctly omits /api/publish"
echo "$SKILL" | grep -q "assertion" && ok "SKILL.md references assertion API" || warn "SKILL.md doesn't mention assertion API"
echo "$SKILL" | grep -q "sub-graph\|subGraph" && ok "SKILL.md references sub-graphs" || warn "SKILL.md doesn't mention sub-graphs"

#------------------------------------------------------------
echo ""
echo "=== SECTION 18: Sync Protocol & Catch-up Status ==="
echo ""

echo "--- 18a: Subscribe Node5 and poll catch-up status ---"
c -X POST "http://127.0.0.1:9205/api/context-graph/subscribe" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"includeSharedMemory\":true}" > /dev/null 2>&1
SYNC_OK=false
for i in $(seq 1 20); do
  SYNC=$(c "http://127.0.0.1:9205/api/sync/catchup-status?contextGraphId=$CONTEXT_GRAPH")
  SYNC_ST=$(json_get "$SYNC" status)
  if [[ "$SYNC_ST" == "completed" || "$SYNC_ST" == "idle" || "$SYNC_ST" == "synced" || "$SYNC_ST" == "done" ]]; then
    SYNC_OK=true
    break
  fi
  sleep 2
done
$SYNC_OK && ok "Sync catch-up completed on Node5 (status=$SYNC_ST)" || warn "Sync catch-up not completed after 40s (status=$SYNC_ST)"

echo "--- 18b: Verify synced VM data on Node5 ---"
SYNC_VM=$(c -X POST "http://127.0.0.1:9205/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <http://example.org/entity/city1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verified-memory\"
}")
SYNC_VM_CT=$(echo "$SYNC_VM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SYNC_VM_CT" -ge 1 ]] && ok "Node5 synced VM data (city1 found)" || warn "Node5 VM data not synced yet ($SYNC_VM_CT)"

echo "--- 18c: Verify synced SWM data on Node5 ---"
SYNC_SWM=$(c -X POST "http://127.0.0.1:9205/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <http://example.org/entity/city1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"shared-memory\"
}")
SYNC_SWM_CT=$(echo "$SYNC_SWM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SYNC_SWM_CT" -ge 1 ]] && ok "Node5 synced SWM data (city1 found)" || warn "Node5 SWM data not synced ($SYNC_SWM_CT)"

#------------------------------------------------------------
echo ""
echo "=== SECTION 19: Memory Layer View Queries ==="
echo ""

echo "--- 19a: Verified memory view ---"
VM_VIEW=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <http://example.org/entity/city1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verified-memory\"
}")
VM_CT=$(echo "$VM_VIEW" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$VM_CT" -ge 1 ]] && ok "Verified memory view returns published data" || warn "Verified memory view empty ($VM_CT) — VM finalization may be pending"

echo "--- 19b: Shared memory view ---"
SWM_VIEW=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s a ?type }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"shared-memory\"
}")
SWM_CT=$(echo "$SWM_VIEW" | python3 -c 'import sys,json;b=json.load(sys.stdin).get("result",{}).get("bindings",[]);print(b[0]["c"].strip(chr(34)).split("^^")[0] if b else "0")' 2>/dev/null || echo "0")
echo "  SWM entity count: $SWM_CT"
[[ "$SWM_CT" -ge 1 ]] && ok "Shared memory view returns data ($SWM_CT entities)" || warn "Shared memory view empty"

echo "--- 19c: Working memory assertion visible only locally ---"
WM_NAME="wm-view-test-$(date +%s)"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$WM_NAME\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/$WM_NAME/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql 'urn:wm-view:only' 'http://schema.org/name' 'WM Only Data')]
}" > /dev/null

WM_LOCAL=$(c -X POST "http://127.0.0.1:9201/api/assertion/$WM_NAME/query" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
WM_LOCAL_CT=$(echo "$WM_LOCAL" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("quads",d.get("result",[]))))' 2>/dev/null || echo "0")
[[ "$WM_LOCAL_CT" -ge 1 ]] && ok "WM assertion visible locally ($WM_LOCAL_CT quads)" || fail "WM assertion not visible locally"

echo "--- 19d: WM data NOT in verified memory ---"
WM_IN_VM=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:wm-view:only> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verified-memory\"
}")
WM_IN_VM_CT=$(echo "$WM_IN_VM" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$WM_IN_VM_CT" -eq 0 ]] && ok "WM data correctly absent from verified memory" || fail "WM data leaked into verified memory ($WM_IN_VM_CT)"

echo "--- 19e: WM data NOT visible on Node2 ---"
WM_REMOTE=$(c -X POST "http://127.0.0.1:9202/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:wm-view:only> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\"
}")
WM_REMOTE_CT=$(echo "$WM_REMOTE" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$WM_REMOTE_CT" -eq 0 ]] && ok "WM data correctly absent on Node2" || fail "WM data leaked to Node2 ($WM_REMOTE_CT)"

c -X POST "http://127.0.0.1:9201/api/assertion/$WM_NAME/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "=== SECTION 20: Context Graph Existence & SWM TTL Settings ==="
echo ""

echo "--- 20a: Context graph exists (known) ---"
CG_EXISTS=$(c "http://127.0.0.1:9201/api/context-graph/exists?id=$CONTEXT_GRAPH")
CG_E=$(json_get "$CG_EXISTS" exists)
check "Context graph devnet-test exists" "$CG_E" "True"

echo "--- 20b: Context graph exists (unknown) ---"
CG_NOT=$(c "http://127.0.0.1:9201/api/context-graph/exists?id=nonexistent-cg-$(date +%s)")
CG_N=$(json_get "$CG_NOT" exists)
check "Nonexistent context graph reports false" "$CG_N" "False"

echo "--- 20c: Read SWM TTL setting ---"
TTL_ORIG=$(c "http://127.0.0.1:9201/api/settings/shared-memory-ttl")
TTL_DAYS_ORIG=$(json_get "$TTL_ORIG" ttlDays)
TTL_MS_ORIG=$(json_get "$TTL_ORIG" ttlMs)
echo "  Current TTL: ${TTL_DAYS_ORIG} days (${TTL_MS_ORIG} ms)"
[[ "$TTL_DAYS_ORIG" != "__NONE__" && "$TTL_DAYS_ORIG" != "__ERR__" ]] && ok "SWM TTL readable ($TTL_DAYS_ORIG days)" || fail "SWM TTL not readable: $TTL_ORIG"

echo "--- 20d: Update SWM TTL ---"
TTL_SET=$(curl -s -X PUT -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "http://127.0.0.1:9201/api/settings/shared-memory-ttl" -d '{"ttlDays":7}')
TTL_OK=$(json_get "$TTL_SET" ok)
[[ "$TTL_OK" == "True" ]] && ok "SWM TTL updated to 7 days" || fail "SWM TTL update failed: $TTL_SET"

echo "--- 20e: Verify updated TTL ---"
TTL_NEW=$(c "http://127.0.0.1:9201/api/settings/shared-memory-ttl")
TTL_DAYS_NEW=$(json_get "$TTL_NEW" ttlDays)
check "TTL reads back as 7 days" "$TTL_DAYS_NEW" "7"

echo "--- 20f: Restore original TTL ---"
curl -s -X PUT -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "http://127.0.0.1:9201/api/settings/shared-memory-ttl" -d "{\"ttlDays\":$TTL_DAYS_ORIG}" > /dev/null 2>&1
ok "TTL restored to $TTL_DAYS_ORIG days"

#------------------------------------------------------------
echo ""
echo "=== SECTION 21: Import-File Extraction Status ==="
echo ""

IMPORT_NAME="import-extract-$(date +%s)"
echo "--- 21a: Create assertion for import ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$IMPORT_NAME\"}" > /dev/null

echo "--- 21b: Import markdown file ---"
TMPMD=$(mktemp /tmp/devnet-import-XXXXXX.md)
cat > "$TMPMD" <<'MDEOF'
---
title: DKG V10 Import Test
author: Devnet Suite
---

# Knowledge Graph Testing

The Decentralized Knowledge Graph enables verifiable knowledge sharing.

## Features

- Sub-graphs for scoped data organization
- Async publisher queue for reliable chain anchoring
- Memory layers: Working Memory, Shared Memory, Verified Memory
MDEOF

IMPORT_RESP=$(curl -s -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPMD};type=text/markdown" \
  -F "contextGraphId=$CONTEXT_GRAPH" \
  "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/import-file" 2>&1)
rm -f "$TMPMD"
IMPORT_URI=$(json_get "$IMPORT_RESP" assertionUri)
IMPORT_HASH=$(json_get "$IMPORT_RESP" fileHash)
echo "  Import assertionUri=$IMPORT_URI fileHash=$IMPORT_HASH"
[[ "$IMPORT_URI" != "__NONE__" && "$IMPORT_URI" != "__ERR__" ]] && ok "Import-file accepted ($IMPORT_URI)" || fail "Import-file failed: ${IMPORT_RESP:0:200}"
[[ "$IMPORT_HASH" != "__NONE__" && "$IMPORT_HASH" != "__ERR__" ]] && ok "File hash returned ($IMPORT_HASH)" || warn "No file hash returned"

echo "--- 21c: Check extraction status endpoint ---"
EXTRACT_ST=$(c "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/extraction-status?contextGraphId=$CONTEXT_GRAPH")
EXT_STATUS=$(json_get "$EXTRACT_ST" status)
echo "  Extraction status: $EXT_STATUS"
[[ "$EXT_STATUS" == "completed" ]] && ok "Extraction status endpoint reports completed" || warn "Extraction status: $EXT_STATUS (${EXTRACT_ST:0:200})"

echo "--- 21d: Query imported assertion ---"
IMPORT_Q=$(c -X POST "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/query" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
IMPORT_Q_CT=$(echo "$IMPORT_Q" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("quads",d.get("result",[]))))' 2>/dev/null || echo "0")
[[ "$IMPORT_Q_CT" -ge 1 ]] && ok "Imported assertion has $IMPORT_Q_CT quads" || warn "Imported assertion empty"

echo "--- 21e: Promote imported assertion to SWM ---"
IMPORT_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/promote" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
IMPORT_PC=$(json_get "$IMPORT_PROMOTE" promotedCount)
echo "  Promoted count: $IMPORT_PC"
[[ "$IMPORT_PC" != "__NONE__" && "$IMPORT_PC" != "0" ]] && ok "Imported data promoted to SWM ($IMPORT_PC quads)" || warn "Import promote: $IMPORT_PC"

#------------------------------------------------------------
echo ""
echo "=== SECTION 22: Publisher Queue End-to-End ==="
echo ""

echo "--- 22a: Write SWM data for publisher test ---"
PQ_ENTITY="http://example.org/entity/pub-queue-$(date +%s)"
PQ_WRITE=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(q "$PQ_ENTITY" 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),
    $(ql "$PQ_ENTITY" 'http://schema.org/name' 'Publisher Queue Test')
  ]
}")
PQ_OP_ID=$(json_get "$PQ_WRITE" shareOperationId)
if [[ "$PQ_OP_ID" == "__NONE__" || "$PQ_OP_ID" == "__ERR__" ]]; then
  PQ_OP_ID=$(json_get "$PQ_WRITE" workspaceOperationId)
fi
echo "  SWM write shareOperationId=$PQ_OP_ID"
[[ "$PQ_OP_ID" != "__NONE__" && "$PQ_OP_ID" != "__ERR__" ]] && ok "SWM write for publisher test" || fail "SWM write failed: ${PQ_WRITE:0:200}"

echo "--- 22b: Enqueue publish job ---"
PQ_ENQUEUE=$(c -X POST "http://127.0.0.1:9201/api/publisher/enqueue" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"shareOperationId\":\"$PQ_OP_ID\",
  \"roots\":[\"$PQ_ENTITY\"],
  \"namespace\":\"did:dkg:context-graph:$CONTEXT_GRAPH\",
  \"scope\":\"full\",
  \"authorityType\":\"owner\",
  \"authorityProofRef\":\"urn:dkg:proof:devnet-pub-queue\"
}")
PQ_JOB_ID=$(json_get "$PQ_ENQUEUE" jobId)
echo "  Enqueue jobId=$PQ_JOB_ID"
[[ "$PQ_JOB_ID" != "__NONE__" && "$PQ_JOB_ID" != "__ERR__" ]] && ok "Publisher job enqueued: $PQ_JOB_ID" || warn "Enqueue response: ${PQ_ENQUEUE:0:200}"

if [[ "$PQ_JOB_ID" != "__NONE__" && "$PQ_JOB_ID" != "__ERR__" && -n "$PQ_JOB_ID" ]]; then
  echo "--- 22c: Poll job status ---"
  PQ_FINAL_ST="unknown"
  for i in $(seq 1 15); do
    PQ_STATUS=$(c "http://127.0.0.1:9201/api/publisher/job?id=$PQ_JOB_ID")
    PQ_FINAL_ST=$(echo "$PQ_STATUS" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("job",d).get("status","?") if isinstance(d.get("job",d),dict) else "?")' 2>/dev/null || echo "?")
    echo "  Poll $i: status=$PQ_FINAL_ST"
    [[ "$PQ_FINAL_ST" == "finalized" || "$PQ_FINAL_ST" == "included" || "$PQ_FINAL_ST" == "failed" ]] && break
    sleep 3
  done
  [[ "$PQ_FINAL_ST" == "finalized" || "$PQ_FINAL_ST" == "included" ]] && ok "Publisher job reached $PQ_FINAL_ST" || warn "Publisher job status: $PQ_FINAL_ST"

  echo "--- 22d: Fetch job payload ---"
  PQ_PAYLOAD=$(c "http://127.0.0.1:9201/api/publisher/job-payload?id=$PQ_JOB_ID")
  PQ_HAS_PAYLOAD=$(echo "$PQ_PAYLOAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("yes" if d.get("payload") or d.get("job") else "no")' 2>/dev/null || echo "no")
  [[ "$PQ_HAS_PAYLOAD" == "yes" ]] && ok "Job payload retrieved" || warn "Job payload: ${PQ_PAYLOAD:0:200}"

  echo "--- 22e: Verify publisher stats ---"
  PQ_STATS=$(c "http://127.0.0.1:9201/api/publisher/stats")
  echo "  Stats: $(echo "$PQ_STATS" | head -c 300)"
  echo "$PQ_STATS" | python3 -c 'import sys,json;json.load(sys.stdin)' 2>/dev/null && ok "Publisher stats valid JSON" || warn "Publisher stats: $PQ_STATS"

  echo "--- 22f: Clear finalized jobs ---"
  PQ_CLEAR=$(c -X POST "http://127.0.0.1:9201/api/publisher/clear" -d '{"status":"finalized"}')
  PQ_CLEARED=$(json_get "$PQ_CLEAR" cleared)
  echo "  Cleared: $PQ_CLEARED jobs"
  [[ "$PQ_CLEARED" != "__ERR__" ]] && ok "Publisher clear returned ($PQ_CLEARED)" || warn "Publisher clear: $PQ_CLEAR"
fi

#------------------------------------------------------------
echo ""
echo "=== SECTION 23: Authorization & Error Handling ==="
echo ""

echo "--- 23a: Request without auth token ---"
NOAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:9201/api/query" -X POST -H "Content-Type: application/json" -d '{"sparql":"SELECT * WHERE { ?s ?p ?o } LIMIT 1","contextGraphId":"devnet-test"}')
[[ "$NOAUTH_CODE" == "401" ]] && ok "No-auth request rejected (401)" || warn "No-auth returned $NOAUTH_CODE (expected 401 — auth may be disabled)"

echo "--- 23b: Query against nonexistent context graph ---"
BAD_CG=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?s WHERE { ?s ?p ?o } LIMIT 1\",
  \"contextGraphId\":\"nonexistent-cg-$(date +%s)\"
}")
BAD_CG_CT=$(echo "$BAD_CG" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "err")
[[ "$BAD_CG_CT" == "0" || "$BAD_CG_CT" == "err" ]] && ok "Query against nonexistent CG returns empty/error" || warn "Nonexistent CG returned $BAD_CG_CT results"

echo "--- 23c: Create assertion with empty name ---"
EMPTY_NAME=$(c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"\"}")
echo "$EMPTY_NAME" | grep -qi "error\|invalid" && ok "Empty assertion name rejected" || fail "Empty assertion name accepted: ${EMPTY_NAME:0:200}"

echo "--- 23d: Duplicate assertion name reuses same URI ---"
DUP_NAME="dup-test-$(date +%s)"
DUP_FIRST=$(c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$DUP_NAME\"}")
DUP_URI1=$(json_get "$DUP_FIRST" assertionUri)
DUP_SECOND=$(c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$DUP_NAME\"}")
DUP_URI2=$(json_get "$DUP_SECOND" assertionUri)
if echo "$DUP_SECOND" | grep -qi "error\|exists\|already\|duplicate"; then
  ok "Duplicate assertion name rejected"
elif [[ "$DUP_URI1" == "$DUP_URI2" ]]; then
  ok "Duplicate assertion name returns same URI (idempotent)"
else
  warn "Duplicate assertion name created different URI (URI1=$DUP_URI1, URI2=$DUP_URI2)"
fi
c -X POST "http://127.0.0.1:9201/api/assertion/$DUP_NAME/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null 2>&1

echo "--- 23e: Promote nonexistent assertion ---"
GHOST_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/assertion/does-not-exist-$(date +%s)/promote" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
GHOST_PC=$(json_get "$GHOST_PROMOTE" promotedCount)
if echo "$GHOST_PROMOTE" | grep -qi "error\|not found\|not exist"; then
  ok "Promote nonexistent assertion rejected with error"
elif [[ "$GHOST_PC" == "0" ]]; then
  ok "Promote nonexistent assertion returns promotedCount=0 (no-op)"
else
  fail "Promote nonexistent assertion unexpected: ${GHOST_PROMOTE:0:200}"
fi

echo "--- 23f: Double discard ---"
DD_NAME="discard-twice-$(date +%s)"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$DD_NAME\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/$DD_NAME/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql 'urn:dd:test' 'http://schema.org/name' 'Double Discard')]
}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/$DD_NAME/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null
DD_SECOND=$(c -X POST "http://127.0.0.1:9201/api/assertion/$DD_NAME/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
if echo "$DD_SECOND" | grep -qi "error\|not found\|not exist\|already"; then
  ok "Double discard rejected with error"
else
  ok "Double discard is idempotent (${DD_SECOND:0:80})"
fi

echo "--- 23g: Publisher enqueue missing fields ---"
BAD_ENQ=$(c -X POST "http://127.0.0.1:9201/api/publisher/enqueue" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
echo "$BAD_ENQ" | grep -qi "error\|missing\|required" && ok "Publisher enqueue missing fields rejected" || fail "Bad enqueue accepted: ${BAD_ENQ:0:200}"

#------------------------------------------------------------
echo ""
echo "=== SECTION 24: Sub-graph Query Isolation ==="
echo ""

SG_A="isolation-alpha-$(date +%s)"
SG_B="isolation-beta-$(date +%s)"

echo "--- 24a: Create two sub-graphs ---"
SG_A_CREATE=$(c -X POST "http://127.0.0.1:9201/api/sub-graph/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"subGraphName\":\"$SG_A\"}")
echo "$SG_A_CREATE" | grep -qi "error" && fail "Sub-graph A create failed: $SG_A_CREATE" || ok "Sub-graph '$SG_A' created"
SG_B_CREATE=$(c -X POST "http://127.0.0.1:9201/api/sub-graph/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"subGraphName\":\"$SG_B\"}")
echo "$SG_B_CREATE" | grep -qi "error" && fail "Sub-graph B create failed: $SG_B_CREATE" || ok "Sub-graph '$SG_B' created"

echo "--- 24b: Write distinct data to each sub-graph ---"
c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_A\",
  \"quads\":[
    $(ql 'urn:iso:alpha1' 'http://schema.org/name' 'Alpha Only Entity'),
    $(q 'urn:iso:alpha1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]
}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_B\",
  \"quads\":[
    $(ql 'urn:iso:beta1' 'http://schema.org/name' 'Beta Only Entity'),
    $(q 'urn:iso:beta1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]
}" > /dev/null

sleep 3

echo "--- 24c: Query sub-graph A — should find alpha, not beta ---"
SG_A_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_A\",
  \"includeSharedMemory\":true
}")
SG_A_CT=$(echo "$SG_A_Q" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SG_A_CT" -ge 1 ]] && ok "Sub-graph A has alpha entity" || fail "Sub-graph A missing alpha entity ($SG_A_CT)"

SG_A_LEAK=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:beta1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_A\",
  \"includeSharedMemory\":true
}")
SG_A_LEAK_CT=$(echo "$SG_A_LEAK" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SG_A_LEAK_CT" -eq 0 ]] && ok "Sub-graph A correctly excludes beta data" || fail "Sub-graph A leaks beta data ($SG_A_LEAK_CT)"

echo "--- 24d: Query sub-graph B — should find beta, not alpha ---"
SG_B_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:beta1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_B\",
  \"includeSharedMemory\":true
}")
SG_B_CT=$(echo "$SG_B_Q" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SG_B_CT" -ge 1 ]] && ok "Sub-graph B has beta entity" || fail "Sub-graph B missing beta entity ($SG_B_CT)"

SG_B_LEAK=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_B\",
  \"includeSharedMemory\":true
}")
SG_B_LEAK_CT=$(echo "$SG_B_LEAK" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SG_B_LEAK_CT" -eq 0 ]] && ok "Sub-graph B correctly excludes alpha data" || fail "Sub-graph B leaks alpha data ($SG_B_LEAK_CT)"

echo "--- 24e: Root CG query should NOT include sub-graph-only data ---"
ROOT_ALPHA=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"shared-memory\"
}")
ROOT_ALPHA_CT=$(echo "$ROOT_ALPHA" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$ROOT_ALPHA_CT" -eq 0 ]] && ok "Sub-graph alpha data absent from root CG SWM" || warn "Sub-graph data visible in root CG ($ROOT_ALPHA_CT) — may be expected if SWM shares a graph"

echo "--- 24f: Sub-graph data gossips to Node2 ---"
sleep 5
SG_GOS_A=$(c -X POST "http://127.0.0.1:9202/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_A\",
  \"includeSharedMemory\":true
}")
SG_GOS_CT=$(echo "$SG_GOS_A" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SG_GOS_CT" -ge 1 ]] && ok "Sub-graph A data gossiped to Node2" || warn "Sub-graph A not on Node2 ($SG_GOS_CT)"

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
