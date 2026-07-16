#!/usr/bin/env bash
#
# Shared-memory recovery regression (per-KA-graph REPLACE, not blind union).
#
# Proves a member that fell behind recovers its private shared memory to the
# CURRENT state from one chosen authoritative peer — replacing the stale value,
# never unioning it. Reproduces the union-corruption the recovery layer fixes:
#
#   1. Node 1 shares a root into the CG's shared memory with status/name = "v1".
#   2. Node 2 subscribes and catches up — it now holds "v1".
#   3. Node 2 is stopped (so it misses the next update).
#   4. Node 1 updates the same root to "v2".
#   5. Node 2 is restarted — it still holds the stale "v1".
#   6. Node 2 calls POST /api/context-graph/recover-shared-memory pointing at
#      Node 1's peerId.
#   7. Node 2's shared memory must read EXACTLY ["v2"] — the REPLACE applied.
#      A blind union (the bug) would leave {"v1","v2"}; this asserts it does not.
#
# Preconditions (run a devnet free of your other one — this resets
# localhost_contracts.json and binds HARDHAT_PORT, default 8545):
#   ./scripts/devnet.sh clean
#   ./scripts/devnet.sh start 2
#
# Uses only the daemon HTTP API.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CONTEXT_GRAPH="${CONTEXT_GRAPH:-devnet-test}"
OWNER_NODE="${OWNER_NODE:-1}"
MEMBER_NODE="${MEMBER_NODE:-2}"
TMPDIR="${TMPDIR:-/tmp}"

SCHEMA_NAME="http://schema.org/name"
ROOT="urn:swm:recovery-root"

log()  { echo "[swm-rec] $*"; }
fail() { echo "[swm-rec] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[swm-rec] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { grep -v '^#' "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

require_node() {
  [ -d "$(node_dir "$1")" ] || fail "node $1 home missing; run ./scripts/devnet.sh start 2 first"
  [ -n "$(node_token "$1")" ] || fail "node $1 auth token missing"
}

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port token tmp code
  port=$(node_port "$node"); token=$(node_token "$node")
  tmp="$(mktemp "$TMPDIR/swm-rec-XXXXXX")"
  local -a args=(-sS --max-time 180 --connect-timeout 5 -o "$tmp" -w "%{http_code}" -X "$method"
    -H "Authorization: Bearer $token" -H "Content-Type: application/json")
  [ -n "$data" ] && args+=(--data "$data")
  code=$(curl "${args[@]}" "http://127.0.0.1:${port}${path}" || echo "000")
  cat "$tmp"; rm -f "$tmp"
  [[ "$code" =~ ^2 ]] || { echo "[swm-rec] HTTP $code on $method $path" >&2; return 1; }
}

parse_json() { JQ_PATH="$2" node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const p=process.env.JQ_PATH.replace(/^\./,"").split(".");let v=j;for(const k of p)v=v?.[k];console.log(v==null?"":v)})' <<<"$1"; }

swm_values() {
  # DISTINCT object values for ROOT under the CG's _shared_memory graph on $1
  local node="$1"
  local q
  q=$(CG="$CONTEXT_GRAPH" R="$ROOT" P="$SCHEMA_NAME" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,graphSuffix:"_shared_memory",sparql:`SELECT DISTINCT ?v WHERE { <${process.env.R}> <${process.env.P}> ?v }`}))')
  api_call "$node" POST /api/query "$q" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const b=j?.result?.bindings??j?.bindings??[];const vals=b.map(r=>String((r.v&&r.v.value)??r.v??"").replace(/^"|"$/g,"")).filter(Boolean).sort();console.log(JSON.stringify(vals))})'
}

wait_down() { local p; p=$(node_port "$1"); for _ in $(seq 1 60); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null || return 0; sleep 0.5; done; fail "node $1 still up"; }
wait_up()   { local p; p=$(node_port "$1"); for _ in $(seq 1 240); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null && return 0; sleep 0.5; done; fail "node $1 never came up"; }

# Share ROOT into shared memory with a given value via the KA -> WM -> SWM flow.
share_value() {
  local node="$1" value="$2" ka
  ka="rec-$(date +%s)-$RANDOM"
  api_call "$node" POST /api/knowledge-assets "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$ka\"}" >/dev/null
  local payload
  payload=$(CG="$CONTEXT_GRAPH" R="$ROOT" P="$SCHEMA_NAME" V="$value" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,quads:[{subject:process.env.R,predicate:process.env.P,object:JSON.stringify(process.env.V),graph:""}]}))')
  api_call "$node" POST "/api/knowledge-assets/${ka}/wm/write" "$payload" >/dev/null
  api_call "$node" POST "/api/knowledge-assets/${ka}/wm/finalize" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" >/dev/null
  api_call "$node" POST "/api/knowledge-assets/${ka}/swm/share" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" >/dev/null
}

require_node "$OWNER_NODE"; require_node "$MEMBER_NODE"
OWNER_PEER=$(api_call "$OWNER_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
[ -n "$OWNER_PEER" ] || fail "could not resolve owner peerId"
log "owner(node $OWNER_NODE) peerId=$OWNER_PEER  member=node $MEMBER_NODE  cg=$CONTEXT_GRAPH"

act "1. both nodes subscribe to the CG"
api_call "$OWNER_NODE"  POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"includeSharedMemory\":true}" >/dev/null
api_call "$MEMBER_NODE" POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"includeSharedMemory\":true}" >/dev/null
sleep 3

act "2. owner shares ROOT=v1; member catches up"
share_value "$OWNER_NODE" "v1"
sleep 5
[ "$(swm_values "$MEMBER_NODE")" = '["v1"]' ] || fail "member did not receive v1 (got $(swm_values "$MEMBER_NODE"))"
log "member holds v1 ✓"

act "3. stop member, owner updates ROOT=v2"
"$REPO_ROOT/scripts/devnet.sh" stop "$MEMBER_NODE" 2>/dev/null || true
wait_down "$MEMBER_NODE"
share_value "$OWNER_NODE" "v2"
sleep 3
[ "$(swm_values "$OWNER_NODE")" = '["v2"]' ] || fail "owner not at v2 (got $(swm_values "$OWNER_NODE"))"
log "owner at v2, member offline ✓"

act "4. restart member — still stale at v1"
"$REPO_ROOT/scripts/devnet.sh" start-node "$MEMBER_NODE" 2>/dev/null || "$REPO_ROOT/scripts/devnet.sh" start 2 >/dev/null 2>&1 || true
wait_up "$MEMBER_NODE"
sleep 2
MEMBER_BEFORE="$(swm_values "$MEMBER_NODE")"
log "member before recovery: $MEMBER_BEFORE"

act "5. member recovers from the owner (explicit REPLACE)"
api_call "$MEMBER_NODE" POST /api/context-graph/recover-shared-memory \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"remotePeerId\":\"$OWNER_PEER\"}" >/dev/null
sleep 2

act "6. assert REPLACE — member holds EXACTLY [v2], never {v1,v2}"
AFTER="$(swm_values "$MEMBER_NODE")"
log "member after recovery: $AFTER"
[ "$AFTER" = '["v2"]' ] || fail "expected [\"v2\"] after recovery, got $AFTER (a blind union would be [\"v1\",\"v2\"])"
echo ""
log "PASS — recovery REPLACED the stale value (v1 -> v2), no union corruption."
