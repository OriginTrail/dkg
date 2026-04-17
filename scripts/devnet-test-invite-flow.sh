#!/usr/bin/env bash
#
# End-to-end test of the curated context-graph invite & acceptance flow.
#
# Drives 3 devnet nodes over HTTP:
#   N1 (port 9201) — curator, creates a private (curated) CG
#   N2 (port 9202) — invitee, allowlisted after approval; should join successfully
#   N3 (port 9203) — invitee, never allowlisted; should be cleanly denied
#
# Focuses strictly on the invite/acceptance surface. Assumes the devnet
# was started by `./scripts/devnet.sh start 5`.

set -u
set -o pipefail

TOKEN="${DEVNET_TOKEN:-5CnUoxJBhTnXOeOCi2fCZyZ3kdZzBfT4fKAwf8Uco}"
CG_ID="invite-test-$(date +%s)"
N1=http://127.0.0.1:9201
N2=http://127.0.0.1:9202
N3=http://127.0.0.1:9203

# Filled in by `identify` below.
N1_ADDR=""
N2_ADDR=""
N3_ADDR=""

hr() { printf '\n\033[1;34m── %s ──\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
note() { printf '  \033[0;90m· %s\033[0m\n' "$*"; }

api() {
  local node="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "${node}${path}" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -sS -X "$method" "${node}${path}" \
      -H "Authorization: Bearer $TOKEN"
  fi
}

jq_field() {
  # Tiny pure-python JSON field extractor (no jq dependency assumed).
  # Usage: echo '<json>' | jq_field path.to.key
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

identify() {
  for i in 1 2 3; do
    local node_url="N$i" api_url
    api_url=$(eval echo "\$N${i}")
    local self
    self=$(api "$api_url" GET /api/agents | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
    if a.get('connectionStatus')=='self':
        print(a.get('agentAddress','')); break
")
    if [ -z "$self" ]; then fail "Node $i: could not fetch agent address"; exit 1; fi
    eval "N${i}_ADDR=\"$self\""
    ok "Node $i agent address: $self"
  done
}

poll_catchup() {
  local node="$1" cg_id="$2" expect="$3" timeout="${4:-90}"
  local start=$(date +%s) status last_status=""
  local encoded
  encoded=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$cg_id',safe=''))")
  while :; do
    local elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail "catch-up polling timed out after ${timeout}s (last status: ${last_status:-none}, expected: $expect)"
      return 1
    fi
    local resp
    resp=$(api "$node" GET "/api/sync/catchup-status?contextGraphId=$encoded" 2>/dev/null)
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
          fail "catch-up status = $status (expected $expect)"
          note "response: $resp"
          return 1
        fi
        ;;
    esac
    sleep 1.5
  done
}

list_has_cg() {
  local node="$1" cg_id="$2"
  api "$node" GET /api/paranet/list | python3 -c "
import sys,json
d=json.load(sys.stdin); cgs=d.get('contextGraphs',[])
match=[c for c in cgs if c.get('id')=='$cg_id']
print('yes' if match else 'no')
"
}

list_cg_state() {
  local node="$1" cg_id="$2"
  api "$node" GET /api/paranet/list | python3 -c "
import sys,json
d=json.load(sys.stdin); cgs=d.get('contextGraphs',[])
match=[c for c in cgs if c.get('id')=='$cg_id']
print(json.dumps(match[0] if match else None, indent=2))
"
}

###############################################################################
# Start
###############################################################################

hr "Step 0 — identify nodes"
identify

hr "Step 1 — N1 creates curated CG '$CG_ID' (allowlist = [N1 only])"
create_body=$(python3 -c "
import json
print(json.dumps({
  'id': '$CG_ID',
  'name': 'Invite flow test $CG_ID',
  'description': 'Curated CG for invite/acceptance test',
  'accessPolicy': 1,
  'allowedAgents': ['$N1_ADDR'],
}))
")
create_resp=$(api "$N1" POST /api/paranet/create "$create_body")
created=$(echo "$create_resp" | jq_field created)
if [ "$created" = "$CG_ID" ]; then
  ok "CG created on N1: $(echo "$create_resp" | jq_field uri)"
else
  fail "create failed: $create_resp"
  exit 1
fi

hr "Step 2 — N1 publishes some durable data into the CG (so N2 has something to sync after approval)"
# Create an assertion and write two sample quads into it.
ASSERTION_NAME="widget-info"
create_assertion=$(api "$N1" POST /api/assertion/create \
  "{\"contextGraphId\":\"$CG_ID\",\"name\":\"$ASSERTION_NAME\"}")
note "assertion/create response: $create_assertion"

write_body=$(CG="$CG_ID" python3 <<'PY'
import json, os
cg = os.environ["CG"]
print(json.dumps({
  "contextGraphId": cg,
  "quads": [
    {
      "subject":   "did:example:widget",
      "predicate": "http://www.w3.org/2000/01/rdf-schema#label",
      "object":    '"Widget"',
    },
    {
      "subject":   "did:example:widget",
      "predicate": "http://schema.org/price",
      "object":    '"42"',
    },
  ],
}))
PY
)
write_resp=$(api "$N1" POST "/api/assertion/$ASSERTION_NAME/write" "$write_body")
note "assertion/write response: $write_resp"
written=$(echo "$write_resp" | jq_field written)
if [ -n "$written" ] && [ "$written" != "0" ]; then
  ok "wrote $written quads into CG on N1"
else
  fail "failed to write quads: $write_resp"
fi

hr "Step 3 — N2 attempts to subscribe before being allowlisted (expect: denied)"
subscribe_body="{\"contextGraphId\":\"$CG_ID\"}"
sub_resp=$(api "$N2" POST /api/subscribe "$subscribe_body")
note "subscribe response: $sub_resp"
poll_catchup "$N2" "$CG_ID" denied 90 || { fail "N2 did not receive a 'denied' status"; }

hr "Step 3b — verify N2's CG list does NOT contain a phantom entry"
n2_sees=$(list_has_cg "$N2" "$CG_ID")
if [ "$n2_sees" = "no" ]; then
  ok "N2's project list correctly omits the inaccessible CG"
else
  fail "N2 has a phantom entry for '$CG_ID' (regression)"
  list_cg_state "$N2" "$CG_ID"
fi

hr "Step 4 — N2 signs & forwards a join request to N1 (curator)"
sign_resp=$(api "$N2" POST "/api/context-graph/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CG_ID',safe=''))")/sign-join" "{}")
sent_status=$(echo "$sign_resp" | jq_field status)
delivered=$(echo "$sign_resp" | jq_field delivered)
sig=$(echo "$sign_resp" | jq_field signature)
ts=$(echo "$sign_resp" | jq_field timestamp)
note "sign-join response: $sign_resp"
if [ "$sent_status" = "sent" ] && [ -n "$delivered" ] && [ "$delivered" != "0" ]; then
  ok "join request delivered to $delivered curator candidate(s)"
else
  fail "sign-join did not deliver (status=$sent_status delivered=$delivered)"
fi

hr "Step 5 — N1 lists pending join requests (expect: 1 for N2)"
sleep 1  # allow P2P forward + store
req_resp=$(api "$N1" GET "/api/context-graph/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CG_ID',safe=''))")/join-requests")
note "join-requests response: $req_resp"
found_n2=$(echo "$req_resp" | python3 -c "
import sys,json
d=json.load(sys.stdin)
reqs=d.get('requests',[])
print('yes' if any(r.get('agentAddress','').lower()=='$N2_ADDR'.lower() for r in reqs) else 'no')
")
if [ "$found_n2" = "yes" ]; then
  ok "N1 sees N2's pending request"
else
  fail "N1 does not see N2's pending request"
fi

hr "Step 6 — N1 approves N2"
approve_resp=$(api "$N1" POST "/api/context-graph/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CG_ID',safe=''))")/approve-join" "{\"agentAddress\":\"$N2_ADDR\"}")
ok_flag=$(echo "$approve_resp" | jq_field ok)
if [ "$ok_flag" = "true" ] || [ "$ok_flag" = "True" ] || [ "$ok_flag" = "1" ]; then
  ok "approve-join succeeded: $approve_resp"
else
  fail "approve-join failed: $approve_resp"
fi

hr "Step 7 — N2 re-subscribes (expect: done)"
sleep 2  # allowlist write to settle + any SSE notification
sub2_resp=$(api "$N2" POST /api/subscribe "$subscribe_body")
note "subscribe response: $sub2_resp"
poll_catchup "$N2" "$CG_ID" done 90 || fail "N2 did not complete catch-up after approval"

hr "Step 7b — verify N2 now sees the CG legitimately"
n2_state_after=$(list_cg_state "$N2" "$CG_ID")
note "N2 project state: $n2_state_after"
echo "$n2_state_after" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read() or 'null')
if d and d.get('subscribed') and d.get('synced'):
    print('  OK subscribed=True synced=True name=' + str(d.get('name')))
else:
    print('  FAIL: expected subscribed+synced, got:', d)
"

hr "Step 7c — verify N2 received the CG's _meta graph from the curator"
# The _meta graph carries the CG declaration + allowlist post-approval; sync
# is expected to transfer it so the invitee can prove access locally.
query_meta=$(CG="$CG_ID" python3 <<'PY'
import json, os
cg = os.environ["CG"]
meta = f"did:dkg:context-graph:{cg}/_meta"
print(json.dumps({
  "contextGraphId": cg,
  "sparql": f"SELECT (COUNT(*) AS ?n) WHERE {{ GRAPH <{meta}> {{ ?s ?p ?o }} }}",
}))
PY
)
meta_resp=$(api "$N2" POST /api/query "$query_meta")
meta_count=$(echo "$meta_resp" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    b=d.get('result',{}).get('bindings',[])
    v=b[0].get('n','0') if b else '0'
    import re
    m=re.search(r'\d+', str(v))
    print(m.group(0) if m else '0')
except Exception as e:
    print('0')
")
note "_meta triple count on N2: $meta_count"
if [ "$meta_count" -gt "0" ] 2>/dev/null; then
  ok "N2 holds $meta_count triples in the CG's _meta graph"
else
  fail "N2 has no _meta triples for $CG_ID"
fi

hr "Step 8 — N3 (never allowlisted) tries the same CG (expect: denied + no phantom)"
sub3_resp=$(api "$N3" POST /api/subscribe "$subscribe_body")
note "N3 subscribe response: $sub3_resp"
poll_catchup "$N3" "$CG_ID" denied 90 || fail "N3 did not receive a 'denied' status"
n3_sees=$(list_has_cg "$N3" "$CG_ID")
if [ "$n3_sees" = "no" ]; then
  ok "N3's project list correctly omits the inaccessible CG"
else
  fail "N3 has a phantom entry for '$CG_ID'"
  list_cg_state "$N3" "$CG_ID"
fi

hr "Done."
echo "CG id used: $CG_ID"
