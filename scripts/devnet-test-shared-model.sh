#!/usr/bin/env bash
#
# End-to-end test of shared curator AI-model access (PR #1157) over a devnet,
# including the M1 hardening fixes (PR #1158):
#   B1 — membership gate: a REMOVED member must be DENIED (the canonical
#        approved-delegatee-peer set, not the pre-approval/self-asserted one).
#   B2 — invoke timeout: a slow upstream provider (>20s, the old router
#        default) must still return a completion (opt-in, TEST_B2=1).
#
# Drives 2 devnet nodes over HTTP:
#   N1 (port 9201) — curator; serves the shared model, owns a private CG
#   N2 (port 9202) — member; joins via a genuine pending join, then invokes
#
# Faithful-path requirements this script encodes (all code-confirmed):
#   * invoke is issued against the MEMBER node (N2), never the curator —
#     otherwise the local fast-path hardcodes isMember:true and the P2P
#     membership gate is never exercised.
#   * membership is established via the genuine sign-join -> request-join
#     (pending) -> approve-join handshake (NOT invite-with-model, which does
#     not write the delegatee-peer binding the gate checks).
#   * N2 is never pre-allowlisted, so the join is a real `pending` (an
#     already-member short-circuit would skip the post-approval _meta sync).
#   * the script does NOT call /subscribe before the grant lands.
#
# Assumes `./scripts/devnet.sh start 2` (or more) is running. By default the
# script (re)starts node1 with DEVNET_SHARED_MODEL=1 (mock provider) so the
# curator serves invokes; set SKIP_CONFIG=1 if you configured sharing yourself.
#
# Env:
#   SKIP_CONFIG=1   do not touch node1 config / restart (you pre-configured it)
#   TEST_B2=1       also run the slow-upstream timeout check (B2)
#   B2_SLEEP=25     seconds the slow stub waits before responding (>20, <110)
#   STUB_PORT=9777  port for the local slow openai-compatible stub
#   DEVNET_TOKEN / DKG_AUTH   override the auth token (else read from devnet)

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVNET_DIR="$SCRIPT_DIR/../.devnet"

N1=http://127.0.0.1:9201
N2=http://127.0.0.1:9202
N1_ADDR=""; N2_ADDR=""; N1_PEER_ID=""

TEST_B2="${TEST_B2:-}"
B2_SLEEP="${B2_SLEEP:-25}"
STUB_PORT="${STUB_PORT:-9777}"
STUB_PID=""
MODE="mock"; [ "$TEST_B2" = "1" ] && MODE="b2-slow-provider"

CG_ID="shared-model-test-$(date +%s)"

# Resolve the devnet auth token the same way the sibling scripts do.
if [[ -n "${DEVNET_TOKEN:-}" ]]; then
  TOKEN="$DEVNET_TOKEN"
elif [[ -n "${DKG_AUTH:-}" ]]; then
  TOKEN="$DKG_AUTH"
elif [[ -f "$DEVNET_DIR/node1/auth.token" ]]; then
  TOKEN="$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" 2>/dev/null | tr -d '[:space:]')"
else
  echo "ERROR: No auth token. Export DEVNET_TOKEN/DKG_AUTH or run ./scripts/devnet.sh start" >&2
  exit 2
fi

hr()   { printf '\n\033[1;34m── %s ──\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m✗\033[0m %s\n' "$*"; cleanup; exit 1; }
note() { printf '  \033[0;90m· %s\033[0m\n' "$*"; }

cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; }
trap cleanup EXIT

api() {
  local node="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "${node}${path}" -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" --data "$body"
  else
    curl -sS -X "$method" "${node}${path}" -H "Authorization: Bearer $TOKEN"
  fi
}
urlenc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }
jget()   { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: print(''); sys.exit(0)
cur=d
for k in sys.argv[1].split('.'):
    cur=cur.get(k) if isinstance(cur,dict) else None
print('' if cur is None else cur)" "$1"; }

identify() {
  for i in 1 2; do
    local url; url=$(eval echo "\$N${i}")
    local self; self=$(api "$url" GET /api/agents | python3 -c "
import sys,json
d=json.load(sys.stdin)
for a in d.get('agents',[]):
    if a.get('connectionStatus')=='self':
        print(json.dumps({'addr':a.get('agentAddress',''),'peer':a.get('peerId','')})); break
")
    local addr peer
    addr=$(echo "$self" | jget addr); peer=$(echo "$self" | jget peer)
    [ -z "$addr" ] && fail "N$i: could not fetch agent address (is the devnet up?)"
    eval "N${i}_ADDR=\"$addr\""; eval "N${i}_PEER_ID=\"$peer\""
    ok "N$i: $addr (peer $peer)"
  done
}

wait_node_ready() {
  local node="$1" start; start=$(date +%s)
  while :; do
    if api "$node" GET /api/status >/dev/null 2>&1; then ok "node ready: $node"; return 0; fi
    [ $(( $(date +%s) - start )) -ge 60 ] && fail "node not ready after 60s: $node"
    sleep 1.5
  done
}

start_slow_stub() {
  hr "B2 — starting slow openai-compatible stub on :$STUB_PORT (sleeps ${B2_SLEEP}s)"
  python3 - "$STUB_PORT" "$B2_SLEEP" >/dev/null 2>&1 <<'PY' &
import sys, json, time
from http.server import BaseHTTPRequestHandler, HTTPServer
port, sleep = int(sys.argv[1]), float(sys.argv[2])
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); self.rfile.read(n)
        time.sleep(sleep)
        body = json.dumps({"choices":[{"message":{"content":"slow-pong"}}],"model":"slow-stub"}).encode()
        self.send_response(200); self.send_header('content-type','application/json')
        self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', port), H).serve_forever()
PY
  STUB_PID=$!
  sleep 1
  ok "stub pid $STUB_PID"
}

# (Re)configure node1 as a sharing curator and restart it so config regenerates
# WITH the sharedModel block (restart-node re-runs create_node_config).
ensure_curator_config() {
  if [ "${SKIP_CONFIG:-}" = "1" ]; then
    note "SKIP_CONFIG=1 — assuming node1 already has sharedModel enabled"
    return 0
  fi
  hr "Configure curator (node1) for sharing — provider=$([ "$TEST_B2" = "1" ] && echo openai-compatible || echo mock)"
  export DEVNET_SHARED_MODEL=1
  if [ "$TEST_B2" = "1" ]; then
    start_slow_stub
    export DEVNET_SHARED_MODEL_PROVIDER=openai-compatible
    export DEVNET_SHARED_MODEL_MODEL=slow-stub
    export DEVNET_SHARED_MODEL_BASEURL="http://127.0.0.1:${STUB_PORT}/v1"
  else
    export DEVNET_SHARED_MODEL_PROVIDER=mock
  fi
  "$SCRIPT_DIR/devnet.sh" restart-node 1 >/dev/null 2>&1 || fail "restart-node 1 failed"
  wait_node_ready "$N1"
}

# Genuine sign-join -> request-join(pending) -> approve-join, then poll the
# member's grant until the curated _meta (curator triples + grant) has synced.
establish_membership() {
  local enc; enc=$(urlenc "$CG_ID")

  hr "Member signs a join delegation (binds N2 peer id)"
  local deleg; deleg=$(api "$N2" POST "/api/context-graph/$enc/sign-join" "{}" \
    | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('delegation') or {}))")
  { [ -z "$deleg" ] || [ "$deleg" = "{}" ]; } && fail "sign-join returned no delegation"
  ok "delegation signed"

  hr "Member submits a GENUINE pending join over P2P"
  local sb; sb=$(python3 -c "import json; print(json.dumps({'delegation': json.loads('''$deleg'''), 'curatorPeerId': '$N1_PEER_ID'}))")
  local resp; resp=$(api "$N2" POST "/api/context-graph/$enc/request-join" "$sb")
  local delivered; delivered=$(echo "$resp" | jget delivered)
  local status; status=$(echo "$resp" | jget status)
  note "request-join: delivered=$delivered status=$status"
  [ "$status" = "already-member" ] && fail "join short-circuited as already-member — N2 must not be pre-allowlisted"

  hr "Curator sees the pending request"
  local found; found=$(api "$N1" GET "/api/context-graph/$enc/join-requests" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if any(r.get('agentAddress','').lower()=='$N2_ADDR'.lower() for r in d.get('requests',[])) else 'no')")
  [ "$found" = "yes" ] && ok "curator sees N2's pending request" || fail "N2 request not pending on curator: re-run, it must be a fresh join"

  hr "Curator approves (writes allowedDelegateePeer=N2; triggers post-approval _meta sync)"
  local ar; ar=$(api "$N1" POST "/api/context-graph/$enc/approve-join" "{\"agentAddress\":\"$N2_ADDR\"}")
  note "approve-join: $ar"

  hr "Member polls grant until _meta has synced (enabled:true)"
  local start; start=$(date +%s)
  while :; do
    local g; g=$(api "$N2" GET "/api/context-graph/$enc/model/grant")
    [ "$(echo "$g" | jget enabled)" = "True" ] && { ok "grant synced to member: $g"; break; }
    [ $(( $(date +%s) - start )) -ge 90 ] && fail "grant did not sync to member within 90s (last: $g)"
    sleep 2
  done
}

###############################################################################

hr "Shared curator AI-model access — devnet e2e (mode: $MODE, CG: $CG_ID)"
identify
ensure_curator_config

hr "Curator creates a PRIVATE (curated) CG, allowlist = [curator only]"
create_body=$(python3 -c "import json; print(json.dumps({'id':'$CG_ID','name':'Shared-model test $CG_ID','description':'shared-model e2e','accessPolicy':1,'allowedAgents':['$N1_ADDR']}))")
cr=$(api "$N1" POST /api/context-graph/create "$create_body")
[ "$(echo "$cr" | jget created)" = "$CG_ID" ] && ok "CG created" || fail "create failed: $cr"

hr "Curator enables model sharing for the CG"
enc=$(urlenc "$CG_ID")
sr=$(api "$N1" POST "/api/context-graph/$enc/model/share" '{"enabled":true}')
[ "$(echo "$sr" | jget ok)" = "True" ] && ok "model/share: $sr" || fail "model/share failed: $sr"
gr=$(api "$N1" GET "/api/context-graph/$enc/model/grant")
[ "$(echo "$gr" | jget enabled)" = "True" ] && ok "curator grant enabled (model: $(echo "$gr" | jget modelId))" || fail "grant not enabled on curator: $gr"

establish_membership

hr "Member invokes the curator's model over P2P (the real gate)"
inv=$(api "$N2" POST "/api/context-graph/$enc/model/invoke" '{"messages":[{"role":"user","content":"ping-from-member-42"}]}')
[ "$(echo "$inv" | jget ok)" = "True" ] || fail "invoke denied unexpectedly: $inv"
content=$(echo "$inv" | jget content)
if [ "$TEST_B2" = "1" ]; then
  echo "$content" | grep -q "slow-pong" && ok "B2: slow provider returned a completion: \"$content\"" \
    || fail "B2: expected slow-pong, got: $inv"
else
  echo "$content" | grep -q "ping-from-member-42" && echo "$content" | grep -q "\[shared-model:" \
    && ok "invoke ok, mock echoed prompt: \"$content\"" || fail "unexpected mock content: $inv"
fi

# OpenAI-compatible surface (mock mode only — keeps the B2 path to one slow call)
if [ "$TEST_B2" != "1" ]; then
  hr "Member invokes via the OpenAI-compatible endpoint"
  oai=$(api "$N2" POST "/api/context-graph/$enc/model/v1/chat/completions" \
    '{"model":"probe","messages":[{"role":"user","content":"openai-path-check"}]}')
  [ "$(echo "$oai" | jget object)" = "chat.completion" ] || fail "OpenAI endpoint shape wrong: $oai"
  oc=$(echo "$oai" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content',''))")
  echo "$oc" | grep -q "openai-path-check" && ok "OpenAI-compatible completion: \"$oc\"" || fail "OpenAI content wrong: $oai"
fi

# ---- B1 regression: a removed member must now be DENIED ----
hr "B1 — curator removes the member, then member re-invokes (must be DENIED)"
rm=$(api "$N1" POST "/api/context-graph/$enc/remove-participant" "{\"agentAddress\":\"$N2_ADDR\"}")
[ "$(echo "$rm" | jget ok)" = "True" ] && ok "remove-participant: $rm" || fail "remove-participant failed: $rm"

start=$(date +%s)
while :; do
  inv2=$(api "$N2" POST "/api/context-graph/$enc/model/invoke" '{"messages":[{"role":"user","content":"after-removal"}]}')
  okf=$(echo "$inv2" | jget ok); denied=$(echo "$inv2" | jget denied)
  if [ "$okf" = "False" ] && echo "$denied" | grep -qi "not a member"; then
    ok "B1 PASS: removed member denied — \"$denied\""
    break
  fi
  if [ "$okf" = "True" ]; then
    fail "B1 FAIL: removed member STILL got a completion (this is the pre-patch auth bypass): $inv2"
  fi
  [ $(( $(date +%s) - start )) -ge 15 ] && fail "B1: unexpected response after removal: $inv2"
  sleep 1.5
done

hr "Done — shared-model e2e passed (mode: $MODE)"
echo "CG id used: $CG_ID"
[ "$TEST_B2" = "1" ] && note "B2 proved the invoke survived a ${B2_SLEEP}s upstream; on the unpatched build this returns 'curator node unreachable' at ~20s."
