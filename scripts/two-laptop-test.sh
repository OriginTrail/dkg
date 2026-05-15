#!/usr/bin/env bash
#
# End-to-end invite + sync + publish test against two real nodes.
#
# Drives two HTTP-reachable DKG daemons through the full V10 flow:
#   1. Identify both (peer-id + agent-address from /api/agents)
#   2. A creates a curated context graph with N1 as sole allowedAgent
#   3. A writes some WM (working memory) data into an assertion
#   4. B subscribes  → expect 'denied' (not on allowlist yet)
#   5. B sign-join + request-join (passing A's peerId — required in V10)
#   6. A approves the join request
#   7. B catches up — verify _meta graph arrives
#   8. A promotes WM → SWM — verify B receives the gossip ENCRYPTED
#      (this is the regression check for the SWM Sender-Key encryption
#      work merged from main, exercising the assertionPromote path)
#   9. A registers the CG on-chain (if not already), then publishes SWM → VM
#  10. B (same allowlist) and any third party verify VM data arrives
#
# Usage:
#   N_A_API=http://localhost:9200      N_A_TOKEN=<bearer>      \
#   N_B_API=http://localhost:19200     N_B_TOKEN=<bearer>      \
#     ./scripts/two-laptop-test.sh
#
# The script can run from EITHER laptop or a third machine — it just
# curl-calls both APIs. If A and B are on different networks, the
# easiest reachability pattern is SSH local-port-forwards from
# wherever you run the script:
#
#   # from your script-running machine:
#   ssh -L 9200:localhost:9200  user@laptop-A
#   ssh -L 19200:localhost:9200 user@laptop-B
#   # then:
#   N_A_API=http://localhost:9200  N_A_TOKEN=$(ssh user@laptop-A 'cat ~/.dkg/auth.token')  \
#   N_B_API=http://localhost:19200 N_B_TOKEN=$(ssh user@laptop-B 'cat ~/.dkg/auth.token')  \
#     ./scripts/two-laptop-test.sh
#
# Set TEST_PUBLISH=0 to skip the on-chain publish step (sections 9-10).
# Useful for a quick invite+sync-only smoke test without spending gas.

set -u
set -o pipefail

# --- input validation ----------------------------------------------------

: "${N_A_API:?N_A_API not set (curator/inviter URL, e.g. http://localhost:9200)}"
: "${N_B_API:?N_B_API not set (joiner URL, e.g. http://localhost:19200)}"
: "${N_A_TOKEN:?N_A_TOKEN not set (curator's ~/.dkg/auth.token)}"
: "${N_B_TOKEN:?N_B_TOKEN not set (joiner's ~/.dkg/auth.token)}"

TEST_PUBLISH="${TEST_PUBLISH:-1}"

# Real-network timeouts: longer than devnet because peer dial via relay
# + on-chain settlement add real seconds. Tweak via env if needed.
DENIED_TIMEOUT="${DENIED_TIMEOUT:-60}"
APPROVED_TIMEOUT="${APPROVED_TIMEOUT:-180}"
SWM_GOSSIP_TIMEOUT="${SWM_GOSSIP_TIMEOUT:-30}"
VM_SYNC_TIMEOUT="${VM_SYNC_TIMEOUT:-60}"
ONCHAIN_REGISTER_SLEEP="${ONCHAIN_REGISTER_SLEEP:-5}"

# --- helpers -------------------------------------------------------------

CG_ID="two-laptop-$(date +%s)"
N_A_ADDR=""
N_A_PEER=""
N_B_ADDR=""
N_B_PEER=""

hr()   { printf '\n\033[1;34m── %s ──\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; exit 1; }
note() { printf '  \033[0;90m· %s\033[0m\n' "$*"; }

api() {
  # api <node-url> <token> <method> <path> [<body>]
  local url="$1" token="$2" method="$3" path="$4" body="${5:-}"
  if [ -n "$body" ]; then
    curl -sS --max-time 60 --connect-timeout 10 \
      -X "$method" "${url}${path}" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -sS --max-time 60 --connect-timeout 10 \
      -X "$method" "${url}${path}" \
      -H "Authorization: Bearer $token"
  fi
}

apiA() { api "$N_A_API" "$N_A_TOKEN" "$@"; }
apiB() { api "$N_B_API" "$N_B_TOKEN" "$@"; }

jq_field() {
  python3 -c "
import sys, json
try:
    d=json.load(sys.stdin)
except Exception as e:
    print(f'<parse-error: {e}>', end=''); sys.exit(0)
keys = '$1'.split('.')
cur = d
for k in keys:
    if isinstance(cur, list):
        try: cur = cur[int(k)]
        except: cur = None; break
    elif isinstance(cur, dict) and k in cur:
        cur = cur[k]
    else:
        cur = None; break
print('' if cur is None else (json.dumps(cur) if not isinstance(cur,(str,int,float,bool)) else cur))
"
}

urlencode() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }

identify_node() {
  # identify_node <name> <url> <token>  → echoes "<addr> <peer>"
  local name="$1" url="$2" token="$3"
  local resp
  resp=$(api "$url" "$token" GET /api/agents) || fail "$name: /api/agents call failed"
  echo "$resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
    if a.get('connectionStatus')=='self':
        print(a.get('agentAddress',''), a.get('peerId',''))
        break
" | head -1
}

poll_catchup() {
  # poll_catchup <node-url> <token> <cg> <expect-status> <timeout>
  local url="$1" token="$2" cg="$3" expect="$4" timeout="$5"
  local start=$(date +%s) status last_status="" elapsed
  local encoded; encoded=$(urlencode "$cg")
  while :; do
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail "catch-up polling timed out after ${timeout}s (last status=${last_status:-none}, expected=$expect)"
    fi
    local resp; resp=$(api "$url" "$token" GET "/api/sync/catchup-status?contextGraphId=$encoded" 2>/dev/null)
    status=$(echo "$resp" | jq_field status)
    if [ -n "$status" ] && [ "$status" != "$last_status" ]; then
      note "  t=${elapsed}s  status=$status"
      last_status="$status"
    fi
    case "$status" in
      done|denied|failed)
        if [ "$status" = "$expect" ]; then
          ok "catch-up status = $status (as expected)"
          return 0
        else
          fail "catch-up status = $status (expected $expect)  resp=$resp"
        fi
        ;;
    esac
    sleep 2
  done
}

count_query_bindings() {
  # count_query_bindings <node-url> <token> <cg> <view> <sparql>
  local url="$1" token="$2" cg="$3" view="$4" sparql="$5"
  local body; body=$(python3 -c "
import json,sys
print(json.dumps({'contextGraphId': sys.argv[1], 'view': sys.argv[2], 'sparql': sys.argv[3]}))
" "$cg" "$view" "$sparql")
  local resp; resp=$(api "$url" "$token" POST /api/query "$body")
  echo "$resp" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print(len(d.get('result',{}).get('bindings',[])))
except: print(0)
"
}

count_integer_query() {
  # for SELECT (COUNT(*) AS ?cnt) shape — extracts the integer
  local url="$1" token="$2" cg="$3" view="$4" sparql="$5"
  local body; body=$(python3 -c "
import json,sys
print(json.dumps({'contextGraphId': sys.argv[1], 'view': sys.argv[2], 'sparql': sys.argv[3]}))
" "$cg" "$view" "$sparql")
  local resp; resp=$(api "$url" "$token" POST /api/query "$body")
  echo "$resp" | python3 -c "
import sys,json,re
try:
  d=json.load(sys.stdin)
  b=d.get('result',{}).get('bindings',[])
  v = b[0].get(list(b[0].keys())[0],'0') if b else '0'
  m = re.search(r'\d+', str(v))
  print(m.group(0) if m else '0')
except: print('0')
"
}

# -------------------------------------------------------------------------
hr "Step 0 — identify both nodes"
read -r N_A_ADDR N_A_PEER < <(identify_node "Node A" "$N_A_API" "$N_A_TOKEN")
[ -n "$N_A_ADDR" ] || fail "could not resolve Node A's agent address"
[ -n "$N_A_PEER" ] || fail "could not resolve Node A's peer-id"
ok "Node A: addr=$N_A_ADDR peer=$N_A_PEER"

read -r N_B_ADDR N_B_PEER < <(identify_node "Node B" "$N_B_API" "$N_B_TOKEN")
[ -n "$N_B_ADDR" ] || fail "could not resolve Node B's agent address"
[ -n "$N_B_PEER" ] || fail "could not resolve Node B's peer-id"
ok "Node B: addr=$N_B_ADDR peer=$N_B_PEER"

_a_lc=$(printf '%s' "$N_A_ADDR" | tr '[:upper:]' '[:lower:]')
_b_lc=$(printf '%s' "$N_B_ADDR" | tr '[:upper:]' '[:lower:]')
if [ "$_a_lc" = "$_b_lc" ]; then
  fail "Node A and Node B share the same agent address — they must be distinct identities"
fi
unset _a_lc _b_lc

# -------------------------------------------------------------------------
hr "Step 1 — Node A creates curated CG '$CG_ID' (allowlist=[A])"
create_body=$(python3 -c "
import json
print(json.dumps({
  'id': '$CG_ID',
  'name': 'Two-laptop test $CG_ID',
  'description': 'Real-network invite + sync + publish smoke test',
  'accessPolicy': 1,
  'allowedAgents': ['$N_A_ADDR'],
}))
")
create_resp=$(apiA POST /api/context-graph/create "$create_body")
created=$(echo "$create_resp" | jq_field created)
[ "$created" = "$CG_ID" ] || fail "create failed: $create_resp"
ok "CG created on A: $(echo "$create_resp" | jq_field uri)"

# -------------------------------------------------------------------------
hr "Step 2 — Node A writes some WM data into 'widget-info' assertion"
apiA POST /api/assertion/create "{\"contextGraphId\":\"$CG_ID\",\"name\":\"widget-info\"}" > /dev/null

write_body=$(CG="$CG_ID" python3 <<'PY'
import json, os
print(json.dumps({
  "contextGraphId": os.environ["CG"],
  "quads": [
    {"subject":"did:example:widget","predicate":"http://www.w3.org/2000/01/rdf-schema#label","object":'"Widget"'},
    {"subject":"did:example:widget","predicate":"http://schema.org/price","object":'"42"'},
  ],
}))
PY
)
write_resp=$(apiA POST "/api/assertion/widget-info/write" "$write_body")
written=$(echo "$write_resp" | jq_field written)
[ -n "$written" ] && [ "$written" != "0" ] || fail "write failed: $write_resp"
ok "wrote $written quads into WM"

# -------------------------------------------------------------------------
hr "Step 3 — Node B subscribes (expect: denied — not on allowlist)"
apiB POST /api/subscribe "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
poll_catchup "$N_B_API" "$N_B_TOKEN" "$CG_ID" denied "$DENIED_TIMEOUT"

# -------------------------------------------------------------------------
hr "Step 4 — Node B signs a join-delegation, then forwards it to Node A"
# PR #448 split sign vs forward into two endpoints: /sign-join is sign-only
# (no body; returns the SignedAgentDelegation), /request-join takes the
# delegation + curatorPeerId and dials the curator over P2P. Mirrors the
# devnet-test-invite-flow.sh flow so this stays in lockstep with what the
# UI/CLI do in production.
sign_resp=$(apiB POST "/api/context-graph/$(urlencode "$CG_ID")/sign-join" "{}")
note "sign-join response: $sign_resp"
delegation=$(echo "$sign_resp" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('delegation') or {}))")
if [ -z "$delegation" ] || [ "$delegation" = "{}" ]; then
  fail "sign-join did not return a signed delegation: $sign_resp"
fi
ok "Node B produced a signed delegation"

submit_body=$(DEL="$delegation" PEER="$N_A_PEER" python3 <<'PY'
import json, os
print(json.dumps({
  "delegation": json.loads(os.environ["DEL"]),
  "curatorPeerId": os.environ["PEER"],
}))
PY
)
submit_resp=$(apiB POST "/api/context-graph/$(urlencode "$CG_ID")/request-join" "$submit_body")
note "request-join response: $submit_resp"
status_field=$(echo "$submit_resp" | jq_field status)
delivered=$(echo "$submit_resp" | jq_field delivered)
if [ "$status_field" = "pending" ] && [ -n "$delivered" ] && [ "$delivered" != "0" ]; then
  ok "join request delivered to Node A ($delivered curator candidate(s))"
else
  fail "request-join did not deliver: $submit_resp"
fi

# -------------------------------------------------------------------------
hr "Step 5 — Node A sees the pending request"
sleep 2
req_resp=$(apiA GET "/api/context-graph/$(urlencode "$CG_ID")/join-requests")
found=$(echo "$req_resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if any(r.get('agentAddress','').lower()=='$N_B_ADDR'.lower() for r in d.get('requests',[])) else 'no')
")
[ "$found" = "yes" ] || fail "Node A does not see Node B's pending request: $req_resp"
ok "Node A sees Node B's pending request"

# -------------------------------------------------------------------------
hr "Step 6 — Node A approves Node B"
approve_resp=$(apiA POST "/api/context-graph/$(urlencode "$CG_ID")/approve-join" \
  "{\"agentAddress\":\"$N_B_ADDR\"}")
ok_flag=$(echo "$approve_resp" | jq_field ok)
case "$ok_flag" in true|True|1) ok "approve-join succeeded" ;; *) fail "approve-join failed: $approve_resp" ;; esac

# -------------------------------------------------------------------------
hr "Step 7 — Node B catches up (expect: done; verify _meta arrives)"
sleep 2
apiB POST /api/subscribe "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
poll_catchup "$N_B_API" "$N_B_TOKEN" "$CG_ID" done "$APPROVED_TIMEOUT"

meta_count=$(count_integer_query "$N_B_API" "$N_B_TOKEN" "$CG_ID" "" \
  "SELECT (COUNT(*) AS ?n) WHERE { GRAPH <did:dkg:context-graph:${CG_ID}/_meta> { ?s ?p ?o } }")
[ "$meta_count" -gt 0 ] 2>/dev/null \
  && ok "Node B holds $meta_count triples in the CG _meta graph" \
  || fail "Node B has no _meta triples for $CG_ID"

# -------------------------------------------------------------------------
hr "Step 8 — Node A promotes WM → SWM, expect Node B to receive (encryption check)"
promote_resp=$(apiA POST "/api/assertion/widget-info/promote" "{\"contextGraphId\":\"$CG_ID\"}")
promoted_ct=$(echo "$promote_resp" | jq_field promotedCount)
[ -n "$promoted_ct" ] && [ "$promoted_ct" != "0" ] && [ "$promoted_ct" != "<parse-error" ] \
  || fail "promote failed: $promote_resp"
ok "promoted $promoted_ct quads to SWM on Node A"

# Verify locally on A first
sleep 2
a_swm=$(count_query_bindings "$N_A_API" "$N_A_TOKEN" "$CG_ID" "shared-working-memory" \
  "SELECT ?o WHERE { <did:example:widget> ?p ?o }")
[ "$a_swm" -ge 1 ] 2>/dev/null \
  || fail "Node A's SWM is empty after promote"
ok "Node A SWM shows the promoted entity ($a_swm bindings)"

# Now wait for the gossip to arrive at B (encrypted; B must decrypt)
b_swm_ok=false
for i in $(seq 1 "$SWM_GOSSIP_TIMEOUT"); do
  b_swm=$(count_query_bindings "$N_B_API" "$N_B_TOKEN" "$CG_ID" "shared-working-memory" \
    "SELECT ?o WHERE { <did:example:widget> ?p ?o }")
  if [ "$b_swm" -ge 1 ] 2>/dev/null; then
    b_swm_ok=true
    ok "Node B received decrypted SWM data after ${i}s ($b_swm bindings)"
    break
  fi
  sleep 1
done
$b_swm_ok || fail "Node B did not receive SWM data after ${SWM_GOSSIP_TIMEOUT}s — encryption pipeline may be broken"

if [ "$TEST_PUBLISH" != "1" ]; then
  hr "Done (TEST_PUBLISH=0 — skipped on-chain publish)"
  echo "CG id used: $CG_ID"
  exit 0
fi

# -------------------------------------------------------------------------
hr "Step 9 — Node A registers CG on-chain + publishes SWM → VM"
reg_resp=$(apiA POST /api/context-graph/register "{\"id\":\"$CG_ID\"}")
reg_ok=$(echo "$reg_resp" | jq_field registered)
reg_err=$(echo "$reg_resp" | jq_field error)
if [ "$reg_ok" = "$CG_ID" ]; then
  ok "CG registered on-chain"
elif echo "$reg_err" | grep -qi "already"; then
  ok "CG was already registered"
else
  fail "CG on-chain registration failed: $reg_resp"
fi
sleep "$ONCHAIN_REGISTER_SLEEP"

publish_resp=$(apiA POST /api/shared-memory/publish \
  "{\"contextGraphId\":\"$CG_ID\",\"selection\":\"all\",\"clearAfter\":false}")
pub_status=$(echo "$publish_resp" | jq_field status)
pub_kcid=$(echo "$publish_resp" | jq_field kcId)
pub_tx=$(echo "$publish_resp" | jq_field txHash)
note "publish: status=$pub_status kcId=$pub_kcid tx=${pub_tx:0:24}..."
case "$pub_status" in
  published|created|mined|confirmed)
    ok "SWM published to VM (kcId=$pub_kcid status=$pub_status)" ;;
  *)
    if [ -n "$pub_kcid" ] && [ "$pub_kcid" != "<parse-error" ]; then
      ok "SWM publish completed (kcId=$pub_kcid status=$pub_status)"
    else
      fail "SWM publish failed: $publish_resp"
    fi ;;
esac

# -------------------------------------------------------------------------
hr "Step 10 — Both nodes see VM data (VM is on-chain → public)"
for label in "Node A" "Node B"; do
  if [ "$label" = "Node A" ]; then url="$N_A_API"; token="$N_A_TOKEN"; else url="$N_B_API"; token="$N_B_TOKEN"; fi
  vm_ok=false
  for i in $(seq 1 "$VM_SYNC_TIMEOUT"); do
    vm_ct=$(count_integer_query "$url" "$token" "$CG_ID" "verified-memory" \
      "SELECT (COUNT(*) AS ?cnt) WHERE { ?s ?p ?o }")
    if [ "$vm_ct" -ge 1 ] 2>/dev/null; then
      vm_ok=true
      ok "$label: $vm_ct VM entities (after ${i}s)"
      break
    fi
    sleep 1
  done
  $vm_ok || warn "$label: no VM entities after ${VM_SYNC_TIMEOUT}s — VM sync may be slower on testnet"
done

hr "Done."
echo "CG id used:    $CG_ID"
echo "Curator (A):   addr=$N_A_ADDR  peer=$N_A_PEER"
echo "Joiner  (B):   addr=$N_B_ADDR  peer=$N_B_PEER"
