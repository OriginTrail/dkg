#!/usr/bin/env bash
# RFC-38 unclean Core restart under the release-native RFC-64 catalog.
# Private graph data stays off Cores. Kill a Core after a large member
# delivery, then prove the member retains history, new shares still arrive,
# and the Core remains free of the graph's private ciphertext.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/devnet-publish-helpers.sh"
source "$SCRIPT_DIR/devnet-curated-join-helpers.sh"
DEVNET_DIR=${DEVNET_DIR:-$REPO_ROOT/.devnet}
API_PORT_BASE=9201
CURATOR_NODE=5
M1_NODE=6
CORE_NODE=1
WRITES_COUNT=${WRITES_COUNT:-1000}
WRITE_PAYLOAD_BYTES=${WRITE_PAYLOAD_BYTES:-32768}
WRITES_PER_BATCH=${WRITES_PER_BATCH:-100}
# Preserve each batch as one KA. Splitting by root turns this 1,000-triple
# Core-restart stress into 1,000 catalog updates; 100 x 32 KiB also stays
# below the sealed assertion's 4 MiB gossip payload limit.
export DEVNET_PUBLISH_PRESERVE_BATCH=1

log() { echo "[urr] $*"; }
warn() { echo "[urr] WARN: $*" >&2; }
fail() { echo "[urr] FAIL: $*" >&2; exit 1; }
act() { echo ""; log "=== $1 ==="; }
node_dir() { echo "$DEVNET_DIR/node$1"; }
node_port() { echo $((API_PORT_BASE + $1 - 1)); }
node_token() { tail -1 "$(node_dir "$1")/auth.token" | tr -d '\r\n'; }
parse_json() { printf '%s' "$1" | jq -r "$2"; }

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 22 ] || fail "Node 22+ is required for the devnet daemon (found Node $NODE_MAJOR)"
[[ "$WRITES_COUNT" =~ ^[1-9][0-9]*$ ]] || fail "WRITES_COUNT must be positive"
[[ "$WRITE_PAYLOAD_BYTES" =~ ^[1-9][0-9]*$ ]] || fail "WRITE_PAYLOAD_BYTES must be positive"
[[ "$WRITES_PER_BATCH" =~ ^[1-9][0-9]*$ ]] || fail "WRITES_PER_BATCH must be positive"
[ "$WRITES_PER_BATCH" -le 200 ] || fail "WRITES_PER_BATCH must be <=200 to fit MAX_BODY_BYTES"

api_call() {
  local node="$1" method="$2" path="$3" body="${4:-}"
  local token; token=$(node_token "$node")
  if [ -n "$body" ]; then
    printf '%s' "$body" | curl -sS --max-time 240 -X "$method" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d @- "http://127.0.0.1:$(node_port "$node")$path"
  else
    curl -sS --max-time 240 -X "$method" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      "http://127.0.0.1:$(node_port "$node")$path"
  fi
}

CORE_WAS_KILLED=0
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ "$CORE_WAS_KILLED" -eq 1 ] &&
     ! curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$(node_port "$CORE_NODE")/api/status" 2>/dev/null; then
    bash "$SCRIPT_DIR/devnet.sh" restart-node "$CORE_NODE" >/dev/null 2>&1 ||
      { warn "cleanup could not restart Core"; result=1; }
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

count_triples() {
  local node="$1" response
  response=$(api_call "$node" POST /api/query \
    "$(jq -nc --arg cg "$CG_ID" '{contextGraphId:$cg,graphSuffix:"_shared_memory",sparql:"SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/note> ?o }"}')")
  printf '%s' "$response" | jq -r '.result.bindings[0].n // .result.bindings[0].cnt // empty' \
    | sed -nE 's/^"?([0-9]+).*/\1/p'
}

wait_for_member_count() {
  local target="$1" count=""
  for _ in $(seq 1 90); do
    count=$(count_triples "$M1_NODE" 2>/dev/null || true)
    if [[ "$count" =~ ^[0-9]+$ ]] && [ "$count" -ge "$target" ]; then
      printf '%s\n' "$count"
      return 0
    fi
    sleep 2
  done
  fail "member never reached $target private triples (last count=${count:-unreadable})"
}

core_stats_entry_count() {
  local cg="$1" wire="$2"
  jq -er --arg cg "$cg" --arg wire "$wire" '
    def count($key):
      if (.perCg | has($key)) then
        .perCg[$key].entries as $entries
        | if (($entries | type) == "number" and $entries >= 0 and ($entries | floor) == $entries)
          then $entries
          else error("invalid host-mode entry count") end
      else 0 end;
    if (.enabled == true and (.perCg | type) == "object") then
      count($cg) + count($wire)
    else error("host-mode diagnostics unavailable") end
  '
}

# A missing graph key means zero custody only when the Core reports a healthy,
# enabled host-mode store. Keep this distinction under test on every run.
assert_core_stats_fixtures() {
  local healthy
  healthy=$(printf '%s' '{"enabled":true,"perCg":{}}' | core_stats_entry_count fixture wire)
  [ "$healthy" = 0 ] || fail "healthy empty host-mode stats fixture did not count as zero"
  if printf '%s' '{"enabled":false,"perCg":{}}' | core_stats_entry_count fixture wire >/dev/null 2>&1; then
    fail "disabled host-mode stats fixture counted as zero"
  fi
  if printf '%s' '{"error":"host-mode store failed"}' | core_stats_entry_count fixture wire >/dev/null 2>&1; then
    fail "errored host-mode stats fixture counted as zero"
  fi
  if printf '%s' '{"enabled":true,"perCg":[]}' | core_stats_entry_count fixture wire >/dev/null 2>&1; then
    fail "malformed host-mode stats fixture counted as zero"
  fi
  if printf '%s' '{"enabled":true,"perCg":{"fixture":{}}}' | core_stats_entry_count fixture wire >/dev/null 2>&1; then
    fail "malformed graph entry fixture counted as zero"
  fi
}
assert_core_stats_fixtures

core_private_entries() {
  local response status stats
  response=$(curl -sS --max-time 30 -w '\n%{http_code}' \
    -H "Authorization: Bearer $(node_token "$CORE_NODE")" \
    "http://127.0.0.1:$(node_port "$CORE_NODE")/api/shared-memory/host-mode/stats") ||
    fail "Core host-mode diagnostics request failed"
  status=${response##*$'\n'}
  [ "$status" = 200 ] || fail "Core host-mode diagnostics returned HTTP $status"
  stats=${response%$'\n'*}
  printf '%s' "$stats" | core_stats_entry_count "$CG_ID" "$WIRE_CG_ID"
}

require_core_zero_custody() {
  local stage="$1" entries
  entries=$(core_private_entries)
  [ "$entries" = 0 ] || fail "$stage: Core has $entries private host-mode entries"
  log "✓ $stage: Core holds zero private host-mode entries"
}

kill_core_managed_store_process() {
  local port pids pid comm
  port=$(jq -r 'if .store.backend=="oxigraph-server" then .store.options.port // empty else empty end' \
    "$(node_dir "$CORE_NODE")/config.json")
  [ -n "$port" ] || return 0
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  for pid in $pids; do
    comm=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$comm" in
      *"$(node_dir "$CORE_NODE")/oxigraph"*|*"$(node_dir "$CORE_NODE")/oxigraph-data"*)
        kill -9 "$pid" 2>/dev/null || true ;;
      *) warn "refusing to kill unrelated process $pid on Core store port $port" ;;
    esac
  done
}

act "1. Create a registered private graph and join its member"
CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | jq -r .agentAddress)
M1_AGENT=$(api_call "$M1_NODE" GET /api/agent/identity | jq -r .agentAddress)
CURATOR_PEER=$(api_call "$CURATOR_NODE" GET /api/agent/identity | jq -r .peerId)
STAMP=$(date +%s)
CG_ID="$CURATOR_AGENT/urr-$STAMP"
WIRE_CG_ID=$(CG_ID="$CG_ID" AGENT_MODULES="$REPO_ROOT/packages/agent/node_modules" node -e '
  const {keccak256,toUtf8Bytes}=require(process.env.AGENT_MODULES+"/ethers");
  process.stdout.write(keccak256(toUtf8Bytes(process.env.CG_ID)));
')
log "Curator: $CURATOR_AGENT; member: $M1_AGENT; graph: $CG_ID"
CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create \
  "$(jq -nc --arg id "$CG_ID" --arg curator "$CURATOR_AGENT" --arg member "$M1_AGENT" \
    '{id:$id,name:("unclean "+$id),accessPolicy:1,publishPolicy:0,allowedAgents:[$curator,$member],register:true}')")
ON_CHAIN_ID=$(parse_json "$CREATE" '.onChainId')
REGISTERED=$(parse_json "$CREATE" '.registered')
[[ "$ON_CHAIN_ID" =~ ^[1-9][0-9]*$ ]] && [ "$REGISTERED" = true ] ||
  fail "private graph registration was partial: $CREATE"
devnet_join_curated_member "$M1_NODE" "$CURATOR_NODE" "$CG_ID" "$M1_AGENT" ||
  fail "member did not join the curator"
HOST_SUB=$(api_call "$CORE_NODE" POST /api/shared-memory/host-mode/subscribe \
  "$(jq -nc --arg cg "$CG_ID" '{contextGraphId:$cg}')")
[ "$(parse_json "$HOST_SUB" '.hostingEnabled')" = true ] || fail "Core host-mode store unavailable"
[ "$(parse_json "$HOST_SUB" '.subscribed')" = false ] ||
  fail "Core accepted forbidden private legacy host custody: $HOST_SUB"
[ "$(parse_json "$HOST_SUB" '.alreadySubscribed')" = false ] ||
  fail "Core already hosts this fresh private graph: $HOST_SUB"
require_core_zero_custody "before writes"

act "2. Write $WRITES_COUNT private triples at $WRITE_PAYLOAD_BYTES bytes each"
TOTAL_WRITTEN=0
BATCH_START=0
while [ "$BATCH_START" -lt "$WRITES_COUNT" ]; do
  BATCH_END=$((BATCH_START + WRITES_PER_BATCH))
  [ "$BATCH_END" -le "$WRITES_COUNT" ] || BATCH_END=$WRITES_COUNT
  BATCH_LEN=$((BATCH_END - BATCH_START))
  PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" START="$BATCH_START" END="$BATCH_END" BYTES="$WRITE_PAYLOAD_BYTES" node -e '
    const s=process.env.STAMP,cg=process.env.CG_ID,start=Number(process.env.START),end=Number(process.env.END);
    const filler="f".repeat(Number(process.env.BYTES));
    const quads=[];
    for(let i=start;i<end;i++) quads.push({subject:"urn:urr:"+s+"/t-"+i,predicate:"http://schema.org/note",object:"\""+filler+"\"",graph:""});
    process.stdout.write(JSON.stringify({contextGraphId:cg,quads}));
  ')
  RESPONSE=$(devnet_create_shared_ka "$CURATOR_NODE" "$PAYLOAD")
  [ "$(parse_json "$RESPONSE" '.triplesWritten')" = "$BATCH_LEN" ] ||
    fail "batch $BATCH_START..$BATCH_END did not write $BATCH_LEN triples"
  TOTAL_WRITTEN=$((TOTAL_WRITTEN+BATCH_LEN))
  BATCH_START=$BATCH_END
done
log "✓ wrote $TOTAL_WRITTEN triples"
M1_PRE=$(wait_for_member_count "$WRITES_COUNT")
log "✓ member holds $M1_PRE triples before Core loss"
require_core_zero_custody "after writes"

act "3. Force-stop the Core and restart it"
SUPERVISOR_PID=$(tr -d '[:space:]' < "$(node_dir "$CORE_NODE")/devnet.pid")
INNER_PID=$(tr -d '[:space:]' < "$(node_dir "$CORE_NODE")/daemon.pid")
[ -n "$SUPERVISOR_PID" ] || fail "Core supervisor pid is missing"
ORIGINAL_CORE_PEER=$(api_call "$CORE_NODE" GET /api/status | jq -r '.peerId // empty')
[ -n "$ORIGINAL_CORE_PEER" ] || fail "Core has no peer identity before SIGKILL"
CORE_WAS_KILLED=1
kill -9 "$SUPERVISOR_PID" 2>/dev/null || true
if [ -n "$INNER_PID" ] && [ "$INNER_PID" != "$SUPERVISOR_PID" ]; then
  kill -9 "$INNER_PID" 2>/dev/null || true
fi
kill_core_managed_store_process
CLOSED=0
for _ in $(seq 1 30); do
  if ! curl -fsS --max-time 1 -o /dev/null "http://127.0.0.1:$(node_port "$CORE_NODE")/api/status" 2>/dev/null; then
    CLOSED=1; break
  fi
  sleep 1
done
[ "$CLOSED" -eq 1 ] || fail "Core API did not go down after SIGKILL"
bash "$SCRIPT_DIR/devnet.sh" restart-node "$CORE_NODE" >/dev/null 2>&1 ||
  fail "Core did not restart after SIGKILL"
NEW_CORE_PEER=$(api_call "$CORE_NODE" GET /api/status | jq -r '.peerId // empty')
[ "$NEW_CORE_PEER" = "$ORIGINAL_CORE_PEER" ] || fail "restarted Core changed peer identity"
log "✓ Core forcibly stopped, then restarted"

act "4. Recover through the curator and prove new delivery"
CURATOR_MULTIADDR=$(cat "$(node_dir "$CURATOR_NODE")/multiaddr")
CONNECTED=0
for _ in 1 2 3; do
  CONNECT=$(api_call "$M1_NODE" POST /api/connect \
    "$(jq -nc --arg multiaddr "$CURATOR_MULTIADDR" '{multiaddr:$multiaddr}')" 2>/dev/null || true)
  if [ "$(parse_json "$CONNECT" '.connected' 2>/dev/null)" = true ]; then CONNECTED=1; break; fi
  sleep 5
done
[ "$CONNECTED" -eq 1 ] || fail "member could not reconnect to its curator"
CATCHUP=$(api_call "$M1_NODE" POST /api/shared-memory/catchup \
  "$(jq -nc --arg cg "$CG_ID" --arg peer "$CURATOR_PEER" '{contextGraphId:$cg,peerId:$peer}')")
printf '%s' "$CATCHUP" | jq -e --arg peer "$CURATOR_PEER" '
  (.error // "") == ""
  and (.peersAttempted // 0) >= 1
  and ([.results[]? | select(.peerId == $peer)] | length) >= 1
  and all(.results[]?; (.swmError // .durableError // .error // "") == "")
' >/dev/null ||
  fail "member catch-up from curator failed: $CATCHUP"
M1_RECOVERED=$(wait_for_member_count "$WRITES_COUNT")
log "✓ member retains $M1_RECOVERED triples after Core loss"
POST_PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  process.stdout.write(JSON.stringify({contextGraphId:process.env.CG_ID,quads:[{
    subject:"urn:urr:"+process.env.STAMP+"/after-core-restart",predicate:"http://schema.org/note",
    object:"\"after-restart\"",graph:""
  }]}));
')
POST_RESPONSE=$(devnet_create_shared_ka "$CURATOR_NODE" "$POST_PAYLOAD")
[ "$(parse_json "$POST_RESPONSE" '.triplesWritten')" = 1 ] ||
  fail "post-restart write failed: $POST_RESPONSE"
M1_FINAL=$(wait_for_member_count "$((WRITES_COUNT+1))")
require_core_zero_custody "after restart and new share"
log "RFC-38 unclean Core restart: PASS (member=$M1_FINAL; private Core custody=0)"
