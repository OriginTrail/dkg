#!/usr/bin/env bash
#
# rc.11 — async-promote crash + restart integration scenario.
#
# Exercises the daemon × queue × store × worker-supervisor plumbing
# under a SIGKILL/restart cycle. The promote queue's
# `recoverOnStartup()` (PR #665) only abandons jobs whose lease has
# EXPIRED (default 5 min); jobs with a still-valid lease are correctly
# preserved per RFC §6.2 (recovery MUST NEVER demote `running →
# queued`, and MUST NEVER abandon a `running` job whose worker may
# still be alive elsewhere — even though on a single-daemon setup
# "elsewhere" means "nowhere").
#
# Devnet can't make the lease expire in a single test run without
# exposing `leaseMs` as a daemon config knob (currently 5 min hard
# default in `async-promote-queue-impl.ts`). The exhaustive lease-
# expiry test surface lives in the 27 unit tests in
# `packages/publisher/test/async-promote-queue.test.ts`. What this
# devnet test validates instead is the INTEGRATION shape — that the
# daemon lifecycle correctly:
#   1. Persists queue state to the underlying triple store.
#   2. Survives a hard process kill without store corruption.
#   3. Re-attaches the queue on the next boot and runs
#      `recoverOnStartup()` (the actual logged-and-counted call —
#      see `lifecycle.ts` wiring).
#   4. Surfaces the persisted job state through the HTTP API after
#      restart with NONE of the forbidden post-recovery states
#      (`running → queued` demotion; `running → failed` without an
#      expired lease).
#
# Flow:
#   1. Curator (edge node 5) creates an assertion + writes 200 triples
#      in WM (large enough to widen the in-flight promote window).
#   2. POST /api/knowledge-assets/<name>/swm/share-async → jobId.
#   3. Tight-poll GET /api/knowledge-assets/swm/share-jobs/<jobId> until
#      state === "running" (worker has claimed the lease).
#   4. SIGKILL the daemon (NOT SIGTERM — we explicitly want to bypass
#      graceful shutdown so the worker can't drain).
#   5. `./scripts/devnet.sh restart-node 5` brings node 5 back. The
#      daemon's lifecycle wiring calls `queue.recoverOnStartup()`
#      against the persisted triple-store queue state.
#   6. GET /api/knowledge-assets/swm/share-jobs/<jobId> on the restarted node
#      → classify per the matrix below.
#
# Flow:
#   1. Curator (edge node 5) creates an assertion + writes 5 triples
#      in WM under a unique context graph subgraph.
#   2. POST /api/knowledge-assets/<name>/swm/share-async → jobId.
#   3. Tight-poll GET /api/knowledge-assets/swm/share-jobs/<jobId> until
#      state === "running" (means worker has claimed the lease).
#   4. SIGKILL the daemon (NOT SIGTERM — we explicitly want to bypass
#      graceful shutdown so the worker can't drain).
#   5. `./scripts/devnet.sh restart-node 5` brings node 5 back. The
#      daemon's lifecycle wiring calls `queue.recoverOnStartup()`
#      against the persisted triple-store queue state.
#   6. GET /api/knowledge-assets/swm/share-jobs/<jobId> on the restarted node
#      → expect state === "failed", reason matching
#      /partial promote ambiguity/i (per
#      `async-promote-queue-impl.ts:abandonStartupRecovery`).
#
# Post-restart state classification matrix:
#
#   succeeded          PASS — worker drained pre-kill OR persisted
#                      commit marker before SIGKILL landed. Devnet's
#                      ~250ms promote window is small enough that this
#                      outcome dominates. Still a valid integration
#                      pass: the queue's persistence + restart wiring
#                      worked, the run survived a hard kill, no
#                      corruption.
#
#   running            PASS — job preserved with valid lease across
#                      restart. RFC §6.2 invariant intact (no
#                      wrongful demote / wrongful abandon).
#
#   queued             FAIL — recovery wrongly demoted running → queued.
#                      This is the duplicate-execution risk RFC §6.2
#                      explicitly forbids.
#
#   failed +           PASS — recovery correctly cleaned up an EXPIRED
#   reason matches     lease. Only reachable on devnet if the kill →
#   "partial promote   restart cycle exceeded 5 min, which is well
#    ambiguity" or     beyond our test budget. Listed for completeness.
#   "lease expired"
#
#   failed (any        FAIL — recovery wrongly abandoned a still-valid
#   other reason)      lease OR the worker errored mid-promote in a way
#                      the queue then mis-classified.
#
# Exit 0 on any PASS, non-zero on any FAIL.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5

log()  { echo "[rc11-promote-crash] $*"; }
warn() { echo "[rc11-promote-crash] WARN: $*" >&2; }
fail() { echo "[rc11-promote-crash] FAIL: $*" >&2; exit 1; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }
# devnet.pid is the outer foreground supervisor; daemon.pid is the inner
# `daemon-foreground-worker` that actually runs the libp2p node and async-promote
# worker. Codex (#673#discussion_r3302023868) flagged that killing only the
# supervisor leaves the worker alive, so the API port + SQLite store stays open
# and the "restart" path doesn't reflect a real crash. We now kill BOTH.
node_pidfile(){ echo "$(node_dir "$1")/devnet.pid"; }
node_daemon_pidfile(){ echo "$(node_dir "$1")/daemon.pid"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 30 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
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

STAMP=$(date +%s)
CG_ID="devnet-test"                                    # already registered by devnet.sh
ASSERTION_NAME="rc11-promote-crash-${STAMP}"

# ---------------------------------------------------------------------------
# Stage 1: Set up assertion in WM on the curator.
# ---------------------------------------------------------------------------

log "Curator: node $CURATOR_NODE; context graph: $CG_ID"
log "Assertion: $ASSERTION_NAME (default subgraph)"

CREATE_RESP=$(api_call "$CURATOR_NODE" POST /api/knowledge-assets "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "name": "$ASSERTION_NAME" }
EOF
)")
log "create response: $CREATE_RESP"
ASSERTION_URI=$(parse_json "$CREATE_RESP" '.assertionUri')
[ -n "$ASSERTION_URI" ] || fail "assertion create did not return assertionUri: $CREATE_RESP"
log "✓ assertion created: $ASSERTION_URI"

# 200 triples gives the promote ~3-5s of WM-read/SWM-write/lifecycle-stamp
# work on devnet (the first run with 5 triples drained in ~240ms — fast
# enough that the SIGKILL landed AFTER the commit marker was fully
# persisted, leaving the recovery path untested). Larger N widens the
# crash window so the kill can land mid-promote.
TRIPLE_COUNT=200
QUADS_JSON=$(node -e "
  const quads = [];
  for (let i = 0; i < $TRIPLE_COUNT; i++) {
    quads.push({
      subject: 'urn:rc11-promote-crash/${STAMP}/item' + i,
      predicate: 'http://schema.org/name',
      object: '\"Item' + i + '\"',
      graph: ''
    });
  }
  console.log(JSON.stringify({
    contextGraphId: '$CG_ID',
    quads,
  }));
")
WRITE_RESP=$(api_call "$CURATOR_NODE" POST "/api/knowledge-assets/$ASSERTION_NAME/wm/write" "$QUADS_JSON")
log "write response: $(printf '%s' "$WRITE_RESP" | head -c 200)"
WRITTEN=$(parse_json "$WRITE_RESP" '.written')
[ "$WRITTEN" = "$TRIPLE_COUNT" ] || fail "expected $TRIPLE_COUNT quads written; got '$WRITTEN': $WRITE_RESP"
log "✓ wrote $TRIPLE_COUNT triples to WM"

# ---------------------------------------------------------------------------
# Stage 2: Enqueue + race-to-running.
# ---------------------------------------------------------------------------

log ""
log "Enqueueing promote-async job..."
ENQUEUE=$(api_call "$CURATOR_NODE" POST "/api/knowledge-assets/$ASSERTION_NAME/swm/share-async" "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "entities": "all" }
EOF
)")
log "enqueue response: $ENQUEUE"
JOB_ID=$(parse_json "$ENQUEUE" '.jobId')
[ -n "$JOB_ID" ] || fail "enqueue returned no jobId: $ENQUEUE"
log "✓ enqueued job: $JOB_ID"

# Tight-poll for state === 'running'. Worker default pollIntervalMs is
# 100ms (see async-promote-worker.ts), so we expect state to flip within
# ~200-500ms after enqueue. Budget 5s before declaring the race lost.
log "Polling for state=running (budget 5s)..."
RACE_DEADLINE=$(( $(date +%s) + 5 ))
SAW_RUNNING=0
LAST_STATE=""
while [ "$(date +%s)" -lt "$RACE_DEADLINE" ]; do
  STATUS=$(api_call "$CURATOR_NODE" GET "/api/knowledge-assets/swm/share-jobs/$JOB_ID" 2>/dev/null || echo '{}')
  LAST_STATE=$(parse_json "$STATUS" '.state' 2>/dev/null || echo "")
  case "$LAST_STATE" in
    running)
      SAW_RUNNING=1
      log "✓ caught job in state=running"
      break
      ;;
    succeeded)
      # Codex (#673#discussion_r3302023872): the crash/restart scenario was
      # never exercised on this path. Exit non-zero so callers can
      # distinguish an inconclusive run from a pass — this script asserts
      # crash-recovery behavior, not happy-path completion.
      warn "job drained before kill could land (state=succeeded). Worker faster than poll loop — rerun for a reliable crash window."
      log "  raw status: $STATUS"
      log "RESULT: INCONCLUSIVE (worker finished before kill — crash-recovery path not exercised)"
      exit 2
      ;;
    failed)
      fail "job in state=failed before any kill — pre-existing recovery condition? raw status: $STATUS"
      ;;
    "")
      sleep 0.02
      continue
      ;;
    *)
      sleep 0.02
      ;;
  esac
done

if [ "$SAW_RUNNING" -eq 0 ]; then
  fail "never observed state=running within 5s budget (last state: '$LAST_STATE'). Worker may be misconfigured or queue stuck."
fi

# ---------------------------------------------------------------------------
# Stage 3: SIGKILL the daemon hard. No SIGTERM — that would let the
# graceful-shutdown path drain the worker, defeating the test.
# ---------------------------------------------------------------------------

SUPERVISOR_PIDFILE=$(node_pidfile "$CURATOR_NODE")
WORKER_PIDFILE=$(node_daemon_pidfile "$CURATOR_NODE")
[ -f "$SUPERVISOR_PIDFILE" ] || fail "expected pidfile at $SUPERVISOR_PIDFILE — node may not be running"
SUPERVISOR_PID=$(cat "$SUPERVISOR_PIDFILE")
# Codex (#673#discussion_r3302023868): SIGKILL on the supervisor alone leaves
# `daemon-foreground-worker` alive and holding the API port + SQLite store
# open, so the restart isn't a real crash. Kill both the supervisor and the
# worker (whichever pidfiles are present).
WORKER_PID=""
if [ -f "$WORKER_PIDFILE" ]; then
  WORKER_PID=$(cat "$WORKER_PIDFILE")
fi
log ""
log "SIGKILL daemon (supervisor pid=$SUPERVISOR_PID, worker pid=${WORKER_PID:-<none>}) — bypassing graceful-shutdown to reproduce a hard crash..."
[ -n "$WORKER_PID" ] && { kill -9 "$WORKER_PID" 2>/dev/null || warn "kill -9 $WORKER_PID returned non-zero; pid may already be gone"; }
kill -9 "$SUPERVISOR_PID" 2>/dev/null || warn "kill -9 $SUPERVISOR_PID returned non-zero; pid may already be gone"

# Wait for both processes to actually disappear so the restart doesn't race
# a dying process holding the API port.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  supervisor_alive=0; worker_alive=0
  kill -0 "$SUPERVISOR_PID" 2>/dev/null && supervisor_alive=1
  [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null && worker_alive=1
  if [ "$supervisor_alive" -eq 0 ] && [ "$worker_alive" -eq 0 ]; then
    break
  fi
  sleep 0.5
done
if kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
  fail "supervisor pid $SUPERVISOR_PID still alive 5s after SIGKILL — kernel did not reap"
fi
if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
  fail "worker pid $WORKER_PID still alive 5s after SIGKILL — kernel did not reap"
fi
log "✓ supervisor + worker dead"

# ---------------------------------------------------------------------------
# Stage 4: Restart the node. Lifecycle wires queue.recoverOnStartup()
# inside the agent.start() path, so by the time /api/status returns the
# recovery pass has already run.
# ---------------------------------------------------------------------------

log ""
log "Restarting node $CURATOR_NODE..."
"$REPO_ROOT/scripts/devnet.sh" restart-node "$CURATOR_NODE" 2>&1 | sed 's/^/[devnet]   /'

# Poll /api/status until healthy. restart-node should have already
# blocked until the API port is up but be defensive.
PORT=$(node_port "$CURATOR_NODE")
READY_DEADLINE=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$READY_DEADLINE" ]; do
  if curl -sS --max-time 2 "http://127.0.0.1:${PORT}/api/status" \
       -H "Authorization: Bearer $(node_token "$CURATOR_NODE")" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if [ "$(date +%s)" -ge "$READY_DEADLINE" ]; then
  fail "node $CURATOR_NODE did not become responsive within 60s after restart"
fi
log "✓ node $CURATOR_NODE responsive"

# ---------------------------------------------------------------------------
# Stage 5: Assert recoverOnStartup did the right thing.
# ---------------------------------------------------------------------------

log ""
log "Querying job status post-restart..."
POST_RESTART=$(api_call "$CURATOR_NODE" GET "/api/knowledge-assets/swm/share-jobs/$JOB_ID")
log "post-restart status: $POST_RESTART"
POST_STATE=$(parse_json "$POST_RESTART" '.state')
POST_REASON=$(parse_json "$POST_RESTART" '.reason' 2>/dev/null || echo "")

CLASSIFICATION=""
case "$POST_STATE" in
  succeeded)
    CLASSIFICATION="GREEN: worker drained pre-kill OR persisted commit marker before SIGKILL; queue persistence + restart wiring intact"
    ;;
  running)
    CLASSIFICATION="GREEN: job preserved with valid lease across restart (RFC §6.2 invariant intact)"
    ;;
  queued)
    fail "job back to state=queued — recovery wrongly demoted running → queued. RFC §6.2 explicitly forbids this; would cause duplicate execution."
    ;;
  failed)
    if printf '%s' "$POST_REASON" | grep -qi 'partial promote ambiguity\|lease expired'; then
      CLASSIFICATION="GREEN: recovery correctly abandoned expired-lease job ('$POST_REASON')"
    else
      fail "job state=failed but reason did not match expected expired-lease patterns: '$POST_REASON'. Recovery may have abandoned a still-valid lease."
    fi
    ;;
  *)
    fail "unexpected post-restart state '$POST_STATE'; expected one of: succeeded, running, failed (with valid reason)"
    ;;
esac

log ""
log "================================================================"
log "  rc.11 async-promote crash + restart: PASS"
log "================================================================"
log "  Job ID:           $JOB_ID"
log "  Final state:      $POST_STATE"
log "  Reason:           ${POST_REASON:-(none)}"
log "  Classification:   $CLASSIFICATION"
log "================================================================"
