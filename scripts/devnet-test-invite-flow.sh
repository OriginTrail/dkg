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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$SCRIPT_DIR/../.devnet"

# Devnet daemon log paths — used by `assert_curator_log` to validate
# server-side observability of the invite flow. Without these checks
# this script could pass even when the curator silently NACKs every
# join request (the failure mode that took an entire two-laptop session
# to root-cause; see PR #448 round-6 + the `deriveCuratorDidFromCgId`
# fallback). The script is now responsible for asserting curator-side
# log lines exist whenever a join request is supposed to land.
N1_LOG="$DEVNET_DIR/node1/daemon.log"
N2_LOG="$DEVNET_DIR/node2/daemon.log"
N3_LOG="$DEVNET_DIR/node3/daemon.log"

# Resolve the devnet auth token the same way the other devnet test scripts do.
# ./scripts/devnet.sh start generates a fresh shared token per run and writes
# it to .devnet/node1/auth.token — the nodes all accept the same token.
if [[ -n "${DEVNET_TOKEN:-}" ]]; then
  TOKEN="$DEVNET_TOKEN"
elif [[ -n "${DKG_AUTH:-}" ]]; then
  TOKEN="$DKG_AUTH"
elif [[ -f "$SCRIPT_DIR/../.devnet/node1/auth.token" ]]; then
  TOKEN="$(grep -v '^#' "$SCRIPT_DIR/../.devnet/node1/auth.token" 2>/dev/null | tr -d '[:space:]')"
else
  echo "ERROR: No auth token found. Export DEVNET_TOKEN/DKG_AUTH or start a devnet with ./scripts/devnet.sh start" >&2
  exit 2
fi

CG_ID="invite-test-$(date +%s)"
N1=http://127.0.0.1:9201
N2=http://127.0.0.1:9202
N3=http://127.0.0.1:9203

# Filled in by `identify` below.
N1_ADDR=""
N2_ADDR=""
N3_ADDR=""
# Curator peer-id (libp2p) — required by /sign-join in V10. Real users
# get this from the invite code (`<cgId>\n<peerId>`); test scripts
# resolve it via /api/agents.
N1_PEER_ID=""

hr()   { printf '\n\033[1;34m── %s ──\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
# fail halts the script so a failed assertion cannot fall through to a
# later "Done." — the script does not run under set -e so each failure
# path is responsible for exiting.
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; exit 1; }
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
    local self_json self_addr self_peer
    self_json=$(api "$api_url" GET /api/agents | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
    if a.get('connectionStatus')=='self':
        print(json.dumps({'addr': a.get('agentAddress',''), 'peer': a.get('peerId','')})); break
")
    self_addr=$(echo "$self_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('addr',''))")
    self_peer=$(echo "$self_json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('peer',''))")
    if [ -z "$self_addr" ]; then fail "Node $i: could not fetch agent address"; exit 1; fi
    eval "N${i}_ADDR=\"$self_addr\""
    eval "N${i}_PEER_ID=\"$self_peer\""
    ok "Node $i agent address: $self_addr (peer: $self_peer)"
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

# assert_log_recent <log-path> <since-iso> <expected-pattern> <human-label>
# Greps for `expected-pattern` in `log-path`, restricted to lines that
# look like they were written after `since-iso`. Uses awk because the
# devnet logs interleave bracketed ISO timestamps with un-prefixed
# multi-line stack traces; we want a "this matched while we were
# watching" semantic, not "this was ever in the log".
assert_log_recent() {
  local log_path="$1" since_iso="$2" pattern="$3" label="$4"
  if [ ! -f "$log_path" ]; then
    fail "log file missing: $log_path (label=$label)"
    return 1
  fi
  # Ignore lines older than `since_iso`. The grep is on the FILTERED
  # window so a stale match from a previous test run can't satisfy us.
  local hit
  hit=$(awk -v since="$since_iso" '
    # Match either bracketed ISO ([2026-01-…]) or whitespace-prefixed
    # ISO (2026-01-… …) — both shapes show up in the devnet log mix.
    match($0, /(\[)?20[0-9]{2}-[0-9]{2}-[0-9]{2}T?[ ][0-9:]{8}/) {
      ts = substr($0, RSTART, RLENGTH); gsub(/[\[T]/, " ", ts); sub(/^ /, "", ts)
      if (ts >= since) print
    }
  ' "$log_path" | grep -E "$pattern" | head -1)
  if [ -n "$hit" ]; then
    ok "log assertion ($label): matched"
    note "  → $hit"
    return 0
  fi
  fail "log assertion ($label) failed: pattern '$pattern' not in $log_path since $since_iso"
  note "  hint: tail of log:"
  tail -n 8 "$log_path" | sed 's/^/    /'
  return 1
}

list_has_cg() {
  local node="$1" cg_id="$2"
  api "$node" GET /api/context-graph/list | python3 -c "
import sys,json
d=json.load(sys.stdin); cgs=d.get('contextGraphs',[])
match=[c for c in cgs if c.get('id')=='$cg_id']
print('yes' if match else 'no')
"
}

list_cg_state() {
  local node="$1" cg_id="$2"
  api "$node" GET /api/context-graph/list | python3 -c "
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
create_resp=$(api "$N1" POST /api/context-graph/create "$create_body")
created=$(echo "$create_resp" | jq_field created)
if [ "$created" = "$CG_ID" ]; then
  ok "CG created on N1: $(echo "$create_resp" | jq_field uri)"
else
  fail "create failed: $create_resp"
  exit 1
fi

hr "Step 1b — assert the curator triple landed in N1's RDF _meta graph"
# Why this assertion exists: PR #448 round-6 traced "no reachable
# curator" failures back to CGs whose _meta graph was missing the
# DKG_CURATOR triple — `getContextGraphOwner` then returned null and
# PROTOCOL_JOIN_REQUEST silently NACK'd. The wallet-prefix fallback
# (`deriveCuratorDidFromCgId`) heals stale data from older code, but
# the *real* prevention is keeping today's create path honest. If a
# future PR ever drops the DKG_CURATOR write from `createContextGraph`
# this assertion fails immediately — instead of the bug only showing
# up on the next invite/sync test downstream.
curator_query=$(CG="$CG_ID" python3 <<'PY'
import json, os
cg = os.environ["CG"]
meta = f"did:dkg:context-graph:{cg}/_meta"
subj = f"did:dkg:context-graph:{cg}"
print(json.dumps({
  "contextGraphId": cg,
  "sparql": f"""SELECT ?owner WHERE {{
    GRAPH <{meta}> {{
      <{subj}> <https://dkg.network/ontology#curator> ?owner .
    }}
  }} LIMIT 1""",
}))
PY
)
curator_resp=$(api "$N1" POST /api/query "$curator_query")
curator_owner=$(echo "$curator_resp" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  bindings = d.get('result', {}).get('bindings', [])
  print(bindings[0].get('owner', '') if bindings else '')
except Exception:
  print('')
")
expected_owner="did:dkg:agent:${N1_ADDR}"
# Lower-case both sides: `/api/agents` returns wallet addresses
# lower-cased, but `createContextGraph` writes them in EIP-55
# checksum case to the RDF triple. Both forms denote the same
# Ethereum address — and `getContextGraphOwner`'s downstream
# consumers (`isCuratorOf`, `isCurator`) compare case-insensitively
# for this exact reason. Mirror that here so the assertion only
# fires on a real "missing/wrong owner" regression, not on cosmetic
# checksum drift.
curator_owner_lc=$(printf '%s' "$curator_owner" | tr '[:upper:]' '[:lower:]')
expected_owner_lc=$(printf '%s' "$expected_owner" | tr '[:upper:]' '[:lower:]')
if [ "$curator_owner_lc" = "$expected_owner_lc" ]; then
  ok "DKG_CURATOR triple present and points at N1: $curator_owner"
elif [ -n "$curator_owner" ]; then
  fail "DKG_CURATOR triple present but owner unexpected (got '$curator_owner', expected '$expected_owner')"
else
  fail "DKG_CURATOR triple MISSING from $CG_ID's _meta graph — createContextGraph regression. Without it, every PROTOCOL_JOIN_REQUEST for this CG silently NACKs."
  note "raw response: $curator_resp"
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
# PR #448 review: /sign-join is now sign-only — it returns the
# SignedAgentDelegation but does NOT forward over P2P. Forwarding lives
# in /request-join, mirroring the UI's two-step flow. The earlier
# "sign-and-forward" path duplicated the forward when callers also
# POSTed the delegation back to /request-join.
ENC_CG=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CG_ID',safe=''))")
sign_resp=$(api "$N2" POST "/api/context-graph/$ENC_CG/sign-join" "{}")
note "sign-join response: $sign_resp"
delegation=$(echo "$sign_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('delegation') or {}))")
if [ -z "$delegation" ] || [ "$delegation" = "{}" ]; then
  fail "sign-join did not return a signed delegation: $sign_resp"
fi
ok "sign-join returned a signed delegation"

submit_body=$(python3 -c "
import sys,json
print(json.dumps({
  'delegation': json.loads('''$delegation'''),
  'curatorPeerId': '$N1_PEER_ID',
}))
")
# Mark the moment of request submission so subsequent log assertions
# only consider lines written from this point onward (avoids matching
# stale entries from prior test runs that re-used the same fixture).
JOIN_REQUEST_TS=$(date -u +'%Y-%m-%d %H:%M:%S')
submit_resp=$(api "$N2" POST "/api/context-graph/$ENC_CG/request-join" "$submit_body")
note "request-join response: $submit_resp"
delivered=$(echo "$submit_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('delivered',''))")
status_field=$(echo "$submit_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))")
if [ "$status_field" = "pending" ] && [ -n "$delivered" ] && [ "$delivered" != "0" ]; then
  ok "join request delivered ($delivered)"
else
  fail "request-join did not deliver (status=$status_field delivered=$delivered)"
fi

# Server-side observability assertions — protect against the silent-
# rejection regression class where `delivered>0` is satisfied by a
# broadcast peer that ack'd "ok" but isn't actually the curator, or
# where the curator's own handler silently returned "unknown CG" /
# "missing fields" without surfacing it. Both lines below come from
# the inbound PROTOCOL_JOIN_REQUEST handler in `dkg-agent.ts` (added
# in PR #448 round-6 along with the wallet-prefix curator fallback).
hr "Step 4b — assert curator (N1) logged the inbound join request"
sleep 1   # give the inbound handler a moment to flush
assert_log_recent "$N1_LOG" "$JOIN_REQUEST_TS" \
  "PROTOCOL_JOIN_REQUEST from .* for \"$CG_ID\": accepted" \
  "curator accepted inbound request" \
  || fail "curator did not log accepting the join request — silent-NACK regression?"
assert_log_recent "$N1_LOG" "$JOIN_REQUEST_TS" \
  "Stored pending join request from .* for \"$CG_ID\"" \
  "curator persisted the request" \
  || fail "curator accepted but did not persist — broken store path"

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
# Post-approval catch-up does a full multi-peer fan-out (data + meta +
# shared-memory) for every CG the node knows about, which in devnet
# can take ~1–2 minutes under retries. We don't want this assertion to
# race pre-existing SWM sync cost, so poll for 180s.
poll_catchup "$N2" "$CG_ID" done 180 || fail "N2 did not complete catch-up after approval"

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
