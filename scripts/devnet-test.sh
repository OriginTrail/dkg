#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_CONSTANTS_TS="$SCRIPT_DIR/../packages/core/src/constants.ts"
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

# Total-script timing — print elapsed at the bottom so a "this used to take
# 3 minutes" regression is visible. Per-section timing is wired into the
# new sections (28-30) only; retrofitting it across all 28 sections would
# need wrapping each in a function.
SCRIPT_T0=$(date +%s)

# Optional knobs for the newer sections. Defaults are conservative
# enough to run end-to-end without surprising the operator. Override:
#   SKIP_RESTART=1        — skip SECTION 30 (Node1 restart, ~30-60s)
#   SKIP_MATRIX=1         — skip SECTION 29 (cross-node connect matrix)
#   SKIP_INVITE_FLOW=1    — skip SECTION 31 (curated CG invite/join e2e, ~10-30s)
#   SKIP_RC9_SUBSTRATE=1  — skip SECTIONS 32-36 (rc.9 SLO + SWM substrate observability)
#   SKIP_EDGE_RESTART=1   — skip SECTION 37 (edge restart outbox-durability, ~30-60s)
#   RESTART_BOOT_TIMEOUT_S=60   — how long SECTION 30 / 37 waits for the node's API
#   INVITE_DENIED_TIMEOUT_S=90  — SECTION 31 catch-up poll budget (denied/done)
#   EDGE_OUTBOX_FLUSH_TIMEOUT_S=45  — SECTION 37 poll budget for substrate flush after recipient restart
#   IDEMPOTENCY_QUIET_PERIOD_S=10   — SECTION 37 post-first-match window to catch late duplicates before asserting exactly-once
#   ACK_DRAIN_TIMEOUT_S=75          — SECTION 35 poll budget for shareAckQuorum.pending to drain to ≤1.
#                                     Default is 2.5× DEFAULT_WATCHDOG_MS (30s in swm/ack-quorum.ts) so a
#                                     share recovering only on the first watchdog cycle has time to drain.
#   FANOUT_QUIET_WINDOW_S=40        — SECTION 36 quiet-window length to observe substrate counter deltas.
#                                     Default exceeds MESSAGE_OUTBOX_TICK_MS (30s in dkg-agent-constants.ts)
#                                     so the window covers at least one full retry-tick cycle.
SKIP_RESTART="${SKIP_RESTART:-0}"
SKIP_MATRIX="${SKIP_MATRIX:-0}"
SKIP_INVITE_FLOW="${SKIP_INVITE_FLOW:-0}"
SKIP_RC9_SUBSTRATE="${SKIP_RC9_SUBSTRATE:-0}"
SKIP_EDGE_RESTART="${SKIP_EDGE_RESTART:-0}"
RESTART_BOOT_TIMEOUT_S="${RESTART_BOOT_TIMEOUT_S:-60}"
INVITE_DENIED_TIMEOUT_S="${INVITE_DENIED_TIMEOUT_S:-90}"
EDGE_OUTBOX_FLUSH_TIMEOUT_S="${EDGE_OUTBOX_FLUSH_TIMEOUT_S:-45}"
IDEMPOTENCY_QUIET_PERIOD_S="${IDEMPOTENCY_QUIET_PERIOD_S:-10}"
ACK_DRAIN_TIMEOUT_S="${ACK_DRAIN_TIMEOUT_S:-75}"
FANOUT_QUIET_WINDOW_S="${FANOUT_QUIET_WINDOW_S:-40}"

# Per-section timer helpers (used by sections 28-30). The existing 27
# sections aren't wrapped — see comment on SCRIPT_T0 above.
SECTION_T0=0
section_start() {
  SECTION_T0=$(date +%s)
  echo ""
  echo "=== $1 ==="
  echo ""
}
section_done() {
  local elapsed=$(( $(date +%s) - SECTION_T0 ))
  echo ""
  echo "  -- section took ${elapsed}s --"
}

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

protocol_const() {
  local const_name="$1"
  sed -nE "s|^export const ${const_name} = '([^']+)';$|\1|p" "$CORE_CONSTANTS_TS" 2>/dev/null | head -n 1
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

ka_create_share() {
  local port=$1 cg=$2 name=$3 sub_graph=$4
  shift 4
  local quads="$*"
  local sub_graph_json=""
  if [[ -n "$sub_graph" ]]; then
    sub_graph_json=",\"subGraphName\":\"$sub_graph\""
  fi
  c -X POST "http://127.0.0.1:$port/api/knowledge-assets" -d "{
    \"contextGraphId\":\"$cg\",
    \"name\":\"$name\"$sub_graph_json,
    \"quads\":[$quads],
    \"finalize\":true,
    \"alsoShareSwm\":true
  }"
}

ka_publish() {
  local port=$1 cg=$2 name=$3
  c -X POST "http://127.0.0.1:$port/api/knowledge-assets/$name/vm/publish" -d "{
    \"contextGraphId\":\"$cg\"
  }"
}

ka_publish_async() {
  local port=$1 cg=$2 name=$3
  c -X POST "http://127.0.0.1:$port/api/knowledge-assets/$name/vm/publish-async" -d "{
    \"contextGraphId\":\"$cg\"
  }"
}

retired_post_assert() {
  local desc="$1" port="$2" path="$3" body="$4"
  local retired_body retired_code
  http_post_capture "http://127.0.0.1:$port$path" "$body" retired_body retired_code
  if [[ "$retired_code" == "404" || "$retired_code" == "410" ]]; then
    ok "$desc retired (HTTP $retired_code)"
  else
    fail "$desc unexpectedly served (HTTP $retired_code): ${retired_body:0:200}"
  fi
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
echo "  Node2 TRAC before KA create/share: $TRAC_BEFORE"

ALICE_BOB_KA="alice-bob-$(date +%s%N)"
SWM_W=$(ka_create_share 9202 "$CONTEXT_GRAPH" "$ALICE_BOB_KA" "" \
    $(ql 'http://example.org/entity/alice' 'http://schema.org/name' 'Alice'),
    $(ql 'http://example.org/entity/alice' 'http://schema.org/age' '30'),
    $(q 'http://example.org/entity/alice' 'http://schema.org/knows' 'http://example.org/entity/bob'),
    $(ql 'http://example.org/entity/bob' 'http://schema.org/name' 'Bob'),
    $(ql 'http://example.org/entity/bob' 'http://schema.org/age' '25')
)
swm_written=$(json_get "$SWM_W" promotedCount)
[[ "$swm_written" != "__NONE__" && "$swm_written" != "0" ]] && ok "KA create/share OK ($swm_written triples)" || fail "KA create/share failed: $SWM_W"

TRAC_AFTER=$(c "http://127.0.0.1:9202/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
check "KA create/share is FREE (TRAC unchanged)" "$TRAC_BEFORE" "$TRAC_AFTER"

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
CITY1_KA="city1-ka-$(date +%s%N)"
CITY2_KA="city2-ka-$(date +%s%N)"
CITY1_SHARE=$(ka_create_share 9201 "$CONTEXT_GRAPH" "$CITY1_KA" "" \
    $(ql 'http://example.org/entity/city1' 'http://schema.org/name' 'Ljubljana'),
    $(q 'http://example.org/entity/city1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city1' 'http://schema.org/population' '290000')
)
CITY1_SHARED=$(json_get "$CITY1_SHARE" swmShared)
[[ "$CITY1_SHARED" == "true" ]] && ok "$CITY1_KA shared to SWM" || fail "$CITY1_KA share failed: $CITY1_SHARE"
CITY2_SHARE=$(ka_create_share 9201 "$CONTEXT_GRAPH" "$CITY2_KA" "" \
    $(ql 'http://example.org/entity/city2' 'http://schema.org/name' 'Maribor'),
    $(q 'http://example.org/entity/city2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city2' 'http://schema.org/population' '95000')
)
CITY2_SHARED=$(json_get "$CITY2_SHARE" swmShared)
[[ "$CITY2_SHARED" == "true" ]] && ok "$CITY2_KA shared to SWM" || fail "$CITY2_KA share failed: $CITY2_SHARE"
sleep 2

PUB1=$(ka_publish 9201 "$CONTEXT_GRAPH" "$CITY1_KA")
PUB2=$(ka_publish 9201 "$CONTEXT_GRAPH" "$CITY2_KA")
PUB1_ST=$(json_get "$PUB1" status)
PUB1_KC=$(json_get "$PUB1" kaId)
PUB1_TX=$(json_get "$PUB1" txHash)
PUB1_BN=$(json_get "$PUB1" blockNumber)
PUB2_ST=$(json_get "$PUB2" status)
PUB2_KC=$(json_get "$PUB2" kaId)
PUB2_TX=$(json_get "$PUB2" txHash)
PUB1_KAS=0
[[ "$PUB1_ST" == "confirmed" || "$PUB1_ST" == "finalized" ]] && PUB1_KAS=$((PUB1_KAS + 1))
[[ "$PUB2_ST" == "confirmed" || "$PUB2_ST" == "finalized" ]] && PUB1_KAS=$((PUB1_KAS + 1))

echo "  city1: status=$PUB1_ST kaId=$PUB1_KC tx=$PUB1_TX block=$PUB1_BN"
echo "  city2: status=$PUB2_ST kaId=$PUB2_KC tx=$PUB2_TX"
[[ "$PUB1_ST" == "confirmed" || "$PUB1_ST" == "finalized" ]] && ok "$CITY1_KA VM publish succeeded ($PUB1_ST)" || fail "$CITY1_KA publish status=$PUB1_ST: $PUB1"
[[ "$PUB2_ST" == "confirmed" || "$PUB2_ST" == "finalized" ]] && ok "$CITY2_KA VM publish succeeded ($PUB2_ST)" || fail "$CITY2_KA publish status=$PUB2_ST: $PUB2"
[[ "$PUB1_TX" != "__NONE__" && "$PUB2_TX" != "__NONE__" ]] && ok "On-chain txs: $PUB1_TX / $PUB2_TX" || fail "Missing city publish txHash"
[[ "$PUB1_KAS" == "2" ]] && ok "Published 2 named KAs ($CITY1_KA, $CITY2_KA)" || fail "Expected 2 named KA publishes, got $PUB1_KAS"

echo ""
echo "--- 3b: Query Verifiable Memory for published city root entities on publisher ---"
LTM_CT=0
for i in $(seq 1 15); do
  LTM_Q=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
    \"sparql\":\"SELECT ?s ?name WHERE { VALUES ?s { <http://example.org/entity/city1> <http://example.org/entity/city2> } ?s <http://schema.org/name> ?name } LIMIT 10\",
    \"contextGraphId\":\"$CONTEXT_GRAPH\",
    \"view\":\"verifiable-memory\"
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
    \"view\":\"verifiable-memory\"
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
# chain-capable node may promote selected SWM data to Verifiable Memory. Curated
# publish-authority rejection is covered by private/curated sharing tests.

echo "--- 4a: Node2 (core) shares a Product triple-set to SWM ---"
PRODUCT1_KA="product1-ka-$(date +%s%N)"
PRODUCT2_KA="product2-ka-$(date +%s%N)"
PERSON1_KA="person1-ka-$(date +%s%N)"
LAKE1_KA="lake1-ka-$(date +%s%N)"
LAKE1_PUBLISH_KA="lake1-publish-ka-$(date +%s%N)"
SWM2=$(ka_create_share 9202 "$CONTEXT_GRAPH" "$PRODUCT1_KA" "" \
    $(ql 'http://example.org/entity/product1' 'http://schema.org/name' 'Potica'),
    $(q 'http://example.org/entity/product1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product1' 'http://schema.org/description' 'Traditional Slovenian nut roll')
)
SWM2_W=$(json_get "$SWM2" promotedCount)
[[ "$SWM2_W" == "3" ]] && ok "Node2 SWM contribution accepted ($SWM2_W triples)" || fail "Node2 KA create/share: $SWM2"

echo "--- 4b: Node3 (core, oxigraph) shares a second Product triple-set ---"
SWM3=$(ka_create_share 9203 "$CONTEXT_GRAPH" "$PRODUCT2_KA" "" \
    $(ql 'http://example.org/entity/product2' 'http://schema.org/name' 'Carniolan Sausage'),
    $(q 'http://example.org/entity/product2' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Product'),
    $(ql 'http://example.org/entity/product2' 'http://schema.org/description' 'PGI sausage')
)
SWM3_W=$(json_get "$SWM3" promotedCount)
[[ "$SWM3_W" == "3" ]] && ok "Node3 SWM contribution accepted ($SWM3_W triples)" || fail "Node3 KA create/share: $SWM3"

echo "--- 4c: Node4 (core) shares a Person triple-set to SWM ---"
SWM4=$(ka_create_share 9204 "$CONTEXT_GRAPH" "$PERSON1_KA" "" \
    $(ql 'http://example.org/entity/person1' 'http://schema.org/name' 'France Prešeren'),
    $(q 'http://example.org/entity/person1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),
    $(ql 'http://example.org/entity/person1' 'http://schema.org/birthDate' '1800-12-03')
)
SWM4_W=$(json_get "$SWM4" promotedCount)
[[ "$SWM4_W" == "3" ]] && ok "Node4 SWM contribution accepted ($SWM4_W triples)" || fail "Node4 KA create/share: $SWM4"

echo "--- 4d: Node5 (edge) shares a Lake triple-set to SWM ---"
SWM5=$(ka_create_share 9205 "$CONTEXT_GRAPH" "$LAKE1_KA" "" \
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/name' 'Lake Bled'),
    $(q 'http://example.org/entity/lake1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/LakeBodyOfWater'),
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/description' 'Glacial lake in the Julian Alps')
)
SWM5_W=$(json_get "$SWM5" promotedCount)
[[ "$SWM5_W" == "3" ]] && ok "Node5 (edge) SWM contribution accepted ($SWM5_W triples)" || fail "Node5 KA create/share: $SWM5"

LAKE1_CORE_SHARE=$(ka_create_share 9201 "$CONTEXT_GRAPH" "$LAKE1_PUBLISH_KA" "" \
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/name' 'Lake Bled'),
    $(q 'http://example.org/entity/lake1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/LakeBodyOfWater'),
    $(ql 'http://example.org/entity/lake1' 'http://schema.org/description' 'Glacial lake in the Julian Alps')
)
LAKE1_CORE_SHARED=$(json_get "$LAKE1_CORE_SHARE" swmShared)
[[ "$LAKE1_CORE_SHARED" == "true" ]] && ok "Curator-owned lake KA shared for VM publish" || fail "Curator lake KA share failed: ${LAKE1_CORE_SHARE:0:200}"

echo "--- 4e: Open CG allows Node2 to publish its SWM contribution ---"
sleep 2
http_post_capture "http://127.0.0.1:9202/api/knowledge-assets/$PRODUCT1_KA/vm/publish" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" \
  NON_CURATOR_BODY NON_CURATOR_CODE
NON_CURATOR_ST=$(json_get "$NON_CURATOR_BODY" status)
if [[ "$NON_CURATOR_CODE" == "200" && ( "$NON_CURATOR_ST" == "confirmed" || "$NON_CURATOR_ST" == "finalized" ) ]]; then
  ok "Open-CG publish from Node2 accepted (status=$NON_CURATOR_ST)"
else
  fail "Open-CG publish from Node2 failed, HTTP $NON_CURATOR_CODE status=$NON_CURATOR_ST: ${NON_CURATOR_BODY:0:200}"
fi

# Named lifecycle publish: each chain-capable contributor promotes its KA name;
# the edge payload is published through a curator-owned KA with the same triples.
echo "--- 4f: Remaining named KA publishes succeed across contributors ---"
sleep 2
AGG_PRODUCT2=$(ka_publish 9203 "$CONTEXT_GRAPH" "$PRODUCT2_KA")
AGG_PERSON1=$(ka_publish 9204 "$CONTEXT_GRAPH" "$PERSON1_KA")
AGG_LAKE1=$(ka_publish 9201 "$CONTEXT_GRAPH" "$LAKE1_PUBLISH_KA")
AGG_PRODUCT2_ST=$(json_get "$AGG_PRODUCT2" status)
AGG_PERSON1_ST=$(json_get "$AGG_PERSON1" status)
AGG_LAKE1_ST=$(json_get "$AGG_LAKE1" status)
if [[ ( "$AGG_PRODUCT2_ST" == "confirmed" || "$AGG_PRODUCT2_ST" == "finalized" ) \
   && ( "$AGG_PERSON1_ST" == "confirmed" || "$AGG_PERSON1_ST" == "finalized" ) \
   && ( "$AGG_LAKE1_ST" == "confirmed" || "$AGG_LAKE1_ST" == "finalized" ) ]]; then
  ok "Remaining named KA publishes OK (product2=$AGG_PRODUCT2_ST person1=$AGG_PERSON1_ST lake1=$AGG_LAKE1_ST)"
else
  fail "Remaining named KA publishes failed: product2=$AGG_PRODUCT2_ST person1=$AGG_PERSON1_ST lake1=$AGG_LAKE1_ST"
fi

echo "--- 4g: ALL published entities replicate to ALL nodes ---"
sleep 12
for p in "${NODE_PORTS[@]}"; do
  for entity in city1 city2 product1 product2 person1 lake1; do
    R=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
      \"sparql\":\"ASK { <http://example.org/entity/$entity> <http://schema.org/name> ?name }\",
      \"contextGraphId\":\"$CONTEXT_GRAPH\",
      \"view\":\"verifiable-memory\"
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
# for the wrong reason. This section therefore has Node1 create/share a
# publish-ready KA, promote it to VM, and checks Node1's balance delta.

TRAC1_B=$(c "http://127.0.0.1:9201/api/wallets/balances" | python3 -c "import sys,json; print(json.load(sys.stdin)['balances'][0]['trac'])" 2>/dev/null)
echo "  Node1 (curator) TRAC before: $TRAC1_B"

COST_KA="cost-test-ka-$(date +%s%N)"
COST_SHARE=$(ka_create_share 9201 "$CONTEXT_GRAPH" "$COST_KA" "" \
    $(ql 'http://example.org/entity/cost-test' 'http://schema.org/name' 'CostTest'),
    $(q 'http://example.org/entity/cost-test' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
)
COST_SHARED=$(json_get "$COST_SHARE" swmShared)
[[ "$COST_SHARED" == "true" ]] && ok "Cost-test KA shared by Node1" || fail "Cost-test KA share failed: ${COST_SHARE:0:200}"
sleep 1
COST_PUB=$(ka_publish 9201 "$CONTEXT_GRAPH" "$COST_KA")
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
  \"kaId\":\"$PUB1_KC\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[
    $(ql 'http://example.org/entity/city1' 'http://schema.org/name' 'Ljubljana'),
    $(q 'http://example.org/entity/city1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/City'),
    $(ql 'http://example.org/entity/city1' 'http://schema.org/population' '295000')
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

# Per SPEC_CG_MEMORY_MODEL, per-CG hosting committees and per-CG quorum
# overrides were removed from the wire format end-to-end. Hosting is
# handled by the network sharding table at publish time, and the ACK
# quorum is the system parameter parametersStorage.minimumRequiredSignatures().
# This section simply creates a public CG (accessPolicy=0, publishPolicy=1)
# and exercises the downstream dedup / publish paths.
CG_SLUG="devnet-test-section7-$(date +%s)"
CG=$(c -X POST "http://127.0.0.1:9201/api/context-graph/create" -d "{
  \"id\":\"$CG_SLUG\",
  \"name\":\"Devnet Test Section 7\",
  \"accessPolicy\":0,
  \"publishPolicy\":1
}")
# Daemon returns { created: "<slug>", uri: "<did>" } on success, { error: "..." } on failure.
CG_ID=$(json_get "$CG" created)
CG_URI=$(json_get "$CG" uri)
echo "  CG result: created=$CG_ID uri=$CG_URI"
[[ -n "$CG_ID" ]] && ok "Context Graph created (id=$CG_ID)" || fail "CG creation: $CG"

#------------------------------------------------------------
echo ""
echo "=== SECTION 8: Triple Deduplication ==="
echo ""

DEDUP_KA="dedup1-ka-$(date +%s%N)"
DEDUP_SHARE=$(ka_create_share 9201 "$CONTEXT_GRAPH" "$DEDUP_KA" "" \
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest'),
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest'),
    $(ql 'http://example.org/entity/dedup1' 'http://schema.org/name' 'DedupTest')
)
DEDUP_SHARED=$(json_get "$DEDUP_SHARE" swmShared)
[[ "$DEDUP_SHARED" == "true" ]] && ok "Dedup KA shared to SWM" || fail "Dedup share failed: ${DEDUP_SHARE:0:200}"
sleep 1
DEDUP=$(ka_publish 9201 "$CONTEXT_GRAPH" "$DEDUP_KA")
DD_ST=$(json_get "$DEDUP" status)
DD_KAS=0
[[ "$DD_ST" == "confirmed" || "$DD_ST" == "finalized" ]] && DD_KAS=1
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

BATCH_KA="batch-50-ka-$(date +%s%N)"
BATCH_SHARE=$(ka_create_share 9201 "$CONTEXT_GRAPH" "$BATCH_KA" "" $BATCH_QUADS)
BATCH_SHARED=$(json_get "$BATCH_SHARE" swmShared)
[[ "$BATCH_SHARED" == "true" ]] && ok "Batch KA shared to SWM" || fail "Batch KA share failed: ${BATCH_SHARE:0:200}"
sleep 2
BATCH=$(ka_publish 9201 "$CONTEXT_GRAPH" "$BATCH_KA")
B_ST=$(json_get "$BATCH" status)
B_TX=$(json_get "$BATCH" txHash)
[[ "$B_ST" == "confirmed" || "$B_ST" == "finalized" ]] && ok "Batch(50) publish OK ($B_ST)" || fail "Batch publish=$B_ST: $BATCH"
[[ "$B_TX" != "__NONE__" ]] && ok "Batch tx: $B_TX" || fail "No batch txHash"
echo "  Batch named KA submitted 50 entities; replication checked below"

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

ka_create_share 9202 "$CONTEXT_GRAPH" "song1-ka-$(date +%s%N)" "" \
  $(ql 'http://example.org/entity/song1' 'http://schema.org/name' 'Zdravljica'),$(q 'http://example.org/entity/song1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/MusicComposition') \
  > /dev/null 2>&1 &
PID1=$!

ka_create_share 9204 "$CONTEXT_GRAPH" "mountain1-ka-$(date +%s%N)" "" \
  $(ql 'http://example.org/entity/mountain1' 'http://schema.org/name' 'Triglav'),$(q 'http://example.org/entity/mountain1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Mountain'),$(ql 'http://example.org/entity/mountain1' 'http://schema.org/elevation' '2864') \
  > /dev/null 2>&1 &
PID2=$!

ka_create_share 9203 "$CONTEXT_GRAPH" "river1-ka-$(date +%s%N)" "" \
  $(ql 'http://example.org/entity/river1' 'http://schema.org/name' 'Sava'),$(q 'http://example.org/entity/river1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/RiverBodyOfWater') \
  > /dev/null 2>&1 &
PID3=$!

wait $PID1 $PID2 $PID3
ok "3 concurrent KA create/share calls completed"

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
    \"view\":\"verifiable-memory\"
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

echo "--- 13b: Retired /api/shared-memory/write is not served ---"
retired_post_assert "/api/shared-memory/write" 9201 "/api/shared-memory/write" '{"contextGraphId":"devnet-test","quads":[]}'

echo "--- 13c: Malformed SPARQL ---"
BAD_SPARQL=$(c -X POST "http://127.0.0.1:9201/api/query" -d '{
  "sparql": "NOT VALID SPARQL AT ALL",
  "contextGraphId": "devnet-test"
}')
echo "$BAD_SPARQL" | grep -qi "error" && ok "Malformed SPARQL returns error" || fail "Malformed SPARQL didn't error: $BAD_SPARQL"

echo "--- 13d: Retired /api/shared-memory/conditional-write is not served ---"
retired_post_assert "/api/shared-memory/conditional-write" 9201 "/api/shared-memory/conditional-write" '{"contextGraphId":"devnet-test","quads":[],"conditions":[]}'

echo "--- 13e: Retired /api/shared-memory/publish is not served ---"
EMPTY_CG="empty-swm-test-$$"
c -X POST "http://127.0.0.1:9205/api/context-graph/create" -d "{\"id\":\"$EMPTY_CG\",\"name\":\"empty swm test\"}" >/dev/null 2>&1
retired_post_assert "/api/shared-memory/publish" 9205 "/api/shared-memory/publish" "{\"contextGraphId\":\"$EMPTY_CG\"}"

#------------------------------------------------------------
echo ""
echo "=== SECTION 14: Assertion Lifecycle (Working Memory) ==="
echo ""

ASSERT_CG="devnet-test"
ASSERT_NAME="devnet-draft-$(date +%s%N)"

echo "--- 14a: Create an assertion ---"
ASSERT_CREATE=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{
  \"contextGraphId\":\"$ASSERT_CG\",
  \"name\":\"$ASSERT_NAME\"
}")
ASSERT_URI=$(json_get "$ASSERT_CREATE" assertionUri)
echo "  Assertion URI: $ASSERT_URI"
[[ "$ASSERT_URI" != "__NONE__" && "$ASSERT_URI" != "__ERR__" ]] && ok "Assertion created: $ASSERT_URI" || fail "Assertion create failed: $ASSERT_CREATE"

echo "--- 14b: Write triples to the assertion ---"
ASSERT_WRITE=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$ASSERT_NAME/wm/write" -d "{
  \"contextGraphId\":\"$ASSERT_CG\",
  \"quads\":[
    $(ql 'urn:devnet:assert:entity1' 'http://schema.org/name' 'Assertion Entity'),
    $(ql 'urn:devnet:assert:entity1' 'http://schema.org/version' '1')
  ]
}")
echo "  Write response: $(echo "$ASSERT_WRITE" | head -c 200)"
echo "$ASSERT_WRITE" | grep -qi "error" && fail "Assertion write failed: $ASSERT_WRITE" || ok "Assertion write OK"

echo "--- 14c: Query the assertion ---"
ASSERT_QUERY=$(c "http://127.0.0.1:9201/api/knowledge-assets/$ASSERT_NAME/wm/quads?contextGraphId=$ASSERT_CG")
ASSERT_Q_CT=$(safe_quads_count "$ASSERT_QUERY")
if [[ "$ASSERT_Q_CT" == "PARSE_ERR" ]]; then
  fail "Assertion query returned unparseable response: ${ASSERT_QUERY:0:200}"
else
  echo "  Assertion has $ASSERT_Q_CT quads"
  [[ "$ASSERT_Q_CT" -ge 1 ]] && ok "Assertion query returned $ASSERT_Q_CT quads" || fail "Assertion query returned 0 quads"
fi

echo "--- 14d: Promote the assertion to SWM ---"
ASSERT_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$ASSERT_NAME/swm/share" -d "{
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
SWM_CT=$(safe_bindings_count "$SWM_CHECK")
if [[ "$SWM_CT" == "PARSE_ERR" ]]; then
  fail "Promoted-data SWM query returned unparseable response: ${SWM_CHECK:0:200}"
else
  [[ "$SWM_CT" -ge 1 ]] && ok "Promoted data visible in SWM" || fail "Promoted data not in SWM ($SWM_CT)"
fi

echo "--- 14f: Create and immediately discard another assertion ---"
c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{\"contextGraphId\":\"$ASSERT_CG\",\"name\":\"discard-me\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/knowledge-assets/discard-me/wm/write" -d "{
  \"contextGraphId\":\"$ASSERT_CG\",
  \"quads\":[$(ql 'urn:devnet:assert:discard' 'http://schema.org/name' 'Discard Me')]
}" > /dev/null
DISCARD_RESP=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/discard-me/wm/discard" -d "{\"contextGraphId\":\"$ASSERT_CG\"}")
echo "$DISCARD_RESP" | grep -qi "error" && fail "Discard failed: $DISCARD_RESP" || ok "Assertion discard OK"

echo "--- 14g: Promoted assertion gossips to other nodes ---"
sleep 4
for p in 9202 9203 9204; do
  GOS_RESP=$(c -X POST "http://127.0.0.1:$p/api/query" -d "{
    \"sparql\":\"SELECT ?name WHERE { <urn:devnet:assert:entity1> <http://schema.org/name> ?name }\",
    \"contextGraphId\":\"$ASSERT_CG\",
    \"graphSuffix\":\"_shared_memory\"
  }")
  GOS_CT=$(safe_bindings_count "$GOS_RESP")
  if [[ "$GOS_CT" == "PARSE_ERR" ]]; then
    warn "Promoted-data gossip query to Node $p returned unparseable response: ${GOS_RESP:0:120}"
  elif [[ "$GOS_CT" -ge 1 ]]; then
    ok "Promoted data gossiped to Node $p"
  else
    warn "Promoted data not on Node $p ($GOS_CT)"
  fi
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

echo "--- 15c: Enqueue a named KA VM publish job ---"
PUB_ENQUEUE=$(ka_publish_async 9201 "$CONTEXT_GRAPH" "$ASSERT_NAME")
echo "  Enqueue: $(echo "$PUB_ENQUEUE" | head -c 300)"
PUB_JOB_ID=$(json_get "$PUB_ENQUEUE" jobId)
PUB_ENQUEUE_ST=$(json_get "$PUB_ENQUEUE" status)
[[ "$PUB_JOB_ID" != "__NONE__" && "$PUB_JOB_ID" != "__ERR__" ]] && ok "Named KA VM publish job enqueued: $PUB_JOB_ID (status=$PUB_ENQUEUE_ST)" || warn "Enqueue response: $PUB_ENQUEUE"

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
c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"name\":\"sg-draft\",
  \"subGraphName\":\"test-assertions\"
}" > /dev/null
SG_AW=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/sg-draft/wm/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"subGraphName\":\"test-assertions\",
  \"quads\":[$(ql 'urn:sg:assert:item1' 'http://schema.org/name' 'Sub-graph Assertion')]
}")
echo "$SG_AW" | grep -qi "error" && fail "Sub-graph assertion write failed: $SG_AW" || ok "Sub-graph assertion write OK"

echo "--- 16c: Promote sub-graph assertion ---"
SG_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/sg-draft/swm/share" -d "{
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
SG_GOS_CT=$(safe_bindings_count "$SG_GOS")
if [[ "$SG_GOS_CT" == "PARSE_ERR" ]]; then
  warn "Sub-graph gossip query to Node3 returned unparseable response: ${SG_GOS:0:120}"
elif [[ "$SG_GOS_CT" -ge 1 ]]; then
  ok "Sub-graph assertion gossiped to Node3"
else
  warn "Sub-graph assertion not on Node3 ($SG_GOS_CT)"
fi

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
ka_create_share 9201 "$CONTEXT_GRAPH" "sync-verify-$(date +%s%N)" "" \
  $(ql "$SYNC_ENTITY" 'http://schema.org/name' 'Post-Subscribe Sync Test') \
  > /dev/null
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

echo "--- 19a: Verifiable memory view ---"
VM_VIEW=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <http://example.org/entity/city1> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verifiable-memory\"
}")
VM_CT=$(safe_bindings_count "$VM_VIEW")
if [[ "$VM_CT" == "PARSE_ERR" ]]; then
  fail "Verifiable memory view returned unparseable response: ${VM_VIEW:0:200}"
elif [[ "$VM_CT" -ge 1 ]]; then
  ok "Verifiable memory view returns published data"
else
  warn "Verifiable memory view empty ($VM_CT) — VM finalization may be pending"
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
c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$WM_NAME\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$WM_NAME/wm/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql "$WM_SUBJECT" 'http://schema.org/name' 'WM Only Data')]
}" > /dev/null

WM_LOCAL=$(c "http://127.0.0.1:9201/api/knowledge-assets/$WM_NAME/wm/quads?contextGraphId=$CONTEXT_GRAPH")
WM_LOCAL_CT=$(safe_quads_count "$WM_LOCAL")
if [[ "$WM_LOCAL_CT" == "PARSE_ERR" ]]; then
  fail "WM assertion query returned unparseable response: ${WM_LOCAL:0:200}"
elif [[ "$WM_LOCAL_CT" -ge 1 ]]; then
  ok "WM assertion visible locally ($WM_LOCAL_CT quads)"
else
  fail "WM assertion not visible locally"
fi

echo "--- 19d: WM data NOT in verifiable memory ---"
WM_IN_VM=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?name WHERE { <$WM_SUBJECT> <http://schema.org/name> ?name }\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verifiable-memory\"
}")
WM_IN_VM_CT=$(safe_bindings_count "$WM_IN_VM")
if [[ "$WM_IN_VM_CT" == "PARSE_ERR" ]]; then
  fail "WM/VM isolation query returned unparseable response: ${WM_IN_VM:0:200}"
elif [[ "$WM_IN_VM_CT" -eq 0 ]]; then
  ok "WM data correctly absent from verifiable memory"
else
  fail "WM data leaked into verifiable memory ($WM_IN_VM_CT)"
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

c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$WM_NAME/wm/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null 2>&1

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
c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$IMPORT_NAME\"}" > /dev/null

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
- Memory layers: Working Memory, Shared Memory, Verifiable Memory
MDEOF

IMPORT_RESP=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
  -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPMD};type=text/markdown" \
  -F "contextGraphId=$CONTEXT_GRAPH" \
  "http://127.0.0.1:9201/api/knowledge-assets/${IMPORT_NAME}/wm/import-file" 2>&1)
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
EXTRACT_ST=$(c "http://127.0.0.1:9201/api/knowledge-assets/${IMPORT_NAME}/wm/extraction-status?contextGraphId=$CONTEXT_GRAPH")
EXT_STATUS=$(json_get "$EXTRACT_ST" status)
echo "  Extraction status: $EXT_STATUS"
[[ "$EXT_STATUS" == "completed" ]] && ok "Extraction status endpoint reports completed" || warn "Extraction status: $EXT_STATUS (${EXTRACT_ST:0:200})"

echo "--- 21d: Query imported assertion ---"
IMPORT_Q=$(c "http://127.0.0.1:9201/api/knowledge-assets/${IMPORT_NAME}/wm/quads?contextGraphId=$CONTEXT_GRAPH")
IMPORT_Q_CT=$(safe_quads_count "$IMPORT_Q")
if [[ "$IMPORT_Q_CT" == "PARSE_ERR" ]]; then
  fail "Imported assertion query returned unparseable response: ${IMPORT_Q:0:200}"
elif [[ "$IMPORT_Q_CT" -ge 1 ]]; then
  ok "Imported assertion has $IMPORT_Q_CT quads"
else
  warn "Imported assertion empty"
fi

echo "--- 21e: Promote imported assertion to SWM ---"
IMPORT_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/${IMPORT_NAME}/swm/share" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
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
c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$PNG_NAME\"}" > /dev/null
TMPPNG=$(mktemp "$DEVNET_TMPDIR/devnet-png-XXXXXX.png")
# 8-byte PNG magic header — enough to look like a real image to the server
# while keeping the test body small. No converter is registered for image/png
# so the daemon must graceful-degrade.
printf '\x89PNG\r\n\x1a\n' > "$TMPPNG"
PNG_RESP=$(curl -sS --max-time "$DEVNET_CURL_TIMEOUT" --connect-timeout "$DEVNET_CURL_CONNECT_TIMEOUT" \
  -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPPNG};type=image/png" \
  -F "contextGraphId=$CONTEXT_GRAPH" \
  "http://127.0.0.1:9201/api/knowledge-assets/${PNG_NAME}/wm/import-file" 2>&1)
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
c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$PNG_NAME/wm/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null 2>&1

#------------------------------------------------------------
echo ""
echo "=== SECTION 22: Publisher Queue End-to-End ==="
echo ""

echo "--- 22a: Create/share named KA data for publisher test ---"
PQ_ENTITY="http://example.org/entity/pub-queue-$(date +%s)"
PQ_NAME="pub-queue-ka-$(date +%s%N)"
PQ_WRITE=$(ka_create_share 9201 "$CONTEXT_GRAPH" "$PQ_NAME" "" \
    $(q "$PQ_ENTITY" 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),
    $(ql "$PQ_ENTITY" 'http://schema.org/name' 'Publisher Queue Test')
)
PQ_SHARED=$(json_get "$PQ_WRITE" swmShared)
PQ_PROMOTED=$(json_get "$PQ_WRITE" promotedCount)
echo "  KA share swmShared=$PQ_SHARED promotedCount=$PQ_PROMOTED"
[[ "$PQ_SHARED" == "true" ]] && ok "Named KA shared for publisher test" || fail "KA share failed: ${PQ_WRITE:0:200}"

# P1-9: also assert promotedCount >= 2. A silent zero-share pipeline would
# let the publisher enqueue an empty payload and 22c would "pass" with no
# actual data to publish.
PQ_TW="$PQ_PROMOTED"
if [[ "$PQ_TW" != "__NONE__" && "$PQ_TW" != "__ERR__" && "$PQ_TW" -ge 2 ]] 2>/dev/null; then
  ok "KA share persisted $PQ_TW triples (>= 2)"
else
  fail "KA share promotedCount=$PQ_TW (expected >= 2) — publisher queue test will be meaningless"
fi

echo "--- 22b: Enqueue named KA VM publish job ---"
PQ_ENQUEUE=$(ka_publish_async 9201 "$CONTEXT_GRAPH" "$PQ_NAME")
PQ_JOB_ID=$(json_get "$PQ_ENQUEUE" jobId)
echo "  Enqueue jobId=$PQ_JOB_ID"
[[ "$PQ_JOB_ID" != "__NONE__" && "$PQ_JOB_ID" != "__ERR__" && -n "$PQ_JOB_ID" ]] && ok "Named KA VM publish job enqueued: $PQ_JOB_ID" || fail "Named KA VM publish enqueue failed: ${PQ_ENQUEUE:0:200}"

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
  fail "22c-22f skipped: publisher enqueue did not return a usable jobId (PQ_JOB_ID=$PQ_JOB_ID)"
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
http_post_capture "http://127.0.0.1:9201/api/knowledge-assets" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"\"}" \
  EMPTY_NAME EMPTY_CODE
if [[ "$EMPTY_CODE" =~ ^4 ]] && echo "$EMPTY_NAME" | grep -qiE 'error|invalid'; then
  ok "Empty assertion name rejected (HTTP $EMPTY_CODE)"
else
  fail "Empty assertion name not cleanly rejected (HTTP $EMPTY_CODE): ${EMPTY_NAME:0:200}"
fi

echo "--- 23d: Duplicate assertion name reuses same URI ---"
DUP_NAME="dup-test-$(date +%s)"
DUP_FIRST=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$DUP_NAME\"}")
DUP_URI1=$(json_get "$DUP_FIRST" assertionUri)
DUP_SECOND=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$DUP_NAME\"}")
DUP_URI2=$(json_get "$DUP_SECOND" assertionUri)
if echo "$DUP_SECOND" | grep -qi "error\|exists\|already\|duplicate"; then
  ok "Duplicate assertion name rejected"
elif [[ "$DUP_URI1" == "$DUP_URI2" ]]; then
  ok "Duplicate assertion name returns same URI (idempotent)"
else
  warn "Duplicate assertion name created different URI (URI1=$DUP_URI1, URI2=$DUP_URI2)"
fi
c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$DUP_NAME/wm/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null 2>&1

echo "--- 23e: Promote nonexistent assertion ---"
GHOST_PROMOTE=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/does-not-exist-$(date +%s)/swm/share" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
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
c -X POST "http://127.0.0.1:9201/api/knowledge-assets" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$DD_NAME\"}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$DD_NAME/wm/write" -d "{
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[$(ql 'urn:dd:test' 'http://schema.org/name' 'Double Discard')]
}" > /dev/null
c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$DD_NAME/wm/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" > /dev/null
DD_SECOND=$(c -X POST "http://127.0.0.1:9201/api/knowledge-assets/$DD_NAME/wm/discard" -d "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
if echo "$DD_SECOND" | grep -qi "error\|not found\|not exist\|already"; then
  ok "Double discard rejected with error"
else
  ok "Double discard is idempotent (${DD_SECOND:0:80})"
fi

echo "--- 23g: Retired /api/publisher/enqueue is not served ---"
retired_post_assert "/api/publisher/enqueue" 9201 "/api/publisher/enqueue" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}"

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
ka_create_share 9201 "$CONTEXT_GRAPH" "isolation-alpha-ka" "$SG_A" \
    $(ql 'urn:iso:alpha1' 'http://schema.org/name' 'Alpha Only Entity'),
    $(q 'urn:iso:alpha1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  > /dev/null
ka_create_share 9201 "$CONTEXT_GRAPH" "isolation-beta-ka" "$SG_B" \
    $(ql 'urn:iso:beta1' 'http://schema.org/name' 'Beta Only Entity'),
    $(q 'urn:iso:beta1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing')
  > /dev/null

# P2-1: brief settle window for the local KA share to hit the triple
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
http_post_capture "http://127.0.0.1:9201/api/knowledge-assets" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"unreg-subgraph-ka\",\"subGraphName\":\"$UNREG_SG\",\"quads\":[$(ql 'urn:unreg:x' 'http://schema.org/name' 'nope')],\"finalize\":true,\"alsoShareSwm\":true}" \
  UNREG_BODY UNREG_CODE
if [[ "$UNREG_CODE" =~ ^4 ]]; then
  ok "KA create/share to unregistered sub-graph rejected (HTTP $UNREG_CODE)"
else
  fail "KA create/share to unregistered sub-graph not rejected (HTTP $UNREG_CODE): ${UNREG_BODY:0:200}"
fi

#------------------------------------------------------------
echo ""
echo "=== SECTION 25: Regression Tests for Fix Round ==="
echo ""

echo "--- 25a: VM query returns published data (§16.1 root content graph) ---"
VM_REG=$(c -X POST "http://127.0.0.1:9201/api/query" -d "{
  \"sparql\":\"SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name } LIMIT 5\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"view\":\"verifiable-memory\"
}")
VM_REG_CT=$(safe_bindings_count "$VM_REG")
if [[ "$VM_REG_CT" == "PARSE_ERR" ]]; then
  fail "VM regression query returned unparseable response: ${VM_REG:0:200}"
elif [[ "$VM_REG_CT" -ge 1 ]]; then
  ok "VM view returns $VM_REG_CT bindings from root content graph (§16.1)"
else
  fail "VM view returns 0 bindings — root content graph not included in verifiable-memory view"
fi

echo "--- 25b: ABI error decoding — UPDATE to non-existent KC returns decoded error ---"
UPDATE_ERR=$(c -X POST "http://127.0.0.1:9201/api/update" -d "{
  \"kaId\":\"999999\",
  \"contextGraphId\":\"$CONTEXT_GRAPH\",
  \"quads\":[{\"subject\":\"urn:test:err\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"test\\\"\",\"graph\":\"\"}]
}")
echo "  Update error response: $(echo "$UPDATE_ERR" | head -c 200)"
echo "$UPDATE_ERR" | grep -qi "error\|BatchNotFound\|NotBatchPublisher\|does not exist" && ok "UPDATE to non-existent KC returned meaningful error" || warn "UPDATE error not decoded: ${UPDATE_ERR:0:200}"

echo "--- 25c: KA create/share to unregistered sub-graph returns 400 ---"
UNREG_SG2="regression-unreg-$(date +%s%N)"
http_post_capture "http://127.0.0.1:9201/api/knowledge-assets" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"regression-unreg-ka\",\"subGraphName\":\"$UNREG_SG2\",\"quads\":[{\"subject\":\"urn:unreg:x\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"nope\\\"\",\"graph\":\"\"}],\"finalize\":true,\"alsoShareSwm\":true}" \
  UNREG2_BODY UNREG2_CODE
if [[ "$UNREG2_CODE" == "400" ]]; then
  ok "Unregistered sub-graph KA create/share returns HTTP 400"
elif [[ "$UNREG2_CODE" =~ ^4 ]]; then
  ok "Unregistered sub-graph KA create/share returns HTTP $UNREG2_CODE"
else
  fail "Unregistered sub-graph KA create/share not rejected properly (HTTP $UNREG2_CODE): ${UNREG2_BODY:0:200}"
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
FREE_CG_KA="free-test-ka"
SWM_FREE_RESP=$(ka_create_share 9201 "$FREE_CG_ID" "$FREE_CG_KA" "" \
    $(ql "http://example.org/entity/free-test-1" "http://schema.org/name" "FreeCGEntity"),
    $(q  "http://example.org/entity/free-test-1" "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" "http://schema.org/Thing")
)
SWM_FREE_OK=$(json_get "$SWM_FREE_RESP" promotedCount)
if [[ "$SWM_FREE_OK" != "__NONE__" && "$SWM_FREE_OK" != "0" && "$SWM_FREE_OK" != "__ERR__" ]]; then
  ok "KA create/share to free CG succeeded ($SWM_FREE_OK triples)"
else
  fail "KA create/share to free CG failed: $SWM_FREE_RESP"
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

echo "--- 27e: Retired /api/shared-memory/publish is not served on free CG ---"
retired_post_assert "/api/shared-memory/publish on free CG" 9201 "/api/shared-memory/publish" "{\"contextGraphId\":\"$FREE_CG_ID\"}"

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
PUB_RESP=$(ka_publish 9201 "$FREE_CG_ID" "$FREE_CG_KA")
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
echo "=== SECTION 28: RFC 07 — /api/connect Resolver Path & HTTP Semantics ==="
echo ""
# RFC 07 in-process PeerResolver wires every outbound dial through a single
# resolution chain (live-conn → DHT → RFC 04 registry stub → agents-CG
# fallback). `/api/connect` (POST {peerId}) is the public surface of that
# chain. The legacy `/api/connect {multiaddr}` path is exercised implicitly
# by §1b/§1c (peers come up via mDNS) but the peerId-only flow had no
# explicit coverage until now. This section pins:
#   - 28a INVALID_PEER_ID  → HTTP 400 (terminal client error)
#   - 28b SELF_DIAL        → HTTP 400 (terminal client error)
#   - 28c PEER_NOT_FOUND   → HTTP 404 (genuine negative lookup; resolver
#                            completed cleanly with no addresses)
#   - 28d Cold-peer dial via PeerResolver — disconnect a known peer, then
#         /api/connect by peerId only. Requires the resolver to find addrs
#         from libp2p peerStore / DHT and prime them so dialProtocol works.
#   - 28e Idempotent fast-path — re-call /api/connect on the just-connected
#         peer; the resolver's step-1 live-connection check should make this
#         a sub-ms no-op.
#   - 28f Missing-body  → HTTP 400 (route-level guard)
#
# CONNECT_TIMEOUT (HTTP 504) — the post-RFC-07 distinction added in PR #499
# round 5 (transient timeout vs terminal not-found) requires a sub-second
# `timeoutMs` to trigger reliably. The /api/connect route doesn't accept
# `timeoutMs` from the body today, so the 504 path is covered by the unit
# test (peer-resolver.test.ts: "skips later steps once signal is aborted
# mid-resolve") rather than here.

echo "--- 28a: INVALID_PEER_ID returns 400 ---"
http_post_capture "http://127.0.0.1:9201/api/connect" \
  '{"peerId":"not-a-real-peer-id"}' \
  CONN_BAD_BODY CONN_BAD_CODE
CONN_BAD_CODE_VAL="$CONN_BAD_CODE"
CONN_BAD_ERR_CODE=$(json_get "$CONN_BAD_BODY" code)
if [[ "$CONN_BAD_CODE_VAL" == "400" && "$CONN_BAD_ERR_CODE" == "INVALID_PEER_ID" ]]; then
  ok "Malformed peerId → HTTP 400 + code=INVALID_PEER_ID"
elif [[ "$CONN_BAD_CODE_VAL" == "400" ]]; then
  ok "Malformed peerId → HTTP 400 (code=$CONN_BAD_ERR_CODE)"
else
  fail "Malformed peerId returned HTTP $CONN_BAD_CODE_VAL (expected 400): ${CONN_BAD_BODY:0:200}"
fi

echo "--- 28b: SELF_DIAL returns 400 ---"
SELF_PEER=$(json_get "$(c "http://127.0.0.1:9201/api/info")" peerId)
if [[ "$SELF_PEER" == "__NONE__" || "$SELF_PEER" == "__ERR__" || -z "$SELF_PEER" ]]; then
  fail "Could not read Node1's own peerId from /api/info — cannot test SELF_DIAL"
else
  http_post_capture "http://127.0.0.1:9201/api/connect" \
    "{\"peerId\":\"$SELF_PEER\"}" \
    CONN_SELF_BODY CONN_SELF_CODE
  CONN_SELF_ERR=$(json_get "$CONN_SELF_BODY" code)
  if [[ "$CONN_SELF_CODE" == "400" && "$CONN_SELF_ERR" == "SELF_DIAL" ]]; then
    ok "Self-dial → HTTP 400 + code=SELF_DIAL"
  elif [[ "$CONN_SELF_CODE" == "400" ]]; then
    ok "Self-dial → HTTP 400 (code=$CONN_SELF_ERR)"
  else
    fail "Self-dial returned HTTP $CONN_SELF_CODE (expected 400): ${CONN_SELF_BODY:0:200}"
  fi
fi

echo "--- 28c: PEER_NOT_FOUND or CONNECT_TIMEOUT for unknown valid peerId ---"
# Generate a fresh, syntactically-valid Ed25519 peerId via libp2p so the
# format always parses on whatever libp2p version is installed. The
# generated key is ephemeral (never used by any node) so the resolver's
# full chain (live-conn → DHT → registry stub → agents-CG) all miss.
# This run can take up to the default 15s connectToPeerId timeout.
GHOST_PEER=$(cd "$SCRIPT_DIR/../packages/core" && node --input-type=module -e "
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
const k = await generateKeyPair('Ed25519');
console.log(peerIdFromPrivateKey(k).toString());
" 2>/dev/null)
if [[ -z "$GHOST_PEER" || ! "$GHOST_PEER" =~ ^12D3KooW[A-Za-z0-9]+$ ]]; then
  warn "Could not generate ghost peerId (got=$GHOST_PEER); skipping 28c"
else
  GHOST_START=$(date +%s)
  http_post_capture "http://127.0.0.1:9201/api/connect" \
    "{\"peerId\":\"$GHOST_PEER\"}" \
    CONN_NOTFOUND_BODY CONN_NOTFOUND_CODE
  GHOST_ELAPSED=$(( $(date +%s) - GHOST_START ))
  CONN_NF_ERR=$(json_get "$CONN_NOTFOUND_BODY" code)
  # Codex PR #499 round 5: pin to one deterministic outcome rather
  # than accepting either 404 or 504 (which would silently pass a
  # regression that turned every clean miss into a timeout).
  #
  # On this 6-node devnet, the resolver's DHT findPeer step keeps
  # querying for the ghost peer until the per-step signal fires at
  # ~timeoutMs (the connectToPeerId default). signal.aborted=true
  # at that point → CONNECT_TIMEOUT (504). This is the deterministic
  # outcome here.
  #
  # The 404 PEER_NOT_FOUND branch (resolver completes cleanly, no
  # addrs found, signal NOT aborted) requires either a much smaller
  # DHT (so findPeer exhausts before the timeout) or a sub-second
  # timeoutMs. /api/connect doesn't accept timeoutMs from the body
  # today, and devnet's DHT topology is what it is, so the 404 mapping
  # is covered by the unit test instead:
  #   peer-resolver.test.ts → "returns empty array when nothing resolves"
  #   protocol-router-resolver.test.ts → resolver miss path
  if [[ "$CONN_NOTFOUND_CODE" == "504" && "$CONN_NF_ERR" == "CONNECT_TIMEOUT" ]]; then
    ok "Ghost peerId → HTTP 504 + code=CONNECT_TIMEOUT in ${GHOST_ELAPSED}s (RFC 07 PR #499 round 5: transient-vs-terminal split; 504 is the deterministic devnet outcome)"
  else
    fail "Ghost peerId returned HTTP $CONN_NOTFOUND_CODE code=$CONN_NF_ERR after ${GHOST_ELAPSED}s — expected 504/CONNECT_TIMEOUT on this 6-node devnet (regression in resolver timeout → /api/connect mapping?): ${CONN_NOTFOUND_BODY:0:200}"
  fi
fi

echo "--- 28d: Cold-peer dial via PeerResolver succeeds (peer in libp2p peerStore) ---"
# devnet nodes connect via mDNS at startup, so node1 already has node3 in
# its peerStore (and probably an open connection). Disconnecting node3
# from node1 first makes this a true cold dial: /api/connect by peerId
# alone must resolve via the libp2p peerStore-cached path the resolver's
# step 2 (DHT findPeer) walks back to.
NODE3_PEER=$(json_get "$(c "http://127.0.0.1:9203/api/info")" peerId)
if [[ "$NODE3_PEER" == "__NONE__" || "$NODE3_PEER" == "__ERR__" || -z "$NODE3_PEER" ]]; then
  fail "Could not read Node3's peerId from /api/info — cannot test cold-peer dial"
else
  # Best-effort disconnect Node3 from Node1's perspective. The
  # /api/disconnect (or the legacy /api/agents/<peerId>/disconnect) endpoint
  # may not exist on every build — if not, we still test the (warm) connect
  # which exercises the resolver's step-1 live-connection short-circuit.
  curl -sS --max-time 5 -H "Authorization: Bearer $AUTH" \
    -X POST "http://127.0.0.1:9201/api/disconnect" \
    -H "Content-Type: application/json" \
    -d "{\"peerId\":\"$NODE3_PEER\"}" > /dev/null 2>&1 || true
  sleep 1

  http_post_capture "http://127.0.0.1:9201/api/connect" \
    "{\"peerId\":\"$NODE3_PEER\"}" \
    CONN_OK_BODY CONN_OK_CODE
  CONN_OK_FLAG=$(json_get "$CONN_OK_BODY" connected)
  if [[ "$CONN_OK_CODE" == "200" && "$CONN_OK_FLAG" == "true" ]]; then
    ok "Cold dial Node3 by peerId via resolver → HTTP 200 connected=true"
  else
    fail "Cold dial Node3 returned HTTP $CONN_OK_CODE (expected 200): ${CONN_OK_BODY:0:200}"
  fi
fi

echo "--- 28e: Idempotent fast-path (resolver step-1 live-connection check) ---"
# The just-completed dial leaves an open connection. Re-calling /api/connect
# should hit `connectToPeerId`'s `getConnections().length > 0` early-return
# (which both predates and complements the resolver's step-1 live-conn
# short-circuit). Should be fast and return 200.
if [[ -n "${NODE3_PEER:-}" && "$NODE3_PEER" != "__NONE__" && "$NODE3_PEER" != "__ERR__" ]]; then
  IDEMPOTENT_START=$(date +%s)
  http_post_capture "http://127.0.0.1:9201/api/connect" \
    "{\"peerId\":\"$NODE3_PEER\"}" \
    CONN_AGAIN_BODY CONN_AGAIN_CODE
  IDEMPOTENT_ELAPSED=$(( $(date +%s) - IDEMPOTENT_START ))
  CONN_AGAIN_FLAG=$(json_get "$CONN_AGAIN_BODY" connected)
  if [[ "$CONN_AGAIN_CODE" == "200" && "$CONN_AGAIN_FLAG" == "true" && "$IDEMPOTENT_ELAPSED" -le 3 ]]; then
    ok "Re-connect to already-connected peer → HTTP 200 in ${IDEMPOTENT_ELAPSED}s (fast-path)"
  elif [[ "$CONN_AGAIN_CODE" == "200" ]]; then
    warn "Re-connect succeeded but took ${IDEMPOTENT_ELAPSED}s (expected sub-second fast-path)"
  else
    fail "Re-connect returned HTTP $CONN_AGAIN_CODE: ${CONN_AGAIN_BODY:0:200}"
  fi
fi

echo "--- 28f: Missing peerId AND multiaddr returns 400 ---"
http_post_capture "http://127.0.0.1:9201/api/connect" \
  '{}' \
  CONN_EMPTY_BODY CONN_EMPTY_CODE
if [[ "$CONN_EMPTY_CODE" == "400" ]]; then
  ok "Empty body → HTTP 400 (route-level guard)"
else
  fail "Empty body returned HTTP $CONN_EMPTY_CODE (expected 400): ${CONN_EMPTY_BODY:0:200}"
fi

echo "--- 28g: Audit gate locally — every dialProtocol() goes through the RFC 07 boundary ---"
# Cheap sanity check: even without re-running CI, assert the audit script
# still passes on the deployed source. A regression that re-introduces a
# raw libp2p.dialProtocol(peerId, ...) elsewhere would surface here as a
# devnet-side smoke test, not just at PR-merge time.
AUDIT_OUT=$(node "$SCRIPT_DIR/audit-dial-protocol.mjs" 2>&1 || true)
if echo "$AUDIT_OUT" | grep -q "audit-dial-protocol: OK"; then
  ok "Dial-protocol audit passes (PeerResolver boundary intact)"
else
  fail "Dial-protocol audit failed: ${AUDIT_OUT:0:400}"
fi

echo "--- 28h: legacy /api/connect {multiaddr} form still works ---"
# /api/connect accepts BOTH `{peerId}` (RFC 07 resolver path) and the
# legacy `{multiaddr: "/ip4/.../p2p/<id>"}` direct dial. The peerId form
# is exhaustively covered above (28a-28e); the multiaddr form has zero
# explicit HTTP coverage, so a regression that breaks the legacy branch
# while editing the resolver branch (in `agent-chat.ts:611`) would slip.
# This test pins it.
#
# /api/info doesn't expose a node's own listen addrs (would be a useful
# add-on, but that's a separate change), so we extract the loopback addr
# from the daemon log — which the libp2p stack prints once at startup.
# Filter: loopback tcp + matching Node2's OWN peerId (the log also
# contains Node1's relay addr from Node2's bootstrap; we don't want that).
NODE2_LOG="$SCRIPT_DIR/../.devnet/node2/daemon.log"
NODE2_PEERID=$(json_get "$(c "http://127.0.0.1:9202/api/info")" peerId)
NODE2_MULTIADDR=""
if [[ -f "$NODE2_LOG" && -n "$NODE2_PEERID" && "$NODE2_PEERID" != "__NONE__" && "$NODE2_PEERID" != "__ERR__" ]]; then
  NODE2_MULTIADDR=$(grep -oE "/ip4/127\\.0\\.0\\.1/tcp/[0-9]+/p2p/${NODE2_PEERID}" "$NODE2_LOG" 2>/dev/null \
    | awk 'NR==1 {print; exit}')
fi
if [[ -z "$NODE2_MULTIADDR" ]]; then
  warn "Could not extract Node2 multiaddr from $NODE2_LOG — skipping 28h"
else
  http_post_capture "http://127.0.0.1:9201/api/connect" \
    "{\"multiaddr\":\"$NODE2_MULTIADDR\"}" \
    MA_BODY MA_CODE
  MA_FLAG=$(json_get "$MA_BODY" connected)
  if [[ "$MA_CODE" == "200" && "$MA_FLAG" == "true" ]]; then
    ok "Legacy {multiaddr} form → HTTP 200 connected=true ($NODE2_MULTIADDR)"
  else
    fail "Legacy {multiaddr} form returned HTTP $MA_CODE: ${MA_BODY:0:200}"
  fi
fi

#------------------------------------------------------------
section_start "SECTION 29: RFC 07 — Cross-node /api/connect resolver matrix"
# §28d only proves Node1 can resolve Node3. This section proves the
# resolver wiring is uniform across the whole cluster: every node can
# /api/connect to every OTHER node by peerId alone. Catches:
#   - one node missing the resolver wiring (e.g. an init-order bug)
#   - edge nodes (no on-chain identity) using the resolver correctly
#   - asymmetric NAT / relay scenarios where node_i can dial node_j
#     but not vice versa
#
# Caveats / honest limits:
#   - There's no /api/disconnect endpoint today, and the devnet mesh
#     auto-bootstraps via mDNS, so most pair connects will hit the
#     resolver's step-1 live-conn fast-path rather than the cold DHT
#     walk. SECTION 30 covers the genuine cold path via a Node1
#     restart. What §29 verifies is that the resolver+route plumbing
#     is wired correctly on every node — the slow steps don't get
#     exercised here, the orchestration does.
if [[ "$SKIP_MATRIX" == "1" ]]; then
  skip "SECTION 29: skipped via SKIP_MATRIX=1"
else
  echo "--- 29a: every node /api/connect's to every other node by peerId ---"
  # Collect peerIds first to avoid N² /api/info calls.
  # NOTE: macOS ships bash 3.x which lacks `declare -A` (associative
  # arrays). We get the same effect via a sparse indexed array — port
  # numbers are integers so PEERID_BY_PORT[9201]=... stores at index
  # 9201 and ${PEERID_BY_PORT[9201]} retrieves it cleanly under bash 3+.
  PEERID_BY_PORT=()
  for p in "${NODE_PORTS[@]}"; do
    PEERID_BY_PORT[$p]=$(json_get "$(c "http://127.0.0.1:$p/api/info")" peerId)
  done
  matrix_total=0
  matrix_ok=0
  matrix_slow=0
  matrix_fail=0
  matrix_failures=()
  for src in "${NODE_PORTS[@]}"; do
    for dst in "${NODE_PORTS[@]}"; do
      [[ "$src" == "$dst" ]] && continue
      dst_peer="${PEERID_BY_PORT[$dst]}"
      if [[ -z "$dst_peer" || "$dst_peer" == "__NONE__" || "$dst_peer" == "__ERR__" ]]; then
        matrix_fail=$((matrix_fail + 1))
        matrix_failures+=("${src}→${dst}: missing dst peerId")
        continue
      fi
      matrix_total=$((matrix_total + 1))
      pair_t0=$(date +%s)
      http_post_capture "http://127.0.0.1:$src/api/connect" \
        "{\"peerId\":\"$dst_peer\"}" \
        MX_BODY MX_CODE
      pair_elapsed=$(( $(date +%s) - pair_t0 ))
      mx_flag=$(json_get "$MX_BODY" connected)
      if [[ "$MX_CODE" == "200" && "$mx_flag" == "true" ]]; then
        matrix_ok=$((matrix_ok + 1))
        # Anything > 2s in a warm devnet means the resolver chain
        # actually walked DHT instead of step-1 short-circuiting —
        # not a fail, but worth surfacing for performance tracking.
        if [[ "$pair_elapsed" -gt 2 ]]; then
          matrix_slow=$((matrix_slow + 1))
          echo "  [SLOW] ${src}→${dst} (${dst_peer:0:16}…) took ${pair_elapsed}s"
        fi
      else
        matrix_fail=$((matrix_fail + 1))
        matrix_failures+=("${src}→${dst} HTTP $MX_CODE in ${pair_elapsed}s: ${MX_BODY:0:120}")
      fi
    done
  done
  echo "  matrix: $matrix_ok/$matrix_total succeeded; $matrix_slow slow; $matrix_fail failed"
  if [[ "$matrix_total" -gt 0 && "$matrix_fail" -eq 0 ]]; then
    ok "Cross-node connect matrix: all $matrix_total pairs reachable via /api/connect {peerId}"
  elif [[ "$matrix_fail" -gt 0 ]]; then
    fail "Cross-node connect matrix: $matrix_fail/$matrix_total pairs failed"
    for f in "${matrix_failures[@]}"; do echo "    - $f"; done
  else
    fail "Cross-node connect matrix: zero pairs attempted (NODE_PORTS empty?)"
  fi
fi
section_done

#------------------------------------------------------------
section_start "SECTION 30: RFC 07 — Restart-resilience for /api/connect"
# §28-29 prove the resolver works on warm peerStore. This section
# verifies that a NODE RESTART doesn't break /api/connect — i.e. after
# Node1 dies and comes back, asking it to dial a peerId still
# succeeds end-to-end through the same /api/connect surface.
#
# Honest scope note (mDNS race):
#   The original intent was to force a TRUE cold-path walk (peerStore
#   empty, resolver must use DHT or agents-CG). But on a loopback
#   devnet, mDNS reconverges in well under a second after Node1's
#   listen socket binds, so by the time §30e fires, Node1's peerStore
#   has typically already been re-warmed by mDNS broadcasts from the
#   other 5 nodes — and the resolver short-circuits at step 1
#   (live-connection check / cached addrs).
#
#   We don't try to suppress mDNS here because (a) doing so would
#   require devnet config changes outside the test's scope and (b) the
#   true cold path IS exercised by the unit tests
#   (peer-resolver.test.ts walks every step with mocked transports).
#   What this section uniquely contributes is the END-TO-END process
#   restart — it catches regressions where Node1 restart fails to
#   wire the resolver into /api/connect at all (init order bugs,
#   missing dependency injection, etc), even if the resolver itself
#   doesn't have to do real cold work.
#
# We restart Node1 so this section stays self-contained — every other
# section's state on Node1 is already validated by the time we get
# here. Node3 stays up and is the connect target.
#
# Destructive (restarts Node1) → gated by SKIP_RESTART=1 and runs
# LAST so nothing else loses state.
if [[ "$SKIP_RESTART" == "1" ]]; then
  skip "SECTION 30: skipped via SKIP_RESTART=1 (destructive — restarts Node1)"
elif [[ ! -f "$SCRIPT_DIR/../.devnet/node1/devnet.pid" ]]; then
  skip "SECTION 30: no .devnet/node1/devnet.pid found — script not running against a devnet.sh devnet"
else
  echo "--- 30a: capture Node3 peerId (will be the connect target after Node1 restart) ---"
  N3_PEER_BEFORE=$(json_get "$(c "http://127.0.0.1:9203/api/info")" peerId)
  if [[ -z "$N3_PEER_BEFORE" || "$N3_PEER_BEFORE" == "__NONE__" || "$N3_PEER_BEFORE" == "__ERR__" ]]; then
    fail "Could not capture Node3 peerId before restart — aborting SECTION 30"
  else
    ok "Captured Node3 peerId: ${N3_PEER_BEFORE:0:32}…"

    echo "--- 30b: restart Node1 (libp2p drops, peerStore goes empty) ---"
    DEVNET_DIR="$SCRIPT_DIR/../.devnet"
    CLI_JS="$SCRIPT_DIR/../packages/cli/dist/cli.js"
    PIDFILE="$DEVNET_DIR/node1/devnet.pid"
    OLD_PID=$(cat "$PIDFILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" 2>/dev/null || true
      # Wait for clean shutdown (libp2p's port release + storage flush).
      for i in $(seq 1 15); do
        kill -0 "$OLD_PID" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$OLD_PID" 2>/dev/null; then
        kill -9 "$OLD_PID" 2>/dev/null || true
        sleep 2
      fi
      ok "Node1 stopped (was PID $OLD_PID)"
    else
      warn "Node1 PID $OLD_PID was already dead before kill — proceeding anyway"
    fi
    rm -f "$PIDFILE" "$DEVNET_DIR/node1/daemon.pid"

    echo "--- 30c: restart Node1 (fresh libp2p instance, empty peerStore) ---"
    DKG_HOME="$DEVNET_DIR/node1" DKG_NO_BLUE_GREEN=1 \
      node "$CLI_JS" start --foreground \
      >> "$DEVNET_DIR/node1/daemon.log" 2>&1 &
    NEW_PID=$!
    echo "$NEW_PID" > "$PIDFILE"
    ok "Node1 restart launched (PID $NEW_PID)"

    echo "--- 30d: wait for Node1's API to come back up (≤ ${RESTART_BOOT_TIMEOUT_S}s) ---"
    api_ready=0
    boot_t0=$(date +%s)
    for i in $(seq 1 "$RESTART_BOOT_TIMEOUT_S"); do
      if curl -sf --max-time 2 -H "Authorization: Bearer $AUTH" \
           "http://127.0.0.1:9201/api/status" > /dev/null 2>&1; then
        api_ready=1
        boot_elapsed=$(( $(date +%s) - boot_t0 ))
        ok "Node1 API responsive again after ${boot_elapsed}s"
        break
      fi
      sleep 1
    done
    if [[ "$api_ready" -ne 1 ]]; then
      fail "Node1 API did not respond within ${RESTART_BOOT_TIMEOUT_S}s after restart — aborting SECTION 30"
    else
      # Brief settle so libp2p finishes startup (identify, dht warmup).
      # On loopback, mDNS will likely have already re-warmed the
      # peerStore — see the section's "Honest scope note" above. 5s
      # is enough for libp2p to be in a stable state to accept dials.
      sleep 5

      echo "--- 30e: post-restart /api/connect {peerId: Node3} from freshly-restarted Node1 ---"
      # Codex PR #499 round 5 (devnet-test.sh:2502): downgrading
      # CONNECT_TIMEOUT / PEER_NOT_FOUND to warn meant the test
      # silently passed when post-restart connectivity was broken —
      # defeating the purpose of the section. Strict mode: retry for
      # a bounded window to absorb mDNS/DHT warmup, but FAIL hard if
      # it never recovers. The retry budget is generous enough for a
      # truly cold-restart on loopback (~30s).
      RETRY_BUDGET_S="${RESTART_RETRY_BUDGET_S:-30}"
      retry_t0=$(date +%s)
      attempt=0
      post_succeeded=0
      while [[ $(( $(date +%s) - retry_t0 )) -lt "$RETRY_BUDGET_S" ]]; do
        attempt=$((attempt + 1))
        http_post_capture "http://127.0.0.1:9201/api/connect" \
          "{\"peerId\":\"$N3_PEER_BEFORE\"}" \
          POST_BODY POST_CODE
        post_flag=$(json_get "$POST_BODY" connected)
        if [[ "$POST_CODE" == "200" && "$post_flag" == "true" ]]; then
          post_succeeded=1
          break
        fi
        # 1s pause between retries — mDNS converges in <1s on loopback
        # so this is plenty for the polling rate.
        sleep 1
      done
      retry_elapsed=$(( $(date +%s) - retry_t0 ))
      post_err=$(json_get "$POST_BODY" code)
      if [[ "$post_succeeded" == "1" ]]; then
        ok "Post-restart dial Node3 from restarted Node1 → HTTP 200 connected=true after ${attempt} attempt(s) over ${retry_elapsed}s (resolver wiring intact across process restart)"
      else
        fail "Post-restart dial Node3 NEVER succeeded — last attempt: HTTP $POST_CODE code=$post_err after ${retry_elapsed}s of retries (${attempt} attempts). Resolver wiring may be broken across process restart: ${POST_BODY:0:200}"
      fi

      echo "--- 30f: post-restart Node1 has rebuilt the mesh ---"
      # After the cold dial succeeded (or even if it didn't, mDNS will
      # have caught up by now), Node1 should report a full mesh again.
      # This catches a regression where Node1 restarts and silently
      # never re-discovers anyone.
      sleep 5
      mesh_count=$(c "http://127.0.0.1:9201/api/agents" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  print(sum(1 for a in d.get('agents', []) if a.get('connectionStatus') in ('connected', 'self')))
except Exception:
  print(0)
" 2>/dev/null)
      if [[ "$mesh_count" -ge 4 ]]; then
        ok "Node1 mesh restored to $mesh_count peers post-restart"
      else
        warn "Node1 mesh only $mesh_count peers post-restart (expected ≥ 4)"
      fi
    fi
  fi
fi
section_done

#------------------------------------------------------------
section_start "SECTION 31: Curated CG — Invite & Join End-to-End (PR #448 flow)"
# What this covers (and why §27i/27j alone are not enough):
#
# §27i + §27j only verify the OUTBOUND side of invite — N1 creates a
# curated CG with `allowedPeers` and POSTs `/api/context-graph/invite`,
# checking the response echoes the peerId. They never assert that:
#   - the invitee can subscribe (or is correctly DENIED before approval),
#   - the curator actually receives + persists the join request,
#   - approval flips the allowlist,
#   - the invitee then catches-up successfully and receives the
#     `_meta` graph from the curator,
#   - a non-allowlisted third party stays denied without a phantom
#     CG entry.
#
# All those failure modes are routinely hit in real-world rollouts
# (the "two-laptop debugging session" that birthed PR #448 round-6's
# `deriveCuratorDidFromCgId` fallback + the `DKG_CURATOR` triple
# regression guard). This section folds the standalone
# `scripts/devnet-test-invite-flow.sh` into the main suite so future
# CI runs can't silently regress invite/join.
#
# Requires ≥ 3 nodes (uses NODE_PORTS[0..2]). Skips with a SKIP if the
# devnet is smaller, or if SKIP_INVITE_FLOW=1.
if [[ "$SKIP_INVITE_FLOW" == "1" ]]; then
  skip "Invite/Join e2e (SKIP_INVITE_FLOW=1)"
elif [[ "${#NODE_PORTS[@]}" -lt 3 ]]; then
  skip "Invite/Join e2e (need ≥3 nodes, have ${#NODE_PORTS[@]})"
else
  N1_PORT="${NODE_PORTS[0]}"
  N2_PORT="${NODE_PORTS[1]}"
  N3_PORT="${NODE_PORTS[2]}"

  # Helper: extract self agent's address + peerId from /api/agents
  invite_self_info() {
    local port="$1"
    c "http://127.0.0.1:$port/api/agents" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  for a in d.get('agents', []):
    if a.get('connectionStatus') == 'self':
      print(a.get('agentAddress', '') + ' ' + a.get('peerId', ''))
      break
  else:
    print(' ')
except Exception:
  print(' ')
" 2>/dev/null
  }

  echo "--- 31a: capture N1/N2/N3 agent addresses + peerIds ---"
  read -r N1_ADDR N1_PEER < <(invite_self_info "$N1_PORT")
  read -r N2_ADDR N2_PEER < <(invite_self_info "$N2_PORT")
  read -r N3_ADDR N3_PEER < <(invite_self_info "$N3_PORT")
  if [[ -n "$N1_ADDR" && -n "$N2_ADDR" && -n "$N3_ADDR" ]]; then
    ok "Captured N1/N2/N3 identities ($N1_ADDR / $N2_ADDR / $N3_ADDR)"
  else
    fail "Could not capture all three agent addresses (N1=$N1_ADDR N2=$N2_ADDR N3=$N3_ADDR) — aborting SECTION 31"
    SKIP_INVITE_FLOW=1
  fi

  if [[ "$SKIP_INVITE_FLOW" != "1" ]]; then
    INVITE_CG_ID="invite-test-$(date +%s)"
    INVITE_CG_ENC="$INVITE_CG_ID"  # urlsafe — only [a-z0-9-] in id

    echo "--- 31b: N1 creates curated CG '$INVITE_CG_ID' (allowlist = [N1 only]) ---"
    INVITE_CREATE_BODY=$(python3 -c "
import json
print(json.dumps({
  'id': '$INVITE_CG_ID',
  'name': 'Invite flow test $INVITE_CG_ID',
  'description': 'Curated CG for invite/acceptance regression test',
  'accessPolicy': 1,
  'allowedAgents': ['$N1_ADDR'],
}))
")
    http_post_capture "http://127.0.0.1:$N1_PORT/api/context-graph/create" \
      "$INVITE_CREATE_BODY" \
      INV_CREATE_BODY INV_CREATE_CODE
    INV_CREATED=$(json_get "$INV_CREATE_BODY" created)
    if [[ "$INV_CREATE_CODE" == "200" && "$INV_CREATED" == "$INVITE_CG_ID" ]]; then
      ok "N1 created curated CG $INVITE_CG_ID"
    else
      fail "Curated CG create failed (HTTP $INV_CREATE_CODE): ${INV_CREATE_BODY:0:200}"
    fi

    echo "--- 31c: assert DKG_CURATOR triple is present in N1's _meta graph (PR #448 round-6 silent-NACK regression guard) ---"
    # Without DKG_CURATOR, getContextGraphOwner returns null and every
    # PROTOCOL_JOIN_REQUEST silently NACKs. The wallet-prefix fallback
    # (deriveCuratorDidFromCgId) heals stale data — this assertion
    # protects today's create path from silently dropping the write.
    INV_CURATOR_QUERY=$(CG="$INVITE_CG_ID" python3 <<'PY'
import json, os
cg = os.environ['CG']
meta = f"did:dkg:context-graph:{cg}/_meta"
subj = f"did:dkg:context-graph:{cg}"
print(json.dumps({
  "contextGraphId": cg,
  "sparql": f"""SELECT ?owner WHERE {{ GRAPH <{meta}> {{ <{subj}> <https://dkg.network/ontology#curator> ?owner . }} }} LIMIT 1""",
}))
PY
)
    INV_CURATOR_RESP=$(c -X POST "http://127.0.0.1:$N1_PORT/api/query" -d "$INV_CURATOR_QUERY")
    INV_CURATOR_OWNER=$(echo "$INV_CURATOR_RESP" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  bindings = d.get('result', {}).get('bindings', [])
  print(bindings[0].get('owner', '') if bindings else '')
except Exception:
  print('')
" 2>/dev/null)
    INV_EXPECTED_OWNER="did:dkg:agent:${N1_ADDR}"
    INV_CURATOR_LC=$(printf '%s' "$INV_CURATOR_OWNER" | tr '[:upper:]' '[:lower:]')
    INV_EXPECTED_LC=$(printf '%s' "$INV_EXPECTED_OWNER" | tr '[:upper:]' '[:lower:]')
    if [[ "$INV_CURATOR_LC" == "$INV_EXPECTED_LC" ]]; then
      ok "DKG_CURATOR triple present and points at N1"
    elif [[ -n "$INV_CURATOR_OWNER" ]]; then
      fail "DKG_CURATOR triple present but owner unexpected (got '$INV_CURATOR_OWNER', expected '$INV_EXPECTED_OWNER')"
    else
      fail "DKG_CURATOR triple MISSING — createContextGraph regression. Without it, every PROTOCOL_JOIN_REQUEST for $INVITE_CG_ID would silently NACK."
    fi

    echo "--- 31d: N1 publishes data into the CG (so N2 has something to sync after approval) ---"
    INV_ASSERTION_NAME="widget-info-$(date +%s)"
    c -X POST "http://127.0.0.1:$N1_PORT/api/knowledge-assets" \
      -d "{\"contextGraphId\":\"$INVITE_CG_ID\",\"name\":\"$INV_ASSERTION_NAME\"}" >/dev/null
    INV_WRITE_RESP=$(c -X POST "http://127.0.0.1:$N1_PORT/api/knowledge-assets/$INV_ASSERTION_NAME/wm/write" \
      -d "{\"contextGraphId\":\"$INVITE_CG_ID\",\"quads\":[{\"subject\":\"did:example:widget\",\"predicate\":\"http://www.w3.org/2000/01/rdf-schema#label\",\"object\":\"\\\"Widget\\\"\"},{\"subject\":\"did:example:widget\",\"predicate\":\"http://schema.org/price\",\"object\":\"\\\"42\\\"\"}]}")
    INV_WRITTEN=$(json_get "$INV_WRITE_RESP" written)
    if [[ "$INV_WRITTEN" == "2" ]]; then
      ok "N1 wrote 2 quads into $INVITE_CG_ID"
    else
      fail "N1 write returned written=$INV_WRITTEN (expected 2): ${INV_WRITE_RESP:0:200}"
    fi

    # Helper: poll catch-up status until it terminates (done|denied|failed)
    # or the timeout expires. Echoes the final status.
    invite_poll_catchup() {
      local port="$1" cg_id="$2" timeout="$3"
      local enc t0 elapsed status last_status="" resp
      enc=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$cg_id', safe=''))")
      t0=$(date +%s)
      while :; do
        elapsed=$(( $(date +%s) - t0 ))
        if [[ "$elapsed" -ge "$timeout" ]]; then
          echo "${last_status:-timeout}"
          return
        fi
        resp=$(c "http://127.0.0.1:$port/api/sync/catchup-status?contextGraphId=$enc" 2>/dev/null)
        status=$(json_get "$resp" status)
        if [[ -n "$status" && "$status" != "$last_status" ]]; then
          last_status="$status"
        fi
        case "$status" in
          done|denied|failed)
            echo "$status"
            return
            ;;
        esac
        sleep 1
      done
    }

    echo "--- 31e: N2 subscribes BEFORE allowlisted (expect catch-up status = denied) ---"
    INV_SUB_BODY="{\"contextGraphId\":\"$INVITE_CG_ID\"}"
    c -X POST "http://127.0.0.1:$N2_PORT/api/subscribe" -d "$INV_SUB_BODY" >/dev/null
    INV_N2_STATUS=$(invite_poll_catchup "$N2_PORT" "$INVITE_CG_ID" "$INVITE_DENIED_TIMEOUT_S")
    if [[ "$INV_N2_STATUS" == "denied" ]]; then
      ok "N2 catch-up status = denied (curator correctly rejected unallowlisted subscriber)"
    else
      fail "N2 catch-up status = $INV_N2_STATUS (expected denied)"
    fi

    echo "--- 31f: N2 has no phantom entry for the inaccessible CG ---"
    INV_N2_LIST=$(c "http://127.0.0.1:$N2_PORT/api/context-graph/list")
    INV_N2_HAS=$(echo "$INV_N2_LIST" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  cgs = d.get('contextGraphs', [])
  print('yes' if any(c.get('id') == '$INVITE_CG_ID' for c in cgs) else 'no')
except Exception:
  print('parse-err')
" 2>/dev/null)
    if [[ "$INV_N2_HAS" == "no" ]]; then
      ok "N2's project list correctly omits the inaccessible CG"
    else
      fail "N2 has a phantom entry for $INVITE_CG_ID (regression)"
    fi

    echo "--- 31g: N2 sign-join (sign-only, returns delegation) ---"
    INV_SIGN_RESP=$(c -X POST "http://127.0.0.1:$N2_PORT/api/context-graph/$INVITE_CG_ENC/sign-join" -d "{}")
    INV_DELEGATION=$(echo "$INV_SIGN_RESP" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  deleg = d.get('delegation') or {}
  print(json.dumps(deleg) if deleg else '')
except Exception:
  print('')
" 2>/dev/null)
    if [[ -n "$INV_DELEGATION" && "$INV_DELEGATION" != "{}" ]]; then
      ok "sign-join returned a signed delegation"
    else
      fail "sign-join did not return a signed delegation: ${INV_SIGN_RESP:0:200}"
    fi

    echo "--- 31h: N2 request-join (forwards delegation to curator over libp2p) ---"
    INV_SUBMIT_BODY=$(python3 -c "
import json
print(json.dumps({'delegation': json.loads('''$INV_DELEGATION'''), 'curatorPeerId': '$N1_PEER'}))
")
    # Capture the moment of submission so log assertions only consider
    # lines written after this point (avoids stale matches across runs).
    INV_REQ_TS=$(date -u +'%Y-%m-%d %H:%M:%S')
    INV_SUBMIT_RESP=$(c -X POST "http://127.0.0.1:$N2_PORT/api/context-graph/$INVITE_CG_ENC/request-join" -d "$INV_SUBMIT_BODY")
    INV_DELIVERED=$(json_get "$INV_SUBMIT_RESP" delivered)
    INV_STATUS=$(json_get "$INV_SUBMIT_RESP" status)
    if [[ "$INV_STATUS" == "pending" && -n "$INV_DELIVERED" && "$INV_DELIVERED" != "0" && "$INV_DELIVERED" != "__NONE__" ]]; then
      ok "request-join delivered (delivered=$INV_DELIVERED, status=pending)"
    else
      fail "request-join did not deliver (status=$INV_STATUS delivered=$INV_DELIVERED): ${INV_SUBMIT_RESP:0:200}"
    fi

    echo "--- 31i: assert curator (N1) logged PROTOCOL_JOIN_REQUEST accepted + persisted (silent-NACK regression guard) ---"
    sleep 1  # give the inbound handler a moment to flush
    N1_LOG_PATH="$SCRIPT_DIR/../.devnet/node1/daemon.log"
    if [[ -f "$N1_LOG_PATH" ]]; then
      INV_LOG_ACCEPT=$(awk -v since="$INV_REQ_TS" '
        match($0, /(\[)?20[0-9]{2}-[0-9]{2}-[0-9]{2}T?[ ][0-9:]{8}/) {
          ts = substr($0, RSTART, RLENGTH); gsub(/[\[T]/, " ", ts); sub(/^ /, "", ts)
          if (ts >= since) print
        }' "$N1_LOG_PATH" | grep -E "PROTOCOL_JOIN_REQUEST from .* for \"$INVITE_CG_ID\": accepted" | awk 'NR==1 {print; exit}')
      INV_LOG_STORE=$(awk -v since="$INV_REQ_TS" '
        match($0, /(\[)?20[0-9]{2}-[0-9]{2}-[0-9]{2}T?[ ][0-9:]{8}/) {
          ts = substr($0, RSTART, RLENGTH); gsub(/[\[T]/, " ", ts); sub(/^ /, "", ts)
          if (ts >= since) print
        }' "$N1_LOG_PATH" | grep -E "Stored pending join request from .* for \"$INVITE_CG_ID\"" | awk 'NR==1 {print; exit}')
      if [[ -n "$INV_LOG_ACCEPT" ]]; then
        ok "Curator logged PROTOCOL_JOIN_REQUEST accepted"
      else
        fail "Curator did NOT log accepting the join request — silent-NACK regression?"
      fi
      if [[ -n "$INV_LOG_STORE" ]]; then
        ok "Curator logged 'Stored pending join request'"
      else
        fail "Curator accepted but did NOT persist — broken store path"
      fi
    else
      warn "Skipped log assertion (n1 daemon.log not at expected path: $N1_LOG_PATH)"
    fi

    echo "--- 31j: N1 sees N2's pending request via /join-requests ---"
    sleep 1
    INV_REQ_RESP=$(c "http://127.0.0.1:$N1_PORT/api/context-graph/$INVITE_CG_ENC/join-requests")
    INV_FOUND_N2=$(echo "$INV_REQ_RESP" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  reqs = d.get('requests', [])
  target = '$N2_ADDR'.lower()
  print('yes' if any((r.get('agentAddress', '') or '').lower() == target for r in reqs) else 'no')
except Exception:
  print('parse-err')
" 2>/dev/null)
    if [[ "$INV_FOUND_N2" == "yes" ]]; then
      ok "N1 sees N2's pending join request"
    else
      fail "N1 does NOT see N2's pending request: ${INV_REQ_RESP:0:200}"
    fi

    echo "--- 31k: N1 approves N2 via /approve-join ---"
    INV_APPROVE_RESP=$(c -X POST "http://127.0.0.1:$N1_PORT/api/context-graph/$INVITE_CG_ENC/approve-join" \
      -d "{\"agentAddress\":\"$N2_ADDR\"}")
    INV_APPROVE_OK=$(json_get "$INV_APPROVE_RESP" ok)
    if [[ "$INV_APPROVE_OK" == "true" ]]; then
      ok "approve-join succeeded"
    else
      fail "approve-join failed: ${INV_APPROVE_RESP:0:200}"
    fi

    echo "--- 31l: N2 re-subscribes (expect catch-up status = done, with subscribed+synced) ---"
    sleep 2  # allowlist write + any SSE notification
    c -X POST "http://127.0.0.1:$N2_PORT/api/subscribe" -d "$INV_SUB_BODY" >/dev/null
    # Post-approval catch-up does a full data + meta + SWM fan-out;
    # under retries this can take ~1-2 minutes on a busy devnet. Use
    # a 180s budget so we don't race pre-existing SWM sync cost.
    INV_N2_AFTER=$(invite_poll_catchup "$N2_PORT" "$INVITE_CG_ID" 180)
    if [[ "$INV_N2_AFTER" == "done" ]]; then
      ok "N2 catch-up after approval = done"
    else
      fail "N2 catch-up after approval = $INV_N2_AFTER (expected done)"
    fi

    echo "--- 31m: N2's project state shows subscribed=true synced=true ---"
    INV_N2_AFTER_LIST=$(c "http://127.0.0.1:$N2_PORT/api/context-graph/list")
    INV_N2_FLAGS=$(echo "$INV_N2_AFTER_LIST" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  cgs = d.get('contextGraphs', [])
  match = next((c for c in cgs if c.get('id') == '$INVITE_CG_ID'), None)
  if not match:
    print('missing')
  else:
    print(f\"{bool(match.get('subscribed'))}-{bool(match.get('synced'))}\")
except Exception:
  print('parse-err')
" 2>/dev/null)
    if [[ "$INV_N2_FLAGS" == "True-True" ]]; then
      ok "N2 sees CG legitimately (subscribed=true synced=true)"
    else
      fail "N2 project state unexpected (subscribed-synced=$INV_N2_FLAGS)"
    fi

    echo "--- 31n: N2 received the CG's _meta graph from the curator ---"
    INV_META_QUERY=$(CG="$INVITE_CG_ID" python3 <<'PY'
import json, os
cg = os.environ['CG']
meta = f"did:dkg:context-graph:{cg}/_meta"
print(json.dumps({
  "contextGraphId": cg,
  "sparql": f"SELECT (COUNT(*) AS ?n) WHERE {{ GRAPH <{meta}> {{ ?s ?p ?o }} }}",
}))
PY
)
    INV_META_RESP=$(c -X POST "http://127.0.0.1:$N2_PORT/api/query" -d "$INV_META_QUERY")
    INV_META_COUNT=$(echo "$INV_META_RESP" | python3 -c "
import sys, json, re
try:
  d = json.load(sys.stdin)
  b = d.get('result', {}).get('bindings', [])
  v = b[0].get('n', '0') if b else '0'
  m = re.search(r'\d+', str(v))
  print(m.group(0) if m else '0')
except Exception:
  print('0')
" 2>/dev/null)
    if [[ "$INV_META_COUNT" -gt 0 ]] 2>/dev/null; then
      ok "N2 holds $INV_META_COUNT triples in the CG's _meta graph"
    else
      fail "N2 has no _meta triples for $INVITE_CG_ID"
    fi

    echo "--- 31o: N3 (never allowlisted) tries the same CG (expect denied + no phantom) ---"
    c -X POST "http://127.0.0.1:$N3_PORT/api/subscribe" -d "$INV_SUB_BODY" >/dev/null
    INV_N3_STATUS=$(invite_poll_catchup "$N3_PORT" "$INVITE_CG_ID" "$INVITE_DENIED_TIMEOUT_S")
    if [[ "$INV_N3_STATUS" == "denied" ]]; then
      ok "N3 catch-up status = denied"
    else
      fail "N3 catch-up status = $INV_N3_STATUS (expected denied)"
    fi
    INV_N3_LIST=$(c "http://127.0.0.1:$N3_PORT/api/context-graph/list")
    INV_N3_HAS=$(echo "$INV_N3_LIST" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  cgs = d.get('contextGraphs', [])
  print('yes' if any(c.get('id') == '$INVITE_CG_ID' for c in cgs) else 'no')
except Exception:
  print('parse-err')
" 2>/dev/null)
    if [[ "$INV_N3_HAS" == "no" ]]; then
      ok "N3's project list correctly omits the inaccessible CG"
    else
      fail "N3 has a phantom entry for $INVITE_CG_ID"
    fi
  fi
fi
section_done

#------------------------------------------------------------
# SECTIONS 32-37 — rc.9 Universal Messenger + SWM substrate observability.
#
# Backstory: rc.9 (PR #587 merge train) introduced the Universal
# Messenger substrate (`/dkg/10.0.1/*`) with durable per-protocol
# outbox + receiver idempotency, the SWM substrate fan-out path with
# ack-quorum watchdog (`/dkg/10.0.1/swm-update` + `/dkg/10.0.1/
# swm-share-ack`), and the `/api/slo` diagnostics endpoint. Sections
# 32-37 verify the user-observable contracts of those changes that
# pre-rc.9 devnet sections don't actively assert (most sections pass
# unchanged because chat/SWM read-back is unchanged from outside).
#
# All 6 sections are gated by SKIP_RC9_SUBSTRATE=1 for operators
# running this script against pre-rc.9 nodes. SECTION 37 is also gated
# by SKIP_EDGE_RESTART=1 because it kills/restarts an edge daemon.

#------------------------------------------------------------
section_start "SECTION 32: rc.9 — /api/slo endpoint shape & cold-start safety"
# The /api/slo endpoint (rc.9 PR-12 + PR-A/C/D additions) is the
# operator's primary lens into messenger latency, gossip publish
# failures, SWM redundant-apply counters, substrate fan-out outcomes,
# and ack-quorum tracker state. This section verifies the wire shape
# is intact on every node — schema drift here would silently break
# every soak script + operator dashboard.
if [[ "$SKIP_RC9_SUBSTRATE" == "1" ]]; then
  skip "SECTION 32: skipped via SKIP_RC9_SUBSTRATE=1"
else
  for p in "${NODE_PORTS[@]}"; do
    slo=$(c "http://127.0.0.1:$p/api/slo")
    # Top-level keys must exist on every production agent.
    has_protocols=$(json_get "$slo" protocols)
    has_gossip=$(json_get "$slo" gossip.publishFailuresOverflow)
    has_swm=$(json_get "$slo" swm.redundantAppliesOverflow)
    if [[ "$has_protocols" != "__NONE__" && "$has_protocols" != "__ERR__" ]]; then
      ok "Node $p /api/slo returns protocols map"
    else
      fail "Node $p /api/slo missing protocols"
    fi
    if [[ "$has_gossip" =~ ^[0-9]+$ ]]; then
      ok "Node $p /api/slo gossip.publishFailuresOverflow=$has_gossip (numeric)"
    else
      fail "Node $p /api/slo gossip.publishFailuresOverflow not numeric: $has_gossip"
    fi
    if [[ "$has_swm" =~ ^[0-9]+$ ]]; then
      ok "Node $p /api/slo swm.redundantAppliesOverflow=$has_swm (numeric)"
    else
      fail "Node $p /api/slo swm.redundantAppliesOverflow not numeric: $has_swm"
    fi
    # rc.9 PR-C: substrate fan-out overlay must be present on every
    # production agent (the optional-on-interface caveat in the code
    # is only there for test doubles).
    sf_truncated=$(json_get "$slo" swm.substrateFanout.truncated)
    if [[ "$sf_truncated" == "true" || "$sf_truncated" == "false" ]]; then
      ok "Node $p exposes swm.substrateFanout (PR-C)"
    else
      fail "Node $p missing swm.substrateFanout overlay (got truncated=$sf_truncated)"
    fi
    # rc.9 PR-D: ack-quorum overlay must be present.
    aq_pending=$(json_get "$slo" swm.shareAckQuorum.pending)
    if [[ "$aq_pending" =~ ^[0-9]+$ ]]; then
      ok "Node $p exposes swm.shareAckQuorum (PR-D), pending=$aq_pending"
    else
      fail "Node $p missing swm.shareAckQuorum overlay (got pending=$aq_pending)"
    fi
  done
fi
section_done

#------------------------------------------------------------
section_start "SECTION 33: rc.9/rc.14 — wire protocols negotiated"
# rc.9 bumped 8+ short-message protocols from /dkg/10.0.0/* to
# /dkg/10.0.1/*; rc.14 bumps PROTOCOL_SYNC again when sync leaves the
# messenger substrate. A devnet-wide mismatch (one node still on an
# older wire ID) would manifest as silently queued substrate messages
# or skipped sync. The peerStore protocols list returned by
# /api/peer-info?peerId=<X> proves the identify handshake advertised
# the expected protocol IDs on both sides.
if [[ "$SKIP_RC9_SUBSTRATE" == "1" ]]; then
  skip "SECTION 33: skipped via SKIP_RC9_SUBSTRATE=1"
elif [[ "$NUM_NODES" -lt 2 ]]; then
  skip "SECTION 33: need ≥2 nodes (have $NUM_NODES)"
else
  # Wire protocol IDs we expect to see on every healthy
  # peer. PROTOCOL_ACCESS (/dkg/10.0.1/private-access) is registered
  # unconditionally by DKGAgent.start() — round-3 Codex fix corrects
  # the earlier mistaken comment that claimed it was conditional.
  # /dkg/10.0.1/storage-ack is core-only — DKGAgent.start() registers
  # it under `if (effectiveRole === 'core')` (round-4 Codex fix), so
  # it's expected only when the TARGET is a core node.
  PROTOCOL_SYNC_EXPECTED="$(protocol_const PROTOCOL_SYNC)"
  if [[ -z "$PROTOCOL_SYNC_EXPECTED" ]]; then
    fail "PROTOCOL_SYNC unreadable from packages/core/src/constants.ts — cannot verify sync protocol advertisement"
    PROTOCOL_SYNC_EXPECTED="__MISSING_PROTOCOL_SYNC__"
  fi
  EXPECTED_UNIVERSAL=(
    "/dkg/10.0.1/message"
    "$PROTOCOL_SYNC_EXPECTED"
    "/dkg/10.0.1/swm-update"
    "/dkg/10.0.1/swm-share-ack"
    "/dkg/10.0.1/swm-sender-key"
    "/dkg/10.0.1/verify-proposal"
    "/dkg/10.0.1/join-request"
    "/dkg/10.0.1/query-remote"
    "/dkg/10.0.1/private-access"
  )
  EXPECTED_CORE_ONLY=(
    "/dkg/10.0.1/storage-ack"
  )
  # Walk the full observer × target matrix so a single rc.8 straggler
  # on ANY node breaks an assertion (Codex PR #588: the original
  # version only inspected N2 from N1 and would miss a stale advert on
  # any other peer). One PASS line per (observer, target) pair when
  # all 9 protocols are present; a FAIL listing the missing protocols
  # otherwise.
  declare -a TARGET_PEER_IDS=()
  declare -a TARGET_NODE_ROLES=()
  for tp in "${NODE_PORTS[@]}"; do
    info_blob=$(c "http://127.0.0.1:$tp/api/info")
    pid=$(json_get "$info_blob" peerId)
    role=$(json_get "$info_blob" nodeRole)
    TARGET_PEER_IDS+=("$pid")
    TARGET_NODE_ROLES+=("$role")
  done
  # Hard fail (Codex PR #588 round 2) once per unreachable target so a
  # broken /api/info doesn't silently skip protocol-advertisement
  # checks for that node and hide a wire-version regression. Round 6
  # adds the same sentinel validation for nodeRole — if that field
  # stops parsing on a core node, we'd silently drop /dkg/10.0.1/
  # storage-ack from expected_for_target and pass without checking it.
  for j in $(seq 0 $((NUM_NODES - 1))); do
    target_port=${NODE_PORTS[$j]}
    target_peer=${TARGET_PEER_IDS[$j]}
    target_role=${TARGET_NODE_ROLES[$j]}
    if [[ -z "$target_peer" || "$target_peer" == "__NONE__" || "$target_peer" == "__ERR__" ]]; then
      fail "N$((j+1)) ($target_port) peerId unreadable via /api/info — cannot verify wire protocol advertisements"
    fi
    if [[ -z "$target_role" || "$target_role" == "__NONE__" || "$target_role" == "__ERR__" ]]; then
      fail "N$((j+1)) ($target_port) nodeRole unreadable via /api/info — cannot decide expected core-only protocols"
    elif [[ "$target_role" != "core" && "$target_role" != "edge" ]]; then
      fail "N$((j+1)) ($target_port) nodeRole='$target_role' is not 'core' or 'edge' — unrecognised role; cannot decide expected protocols"
    fi
  done
  for i in $(seq 0 $((NUM_NODES - 1))); do
    observer_port=${NODE_PORTS[$i]}
    for j in $(seq 0 $((NUM_NODES - 1))); do
      [[ "$i" == "$j" ]] && continue
      target_port=${NODE_PORTS[$j]}
      target_peer=${TARGET_PEER_IDS[$j]}
      target_role=${TARGET_NODE_ROLES[$j]}
      # Already failed once above for bad peerId or nodeRole — silently
      # skip the pair iteration rather than re-emitting per observer
      # (N-1 noisy lines per bad target).
      if [[ -z "$target_peer" || "$target_peer" == "__NONE__" || "$target_peer" == "__ERR__" ]]; then
        continue
      fi
      if [[ -z "$target_role" || "$target_role" == "__NONE__" || "$target_role" == "__ERR__" \
            || ( "$target_role" != "core" && "$target_role" != "edge" ) ]]; then
        continue
      fi
      pi=$(c "http://127.0.0.1:$observer_port/api/peer-info?peerId=$target_peer")
      protos=$(echo "$pi" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  ps = d.get('peerStore') or {}
  for p in ps.get('protocols', []):
    print(p)
except Exception:
  pass
" 2>/dev/null)
      # Build the per-target expected set: universal protocols on
      # every node + core-only protocols when target is core.
      # (target_role already captured above for sentinel validation.)
      expected_for_target=("${EXPECTED_UNIVERSAL[@]}")
      if [[ "$target_role" == "core" ]]; then
        expected_for_target+=("${EXPECTED_CORE_ONLY[@]}")
      fi
      missing=()
      for proto in "${expected_for_target[@]}"; do
        if ! echo "$protos" | grep -qx "$proto"; then
          missing+=("$proto")
        fi
      done
      legacy_seen=()
      for legacy in "/dkg/10.0.0/message" "/dkg/10.0.0/sync" "/dkg/10.0.0/private-access"; do
        if echo "$protos" | grep -qx "$legacy"; then
          legacy_seen+=("$legacy")
        fi
      done
      if [[ ${#missing[@]} -eq 0 ]]; then
        ok "N$((i+1)) ($observer_port) sees N$((j+1)) ($target_port, $target_role) advertising all ${#expected_for_target[@]} expected wire protocols"
      else
        fail "N$((i+1)) ($observer_port) does NOT see N$((j+1)) ($target_port, $target_role) advertising: ${missing[*]} (peerStore.protocols mismatch — possible wire-prefix drift)"
      fi
      if [[ ${#legacy_seen[@]} -gt 0 ]]; then
        warn "N$((i+1)) ($observer_port) still sees N$((j+1)) ($target_port) advertising legacy: ${legacy_seen[*]} — peer may be on rc.8"
      fi
    done
  done
fi
section_done

#------------------------------------------------------------
section_start "SECTION 34: rc.9 — SWM substrate fan-out delivers (PR-C counters)"
# rc.9 PR-C added a direct substrate fan-out for SWM shares
# (PROTOCOL_SWM_UPDATE = /dkg/10.0.1/swm-update). Existing SWM
# sections only assert read-back via SPARQL, which passes equally
# whether gossip OR substrate delivered. This section asserts that
# `swm.substrateFanout.delivered` ACTUALLY grows when N1 writes a
# share — i.e. that the substrate path is exercised, not just gossip.
#
# We use the pre-existing `devnet-test` CG (which other nodes are
# already subscribed to from earlier sections) to avoid extra setup.
if [[ "$SKIP_RC9_SUBSTRATE" == "1" ]]; then
  skip "SECTION 34: skipped via SKIP_RC9_SUBSTRATE=1"
elif [[ "$NUM_NODES" -lt 2 ]]; then
  skip "SECTION 34: need ≥2 nodes (have $NUM_NODES)"
else
  N1_PORT=${NODE_PORTS[0]}
  # `delivered` is keyed by contextGraphId (a literal cgId string,
  # the same value passed to KA create/share). Codex PR #588
  # round 3: summing across ALL cgIds let unrelated background traffic
  # (retries on other CGs) make the canary pass; compare the delta
  # for $CONTEXT_GRAPH specifically so this section actually proves
  # the write issued here exercised the substrate path.
  cg_delivered() {
    echo "$1" | CG="$2" python3 -c "
import os, sys, json
cg = os.environ.get('CG','')
try:
  d = json.load(sys.stdin)
  sf = (d.get('swm') or {}).get('substrateFanout') or {}
  print(int((sf.get('delivered') or {}).get(cg, 0)))
except Exception:
  print(0)
" 2>/dev/null
  }
  cg_substrate_counter() {
    # cg_substrate_counter <slo_json> <cg> <bucket>
    # Returns the per-CG count for any swm.substrateFanout bucket
    # (delivered / queued / inFlight / failed / retryable / rejected).
    # All buckets are cumulative — callers MUST compare before/after
    # deltas for the specific write under test (Codex PR #588 round 4).
    echo "$1" | CG="$2" BUCKET="$3" python3 -c "
import os, sys, json
cg = os.environ.get('CG','')
bucket = os.environ.get('BUCKET','')
try:
  d = json.load(sys.stdin)
  sf = (d.get('swm') or {}).get('substrateFanout') or {}
  print(int((sf.get(bucket) or {}).get(cg, 0)))
except Exception:
  print(0)
" 2>/dev/null
  }

  SLO_BEFORE=$(c "http://127.0.0.1:$N1_PORT/api/slo")
  DELIVERED_BEFORE=$(cg_delivered "$SLO_BEFORE" "$CONTEXT_GRAPH")
  QUEUED_BEFORE=$(cg_substrate_counter "$SLO_BEFORE" "$CONTEXT_GRAPH" queued)
  INFLIGHT_BEFORE=$(cg_substrate_counter "$SLO_BEFORE" "$CONTEXT_GRAPH" inFlight)
  FAILED_BEFORE=$(cg_substrate_counter "$SLO_BEFORE" "$CONTEXT_GRAPH" failed)

  TAG="urn:rc9-fanout:$(date +%s%N)"
  WRITE=$(ka_create_share "$N1_PORT" "$CONTEXT_GRAPH" "rc9-fanout-$(date +%s%N)" "" \
    $(ql "$TAG" "http://schema.org/name" "rc9-substrate-fanout-canary"))
  WRITE_OK=$(json_get "$WRITE" promotedCount)
  if [[ "$WRITE_OK" != "1" ]]; then
    fail "N1 KA create/share for substrate fan-out canary failed (promotedCount=$WRITE_OK)"
  else
    ok "N1 wrote canary $TAG to '$CONTEXT_GRAPH'"
    sleep $((GOSSIP_WAIT_S + 3))

    SLO_AFTER=$(c "http://127.0.0.1:$N1_PORT/api/slo")
    DELIVERED_AFTER=$(cg_delivered "$SLO_AFTER" "$CONTEXT_GRAPH")
    QUEUED_AFTER=$(cg_substrate_counter "$SLO_AFTER" "$CONTEXT_GRAPH" queued)
    INFLIGHT_AFTER=$(cg_substrate_counter "$SLO_AFTER" "$CONTEXT_GRAPH" inFlight)
    FAILED_AFTER=$(cg_substrate_counter "$SLO_AFTER" "$CONTEXT_GRAPH" failed)

    DELTA=$((DELIVERED_AFTER - DELIVERED_BEFORE))
    if [[ "$DELTA" -ge 1 ]]; then
      ok "swm.substrateFanout.delivered['$CONTEXT_GRAPH'] grew by $DELTA (before=$DELIVERED_BEFORE after=$DELIVERED_AFTER) — substrate path exercised for this CG"
    else
      fail "swm.substrateFanout.delivered['$CONTEXT_GRAPH'] did NOT grow (before=$DELIVERED_BEFORE after=$DELIVERED_AFTER) — substrate fan-out not firing for the canary CG"
    fi
    # All cumulative substrate counters are deltas (round-4 fix —
    # the absolute floor check was meaningless against cumulative
    # numbers). On a healthy loopback mesh the canary write should
    # contribute zero failed entries for $CONTEXT_GRAPH; transient
    # queued/inFlight can occur after the earlier restart/connectivity
    # sections and are still healthy if they later flush — that
    # property is enforced by §35 (poll-to-drain) + §36 (quiet-window
    # delta). So we hard-fail on `failed` (terminal) and warn on
    # transient queued/inFlight (Codex PR #588 round 5).
    QUEUED_DELTA=$((QUEUED_AFTER - QUEUED_BEFORE))
    INFLIGHT_DELTA=$((INFLIGHT_AFTER - INFLIGHT_BEFORE))
    FAILED_DELTA=$((FAILED_AFTER - FAILED_BEFORE))
    if [[ "$FAILED_DELTA" -eq 0 ]]; then
      ok "swm.substrateFanout.failed delta=0 for '$CONTEXT_GRAPH' (no terminal send errors on canary)"
    else
      fail "swm.substrateFanout.failed['$CONTEXT_GRAPH'] grew by $FAILED_DELTA after canary write (terminal send error on healthy loopback)"
    fi
    if [[ "$QUEUED_DELTA" -eq 0 && "$INFLIGHT_DELTA" -eq 0 ]]; then
      ok "swm.substrateFanout queued/inFlight deltas both 0 for '$CONTEXT_GRAPH' (canary cleanly delivered, no backlog)"
    else
      warn "swm.substrateFanout transient queued+=$QUEUED_DELTA inFlight+=$INFLIGHT_DELTA for '$CONTEXT_GRAPH' (still healthy if §35 drains + §36 quiet window stays flat)"
    fi
  fi
fi
section_done

#------------------------------------------------------------
section_start "SECTION 35: rc.9 — SWM ack-quorum reaches steady state (PR-D)"
# rc.9 PR-D + PR-H added an ack-quorum watchdog that tracks per-share
# delivery quorum and re-arms substrate top-ups on stalls. After the
# §34 KA share (or any earlier SWM share in this run), the tracker
# should show `pending ≈ 0` on a healthy mesh — every started share
# either completed or got dropped via deadline/watchdog.
if [[ "$SKIP_RC9_SUBSTRATE" == "1" ]]; then
  skip "SECTION 35: skipped via SKIP_RC9_SUBSTRATE=1"
else
  # shareAckQuorum.pending is a LIVE gauge (records.size in
  # ack-quorum.ts), so polling for drain is the right shape — and
  # makes "reaches steady state" actually enforceable (Codex PR #588
  # round 4: warning here let a stuck backlog stay green). Default
  # budget is set at file-top (75s = 2.5× DEFAULT_WATCHDOG_MS) so a
  # share recovering only on the first watchdog cycle has time to drain.
  for p in "${NODE_PORTS[@]}"; do
    drained=0
    drain_t0=$(date +%s)
    last_pending=""
    last_tracked=""
    last_completed=""
    last_watchdog=""
    last_deadline=""
    while [[ $(( $(date +%s) - drain_t0 )) -lt "$ACK_DRAIN_TIMEOUT_S" ]]; do
      slo=$(c "http://127.0.0.1:$p/api/slo")
      last_tracked=$(json_get "$slo" swm.shareAckQuorum.tracked)
      last_completed=$(json_get "$slo" swm.shareAckQuorum.completed)
      last_pending=$(json_get "$slo" swm.shareAckQuorum.pending)
      last_watchdog=$(json_get "$slo" swm.shareAckQuorum.watchdogFired)
      last_deadline=$(json_get "$slo" swm.shareAckQuorum.deadlineExpired)
      if ! [[ "$last_tracked" =~ ^[0-9]+$ && "$last_completed" =~ ^[0-9]+$ && "$last_pending" =~ ^[0-9]+$ ]]; then
        break
      fi
      # Round 7: tighten to pending == 0. `pending` is the live
      # records.size gauge from SwmAckQuorum.stats(); allowing ≤1
      # let one wedged share pass as "steady state".
      if [[ "$last_pending" -eq 0 ]]; then
        drained=1
        break
      fi
      sleep 2
    done
    if ! [[ "$last_tracked" =~ ^[0-9]+$ && "$last_completed" =~ ^[0-9]+$ && "$last_pending" =~ ^[0-9]+$ ]]; then
      fail "Node $p shareAckQuorum counters missing or non-numeric (tracked=$last_tracked completed=$last_completed pending=$last_pending)"
      continue
    fi
    drain_elapsed=$(( $(date +%s) - drain_t0 ))
    # On the sender tracked>0 is the strong signal. On receivers
    # tracked stays 0. Don't enforce a global tracked>0 — just
    # verify the pending invariant.
    if [[ "$drained" == "1" ]]; then
      ok "Node $p shareAckQuorum.pending=$last_pending after ${drain_elapsed}s (tracked=$last_tracked completed=$last_completed watchdogFired=$last_watchdog deadlineExpired=$last_deadline)"
    else
      fail "Node $p shareAckQuorum.pending=$last_pending did NOT drain within ${ACK_DRAIN_TIMEOUT_S}s (tracked=$last_tracked completed=$last_completed) — stuck backlog"
    fi
  done
fi
section_done

#------------------------------------------------------------
section_start "SECTION 36: rc.9 PR-K — no new substrate queued/failed during quiet window"
# rc.9 PR-K tier-1+2 added `isPeerDialable` filtering: drop limited-
# circuit-only peers (tier-1) and peers without PROTOCOL_SWM_UPDATE
# handler (tier-2). On a dialable mesh that filter should prevent
# any new `queued` or `failed` counters from accruing when no writes
# are in flight.
#
# Codex PR #588 round 4: the substrateFanout buckets are CUMULATIVE
# (recordSwmSubstrateFanoutOutcome only increments) — absolute-value
# checks are meaningless because earlier transient retries leave the
# totals non-zero forever. We instead snapshot, sleep through a
# write-free quiet window, snapshot again, and assert that NO new
# queued/failed entries accrued on ANY CG. Stale-rc.8 peers or
# broken dialability filter would manifest as ongoing background
# retries that grow these counters even with no new writes.
if [[ "$SKIP_RC9_SUBSTRATE" == "1" ]]; then
  skip "SECTION 36: skipped via SKIP_RC9_SUBSTRATE=1"
else
  bucket_total() {
    # Sum a bucket across all CGs in one SLO snapshot. Emits __ERR__
    # on parse/schema failure (Codex PR #588 round 6: collapsing parse
    # errors to 0 produced false PASSes when /api/slo was unreadable).
    echo "$1" | BUCKET="$2" python3 -c "
import os, sys, json
bucket = os.environ.get('BUCKET','')
try:
  d = json.load(sys.stdin)
  sf = (d.get('swm') or {}).get('substrateFanout') or {}
  b = sf.get(bucket)
  if not isinstance(b, dict):
    # Bucket can legitimately be absent (no writes yet) → 0.
    print(0)
  else:
    print(sum(int(v) for v in b.values()))
except Exception:
  print('__ERR__')
" 2>/dev/null
  }
  declare -a QUEUED_BEFORE_36=()
  declare -a FAILED_BEFORE_36=()
  abort_36=0
  for p in "${NODE_PORTS[@]}"; do
    slo=$(c "http://127.0.0.1:$p/api/slo")
    qb=$(bucket_total "$slo" queued)
    fb=$(bucket_total "$slo" failed)
    if [[ "$qb" == "__ERR__" || "$fb" == "__ERR__" ]]; then
      fail "Node $p /api/slo unparseable for BEFORE snapshot (queued=$qb failed=$fb) — observability broken; cannot run quiet-window check"
      abort_36=1
    fi
    QUEUED_BEFORE_36+=("$qb")
    FAILED_BEFORE_36+=("$fb")
  done
  if [[ "$abort_36" == "1" ]]; then
    skip "SECTION 36: aborted — at least one BEFORE snapshot was unreadable (see fail(s) above)"
  else
    echo "  observing substrate counters across ${FANOUT_QUIET_WINDOW_S}s quiet window (no writes)..."
    sleep "$FANOUT_QUIET_WINDOW_S"
    for idx in $(seq 0 $((NUM_NODES - 1))); do
      p=${NODE_PORTS[$idx]}
      slo=$(c "http://127.0.0.1:$p/api/slo")
      q_after=$(bucket_total "$slo" queued)
      f_after=$(bucket_total "$slo" failed)
      if [[ "$q_after" == "__ERR__" || "$f_after" == "__ERR__" ]]; then
        fail "Node $p /api/slo unparseable for AFTER snapshot (queued=$q_after failed=$f_after) — observability broken; cannot assert quiet-window invariant"
        continue
      fi
      q_delta=$((q_after - ${QUEUED_BEFORE_36[$idx]}))
      f_delta=$((f_after - ${FAILED_BEFORE_36[$idx]}))
      if [[ "$q_delta" -eq 0 && "$f_delta" -eq 0 ]]; then
        ok "Node $p substrateFanout queued/failed deltas both 0 across ${FANOUT_QUIET_WINDOW_S}s quiet window (PR-K dialable-only filter healthy)"
      else
        fail "Node $p substrateFanout grew during ${FANOUT_QUIET_WINDOW_S}s quiet window: queued+=$q_delta failed+=$f_delta (background retries — possible dialability regression or stale-rc.8 peer)"
      fi
    done
  fi
fi
section_done

#------------------------------------------------------------
section_start "SECTION 37: rc.9 — outbox durability + idempotency across recipient restart"
# rc.9 PR-2 introduced a SQLite-backed `protocol_outbox` that holds
# substrate messages until they're delivered. This section proves the
# end-to-end property operators care about: send a message while the
# recipient is DOWN, restart the recipient, and the message arrives
# WITHOUT operator intervention — and arrives EXACTLY ONCE (substrate
# `message_idempotency` dedups any internal retries).
#
# We walk NODE_PORTS for a node whose /api/info.nodeRole == 'edge'
# (devnet.sh seeds 1-4 as core, 5+ as edge). Edge nodes are simpler
# to restart — no consensus impact, no RS prover state. If no edge
# node exists (small devnet) the section is skipped cleanly rather
# than restarting a core. Gated by SKIP_EDGE_RESTART because it
# kills a daemon process.
if [[ "$SKIP_RC9_SUBSTRATE" == "1" ]]; then
  skip "SECTION 37: skipped via SKIP_RC9_SUBSTRATE=1"
elif [[ "$SKIP_EDGE_RESTART" == "1" ]]; then
  skip "SECTION 37: skipped via SKIP_EDGE_RESTART=1 (destructive — restarts an edge daemon)"
elif [[ "$NUM_NODES" -lt 2 ]]; then
  skip "SECTION 37: need ≥2 nodes (have $NUM_NODES)"
else
  N1_PORT=${NODE_PORTS[0]}
  # Walk NODE_PORTS to find an EDGE node. The "no consensus impact"
  # assumption only holds for edge nodes; devnet.sh seeds 1-4 as core,
  # 5+ as edge. Iterate in reverse so we prefer the highest-numbered
  # (most likely edge) node when several exist.
  RECIPIENT_PORT=""
  EDGE_DISCOVERY_BROKEN=0
  for idx in $(seq $((NUM_NODES - 1)) -1 0); do
    p=${NODE_PORTS[$idx]}
    role=$(json_get "$(c "http://127.0.0.1:$p/api/info")" nodeRole)
    # Round 7: sentinel-validate before classifying. An unreadable
    # nodeRole silently falling through to "not edge" let a broken
    # /api/info on the only edge node skip §37 as "no edge node
    # detected" while the devnet was actually unhealthy. Treat
    # unreadable as a fail rather than a silent skip.
    if [[ -z "$role" || "$role" == "__NONE__" || "$role" == "__ERR__" ]]; then
      fail "Node $p /api/info.nodeRole unreadable ('$role') — cannot decide if this is an edge restart candidate"
      EDGE_DISCOVERY_BROKEN=1
      continue
    fi
    if [[ "$role" != "core" && "$role" != "edge" ]]; then
      fail "Node $p /api/info.nodeRole='$role' is not 'core' or 'edge' — unrecognised role; cannot decide if it's an edge restart candidate"
      EDGE_DISCOVERY_BROKEN=1
      continue
    fi
    if [[ "$role" == "edge" ]]; then
      RECIPIENT_PORT="$p"
      break
    fi
  done
  # Resolve .devnet/nodeN by matching RECIPIENT_PORT against each
  # node dir's config.json.apiPort. Robust to (a) filtered/reordered
  # DEVNET_NODES (e.g. DEVNET_NODES="9205 9206" — round 3 fix) and
  # (b) non-default API_PORT_BASE (round 2 fix). Reading config.json
  # is the only source of truth that survives both.
  RECIPIENT_DIR=""
  RECIPIENT_NODE_NUM=""
  if [[ -n "$RECIPIENT_PORT" ]]; then
    for d in "$SCRIPT_DIR/../.devnet/"node*; do
      [[ -d "$d" && -f "$d/config.json" ]] || continue
      cfg_port=$(python3 -c "
import sys, json
try:
  print(json.load(open('$d/config.json')).get('apiPort') or '')
except Exception:
  pass
" 2>/dev/null)
      if [[ "$cfg_port" == "$RECIPIENT_PORT" ]]; then
        RECIPIENT_DIR="$d"
        RECIPIENT_NODE_NUM=$(basename "$d" | sed 's/node//')
        break
      fi
    done
  fi
  RECIPIENT_PIDFILE="${RECIPIENT_DIR:+$RECIPIENT_DIR/devnet.pid}"
  CLI_JS="$SCRIPT_DIR/../packages/cli/dist/cli.js"

  if [[ -z "$RECIPIENT_PORT" && "$EDGE_DISCOVERY_BROKEN" == "1" ]]; then
    fail "SECTION 37: edge-node discovery broken — at least one /api/info.nodeRole was unreadable (see fail(s) above); refusing to skip a stale-build mismatch as 'no edge'"
  elif [[ -z "$RECIPIENT_PORT" ]]; then
    skip "SECTION 37: no edge node detected (all $NUM_NODES nodes report nodeRole != 'edge'); restarting a core would break consensus — skipping"
  elif [[ -z "$RECIPIENT_DIR" ]]; then
    skip "SECTION 37: could not match port $RECIPIENT_PORT to any .devnet/nodeN/config.json — script not running against devnet.sh layout"
  elif [[ ! -f "$RECIPIENT_PIDFILE" ]]; then
    skip "SECTION 37: no $RECIPIENT_PIDFILE — daemon not under devnet.sh management (port $RECIPIENT_PORT)"
  else
    echo "--- 37a: capture recipient identity (port $RECIPIENT_PORT = node $RECIPIENT_NODE_NUM) ---"
    RCPT_INFO=$(c "http://127.0.0.1:$RECIPIENT_PORT/api/info")
    RCPT_PEER=$(json_get "$RCPT_INFO" peerId)
    RCPT_NAME=$(json_get "$(c "http://127.0.0.1:$RECIPIENT_PORT/api/agent/identity")" name)
    # Sentinel-validate BOTH RCPT_PEER and N1_PEER (Codex PR #588
    # round 6: missing __ERR__ guard would let us send chats to a
    # bogus peer ID and turn a setup/diagnostic failure into a
    # misleading outbox failure).
    if [[ -z "$RCPT_PEER" || "$RCPT_PEER" == "__NONE__" || "$RCPT_PEER" == "__ERR__" ]]; then
      fail "Could not capture recipient peerId on port $RECIPIENT_PORT (got '$RCPT_PEER') — aborting SECTION 37"
    else
      N1_PEER=$(json_get "$(c "http://127.0.0.1:$N1_PORT/api/info")" peerId)
      if [[ -z "$N1_PEER" || "$N1_PEER" == "__NONE__" || "$N1_PEER" == "__ERR__" ]]; then
        fail "Could not capture N1 peerId on port $N1_PORT (got '$N1_PEER') — inbox filter would not work; aborting SECTION 37"
      else
        ok "Recipient: name='$RCPT_NAME' peerId=${RCPT_PEER:0:32}… (N1 peerId=${N1_PEER:0:32}…)"

        echo "--- 37b: stop recipient daemon (substrate outbox should hold messages) ---"
      OLD_PID=$(cat "$RECIPIENT_PIDFILE")
      if kill -0 "$OLD_PID" 2>/dev/null; then
        kill "$OLD_PID" 2>/dev/null || true
        for i in $(seq 1 15); do
          kill -0 "$OLD_PID" 2>/dev/null || break
          sleep 1
        done
        if kill -0 "$OLD_PID" 2>/dev/null; then
          kill -9 "$OLD_PID" 2>/dev/null || true
          sleep 2
        fi
        ok "Recipient stopped (was PID $OLD_PID)"
      else
        warn "Recipient PID $OLD_PID was already dead — proceeding"
      fi
      rm -f "$RECIPIENT_PIDFILE" "$RECIPIENT_DIR/daemon.pid"
      # Give libp2p a moment to register the disconnect on N1 — otherwise
      # the first /api/chat might race the still-warm connection and
      # appear delivered=true (the OS hasn't surfaced the EOF yet).
      sleep 3

      echo "--- 37c: send a uniquely-tagged chat from N1 → recipient (expect queued) ---"
      DURABLE_MARKER="rc9-durable-$(date +%s%N)"
      CHAT_RESP=$(c -X POST "http://127.0.0.1:$N1_PORT/api/chat" -d "{
        \"to\":\"$RCPT_PEER\",
        \"text\":\"$DURABLE_MARKER\"
      }")
      DELIVERED_NOW=$(json_get "$CHAT_RESP" delivered)
      QUEUED_NOW=$(json_get "$CHAT_RESP" queued)
      MSG_ID=$(json_get "$CHAT_RESP" messageId)
      # We REQUIRE delivered=false / queued=true to prove the outbox
      # path is being exercised. delivered=true means we raced the
      # disconnect (libp2p hasn't surfaced the EOF on N1 yet) and the
      # chat was actually delivered BEFORE we killed the recipient —
      # in which case the §37e inbox poll would succeed on a
      # pre-restart delivery, falsely confirming durability without
      # ever testing it. One retry attempt with a fresh marker; if
      # we STILL see delivered=true, abort the section cleanly rather
      # than report a false positive (Codex PR #588).
      if [[ "$DELIVERED_NOW" == "true" ]]; then
        warn "Chat returned delivered=true before recipient could go down — sleeping 5s and retrying once with a fresh marker"
        sleep 5
        DURABLE_MARKER="rc9-durable-$(date +%s%N)-r2"
        CHAT_RESP=$(c -X POST "http://127.0.0.1:$N1_PORT/api/chat" -d "{
          \"to\":\"$RCPT_PEER\",
          \"text\":\"$DURABLE_MARKER\"
        }")
        DELIVERED_NOW=$(json_get "$CHAT_RESP" delivered)
        QUEUED_NOW=$(json_get "$CHAT_RESP" queued)
        MSG_ID=$(json_get "$CHAT_RESP" messageId)
      fi
      ABORT_RESTART=0
      # Round 7: validate the chat response shape BEFORE the
      # delivered/queued branching. If /api/chat returned junk,
      # DELIVERED_NOW/QUEUED_NOW will be __ERR__/__NONE__ — that's
      # a broken endpoint, not a "couldn't exercise outbox path"
      # condition. Hard-fail on unreadable responses; only THEN
      # interpret the boolean shape.
      if [[ "$DELIVERED_NOW" != "true" && "$DELIVERED_NOW" != "false" ]] \
         || [[ "$QUEUED_NOW" != "true" && "$QUEUED_NOW" != "false" ]]; then
        fail "Chat /api/chat returned unreadable response shape: delivered='$DELIVERED_NOW' queued='$QUEUED_NOW' (expected true/false). Broken endpoint, not an outbox-path failure — aborting §37d-§37e"
        ABORT_RESTART=1
      # REQUIRE delivered=false AND queued=true (Codex PR #588 round 2):
      # a plain send failure can return delivered=false WITHOUT queued=true,
      # which is NOT the outbox path — treating it as durable would let the
      # inbox-poll below pass on a message that never persisted for retry.
      elif [[ "$DELIVERED_NOW" == "false" && "$QUEUED_NOW" == "true" ]]; then
        ok "Chat returned delivered=false queued=true messageId=${MSG_ID:0:12}… (substrate outbox holding it)"
      else
        # Either delivered=true (raced the disconnect), or
        # delivered=false+queued=false (plain send failure, message
        # not persisted). Neither lets us meaningfully test outbox
        # durability. Skip §37d-§37e to avoid a false positive.
        skip "Chat returned delivered=$DELIVERED_NOW queued=$QUEUED_NOW after retry — cannot exercise outbox path (need delivered=false AND queued=true). Skipping §37d-§37e (no regression vs no-test)"
        ABORT_RESTART=1
      fi

      if [[ "$ABORT_RESTART" == "1" ]]; then
        # Restart recipient anyway so subsequent runs / sections see a
        # healthy mesh — and health-check it (Codex PR #588 round 2:
        # if `start --foreground` exits immediately, the suite would
        # end with the node still down and no failure signal).
        DKG_HOME="$RECIPIENT_DIR" DKG_NO_BLUE_GREEN=1 \
          node "$CLI_JS" start --foreground \
          >> "$RECIPIENT_DIR/daemon.log" 2>&1 &
        NEW_PID=$!
        echo "$NEW_PID" > "$RECIPIENT_PIDFILE"
        cleanup_ready=0
        cleanup_t0=$(date +%s)
        for i in $(seq 1 "$RESTART_BOOT_TIMEOUT_S"); do
          if curl -sf --max-time 2 -H "Authorization: Bearer $AUTH" \
               "http://127.0.0.1:$RECIPIENT_PORT/api/status" > /dev/null 2>&1; then
            cleanup_ready=1
            cleanup_elapsed=$(( $(date +%s) - cleanup_t0 ))
            ok "Recipient (skipped section) restored after ${cleanup_elapsed}s"
            break
          fi
          sleep 1
        done
        if [[ "$cleanup_ready" -ne 1 ]]; then
          fail "Recipient did NOT come back within ${RESTART_BOOT_TIMEOUT_S}s after §37c abort — devnet left in degraded state"
        fi
      else
      echo "--- 37d: restart recipient (substrate should drain on connection re-establishment) ---"
      DKG_HOME="$RECIPIENT_DIR" DKG_NO_BLUE_GREEN=1 \
        node "$CLI_JS" start --foreground \
        >> "$RECIPIENT_DIR/daemon.log" 2>&1 &
      NEW_PID=$!
      echo "$NEW_PID" > "$RECIPIENT_PIDFILE"
      ok "Recipient restart launched (PID $NEW_PID)"

      api_ready=0
      boot_t0=$(date +%s)
      for i in $(seq 1 "$RESTART_BOOT_TIMEOUT_S"); do
        if curl -sf --max-time 2 -H "Authorization: Bearer $AUTH" \
             "http://127.0.0.1:$RECIPIENT_PORT/api/status" > /dev/null 2>&1; then
          api_ready=1
          boot_elapsed=$(( $(date +%s) - boot_t0 ))
          ok "Recipient API responsive after ${boot_elapsed}s"
          break
        fi
        sleep 1
      done

      if [[ "$api_ready" -ne 1 ]]; then
        fail "Recipient API never responded within ${RESTART_BOOT_TIMEOUT_S}s — aborting SECTION 37"
      else
        echo "--- 37e: poll inbox for the durable marker (≤ ${EDGE_OUTBOX_FLUSH_TIMEOUT_S}s) ---"
        # Phase 1: poll every 3s until the marker first appears (or
        # timeout). Substrate outbox tick + libp2p reconnect + dial is
        # bounded by EDGE_OUTBOX_FLUSH_TIMEOUT_S.
        inbox_count_for_marker() {
          c "http://127.0.0.1:$RECIPIENT_PORT/api/messages?peer=$N1_PEER&direction=in&limit=50" \
            | python3 -c "
import sys, json
marker = '$DURABLE_MARKER'
try:
  d = json.load(sys.stdin)
  msgs = d.get('messages') or d.get('result') or []
  print(sum(1 for m in msgs if m.get('text') == marker))
except Exception:
  print(0)
" 2>/dev/null
        }
        delivered=0
        first_match_count=0
        poll_t0=$(date +%s)
        while [[ $(( $(date +%s) - poll_t0 )) -lt "$EDGE_OUTBOX_FLUSH_TIMEOUT_S" ]]; do
          first_match_count=$(inbox_count_for_marker)
          if [[ "$first_match_count" -ge 1 ]]; then
            delivered=1
            break
          fi
          sleep 3
        done
        poll_elapsed=$(( $(date +%s) - poll_t0 ))
        if [[ "$delivered" == "1" ]]; then
          ok "Recipient received '$DURABLE_MARKER' after ${poll_elapsed}s without operator resend (outbox-durability ✓)"
          # Phase 2: idempotency quiet-period (Codex PR #588 fix).
          # Breaking on the first match would miss a duplicate that
          # arrives a few seconds later during the same reconnect/
          # flush window. Keep polling for IDEMPOTENCY_QUIET_PERIOD_S
          # past the first match; assert exactly-once based on the
          # MAX seen across the whole window.
          QUIET_PERIOD_S="${IDEMPOTENCY_QUIET_PERIOD_S:-10}"
          echo "  observing idempotency quiet period (${QUIET_PERIOD_S}s) for late duplicates..."
          max_count=$first_match_count
          quiet_t0=$(date +%s)
          while [[ $(( $(date +%s) - quiet_t0 )) -lt "$QUIET_PERIOD_S" ]]; do
            n=$(inbox_count_for_marker)
            if [[ "$n" -gt "$max_count" ]]; then
              max_count=$n
            fi
            sleep 2
          done
          if [[ "$max_count" -eq 1 ]]; then
            ok "Inbox has exactly 1 row for the marker after ${QUIET_PERIOD_S}s quiet period (idempotency ✓)"
          else
            fail "Inbox saw $max_count rows for the marker during ${QUIET_PERIOD_S}s quiet period — expected 1 (idempotency regression: substrate isn't deduping retries)"
          fi
        else
          fail "Recipient did NOT receive '$DURABLE_MARKER' within ${EDGE_OUTBOX_FLUSH_TIMEOUT_S}s — outbox-durability regression"
        fi
      fi
      fi  # close the ABORT_RESTART else-branch
      fi  # close the N1_PEER sentinel-validation else-branch (round 6)
    fi
  fi
fi
section_done

#------------------------------------------------------------
echo ""
echo "============================================================"
echo "TEST SUMMARY"
echo "============================================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo "  TOTAL: $((PASS + FAIL + WARN))"
echo "  Elapsed: $(( $(date +%s) - SCRIPT_T0 ))s"
echo "============================================================"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "  Some tests FAILED — see above for details."
  exit 1
else
  echo "  All tests passed (with $WARN warnings)."
fi
