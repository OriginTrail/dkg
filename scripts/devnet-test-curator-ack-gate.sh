#!/usr/bin/env bash
# Strict curator-ack gate (OT-RFC-49 curator-leader) — devnet end-to-end proof.
#
# Proves the M2-b silent-loss fix: a member's write to a PRIVATE CG is durable
# iff the curator applied it. With the curator UP a member-owned write returns
# 200 AND lands on the curator; with the curator DOWN the same write returns
# HTTP 503 (curatorDelivery=unconfirmed) and is NOT persisted locally (no silent
# 200 that would be REPLACE-reverted on reconnect). Requires the devnet running
# with swmAwaitCuratorAck=true (devnet.sh sets it). Curator=node1, member=node2.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
TMPDIR="${TMPDIR:-/tmp}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CURATOR_NODE="${CURATOR_NODE:-1}"
MEMBER_NODE="${MEMBER_NODE:-2}"
PRED="http://example.org/ackgate"
STAMP="$(node -e 'process.stdout.write(String(Date.now()))')"

log()  { echo "[ackgate] $*"; }
fail() { echo "[ackgate] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[ackgate] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { grep -v '^#' "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
parse_json() { JQ_PATH="$2" node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const p=process.env.JQ_PATH.replace(/^\./,"").split(".");let v=j;for(const k of p)v=v?.[k];console.log(v==null?"":v)})' <<<"$1"; }

api_call() { # node method path [body]  → body on stdout, fails on non-2xx
  local node="$1" method="$2" path="$3" data="${4:-}" port token tmp code
  port=$(node_port "$node"); token=$(node_token "$node"); tmp="$(mktemp "$TMPDIR/ackgate-XXXXXX")"
  local -a args=(-sS --max-time 180 --connect-timeout 5 -o "$tmp" -w "%{http_code}" -X "$method"
    -H "Authorization: Bearer $token" -H "Content-Type: application/json")
  [ -n "$data" ] && args+=(--data "$data")
  code=$(curl "${args[@]}" "http://127.0.0.1:${port}${path}" || echo "000")
  cat "$tmp"; rm -f "$tmp"
  [[ "$code" =~ ^2 ]] || { echo "[ackgate] HTTP $code on $method $path" >&2; return 1; }
}

identity_field() { local body; body="$(api_call "$1" GET /api/agent/identity)"; parse_json "$body" ".$2"; }

# Member write that CAPTURES the HTTP status + curatorDelivery field.
# Prints: "<httpcode> <curatorDelivery|none>"
write_capture() { # node subj value
  local node="$1" subj="$2" value="$3" port token tmp code body cd payload
  port=$(node_port "$node"); token=$(node_token "$node"); tmp="$(mktemp "$TMPDIR/ackw-XXXXXX")"
  # Opt INTO the strict gate per-request (the agent default stays OFF — phase-1
  # rollout). This isolates the gate test from the M2-a converge test, which
  # deliberately relies on the legacy (gate-off) offline-write path.
  payload=$(CG="$CG_ID" R="$subj" P="$PRED" V="$value" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,awaitCuratorAck:true,quads:[{subject:process.env.R,predicate:process.env.P,object:JSON.stringify(process.env.V),graph:""}]}))')
  code=$(curl -sS --max-time 30 --connect-timeout 5 -o "$tmp" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    --data "$payload" "http://127.0.0.1:${port}/api/shared-memory/write" || echo "000")
  body="$(cat "$tmp")"; rm -f "$tmp"
  cd="$(parse_json "$body" ".curatorDelivery")"
  echo "$code ${cd:-none}"
}

post_capture() { # node path body → "<httpcode> <curatorDelivery|none>"
  local node="$1" path="$2" body="$3" port token tmp code resp cd
  port=$(node_port "$node"); token=$(node_token "$node"); tmp="$(mktemp "$TMPDIR/ackp-XXXXXX")"
  code=$(curl -sS --max-time 30 --connect-timeout 5 -o "$tmp" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    --data "$body" "http://127.0.0.1:${port}${path}" || echo "000")
  resp="$(cat "$tmp")"; rm -f "$tmp"; cd="$(parse_json "$resp" ".curatorDelivery")"
  echo "$code ${cd:-none}"
}

swm_values() { # node subj → JSON array of distinct values
  local node="$1" subj="$2" q
  q=$(CG="$CG_ID" R="$subj" P="$PRED" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,graphSuffix:"_shared_memory",sparql:`SELECT DISTINCT ?v WHERE { GRAPH ?g { <${process.env.R}> <${process.env.P}> ?v } }`}))')
  api_call "$node" POST /api/query "$q" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const b=j?.result?.bindings??j?.bindings??[];const vals=b.map(r=>String((r.v&&r.v.value)??r.v??"").replace(/^"|"$/g,"")).filter(Boolean).sort();console.log(JSON.stringify(vals))})'
}

wait_up()   { local p; p=$(node_port "$1"); for _ in $(seq 1 240); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null && return 0; sleep 0.5; done; fail "node $1 never came up"; }
wait_down() { local p; p=$(node_port "$1"); for _ in $(seq 1 60);  do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null || return 0; sleep 0.5; done; fail "node $1 still up"; }
stop_node() { # robust: kill the pid-file supervisor AND any orphan on the API port
  local n="$1" pidf port pids
  pidf="$DEVNET_DIR/node${n}/devnet.pid"; port=$(node_port "$n")
  pids=$({ [ -f "$pidf" ] && cat "$pidf"; lsof -ti "tcp:$port" 2>/dev/null; } | sort -u)
  for pid in $pids; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 15); do lsof -ti "tcp:$port" >/dev/null 2>&1 || break; sleep 1; done
  for pid in $(lsof -ti "tcp:$port" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
  rm -f "$pidf"; wait_down "$n"
}
start_node() { "$REPO_ROOT/scripts/devnet.sh" restart-node "$1" >/dev/null 2>&1 || true; wait_up "$1"; }
await_values() { local node="$1" subj="$2" want="$3" n="${4:-60}" got; for _ in $(seq 1 "$n"); do got="$(swm_values "$node" "$subj")"; [ "$got" = "$want" ] && { echo "$got"; return 0; }; sleep 1; done; echo "$got"; return 1; }

[ -n "$(node_token "$CURATOR_NODE")" ] || fail "curator node token missing — start the devnet first"
CURATOR_AGENT="$(identity_field "$CURATOR_NODE" agentAddress)"
MEMBER_AGENT="$(identity_field "$MEMBER_NODE" agentAddress)"
[ -n "$CURATOR_AGENT" ] && [ -n "$MEMBER_AGENT" ] || fail "could not resolve agent identities"
CG_ID="${CURATOR_AGENT}/ackgate-${STAMP}"
ALLOWED='["'"$CURATOR_AGENT"'", "'"$MEMBER_AGENT"'"]'
ROOT="urn:ackgate:root"
log "curator=$CURATOR_AGENT (node$CURATOR_NODE)  member=$MEMBER_AGENT (node$MEMBER_NODE)"
log "cg=$CG_ID  root=$ROOT (member-owned)"

act "0. create private CG (curator registers; member pre-creates) + subscribe"
CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "{ \"id\": \"$CG_ID\", \"name\": \"ackgate $STAMP\", \"accessPolicy\": 1, \"publishPolicy\": 0, \"allowedAgents\": $ALLOWED, \"register\": true }")
parse_json "$CREATE" ".onChainId" >/dev/null 2>&1 || true
api_call "$MEMBER_NODE" POST /api/context-graph/create "{ \"id\": \"$CG_ID\", \"name\": \"ackgate $STAMP (member)\", \"accessPolicy\": 1, \"publishPolicy\": 0, \"allowedAgents\": $ALLOWED }" >/dev/null || true
api_call "$CURATOR_NODE" POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}" >/dev/null
api_call "$MEMBER_NODE"  POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}" >/dev/null
sleep 3

act "A. curator UP: member-owned write must CONFIRM (200) and land on the curator"
RES="$(write_capture "$MEMBER_NODE" "$ROOT" "v1")"
log "member write (curator up) -> HTTP+delivery: $RES"
[ "${RES%% *}" = "200" ] || fail "expected 200 with curator up, got: $RES"
[ "$(swm_values "$MEMBER_NODE" "$ROOT")" = '["v1"]' ] || fail "member should hold v1 (got $(swm_values "$MEMBER_NODE" "$ROOT"))"
GOTC="$(await_values "$CURATOR_NODE" "$ROOT" '["v1"]' 30)" || fail "curator never received the confirmed write (got $GOTC) — gate did not actually deliver"
log "curator received v1 ✓ (the gate's reliable send delivered + applied)"

act "B. curator DOWN: member-owned write must be REJECTED (503) and NOT persisted"
stop_node "$CURATOR_NODE"
log "curator stopped"
RES="$(write_capture "$MEMBER_NODE" "$ROOT" "v2")"
log "member write (curator down) -> HTTP+delivery: $RES"
CODE="${RES%% *}"; DELIV="${RES##* }"
[ "$CODE" = "503" ] || fail "expected HTTP 503 with curator down, got: $RES (the silent-200 bug is NOT fixed)"
[ "$DELIV" = "unconfirmed" ] || fail "expected curatorDelivery=unconfirmed, got: $RES"
AFTER="$(swm_values "$MEMBER_NODE" "$ROOT")"
[ "$AFTER" = '["v1"]' ] || fail "NO-PERSIST violated: member should still hold ONLY v1, got $AFTER (v2 leaked into the local store)"
log "member still holds [v1], v2 was NOT persisted ✓ (no silent state)"

act "C. curator back UP: the same write now CONFIRMS again"
start_node "$CURATOR_NODE"; sleep 3
RES="$(write_capture "$MEMBER_NODE" "$ROOT" "v2")"
log "member write (curator up again) -> HTTP+delivery: $RES"
[ "${RES%% *}" = "200" ] || fail "expected 200 after curator restart, got: $RES"
GOTC="$(await_values "$CURATOR_NODE" "$ROOT" '["v2"]' 30)" || fail "curator never received v2 after restart (got $GOTC)"
[ "$(swm_values "$MEMBER_NODE" "$ROOT")" = '["v2"]' ] || fail "member should hold v2"
log "curator + member both [v2] ✓"

act "D. PROMOTE path (WM→SWM via /knowledge-assets/:name/swm/share — the path the original silent-loss counterexample used)"
KA1="kapromote-a-$STAMP"; KA2="kapromote-b-$STAMP"; KAROOT1="urn:ackgate:ka1"; KAROOT2="urn:ackgate:ka2"
# D1. curator UP: create a WM draft, then promote → must CONFIRM (200) and land on curator
api_call "$MEMBER_NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG_ID\",\"name\":\"$KA1\",\"quads\":[{\"subject\":\"$KAROOT1\",\"predicate\":\"$PRED\",\"object\":\"\\\"pv1\\\"\",\"graph\":\"\"}]}" >/dev/null || fail "WM create (KA1) failed"
RES="$(post_capture "$MEMBER_NODE" "/api/knowledge-assets/$KA1/swm/share" "{\"contextGraphId\":\"$CG_ID\",\"awaitCuratorAck\":true}")"
log "promote (curator up) -> HTTP+delivery: $RES"
[ "${RES%% *}" = "200" ] || fail "expected 200 promote with curator up, got: $RES"
GOTC="$(await_values "$CURATOR_NODE" "$KAROOT1" '["pv1"]' 30)" || fail "curator never received the promoted KA (got $GOTC)"
log "curator received the promoted KA ✓"
# D2. curator DOWN: create another WM draft, promote → must be REJECTED (503) and NOT in SWM
stop_node "$CURATOR_NODE"; log "curator stopped"
api_call "$MEMBER_NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG_ID\",\"name\":\"$KA2\",\"quads\":[{\"subject\":\"$KAROOT2\",\"predicate\":\"$PRED\",\"object\":\"\\\"pv2\\\"\",\"graph\":\"\"}]}" >/dev/null || fail "WM create (KA2) failed"
RES="$(post_capture "$MEMBER_NODE" "/api/knowledge-assets/$KA2/swm/share" "{\"contextGraphId\":\"$CG_ID\",\"awaitCuratorAck\":true}")"
log "promote (curator down) -> HTTP+delivery: $RES"
[ "${RES%% *}" = "503" ] || fail "expected 503 promote with curator down, got: $RES (promote path NOT gated)"
[ "$(swm_values "$MEMBER_NODE" "$KAROOT2")" = '[]' ] || fail "NO-PERSIST violated: promoted KA2 leaked into SWM (got $(swm_values "$MEMBER_NODE" "$KAROOT2"))"
log "promote aborted, KA2 NOT in SWM (WM intact) ✓"
start_node "$CURATOR_NODE"; sleep 3

echo ""
log "GATE PASS — strict curator-ack on BOTH paths:"
log "  • share()  (/api/shared-memory/write): confirmed→200+durable, unconfirmed→503 no-persist"
log "  • promote  (/knowledge-assets/:name/swm/share): confirmed→200+durable, unconfirmed→503 no-persist"
log "  The silent-200 same-root loss (M2-b gap) is closed for the SWM write + promote paths."
