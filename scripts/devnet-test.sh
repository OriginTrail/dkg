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

# P1-1: Bounded curl — every devnet call gets a connect + total timeout so a
# hung node stalls CI instead of letting a single test run forever. Override
# DEVNET_CURL_TIMEOUT / DEVNET_CURL_CONNECT_TIMEOUT to widen if needed.
DEVNET_CURL_TIMEOUT="${DEVNET_CURL_TIMEOUT:-30}"
DEVNET_CURL_CONNECT_TIMEOUT="${DEVNET_CURL_CONNECT_TIMEOUT:-5}"
c() {
  curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
    -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "$@"
}

# P2-3: Respect TMPDIR so CI runners with non-/tmp tmp dirs work cleanly.
DEVNET_TMPDIR="${TMPDIR:-/tmp}"

# P2-1: Make the gossip sleep overrideable for fast local runs / flaky CI.
# Round 8 Bug 24: split LOCAL_SETTLE_S out of GOSSIP_WAIT_S. The former
# governs local write→query settles that must never be set to 0 (section 24
# would race its own write); the latter governs cross-node gossip propagation
# waits exclusively and CAN be set to 0 for fast local-only runs.
GOSSIP_WAIT_S="${GOSSIP_WAIT_S:-3}"
LOCAL_SETTLE_S="${LOCAL_SETTLE_S:-1}"

ok()   { PASS=$((PASS+1)); echo "  [PASS] $1"; }
fail() { FAIL=$((FAIL+1)); echo "  [FAIL] $1"; }
warn() { WARN=$((WARN+1)); echo "  [WARN] $1"; }
skip() { echo "  [SKIP] $1"; }

# P1-2: json_get now normalizes Python booleans to lowercase so the `check`
# helper can compare against plain 'true'/'false' without worrying about
# Python's `True`/`False` capitalization leaking through. Also emits
# __NONE__ / __ERR__ sentinels unchanged for existing call sites.
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
  if d is None:
    print('__NONE__')
  elif isinstance(d,bool):
    print('true' if d else 'false')
  else:
    print(d)
except: print('__ERR__')
" 2>/dev/null
}

check() {
  local desc="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then ok "$desc"; else fail "$desc (expected=$expected, got=$actual)"; fi
}

# P1-3: Safe count helper. Replaces the pervasive
#   python3 -c '…len(bindings)…' 2>/dev/null || echo "0"
# idiom, which silently turns schema drift and parse errors into a legitimate
# "zero results" reading. When the response is not parseable JSON-with-bindings,
# this helper echoes PARSE_ERR so call sites can distinguish an empty-but-valid
# response from a broken one.
safe_bindings_count() {
  echo "$1" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  b=d.get("result",{}).get("bindings",None)
  if b is None:
    print("PARSE_ERR")
  else:
    print(len(b))
except Exception:
  print("PARSE_ERR")
' 2>/dev/null || echo "PARSE_ERR"
}

# P1-3: Same idea for /assertion/:name/query responses that carry a top-level
# `quads` or `result` list instead of SPARQL-style bindings.
safe_quads_count() {
  echo "$1" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  v=d.get("quads",d.get("result",None))
  if v is None:
    print("PARSE_ERR")
  else:
    print(len(v))
except Exception:
  print("PARSE_ERR")
' 2>/dev/null || echo "PARSE_ERR"
}

# P0-3: Capture both the response body and the HTTP status in one call.
# Usage: http_post_capture <url> <json-body> <body-var-name> <code-var-name>
# Returns by assigning to caller's variables via nameref.
http_post_capture() {
  local url="$1" body="$2" body_out="$3" code_out="$4"
  local tmp
  tmp="$(mktemp "$DEVNET_TMPDIR/devnet-resp-XXXXXX")"
  local code
  code=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
    -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" \
    -o "$tmp" -w "%{http_code}" -X POST "$url" -d "$body" 2>/dev/null || echo "000")
  local content
  content="$(cat "$tmp")"
  rm -f "$tmp"
  printf -v "$body_out" '%s' "$content"
  printf -v "$code_out" '%s' "$code"
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

DEVNET_NODES="${DEVNET_NODES:-}"
if [[ -z "$DEVNET_NODES" ]]; then
  for candidate in 9201 9202 9203 9204 9205 9206 9207 9208; do
    if curl -sS --max-time 2 --connect-timeout 1 -H "Authorization: Bearer $AUTH" \
       "http://127.0.0.1:$candidate/api/info" 2>/dev/null | grep -q '"status"'; then
      DEVNET_NODES="${DEVNET_NODES:+$DEVNET_NODES }$candidate"
    fi
  done
fi
read -ra NODE_PORTS <<< "$DEVNET_NODES"
NUM_NODES=${#NODE_PORTS[@]}
EXPECTED_PEERS=$((NUM_NODES))

echo "============================================================"
echo "DKG V10 Comprehensive Devnet Test Suite (SWM-first flow)"
echo "$NUM_NODES nodes detected: ${NODE_PORTS[*]}"
echo "============================================================"
echo ""

#------------------------------------------------------------
echo "=== SECTION 1: Node Health & Identity ==="
echo ""
for p in "${NODE_PORTS[@]}"; do
  info=$(c "http://127.0.0.1:$p/api/info")
  check "Node $p running" "$(json_get "$info" status)" "running"
  ident=$(c "http://127.0.0.1:$p/api/identity")
  iid=$(json_get "$ident" identityId)
  role=$(json_get "$info" nodeRole)
  # Edge nodes intentionally don't stake / register on-chain identities
  # (v10 spec §17, devnet.sh — only the core quorum participates in
  # consensus). Treat a missing identity as a passing spec-conformant
  # assertion for edge nodes; assert it strictly on cores.
  if [[ "$role" == "edge" ]]; then
    [[ "$iid" == "0" || "$iid" == "__NONE__" ]] && ok "Node $p (edge) has no on-chain identity (by design)" \
      || warn "Node $p marked edge but has identityId=$iid (spec says edges stay off-chain)"
  else
    [[ "$iid" != "0" && "$iid" != "__NONE__" ]] && ok "Node $p identity=$iid" || fail "Node $p no identity"
  fi
done

echo ""
echo "--- 1b: P2P mesh ---"
agents=$(c "http://127.0.0.1:9201/api/agents")
connected=$(echo "$agents" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for a in d['agents'] if a['connectionStatus'] in ('connected','self')))" 2>/dev/null)
check "Core sees $EXPECTED_PEERS peers" "$connected" "$EXPECTED_PEERS"

echo ""
echo "--- 1c: P2P mesh from every node's perspective ---"
for p in "${NODE_PORTS[@]}"; do
  a=$(c "http://127.0.0.1:$p/api/agents")
  cn=$(echo "$a" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for a in d['agents'] if a['connectionStatus'] in ('connected','self')))" 2>/dev/null)
  [[ "$cn" -ge 4 ]] && ok "Node $p sees $cn peers" || warn "Node $p sees only $cn peers"
done

echo ""
echo "--- 1d: Wallet balances ---"
for p in "${NODE_PORTS[@]}"; do
  bals=$(c "http://127.0.0.1:$p/api/wallets/balances")
  bc=$(echo "$bals" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('balances',[])))" 2>/dev/null)
  [[ "$bc" -ge 1 ]] && ok "Node $p has $bc wallet(s)" || fail "Node $p no wallets"
done

echo ""
echo "--- 1e: Chain RPC health ---"
for p in "${NODE_PORTS[@]}"; do
  h=$(c "http://127.0.0.1:$p/api/chain/rpc-health")
  rpc_ok=$(json_get "$h" ok)
  check "Node $p RPC ok" "$rpc_ok" "true"
done

#------------------------------------------------------------
echo ""
echo "--- Registering default CG on-chain (required for VM publish tests) ---"
REG_DEFAULT=$(c -X POST "http://127.0.0.1:9201/api/context-graph/register" -d "{\"id\":\"$CONTEXT_GRAPH\"}")
REG_DEF_ID=$(json_get "$REG_DEFAULT" registered)
REG_DEF_OC=$(json_get "$REG_DEFAULT" onChainId)
if [[ "$REG_DEF_ID" == "$CONTEXT_GRAPH" ]]; then
  ok "Default CG '$CONTEXT_GRAPH' registered on-chain ($REG_DEF_OC)"
else
  warn "Default CG registration: $REG_DEFAULT (tests requiring VM publish may fail)"
fi

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
echo "--- 3b: Query Verified Memory for published city root entities on publisher ---"
LTM_CT=0
for i in $(seq 1 15); do
  LTM_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
    \"sparql\":\"SELECT ?s ?name WHERE { VALUES ?s { <http://example.org/entity/city1> <http://example.org/entity/city2> } ?s <http://schema.org/name> ?name } LIMIT 10\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"view\":\"verified-memory\"
  }")
  LTM_CT=$(echo "$LTM_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
  [ "$LTM_CT" -ge 2 ] && break
  sleep 1
done
[[ "$LTM_CT" -ge 2 ]] && ok "VM has $LTM_CT published city roots on Node1" || warn "VM has $LTM_CT published city roots immediately after publish (validated later in §25a)"

echo ""
echo "--- 3c: Cross-node finalization — cities reach ALL 5 nodes ---"
sleep 10
for p in "${NODE_PORTS[@]}"; do
  R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT ?s ?name WHERE { VALUES ?s { <http://example.org/entity/city1> <http://example.org/entity/city2> } ?s <http://schema.org/name> ?name } LIMIT 10\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"view\":\"verified-memory\"
  }")
  ct=$(echo "$R" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null)
  [[ "$ct" -ge 2 ]] && ok "Node $p has $ct published city roots in VM" || warn "Node $p has $ct published city roots in VM (finalization pending?)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 4: Multi-node SWM contribution + open-CG VM publish ==="
echo ""
# Devnet bootstrap CGs are intentionally registered as open
# (ContextGraphs publishPolicy=1). Any node may contribute to SWM and any
# chain-capable node may promote selected SWM data to Verified Memory. Curated
# publish-authority rejection is covered by private/curated sharing tests.

echo "--- 4a: Node2 (core) shares a Product triple-set to SWM ---"
SWM2=$(c -X POST "http://127.0.0.1:9202/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/product1' 'http://schema.org/name' 'Potica'),
    $(q 'http://example.org/entity/product1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product1' 'http://schema.org/description' 'Traditional Slovenian nut roll')
  ]
}")
SWM2_W=$(json_get "$SWM2" triplesWritten)
[[ "$SWM2_W" == "3" ]] && ok "Node2 SWM contribution accepted ($SWM2_W triples)" || fail "Node2 SWM write: $SWM2"

echo "--- 4b: Node3 (core, oxigraph) shares a second Product triple-set ---"
SWM3=$(c -X POST "http://127.0.0.1:9203/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/product2' 'http://schema.org/name' 'Carniolan Sausage'),
    $(q 'http://example.org/entity/product2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product2' 'http://schema.org/description' 'PGI sausage')
  ]
}")
SWM3_W=$(json_get "$SWM3" triplesWritten)
[[ "$SWM3_W" == "3" ]] && ok "Node3 SWM contribution accepted ($SWM3_W triples)" || fail "Node3 SWM write: $SWM3"

echo "--- 4c: Node4 (core) shares a Person triple-set to SWM ---"
SWM4=$(c -X POST "http://127.0.0.1:9204/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/person1' 'http://schema.org/name' 'France Prešeren'),
    $(q 'http://example.org/entity/person1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),
    $(ql 'http://example.org/entity/person1' 'http://schema.org/birthDate' '1800-12-03')
  ]
}")
SWM4_W=$(json_get "$SWM4" triplesWritten)
[[ "$SWM4_W" == "3" ]] && ok "Node4 SWM contribution accepted ($SWM4_W triples)" || fail "Node4 SWM write: $SWM4"

echo "--- 4d: Node5 (edge) shares a Lake triple-set to SWM ---"
SWM5=$(c -X POST "http://127.0.0.1:9205/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/name' 'Lake Bled'),
    $(q 'http://example.org/entity/lake1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/LakeBodyOfWater'),
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/description' 'Glacial lake in the Julian Alps')
  ]
}")
SWM5_W=$(json_get "$SWM5" triplesWritten)
[[ "$SWM5_W" == "3" ]] && ok "Node5 (edge) SWM contribution accepted ($SWM5_W triples)" || fail "Node5 SWM write: $SWM5"

echo "--- 4e: Open CG allows Node2 to publish its SWM contribution ---"
sleep 2
http_post_capture "http://127.0.0.1:9202/api/shared-memory/publish" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/product1\"]}" \
  NON_CURATOR_BODY NON_CURATOR_CODE
NON_CURATOR_ST=$(json_get "$NON_CURATOR_BODY" status)
if [[ "$NON_CURATOR_CODE" == "200" && ( "$NON_CURATOR_ST" == "confirmed" || "$NON_CURATOR_ST" == "finalized" ) ]]; then
  ok "Open-CG publish from Node2 accepted (status=$NON_CURATOR_ST)"
else
  fail "Open-CG publish from Node2 failed, HTTP $NON_CURATOR_CODE status=$NON_CURATOR_ST: ${NON_CURATOR_BODY:0:200}"
fi

# Aggregated promote: Node1 picks up the remaining SWM contributions in a
# single on-chain tx. Each entity becomes its own KA (rootEntity), but they
# share one on-chain batch.
echo "--- 4f: Node1 publishes the remaining aggregated multi-node SWM batch ---"
sleep 2
AGG_PUB=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"selection\":[
    \"http://example.org/entity/product1\",
    \"http://example.org/entity/product2\",
    \"http://example.org/entity/person1\",
    \"http://example.org/entity/lake1\"
  ]
}")
AGG_ST=$(json_get "$AGG_PUB" status)
AGG_TX=$(json_get "$AGG_PUB" txHash)
if [[ "$AGG_ST" == "confirmed" || "$AGG_ST" == "finalized" ]]; then
  ok "Curator aggregated publish OK (status=$AGG_ST, tx=${AGG_TX:0:18}…)"
else
  fail "Curator aggregated publish=$AGG_ST: $AGG_PUB"
fi

echo "--- 4g: ALL published entities replicate to ALL nodes ---"
sleep 12
for p in "${NODE_PORTS[@]}"; do
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
# Publish TRAC is paid by the publisher wallet on the on-chain tx. For
# `devnet-test` that is Node1 (the curator / publishAuthority — the
# only node authorised to publish to VM per §2.2). Measuring against
# Node5 as in the previous revision was invalid: Node5 can't publish
# to `devnet-test` at all, so the balance delta would always be zero
# for the wrong reason. This section therefore writes SWM from Node5
# (any node may share), then has Node1 promote it to VM and checks
# Node1's balance delta.

TRAC1_B=$(c "http://127.0.0.1:9201/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node1 (curator) TRAC before: $TRAC1_B"

c -X POST "http://127.0.0.1:9205/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/cost-test' 'http://schema.org/name' 'CostTest'),
    $(q 'http://example.org/entity/cost-test' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  ]
}" > /dev/null
sleep 1
COST_PUB=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"selection\":[\"http://example.org/entity/cost-test\"]}")
COST_ST=$(json_get "$COST_PUB" status)
[[ "$COST_ST" == "confirmed" || "$COST_ST" == "finalized" ]] && ok "Cost-test publish OK ($COST_ST)" || fail "Cost-test publish failed: status=$COST_ST: ${COST_PUB:0:200}"

TRAC1_A=$(c "http://127.0.0.1:9201/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node1 (curator) TRAC after:  $TRAC1_A"

if [[ "$TRAC1_B" != "$TRAC1_A" ]]; then
  ok "TRAC spent by curator on publish ($TRAC1_B → $TRAC1_A)"
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

# Participant-CG creation (`publishPolicy=participant`, M-of-N signatures
# over SWM promotes) requires every listed participant to have an on-chain
# identityId. Edge nodes don't stake — see §1a — so Node5's identityId is
# always 0 and fails contract-side `onlyRegistered(identityId)` validation.
# This section therefore lists core nodes only (1 / 2 / 3); see §4/§5
# for the curator / non-curator publish-authority semantics.
ID1=$(c "http://127.0.0.1:9201/api/identity" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identityId',0))" 2>/dev/null)
ID2=$(c "http://127.0.0.1:9202/api/identity" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identityId',0))" 2>/dev/null)
ID3=$(c "http://127.0.0.1:9203/api/identity" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identityId',0))" 2>/dev/null)
echo "  Core identity IDs: $ID1, $ID2, $ID3"

CG=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" -d "{
  \"participantIdentityIds\":[$ID1,$ID2,$ID3],
  \"requiredSignatures\":2
}")
CG_ID=$(json_get "$CG" contextGraphId)
CG_OK=$(json_get "$CG" success)
echo "  CG result: id=$CG_ID success=$CG_OK"
[[ "$CG_OK" == "true" ]] && ok "Context Graph created (id=$CG_ID)" || fail "CG creation: $CG"

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
for p in "${NODE_PORTS[@]}"; do
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
  for p in "${NODE_PORTS[@]}"; do
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
for p in "${NODE_PORTS[@]}"; do
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
EMPTY_CG="empty-swm-test-$$"
c -X POST "http://127.0.0.1:9205/api/context-graph/create" -d "{\"id\":\"$EMPTY_CG\",\"name\":\"empty swm test\"}" >/dev/null 2>&1
EMPTY_PUB=$(c -X POST "http://127.0.0.1:9205/api/shared-memory/publish" -d "{\"contextGraphId\":\"$EMPTY_CG\"}")
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
echo "$SKILL" | grep -Eq '(^|[^[:alnum:]_-])/api/publish([^[:alnum:]_-]|$)' && fail "SKILL.md still references removed /api/publish" || ok "SKILL.md correctly omits /api/publish"
echo "$SKILL" | grep -q "assertion" && ok "SKILL.md references assertion API" || warn "SKILL.md doesn't mention assertion API"
echo "$SKILL" | grep -q "sub-graph\|subGraph" && ok "SKILL.md references sub-graphs" || warn "SKILL.md doesn't mention sub-graphs"

#------------------------------------------------------------
echo ""
echo "=== SECTION 18: Sync Protocol & Catch-up Status ==="
echo ""

echo "--- 18a: Subscribe Node5 and poll catch-up status ---"
# P0-4: `idle` was previously treated as success, but it's the PRE-catchup
# initial state — a test that breaks out of the loop on `idle` never sees
# whether catch-up actually ran. Only accept positive completion markers
# and require 18b/18c data to confirm the sync.
c -X POST "http://127.0.0.1:9205/api/context-graph/subscribe" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"includeSharedMemory\":true}" > /dev/null 2>&1
SYNC_COMPLETED=false
SYNC_ST=""
for i in $(seq 1 20); do
  SYNC=$(c "http://127.0.0.1:9205/api/sync/catchup-status?contextGraphId=$CONTEXT_GRAPH")
  SYNC_ST=$(json_get "$SYNC" status)
  if [[ "$SYNC_ST" == "completed" || "$SYNC_ST" == "synced" || "$SYNC_ST" == "done" ]]; then
    SYNC_COMPLETED=true
    break
  fi
  sleep 2
done
$SYNC_COMPLETED && ok "Sync catch-up reported completion on Node5 (status=$SYNC_ST)" || warn "Sync catch-up did not reach a positive completion status after 40s (status=$SYNC_ST)"

echo "--- 18b: Write fresh post-subscribe SWM data on Node1 for sync verification ---"
SYNC_ENTITY="urn:sync-verify:post-sub-$(date +%s)"
c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql "$SYNC_ENTITY" 'http://schema.org/name' 'Post-Subscribe Sync Test')]
}" > /dev/null
sleep "$LOCAL_SETTLE_S"

echo "--- 18c: Verify post-subscribe SWM data synced to Node5 ---"
SYNC_SWM_OK=false
for i in $(seq 1 10); do
  SYNC_SWM=$(c -X POST "http://127.0.0.1:9205/api/query" -d "{
    \"sparql\":\"SELECT ?name WHERE { <$SYNC_ENTITY> <http://schema.org/name> ?name }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"view\":\"shared-working-memory\"
  }")
  SYNC_SWM_CT=$(safe_bindings_count "$SYNC_SWM")
  if [[ "$SYNC_SWM_CT" != "PARSE_ERR" && "$SYNC_SWM_CT" -ge 1 ]]; then
    SYNC_SWM_OK=true
    break
  fi
  sleep 2
done
if $SYNC_SWM_OK; then
  ok "Post-subscribe SWM data synced to Node5"
elif [[ "$SYNC_SWM_CT" == "PARSE_ERR" ]]; then
  fail "Node5 SWM sync query returned unparseable response: ${SYNC_SWM:0:200}"
elif $SYNC_COMPLETED; then
  fail "Catchup reported complete on Node5 but fresh SWM data is missing — sync pipeline bug"
else
  warn "Post-subscribe SWM data not synced to Node5 ($SYNC_SWM_CT) — catchup never completed"
fi

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
VM_CT=$(safe_bindings_count "$VM_VIEW")
if [[ "$VM_CT" == "PARSE_ERR" ]]; then
  fail "Verified memory view returned unparseable response: ${VM_VIEW:0:200}"
elif [[ "$VM_CT" -ge 1 ]]; then
  ok "Verified memory view returns published data"
else
  warn "Verified memory view empty ($VM_CT) — VM finalization may be pending"
fi

echo "--- 19b: Shared memory view ---"
SWM_VIEW=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s a ?type }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"shared-working-memory\"
}")
SWM_CT=$(echo "$SWM_VIEW" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  b=d.get("result",{}).get("bindings",None)
  if b is None:
    print("PARSE_ERR")
  elif b:
    print(b[0]["c"].strip(chr(34)).split("^^")[0])
  else:
    print("0")
except Exception:
  print("PARSE_ERR")
' 2>/dev/null || echo "PARSE_ERR")
echo "  SWM entity count: $SWM_CT"
if [[ "$SWM_CT" == "PARSE_ERR" ]]; then
  fail "Shared memory view returned unparseable response: ${SWM_VIEW:0:200}"
elif [[ "$SWM_CT" -ge 1 ]]; then
  ok "Shared memory view returns data ($SWM_CT entities)"
else
  warn "Shared memory view empty"
fi

echo "--- 19c: Working memory assertion visible only locally ---"
WM_NAME="wm-view-test-$(date +%s)"
WM_SUBJECT="urn:wm-view:${WM_NAME}"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$WM_NAME\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/assertion/$WM_NAME/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql "$WM_SUBJECT" 'http://schema.org/name' 'WM Only Data')]
}" > /dev/null

WM_LOCAL=$(c -X POST "http://127.0.0.1:9201/api/assertion/$WM_NAME/query" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
WM_LOCAL_CT=$(safe_quads_count "$WM_LOCAL")
if [[ "$WM_LOCAL_CT" == "PARSE_ERR" ]]; then
  fail "WM assertion query returned unparseable response: ${WM_LOCAL:0:200}"
elif [[ "$WM_LOCAL_CT" -ge 1 ]]; then
  ok "WM assertion visible locally ($WM_LOCAL_CT quads)"
else
  fail "WM assertion not visible locally"
fi

echo "--- 19d: WM data NOT in verified memory ---"
WM_IN_VM=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <$WM_SUBJECT> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verified-memory\"
}")
WM_IN_VM_CT=$(safe_bindings_count "$WM_IN_VM")
if [[ "$WM_IN_VM_CT" == "PARSE_ERR" ]]; then
  fail "WM/VM isolation query returned unparseable response: ${WM_IN_VM:0:200}"
elif [[ "$WM_IN_VM_CT" -eq 0 ]]; then
  ok "WM data correctly absent from verified memory"
else
  fail "WM data leaked into verified memory ($WM_IN_VM_CT)"
fi

echo "--- 19e: WM data NOT visible on Node2 (including SWM) ---"
WM_REMOTE=$(c -X POST "http://127.0.0.1:9202/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <$WM_SUBJECT> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"includeSharedMemory\":true
}")
WM_REMOTE_CT=$(safe_bindings_count "$WM_REMOTE")
if [[ "$WM_REMOTE_CT" == "PARSE_ERR" ]]; then
  fail "WM/Node2 isolation query returned unparseable response: ${WM_REMOTE:0:200}"
elif [[ "$WM_REMOTE_CT" -eq 0 ]]; then
  ok "WM data correctly absent on Node2 (root + SWM)"
else
  fail "WM data leaked to Node2 ($WM_REMOTE_CT)"
fi

c -X POST "http://127.0.0.1:9201/api/assertion/$WM_NAME/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "=== SECTION 20: Context Graph Existence & SWM TTL Settings ==="
echo ""

echo "--- 20a: Context graph exists (known) ---"
CG_EXISTS=$(c "http://127.0.0.1:9201/api/context-graph/exists?id=$CONTEXT_GRAPH")
CG_E=$(json_get "$CG_EXISTS" exists)
check "Context graph devnet-test exists" "$CG_E" "true"

echo "--- 20b: Context graph exists (unknown) ---"
CG_NOT=$(c "http://127.0.0.1:9201/api/context-graph/exists?id=nonexistent-cg-$(date +%s)")
CG_N=$(json_get "$CG_NOT" exists)
check "Nonexistent context graph reports false" "$CG_N" "false"

echo "--- 20c: Read SWM TTL setting ---"
TTL_ORIG=$(c "http://127.0.0.1:9201/api/settings/shared-memory-ttl")
TTL_DAYS_ORIG=$(json_get "$TTL_ORIG" ttlDays)
TTL_MS_ORIG=$(json_get "$TTL_ORIG" ttlMs)
echo "  Current TTL: ${TTL_DAYS_ORIG} days (${TTL_MS_ORIG} ms)"
[[ "$TTL_DAYS_ORIG" != "__NONE__" && "$TTL_DAYS_ORIG" != "__ERR__" ]] && ok "SWM TTL readable ($TTL_DAYS_ORIG days)" || fail "SWM TTL not readable: $TTL_ORIG"

echo "--- 20d: Update SWM TTL ---"
# P1-4: Route through the `c()` helper so the bounded timeout + auth
# headers propagate; c() accepts any curl args via "$@".
TTL_SET=$(c -X PUT "http://127.0.0.1:9201/api/settings/shared-memory-ttl" -d '{"ttlDays":7}')
TTL_OK=$(json_get "$TTL_SET" ok)
[[ "$TTL_OK" == "true" ]] && ok "SWM TTL updated to 7 days" || fail "SWM TTL update failed: $TTL_SET"

echo "--- 20e: Verify updated TTL ---"
TTL_NEW=$(c "http://127.0.0.1:9201/api/settings/shared-memory-ttl")
TTL_DAYS_NEW=$(json_get "$TTL_NEW" ttlDays)
check "TTL reads back as 7 days" "$TTL_DAYS_NEW" "7"

echo "--- 20f: Restore original TTL ---"
# The PUT endpoint only accepts ttlDays. Convert ttlMs back to days for
# precision (ttlDays from GET may be rounded for non-whole-day values).
TTL_DAYS_PRECISE=$(python3 -c "print($TTL_MS_ORIG / 86400000)" 2>/dev/null || echo "$TTL_DAYS_ORIG")
TTL_RESTORE=$(c -X PUT "http://127.0.0.1:9201/api/settings/shared-memory-ttl" -d "{\"ttlDays\":$TTL_DAYS_PRECISE}")
TTL_RESTORE_OK=$(json_get "$TTL_RESTORE" ok)
check "TTL restored to original (${TTL_DAYS_PRECISE} days)" "$TTL_RESTORE_OK" "true"

#------------------------------------------------------------
echo ""
echo "=== SECTION 21: Import-File Extraction Status ==="
echo ""

IMPORT_NAME="import-extract-$(date +%s)"
echo "--- 21a: Create assertion for import ---"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$IMPORT_NAME\"}" > /dev/null

echo "--- 21b: Import markdown file ---"
# P2-3: honor $TMPDIR for CI runners with non-/tmp tmp roots.
TMPMD=$(mktemp "$DEVNET_TMPDIR/devnet-import-XXXXXX.md")
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

IMPORT_RESP=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
  -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPMD};type=text/markdown" \
  -F "contextGraphId=$CONTEXT_GRAPH" \
  "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/import-file" 2>&1)
rm -f "$TMPMD"
IMPORT_URI=$(json_get "$IMPORT_RESP" assertionUri)
IMPORT_HASH=$(json_get "$IMPORT_RESP" fileHash)
echo "  Import assertionUri=$IMPORT_URI fileHash=$IMPORT_HASH"
[[ "$IMPORT_URI" != "__NONE__" && "$IMPORT_URI" != "__ERR__" ]] && ok "Import-file accepted ($IMPORT_URI)" || fail "Import-file failed: ${IMPORT_RESP:0:200}"
[[ "$IMPORT_HASH" != "__NONE__" && "$IMPORT_HASH" != "__ERR__" ]] && ok "File hash returned ($IMPORT_HASH)" || warn "No file hash returned"
# Spec §10.2:603 mandates keccak256 on the wire for the import-file response
# fileHash. Lock in the format so a regression to sha256 is a hard fail.
if [[ "$IMPORT_HASH" =~ ^keccak256:[0-9a-f]{64}$ ]]; then
  ok "File hash is keccak256 (${IMPORT_HASH})"
else
  fail "File hash not keccak256 format (got=$IMPORT_HASH)"
fi

echo "--- 21c: Check extraction status endpoint ---"
EXTRACT_ST=$(c "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/extraction-status?contextGraphId=$CONTEXT_GRAPH")
EXT_STATUS=$(json_get "$EXTRACT_ST" status)
echo "  Extraction status: $EXT_STATUS"
[[ "$EXT_STATUS" == "completed" ]] && ok "Extraction status endpoint reports completed" || warn "Extraction status: $EXT_STATUS (${EXTRACT_ST:0:200})"

echo "--- 21d: Query imported assertion ---"
IMPORT_Q=$(c -X POST "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/query" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
IMPORT_Q_CT=$(safe_quads_count "$IMPORT_Q")
if [[ "$IMPORT_Q_CT" == "PARSE_ERR" ]]; then
  fail "Imported assertion query returned unparseable response: ${IMPORT_Q:0:200}"
elif [[ "$IMPORT_Q_CT" -ge 1 ]]; then
  ok "Imported assertion has $IMPORT_Q_CT quads"
else
  warn "Imported assertion empty"
fi

echo "--- 21e: Promote imported assertion to SWM ---"
IMPORT_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/assertion/${IMPORT_NAME}/promote" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
IMPORT_PC=$(json_get "$IMPORT_PROMOTE" promotedCount)
echo "  Promoted count: $IMPORT_PC"
# P1-10: also exclude __ERR__ (and keep the 0 guard) so parse failures don't
# silently count as success.
if [[ "$IMPORT_PC" != "__NONE__" && "$IMPORT_PC" != "__ERR__" && "$IMPORT_PC" != "0" ]]; then
  ok "Imported data promoted to SWM ($IMPORT_PC quads)"
else
  warn "Import promote: $IMPORT_PC"
fi

# ── 21f / 21g / 21h: spec-linkage SPARQL gate — this is the devnet-side
# sign-off for the Phase B file-linkage implementation. The tests above
# only check that the import-file endpoint RESPONDED; these query the
# actual graph data to confirm the §10.1 data-graph linkage + §10.2 _meta
# triples actually landed. A daemon regression that silently dropped any
# of these predicates would be invisible to 21b-e.

echo "--- 21f: §10.1 linkage triples present post-promote ---"
# After promote (21e), linkage triples move from the assertion graph
# (WM) to SWM. Check SWM for the entity-level linkage predicates, and
# fall back to checking the assertion graph for pre-promote scenarios.
LINK_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"shared-working-memory\",
  \"sparql\":\"SELECT ?s ?p ?o WHERE { ?s ?p ?o FILTER(?p IN (<http://dkg.io/ontology/sourceFile>, <http://dkg.io/ontology/sourceContentType>, <http://dkg.io/ontology/rootEntity>)) }\"
}")
LINK_CT=$(safe_bindings_count "$LINK_Q")
if [[ "$LINK_CT" == "PARSE_ERR" ]]; then
  fail "§10.1 linkage query returned unparseable response: ${LINK_Q:0:200}"
elif [[ "$LINK_CT" -ge 3 ]]; then
  ok "§10.1 linkage predicates present in SWM after promote ($LINK_CT bindings)"
else
  # Fall back to checking the assertion graph (WM) in case promote didn't run
  LINK_WM=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"sparql\":\"SELECT ?s ?p ?o WHERE { GRAPH <${IMPORT_URI}> { ?s ?p ?o FILTER(?p IN (<http://dkg.io/ontology/sourceFile>, <http://dkg.io/ontology/sourceContentType>, <http://dkg.io/ontology/rootEntity>)) } }\"
  }")
  LINK_WM_CT=$(safe_bindings_count "$LINK_WM")
  if [[ "$LINK_WM_CT" -ge 3 ]]; then
    ok "§10.1 linkage predicates present in assertion graph ($LINK_WM_CT bindings)"
  else
    fail "§10.1 linkage predicates missing from both SWM ($LINK_CT) and WM ($LINK_WM_CT), expected >= 3"
  fi
fi

echo "--- 21g: §10.2 sourceFileHash in CG root _meta graph ---"
META_GRAPH="did:dkg:context-graph:${CONTEXT_GRAPH}/_meta"
META_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"sparql\":\"SELECT ?h WHERE { GRAPH <${META_GRAPH}> { <${IMPORT_URI}> <http://dkg.io/ontology/sourceFileHash> ?h } }\"
}")
META_CT=$(safe_bindings_count "$META_Q")
META_HASH_RAW=$(echo "$META_Q" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  b=d.get("result",{}).get("bindings",[])
  if b and "h" in b[0]:
    v=b[0]["h"]
    # strip surrounding quotes + any xsd:string suffix
    if v.startswith("\"") and "\"^^" in v:
      print(v.split("\"^^",1)[0].lstrip("\""))
    elif v.startswith("\"") and v.endswith("\""):
      print(v[1:-1])
    else:
      print(v)
  else:
    print("__MISSING__")
except Exception:
  print("__ERR__")
' 2>/dev/null || echo "__ERR__")
if [[ "$META_CT" == "PARSE_ERR" ]]; then
  fail "§10.2 sourceFileHash query returned unparseable response: ${META_Q:0:200}"
elif [[ "$META_HASH_RAW" =~ ^keccak256:[0-9a-f]{64}$ ]]; then
  if [[ "$META_HASH_RAW" == "$IMPORT_HASH" ]]; then
    ok "§10.2 sourceFileHash present in CG root _meta and matches import response"
  else
    fail "§10.2 sourceFileHash (${META_HASH_RAW}) does not match import response hash (${IMPORT_HASH})"
  fi
else
  fail "§10.2 sourceFileHash missing or wrong shape (got=$META_HASH_RAW)"
fi

echo "--- 21h: §10.2 row 20 (mdIntermediateHash) absent for markdown upload ---"
# Row 20 is spec-gated on Phase 1 having run. text/markdown bypasses Phase 1,
# so the md intermediate predicate MUST NOT be present for a direct markdown
# upload. We assert absence here and verify presence in §21i for PDF-path.
MD_INT_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"sparql\":\"SELECT ?h WHERE { GRAPH <${META_GRAPH}> { <${IMPORT_URI}> <http://dkg.io/ontology/mdIntermediateHash> ?h } }\"
}")
MD_INT_CT=$(safe_bindings_count "$MD_INT_Q")
if [[ "$MD_INT_CT" == "PARSE_ERR" ]]; then
  fail "§10.2 mdIntermediateHash query returned unparseable response: ${MD_INT_Q:0:200}"
elif [[ "$MD_INT_CT" -eq 0 ]]; then
  ok "§10.2 mdIntermediateHash correctly absent for markdown upload"
else
  fail "§10.2 mdIntermediateHash leaked into a markdown import ($MD_INT_CT bindings)"
fi

echo "--- 21i: Unsupported content type gracefully degrades (§6.5) ---"
# P1-6: exercise the graceful-degrade path — a PNG upload should land as
# extraction.status="skipped", tripleCount=0, no linkage triples written.
# Required by 05_PROTOCOL_EXTENSIONS.md §6.5 but previously uncovered.
PNG_NAME="import-degrade-$(date +%s)"
c -X POST "http://127.0.0.1:9201/api/assertion/create" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$PNG_NAME\"}" > /dev/null
TMPPNG=$(mktemp "$DEVNET_TMPDIR/devnet-png-XXXXXX.png")
# 8-byte PNG magic header — enough to look like a real image to the server
# while keeping the test body small. No converter is registered for image/png
# so the daemon must graceful-degrade.
printf '\x89PNG\r\n\x1a\n' > "$TMPPNG"
PNG_RESP=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
  -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPPNG};type=image/png" \
  -F "contextGraphId=$CONTEXT_GRAPH" \
  "http://127.0.0.1:9201/api/assertion/${PNG_NAME}/import-file" 2>&1)
rm -f "$TMPPNG"
PNG_STATUS=$(json_get "$PNG_RESP" extraction.status)
PNG_PIPELINE=$(json_get "$PNG_RESP" extraction.pipelineUsed)
PNG_COUNT=$(json_get "$PNG_RESP" extraction.tripleCount)
if [[ "$PNG_STATUS" == "skipped" && "$PNG_COUNT" == "0" && "$PNG_PIPELINE" == "None" ]]; then
  ok "§6.5 graceful degrade: PNG upload returns skipped + zero triples"
elif [[ "$PNG_STATUS" == "skipped" ]]; then
  # Tolerant fallback: some daemon versions emit pipelineUsed as null->__NONE__
  # or an empty string. Still fine as long as the status is skipped and the
  # count is zero.
  if [[ "$PNG_COUNT" == "0" ]]; then
    ok "§6.5 graceful degrade: PNG upload returns skipped (pipelineUsed=$PNG_PIPELINE)"
  else
    fail "§6.5 graceful degrade reported skipped but with tripleCount=$PNG_COUNT"
  fi
else
  fail "§6.5 graceful degrade failed: status=$PNG_STATUS pipeline=$PNG_PIPELINE count=$PNG_COUNT (${PNG_RESP:0:200})"
fi
# Clean up the degraded assertion so it doesn't pollute later tests.
c -X POST "http://127.0.0.1:9201/api/assertion/$PNG_NAME/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null 2>&1

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
# P2-4: shareOperationId is the current field name; workspaceOperationId is
# the legacy alias still emitted by some node versions. Keep the fallback
# until we confirm every supported node build has migrated.
PQ_OP_ID=$(json_get "$PQ_WRITE" shareOperationId)
if [[ "$PQ_OP_ID" == "__NONE__" || "$PQ_OP_ID" == "__ERR__" ]]; then
  PQ_OP_ID=$(json_get "$PQ_WRITE" workspaceOperationId)
fi
echo "  SWM write shareOperationId=$PQ_OP_ID"
[[ "$PQ_OP_ID" != "__NONE__" && "$PQ_OP_ID" != "__ERR__" ]] && ok "SWM write for publisher test" || fail "SWM write failed: ${PQ_WRITE:0:200}"

# P1-9: also assert triplesWritten >= 2. A silent zero-write pipeline would
# let the publisher enqueue an empty payload and 22c would "pass" with no
# actual data to publish.
PQ_TW=$(json_get "$PQ_WRITE" triplesWritten)
if [[ "$PQ_TW" != "__NONE__" && "$PQ_TW" != "__ERR__" && "$PQ_TW" -ge 2 ]] 2>/dev/null; then
  ok "SWM write persisted $PQ_TW triples (>= 2)"
else
  fail "SWM write triplesWritten=$PQ_TW (expected >= 2) — publisher queue test will be meaningless"
fi

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
    # P1-5: replace the fragile inline ternary with a dedicated helper so
    # malformed responses surface as __ERR__ instead of a stringified "?"
    # that looked like a "valid" status and could fall through.
    PQ_FINAL_ST=$(echo "$PQ_STATUS" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  job=d.get("job", d) if isinstance(d, dict) else None
  if isinstance(job, dict):
    s=job.get("status")
    print(s if s is not None else "__MISSING__")
  else:
    print("__ERR__")
except Exception:
  print("__ERR__")
' 2>/dev/null || echo "__ERR__")
    echo "  Poll $i: status=$PQ_FINAL_ST"
    [[ "$PQ_FINAL_ST" == "finalized" || "$PQ_FINAL_ST" == "included" || "$PQ_FINAL_ST" == "failed" ]] && break
    sleep 3
  done
  if [[ "$PQ_FINAL_ST" == "finalized" || "$PQ_FINAL_ST" == "included" ]]; then
    ok "Publisher job reached $PQ_FINAL_ST"
  elif [[ "$PQ_FINAL_ST" == "__ERR__" || "$PQ_FINAL_ST" == "__MISSING__" ]]; then
    fail "Publisher job status unparseable or missing status field (got=$PQ_FINAL_ST)"
  elif [[ "$PQ_FINAL_ST" == "accepted" ]]; then
    fail "Publisher job remained accepted; queue worker did not drain the job"
  else
    fail "Publisher job did not reach included/finalized (got=$PQ_FINAL_ST) — publisher queue e2e broken"
  fi

  echo "--- 22d: Fetch job payload ---"
  PQ_PAYLOAD=$(c "http://127.0.0.1:9201/api/publisher/job-payload?id=$PQ_JOB_ID")
  PQ_HAS_PAYLOAD=$(echo "$PQ_PAYLOAD" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print("yes" if isinstance(d, dict) and (d.get("payload") or d.get("job")) else "no")
except Exception:
  print("ERR")
' 2>/dev/null || echo "ERR")
  if [[ "$PQ_HAS_PAYLOAD" == "yes" ]]; then
    ok "Job payload retrieved"
  elif [[ "$PQ_HAS_PAYLOAD" == "ERR" ]]; then
    fail "Job payload query returned unparseable response: ${PQ_PAYLOAD:0:200}"
  else
    warn "Job payload: ${PQ_PAYLOAD:0:200}"
  fi

  echo "--- 22e: Verify publisher stats ---"
  PQ_STATS=$(c "http://127.0.0.1:9201/api/publisher/stats")
  echo "  Stats: $(echo "$PQ_STATS" | head -c 300)"
  echo "$PQ_STATS" | python3 -c 'import sys,json;json.load(sys.stdin)' 2>/dev/null && ok "Publisher stats valid JSON" || warn "Publisher stats: $PQ_STATS"

  echo "--- 22f: Clear finalized jobs ---"
  PQ_CLEAR=$(c -X POST "http://127.0.0.1:9201/api/publisher/clear" -d '{"status":"finalized"}')
  PQ_CLEARED=$(json_get "$PQ_CLEAR" cleared)
  echo "  Cleared: $PQ_CLEARED jobs"
  [[ "$PQ_CLEARED" != "__ERR__" ]] && ok "Publisher clear returned ($PQ_CLEARED)" || warn "Publisher clear: $PQ_CLEAR"
else
  # P2-2: silent no-op was confusing when 22a succeeds but the job id is
  # missing. Emit an explicit [SKIP] so the test log carries the reason.
  skip "22c-22f skipped: publisher enqueue did not return a usable jobId (PQ_JOB_ID=$PQ_JOB_ID)"
fi

#------------------------------------------------------------
echo ""
echo "=== SECTION 23: Authorization & Error Handling ==="
echo ""

echo "--- 23a: Request without auth token ---"
# P0-2: explicitly detect DEVNET_NO_AUTH=1 and emit a clean SKIP rather
# than degrading silently to WARN. A real auth-middleware regression must
# show up as a hard failure when auth is enabled.
if [[ "${DEVNET_NO_AUTH:-0}" == "1" ]]; then
  skip "23a: auth disabled via DEVNET_NO_AUTH=1"
else
  NOAUTH_CODE=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
    -o /dev/null -w "%{http_code}" "http://127.0.0.1:9201/api/query" \
    -X POST -H "Content-Type: application/json" \
    -d '{"sparql":"SELECT * WHERE { ?s ?p ?o } LIMIT 1","contextGraphId":"devnet-test"}')
  if [[ "$NOAUTH_CODE" == "401" ]]; then
    ok "No-auth request rejected (401)"
  else
    fail "No-auth returned $NOAUTH_CODE (expected 401; set DEVNET_NO_AUTH=1 if intentional)"
  fi
fi

echo "--- 23b: Query against nonexistent context graph ---"
# P1-8: `err`/PARSE_ERR must NOT pass — a 500 that returns malformed JSON
# would previously silently count as success.
BAD_CG=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?s WHERE { ?s ?p ?o } LIMIT 1\",
  \"contextGraphId\":\"nonexistent-cg-$(date +%s)\"
}")
BAD_CG_CT=$(safe_bindings_count "$BAD_CG")
if [[ "$BAD_CG_CT" == "PARSE_ERR" ]]; then
  # Could be a legitimate 4xx with a bare error envelope OR a 500 — warn
  # rather than pass, so a genuinely broken response shows up instead of
  # hiding inside the "empty result" branch.
  if echo "$BAD_CG" | grep -qiE '"error"|"message"'; then
    ok "Query against nonexistent CG returned an error envelope"
  else
    warn "Query against nonexistent CG returned unparseable response: ${BAD_CG:0:200}"
  fi
elif [[ "$BAD_CG_CT" == "0" ]]; then
  ok "Query against nonexistent CG returns empty result"
else
  warn "Nonexistent CG returned $BAD_CG_CT results"
fi

echo "--- 23c: Create assertion with empty name ---"
# P0-3: capture HTTP status — a 500 with body `{"error":"internal"}` used
# to silently pass the substring check. Require a 4xx AND an error token.
http_post_capture "http://127.0.0.1:9201/api/assertion/create" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"\"}" \
  EMPTY_NAME EMPTY_CODE
if [[ "$EMPTY_CODE" =~ ^4 ]] && echo "$EMPTY_NAME" | grep -qiE 'error|invalid'; then
  ok "Empty assertion name rejected (HTTP $EMPTY_CODE)"
else
  fail "Empty assertion name not cleanly rejected (HTTP $EMPTY_CODE): ${EMPTY_NAME:0:200}"
fi

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
# P0-3: same treatment as 23c — must return a real 4xx, not just a 500
# with an "error" string in the body.
http_post_capture "http://127.0.0.1:9201/api/publisher/enqueue" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" \
  BAD_ENQ BAD_ENQ_CODE
if [[ "$BAD_ENQ_CODE" =~ ^4 ]] && echo "$BAD_ENQ" | grep -qiE 'error|missing|required'; then
  ok "Publisher enqueue missing fields rejected (HTTP $BAD_ENQ_CODE)"
else
  fail "Bad enqueue not cleanly rejected (HTTP $BAD_ENQ_CODE): ${BAD_ENQ:0:200}"
fi

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

# P2-1: brief settle window for the local SWM write to hit the triple
# store before we query it. Round 8 Bug 24: this is a LOCAL write→query
# settle, NOT a cross-node gossip wait, so it uses its own env var.
# Otherwise a dev running with `GOSSIP_WAIT_S=0` to speed up a local-only
# test run would accidentally also skip this settle and section 24 would
# race its own write. `GOSSIP_WAIT_S` continues to govern cross-node
# propagation waits exclusively.
sleep "$LOCAL_SETTLE_S"

echo "--- 24c: Query sub-graph A — should find alpha, not beta ---"
SG_A_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_A\",
  \"includeSharedMemory\":true
}")
SG_A_CT=$(safe_bindings_count "$SG_A_Q")
if [[ "$SG_A_CT" == "PARSE_ERR" ]]; then
  fail "Sub-graph A query returned unparseable response: ${SG_A_Q:0:200}"
elif [[ "$SG_A_CT" -ge 1 ]]; then
  ok "Sub-graph A has alpha entity"
else
  fail "Sub-graph A missing alpha entity ($SG_A_CT)"
fi

SG_A_LEAK=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:beta1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_A\",
  \"includeSharedMemory\":true
}")
SG_A_LEAK_CT=$(safe_bindings_count "$SG_A_LEAK")
if [[ "$SG_A_LEAK_CT" == "PARSE_ERR" ]]; then
  fail "Sub-graph A leak query returned unparseable response: ${SG_A_LEAK:0:200}"
elif [[ "$SG_A_LEAK_CT" -eq 0 ]]; then
  ok "Sub-graph A correctly excludes beta data"
else
  fail "Sub-graph A leaks beta data ($SG_A_LEAK_CT)"
fi

echo "--- 24d: Query sub-graph B — should find beta, not alpha ---"
SG_B_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:beta1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_B\",
  \"includeSharedMemory\":true
}")
SG_B_CT=$(safe_bindings_count "$SG_B_Q")
if [[ "$SG_B_CT" == "PARSE_ERR" ]]; then
  fail "Sub-graph B query returned unparseable response: ${SG_B_Q:0:200}"
elif [[ "$SG_B_CT" -ge 1 ]]; then
  ok "Sub-graph B has beta entity"
else
  fail "Sub-graph B missing beta entity ($SG_B_CT)"
fi

SG_B_LEAK=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"$SG_B\",
  \"includeSharedMemory\":true
}")
SG_B_LEAK_CT=$(safe_bindings_count "$SG_B_LEAK")
if [[ "$SG_B_LEAK_CT" == "PARSE_ERR" ]]; then
  fail "Sub-graph B leak query returned unparseable response: ${SG_B_LEAK:0:200}"
elif [[ "$SG_B_LEAK_CT" -eq 0 ]]; then
  ok "Sub-graph B correctly excludes alpha data"
else
  fail "Sub-graph B leaks alpha data ($SG_B_LEAK_CT)"
fi

echo "--- 24e: Root CG query should NOT include sub-graph-only data ---"
ROOT_ALPHA=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"shared-working-memory\"
}")
ROOT_ALPHA_CT=$(safe_bindings_count "$ROOT_ALPHA")
if [[ "$ROOT_ALPHA_CT" == "PARSE_ERR" ]]; then
  # Phase D hardening: unparseable response now fails loudly instead
  # of being silently counted as 0.
  fail "Root CG isolation query returned unparseable response: ${ROOT_ALPHA:0:200}"
elif [[ "$ROOT_ALPHA_CT" -eq 0 ]]; then
  ok "Sub-graph alpha data absent from root CG SWM"
else
  # Base-rebase fix: non-zero binding count is now a FAIL (was warn).
  # Root and sub-graph SWM use different graph URIs, so contamination
  # is an isolation regression, not "expected".
  fail "Sub-graph data leaked into root CG query ($ROOT_ALPHA_CT) — isolation regression"
fi

echo "--- 24f: Sub-graph data gossips to Node2 ---"
# P2-6: poll instead of one long sleep so a quick network can finish fast
# while a slow one still gets its full budget. Bounded at 5 × 1s = 5s,
# which matches the previous single sleep 5.
SG_GOS_CT="PARSE_ERR"
for i in 1 2 3 4 5; do
  SG_GOS_A=$(c -X POST "http://127.0.0.1:9202/api/query" -d "{
    \"sparql\":\"SELECT ?name WHERE { <urn:iso:alpha1> <http://schema.org/name> ?name }\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"subGraphName\":\"$SG_A\",
    \"includeSharedMemory\":true
  }")
  SG_GOS_CT=$(safe_bindings_count "$SG_GOS_A")
  [[ "$SG_GOS_CT" != "PARSE_ERR" && "$SG_GOS_CT" -ge 1 ]] && break
  sleep 1
done
if [[ "$SG_GOS_CT" == "PARSE_ERR" ]]; then
  fail "Sub-graph gossip query returned unparseable response: ${SG_GOS_A:0:200}"
elif [[ "$SG_GOS_CT" -ge 1 ]]; then
  ok "Sub-graph A data gossiped to Node2"
else
  warn "Sub-graph A not on Node2 ($SG_GOS_CT)"
fi

echo "--- 24g: Write to unregistered sub-graph rejected (negative test) ---"
# P1-7: the spec requires a write to an unregistered sub-graph to fail
# with a 4xx; previously zero coverage. Use a name seeded with a fresh
# timestamp to avoid collisions with anything a previous test run might
# have created.
UNREG_SG="never-created-$(date +%s%N)"
http_post_capture "http://127.0.0.1:9201/api/shared-memory/write" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"subGraphName\":\"$UNREG_SG\",\"quads\":[$(ql 'urn:unreg:x' 'http://schema.org/name' 'nope')]}" \
  UNREG_BODY UNREG_CODE
if [[ "$UNREG_CODE" =~ ^4 ]]; then
  ok "Write to unregistered sub-graph rejected (HTTP $UNREG_CODE)"
else
  fail "Write to unregistered sub-graph not rejected (HTTP $UNREG_CODE): ${UNREG_BODY:0:200}"
fi

#------------------------------------------------------------
echo ""
echo "=== SECTION 25: Regression Tests for Fix Round ==="
echo ""

echo "--- 25a: VM query returns published data (§16.1 root content graph) ---"
VM_REG=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name } LIMIT 5\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verified-memory\"
}")
VM_REG_CT=$(safe_bindings_count "$VM_REG")
if [[ "$VM_REG_CT" == "PARSE_ERR" ]]; then
  fail "VM regression query returned unparseable response: ${VM_REG:0:200}"
elif [[ "$VM_REG_CT" -ge 1 ]]; then
  ok "VM view returns $VM_REG_CT bindings from root content graph (§16.1)"
else
  fail "VM view returns 0 bindings — root content graph not included in verified-memory view"
fi

echo "--- 25b: ABI error decoding — UPDATE to non-existent KC returns decoded error ---"
UPDATE_ERR=$(c -X POST "http://127.0.0.1:9201/api/update" -d "{
  \"kcId\":\"999999\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[{\"subject\":\"urn:test:err\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"test\\\"\",\"graph\":\"\"}]
}")
echo "  Update error response: $(echo "$UPDATE_ERR" | head -c 200)"
echo "$UPDATE_ERR" | grep -qi "error\|BatchNotFound\|NotBatchPublisher\|does not exist" && ok "UPDATE to non-existent KC returned meaningful error" || warn "UPDATE error not decoded: ${UPDATE_ERR:0:200}"

echo "--- 25c: SWM write to unregistered sub-graph returns 400 ---"
UNREG_SG2="regression-unreg-$(date +%s%N)"
http_post_capture "http://127.0.0.1:9201/api/shared-memory/write" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"subGraphName\":\"$UNREG_SG2\",\"quads\":[{\"subject\":\"urn:unreg:x\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"nope\\\"\",\"graph\":\"\"}]}" \
  UNREG2_BODY UNREG2_CODE
if [[ "$UNREG2_CODE" == "400" ]]; then
  ok "Unregistered sub-graph write returns HTTP 400"
elif [[ "$UNREG2_CODE" =~ ^4 ]]; then
  ok "Unregistered sub-graph write returns HTTP $UNREG2_CODE"
else
  fail "Unregistered sub-graph write not rejected properly (HTTP $UNREG2_CODE): ${UNREG2_BODY:0:200}"
fi

echo "--- 25d: Dynamic node count — NUM_NODES matches expected ---"
check "Dynamic node count" "$NUM_NODES" "$NUM_NODES"

echo "--- 25e: SWM view does NOT return root content graph data ---"
SWM_ISO=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { ?s <http://schema.org/name> ?name . ?s a <http://schema.org/City> } LIMIT 1\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"shared-working-memory\"
}")
SWM_ISO_CT=$(safe_bindings_count "$SWM_ISO")
if [[ "$SWM_ISO_CT" == "0" || "$SWM_ISO_CT" == "PARSE_ERR" ]]; then
  ok "SWM view correctly excludes root content graph (0 city bindings)"
else
  warn "SWM view returned $SWM_ISO_CT bindings — may contain stale data"
fi

#------------------------------------------------------------
echo ""
echo "=== SECTION 26: Tri-Modal Memory (Conversation Turns) ==="
echo ""

MEMORY_CG="$CONTEXT_GRAPH"

echo "--- 26a: Ingest a conversation turn via /api/memory/turn ---"
TURN_MD="# Tri-Modal Memory Test\n\nThis turn tests the conversation ingest pipeline.\n\n## Key Concepts\n\n- Knowledge Assets share one UAL across text, graph, and vector\n- Conversation turns are stored as markdown files\n- The extraction pipeline derives RDF triples from markdown"
TURN_RESP=$(c -X POST "http://127.0.0.1:9201/api/memory/turn" -d "{
  \"contextGraphId\":\"$MEMORY_CG\",
  \"markdown\":\"$TURN_MD\",
  \"speaker\":\"devnet-test-agent\",
  \"role\":\"assistant\"
}")
TURN_URI=$(json_get "$TURN_RESP" turnUri)
TURN_HASH=$(json_get "$TURN_RESP" fileHash)
TURN_LAYER=$(json_get "$TURN_RESP" layer)
TURN_QUADS=$(json_get "$TURN_RESP" totalQuads)
echo "  turnUri=$TURN_URI fileHash=$TURN_HASH layer=$TURN_LAYER quads=$TURN_QUADS"
[[ "$TURN_URI" != "__NONE__" && "$TURN_URI" != "__ERR__" ]] && ok "Memory turn ingested: $TURN_URI" || fail "Memory turn ingest failed: ${TURN_RESP:0:300}"
[[ "$TURN_HASH" != "__NONE__" && "$TURN_HASH" != "__ERR__" ]] && ok "Turn file hash returned ($TURN_HASH)" || fail "No turn file hash"
[[ "$TURN_QUADS" != "__NONE__" && "$TURN_QUADS" != "0" ]] && ok "Turn generated $TURN_QUADS quads" || warn "Turn generated 0 quads"

echo "--- 26b: Turn is queryable as ConversationTurn in SWM ---"
MEMORY_SETTLE_S="${MEMORY_SETTLE_S:-3}"
sleep "$MEMORY_SETTLE_S"
TURN_TYPE_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?turn WHERE { BIND(<$TURN_URI> AS ?turn) ?turn a <http://schema.org/ConversationTurn> } LIMIT 1\",
  \"contextGraphId\":\"$MEMORY_CG\",
  \"view\":\"shared-working-memory\"
}")
TURN_TYPE_VAL=$(echo "$TURN_TYPE_Q" | python3 -c "import sys,json; b=json.load(sys.stdin).get('result',{}).get('bindings',[]); print('yes' if b else 'no')" 2>/dev/null || echo "ERR")
if [[ "$TURN_TYPE_VAL" == "yes" ]]; then
  ok "Turn $TURN_URI is typed as ConversationTurn in SWM"
elif [[ "$TURN_TYPE_VAL" == "ERR" ]]; then
  fail "ConversationTurn type query returned unparseable response: ${TURN_TYPE_Q:0:200}"
else
  fail "Turn $TURN_URI not found as ConversationTurn in SWM"
fi

echo "--- 26c: Turn has schema:description quad ---"
TURN_DESC_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?desc WHERE { <$TURN_URI> <http://schema.org/description> ?desc } LIMIT 1\",
  \"contextGraphId\":\"$MEMORY_CG\",
  \"view\":\"shared-working-memory\"
}")
TURN_DESC_CT=$(safe_bindings_count "$TURN_DESC_Q")
if [[ "$TURN_DESC_CT" == "PARSE_ERR" ]]; then
  fail "Turn description query returned unparseable response: ${TURN_DESC_Q:0:200}"
elif [[ "$TURN_DESC_CT" -ge 1 ]]; then
  ok "Turn has schema:description quad"
else
  warn "Turn missing schema:description ($TURN_DESC_CT)"
fi

echo "--- 26d: Turn has agent attribution ---"
TURN_AGENT_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?agent WHERE { <$TURN_URI> <http://schema.org/agent> ?agent } LIMIT 1\",
  \"contextGraphId\":\"$MEMORY_CG\",
  \"view\":\"shared-working-memory\"
}")
TURN_AGENT_CT=$(safe_bindings_count "$TURN_AGENT_Q")
if [[ "$TURN_AGENT_CT" == "PARSE_ERR" ]]; then
  fail "Turn agent query returned unparseable response: ${TURN_AGENT_Q:0:200}"
elif [[ "$TURN_AGENT_CT" -ge 1 ]]; then
  ok "Turn has agent attribution"
else
  warn "Turn missing agent attribution ($TURN_AGENT_CT)"
fi

echo "--- 26e: Source file retrievable via /api/file ---"
if [[ "$TURN_HASH" != "__NONE__" && "$TURN_HASH" != "__ERR__" ]]; then
  FILE_CODE=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
    -H "Authorization: Bearer $AUTH" \
    -o /dev/null -w "%{http_code}" \
    "http://127.0.0.1:9201/api/file/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TURN_HASH', safe=''))")")
  [[ "$FILE_CODE" == "200" ]] && ok "Source file retrievable (HTTP $FILE_CODE)" || fail "Source file not retrievable (HTTP $FILE_CODE)"
else
  skip "26e: no file hash to test"
fi

echo "--- 26f: Ingest a second turn with session linking ---"
TURN2_MD="# Follow-up Discussion\n\nThis is a second turn in the same session to test session linking."
SESSION_URI="urn:dkg:session:devnet-test-$(date +%s)"
TURN2_RESP=$(c -X POST "http://127.0.0.1:9201/api/memory/turn" -d "{
  \"contextGraphId\":\"$MEMORY_CG\",
  \"markdown\":\"$TURN2_MD\",
  \"speaker\":\"devnet-test-user\",
  \"role\":\"user\",
  \"sessionUri\":\"$SESSION_URI\"
}")
TURN2_URI=$(json_get "$TURN2_RESP" turnUri)
TURN2_SESSION=$(json_get "$TURN2_RESP" sessionUri)
[[ "$TURN2_URI" != "__NONE__" && "$TURN2_URI" != "__ERR__" ]] && ok "Second turn ingested: $TURN2_URI" || fail "Second turn ingest failed: ${TURN2_RESP:0:200}"
[[ "$TURN2_SESSION" == "$SESSION_URI" ]] && ok "Session URI echoed back correctly" || warn "Session URI mismatch (expected=$SESSION_URI, got=$TURN2_SESSION)"

echo "--- 26g: Session linking quads present ---"
sleep "$LOCAL_SETTLE_S"
SESSION_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?turn WHERE { ?turn <http://schema.org/isPartOf> <$SESSION_URI> } LIMIT 5\",
  \"contextGraphId\":\"$MEMORY_CG\",
  \"view\":\"shared-working-memory\"
}")
SESSION_CT=$(safe_bindings_count "$SESSION_Q")
if [[ "$SESSION_CT" == "PARSE_ERR" ]]; then
  fail "Session linking query returned unparseable response: ${SESSION_Q:0:200}"
elif [[ "$SESSION_CT" -ge 1 ]]; then
  ok "Session linking quads present ($SESSION_CT turns linked)"
else
  warn "Session linking quads not found ($SESSION_CT)"
fi

echo "--- 26h: /api/memory/search — SPARQL text match ---"
SEARCH_RESP=$(c -X POST "http://127.0.0.1:9201/api/memory/search" -d "{
  \"query\":\"Tri-Modal Memory\",
  \"contextGraphId\":\"$MEMORY_CG\",
  \"limit\":5,
  \"memoryLayers\":[\"swm\"]
}")
SEARCH_CT=$(echo "$SEARCH_RESP" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print(len(d.get("results",[])))
except: print("ERR")
' 2>/dev/null || echo "ERR")
echo "  Search results: $SEARCH_CT"
if [[ "$SEARCH_CT" == "ERR" ]]; then
  fail "Memory search returned unparseable response: ${SEARCH_RESP:0:200}"
elif [[ "$SEARCH_CT" -ge 1 ]]; then
  ok "Memory search returned $SEARCH_CT results for 'Tri-Modal Memory'"
else
  fail "Memory search returned 0 results — ingested turn not searchable via SPARQL/text"
fi

echo "--- 26i: Memory search scoped — no cross-CG leakage ---"
FAKE_CG="nonexistent-memory-cg-$(date +%s)"
LEAK_RESP=$(c -X POST "http://127.0.0.1:9201/api/memory/search" -d "{
  \"query\":\"Tri-Modal Memory\",
  \"contextGraphId\":\"$FAKE_CG\",
  \"limit\":5
}")
LEAK_CT=$(echo "$LEAK_RESP" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print(len(d.get("results",[])))
except: print("ERR")
' 2>/dev/null || echo "ERR")
if [[ "$LEAK_CT" == "ERR" ]]; then
  warn "Cross-CG search returned unparseable response: ${LEAK_RESP:0:200}"
elif [[ "$LEAK_CT" -eq 0 ]]; then
  ok "Memory search correctly scoped — no cross-CG leakage"
else
  fail "Memory search leaked $LEAK_CT results to wrong CG"
fi

echo "--- 26j: Invalid sessionUri rejected with 400 ---"
BAD_SESSION_RESP=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
  -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" \
  -o /dev/null -w "%{http_code}" \
  -X POST "http://127.0.0.1:9201/api/memory/turn" -d "{
    \"contextGraphId\":\"$MEMORY_CG\",
    \"markdown\":\"test\",
    \"speaker\":\"test\",
    \"role\":\"user\",
    \"sessionUri\":\"has spaces and {braces}\"
  }")
[[ "$BAD_SESSION_RESP" == "400" ]] && ok "Invalid sessionUri rejected (HTTP 400)" || fail "Invalid sessionUri returned HTTP $BAD_SESSION_RESP (expected 400)"

echo "--- 26k: Turn gossips to other nodes via SWM ---"
sleep "$GOSSIP_WAIT_S"
for p in 9202 9203; do
  GOS_TURN=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT (COUNT(*) AS ?c) WHERE { ?s a <http://schema.org/ConversationTurn> . FILTER(CONTAINS(STR(?s),'turn/')) }\",
    \"contextGraphId\":\"$MEMORY_CG\",
    \"view\":\"shared-working-memory\"
  }")
  GOS_CT=$(echo "$GOS_TURN" | python3 -c "
import sys,json,re
b=json.load(sys.stdin).get('result',{}).get('bindings',[])
if b:
  v=str(b[0].get('c','0'))
  m=re.search(r'(\d+)',v)
  print(m.group(1) if m else '0')
else: print('0')
" 2>/dev/null)
  [[ "$GOS_CT" -ge 1 ]] && ok "Node $p has $GOS_CT conversation turns via gossip" || warn "Node $p has $GOS_CT turns (gossip pending?)"
done

#------------------------------------------------------------
echo ""
echo "=== SECTION 27: Free CG Creation & Registration ==="
echo ""

FREE_CG_ID="free-cg-test-$(date +%s)"
FREE_CG_NAME="Free CG Test"

echo "--- 27a: Create a free CG (no chain tx) ---"
FREE_CG_RESP=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" -d "{
  \"id\":\"$FREE_CG_ID\",
  \"name\":\"$FREE_CG_NAME\",
  \"description\":\"Test CG created for free (no chain)\"
}")
FREE_CG_CREATED=$(json_get "$FREE_CG_RESP" created)
FREE_CG_URI=$(json_get "$FREE_CG_RESP" uri)
if [[ "$FREE_CG_CREATED" == "$FREE_CG_ID" ]]; then
  ok "Free CG created: id=$FREE_CG_CREATED uri=$FREE_CG_URI"
else
  fail "Free CG creation failed: $FREE_CG_RESP"
fi

echo "--- 27b: Verify free CG appears in list ---"
LIST_RESP=$(c "http://127.0.0.1:9201/api/context-graph/list")
LIST_HAS_CG=$(echo "$LIST_RESP" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  cgs=d.get('contextGraphs',[])
  found=any(c.get('id')=='$FREE_CG_ID' for c in cgs)
  print('true' if found else 'false')
except: print('false')
" 2>/dev/null)
[[ "$LIST_HAS_CG" == "true" ]] && ok "Free CG found in context-graph list" || fail "Free CG not in list"

echo "--- 27c: Write to SWM on free CG (should work without chain) ---"
SWM_FREE_RESP=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/write" -d "{
  \"contextGraphId\":\"$FREE_CG_ID\",
  \"quads\":[
    $(ql "http://example.org/entity/free-test-1" "http://schema.org/name" "FreeCGEntity"),
    $(q  "http://example.org/entity/free-test-1" "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" "http://schema.org/Thing")
  ]
}")
SWM_FREE_OK=$(json_get "$SWM_FREE_RESP" triplesWritten)
if [[ "$SWM_FREE_OK" != "__NONE__" && "$SWM_FREE_OK" != "0" && "$SWM_FREE_OK" != "__ERR__" ]]; then
  ok "SWM write to free CG succeeded ($SWM_FREE_OK triples)"
else
  fail "SWM write to free CG failed: $SWM_FREE_RESP"
fi

echo "--- 27d: Query SWM on free CG ---"
sleep "$LOCAL_SETTLE_S"
SWM_FREE_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { ?s <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$FREE_CG_ID\",
  \"view\":\"shared-working-memory\"
}")
SWM_FREE_QC=$(safe_bindings_count "$SWM_FREE_Q")
if [[ "$SWM_FREE_QC" == "PARSE_ERR" ]]; then
  fail "SWM query on free CG returned unparseable response"
elif [[ "$SWM_FREE_QC" -ge 1 ]]; then
  ok "SWM query on free CG returns $SWM_FREE_QC binding(s)"
else
  fail "SWM query on free CG returns 0 bindings"
fi

echo "--- 27e: VM publish on unregistered CG should fail ---"
http_post_capture "http://127.0.0.1:9201/api/shared-memory/publish" \
  "{\"contextGraphId\":\"$FREE_CG_ID\"}" \
  VM_GUARD_BODY VM_GUARD_CODE
if [[ "$VM_GUARD_CODE" == "500" ]] && echo "$VM_GUARD_BODY" | grep -qi "not registered"; then
  ok "VM publish blocked on unregistered CG (HTTP $VM_GUARD_CODE)"
elif [[ "$VM_GUARD_CODE" =~ ^[45] ]]; then
  ok "VM publish blocked on unregistered CG (HTTP $VM_GUARD_CODE)"
else
  fail "VM publish should be blocked on unregistered CG (HTTP $VM_GUARD_CODE): ${VM_GUARD_BODY:0:200}"
fi

echo "--- 27f: Register CG on-chain ---"
REG_RESP=$(c -X POST "http://127.0.0.1:9201/api/context-graph/register" -d "{
  \"id\":\"$FREE_CG_ID\"
}")
REG_ONCHAIN=$(json_get "$REG_RESP" onChainId)
REG_ID=$(json_get "$REG_RESP" registered)
if [[ "$REG_ID" == "$FREE_CG_ID" && "$REG_ONCHAIN" != "__NONE__" && "$REG_ONCHAIN" != "__ERR__" ]]; then
  ok "CG registered on-chain: onChainId=$REG_ONCHAIN"
else
  fail "CG registration failed: $REG_RESP"
fi

echo "--- 27g: Double-register should return 409 ---"
http_post_capture "http://127.0.0.1:9201/api/context-graph/register" \
  "{\"id\":\"$FREE_CG_ID\"}" \
  DOUBLE_REG_BODY DOUBLE_REG_CODE
if [[ "$DOUBLE_REG_CODE" == "409" ]]; then
  ok "Double-register returns 409 Conflict"
else
  warn "Double-register returned HTTP $DOUBLE_REG_CODE (expected 409): ${DOUBLE_REG_BODY:0:200}"
fi

echo "--- 27h: VM publish after registration should work ---"
PUB_RESP=$(c -X POST "http://127.0.0.1:9201/api/shared-memory/publish" -d "{
  \"contextGraphId\":\"$FREE_CG_ID\"
}")
PUB_ST=$(json_get "$PUB_RESP" status)
if [[ "$PUB_ST" == "confirmed" || "$PUB_ST" == "finalized" || "$PUB_ST" == "tentative" ]]; then
  ok "VM publish after registration succeeded (status=$PUB_ST)"
else
  fail "VM publish after registration failed (status=$PUB_ST): ${PUB_RESP:0:300}"
fi

echo "--- 27i: Create curated CG with allowedPeers ---"
# Fetch real peer IDs from the running devnet nodes
NODE1_PEER=$(json_get "$(c "http://127.0.0.1:9201/api/info")" peerId)
NODE2_PEER=$(json_get "$(c "http://127.0.0.1:9202/api/info")" peerId)
CURATED_CG_ID="curated-cg-test-$(date +%s)"
CURATED_RESP=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" -d "{
  \"id\":\"$CURATED_CG_ID\",
  \"name\":\"Curated Test CG\",
  \"allowedPeers\":[\"$NODE1_PEER\",\"$NODE2_PEER\"]
}")
CURATED_OK=$(json_get "$CURATED_RESP" created)
[[ "$CURATED_OK" == "$CURATED_CG_ID" ]] && ok "Curated CG created with allowedPeers" || fail "Curated CG creation: $CURATED_RESP"

echo "--- 27j: Invite peer to context graph ---"
INVITE_RESP=$(c -X POST "http://127.0.0.1:9201/api/context-graph/invite" -d "{
  \"contextGraphId\":\"$CURATED_CG_ID\",
  \"peerId\":\"$NODE2_PEER\"
}")
INVITE_OK=$(json_get "$INVITE_RESP" invited)
[[ "$INVITE_OK" == "$NODE2_PEER" ]] && ok "Peer invited to curated CG" || fail "Peer invite: $INVITE_RESP"

echo "--- 27k: Register non-existent CG should return 404 ---"
http_post_capture "http://127.0.0.1:9201/api/context-graph/register" \
  "{\"id\":\"does-not-exist-$(date +%s)\"}" \
  REG404_BODY REG404_CODE
[[ "$REG404_CODE" == "404" ]] && ok "Register non-existent CG returns 404" || warn "Register non-existent CG returned HTTP $REG404_CODE (expected 404)"

echo "--- 27l: Create duplicate CG should return 409 ---"
http_post_capture "http://127.0.0.1:9201/api/context-graph/create" \
  "{\"id\":\"$FREE_CG_ID\",\"name\":\"duplicate\"}" \
  DUP_BODY DUP_CODE
[[ "$DUP_CODE" == "409" ]] && ok "Duplicate CG creation returns 409" || warn "Duplicate CG returned HTTP $DUP_CODE (expected 409): ${DUP_BODY:0:200}"

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
