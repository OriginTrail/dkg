#!/usr/bin/env bash
#
# managed-oxigraph-caller-abort — a caller that gives up on a store read after
# it was dispatched must not get a healthy managed Oxigraph restarted.
#
# On the daemon-managed `oxigraph-server` backend a read is retained for
# recovery when its caller stops waiting after dispatch: Oxigraph 0.5 keeps
# evaluating a query when the HTTP connection closes, so an abandoned read that
# never finishes has to be reclaimed by restarting the server at the client
# deadline (dispatch + 30s by default). Before the fix that retained deadline
# fired even when the abandoned query had long since completed, so any caller
# with a short budget of its own (an API client that disconnects, listContext
# Graphs' 200ms per-row reads, a 2s budget) got a healthy server SIGKILLed 30s
# later: an unexplained restart and a store-down blip.
#
# The fix keeps the dispatched request running under the client deadline alone
# and withdraws the retained recovery when the server visibly finishes. This
# script proves both halves against a REAL node with a REAL managed Oxigraph:
#
#   1. ABANDONED BUT COMPLETED. Send /api/query reads whose HTTP client
#      disconnects while the query is running (the daemon aborts the store read
#      on disconnect, after dispatch), where the query itself finishes well
#      inside the client deadline. Wait past that deadline and assert that the
#      node logged NO supervised-recovery restart and the Oxigraph listener pid
#      is unchanged.
#   2. GENUINE OVERRUN. Send a query that cannot finish inside the client
#      deadline and wait for it. Assert the node DOES restart its Oxigraph
#      (the log line and a new listener pid) and the store recovers. This keeps
#      step 1 from passing vacuously and proves runaway queries are still
#      reclaimed.
#
# The query is a bounded cross product of inline VALUES lists, so its cost does
# not depend on what the store holds. It is calibrated at run time to take about
# CALIBRATE_MIN_MS on this machine, so the abort at ABORT_AFTER_MS reliably lands
# after dispatch and before completion. It is scoped to one context graph
# (DEVNET_CONTEXT_GRAPH, default devnet-test): the daemon refuses unscoped
# queries on a store without all-writer consistency coverage, which includes
# every sparql-http backend.
#
# SAFETY: only the target node's own daemon-managed oxigraph-server is observed
# (and, in step 2, restarted by the node itself). The script never signals any
# process. The target is identified as in devnet-test-store-outage.sh: a live
# node API, exactly one LISTENer on the store port, whose command line names
# oxigraph, the node's own directory and that port. Anything else is a SKIP.
#
# Exit codes (a non-run must never look like a pass):
#   0 = PASS, 3 = SKIP (a precondition was unmet, nothing was exercised),
#   other non-zero = a real failure.
#
# Env knobs: DEVNET_DIR, API_PORT_BASE,
#   ABORT_TARGET (node number; default = first eligible node, preferring not node1),
#   ABORT_REQUESTS (default 4), ABORT_AFTER_MS (default 300),
#   CALIBRATE_MIN_MS (default 1500), CLIENT_TIMEOUT_MS (default: the node's
#   store.options.clientTimeoutMs, else 30000), ABORT_WAIT_SLACK_SECS (default 12),
#   ABORT_EXPECT_RESTART=1  invert step 1: assert the abandoned reads DO get the
#     server restarted. That is the pre-fix behaviour; use it to confirm on an
#     unfixed build that this scenario really detects the bug.
#   ABORT_SKIP_OVERRUN=1    run step 1 only.
#
# Run standalone (against a running devnet):  scripts/devnet-test-managed-oxigraph-caller-abort.sh
# Or via the suite: pnpm test:devnet:managed-oxigraph-caller-abort
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
DKG_API_MAXTIME="${DKG_API_MAXTIME:-90}"
ABORT_REQUESTS="${ABORT_REQUESTS:-4}"
ABORT_AFTER_MS="${ABORT_AFTER_MS:-300}"
CALIBRATE_MIN_MS="${CALIBRATE_MIN_MS:-1500}"
ABORT_WAIT_SLACK_SECS="${ABORT_WAIT_SLACK_SECS:-12}"
CONTEXT_GRAPH="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
SKIP_EXIT=3
RESTART_LINE='terminating server for supervised recovery'

say()  { echo "[oxigraph-abort] $*"; }
skip() { echo "[oxigraph-abort] SKIP: $*"; exit "$SKIP_EXIT"; }
fail() { echo "[oxigraph-abort] FAIL: $*" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------
[ -d "$DEVNET_DIR" ] || skip "no devnet at $DEVNET_DIR (start one first: ./scripts/devnet.sh start 6)"
command -v lsof >/dev/null 2>&1 || skip "lsof not available (needed to find the store process)"
command -v curl >/dev/null 2>&1 || skip "curl not available"

# shellcheck source=devnet-lib.sh
. "$REPO_ROOT/scripts/devnet-lib.sh" || skip "cannot source scripts/devnet-lib.sh"

node_up() { [ "$(code_of "$(api "$1" GET /api/status)")" = "200" ]; }

# One line per node dir: "<n> <backend> <port> <clientTimeoutMs>"; <port> only for
# the daemon-managed oxigraph-server backend (default bind port 7878).
topology="$(node -e '
  const fs = require("fs"), path = require("path");
  const dir = process.argv[1];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { process.exit(0); }
  const rows = [];
  for (const name of names) {
    const m = /^node(\d+)$/.exec(name);
    if (!m) continue;
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(dir, name, "config.json"), "utf8")); }
    catch { continue; }
    const backend = (c.store && c.store.backend) || "";
    const opts = (c.store && c.store.options) || {};
    const port = backend === "oxigraph-server" ? String(opts.port || 7878) : "-";
    const timeout = backend === "oxigraph-server" && Number.isInteger(opts.clientTimeoutMs) ? String(opts.clientTimeoutMs) : "-";
    rows.push([Number(m[1]), backend || "-", port, timeout]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  process.stdout.write(rows.map((r) => r.join(" ")).join("\n"));
' "$DEVNET_DIR")"
[ -n "$topology" ] || skip "no node<N>/config.json found under $DEVNET_DIR"

candidates=()
port_of=()
timeout_of=()
while read -r n backend port timeout; do
  [ -n "$n" ] || continue
  [ "$backend" = "oxigraph-server" ] && [ "$port" != "-" ] || continue
  candidates+=("$n")
  port_of[$n]="$port"
  timeout_of[$n]="$timeout"
done <<<"$topology"

target_node=""
if [ -n "${ABORT_TARGET:-}" ]; then
  for c in ${candidates[@]+"${candidates[@]}"}; do
    [ "$c" = "$ABORT_TARGET" ] && target_node="$c"
  done
  [ -n "$target_node" ] || skip "ABORT_TARGET=node${ABORT_TARGET} is not on the daemon-managed oxigraph-server backend (eligible: ${candidates[*]:-none})"
else
  # Prefer a node other than node1, the mesh anchor other tooling relies on.
  for c in ${candidates[@]+"${candidates[@]}"}; do
    if [ "$c" != "1" ] && node_up "$c"; then target_node="$c"; break; fi
  done
  if [ -z "$target_node" ]; then
    for c in ${candidates[@]+"${candidates[@]}"}; do
      if node_up "$c"; then target_node="$c"; break; fi
    done
  fi
fi
[ -n "$target_node" ] || skip "no responsive node uses the daemon-managed oxigraph-server backend. The default './scripts/devnet.sh start 6' puts it on nodes 1-2."

target_dir="$DEVNET_DIR/node${target_node}"
target_log="$target_dir/daemon.log"
target_port="${port_of[$target_node]}"
CLIENT_TIMEOUT_MS="${CLIENT_TIMEOUT_MS:-}"
if [ -z "$CLIENT_TIMEOUT_MS" ]; then
  if [ "${timeout_of[$target_node]:--}" != "-" ]; then CLIENT_TIMEOUT_MS="${timeout_of[$target_node]}"; else CLIENT_TIMEOUT_MS=30000; fi
fi
[ -f "$target_log" ] || skip "node${target_node} has no daemon.log at $target_log"
node_up "$target_node" || skip "node${target_node} API not responding on $(node_port "$target_node")"

# --- positively identify the managed store's listener ------------------------
listener_pid() { lsof -ti "tcp:${target_port}" -sTCP:LISTEN 2>/dev/null | sort -u || true; }
pids="$(listener_pid)"
[ -n "$pids" ] || skip "no process LISTENs on the store port ${target_port} for node${target_node}"
[ "$(echo "$pids" | wc -l | tr -d ' ')" = "1" ] || skip "multiple processes LISTEN on port ${target_port} ($(echo "$pids" | tr '\n' ' ')): ambiguous"
STORE_PID="$pids"
STORE_CMD="$(ps -p "$STORE_PID" -o args= 2>/dev/null || true)"
target_dir_phys="$(cd "$target_dir" 2>/dev/null && pwd -P || echo "$target_dir")"
case "$STORE_CMD" in *oxigraph*) : ;; *) skip "process ${STORE_PID} on port ${target_port} is not an oxigraph server (cmd: ${STORE_CMD:-unknown})" ;; esac
case "$STORE_CMD" in *"$target_dir"*|*"$target_dir_phys"*) : ;; *) skip "oxigraph process ${STORE_PID} does not reference node${target_node}'s directory (cmd: ${STORE_CMD})" ;; esac
case "$STORE_CMD" in *":${target_port}"*) : ;; *) skip "oxigraph process ${STORE_PID} does not bind :${target_port} (cmd: ${STORE_CMD})" ;; esac
say "target = node${target_node}; managed oxigraph-server pid ${STORE_PID} on :${target_port}; client deadline ${CLIENT_TIMEOUT_MS}ms"

restart_lines_since() { # <line offset> -> number of supervised-recovery lines after that offset
  tail -n "+$(( $1 + 1 ))" "$target_log" 2>/dev/null | grep -ac "$RESTART_LINE" || true
}
log_len() { wc -l < "$target_log" | tr -d ' '; }

# --- query helpers -----------------------------------------------------------
# <ARMS> inline VALUES lists of <L> values each, joined without a shared
# variable: a cross product of L^ARMS rows, so the cost is tunable and does not
# depend on what the store holds.
cross_product() { # <L> <ARMS>
  local l="$1" arms="$2" i nums q='SELECT (COUNT(*) AS ?n) WHERE {'
  nums="$(seq -s ' ' 0 $(( l - 1 )))"
  for ((i = 0; i < arms; i++)); do
    q+=" VALUES ?v$i { $nums }"
  done
  printf '%s }' "$q"
}
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
query_body() { node -e 'process.stdout.write(JSON.stringify({ sparql: process.argv[1], contextGraphId: process.argv[2] }))' "$1" "$CONTEXT_GRAPH"; }
node_url="http://127.0.0.1:$(node_port "$target_node")/api/query"
node_auth="Authorization: Bearer $(node_token "$target_node")"
body_file="$(mktemp "${TMPDIR:-/tmp}/oxigraph-abort-body-XXXXXX")"
trap 'rm -f "$body_file"' EXIT

run_query() { # <sparql> <curl --max-time secs> -> "<http code> <elapsed ms>"; the body lands in $body_file
  local t0 t1 code
  t0="$(now_ms)"
  code="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time "$2" -X POST -H "$node_auth" -H 'Content-Type: application/json' --data "$(query_body "$1")" "$node_url" 2>/dev/null || true)"
  t1="$(now_ms)"
  echo "${code:-000} $(( t1 - t0 ))"
}

# --- calibrate: find a cross-product size whose WARM run takes between
# CALIBRATE_MIN_MS and a third of the client deadline. The node's first scoped
# query after a start is slow for reasons that have nothing to do with the store
# (cold authority reads), and a busy host adds noise, so: warm up first, take the
# faster of two runs per size, and steer toward a target size from each
# measurement instead of stepping blindly.
COMPLETING_ARMS=5
RUNAWAY_ARMS=8
max_ok=$(( CLIENT_TIMEOUT_MS / 3 ))
target=$(( (CALIBRATE_MIN_MS + max_ok) / 2 ))
[ "$target" -le 2000 ] || target=2000

measure() { # <L> -> code, elapsed (the faster of two runs; a second run only if the first was not already too slow)
  local c1 e1 c2 e2
  read -r c1 e1 <<<"$(run_query "$(cross_product "$1" "$COMPLETING_ARMS")" 15)"
  code="$c1"; elapsed="$e1"
  if [ "$c1" = "200" ] && [ "$e1" -lt "$max_ok" ]; then
    read -r c2 e2 <<<"$(run_query "$(cross_product "$1" "$COMPLETING_ARMS")" 15)"
    if [ "$c2" = "200" ] && [ "$e2" -lt "$e1" ]; then elapsed="$e2"; fi
  fi
}
next_limit() { # <L> <elapsed ms> -> the size expected to take about $target ms (cost grows with L^ARMS)
  node -e '
    const [l, target, elapsed, arms] = process.argv.slice(1).map(Number);
    let n = Math.round(l * Math.pow(target / Math.max(elapsed, 30), 1 / arms));
    n = Math.min(Math.round(l * 1.8), Math.max(Math.round(l * 0.5), n));
    if (n === l) n = l + (target > elapsed ? 1 : -1);
    process.stdout.write(String(Math.max(2, n)));
  ' "$1" "$target" "$2" "$COMPLETING_ARMS"
}

read -r code elapsed <<<"$(run_query "$(cross_product 4 "$COMPLETING_ARMS")" 25)"
[ "$code" = "200" ] || fail "warm-up query returned HTTP ${code} after ${elapsed}ms for context graph '${CONTEXT_GRAPH}': $(head -c 300 "$body_file")"
say "warm-up query answered in ${elapsed}ms"
limit=8
calibrated=""
for step in $(seq 1 30); do
  measure "$limit"
  # curl reports 000 when its own --max-time expired: that size is far too slow.
  if [ "$code" != "200" ] && ! { [ "$code" = "000" ] && [ "$elapsed" -ge 14000 ]; }; then
    fail "calibration query (${COMPLETING_ARMS} VALUES lists of ${limit}) returned HTTP ${code} after ${elapsed}ms: $(head -c 300 "$body_file")"
  fi
  say "calibration step ${step}: ${COMPLETING_ARMS} VALUES lists of ${limit} -> ${elapsed}ms (HTTP ${code})"
  if [ "$code" = "200" ] && [ "$elapsed" -ge "$CALIBRATE_MIN_MS" ] && [ "$elapsed" -le "$max_ok" ]; then calibrated="$limit"; break; fi
  limit="$(next_limit "$limit" "$elapsed")"
done
[ -n "$calibrated" ] || fail "could not find a cross-product size taking ${CALIBRATE_MIN_MS}-${max_ok}ms on this node (last size ${limit}, ${elapsed}ms)"
say "calibrated: ${COMPLETING_ARMS} VALUES lists of ${calibrated} take ${elapsed}ms to complete on node${target_node}"
[ "$(listener_pid)" = "$STORE_PID" ] || fail "the store listener changed during calibration (was ${STORE_PID}, now $(listener_pid))"

# --- 1. abandoned but completed ----------------------------------------------
log_before="$(log_len)"
abort_secs="$(node -e 'process.stdout.write(String(Number(process.argv[1]) / 1000))' "$ABORT_AFTER_MS")"
say "sending ${ABORT_REQUESTS} reads whose client disconnects after ${ABORT_AFTER_MS}ms (the query takes ~${elapsed}ms, so each is abandoned mid-flight) ..."
disconnected=0
for _ in $(seq 1 "$ABORT_REQUESTS"); do
  read -r code took <<<"$(run_query "$(cross_product "$calibrated" "$COMPLETING_ARMS")" "$abort_secs")"
  # curl reports 000 when --max-time expires; a 200 means the query beat the abort.
  if [ "$code" = "000" ]; then disconnected=$((disconnected + 1)); fi
done
[ "$disconnected" -ge 1 ] || fail "no request was disconnected mid-flight (the query finished inside ${ABORT_AFTER_MS}ms every time): the abort never landed after dispatch"
say "OK: ${disconnected}/${ABORT_REQUESTS} requests were disconnected mid-flight"

wait_secs=$(( CLIENT_TIMEOUT_MS / 1000 + ABORT_WAIT_SLACK_SECS ))
say "waiting ${wait_secs}s, past the ${CLIENT_TIMEOUT_MS}ms client deadline, for a supervised recovery that must not come ..."
restart_seen=0
waited=0
while [ "$waited" -lt "$wait_secs" ]; do
  if [ "$(restart_lines_since "$log_before")" -gt 0 ]; then restart_seen=1; break; fi
  sleep 2
  waited=$((waited + 2))
done

if [ "${ABORT_EXPECT_RESTART:-0}" = "1" ]; then
  [ "$restart_seen" = "1" ] || fail "ABORT_EXPECT_RESTART=1 but no restart followed the abandoned reads within ${wait_secs}s: this build does not show the pre-fix behaviour"
  say "OK (pre-fix behaviour confirmed): the abandoned reads got node${target_node}'s managed Oxigraph restarted"
  echo "[oxigraph-abort][restart] $(tail -n "+$(( log_before + 1 ))" "$target_log" | grep -a "$RESTART_LINE" | head -1)"
  say "PASS (expect-restart)"
  exit 0
fi

if [ "$restart_seen" = "1" ]; then
  fail "node${target_node} restarted its managed Oxigraph after caller-aborted reads that had completed: $(tail -n "+$(( log_before + 1 ))" "$target_log" | grep -a "$RESTART_LINE" | head -1)"
fi
[ "$(listener_pid)" = "$STORE_PID" ] || fail "the Oxigraph listener pid changed from ${STORE_PID} to $(listener_pid) with no logged restart"
read -r code took <<<"$(run_query 'ASK { ?s ?p ?o }' 20)"
[ "$code" = "200" ] || fail "the node could not answer a plain ASK after the abandoned reads (HTTP ${code})"
say "OK: no supervised-recovery restart, listener pid ${STORE_PID} unchanged, and the store still answers"

if [ "${ABORT_SKIP_OVERRUN:-0}" = "1" ]; then
  say "PASS (abandoned-read half only)"
  exit 0
fi

# --- 2. genuine overrun still restarts ---------------------------------------
# A cross product far beyond anything Oxigraph finishes inside the client
# deadline: the request itself times out, and the managed server must be
# restarted to reclaim it.
log_before="$(log_len)"
say "sending a runaway query (${RUNAWAY_ARMS} VALUES lists of ${calibrated}, at least ${calibrated}^3 times the calibrated cost) and waiting for its client deadline ..."
read -r code took <<<"$(run_query "$(cross_product "$calibrated" "$RUNAWAY_ARMS")" $(( CLIENT_TIMEOUT_MS / 1000 + 30 )))"
say "the runaway query ended with HTTP ${code} after ${took}ms"
[ "$code" != "200" ] || fail "the runaway query completed; it must overrun the ${CLIENT_TIMEOUT_MS}ms client deadline (${RUNAWAY_ARMS} VALUES lists of ${calibrated})"
restarted=0
for _ in $(seq 1 20); do
  if [ "$(restart_lines_since "$log_before")" -gt 0 ]; then restarted=1; break; fi
  sleep 2
done
[ "$restarted" = "1" ] || fail "a query that overran the client deadline did NOT get the managed Oxigraph restarted: runaway queries are no longer reclaimed"
say "OK: the overrun restarted node${target_node}'s managed Oxigraph:"
tail -n "+$(( log_before + 1 ))" "$target_log" | grep -a "$RESTART_LINE" | head -1 | sed 's/^/[oxigraph-abort][restart] /'

recovered=""
for _ in $(seq 1 30); do
  new_pid="$(listener_pid)"
  if [ -n "$new_pid" ] && [ "$new_pid" != "$STORE_PID" ]; then recovered="$new_pid"; break; fi
  sleep 2
done
[ -n "$recovered" ] || fail "the managed Oxigraph did not come back on :${target_port} with a new pid after the supervised restart"
say "OK: supervised recovery brought the store back (pid ${STORE_PID} -> ${recovered})"
healthy=""
for _ in $(seq 1 15); do
  read -r code took <<<"$(run_query 'ASK { ?s ?p ?o }' 20)"
  [ "$code" = "200" ] && { healthy=1; break; }
  sleep 2
done
[ -n "$healthy" ] || fail "node${target_node} could not answer a query after the supervised restart"
say "OK: node${target_node} answers queries again after the restart"

say "PASS"
exit 0
