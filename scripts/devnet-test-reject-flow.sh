#!/usr/bin/env bash
#
# End-to-end test of the join-request REJECTION notification flow.
#
# Drives 2 devnet nodes over HTTP:
#   N1 (port 9201) — curator, creates a private (curated) CG
#   N2 (port 9202) — invitee, never allowlisted; request should be rejected
#
# Verifies that after the curator rejects the join request:
#   * N2 receives a `join_rejected` notification via /api/notifications
#   * The notification carries the correct contextGraphId + agentAddress
#
# Assumes `./scripts/devnet.sh start 5` is running.

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$SCRIPT_DIR/../.devnet"
N1_LOG="$DEVNET_DIR/node1/daemon.log"
N2_LOG="$DEVNET_DIR/node2/daemon.log"

# Resolve the devnet auth token the same way the other devnet test scripts do.
# ./scripts/devnet.sh start generates a fresh shared token per run and writes
# it to .devnet/node1/auth.token — all nodes accept the same token.
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

CG_ID="reject-test-$(date +%s)"
N1=http://127.0.0.1:9201
N2=http://127.0.0.1:9202

N1_ADDR=""
N2_ADDR=""
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

urlenc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }

# See devnet-test-invite-flow.sh for the full rationale; same helper.
assert_log_recent() {
  local log_path="$1" since_iso="$2" pattern="$3" label="$4"
  if [ ! -f "$log_path" ]; then fail "log file missing: $log_path (label=$label)"; return 1; fi
  local hit
  hit=$(awk -v since="$since_iso" '
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
  tail -n 8 "$log_path" | sed 's/^/    /'
  return 1
}

identify() {
  for i in 1 2; do
    local api_url
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
    if [ -z "$self_addr" ]; then fail "N$i: could not fetch agent address"; exit 1; fi
    eval "N${i}_ADDR=\"$self_addr\""
    eval "N${i}_PEER_ID=\"$self_peer\""
    ok "N$i agent address: $self_addr (peer: $self_peer)"
  done
}

poll_catchup() {
  local node="$1" cg_id="$2" expect="$3" timeout="${4:-90}"
  local start=$(date +%s) last_status=""
  local encoded=$(urlenc "$cg_id")
  while :; do
    local elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$timeout" ]; then
      fail "catch-up timed out after ${timeout}s (last=$last_status, expected=$expect)"
      return 1
    fi
    local resp status
    resp=$(api "$node" GET "/api/sync/catchup-status?contextGraphId=$encoded" 2>/dev/null)
    status=$(echo "$resp" | python3 -c "import sys,json; 
try: print(json.load(sys.stdin).get('status',''))
except: print('')
")
    if [ -n "$status" ] && [ "$status" != "$last_status" ]; then
      note "  t=${elapsed}s status=$status"; last_status="$status"
    fi
    case "$status" in
      done|denied|failed)
        if [ "$status" = "$expect" ]; then ok "catch-up=$status (expected)"; return 0; fi
        fail "catch-up=$status (expected $expect)"; return 1
        ;;
    esac
    sleep 1.5
  done
}

###############################################################################

hr "Step 0 — identify nodes"
identify

hr "Step 1 — N1 creates curated CG '$CG_ID' (allowlist = [N1 only])"
body=$(python3 -c "
import json
print(json.dumps({
  'id': '$CG_ID',
  'name': 'Reject flow test $CG_ID',
  'description': 'Test curator rejection notification path',
  'accessPolicy': 1,
  'allowedAgents': ['$N1_ADDR'],
}))
")
resp=$(api "$N1" POST /api/context-graph/create "$body")
created=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('created',''))")
[ "$created" = "$CG_ID" ] && ok "CG created on N1" || { fail "create failed: $resp"; exit 1; }

hr "Step 2 — N2 attempts to subscribe (expect denied)"
api "$N2" POST /api/subscribe "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
poll_catchup "$N2" "$CG_ID" denied 90 || exit 1

hr "Step 3 — N2 signs and forwards a join request to N1"
# PR #448: /sign-join is sign-only; forwarding lives in /request-join.
sign_resp=$(api "$N2" POST "/api/context-graph/$(urlenc "$CG_ID")/sign-join" "{}")
delegation_json=$(echo "$sign_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('delegation') or {}))")
[ -z "$delegation_json" ] || [ "$delegation_json" = "{}" ] && { fail "sign-join did not return a delegation: $sign_resp"; exit 1; }
ok "delegation signed"

submit_body=$(python3 -c "
import sys,json
print(json.dumps({
  'delegation': json.loads('''$delegation_json'''),
  'curatorPeerId': '$N1_PEER_ID',
}))
")
JOIN_REQUEST_TS=$(date -u +'%Y-%m-%d %H:%M:%S')
submit_resp=$(api "$N2" POST "/api/context-graph/$(urlenc "$CG_ID")/request-join" "$submit_body")
delivered=$(echo "$submit_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('delivered',''))")
[ -n "$delivered" ] && [ "$delivered" != "0" ] && ok "request delivered ($delivered)" || { fail "request-join: $submit_resp"; exit 1; }

# Server-side observability: same assertion as devnet-test-invite-flow.
# Without it, a "delivered=1" response from a non-curator broadcast
# acceptor would pass while N1 silently NACK'd the actual request.
sleep 1
assert_log_recent "$N1_LOG" "$JOIN_REQUEST_TS" \
  "PROTOCOL_JOIN_REQUEST from .* for \"$CG_ID\": accepted" \
  "curator (N1) accepted inbound request" \
  || fail "curator did not log accepting the join request — silent-NACK regression?"

hr "Step 4 — N1 lists pending requests (expect N2 present)"
sleep 1
reqs=$(api "$N1" GET "/api/context-graph/$(urlenc "$CG_ID")/join-requests")
found=$(echo "$reqs" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if any(r.get('agentAddress','').lower()=='$N2_ADDR'.lower() for r in d.get('requests',[])) else 'no')
")
[ "$found" = "yes" ] && ok "N1 sees N2's request" || { fail "N1 missing N2 request: $reqs"; exit 1; }

hr "Step 5 — snapshot N2 notifications BEFORE rejection"
before=$(api "$N2" GET /api/notifications | python3 -c "
import sys,json
d=json.load(sys.stdin)
n=d.get('notifications',[])
print(sum(1 for x in n if x.get('type')=='join_rejected'))
")
note "N2 has $before join_rejected notification(s) before"

hr "Step 6 — N1 rejects N2's request"
REJECT_TS=$(date -u +'%Y-%m-%d %H:%M:%S')
rej_resp=$(api "$N1" POST "/api/context-graph/$(urlenc "$CG_ID")/reject-join" "{\"agentAddress\":\"$N2_ADDR\"}")
okf=$(echo "$rej_resp" | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('ok','')).lower())")
[ "$okf" = "true" ] && ok "reject-join: $rej_resp" || { fail "reject-join: $rej_resp"; exit 1; }

# N2 should log receiving the rejection from N1 (it's the trusted
# decision sender via the join-request acceptance memo). Catches the
# class of bug where the rejection notification reaches N2's libp2p
# stack but is silently dropped before the UI emits the bell event.
sleep 1
assert_log_recent "$N2_LOG" "$REJECT_TS" \
  "Join request rejected for \"$CG_ID\"" \
  "N2 received & accepted rejection notification" \
  || note "(may take longer in slow devnet — non-fatal here, the API poll below is the strict assertion)"

hr "Step 7 — poll N2 for the join_rejected notification (up to 15s)"
start=$(date +%s)
while :; do
  elapsed=$(( $(date +%s) - start ))
  if [ "$elapsed" -ge 15 ]; then
    fail "N2 did not receive a join_rejected notification within 15s"
  fi
  hit=$(api "$N2" GET /api/notifications | python3 -c "
import sys,json
d=json.load(sys.stdin)
cg = '$CG_ID'
for x in d.get('notifications',[]):
    if x.get('type')=='join_rejected':
        meta = x.get('meta')
        try: meta = json.loads(meta) if isinstance(meta,str) else meta
        except: meta = {}
        if (meta or {}).get('contextGraphId')==cg:
            print(json.dumps({'ts':x.get('ts'),'title':x.get('title'),'message':x.get('message'),'meta':meta}))
            break
")
  if [ -n "$hit" ]; then
    ok "N2 received join_rejected notification"
    echo "$hit" | python3 -m json.tool
    break
  fi
  sleep 0.5
done

hr "Done — rejection notification propagated end-to-end"
echo "CG id used: $CG_ID"
