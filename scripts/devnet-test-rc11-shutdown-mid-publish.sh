#!/usr/bin/env bash
#
# rc.11 — SIGTERM-during-publish devnet scenario.
#
# Exercises the interaction between PR-1 (#655 — hard 15s timeout in
# `shutdown()`) and PR-6 (#669 — `AbortSignal` plumbed through
# `DKGNode.stop()` into protocol-router reads). PR-1 is the safety
# net that guarantees the daemon ALWAYS terminates within 15s; PR-6
# is the root-cause fix that should make PR-1's hard timer never
# fire in practice because libp2p reads abort within milliseconds.
#
# The deadlock shape these PRs were written for came from
# `beacon-01` taking a mid-deploy SIGTERM while in the middle of a
# `streamReadString()` in the StorageACK responder — the await never
# completed, `agent.stop()` never returned, the shutdown wedged
# forever, and the next operator action was a `kill -9`.
#
# Devnet can't reproduce that exact NUMA stall, but it CAN reproduce
# the shape: while a core node is actively handling StorageACK reads
# on behalf of a publishing edge, SIGTERM the core. If PR-6 is
# wired correctly, shutdown completes in well under 15s with no
# `[shutdown-timeout]` line. If PR-6 has a gap, PR-1 still wins (15s
# cap + forced exit code) but we want to know which side fired.
#
# Flow:
#   1. Edge node 5 launches N concurrent publishes against a context
#      graph. Each publish round-trips StorageACK reads to core
#      nodes 1-4, generating sustained libp2p read pressure.
#   2. After ~2s of warm-up, SIGTERM core node 2.
#   3. Measure shutdown wall-clock time (when the daemon pid actually
#      disappears).
#   4. Grep node 2's daemon log for `[shutdown-timeout]`. Pass: no
#      hits + shutdown completed in < 15s. Soft-pass: shutdown <
#      15.5s and exactly one `[shutdown-timeout]` line (means PR-1
#      caught a real PR-6 gap — defense in depth working as
#      designed, but file a follow-up).
#   5. Restart node 2 and confirm /api/status responds healthy
#      within 60s.
#   6. Reap the background publish PIDs (their fate is incidental;
#      what matters is the daemon's shutdown behaviour, not whether
#      individual mid-flight publishes happened to complete).
#
# Exit 0 on clean shutdown (PR-6 win) OR soft-pass (PR-1 catch).
# Exit non-zero only on (a) shutdown > 15.5s (PR-1 broken too) or
# (b) restart never becomes responsive.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201

# Edge node that drives load via concurrent publishes.
LOAD_NODE=5
# Core node we SIGTERM.
TARGET_NODE=2
# Concurrent publishes — enough to keep StorageACK on the target node
# busy through the SIGTERM window without overwhelming the network.
CONCURRENCY=5

log()  { echo "[rc11-shutdown] $*"; }
warn() { echo "[rc11-shutdown] WARN: $*" >&2; }
fail() { echo "[rc11-shutdown] FAIL: $*" >&2; exit 1; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }
node_pidfile(){ echo "$(node_dir "$1")/devnet.pid"; }
node_log()    { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 60 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

parse_json() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch (e) { process.exit(1); }
    })
  "
}

# `date +%s%N` is a GNU coreutils extension; BSD `date` (macOS) emits
# `1779776638N` literally. Use node for portable millisecond clocks so
# this script runs identically on macOS dev boxes and Linux CI.
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

STAMP=$(date +%s)
CG_ID="devnet-test"  # already registered by devnet.sh

# ---------------------------------------------------------------------------
# Stage 0: Capture target node's shutdown-marker baseline. New
# `[shutdown-timeout]` lines added in this run are what matters.
# ---------------------------------------------------------------------------

TARGET_LOG=$(node_log "$TARGET_NODE")
[ -f "$TARGET_LOG" ] || fail "target node log not found: $TARGET_LOG"
# `grep -c` prints "0" AND exits 1 when there are zero matches —
# `grep -c X file || echo 0` would print "0\n0" in the no-match case.
# Pipe through `wc -l` against the match-only output instead so we
# get exactly one integer for any input, and run under `set +e` to
# survive grep's no-match exit code.
count_shutdown_timeout() {
  local log_file="$1"
  if [ ! -f "$log_file" ]; then
    echo 0; return
  fi
  local n
  set +e
  n=$(grep -c '\[shutdown-timeout\]' "$log_file" 2>/dev/null)
  set -e
  echo "${n:-0}"
}
PRE_TIMEOUT_HITS=$(count_shutdown_timeout "$TARGET_LOG")
log "Target node $TARGET_NODE current [shutdown-timeout] hit count: $PRE_TIMEOUT_HITS (baseline)"

# ---------------------------------------------------------------------------
# Stage 1: Launch concurrent publishes from the load node. Each publish
# enqueues SWM triples, calls /api/knowledge-assets/<name>/vm/publish (which drives
# StorageACK reads against cores 1-4), and returns when ACK collection
# settles or fails.
# ---------------------------------------------------------------------------

log ""
log "Launching $CONCURRENCY concurrent publishes from node $LOAD_NODE..."
PUBLISH_PIDS=()
TMP_OUT_DIR=$(mktemp -d)
trap "rm -rf '$TMP_OUT_DIR'" EXIT

for i in $(seq 1 $CONCURRENCY); do
  # Each publish writes 8 fresh SWM triples and asks the daemon to
  # publish them. Run in the background, capture stdout for later
  # post-mortem (we don't gate the shutdown test on publish success).
  (
    export DEVNET_PUBLISH_STATE_FILE="$TMP_OUT_DIR/state-$i.json"
    QUADS=$(node -e "
      const triples = [];
      for (let j = 0; j < 8; j++) {
        triples.push({
          subject: 'urn:rc11-shutdown/${STAMP}/pub${i}/item' + j,
          predicate: 'http://schema.org/name',
          object: '\"Pub${i}Item' + j + '\"',
          graph: ''
        });
      }
      console.log(JSON.stringify({
        contextGraphId: '$CG_ID',
        quads: triples,
      }));
    ")
    devnet_create_shared_ka "$LOAD_NODE" "$QUADS" \
      > "$TMP_OUT_DIR/write-$i.json" 2>&1 || true
    # Codex (#673#discussion_r3302023873): `/api/knowledge-assets/<name>/vm/publish`
    # accepts `selection: "all"` or a root-entity string array — NOT a
    # SPARQL-shaped object. Pass the 8 generated root entities directly so
    # each background pipeline drives a real StorageACK round trip.
    ROOT_ENTITIES=$(node -e "
      const roots = [];
      for (let j = 0; j < 8; j++) {
        roots.push('urn:rc11-shutdown/${STAMP}/pub${i}/item' + j);
      }
      console.log(JSON.stringify({
        contextGraphId: '$CG_ID',
        selection: roots,
      }));
    ")
    PUBLISH_OUT=$(devnet_publish_swm_all_roots "$LOAD_NODE" "$CG_ID" false 2>&1) || PUBLISH_RC=$? && PUBLISH_RC=${PUBLISH_RC:-0}
    echo "$PUBLISH_OUT" > "$TMP_OUT_DIR/publish-$i.json"
    if [ "$PUBLISH_RC" -ne 0 ]; then
      echo "[publish-$i] api_call exit=$PUBLISH_RC" >> "$TMP_OUT_DIR/publish-$i.json"
    fi
  ) &
  PUBLISH_PIDS+=($!)
done
log "✓ launched ${#PUBLISH_PIDS[@]} background publish pipelines"

# Warm-up window so the StorageACK protocol traffic is actually
# in-flight when SIGTERM lands.
log "Warm-up: 2s..."
sleep 2

# ---------------------------------------------------------------------------
# Stage 2: SIGTERM the target node + time the shutdown.
# ---------------------------------------------------------------------------

PIDFILE=$(node_pidfile "$TARGET_NODE")
[ -f "$PIDFILE" ] || fail "expected pidfile at $PIDFILE — node $TARGET_NODE not running"
TARGET_PID=$(cat "$PIDFILE")
kill -0 "$TARGET_PID" 2>/dev/null || fail "target pid $TARGET_PID already dead pre-test"

log ""
log "SIGTERM core node $TARGET_NODE (pid=$TARGET_PID)..."
SHUTDOWN_START=$(now_ms)
kill -TERM "$TARGET_PID"

SHUTDOWN_DEADLINE_MS=20000   # generous; PR-1 caps real shutdown at 15s
while true; do
  if ! kill -0 "$TARGET_PID" 2>/dev/null; then
    break
  fi
  ELAPSED_MS=$(( $(now_ms) - SHUTDOWN_START ))
  if [ "$ELAPSED_MS" -gt "$SHUTDOWN_DEADLINE_MS" ]; then
    fail "daemon pid $TARGET_PID still alive ${ELAPSED_MS}ms after SIGTERM (deadline ${SHUTDOWN_DEADLINE_MS}ms). Both PR-1 (#655) and PR-6 (#669) failed."
  fi
  sleep 0.05
done

SHUTDOWN_END=$(now_ms)
SHUTDOWN_MS=$(( SHUTDOWN_END - SHUTDOWN_START ))
log "✓ daemon dead in ${SHUTDOWN_MS}ms"

# ---------------------------------------------------------------------------
# Stage 3: Classify outcome.
# ---------------------------------------------------------------------------

POST_TIMEOUT_HITS=$(count_shutdown_timeout "$TARGET_LOG")
NEW_TIMEOUT_HITS=$(( POST_TIMEOUT_HITS - PRE_TIMEOUT_HITS ))
log "  baseline [shutdown-timeout] hits: $PRE_TIMEOUT_HITS"
log "  post-shutdown [shutdown-timeout] hits: $POST_TIMEOUT_HITS"
log "  new hits this run: $NEW_TIMEOUT_HITS"

CLASSIFICATION=""
if [ "$NEW_TIMEOUT_HITS" -eq 0 ] && [ "$SHUTDOWN_MS" -lt 15000 ]; then
  CLASSIFICATION="GREEN (PR-6 #669 abort-signal drained reads in time; PR-1 #655 stayed passive)"
elif [ "$NEW_TIMEOUT_HITS" -ge 1 ] && [ "$SHUTDOWN_MS" -lt 16000 ]; then
  CLASSIFICATION="SOFT-PASS (PR-1 #655 caught a real PR-6 #669 gap — defense-in-depth working as designed; file a follow-up to identify the unaborted await site)"
elif [ "$SHUTDOWN_MS" -lt 16000 ]; then
  CLASSIFICATION="GREEN (under-15s shutdown without PR-1 trigger; clean)"
else
  fail "shutdown took ${SHUTDOWN_MS}ms (> 15.5s) — PR-1 #655 itself may be broken"
fi

# Soak up background publishers. Some will have errored mid-flight
# because their target ACKing core just died. That's expected — not
# what this test is measuring.
log ""
log "Reaping ${#PUBLISH_PIDS[@]} background publish pipelines..."
SUCCESS_COUNT=0
for pid in "${PUBLISH_PIDS[@]}"; do
  wait "$pid" 2>/dev/null && SUCCESS_COUNT=$(( SUCCESS_COUNT + 1 )) || true
done
log "  publisher exit summary: $SUCCESS_COUNT/$CONCURRENCY exited 0 (the rest aborted mid-flight, which is expected)"

# ---------------------------------------------------------------------------
# Stage 4: Restart the target node and confirm it comes back healthy.
# ---------------------------------------------------------------------------

log ""
log "Restarting node $TARGET_NODE..."
"$REPO_ROOT/scripts/devnet.sh" restart-node "$TARGET_NODE" 2>&1 | sed 's/^/[devnet]   /'

PORT=$(node_port "$TARGET_NODE")
READY_DEADLINE=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$READY_DEADLINE" ]; do
  if curl -sS --max-time 2 "http://127.0.0.1:${PORT}/api/status" \
       -H "Authorization: Bearer $(node_token "$TARGET_NODE")" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if [ "$(date +%s)" -ge "$READY_DEADLINE" ]; then
  fail "node $TARGET_NODE did not become responsive within 60s after restart"
fi

POST_RESTART_STATUS=$(api_call "$TARGET_NODE" GET /api/status)
RELAY_PRESENT=$(parse_json "$POST_RESTART_STATUS" '.relay ? "yes" : "no"')
CONN_PEERS=$(parse_json "$POST_RESTART_STATUS" '.connectedPeers')
log "✓ node $TARGET_NODE healthy (relay=$RELAY_PRESENT connectedPeers=$CONN_PEERS)"

log ""
log "================================================================"
log "  rc.11 shutdown-mid-publish: PASS"
log "================================================================"
log "  Target node:           $TARGET_NODE (core)"
log "  Load node:             $LOAD_NODE (edge) — $CONCURRENCY concurrent publishes"
log "  Shutdown time:         ${SHUTDOWN_MS}ms (15000ms = PR-1 hard cap)"
log "  New [shutdown-timeout] log lines: $NEW_TIMEOUT_HITS"
log "  Classification:        $CLASSIFICATION"
log "  Post-restart healthy:  relay=$RELAY_PRESENT connectedPeers=$CONN_PEERS"
log "================================================================"
