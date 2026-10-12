#!/usr/bin/env bash
#
# Managed Oxigraph: a write-ahead-log maintenance pause, as a client meets it.
#
# A node on the daemon-managed Oxigraph backend can be given a limit for the
# write-ahead log its store retains (`store.options.walRestartThresholdBytes`).
# Once a minute the daemon measures the retained log. At the limit it stops
# admitting store work, lets the admitted work drain, restarts the store server
# so that the log is reclaimed, and admits work again. While it is paused,
# every request that needs the store is refused as retryable and not started.
#
# A devnet node never reaches a production-sized limit inside a suite, so this
# script makes one node meet the pause on purpose and checks what a client
# sees:
#
#   1. it gives one managed-Oxigraph node a small limit and restarts it;
#   2. it writes to that node until the node's log says the pause began;
#   3. a write sent during the pause must be refused the documented way:
#      HTTP 503, code STORE_OPERATION_TIMEOUT, outcome not_started, retryable;
#   4. the same write, repeated, must succeed once the store is back;
#   5. the node must have logged the supervised restart of its store, must read
#      the asset back, and another node must have received it;
#   6. the node gets its configuration back and is restarted, on every exit
#      path: a limit left behind would pause that node again an hour later.
#
# It runs on any running six-node devnet and leaves it as it found it, two
# restarts of one node apart. scripts/devnet-test-upgrade.sh runs it as an
# optional last step (DEVNET_UPGRADE_WAL_PAUSE_NODE), on a network that was
# just upgraded.
#
# Exit codes (the convention of devnet-test-store-outage.sh):
#   0 = the pause was met and every check held.
#   3 = did not run: no devnet, or no responsive node on the managed backend.
#   other non-zero = a check failed, the pause never came, or the node did not
#       come back.
#
# Env:
#   WAL_PAUSE_NODE      the node to pause (default: the first responsive node on
#                       the managed backend, node 1 last: it is the devnet's
#                       relay and bootstrap peer).
#   WAL_PAUSE_BYTES     the limit to set (default 8388608, 8 MiB).
#   WAL_PAUSE_WAIT_S    seconds of writing the pause may take to begin (default 420).
#   WAL_PAUSE_RETRY_S   seconds the refused write has to succeed (default 300).
#   WAL_PAUSE_WITNESS   the node that must receive the retried write (default:
#                       the lowest-numbered other node that answers).
#   WAL_PAUSE_RESULTS   where the read results go (default: a temporary directory).
#   DEVNET_DIR, API_PORT_BASE, DEVNET_CONTEXT_GRAPH are honoured, and
#   DEVNET_VERSION_LAYOUT by the two restarts (scripts/devnet.sh restart-node).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
export DEVNET_DIR
API_PORT_BASE="${API_PORT_BASE:-9201}"
GRAPH="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
LIMIT="${WAL_PAUSE_BYTES:-8388608}"
WAIT_S="${WAL_PAUSE_WAIT_S:-420}"
RETRY_S="${WAL_PAUSE_RETRY_S:-300}"
DKG_API_MAXTIME="${DKG_API_MAXTIME:-120}"
STAMP="$(date +%s)"
SKIP_EXIT=3
PAUSE_LINE='maintenance threshold; pausing new store work'

PASS=0; FAIL=0
say()  { echo "[wal-pause] $*"; }
ok()   { PASS=$((PASS + 1)); echo "[wal-pause]   ok: $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "[wal-pause]   FAIL: $*" >&2; }
skip() { echo "[wal-pause] SKIP: $*"; echo "[wal-pause] The pause was not exercised (exit $SKIP_EXIT)."; exit "$SKIP_EXIT"; }

case "$LIMIT" in ''|*[!0-9]*) echo "[wal-pause] WAL_PAUSE_BYTES must be a positive integer (got '$LIMIT')" >&2; exit 2 ;; esac
[ "$LIMIT" -gt 0 ] || { echo "[wal-pause] WAL_PAUSE_BYTES must be a positive integer (got '$LIMIT')" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || skip "curl not available"
command -v node >/dev/null 2>&1 || skip "node not available"
[ -d "$DEVNET_DIR/node1" ] || skip "no devnet at $DEVNET_DIR (start one first: ./scripts/devnet.sh start 6)"
# shellcheck source=devnet-lib.sh
. "$SCRIPT_DIR/devnet-lib.sh" || skip "cannot source scripts/devnet-lib.sh"

backend_of() { # <node> -> the store backend in the node's configuration ("" when unreadable)
  CONFIG="$DEVNET_DIR/node$1/config.json" node -e '
    try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.env.CONFIG, "utf8")).store?.backend ?? "")); }
    catch { process.stdout.write(""); }'
}

# ---------------------------------------------------------------------------
# Which node is paused, and which node watches
# ---------------------------------------------------------------------------
TARGET="${WAL_PAUSE_NODE:-}"
if [ -n "$TARGET" ]; then
  case "$TARGET" in *[!0-9]*) skip "WAL_PAUSE_NODE='$TARGET' is not a node number" ;; esac
  [ -f "$DEVNET_DIR/node$TARGET/config.json" ] || skip "no node$TARGET/config.json under $DEVNET_DIR (WAL_PAUSE_NODE)"
  [ "$(backend_of "$TARGET")" = "oxigraph-server" ] \
    || skip "node $TARGET is on the '$(backend_of "$TARGET")' backend: only a node on the daemon-managed oxigraph-server backend has this pause"
  node_up "$TARGET" || skip "node $TARGET does not answer /api/status"
else
  for n in 2 3 4 5 6 1; do
    [ -f "$DEVNET_DIR/node$n/config.json" ] || continue
    [ "$(backend_of "$n")" = "oxigraph-server" ] || continue
    if node_up "$n"; then TARGET="$n"; break; fi
  done
  [ -n "$TARGET" ] || skip "no responsive node uses the daemon-managed oxigraph-server backend (the default './scripts/devnet.sh start 6' puts it on nodes 1 and 2)"
fi
WITNESS="${WAL_PAUSE_WITNESS:-}"
if [ -z "$WITNESS" ]; then
  for n in 1 2 3 4 5 6; do
    [ "$n" = "$TARGET" ] && continue
    if [ -f "$DEVNET_DIR/node$n/config.json" ] && node_up "$n"; then WITNESS="$n"; break; fi
  done
fi
[ -n "$WITNESS" ] && [ "$WITNESS" != "$TARGET" ] && node_up "$WITNESS" \
  || skip "no second node answers: nothing could show that the paused node's write arrived elsewhere"

CONFIG="$DEVNET_DIR/node$TARGET/config.json"
BACKUP="$CONFIG.before-wal-pause"
LOG="$DEVNET_DIR/node$TARGET/daemon.log"
[ -f "$LOG" ] || skip "node $TARGET has no daemon.log at $LOG"
RESULTS="${WAL_PAUSE_RESULTS:-}"
if [ -z "$RESULTS" ]; then RESULTS="$(mktemp -d "${TMPDIR:-/tmp}/dkg-wal-pause-XXXXXX")" || skip "cannot create a temporary directory"; fi
mkdir -p "$RESULTS" || skip "cannot create the results directory $RESULTS"

wait_node_up() { local i; for i in $(seq 1 "$2"); do node_up "$1" && return 0; sleep 1; done; return 1; }

RESTORE=0
restore() {
  [ "$RESTORE" = "1" ] || return 0
  RESTORE=0
  if cp "$BACKUP" "$CONFIG" 2>/dev/null; then
    rm -f "$BACKUP"
    "$SCRIPT_DIR/devnet.sh" restart-node "$TARGET" > "$RESULTS/restart-restore.log" 2>&1 || true
    if wait_node_up "$TARGET" 120; then
      say "node $TARGET has its configuration back and answers again"
    else
      echo "[wal-pause] node $TARGET did not answer within 120s after its configuration was restored (log: $RESULTS/restart-restore.log)" >&2
    fi
  else
    echo "[wal-pause] could not restore $CONFIG from $BACKUP: node $TARGET still has the small limit" >&2
  fi
}
trap restore EXIT
trap 'restore; exit 130' INT
trap 'restore; exit 143' TERM

# ---------------------------------------------------------------------------
# 1. A small limit on one node
# ---------------------------------------------------------------------------
say "node $TARGET gets a limit of $LIMIT bytes for its retained write-ahead log; node $WITNESS watches; graph '$GRAPH'"
cp "$CONFIG" "$BACKUP" || skip "cannot keep a copy of $CONFIG"
RESTORE=1
CONFIG="$CONFIG" LIMIT="$LIMIT" node -e '
  const fs = require("fs");
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"));
  config.store = { ...(config.store ?? {}), options: { ...(config.store?.options ?? {}), walRestartThresholdBytes: Number(process.env.LIMIT) } };
  fs.writeFileSync(process.env.CONFIG, `${JSON.stringify(config, null, 2)}\n`);' \
  || { echo "[wal-pause] FAIL: could not write the limit into $CONFIG" >&2; exit 1; }
OFFSET="$(wc -l < "$LOG" | tr -d ' ')"
# The node's log from here on. The checks read the file themselves (awk on the
# file, not `... | grep -q`): under pipefail a reader that stops early turns a
# match into a failed pipeline.
since_start() { tail -n +"$((OFFSET + 1))" "$LOG" 2>/dev/null; }
logged() { # <fixed text> [<second fixed text>] -> 0 when one line since the start has it (and the second)
  awk -v offset="$OFFSET" -v first="$1" -v second="${2:-}" \
    'NR > offset && index($0, first) && (second == "" || index($0, second)) { found = 1 } END { exit found ? 0 : 1 }' "$LOG"
}
logged_line() { # <fixed text> -> the first such line since the start, without its prefix
  awk -v offset="$OFFSET" -v text="$1" 'NR > offset && index($0, text) { sub(/^.*\[oxigraph\] /, ""); print; exit }' "$LOG"
}
"$SCRIPT_DIR/devnet.sh" restart-node "$TARGET" > "$RESULTS/restart-limit.log" 2>&1 || true
wait_node_up "$TARGET" 120 || { echo "[wal-pause] FAIL: node $TARGET did not answer within 120s with the limit set (log: $RESULTS/restart-limit.log)" >&2; exit 1; }
say "node $TARGET restarted with the limit"

# ---------------------------------------------------------------------------
# 2. Write until the pause begins
# ---------------------------------------------------------------------------
# One request: create, seal and share an asset of <count> statements.
asset_body() { # <name> <count> <tag>
  ID="$GRAPH" NAME="$1" COUNT="$2" TAG="$3" node -e '
    const e = process.env, quads = [];
    for (let i = 0; i < Number(e.COUNT); i++) {
      quads.push({ subject: `urn:dkg-wal-pause:${e.TAG}:${i}`, predicate: "http://schema.org/name",
        object: JSON.stringify(`${e.TAG} statement ${i} ${"x".repeat(160)}`), graph: "" });
    }
    process.stdout.write(JSON.stringify({ contextGraphId: e.ID, name: e.NAME, quads, finalize: true, alsoShareSwm: true }));'
}
shared() { case "$(code_of "$1")" in 200|201) [ "$(field "$(body_of "$1")" swmShared)" = "true" ] ;; *) return 1 ;; esac; }
refused_not_started() {
  [ "$(code_of "$1")" = "503" ] && [ "$(field "$(body_of "$1")" code)" = "STORE_OPERATION_TIMEOUT" ] \
    && [ "$(field "$(body_of "$1")" outcome)" = "not_started" ] && [ "$(field "$(body_of "$1")" retryable)" = "true" ]
}

began=$(date +%s); writes=0; refused=0; paused=0; other=""
while [ $(( $(date +%s) - began )) -lt "$WAIT_S" ]; do
  if logged "$PAUSE_LINE"; then paused=1; break; fi
  writes=$((writes + 1))
  response="$(api "$TARGET" POST /api/knowledge-assets "$(asset_body "walp-$STAMP-fill-$writes" 300 "$STAMP-fill-$writes")")"
  if shared "$response"; then :
  elif refused_not_started "$response"; then refused=$((refused + 1)); sleep 2
  else other="HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; sleep 2
  fi
done
if [ "$paused" != "1" ]; then
  bad "node $TARGET did not pause within ${WAIT_S}s and $writes writes (the last answer that was neither a success nor the refusal: ${other:-none}). Does this build read store.options.walRestartThresholdBytes?"
  since_start | grep -E '\[oxigraph\]' | tail -n 8 | sed 's/^/[wal-pause]     /'
  exit 1
fi
ok "node $TARGET paused new store work after $writes writes and $(( $(date +%s) - began ))s: $(logged_line "$PAUSE_LINE")"

# ---------------------------------------------------------------------------
# 3. A write during the pause is refused, 4. and succeeds when repeated
# ---------------------------------------------------------------------------
NAME="walp-$STAMP-retried"
SUBJECT="urn:dkg-wal-pause:$STAMP-retried:0"
VALUE="$STAMP-retried statement 0 $(printf 'x%.0s' $(seq 1 160))"
BODY="$(asset_body "$NAME" 1 "$STAMP-retried")"
response="$(api "$TARGET" POST /api/knowledge-assets "$BODY")"
if refused_not_started "$response"; then
  ok "a write during the pause is refused as retryable and not started (HTTP 503, STORE_OPERATION_TIMEOUT): $(field "$(body_of "$response")" error)"
elif shared "$response"; then
  bad "a write sent right after the pause began was accepted: the node logged the pause and kept admitting store work"
else
  bad "a write during the pause was not refused the documented way (HTTP $(code_of "$response")): $(body_of "$response" | head -c 400)"
fi
retry_began=$(date +%s); attempts=1; done_at=""
if ! shared "$response"; then
  while [ $(( $(date +%s) - retry_began )) -lt "$RETRY_S" ]; do
    sleep 5
    attempts=$((attempts + 1))
    response="$(api "$TARGET" POST /api/knowledge-assets "$BODY")"
    if shared "$response"; then done_at=$(( $(date +%s) - retry_began )); break; fi
  done
  if [ -n "$done_at" ]; then
    ok "the same write succeeded when repeated: attempt $attempts, ${done_at}s after the refusal"
  else
    bad "the refused write did not succeed within ${RETRY_S}s ($attempts attempts; last answer HTTP $(code_of "$response"): $(body_of "$response" | head -c 300))"
  fi
fi

# ---------------------------------------------------------------------------
# 5. The store was restarted under supervision and the node serves again
# ---------------------------------------------------------------------------
if logged 'maintenance threshold after' 'terminating server for supervised recovery'; then
  ok "node $TARGET restarted its store for maintenance: $(logged_line 'terminating server for supervised recovery')"
else
  bad "node $TARGET did not log the supervised restart of its store for maintenance"
fi
if logged 'server restarted and healthy'; then
  ok "node $TARGET logged its store as restarted and healthy"
else
  bad "node $TARGET did not log its store as restarted and healthy"
fi
EXPECTED="$RESULTS/wal-pause.expected.json"
TARGET_NODE="$TARGET" WITNESS_NODE="$WITNESS" ID="$GRAPH" SUBJECT="$SUBJECT" VALUE="$VALUE" node -e '
  const e = process.env;
  const read = (node, who) => ({ label: `${who} node ${node} reads the write that was refused and repeated (shared memory)`,
    node: Number(node), contextGraphId: e.ID, view: "shared-working-memory", subject: e.SUBJECT, values: [e.VALUE] });
  process.stdout.write(JSON.stringify([read(e.TARGET_NODE, "paused"), read(e.WITNESS_NODE, "witness")]));' > "$EXPECTED"
if node "$SCRIPT_DIR/lib/qa/expected-state-cli.mjs" "$EXPECTED" --devnet-dir "$DEVNET_DIR" --api-port-base "$API_PORT_BASE" \
  --timeout-s 180 --interval-s 3 --out "$RESULTS/wal-pause.results.json" > "$RESULTS/wal-pause.reads.log" 2>&1; then
  ok "node $TARGET serves the write again and node $WITNESS received it"
else
  bad "the write that was refused and repeated does not read back on node $TARGET and node $WITNESS (results: $RESULTS/wal-pause.results.json)"
fi
sed 's/^/[wal-pause]     /' "$RESULTS/wal-pause.reads.log"
say "store lines of node $TARGET since the limit was set:"
since_start | grep -E '\[oxigraph\]' | grep -E 'maintenance threshold|terminating server|restart #|restarted and healthy|retained write-ahead log' | head -n 12 | sed -E 's/^/[wal-pause]     /'
say "requests refused while the node filled its log: $refused; 'Managed Oxigraph is recovering' lines in its log: $(since_start | grep -c 'Managed Oxigraph is recovering')"

# ---------------------------------------------------------------------------
# 6. Put the node back (also done by the trap on any other exit)
# ---------------------------------------------------------------------------
restore
echo
say "──────── SUMMARY ────────"
say "node $TARGET, limit $LIMIT bytes; checks passed=$PASS failed=$FAIL; $(( $(date +%s) - began ))s after the restart; results: $RESULTS"
if [ "$FAIL" -eq 0 ]; then say "PASS"; exit 0; fi
say "SOME CHECKS FAILED"
exit 1
