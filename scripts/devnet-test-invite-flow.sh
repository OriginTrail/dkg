#!/usr/bin/env bash
#
# End-to-end test of the curated context-graph invite & acceptance flow.
#
# Drives 3 devnet nodes over HTTP:
#   N1 (port 9201) — curator, registers a private (curated) CG
#   N2 (port 9202) — invitee, allowlisted after approval; should join successfully
#   N3 (port 9203) — outsider, never allowlisted; its subscription must be refused
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

# Count an exact subject in a node's backing store, below /api/query's
# read-authority gate. A denied scoped query returns empty without inspecting
# storage, so it cannot prove that an outsider never received private data.
store_subject_count() {
  local node_num="$1" subject="$2" predicate="${3:-http://schema.org/name}" config="$DEVNET_DIR/node${1}/config.json"
  local endpoint query out status body
  endpoint=$(python3 - "$config" <<'PYENDPOINT'
import json,sys
c=json.load(open(sys.argv[1]))['store']
backend=c['backend']; options=c.get('options',{})
if backend=='oxigraph-server': print(f"http://127.0.0.1:{options.get('port',7878)}/query")
elif backend=='blazegraph': print(options['url'])
elif backend=='sparql-http': print(options['queryEndpoint'])
else: sys.exit(f'unsupported devnet store backend: {backend}')
PYENDPOINT
) || return 1
  query="SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { <$subject> <$predicate> ?o . FILTER(STRSTARTS(STR(?g), \"did:dkg:context-graph:${CG_ID}/\")) } }"
  out=$(curl -sS --max-time 30 -X POST -H 'Accept: application/sparql-results+json' \
    --data-urlencode "query=$query" -w $'\n%{http_code}' "$endpoint") || return 1
  status="${out##*$'\n'}"
  [ "$status" = 200 ] || return 1
  body="${out%$'\n'*}"
  printf '%s' "$body" | python3 -c '
import json,sys
try:
    n=int(json.load(sys.stdin)["results"]["bindings"][0]["n"]["value"])
    assert n>=0
    print(n)
except Exception: sys.exit(1)
'
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
  'register': True,
  'allowedAgents': ['$N1_ADDR'],
}))
")
create_resp=$(api "$N1" POST /api/context-graph/create "$create_body")
created=$(echo "$create_resp" | jq_field created)
registered=$(echo "$create_resp" | jq_field registered)
on_chain_id=$(echo "$create_resp" | jq_field onChainId)
if [ "$created" = "$CG_ID" ] && [ "$registered" = True ] &&
   [[ "$on_chain_id" =~ ^[1-9][0-9]*$ ]]; then
  ok "CG created on N1: $(echo "$create_resp" | jq_field uri)"
else
  fail "registered create failed or was partial: $create_resp"
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

hr "Step 2 — N1 stages local data before the invite"
# Create an assertion and write two sample quads into it.
ASSERTION_NAME="widget-info"
create_assertion=$(api "$N1" POST /api/knowledge-assets \
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
write_resp=$(api "$N1" POST "/api/knowledge-assets/$ASSERTION_NAME/wm/write" "$write_body")
note "assertion/write response: $write_resp"
written=$(echo "$write_resp" | jq_field written)
if [ -n "$written" ] && [ "$written" != "0" ]; then
  ok "wrote $written quads into CG on N1"
else
  fail "failed to write quads: $write_resp"
fi

# Give durable catch-up a real historical VM asset. Publishing a KA removes
# that KA's graph-scoped SWM copy, so use the separate widget assertion here
# and create the historical SWM-only asset below after VM confirmation.
widget_finalize_resp=$(api "$N1" POST "/api/knowledge-assets/${ASSERTION_NAME}/wm/finalize" \
  "{\"contextGraphId\":\"$CG_ID\"}")
[ -n "$(echo "$widget_finalize_resp" | jq_field merkleRoot)" ] ||
  fail "historical VM assertion did not finalize: $widget_finalize_resp"
widget_share_resp=$(api "$N1" POST "/api/knowledge-assets/${ASSERTION_NAME}/swm/share" \
  "{\"contextGraphId\":\"$CG_ID\",\"entities\":\"all\"}")
[ "$(echo "$widget_share_resp" | jq_field swmShared)" = True ] &&
  [ "$(echo "$widget_share_resp" | jq_field publishReady)" = True ] ||
  fail "historical VM assertion did not complete its full share: $widget_share_resp"
pre_publish_resp=$(api "$N1" POST "/api/knowledge-assets/${ASSERTION_NAME}/vm/publish" \
  "{\"contextGraphId\":\"$CG_ID\",\"options\":{\"epochs\":1}}")
[ "$(echo "$pre_publish_resp" | jq_field status)" = confirmed ] ||
  fail "pre-join VM publish did not confirm: $pre_publish_resp"
pre_ka_id=$(echo "$pre_publish_resp" | jq_field kaId)
[[ "$pre_ka_id" =~ ^[1-9][0-9]*$ ]] || fail "pre-join VM publish lacks a KA id: $pre_publish_resp"
ok "curator confirmed the historical widget in VM before N2 joined"

# A historical SWM asset must exist before the member joins. Live delivery of
# a newly shared asset after subscription cannot prove catch-up worked.
PRE_SUBJECT="urn:invite-flow:${CG_ID}:before"
pre_share_body=$(CG="$CG_ID" SUBJECT="$PRE_SUBJECT" python3 - <<'PYBODY'
import json,os
print(json.dumps({
  'contextGraphId':os.environ['CG'], 'name':'before-'+os.environ['CG'],
  'quads':[{'subject':os.environ['SUBJECT'],
            'predicate':'http://schema.org/name','object':'"Before approval"','graph':''}],
  'finalize':True,'alsoShareSwm':True,
}))
PYBODY
)
pre_share_resp=$(api "$N1" POST /api/knowledge-assets "$pre_share_body")
[ "$(echo "$pre_share_resp" | jq_field swmShared)" = True ] || fail "pre-join SWM share did not complete: $pre_share_resp"
[ -n "$(echo "$pre_share_resp" | jq_field shareOperationId)" ] || fail "pre-join share lacks operation id: $pre_share_resp"
pre_curator_count=$(store_subject_count 1 "$PRE_SUBJECT") || fail "cannot inspect curator's local SWM store"
[ "$pre_curator_count" -ge 1 ] || fail "pre-join SWM subject was not stored on curator"
ok "curator stored the historical SWM asset before N2 joined"

hr "Step 3 — N2 attempts to subscribe before being allowlisted (expect: refused)"
subscribe_body="{\"contextGraphId\":\"$CG_ID\"}"
preapproval_refused=no
for attempt in $(seq 1 30); do
  sub_resp=$(api "$N2" POST /api/context-graph/subscribe "$subscribe_body")
  code=$(echo "$sub_resp" | jq_field code)
  if [ "$code" = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE ]; then
    note "pre-approval authority pending (attempt $attempt/30)"
    sleep 5
    continue
  fi
  error=$(echo "$sub_resp" | jq_field error)
  case "$error" in
    *"not authorized"*|*"invite you first"*) preapproval_refused=yes; break ;;
  esac
  if [ "$(echo "$sub_resp" | jq_field subscribed)" = "$CG_ID" ]; then
    catchup_resp=$(api "$N2" GET "/api/sync/catchup-status?contextGraphId=$CG_ID")
    catchup_status=$(echo "$catchup_resp" | jq_field status)
    if [ "$catchup_status" = denied ]; then
      data_synced=$(echo "$catchup_resp" | jq_field result.dataSynced)
      swm_synced=$(echo "$catchup_resp" | jq_field result.sharedMemorySynced)
      [ "$data_synced" = 0 ] && [ "$swm_synced" = 0 ] || fail "pre-approval catch-up denied after transferring data: $catchup_resp"
      preapproval_refused=yes
      break
    fi
    [ "$catchup_status" != done ] || fail "N2 caught up before approval: $catchup_resp"
    note "pre-approval catch-up returned ${catchup_status:-pending}; waiting for explicit denial"
    sleep 5
    continue
  fi
  fail "N2's pre-approval response was not an explicit refusal: $sub_resp"
done
[ "$preapproval_refused" = yes ] || fail "N2 never received an explicit pre-approval refusal: $sub_resp"
ok "N2 was refused before approval"
pre_widget_member_count=$(store_subject_count 2 "did:example:widget" \
  "http://www.w3.org/2000/01/rdf-schema#label") || fail "cannot inspect N2's pre-approval VM store"
[ "$pre_widget_member_count" -eq 0 ] || fail "N2 received the historical VM asset before approval"
ok "N2 has no historical VM asset before approval"

hr "Step 3b — verify N2's CG list does NOT contain a phantom entry"
n2_sees=$(list_has_cg "$N2" "$CG_ID")
if [ "$n2_sees" = "no" ]; then
  ok "N2's project list correctly omits the inaccessible CG"
else
  fail "N2 has a phantom entry for '$CG_ID' (regression)"
  list_cg_state "$N2" "$CG_ID"
fi
pre_member_count=$(store_subject_count 2 "$PRE_SUBJECT") || fail "cannot inspect N2's local SWM store"
[ "$pre_member_count" = 0 ] || fail "N2 stored private SWM before approval"
ok "N2's backing store has no pre-join private SWM data"

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

hr "Step 7 — N2 subscribes after approval (retry bounded authority reads)"
# The registered graph's chain roster is committed before approve-join returns,
# but a just-started devnet may still have a cold finalized authority index.
# Retry only the documented transient 503; do not treat a metadata-only
# catch-up as proof of private data transfer.
subscribed=no
for attempt in $(seq 1 30); do
  sub2_resp=$(api "$N2" POST /api/context-graph/subscribe "$subscribe_body")
  sub2_id=$(echo "$sub2_resp" | jq_field subscribed)
  if [ "$sub2_id" = "$CG_ID" ]; then subscribed=yes; break; fi
  sub2_code=$(echo "$sub2_resp" | jq_field code)
  [ "$sub2_code" = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE ] || fail "N2 subscription denied after approval: $sub2_resp"
  note "registered authority pending (attempt $attempt/30)"
  sleep 5
done
[ "$subscribed" = yes ] || fail "N2 never subscribed after approval: $sub2_resp"
ok "N2 subscribed to the registered graph"

catchup_done=no
catchup_retries=0
for attempt in $(seq 1 90); do
  catchup_resp=$(api "$N2" GET "/api/sync/catchup-status?contextGraphId=$CG_ID")
  catchup_status=$(echo "$catchup_resp" | jq_field status)
  case "$catchup_status" in
    done)
      historical_synced=$(echo "$catchup_resp" | jq_field result.sharedMemorySynced)
      [[ "$historical_synced" =~ ^[1-9][0-9]*$ ]] ||
        fail "catch-up completed without transferring the historical SWM asset: $catchup_resp"
      durable_synced=$(echo "$catchup_resp" | jq_field result.dataSynced)
      if ! [[ "$durable_synced" =~ ^[1-9][0-9]*$ ]]; then
        # A concurrent graph-level sync can deliver VM outside this foreground
        # catch-up, leaving its own delta count at zero. The asset was
        # absent before approval; require it in this run's backing-store graph.
        # Chain reconciliation may commit it shortly after the foreground job
        # completes, so give that independent path a bounded settling window.
        widget_background_count=0
        for settle in $(seq 1 30); do
          widget_background_count=$(store_subject_count 2 "did:example:widget" \
            "http://www.w3.org/2000/01/rdf-schema#label") ||
            fail "cannot inspect N2's post-approval VM store"
          [ "$widget_background_count" -ge 1 ] && break
          sleep 3
        done
        [ "$widget_background_count" -ge 1 ] ||
          fail "catch-up completed without the historical VM asset: $catchup_resp"
        note "historical VM arrived through graph-level sync before the foreground catch-up"
      fi
      catchup_done=yes
      break
      ;;
    denied) fail "approved member's catch-up was denied: $catchup_resp" ;;
    failed|unreachable|deferred)
      [ "$catchup_retries" -lt 3 ] || fail "approved member's catch-up kept failing: $catchup_resp"
      catchup_retries=$((catchup_retries + 1))
      retry_resp=$(api "$N2" POST /api/context-graph/subscribe "$subscribe_body")
      retry_id=$(echo "$retry_resp" | jq_field subscribed)
      retry_code=$(echo "$retry_resp" | jq_field code)
      [ "$retry_id" = "$CG_ID" ] || [ "$retry_code" = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE ] ||
        fail "approved member's catch-up retry was refused: $retry_resp"
      note "catch-up retry $catchup_retries after $catchup_status"
      ;;
  esac
  sleep 3
done
[ "$catchup_done" = yes ] || fail "approved member's historical catch-up never completed: $catchup_resp"
ok "N2 received historical VM and SWM after approval"

widget_member_count=$(store_subject_count 2 "did:example:widget" \
  "http://www.w3.org/2000/01/rdf-schema#label") || fail "cannot inspect N2's VM backing store"
[ "$widget_member_count" -ge 1 ] || fail "N2 lacks the historical widget VM triple after catch-up"
ok "N2's backing store holds the historical widget VM triple"

subscription_synced=no
for attempt in $(seq 1 15); do
  subscription_state=$(api "$N2" GET /api/context-graph/subscriptions)
  subscription_synced=$(SUBSCRIPTIONS="$subscription_state" CG="$CG_ID" python3 - <<'PYCHECK'
import json,os
try:
    rows=json.loads(os.environ['SUBSCRIPTIONS']).get('subscriptions',[])
    print('yes' if any(r.get('contextGraphId')==os.environ['CG'] and r.get('synced') is True for r in rows) else 'no')
except Exception: print('no')
PYCHECK
)
  [ "$subscription_synced" = yes ] && break
  sleep 2
done
[ "$subscription_synced" = yes ] || fail "N2's subscription stayed unsynced after catch-up: $subscription_state"
ok "N2's subscription reports synced"

pre_query_body=$(CG="$CG_ID" SUBJECT="$PRE_SUBJECT" python3 - <<'PYQUERY'
import json,os
print(json.dumps({'contextGraphId':os.environ['CG'],'graphSuffix':'_shared_memory',
  'sparql':f'SELECT ?o WHERE {{ <{os.environ["SUBJECT"]}> <http://schema.org/name> ?o }}'}))
PYQUERY
)
pre_member_query=$(api "$N2" POST /api/query "$pre_query_body")
if QUERY="$pre_member_query" python3 - <<'PYCHECK'
import json,os,sys
try:
    values=[str(b.get('o','')) for b in json.loads(os.environ['QUERY']).get('result',{}).get('bindings',[])]
    sys.exit(0 if values == ['"Before approval"'] else 1)
except Exception: sys.exit(1)
PYCHECK
then ok "N2 holds the exact historical SWM triple from catch-up"
else fail "N2 missed historical SWM data after catch-up: $pre_member_query"
fi

hr "Step 7b — N2 learns its curator and approved membership"
participants_ok=no
for attempt in $(seq 1 30); do
  participants_resp=$(api "$N2" GET "/api/context-graph/$ENC_CG/participants")
  if N1_AGENT="$N1_ADDR" N2_AGENT="$N2_ADDR" PARTICIPANTS="$participants_resp" python3 - <<'PYCHECK'
import json,os,sys
try:
    want={os.environ['N1_AGENT'].lower(),os.environ['N2_AGENT'].lower()}
    got={str(a).lower() for a in json.loads(os.environ['PARTICIPANTS']).get('allowedAgents',[])}
    sys.exit(0 if want <= got else 1)
except Exception: sys.exit(1)
PYCHECK
  then participants_ok=yes; break; fi
  sleep 5
done
[ "$participants_ok" = yes ] || fail "N2 did not receive approved private membership: $participants_resp"
ok "N2 knows its curator and approved agent"

hr "Step 7c — curator shares a fresh KA; N2 must receive its exact SWM triple"
STAMP=$(date +%s)
SUBJECT="urn:invite-flow:${STAMP}"
share_body=$(CG="$CG_ID" SUBJECT="$SUBJECT" STAMP="$STAMP" python3 - <<'PYBODY'
import json,os
print(json.dumps({
  'contextGraphId':os.environ['CG'],
  'name':'invite-flow-'+os.environ['STAMP'],
  'quads':[{'subject':os.environ['SUBJECT'],
            'predicate':'http://schema.org/name','object':'"Approved member data"','graph':''}],
  'finalize':True,'alsoShareSwm':True,
}))
PYBODY
)
share_resp=$(api "$N1" POST /api/knowledge-assets "$share_body")
[ "$(echo "$share_resp" | jq_field swmShared)" = True ] || fail "curator SWM share did not complete: $share_resp"
[ -n "$(echo "$share_resp" | jq_field shareOperationId)" ] || fail "curator share lacks operation id: $share_resp"
ok "curator shared one finalized KA into the private graph"

query_body=$(CG="$CG_ID" SUBJECT="$SUBJECT" python3 - <<'PYQUERY'
import json,os
print(json.dumps({'contextGraphId':os.environ['CG'],'graphSuffix':'_shared_memory',
  'sparql':f'SELECT ?o WHERE {{ <{os.environ["SUBJECT"]}> <http://schema.org/name> ?o }}'}))
PYQUERY
)
member_has_exact=no
for attempt in $(seq 1 30); do
  member_query=$(api "$N2" POST /api/query "$query_body")
  if QUERY="$member_query" python3 - <<'PYCHECK'
import json,os,sys
try:
    values=[str(b.get('o','')) for b in json.loads(os.environ['QUERY']).get('result',{}).get('bindings',[])]
    sys.exit(0 if values == ['"Approved member data"'] else 1)
except Exception: sys.exit(1)
PYCHECK
  then member_has_exact=yes; break; fi
  sleep 5
done
[ "$member_has_exact" = yes ] || fail "N2 did not receive exact private SWM triple: $member_query"
ok "N2 holds the curator's exact private SWM triple"

hr "Step 8 — N3 is refused and has no private SWM triple"
outsider_refused=no
for attempt in $(seq 1 30); do
  sub3_resp=$(api "$N3" POST /api/context-graph/subscribe "$subscribe_body")
  if [ "$(echo "$sub3_resp" | jq_field code)" = CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE ]; then
    sleep 5
    continue
  fi
  sub3_error=$(echo "$sub3_resp" | jq_field error)
  case "$sub3_error" in
    *"not authorized"*|*"invite you first"*) outsider_refused=yes; break ;;
  esac
  if [ "$(echo "$sub3_resp" | jq_field subscribed)" = "$CG_ID" ]; then
    outside_catchup=$(api "$N3" GET "/api/sync/catchup-status?contextGraphId=$CG_ID")
    outside_status=$(echo "$outside_catchup" | jq_field status)
    if [ "$outside_status" = denied ]; then
      [ "$(echo "$outside_catchup" | jq_field result.dataSynced)" = 0 ] &&
      [ "$(echo "$outside_catchup" | jq_field result.sharedMemorySynced)" = 0 ] ||
        fail "N3 received private data before denial: $outside_catchup"
      outsider_refused=yes
      break
    fi
    [ "$outside_status" != done ] || fail "N3 caught up to private data: $outside_catchup"
    sleep 5
    continue
  fi
  fail "N3 subscription was not an authorization refusal: $sub3_resp"
done
[ "$outsider_refused" = yes ] || fail "N3 never returned an explicit authorization refusal: $sub3_resp"
ok "N3's subscription was refused by the private graph's agent gate"
outside_query=$(api "$N3" POST /api/query "$query_body")
if QUERY="$outside_query" python3 - <<'PYCHECK'
import json,os,sys
try:
    bindings=json.loads(os.environ['QUERY']).get('result',{}).get('bindings',[])
    sys.exit(0 if len(bindings)==0 else 1)
except Exception: sys.exit(1)
PYCHECK
then ok "N3's public query cannot read private SWM"; else fail "outsider N3 read private SWM: $outside_query"; fi
curator_live_count=$(store_subject_count 1 "$SUBJECT") || fail "cannot inspect curator's live SWM store"
[ "$curator_live_count" -ge 1 ] || fail "curator's live SWM subject is absent from its backing store"
outsider_before_count=$(store_subject_count 3 "$PRE_SUBJECT") || fail "cannot inspect N3's historical SWM store"
outsider_live_count=$(store_subject_count 3 "$SUBJECT") || fail "cannot inspect N3's live SWM store"
[ "$outsider_before_count" = 0 ] && [ "$outsider_live_count" = 0 ] ||
  fail "N3 physically stored private SWM despite denial (historical=$outsider_before_count live=$outsider_live_count)"
ok "N3's backing store has neither private SWM subject"
n3_sees=$(list_has_cg "$N3" "$CG_ID")
[ "$n3_sees" = no ] || fail "N3 has a phantom graph entry after refusal: $(list_cg_state "$N3" "$CG_ID")"
ok "N3 has no phantom graph entry"

hr "Done."
echo "Registered CG id used: $CG_ID"
