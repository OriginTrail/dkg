#!/usr/bin/env bash
#
# read-graphs build run: the devnet part of a run with read graphs in `build`
# on every node (docs/use-dkg/read-graphs.md). It drives a running devnet
# (./scripts/devnet.sh start 6) and neither starts nor stops it.
#
# Phases, in this order (READ_GRAPHS_RUN_PHASES picks a subset):
#   seed      with read graphs still off, run READ_GRAPHS_SEED_CMD (default
#             scripts/v10-rc-validation.sh) so the nodes hold data in every
#             layer before the read graphs are built;
#   setup     set query.readGraphs to READ_GRAPHS_SETTING (default "build":
#             every context graph and layer) in every node's config.json and
#             restart the nodes in ascending order;
#   backfill  wait until every node's read graphs are `ready` and record how
#             long that took, then run the full check on every node;
#   measure   record read graphs by state, triples per read graph and copies
#             per triple (scripts/read-graph-store-report.mjs), and the size of
#             each node's directory before and after;
#   gate      run READ_GRAPHS_GATE_CMD (default scripts/devnet-comprehensive.sh)
#             with read graphs on, wait for `ready`, then run the full check
#             again;
#   drills    a restart during a rebuild, a kill during writes, a CLI write
#             with the daemon down, a rollback and forward again, and the
#             setting to `off` and back. Each must end as designed (a new
#             generation, or a dropped partition), and then be `ready` again
#             with a clean full check.
#
# It writes report.md and results.tsv to READ_GRAPHS_RUN_RESULTS (default
# $DEVNET_DIR/read-graphs-build-run/<UTC timestamp>; no spaces). At the end it
# puts back every node's config.json, restarts the nodes in ascending order
# and drops their read graphs, unless READ_GRAPHS_RUN_KEEP=1.
#
# It reads read-graph state only through `dkg store read-graphs` (status --json,
# check --full, rebuild, drop); the read_graph_* functions below are the one
# place that parses their output.
#
# Exit codes (a run that exercised nothing never looks like a pass):
#   0 = PASS, 3 = INCONCLUSIVE (a precondition was unmet, or a step or a drill
#   did not run), any other non-zero = FAIL.
#
# Env knobs:
#   DEVNET_DIR, API_PORT_BASE                  as for every devnet script
#   READ_GRAPHS_SETTING                        JSON value of query.readGraphs (default "build")
#   READ_GRAPHS_RUN_PHASES                     default "seed setup backfill measure gate drills"
#   READ_GRAPHS_SEED_CMD, READ_GRAPHS_GATE_CMD the seed and gate commands
#   READ_GRAPHS_BACKFILL_TIMEOUT               seconds (default 1800)
#   READ_GRAPHS_READY_TIMEOUT                  seconds, after the gate and each drill (default 900)
#   READ_GRAPHS_DIRECT_WRITE_CGS               context graphs the gate writes into a store directly,
#                                              past the daemon (default catalog-fixture-small-graph);
#                                              their read graphs are rebuilt before the check
#   READ_GRAPHS_ROLLBACK_FROM                  devnet version ref for the rollback drill (default prev;
#                                              none skips the drill)
#   READ_GRAPHS_DRILL_{RESTART,KILL,CLI,ROLLBACK,FLAG}_NODE
#                                              the node of each drill (default 5, 6, 3, 4, 2)
#   READ_GRAPHS_RUN_RESULTS, READ_GRAPHS_RUN_KEEP
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
DEVNET_SH="${DEVNET_SH:-$REPO_ROOT/scripts/devnet.sh}"
DKG_CLI_ENTRY="${DKG_CLI_ENTRY:-$REPO_ROOT/packages/cli/dist/cli.js}"
SETTING="${READ_GRAPHS_SETTING:-\"build\"}"
PHASES="${READ_GRAPHS_RUN_PHASES:-seed setup backfill measure gate drills}"
SEED_CMD="${READ_GRAPHS_SEED_CMD:-$REPO_ROOT/scripts/v10-rc-validation.sh}"
GATE_CMD="${READ_GRAPHS_GATE_CMD:-$REPO_ROOT/scripts/devnet-comprehensive.sh}"
BACKFILL_TIMEOUT="${READ_GRAPHS_BACKFILL_TIMEOUT:-1800}"
READY_TIMEOUT="${READ_GRAPHS_READY_TIMEOUT:-900}"
DIRECT_WRITE_CGS="${READ_GRAPHS_DIRECT_WRITE_CGS:-catalog-fixture-small-graph}"
ROLLBACK_FROM="${READ_GRAPHS_ROLLBACK_FROM:-prev}"
# The module of the step `dkg rollback` runs before it switches versions (a test can point elsewhere).
ROLLBACK_MODULE="${READ_GRAPHS_ROLLBACK_MODULE:-$REPO_ROOT/packages/cli/dist/update/rollback-read-graphs.js}"
RESTART_NODE="${READ_GRAPHS_DRILL_RESTART_NODE:-5}"
KILL_NODE="${READ_GRAPHS_DRILL_KILL_NODE:-6}"
CLI_NODE="${READ_GRAPHS_DRILL_CLI_NODE:-3}"
ROLLBACK_NODE="${READ_GRAPHS_DRILL_ROLLBACK_NODE:-4}"
FLAG_NODE="${READ_GRAPHS_DRILL_FLAG_NODE:-2}"
KEEP="${READ_GRAPHS_RUN_KEEP:-0}"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS="${READ_GRAPHS_RUN_RESULTS:-$DEVNET_DIR/read-graphs-build-run/$RUN_ID}"
SKIP_EXIT=3

say() { echo "[read-graphs-run $(date -u +%H:%M:%S)] $*"; }
early_exit() { echo "[read-graphs-run] INCONCLUSIVE: $*"; exit "$SKIP_EXIT"; }

case "$RESULTS" in *" "*) early_exit "READ_GRAPHS_RUN_RESULTS must not contain a space: $RESULTS" ;; esac
[ -d "$DEVNET_DIR" ] || early_exit "no devnet at $DEVNET_DIR (start one first: ./scripts/devnet.sh start 6)"
command -v curl >/dev/null 2>&1 || early_exit "curl not available"
[ -x "$DEVNET_SH" ] || early_exit "no devnet.sh at $DEVNET_SH"
[ -f "$DKG_CLI_ENTRY" ] || early_exit "the CLI is not built ($DKG_CLI_ENTRY)"
node -e 'JSON.parse(process.argv[1])' "$SETTING" 2>/dev/null || early_exit "READ_GRAPHS_SETTING is not JSON: $SETTING"
# shellcheck source=devnet-lib.sh
. "$REPO_ROOT/scripts/devnet-lib.sh" || early_exit "cannot source scripts/devnet-lib.sh"
mkdir -p "$RESULTS/config" "$RESULTS/rows" "$RESULTS/checks" "$RESULTS/measure" || early_exit "cannot create $RESULTS"
: > "$RESULTS/results.tsv"
: > "$RESULTS/notes.md"

# The nodes of the run: every devnet node that answers now, in ascending order.
NODES=""
for dir in "$DEVNET_DIR"/node*; do
  num="${dir##*/node}"
  case "$num" in ''|*[!0-9]*) continue ;; esac
  [ -f "$dir/config.json" ] || continue
  if node_up "$num"; then NODES="$NODES $num"; else echo "- node${num} did not answer at the start and is not part of the run." >> "$RESULTS/notes.md"; fi
done
NODES="$(printf '%s\n' $NODES | sort -n | tr '\n' ' ')"
NODES="${NODES% }"
[ -n "${NODES// /}" ] || early_exit "no devnet node answers on its API port"

# ── results ───────────────────────────────────────────────────────────────
FAILS=0
GAPS=0
# record <step> <PASS|FAIL|INCONCLUSIVE> <seconds> <detail>
record() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULTS/results.tsv"
  case "$2" in FAIL) FAILS=$((FAILS + 1)) ;; INCONCLUSIVE) GAPS=$((GAPS + 1)) ;; esac
  say "$1: $2 ($3 s) $4"
}
note() { echo "- $*" >> "$RESULTS/notes.md"; }
now() { date +%s; }

# ── node control ───────────────────────────────────────────────────────────
dkg_cli() { local n="$1"; shift; DKG_HOME="$DEVNET_DIR/node$n" node "$DKG_CLI_ENTRY" "$@"; }
wait_up() {
  local n="$1" deadline=$(( $(now) + ${2:-180} ))
  while [ "$(now)" -lt "$deadline" ]; do node_up "$n" && return 0; sleep 2; done
  return 1
}
# restart_node <n> [VAR=value ...]: bounce one node through devnet.sh and wait for its API.
restart_node() {
  local n="$1"; shift
  env "$@" "$DEVNET_SH" restart-node "$n" >> "$RESULTS/devnet-sh.log" 2>&1 || true
  wait_up "$n" 180
}
stop_node() { "$DEVNET_SH" stop-node "$1" >> "$RESULTS/devnet-sh.log" 2>&1; }
start_node() {
  local n="$1"; shift
  env "$@" "$DEVNET_SH" start-node "$n" >> "$RESULTS/devnet-sh.log" 2>&1 || true
  wait_up "$n" 180
}
# set_read_graphs <n> <JSON value | "-">: write query.readGraphs into the node's config.json ("-" removes it).
set_read_graphs() {
  node -e '
    const fs = require("fs");
    const [file, value] = process.argv.slice(1);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const query = { ...(cfg.query ?? {}) };
    if (value === "-") delete query.readGraphs; else query.readGraphs = JSON.parse(value);
    if (Object.keys(query).length) cfg.query = query; else delete cfg.query;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$DEVNET_DIR/node$1/config.json" "$2"
}
# read_graphs_setting <n>: the node's query.readGraphs as JSON, or "" when it has none.
read_graphs_setting() {
  node -e '
    const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (cfg.query?.readGraphs !== undefined) process.stdout.write(JSON.stringify(cfg.query.readGraphs));
  ' "$DEVNET_DIR/node$1/config.json"
}
same_json() { node -e 'const [a, b] = process.argv.slice(1); process.exit(JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)) ? 0 : 1)' "$1" "$2" 2>/dev/null; }
# context_graph_count <n>: the context graphs the node lists as subscribed ("" when the list cannot be read).
context_graph_count() {
  local resp
  resp="$(api "$1" GET /api/context-graph/list)"
  [ "$(code_of "$resp")" = "200" ] || return 1
  body_of "$resp" | node -e '
    let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => {
      const j = JSON.parse(d);
      const list = Array.isArray(j) ? j : (j.contextGraphs ?? []);
      process.stdout.write(String(list.filter((cg) => cg.subscribed !== false).length));
    });'
}
node_commit() { field "$(body_of "$(api "$1" GET /api/status)")" version; printf ' '; field "$(body_of "$(api "$1" GET /api/status)")" commitShort; }
# store_endpoint <n>: the node's store query URL, or "" for a store only the daemon can read (embedded).
store_endpoint() {
  node -e '
    const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const { backend, options = {} } = cfg.store ?? {};
    if (backend === "oxigraph-server") process.stdout.write(`http://127.0.0.1:${options.port || 7878}/query`);
    else if (backend === "blazegraph" && typeof options.url === "string") process.stdout.write(options.url);
    else if (backend === "sparql-http" && typeof options.queryEndpoint === "string") process.stdout.write(options.queryEndpoint);
  ' "$DEVNET_DIR/node$1/config.json"
}

# ── the read-graph commands: the one place that parses their output ────────
# read_graph_rows <n>: one line per read graph, "<state> <generation> <read graph IRI>".
read_graph_rows() {
  local json
  json="$(dkg_cli "$1" store read-graphs status --json 2>> "$RESULTS/cli-errors.log")" || return 1
  printf '%s' "$json" | node -e '
    let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => {
      for (const row of JSON.parse(d).readGraphs ?? []) console.log(`${row.state} ${row.generation} ${row.readGraph}`);
    });'
}
# read_graph_check <n> <out>: the full check, both directions; exit 0 only when every read graph is consistent.
read_graph_check() { dkg_cli "$1" store read-graphs check --full --json > "$2" 2>&1; }
# read_graph_rebuild <n> [context graph]: rebuild the node's read graphs, or those of one context graph.
read_graph_rebuild() {
  if [ -n "${2:-}" ]; then dkg_cli "$1" store read-graphs rebuild --context-graph "$2" >> "$RESULTS/cli.log" 2>&1
  else dkg_cli "$1" store read-graphs rebuild >> "$RESULTS/cli.log" 2>&1; fi
}
read_graph_drop() { dkg_cli "$1" store read-graphs drop >> "$RESULTS/cli.log" 2>&1; }

dkg_cli "${NODES%% *}" store read-graphs --help > /dev/null 2>&1 \
  || early_exit "this build has no \`dkg store read-graphs\` commands"
# The build under test, as the first node reports it: "<version> <commit>".
UNDER_TEST="$(node_commit "${NODES%% *}")"

# all_ready <rows file>: at least one read graph, and every one ready.
all_ready() { [ -s "$1" ] && ! grep -qv '^ready ' "$1"; }
# settled <n> <rows file>: every read graph ready, or none because the node subscribes to no context graph.
settled() {
  if [ -s "$2" ]; then all_ready "$2"; return; fi
  [ "$(context_graph_count "$1")" = 0 ]
}
# wait_all_ready <label> <timeout> [nodes]: until every node has settled.
# Writes rows/<label>.node<N>, and to <label>.seconds a line per node:
# "node<N> <seconds since the wait began> <epoch seconds>" (polled every 5 s).
wait_all_ready() {
  local label="$1" timeout="$2" nodes="${3:-$NODES}" started deadline pending n rows
  started="$(now)"; deadline=$((started + timeout)); pending="$nodes"
  : > "$RESULTS/rows/$label.seconds"
  while [ -n "${pending// /}" ]; do
    local still=""
    for n in $pending; do
      rows="$RESULTS/rows/$label.node$n"
      if read_graph_rows "$n" > "$rows.tmp" && mv "$rows.tmp" "$rows" && settled "$n" "$rows"; then
        echo "node$n $(( $(now) - started )) $(now)" >> "$RESULTS/rows/$label.seconds"
      else
        still="$still $n"
      fi
    done
    pending="$still"
    [ -z "${pending// /}" ] && return 0
    if [ "$(now)" -ge "$deadline" ]; then
      for n in $pending; do echo "node$n not ready after ${timeout} s" >> "$RESULTS/rows/$label.seconds"; done
      return 1
    fi
    sleep 5
  done
  return 0
}
# full_checks <label> [nodes]: the full check on every node; 0 when every one is clean.
full_checks() {
  local label="$1" nodes="${2:-$NODES}" n bad=""
  for n in $nodes; do
    read_graph_check "$n" "$RESULTS/checks/$label.node$n.json" || bad="$bad node$n"
  done
  [ -z "$bad" ] && return 0
  echo "$bad" > "$RESULTS/checks/$label.failed"
  return 1
}
# generation_of <rows file> <read graph>
generation_of() { awk -v g="$2" '$3 == g { print $2 }' "$1"; }

# ── cleanup ────────────────────────────────────────────────────────────────
SETUP_DONE=0
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM
  if [ "$SETUP_DONE" = 1 ] && [ "$KEEP" != 1 ]; then
    say "putting back every node's config.json, restarting the nodes and dropping their read graphs"
    local n
    for n in $NODES; do
      [ -f "$RESULTS/config/node$n.json" ] && cp "$RESULTS/config/node$n.json" "$DEVNET_DIR/node$n/config.json"
    done
    for n in $NODES; do
      if ! restart_node "$n"; then note "cleanup: node$n did not come back after the restart"; status=1; continue; fi
      read_graph_drop "$n" || note "cleanup: dropping node$n's read graphs failed (see cli.log)"
    done
  fi
  write_report
  exit "$status"
}
write_report() {
  {
    echo "# Read-graph build run $RUN_ID"
    echo
    echo "- Setting: \`query.readGraphs = $SETTING\` on nodes $NODES"
    for n in $NODES; do echo "- node$n: $(node_commit "$n" 2>/dev/null)"; done
    echo
    echo "| Step | Result | Seconds | Detail |"
    echo "| --- | --- | --- | --- |"
    awk -F '\t' '{ printf "| %s | %s | %s | %s |\n", $1, $2, $3, $4 }' "$RESULTS/results.tsv"
    if [ -s "$RESULTS/rows/backfill-time" ]; then
      echo; echo "## Backfill time"; echo
      echo "From each node's restart with the setting to the first status poll (every 5 s) that showed it ready:"; echo
      sed 's/^/- /; s/$/ s/' "$RESULTS/rows/backfill-time"
    fi
    if ls "$RESULTS/measure/"*.summary > /dev/null 2>&1; then
      echo; echo "## Measurements"; echo; cat "$RESULTS/measure/"*.summary
    fi
    if [ -s "$RESULTS/notes.md" ]; then echo; echo "## Notes"; echo; cat "$RESULTS/notes.md"; fi
  } > "$RESULTS/report.md"
  say "report: $RESULTS/report.md"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# ── phases ─────────────────────────────────────────────────────────────────
phase_seed() {
  local started n count total=0
  started="$(now)"
  if "$SEED_CMD" > "$RESULTS/seed.log" 2>&1; then
    for n in $NODES; do count="$(context_graph_count "$n")" && total=$((total + count)); done
    if [ "$total" -gt 0 ]; then record seed PASS "$(( $(now) - started ))" "$total context graph subscriptions across the nodes"
    else record seed INCONCLUSIVE "$(( $(now) - started ))" "no node lists a context graph: the backfill would build nothing"; fi
  else
    record seed FAIL "$(( $(now) - started ))" "$(basename "$SEED_CMD") failed (seed.log)"
  fi
}

phase_setup() {
  local started n
  started="$(now)"
  : > "$RESULTS/measure/size-before.txt"
  for n in $NODES; do
    [ -f "$RESULTS/config/node$n.json" ] || cp "$DEVNET_DIR/node$n/config.json" "$RESULTS/config/node$n.json"
    du -sk "$DEVNET_DIR/node$n" | awk -v n="$n" '{ print "node" n " " $1 }' >> "$RESULTS/measure/size-before.txt"
  done
  SETUP_DONE=1
  for n in $NODES; do set_read_graphs "$n" "$SETTING" || { record setup FAIL "$(( $(now) - started ))" "could not write node$n's config.json"; return; }; done
  : > "$RESULTS/rows/restarted"
  for n in $NODES; do
    restart_node "$n" || { record setup FAIL "$(( $(now) - started ))" "node$n did not come back with the setting"; return; }
    echo "node$n $(now)" >> "$RESULTS/rows/restarted"
  done
  record setup PASS "$(( $(now) - started ))" "every node restarted with the setting"
}

phase_backfill() {
  local started n empty="" built=0
  started="$(now)"
  if ! wait_all_ready backfill "$BACKFILL_TIMEOUT"; then
    record backfill FAIL "$(( $(now) - started ))" "$(grep 'not ready' "$RESULTS/rows/backfill.seconds" | tr '\n' ';')"
    return
  fi
  for n in $NODES; do
    if [ -s "$RESULTS/rows/backfill.node$n" ]; then built=$((built + 1)); else empty="$empty node$n"; fi
  done
  # Backfill time: from the node's restart with the setting to the first poll that saw it ready.
  awk 'NR == FNR { restarted[$1] = $2; next } ($1 in restarted) { print $1, $3 - restarted[$1] }' \
    "$RESULTS/rows/restarted" "$RESULTS/rows/backfill.seconds" > "$RESULTS/rows/backfill-time" 2>/dev/null || true
  [ -z "$empty" ] || note "backfill: no read graph on nodes that subscribe to no context graph:$empty"
  if full_checks backfill; then
    if [ "$built" = 0 ]; then record backfill INCONCLUSIVE "$(( $(now) - started ))" "no node built a read graph"
    else record backfill PASS "$(( $(now) - started ))" "read graphs ready on $built nodes, full check clean"; fi
  else
    record backfill FAIL "$(( $(now) - started ))" "full check not clean on:$(cat "$RESULTS/checks/backfill.failed")"
  fi
}

phase_measure() {
  local started n endpoint ok=1
  started="$(now)"
  for n in $NODES; do
    du -sk "$DEVNET_DIR/node$n" | awk -v n="$n" '{ print "node" n " " $1 }' >> "$RESULTS/measure/size-after.txt"
    endpoint="$(store_endpoint "$n")"
    if [ -z "$endpoint" ]; then note "measure: node$n's store is embedded; only its states are recorded"; continue; fi
    node "$REPO_ROOT/scripts/read-graph-store-report.mjs" --endpoint "$endpoint" > "$RESULTS/measure/node$n.json" 2>> "$RESULTS/measure/errors.log" || { ok=0; continue; }
    node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const triples = r.readGraphs.reduce((sum, g) => sum + g.triples, 0);
      const copies = {};
      for (const g of r.readGraphs) for (const [k, v] of Object.entries(g.copies)) copies[k] = (copies[k] ?? 0) + v;
      const states = require("fs").readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean)
        .reduce((acc, line) => { const s = line.split(" ")[0]; acc[s] = (acc[s] ?? 0) + 1; return acc; }, {});
      console.log(`- node${process.argv[3]}: status ${JSON.stringify(states)}; the store holds ${r.readGraphs.length} read graphs`
        + ` with ${triples} triples; copies per triple (sampled, an upper bound) ${JSON.stringify(copies)}`);
    ' "$RESULTS/measure/node$n.json" "$RESULTS/rows/backfill.node$n" "$n" > "$RESULTS/measure/node$n.summary" 2>> "$RESULTS/measure/errors.log" || ok=0
  done
  {
    echo "- Node directory sizes (KiB), before the setup and after the backfill:"
    join <(sort "$RESULTS/measure/size-before.txt") <(sort "$RESULTS/measure/size-after.txt") 2>/dev/null | sed 's/^/  - /'
  } > "$RESULTS/measure/sizes.summary"
  if [ "$ok" = 1 ]; then record measure PASS "$(( $(now) - started ))" "see Measurements"
  else record measure INCONCLUSIVE "$(( $(now) - started ))" "a store report failed (measure/errors.log)"; fi
}

phase_gate() {
  local started rc n cg lost="" rebuilt=""
  started="$(now)"
  "$GATE_CMD" > "$RESULTS/gate.log" 2>&1; rc=$?
  for n in $NODES; do same_json "$(read_graphs_setting "$n")" "$SETTING" || lost="$lost node$n"; done
  if [ -n "$lost" ]; then
    record gate FAIL "$(( $(now) - started ))" "the setting is gone from:$lost (a suite rewrote the node's config)"
    return
  fi
  note "gate: nodes a suite adds for itself run with read graphs off."
  if ! wait_all_ready after-gate "$READY_TIMEOUT"; then
    record gate FAIL "$(( $(now) - started ))" "read graphs not ready after the gate: $(grep 'not ready' "$RESULTS/rows/after-gate.seconds" | tr '\n' ';')"
    return
  fi
  for n in $NODES; do
    for cg in $DIRECT_WRITE_CGS; do
      grep -qF "did:dkg:context-graph:$cg/_~read/" "$RESULTS/rows/after-gate.node$n" || continue
      read_graph_rebuild "$n" "$cg" && rebuilt="$rebuilt node$n:$cg"
    done
  done
  if [ -n "$rebuilt" ]; then
    note "gate: rebuilt the read graphs of context graphs a suite writes into the store directly:$rebuilt"
    wait_all_ready after-gate-rebuild "$READY_TIMEOUT" || { record gate FAIL "$(( $(now) - started ))" "rebuilt read graphs not ready"; return; }
  fi
  if ! full_checks after-gate; then
    record gate FAIL "$(( $(now) - started ))" "full check not clean after the gate on:$(cat "$RESULTS/checks/after-gate.failed")"
  elif [ "$rc" = 0 ]; then
    record gate PASS "$(( $(now) - started ))" "the gate passed with read graphs on; full check clean"
  elif [ "$rc" = "$SKIP_EXIT" ]; then
    record gate INCONCLUSIVE "$(( $(now) - started ))" "the gate was inconclusive (gate.log); full check clean"
  else
    record gate FAIL "$(( $(now) - started ))" "the gate failed with exit $rc (gate.log)"
  fi
}

# drill_end <drill> <node> <started> <detail>: ready again, and a clean full check.
drill_end() {
  if ! wait_all_ready "$1" "$READY_TIMEOUT" "$2"; then record "$1" FAIL "$(( $(now) - $3 ))" "node$2's read graphs not ready afterwards"
  elif ! full_checks "$1" "$2"; then record "$1" FAIL "$(( $(now) - $3 ))" "node$2's full check not clean afterwards"
  else record "$1" PASS "$(( $(now) - $3 ))" "$4"; fi
}

drill_restart_during_rebuild() {
  local n="$RESTART_NODE" started before caught="" i state graph gen_before gen_after older=""
  started="$(now)"; before="$RESULTS/rows/restart.before.node$n"
  read_graph_rows "$n" > "$before" && all_ready "$before" || { record drill-restart INCONCLUSIVE 0 "node$n had no ready read graph to rebuild"; return; }
  read_graph_rebuild "$n" || { record drill-restart FAIL "$(( $(now) - started ))" "rebuild refused on node$n (cli.log)"; return; }
  for i in $(seq 1 150); do
    read_graph_rows "$n" > "$RESULTS/rows/restart.caught.node$n" 2>/dev/null || true
    if grep -qv '^ready ' "$RESULTS/rows/restart.caught.node$n"; then caught=1; break; fi
    sleep 0.2
  done
  [ -n "$caught" ] || { record drill-restart INCONCLUSIVE "$(( $(now) - started ))" "every rebuild on node$n ended before a restart could start"; return; }
  restart_node "$n" || { record drill-restart FAIL "$(( $(now) - started ))" "node$n did not come back"; return; }
  if ! wait_all_ready drill-restart "$READY_TIMEOUT" "$n"; then record drill-restart FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the restart"; return; fi
  # Each read graph the restart caught unfinished must have a new generation.
  while read -r state gen_before graph; do
    [ "$state" = ready ] && continue
    gen_after="$(generation_of "$RESULTS/rows/drill-restart.node$n" "$graph")"
    [ -n "$gen_after" ] && [ "$gen_after" != "$gen_before" ] || older="$older <$graph>"
  done < "$RESULTS/rows/restart.caught.node$n"
  [ -z "$older" ] || { record drill-restart FAIL "$(( $(now) - started ))" "no new generation for:$older"; return; }
  drill_end drill-restart "$n" "$started" "unfinished read graphs got a new generation and were rebuilt"
}

drill_kill_during_write() {
  local n="$KILL_NODE" started cg pid command writer
  started="$(now)"; cg="read-graphs-drill-$(echo "$RUN_ID" | tr 'A-Z' 'a-z')"
  case "$(code_of "$(api "$n" POST /api/context-graph/create "{\"id\":\"$cg\",\"name\":\"Read-graph drill\"}")")" in
    200|201|409) ;;
    *) record drill-kill INCONCLUSIVE 0 "could not create context graph $cg on node$n"; return ;;
  esac
  (
    export DKG_API_MAXTIME=15
    for i in $(seq 1 300); do
      api "$n" POST /api/knowledge-assets "{\"contextGraphId\":\"$cg\",\"name\":\"drill-$i\"}" > /dev/null 2>&1 || true
      api "$n" POST "/api/knowledge-assets/drill-$i/wm/write" \
        "{\"contextGraphId\":\"$cg\",\"quads\":[{\"subject\":\"urn:read-graphs-drill:$i\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"drill $i\\\"\"}]}" > /dev/null 2>&1 || true
      api "$n" POST "/api/knowledge-assets/drill-$i/swm/share" "{\"contextGraphId\":\"$cg\",\"entities\":\"all\"}" > /dev/null 2>&1 || true
    done
  ) &
  writer=$!
  sleep 5
  pid="$(tr -d '[:space:]' < "$DEVNET_DIR/node$n/daemon.pid" 2>/dev/null)"
  command="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$command" in
    *daemon-worker*|*daemon-foreground-worker*) kill -9 "$pid" ;;
    *) kill "$writer" 2>/dev/null; wait "$writer" 2>/dev/null
       record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "node$n's daemon.pid does not name its daemon worker"; return ;;
  esac
  kill "$writer" 2>/dev/null; wait "$writer" 2>/dev/null
  # The supervisor starts a new worker; restart the node if it does not.
  wait_up "$n" 120 || restart_node "$n" || { record drill-kill FAIL "$(( $(now) - started ))" "node$n did not come back after the kill"; return; }
  drill_end drill-kill "$n" "$started" "killed node$n's daemon during writes to $cg"
}

drill_cli_write_daemon_down() {
  local n="$CLI_NODE" started rc
  started="$(now)"
  stop_node "$n" || { record drill-cli INCONCLUSIVE 0 "could not stop node$n"; return; }
  dkg_cli "$n" publisher clear failed > "$RESULTS/drill-cli.log" 2>&1; rc=$?
  start_node "$n" || { record drill-cli FAIL "$(( $(now) - started ))" "node$n did not come back"; return; }
  [ "$rc" = 0 ] || { record drill-cli FAIL "$(( $(now) - started ))" "\`dkg publisher clear failed\` exited $rc with the daemon down (drill-cli.log)"; return; }
  drill_end drill-cli "$n" "$started" "\`dkg publisher clear failed\` opened and wrote node$n's store with the daemon down"
}

drill_rollback_and_forward() {
  local n="$ROLLBACK_NODE" started dropped version
  started="$(now)"
  [ "$ROLLBACK_FROM" != none ] || { record drill-rollback INCONCLUSIVE 0 "not run (READ_GRAPHS_ROLLBACK_FROM=none)"; return; }
  read_graph_rows "$n" > "$RESULTS/rows/rollback.before.node$n" && [ -s "$RESULTS/rows/rollback.before.node$n" ] \
    || { record drill-rollback INCONCLUSIVE 0 "node$n has no read graph to drop"; return; }
  stop_node "$n" || { record drill-rollback INCONCLUSIVE 0 "could not stop node$n"; return; }
  # The step `dkg rollback` runs before it switches versions.
  dropped="$(DKG_HOME="$DEVNET_DIR/node$n" node --input-type=module -e '
    const { dropReadGraphsForRollback } = await import(process.argv[1]);
    const dropped = await dropReadGraphsForRollback(process.env.DKG_HOME, (line) => console.error(line));
    console.log(dropped ?? 0);
  ' "$ROLLBACK_MODULE" 2>> "$RESULTS/drill-rollback.log")"
  case "$dropped" in ''|*[!0-9]*|0)
    start_node "$n" > /dev/null
    record drill-rollback FAIL "$(( $(now) - started ))" "the rollback step dropped nothing on node$n (drill-rollback.log)"; return ;;
  esac
  # The earlier release does not know the setting; it runs without it.
  set_read_graphs "$n" "-"
  if ! start_node "$n" DEVNET_VERSION_LAYOUT="all:current,$n:$ROLLBACK_FROM"; then
    set_read_graphs "$n" "$SETTING"; start_node "$n" > /dev/null
    record drill-rollback FAIL "$(( $(now) - started ))" "node$n did not start on $ROLLBACK_FROM (devnet-sh.log)"; return
  fi
  version="$(node_commit "$n")"
  if [ "$version" = "$UNDER_TEST" ]; then
    stop_node "$n"; set_read_graphs "$n" "$SETTING"; start_node "$n" DEVNET_VERSION_LAYOUT="all:current" > /dev/null
    record drill-rollback FAIL "$(( $(now) - started ))" "node$n still ran the build under test ($version), not $ROLLBACK_FROM"; return
  fi
  stop_node "$n"
  set_read_graphs "$n" "$SETTING"
  start_node "$n" DEVNET_VERSION_LAYOUT="all:current" || { record drill-rollback FAIL "$(( $(now) - started ))" "node$n did not come back on the build under test"; return; }
  drill_end drill-rollback "$n" "$started" "dropped $dropped read-graph graphs, ran $version, then rebuilt from nothing"
}

drill_flag_off_and_back() {
  local n="$FLAG_NODE" started undirty="" state gen graph gen_after older=""
  started="$(now)"
  read_graph_rows "$n" > "$RESULTS/rows/flag.before.node$n" && all_ready "$RESULTS/rows/flag.before.node$n" \
    || { record drill-flag INCONCLUSIVE 0 "node$n had no ready read graph"; return; }
  set_read_graphs "$n" '"off"'
  restart_node "$n" || { set_read_graphs "$n" "$SETTING"; record drill-flag FAIL "$(( $(now) - started ))" "node$n did not come back with off"; return; }
  read_graph_rows "$n" > "$RESULTS/rows/flag.off.node$n" || true
  while read -r state gen graph; do [ "$state" = dirty ] || undirty="$undirty <$graph>:$state"; done < "$RESULTS/rows/flag.off.node$n"
  set_read_graphs "$n" "$SETTING"
  if [ ! -s "$RESULTS/rows/flag.off.node$n" ]; then
    restart_node "$n"; record drill-flag INCONCLUSIVE "$(( $(now) - started ))" "status listed no read graph with off"; return
  fi
  [ -z "$undirty" ] || { restart_node "$n"; record drill-flag FAIL "$(( $(now) - started ))" "with off, not dirty:$undirty"; return; }
  restart_node "$n" || { record drill-flag FAIL "$(( $(now) - started ))" "node$n did not come back with the setting"; return; }
  if ! wait_all_ready drill-flag "$READY_TIMEOUT" "$n"; then record drill-flag FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the setting came back"; return; fi
  while read -r state gen graph; do
    gen_after="$(generation_of "$RESULTS/rows/drill-flag.node$n" "$graph")"
    [ -n "$gen_after" ] && [ "$gen_after" != "$gen" ] || older="$older <$graph>"
  done < "$RESULTS/rows/flag.before.node$n"
  [ -z "$older" ] || { record drill-flag FAIL "$(( $(now) - started ))" "no new generation for:$older"; return; }
  drill_end drill-flag "$n" "$started" "off marked every read graph dirty; back on, each got a new generation and was rebuilt"
}

phase_drills() {
  local n
  for n in "$RESTART_NODE" "$KILL_NODE" "$CLI_NODE" "$ROLLBACK_NODE" "$FLAG_NODE"; do
    case " $NODES " in *" $n "*) ;; *) record drills INCONCLUSIVE 0 "drill node node$n is not part of the run"; return ;; esac
  done
  drill_restart_during_rebuild
  drill_kill_during_write
  drill_cli_write_daemon_down
  drill_rollback_and_forward
  drill_flag_off_and_back
}

say "nodes $NODES; setting $SETTING; results in $RESULTS"
for phase in $PHASES; do
  case "$phase" in
    seed|setup|backfill|measure|gate|drills) ;;
    *) record "$phase" INCONCLUSIVE 0 "unknown phase"; continue ;;
  esac
  [ "$FAILS" = 0 ] || { record "$phase" INCONCLUSIVE 0 "not run: an earlier step failed"; continue; }
  "phase_$phase"
done
for phase in seed setup backfill measure gate drills; do
  case " $PHASES " in *" $phase "*) ;; *) note "$phase was not run (READ_GRAPHS_RUN_PHASES)"; GAPS=$((GAPS + 1)) ;; esac
done

if [ "$FAILS" -gt 0 ]; then say "FAIL"; exit 1; fi
if [ "$GAPS" -gt 0 ]; then say "INCONCLUSIVE"; exit "$SKIP_EXIT"; fi
say "PASS"
exit 0
