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

identify() {
  for i in 1 2; do
    local api_url
    api_url=$(eval echo "\$N${i}")
    local self
    self=$(api "$api_url" GET /api/agents | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
    if a.get('connectionStatus')=='self':
        print(a.get('agentAddress','')); break
")
    if [ -z "$self" ]; then fail "N$i: could not fetch agent address"; exit 1; fi
    eval "N${i}_ADDR=\"$self\""
    ok "N$i agent address: $self"
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
resp=$(api "$N1" POST /api/paranet/create "$body")
created=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('created',''))")
[ "$created" = "$CG_ID" ] && ok "CG created on N1" || { fail "create failed: $resp"; exit 1; }

hr "Step 2 — N2 attempts to subscribe (expect denied)"
api "$N2" POST /api/subscribe "{\"contextGraphId\":\"$CG_ID\"}" > /dev/null
poll_catchup "$N2" "$CG_ID" denied 90 || exit 1

hr "Step 3 — N2 signs and forwards a join request to N1"
sign_resp=$(api "$N2" POST "/api/context-graph/$(urlenc "$CG_ID")/sign-join" "{}")
sent=$(echo "$sign_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
[ "$sent" = "sent" ] && ok "request delivered" || { fail "sign-join: $sign_resp"; exit 1; }

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
rej_resp=$(api "$N1" POST "/api/context-graph/$(urlenc "$CG_ID")/reject-join" "{\"agentAddress\":\"$N2_ADDR\"}")
okf=$(echo "$rej_resp" | python3 -c "import sys,json; print(str(json.load(sys.stdin).get('ok','')).lower())")
[ "$okf" = "true" ] && ok "reject-join: $rej_resp" || { fail "reject-join: $rej_resp"; exit 1; }

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
