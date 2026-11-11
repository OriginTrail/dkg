#!/usr/bin/env bash
#
# read-graphs build run: the devnet part of a run with read graphs in `build`
# on every node (docs/use-dkg/read-graphs.md). It drives a running devnet
# (./scripts/devnet.sh start 6) and neither starts nor stops it.
#
# Phases, in this order (READ_GRAPHS_RUN_PHASES picks a subset):
#   seed      with read graphs still off, run READ_GRAPHS_SEED_CMD (default
#             scripts/v10-rc-validation.sh) so the nodes hold data in every
#             layer before the read graphs are built; then have each node's
#             own agent write one working-memory draft into a context graph
#             the node creates for it;
#   setup     check that no node holds a ready read graph yet, so the
#             backfill is fresh; then set query.readGraphs to
#             READ_GRAPHS_SETTING (default "build": every context graph and
#             layer) in every node's config.json and restart the nodes in
#             ascending order;
#   backfill  wait until every node's read graphs are `ready` and record how
#             long that took, then run the full check on every node. A node
#             must also list the read graphs it is expected to keep, worked
#             out without its status: for each context graph it subscribes
#             to that can have read graphs, and each sub-graph registered in
#             it, the read graph of each shared layer its setting keeps, and
#             the working-memory read graph of the seeded draft, by the
#             build's own rules;
#   measure   record read graphs by state, triples per read graph and copies
#             per triple (scripts/read-graph-store-report.mjs), and the size of
#             each node's directory before and after;
#   gate      run READ_GRAPHS_GATE_CMD (default scripts/devnet-comprehensive.sh)
#             with read graphs on, wait for `ready`, then run the full check
#             again. Every mismatch a check logs during the workload fails the
#             gate, even when the read graph was rebuilt by the end (except in
#             the context graphs a suite writes into the store directly). Only a complete pass of the comprehensive run counts
#             (completeSuccess in its REPORT.json); a filtered run is
#             INCONCLUSIVE;
#   drills    a restart during a rebuild; a kill of the daemon worker while it
#             holds a working-memory write, with that agent's read graph
#             built first (a kill counts only when the write's whole request
#             was uploaded and dropped unanswered, and its data is there after
#             the restart, so the worker had begun to store it; the
#             worker gone and a new one in its place; every write the node acknowledged must be there after
#             it, and the agent's working-memory read graph ready and
#             consistent); a CLI write with the daemon down (`dkg publisher clear
#             finalized` on a node that has such jobs, which must stay
#             cleared; a store opened outside the daemon marks every read
#             graph it finds dirty before it writes, so each shared-layer read
#             graph, which a plain restart first keeps at its generation, must
#             get a new one and be rebuilt); a rollback and forward again (the
#             earlier release is
#             built first; `dkg rollback --stores-for <its version>` readies the
#             stopped node's stores, and after it the node's store must hold
#             no read-graph partition and every asset graph as before; the
#             earlier daemon must answer the node's seeded working-memory
#             draft and a verifiable-memory asset through /api/query as the
#             build under test did; and
#             after the forward start every asset graph again, so the drill
#             node needs a store that stays up with its daemon down:
#             Blazegraph or an external SPARQL endpoint); and the setting to
#             `off` and back. Each must end
#             as designed (a new generation, or a dropped partition), and then
#             be `ready` again with a clean full check. A drill whose workload
#             did not happen is INCONCLUSIVE, never a pass.
#
# It writes report.md and results.tsv to READ_GRAPHS_RUN_RESULTS (default
# $DEVNET_DIR/read-graphs-build-run/<UTC timestamp>; no spaces). It saves every
# node's config.json before any phase runs. At the end, also after a failure or
# an interruption, it puts back the config.json of each node it changed,
# restarts those nodes in ascending order, and drops the read graphs that their
# own settings do not keep, unless READ_GRAPHS_RUN_KEEP=1.
#
# It reads read-graph state only through `dkg store read-graphs` (status, check,
# rebuild and drop, each with --json), which ask the running daemon; the
# read_graph_* functions and check_verdict below are the one place that parses
# their output. A full check counts as clean only when every read graph it
# checked is consistent: a skipped or interrupted one is checked again.
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
# The devnet's store endpoint resolver (a test can point it elsewhere).
ENDPOINT_RESOLVER="${READ_GRAPHS_ENDPOINT_RESOLVER:-$REPO_ROOT/scripts/lib/qa/devnet-storage-endpoint.mjs}"
LISTING_MODULE="$REPO_ROOT/scripts/lib/qa/context-graph-listing.mjs"
# The build's own read-graph rules: names and eligibility (core), modes (storage), the setting's parser (CLI).
CORE_MODULE="${READ_GRAPHS_CORE_MODULE:-$REPO_ROOT/packages/core/dist/index.js}"
STORAGE_MODULE="${READ_GRAPHS_STORAGE_MODULE:-$REPO_ROOT/packages/storage/dist/index.js}"
QUERY_CONFIG_MODULE="${READ_GRAPHS_QUERY_CONFIG_MODULE:-$REPO_ROOT/packages/cli/dist/read-graphs-config.js}"
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
# Evidence from an earlier run must never count for this one.
[ ! -e "$RESULTS" ] || [ -z "$(ls -A "$RESULTS" 2>/dev/null)" ] || early_exit "READ_GRAPHS_RUN_RESULTS already holds files ($RESULTS): use a fresh directory"
[ -d "$DEVNET_DIR" ] || early_exit "no devnet at $DEVNET_DIR (start one first: ./scripts/devnet.sh start 6)"
command -v curl >/dev/null 2>&1 || early_exit "curl not available"
[ -x "$DEVNET_SH" ] || early_exit "no devnet.sh at $DEVNET_SH"
[ -f "$DKG_CLI_ENTRY" ] || early_exit "the CLI is not built ($DKG_CLI_ENTRY)"
node -e 'JSON.parse(process.argv[1])' "$SETTING" 2>/dev/null || early_exit "READ_GRAPHS_SETTING is not JSON: $SETTING"
CORE_MODULE="$CORE_MODULE" STORAGE_MODULE="$STORAGE_MODULE" QUERY_CONFIG_MODULE="$QUERY_CONFIG_MODULE" node --input-type=module -e '
  const core = await import(process.env.CORE_MODULE);
  const storage = await import(process.env.STORAGE_MODULE);
  const queryConfig = await import(process.env.QUERY_CONFIG_MODULE);
  const ok = ["isReadGraphEligibleContextGraphId", "readGraphIri", "readScope", "parseReadGraphIri"].every((name) => typeof core[name] === "function")
    && typeof core.MemoryLayer === "object" && typeof storage.readGraphModeOf === "function" && typeof queryConfig.resolveQueryConfig === "function";
  process.exit(ok ? 0 : 1);' 2>/dev/null \
  || early_exit "the build lacks the read-graph rules this run uses (core, storage and CLI dist: names, modes, the setting's parser)"
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
# Set when a step's precondition was not met: the later steps do not run.
STOPPED=0
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
# The nodes whose config or running state this run changed; cleanup puts them back.
CHANGED=""
changed() { CHANGED="$CHANGED $1"; }
stop_node() { changed "$1"; "$DEVNET_SH" stop-node "$1" >> "$RESULTS/devnet-sh.log" 2>&1; }
start_node() {
  local n="$1"; shift
  env "$@" "$DEVNET_SH" start-node "$n" >> "$RESULTS/devnet-sh.log" 2>&1 || true
  wait_up "$n" 180
}
# set_read_graphs <n> <JSON value | "-">: write query.readGraphs into the node's config.json ("-" removes it).
set_read_graphs() {
  changed "$1"
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
# context_graph_count <n>: the context graphs the node subscribes to that can have read graphs, read with the
# devnet's listing parser and the core package's rule (IDs from before the rule for new IDs get none);
# fails when the listing cannot be read.
context_graph_count() {
  # The module paths go in the environment: the listing module runs as a command when argv[1] names it.
  api "$1" GET /api/context-graph/list | LISTING_MODULE="$LISTING_MODULE" CORE_MODULE="$CORE_MODULE" node --input-type=module -e '
    const { readListing } = await import(process.env.LISTING_MODULE);
    const { isReadGraphEligibleContextGraphId: eligible } = await import(process.env.CORE_MODULE);
    let frame = ""; for await (const chunk of process.stdin) frame += chunk;
    const newline = frame.indexOf("\n");
    const listing = readListing(Number(newline === -1 ? frame : frame.slice(0, newline)), newline === -1 ? "" : frame.slice(newline + 1));
    if (!listing.ok) { console.error(listing.reason); process.exit(1); }
    process.stdout.write(String(listing.graphs.filter((graph) => graph.subscribed === true && eligible(graph.id)).length));
  '
}
# expected_read_graphs <n>: the read graphs node <n> must keep, worked out without its status: for each context
# graph it subscribes to that can have read graphs, and for each sub-graph registered in it, the read graph of each
# shared layer whose mode under the node's setting is not off, and the working-memory read graph of the draft the seed
# phase wrote, by the build's own rules. Other working-memory read graphs are required as status lists them (the kill
# drill requires its own).
expected_read_graphs() {
  local setting frames cg agent i=0
  setting="$(read_graphs_setting "$1")"
  frames="$RESULTS/rows/expected-input.node$1"
  # The node's listing, then one sub-graph listing per context graph it subscribes to (frame <i>, named in the index).
  api "$1" GET /api/context-graph/list > "$frames.listing" || return 1
  rm -f "$frames".sub.*; : > "$frames.index"
  for cg in $(LISTING_MODULE="$LISTING_MODULE" CORE_MODULE="$CORE_MODULE" node --input-type=module -e '
      const { readListing } = await import(process.env.LISTING_MODULE);
      const core = await import(process.env.CORE_MODULE);
      const frame = (await import("node:fs")).readFileSync(process.argv[1], "utf8"); const newline = frame.indexOf("\n");
      const listing = readListing(Number(frame.slice(0, newline)), frame.slice(newline + 1));
      if (!listing.ok) { console.error(listing.reason); process.exit(1); }
      for (const graph of listing.graphs) {
        if (graph.subscribed === true && core.isReadGraphEligibleContextGraphId(graph.id)) console.log(encodeURIComponent(graph.id));
      }
    ' "$frames.listing"); do
    i=$((i + 1))
    api "$1" GET "/api/sub-graph/list?contextGraphId=$cg" > "$frames.sub.$i" || return 1
    printf '%s %s\n' "$i" "$cg" >> "$frames.index"
  done
  SETTING_JSON="${setting:-\"off\"}" LISTING_MODULE="$LISTING_MODULE" CORE_MODULE="$CORE_MODULE" \
    STORAGE_MODULE="$STORAGE_MODULE" QUERY_CONFIG_MODULE="$QUERY_CONFIG_MODULE" node --input-type=module -e '
    const fs = await import("node:fs");
    const { readListing } = await import(process.env.LISTING_MODULE);
    const core = await import(process.env.CORE_MODULE);
    const { readGraphModeOf } = await import(process.env.STORAGE_MODULE);
    const { resolveQueryConfig } = await import(process.env.QUERY_CONFIG_MODULE);
    const frame = fs.readFileSync(process.argv[1], "utf8"); const newline = frame.indexOf("\n");
    const listing = readListing(Number(frame.slice(0, newline)), frame.slice(newline + 1));
    if (!listing.ok) { console.error(listing.reason); process.exit(1); }
    // Registered sub-graphs as the builder takes them: valid names, each once.
    const subGraphs = new Map();
    for (const line of fs.readFileSync(`${process.argv[1].slice(0, -".listing".length)}.index`, "utf8").split("\n").filter(Boolean)) {
      const [index, encoded] = line.split(" "); const id = decodeURIComponent(encoded);
      const answer = fs.readFileSync(`${process.argv[1].slice(0, -".listing".length)}.sub.${index}`, "utf8"); const at = answer.indexOf("\n");
      if (answer.slice(0, at) !== "200") { console.error(`the sub-graph list of ${id} answered HTTP ${answer.slice(0, at)}`); process.exit(1); }
      let body; try { body = JSON.parse(answer.slice(at + 1)); } catch { console.error(`the sub-graph list of ${id} is not JSON`); process.exit(1); }
      if (!Array.isArray(body.subGraphs)) { console.error(`the sub-graph list of ${id} has no subGraphs`); process.exit(1); }
      const names = body.subGraphs.map((sub) => sub?.name).filter((name) => typeof name === "string" && core.validateSubGraphName(name).valid);
      subGraphs.set(id, [...new Set(names)]);
    }
    const modes = resolveQueryConfig({ readGraphs: JSON.parse(process.env.SETTING_JSON) }).readGraphs;
    for (const graph of listing.graphs) {
      if (graph.subscribed !== true || !core.isReadGraphEligibleContextGraphId(graph.id)) continue;
      const scopes = [core.readScope(graph.id), ...(subGraphs.get(graph.id) ?? []).map((name) => core.readScope(graph.id, name))];
      for (const scope of scopes) for (const layer of [core.MemoryLayer.VerifiableMemory, core.MemoryLayer.SharedWorkingMemory]) {
        const key = { scope, layer };
        if (readGraphModeOf(modes, key) === "off") continue;
        console.log(core.readGraphIri(key));
      }
    }
  ' "$frames.listing" || return 1
  # The working-memory read graph of the draft the seed phase wrote, when the node's setting keeps it.
  if [ -s "$RESULTS/rows/seed-wm.node$1" ]; then
    read -r cg agent < "$RESULTS/rows/seed-wm.node$1"
    wm_read_graph "$1" "$cg" "$agent" || return 1
  fi
}
# wm_read_graph <n> <context graph> <agent address>: the IRI of that agent's working-memory read graph in the context
# graph, by the build's own rules, when node <n>'s setting keeps it; nothing when the setting does not.
wm_read_graph() {
  local setting
  setting="$(read_graphs_setting "$1")"
  SETTING_JSON="${setting:-\"off\"}" CORE_MODULE="$CORE_MODULE" STORAGE_MODULE="$STORAGE_MODULE" QUERY_CONFIG_MODULE="$QUERY_CONFIG_MODULE" \
    CG="$2" AGENT="$3" node --input-type=module -e '
    const core = await import(process.env.CORE_MODULE);
    const { readGraphModeOf } = await import(process.env.STORAGE_MODULE);
    const { resolveQueryConfig } = await import(process.env.QUERY_CONFIG_MODULE);
    const modes = resolveQueryConfig({ readGraphs: JSON.parse(process.env.SETTING_JSON) }).readGraphs;
    const key = { scope: core.readScope(process.env.CG), layer: core.MemoryLayer.WorkingMemory, agentAddress: process.env.AGENT };
    if (readGraphModeOf(modes, key) !== "off") console.log(core.readGraphIri(key));
  '
}
# wait_read_graph_ready <n> <read graph> <timeout> <rows file>: until node <n>'s status lists that read graph as ready.
wait_read_graph_ready() {
  local deadline=$(( $(now) + $3 ))
  while [ "$(now)" -lt "$deadline" ]; do
    read_graph_rows "$1" > "$4" 2>/dev/null && awk -v g="$2" '$3 == g && $1 == "ready" { found = 1 } END { exit !found }' "$4" && return 0
    sleep 5
  done
  return 1
}
node_commit() { field "$(body_of "$(api "$1" GET /api/status)")" version; printf ' '; field "$(body_of "$(api "$1" GET /api/status)")" commitShort; }
# query_rows <out> <n> <context graph> <view> <sparql> <var>...: writes node <n>'s answer to a view query into <out>,
# one JSON array per row with the values of <var>... in order: an IRI bare, a literal by its lexical form, however
# the release renders it ("lexical"^^<datatype>, "lexical"@lang, bare, or as an object). Prints why, and fails,
# unless the node answers 200 with bindings.
query_rows() {
  local out="$1" n="$2" body resp
  body="$(node -e 'const [contextGraphId, view, sparql] = process.argv.slice(1); console.log(JSON.stringify({ contextGraphId, view, sparql }));' "$3" "$4" "$5")"
  shift 5
  resp="$(api "$n" POST /api/query "$body")"
  [ "$(code_of "$resp")" = 200 ] || { echo "HTTP $(code_of "$resp")"; return 1; }
  body_of "$resp" | node -e '
    let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => {
      let bindings;
      try { bindings = JSON.parse(d).result?.bindings; } catch { bindings = undefined; }
      if (!Array.isArray(bindings)) process.exit(1);
      const value = (v) => {
        const text = String(v && typeof v === "object" ? v.value ?? "" : v ?? "");
        const literal = /^"((?:[^"\\]|\\.)*)"(?:\^\^<[^>]*>|@[A-Za-z0-9-]+)?$/.exec(text);
        return literal ? literal[1].replace(/\\(.)/g, "$1") : text.replace(/^<(.*)>$/, "$1");
      };
      for (const b of bindings) console.log(JSON.stringify(process.argv.slice(1).map((name) => value(b[name]))));
    });' "$@" > "$out" || { echo "an answer without bindings"; return 1; }
}
# store_endpoint <n>: the node's store query URL, from the devnet's own resolver; "" for a store that only
# the daemon can read (embedded), or one that is not this checkout's local devnet.
store_endpoint() { node "$ENDPOINT_RESOLVER" "$DEVNET_DIR" "http://127.0.0.1:$(node_port "$1")" 2>/dev/null || true; }

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
# read_graph_check <n> <out>: the full check (the default), both directions, as JSON in <out>. Its exit code
# says only whether a read graph mismatched or failed; check_verdict reads the rest.
read_graph_check() { dkg_cli "$1" store read-graphs check --json > "$2" 2>> "$RESULTS/cli-errors.log"; }
# check_verdict <out> <rows> <expected>: "clean" when every read graph that status listed just before (<rows>),
# and every read graph the node must keep (<expected>), was checked and found consistent; "bad" when one mismatched,
# failed, or the answer cannot be read; "incomplete" when one was skipped (not ready), interrupted, or not reported.
check_verdict() {
  node -e '
    const fs = require("fs");
    let results;
    try { results = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).results; } catch { results = undefined; }
    if (!Array.isArray(results)) { console.log("bad"); process.exit(0); }
    const expected = [
      ...fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((line) => line.split(" ")[2]),
      ...fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean),
    ];
    const reported = new Set(results.map((r) => r.readGraph));
    if (results.some((r) => !["consistent", "skipped", "interrupted"].includes(r.outcome))) console.log("bad");
    else if (results.some((r) => r.outcome !== "consistent") || expected.some((graph) => !reported.has(graph))) console.log("incomplete");
    else console.log("clean");
  ' "$1" "$2" "$3"
}
# read_graph_rebuild <n> [context graph]: mark the node's read graphs dirty, or those of one context graph;
# the builder rebuilds them at its next pass (rebuilding, then ready).
read_graph_rebuild() {
  if [ -n "${2:-}" ]; then dkg_cli "$1" store read-graphs rebuild --context-graph "$2" --json >> "$RESULTS/cli.log" 2>&1
  else dkg_cli "$1" store read-graphs rebuild --json >> "$RESULTS/cli.log" 2>&1; fi
}
# drop_unkept <n>: drop the read graphs node <n>'s own setting does not keep, by the build's own rules, one context
# graph and layer at a time; with no setting, or one that keeps nothing, that is every read graph.
drop_unkept() {
  local setting pairs cg layer failed=0
  setting="$(read_graphs_setting "$1")"
  read_graph_rows "$1" > "$RESULTS/rows/cleanup.node$1" || return 1
  pairs="$(SETTING_JSON="${setting:-\"off\"}" CORE_MODULE="$CORE_MODULE" STORAGE_MODULE="$STORAGE_MODULE" \
    QUERY_CONFIG_MODULE="$QUERY_CONFIG_MODULE" ROWS="$RESULTS/rows/cleanup.node$1" node --input-type=module -e '
    const fs = await import("node:fs");
    const core = await import(process.env.CORE_MODULE);
    const { readGraphModeOf } = await import(process.env.STORAGE_MODULE);
    const { resolveQueryConfig } = await import(process.env.QUERY_CONFIG_MODULE);
    const modes = resolveQueryConfig({ readGraphs: JSON.parse(process.env.SETTING_JSON) }).readGraphs;
    const pairs = new Set();
    for (const line of fs.readFileSync(process.env.ROWS, "utf8").split("\n").filter(Boolean)) {
      const key = core.parseReadGraphIri(line.split(" ")[2]);
      if (key && readGraphModeOf(modes, key) === "off") pairs.add(`${key.scope.contextGraphId} ${key.layer.toLowerCase()}`);
    }
    for (const pair of pairs) console.log(pair);
  ')" || return 1
  while read -r cg layer; do
    [ -n "$cg" ] || continue
    dkg_cli "$1" store read-graphs drop --context-graph "$cg" --layer "$layer" --yes --json >> "$RESULTS/cli.log" 2>&1 || failed=1
  done <<EOF_PAIRS
$pairs
EOF_PAIRS
  return "$failed"
}

dkg_cli "${NODES%% *}" store read-graphs --help > /dev/null 2>&1 \
  || early_exit "this build has no \`dkg store read-graphs\` commands"
# The build under test, as the first node reports it: "<version> <commit>".
UNDER_TEST="$(node_commit "${NODES%% *}")"

# all_ready <rows file>: at least one read graph, and every one ready.
all_ready() { [ -s "$1" ] && ! grep -qv '^ready ' "$1"; }
# settled <n> <rows file>: every read graph status lists is ready, and every read graph the node must keep
# (expected_read_graphs, written next to the rows) is among them and ready.
settled() {
  local expected="$2.expected" graph
  if [ -s "$2" ] && grep -qv '^ready ' "$2"; then return 1; fi
  # The expected set takes a listing per context graph, and the sub-graph listing counts triples, so each wait works it
  # out once, after status first lists everything ready (wait_all_ready clears it). A failed attempt keeps its reason.
  if [ ! -e "$expected.ok" ]; then
    expected_read_graphs "$1" > "$expected" 2> "$expected.err" || return 1
    : > "$expected.ok"
  fi
  while read -r graph; do
    [ -n "$graph" ] || continue
    awk -v g="$graph" '$3 == g && $1 == "ready" { found = 1 } END { exit !found }' "$2" || return 1
  done < "$expected"
  return 0
}
# unsettled <rows file>: what keeps a node from settling, as ": <graph> (<state or missing>), ..." (at most three).
unsettled() {
  { [ -s "$1.expected.err" ] && [ ! -e "$1.expected.ok" ] && echo "the read graphs it must keep could not be worked out ($(head -1 "$1.expected.err"))"
    awk '$1 != "ready" { print "<" $3 "> (" $1 ")" }' "$1" 2>/dev/null
    while read -r graph; do
      [ -n "$graph" ] && ! awk -v g="$graph" '$3 == g { found = 1 } END { exit !found }' "$1" 2>/dev/null && echo "<$graph> (missing)"
    done < "$1.expected"; } 2>/dev/null | head -3 | paste -sd ',' - | sed 's/^./: &/; s/,/, /g'
}
# wait_all_ready <label> <timeout> [nodes]: until every node has settled.
# Writes rows/<label>.node<N>, and to <label>.seconds a line per node:
# "node<N> <seconds since the wait began> <epoch seconds>" (polled every 5 s).
wait_all_ready() {
  local label="$1" timeout="$2" nodes="${3:-$NODES}" started deadline pending n rows
  started="$(now)"; deadline=$((started + timeout)); pending="$nodes"
  : > "$RESULTS/rows/$label.seconds"
  for n in $nodes; do rm -f "$RESULTS/rows/$label.node$n.expected" "$RESULTS/rows/$label.node$n.expected.ok" "$RESULTS/rows/$label.node$n.expected.err"; done
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
      for n in $pending; do echo "node$n not ready after ${timeout} s$(unsettled "$RESULTS/rows/$label.node$n")" >> "$RESULTS/rows/$label.seconds"; done
      return 1
    fi
    sleep 5
  done
  return 0
}
# full_checks <label> [nodes]: the full check on every node. A node whose check skipped, was
# interrupted, or left out a read graph status listed is checked again, up to three times, once its
# read graphs are ready.
# Returns 0 when every node is clean, 1 when one is bad, 2 when one stays incomplete;
# checks/<label>.failed names the nodes.
full_checks() {
  local label="$1" nodes="${2:-$NODES}" n attempt verdict bad="" incomplete=""
  for n in $nodes; do
    for attempt in 1 2 3; do
      # The read graphs the check must report: those status lists right before it, and those the node must keep.
      if read_graph_rows "$n" > "$RESULTS/checks/$label.node$n.rows" \
        && expected_read_graphs "$n" > "$RESULTS/checks/$label.node$n.expected"; then
        read_graph_check "$n" "$RESULTS/checks/$label.node$n.json"
        verdict="$(check_verdict "$RESULTS/checks/$label.node$n.json" "$RESULTS/checks/$label.node$n.rows" "$RESULTS/checks/$label.node$n.expected")"
      else
        verdict=incomplete
      fi
      [ "$verdict" = incomplete ] || break
      sleep 15
      wait_all_ready "$label-recheck" "$READY_TIMEOUT" "$n" || break
    done
    case "$verdict" in
      clean) ;;
      incomplete) incomplete="$incomplete node$n" ;;
      *) bad="$bad node$n" ;;
    esac
  done
  if [ -n "$bad" ]; then echo "$bad (bad)$incomplete" > "$RESULTS/checks/$label.failed"; return 1; fi
  if [ -n "$incomplete" ]; then echo "$incomplete (a read graph skipped, interrupted, or left out of the check)" > "$RESULTS/checks/$label.failed"; return 2; fi
  return 0
}
# generation_of <rows file> <read graph>
generation_of() { awk -v g="$2" '$3 == g { print $2 }' "$1"; }

# ── cleanup ────────────────────────────────────────────────────────────────
# Every node's config.json as it was before any phase ran; cleanup puts back each node the run changed.
for n in $NODES; do cp "$DEVNET_DIR/node$n/config.json" "$RESULTS/config/node$n.json" || early_exit "cannot save node$n's config.json"; done
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM
  local n changed w
  for w in $(cat "$RESULTS/gate/watchers" 2>/dev/null); do kill "$w" 2>/dev/null; done
  # A kill drill interrupted mid-run leaves its writer: stop it and its requests before any node is restored.
  w="$(cat "$RESULTS/drill-kill.writer" 2>/dev/null)"
  [ -n "$w" ] && stop_writer "$w"
  changed="$(printf '%s\n' $CHANGED | sort -nu | tr '\n' ' ')"
  if [ -n "${changed// /}" ] && [ "$KEEP" != 1 ]; then
    say "putting back the config.json of nodes ${changed% }, restarting them, and dropping read graphs their settings do not keep"
    for n in $changed; do cp "$RESULTS/config/node$n.json" "$DEVNET_DIR/node$n/config.json"; done
    for n in $changed; do
      if ! restart_node "$n"; then note "cleanup: node$n did not come back after the restart"; status=1; continue; fi
      drop_unkept "$n" || note "cleanup: dropping the read graphs node$n's setting does not keep failed (see cli.log)"
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
  local started n count total=0 missing=""
  started="$(now)"
  "$SEED_CMD" > "$RESULTS/seed.log" 2>&1 || { record seed FAIL "$(( $(now) - started ))" "$(basename "$SEED_CMD") failed (seed.log)"; return; }
  for n in $NODES; do seed_working_memory "$n" || missing="$missing node$n"; done
  for n in $NODES; do count="$(context_graph_count "$n")" && total=$((total + count)); done
  if [ "$total" -eq 0 ]; then
    record seed INCONCLUSIVE "$(( $(now) - started ))" "no node subscribes to a context graph that can have read graphs: the backfill would build nothing"
  elif [ -n "$missing" ]; then
    record seed INCONCLUSIVE "$(( $(now) - started ))" "no working-memory draft could be written on$missing, so the backfill of working memory is not checked there (seed-wm.log)"
  else
    record seed PASS "$(( $(now) - started ))" "$total subscriptions to context graphs that can have read graphs, across the nodes; a working-memory draft on each node"
  fi
}
# seed_working_memory <n>: node <n>'s own agent writes one working-memory draft into a context graph the node creates
# for it, with read graphs still off. rows/seed-wm.node<n> then holds "<context graph> <agent address>", and the
# backfill must build that agent's working-memory read graph from the draft (expected_read_graphs).
seed_working_memory() {
  local n="$1" agent cg body resp
  agent="$(field "$(body_of "$(api "$n" GET /api/agent/identity)")" agentAddress)"
  [ -n "$agent" ] || { echo "node$n: no agent address" >> "$RESULTS/seed-wm.log"; return 1; }
  cg="read-graphs-seed-$(echo "$RUN_ID" | tr 'A-Z' 'a-z')-n$n"
  # Bodies go into variables first (bash 3.2 brace expansion, see the kill drill).
  body="{\"id\":\"$cg\",\"name\":\"Read-graph seed\"}"
  resp="$(api "$n" POST /api/context-graph/create "$body")"
  case "$(code_of "$resp")" in 200|201|409) ;; *) echo "node$n: context graph $cg: HTTP $(code_of "$resp")" >> "$RESULTS/seed-wm.log"; return 1 ;; esac
  body="{\"contextGraphId\":\"$cg\",\"name\":\"seed-1\"}"
  api "$n" POST /api/knowledge-assets "$body" > /dev/null
  body="{\"contextGraphId\":\"$cg\",\"quads\":[{\"subject\":\"urn:read-graphs-seed:$n\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"seed $n\\\"\"}]}"
  resp="$(api "$n" POST /api/knowledge-assets/seed-1/wm/write "$body")"
  case "$(code_of "$resp")" in 2??) ;; *) echo "node$n: working-memory write: HTTP $(code_of "$resp")" >> "$RESULTS/seed-wm.log"; return 1 ;; esac
  echo "$cg $agent" > "$RESULTS/rows/seed-wm.node$n"
}

phase_setup() {
  local started n
  started="$(now)"
  # The backfill must build from the asset data alone: a read graph already ready would pass without being built.
  for n in $NODES; do
    if ! read_graph_rows "$n" > "$RESULTS/rows/setup.before.node$n"; then
      record setup INCONCLUSIVE "$(( $(now) - started ))" "node$n's status could not be read before the setup"; STOPPED=1; return
    fi
    if grep -q '^ready ' "$RESULTS/rows/setup.before.node$n"; then
      record setup INCONCLUSIVE "$(( $(now) - started ))" "node$n already holds ready read graphs, so the backfill would not be fresh: drop them first (dkg store read-graphs drop --yes) or start from a devnet without read graphs"
      STOPPED=1; return
    fi
  done
  : > "$RESULTS/measure/size-before.txt"
  for n in $NODES; do
    du -sk "$DEVNET_DIR/node$n" | awk -v n="$n" '{ print "node" n " " $1 }' >> "$RESULTS/measure/size-before.txt"
  done
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
  full_checks backfill
  case "$?" in
    0) if [ "$built" = 0 ]; then record backfill INCONCLUSIVE "$(( $(now) - started ))" "no node built a read graph"
       else record backfill PASS "$(( $(now) - started ))" "read graphs ready on $built nodes, full check clean"; fi ;;
    2) record backfill INCONCLUSIVE "$(( $(now) - started ))" "full check incomplete on:$(cat "$RESULTS/checks/backfill.failed")" ;;
    *) record backfill FAIL "$(( $(now) - started ))" "full check not clean on:$(cat "$RESULTS/checks/backfill.failed")" ;;
  esac
}

phase_measure() {
  local started n endpoint ok=1
  started="$(now)"
  for n in $NODES; do
    du -sk "$DEVNET_DIR/node$n" | awk -v n="$n" '{ print "node" n " " $1 }' >> "$RESULTS/measure/size-after.txt"
    endpoint="$(store_endpoint "$n")"
    if [ -z "$endpoint" ]; then note "measure: node$n's store cannot be read from outside the daemon; only its states are recorded"; continue; fi
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

# gate_verdict <exit code>: PASS, INCONCLUSIVE or FAIL for the gate. The comprehensive run writes REPORT.json
# into RESULTS_DIR, and only its completeSuccess, written by this run's gate command and with that command
# exiting 0, is a pass: a filtered run exits 0 without being one. A gate command that writes no report is judged
# by its exit code (0 PASS, 3 INCONCLUSIVE, other FAIL).
gate_verdict() {
  local report="$RESULTS/gate/REPORT.json"
  if [ -f "$report" ]; then
    node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      // A suite that failed is a failure, also when the run stopped early or left suites missing (an incomplete run
      // reports its outcome as INCONCLUSIVE, with the failure only in its totals).
      const failed = Number(r.totals?.fail ?? 0);
      if (r.outcome === "FAIL" || r.selectionOutcome === "FAIL" || (Number.isFinite(failed) && failed > 0)) console.log("FAIL");
      else if (process.argv[2] === "0" && r.phase === "complete" && r.completeSuccess === true) console.log("PASS");
      else console.log("INCONCLUSIVE");
    ' "$report" "$1" 2>/dev/null || echo INCONCLUSIVE
  elif [ "$GATE_CMD" = "$REPO_ROOT/scripts/devnet-comprehensive.sh" ]; then
    echo INCONCLUSIVE
  else
    case "$1" in 0) echo PASS ;; "$SKIP_EXIT") echo INCONCLUSIVE ;; *) echo FAIL ;; esac
  fi
}

# watch_mismatches <n> <out> <lost> <since> <start>: in the background, append to <out> every read-graph check mismatch
# line that node <n> logs after <start> ("<size> <identity>" of its daemon.log, from log_position, taken before the gate
# starts, so a line written before this process opens the file is not missed). The daemon rotates daemon.log by renaming it to daemon.log.1: the watcher keeps each
# file open, reads it once more when it sees the rename, and goes on reading it until it has stayed unchanged for four
# polls, so a line written just before (or as) the file was renamed is read. When the daemon cannot rename, it trims
# the live file in place, and lines written since the last read may be gone: that is noted in <lost>, and the trimmed
# file is read again from its start (lines stamped before <since>, the log's local "YYYY-MM-DD HH:MM:SS", skipped).
# Prints the PID.
watch_mismatches() {
  LOG="$DEVNET_DIR/node$1/daemon.log" OUT="$2" LOST="$3" SINCE="$4" START="$5" node -e '
    const fs = require("fs");
    const { LOG, OUT, LOST, SINCE, START } = process.env;
    const stamped = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/;
    const keep = (line) => line.includes("[read-graph-check] Read graph <") && !(stamped.test(line) && line.slice(0, 19) < SINCE);
    const emit = (lines) => { const hits = lines.filter(keep); if (hits.length > 0) fs.appendFileSync(OUT, hits.join("\n") + "\n"); };
    const identity = (stat) => `${stat.dev}:${stat.ino}`;
    // A file being read: its descriptor, its identity, how far it was read, the unfinished last line, quiet polls.
    const openFile = (fromEnd) => {
      let fd;
      try { fd = fs.openSync(LOG, "r"); } catch { return null; }
      const stat = fs.fstatSync(fd);
      return { fd, id: identity(stat), offset: fromEnd ? stat.size : 0, rest: "", quiet: 0 };
    };
    // Read what was appended; whether anything was. A file shorter than what was read was trimmed in place.
    const drain = (file) => {
      const size = fs.fstatSync(file.fd).size;
      if (size < file.offset) {
        fs.appendFileSync(LOST, `${LOG} was trimmed in place at ${new Date().toISOString()}\n`); file.offset = 0; file.rest = "";
      }
      if (size === file.offset) return false;
      const buffer = Buffer.alloc(size - file.offset);
      fs.readSync(file.fd, buffer, 0, buffer.length, file.offset); file.offset = size;
      const lines = (file.rest + buffer.toString("utf8")).split("\n"); file.rest = lines.pop(); emit(lines);
      return true;
    };
    // Start where the log stood when the gate was about to start (START, "<size> <identity>"): what was written since,
    // also before this process opened the file, is read. If the file was renamed in between, its rest is read too.
    const [startSize, startId] = (START ?? "0 none").split(" ");
    let live = openFile(false);
    let rotated = [];
    if (live && live.id === startId) live.offset = Math.min(Number(startSize) || 0, fs.fstatSync(live.fd).size);
    else if (startId !== "none") {
      try {
        const fd = fs.openSync(`${LOG}.1`, "r"), stat = fs.fstatSync(fd);
        if (identity(stat) === startId) rotated.push({ fd, id: startId, offset: Math.min(Number(startSize) || 0, stat.size), rest: "", quiet: 0 });
        else fs.closeSync(fd);
      } catch { /* no rotated file */ }
    }
    const tick = () => {
      rotated = rotated.filter((file) => {
        file.quiet = drain(file) ? 0 : file.quiet + 1;
        if (file.quiet < 4) return true;
        emit([file.rest]); fs.closeSync(file.fd); return false;
      });
      if (live) drain(live);
      let stat;
      try { stat = fs.statSync(LOG); } catch { return; }
      if (!live) { live = openFile(false); if (live) drain(live); return; }
      if (identity(stat) !== live.id) {
        drain(live);
        rotated.push(live);
        live = openFile(false); if (live) drain(live);
      }
    };
    setInterval(tick, 500);
    process.on("SIGTERM", () => {
      try { tick(); for (const file of [...rotated, live]) if (file) { drain(file); emit([file.rest]); } } finally { process.exit(0); }
    });
  ' > /dev/null 2>&1 &
  echo $!
}
# gate_mismatches: the mismatches the nodes logged during the gate, outside the context graphs a suite writes into the
# store directly, as "<count> on node<N> (e.g. <read graph>)", one node per line; nothing when there were none.
gate_mismatches() {
  local n file cg kept count
  for n in $NODES; do
    file="$RESULTS/gate/mismatches.node$n"; [ -s "$file" ] || continue
    kept="$(cat "$file")"
    for cg in $DIRECT_WRITE_CGS; do kept="$(printf '%s\n' "$kept" | grep -vF "did:dkg:context-graph:$cg/_~read/")"; done
    count="$(printf '%s\n' "$kept" | grep -c 'Read graph <')"
    [ "$count" -gt 0 ] || continue
    echo "$count on node$n (e.g. $(printf '%s\n' "$kept" | grep -m1 -o 'Read graph <[^>]*>' | sed 's/^Read graph //'))"
  done
}

# log_position <n>: "<size> <device:inode>" of node <n>'s daemon.log now, or "0 none" when there is none.
log_position() {
  node -e 'try { const s = require("fs").statSync(process.argv[1]); console.log(`${s.size} ${s.dev}:${s.ino}`); } catch { console.log("0 none"); }' \
    "$DEVNET_DIR/node$1/daemon.log"
}

phase_gate() {
  local n w watchers="" since
  mkdir -p "$RESULTS/gate"
  # A check that finds a mismatch marks the read graph dirty and the builder rebuilds it, so the full check at the end
  # can be clean although write maintenance failed during the workload. Every mismatch a check logs is kept.
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  for n in $NODES; do
    : > "$RESULTS/gate/mismatches.node$n"; : > "$RESULTS/gate/lost.node$n"
    w="$(watch_mismatches "$n" "$RESULTS/gate/mismatches.node$n" "$RESULTS/gate/lost.node$n" "$since" "$(log_position "$n")")"
    echo "$w" > "$RESULTS/gate/watcher.node$n"; watchers="$watchers $w"
  done
  echo "$watchers" > "$RESULTS/gate/watchers"
  gate_run
  for w in $watchers; do kill "$w" 2>/dev/null; done
  rm -f "$RESULTS/gate/watchers"
}

gate_run() {
  local started rc verdict checked n cg lost="" rebuilt="" mismatched unwatched=""
  started="$(now)"
  rm -f "$RESULTS/gate/REPORT.json"
  for n in $NODES; do read_graphs_setting "$n" > "$RESULTS/gate/setting.node$n"; done
  RESULTS_DIR="$RESULTS/gate" "$GATE_CMD" > "$RESULTS/gate.log" 2>&1; rc=$?
  verdict="$(gate_verdict "$rc")"
  # The gate must leave every node's setting as it found it.
  for n in $NODES; do
    [ "$(read_graphs_setting "$n")" = "$(cat "$RESULTS/gate/setting.node$n")" ] || lost="$lost node$n"
  done
  if [ -n "$lost" ]; then
    record gate FAIL "$(( $(now) - started ))" "the read-graph setting changed on:$lost (a suite rewrote the node's config)"
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
  full_checks after-gate; checked=$?
  sleep 1
  mismatched="$(gate_mismatches | paste -sd ';' - | sed 's/;/; /g')"
  # A watcher that stopped, or a log trimmed in place, may have lost a mismatch line: the gate cannot pass then.
  for n in $NODES; do
    kill -0 "$(cat "$RESULTS/gate/watcher.node$n" 2>/dev/null)" 2>/dev/null || unwatched="$unwatched node$n (its log watcher stopped)"
    [ -s "$RESULTS/gate/lost.node$n" ] && unwatched="$unwatched node$n (its log was trimmed in place)"
  done
  if [ "$checked" = 1 ]; then
    record gate FAIL "$(( $(now) - started ))" "full check not clean after the gate on:$(cat "$RESULTS/checks/after-gate.failed")"
  elif [ -n "$mismatched" ]; then
    record gate FAIL "$(( $(now) - started ))" "a check found read graphs that did not match their member graphs during the workload, though they were rebuilt by the end: $mismatched (gate/mismatches.node<N>)"
  elif [ "$verdict" = FAIL ]; then
    record gate FAIL "$(( $(now) - started ))" "the gate failed (exit $rc; gate/REPORT.md, gate.log)"
  elif [ -n "$unwatched" ]; then
    record gate INCONCLUSIVE "$(( $(now) - started ))" "a mismatch logged during the workload may have been missed on:$unwatched"
  elif [ "$checked" = 2 ]; then
    record gate INCONCLUSIVE "$(( $(now) - started ))" "full check incomplete after the gate on:$(cat "$RESULTS/checks/after-gate.failed")"
  elif [ "$verdict" = PASS ]; then
    record gate PASS "$(( $(now) - started ))" "the gate passed in full with read graphs on; full check clean"
  else
    record gate INCONCLUSIVE "$(( $(now) - started ))" "the gate was not a complete pass, e.g. a filtered or unfinished run (exit $rc; gate/REPORT.json); full check clean"
  fi
}

# drill_end <drill> <node> <started> <detail>: ready again, and a clean full check.
drill_end() {
  if ! wait_all_ready "$1" "$READY_TIMEOUT" "$2"; then record "$1" FAIL "$(( $(now) - $3 ))" "node$2's read graphs not ready afterwards"; return; fi
  full_checks "$1" "$2"
  case "$?" in
    0) record "$1" PASS "$(( $(now) - $3 ))" "$4" ;;
    2) record "$1" INCONCLUSIVE "$(( $(now) - $3 ))" "node$2's full check stayed incomplete afterwards" ;;
    *) record "$1" FAIL "$(( $(now) - $3 ))" "node$2's full check not clean afterwards" ;;
  esac
}

drill_restart_during_rebuild() {
  local n="$RESTART_NODE" started before caught="" i state graph gen_before gen_after renewed=0 finished="" gone=""
  started="$(now)"; before="$RESULTS/rows/restart.before.node$n"
  read_graph_rows "$n" > "$before" && all_ready "$before" || { record drill-restart INCONCLUSIVE 0 "node$n had no ready read graph to rebuild"; return; }
  read_graph_rebuild "$n" || { record drill-restart FAIL "$(( $(now) - started ))" "rebuild refused on node$n (cli.log)"; return; }
  # `rebuild` marks the read graphs dirty; the builder's next pass rebuilds them. Restart while a shared-layer one is
  # being rebuilt. Working-memory read graphs are left out: every start renews them, so they prove nothing here.
  for i in $(seq 1 150); do
    read_graph_rows "$n" > "$RESULTS/rows/restart.caught.node$n" 2>/dev/null || true
    if grep -E '^(rebuilding|building) ' "$RESULTS/rows/restart.caught.node$n" | grep -qv '/_working_memory/'; then caught=1; break; fi
    sleep 0.2
  done
  [ -n "$caught" ] || { record drill-restart INCONCLUSIVE "$(( $(now) - started ))" "no shared-layer read graph on node$n was seen being rebuilt, so no restart could land during one"; return; }
  restart_node "$n" || { record drill-restart FAIL "$(( $(now) - started ))" "node$n did not come back"; return; }
  if ! wait_all_ready drill-restart "$READY_TIMEOUT" "$n"; then record drill-restart FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the restart"; return; fi
  # A read graph the restart caught being built gets a new generation at start. One whose rebuild ended in the
  # moment before the daemon stopped keeps its generation; that is fine, but proves nothing. Neither does a read
  # graph caught `dirty`, still queued: its normal rebuild after the start renews it too.
  while read -r state gen_before graph; do
    [ "$state" = ready ] && continue
    case "$graph" in */_working_memory/*) continue ;; esac
    gen_after="$(generation_of "$RESULTS/rows/drill-restart.node$n" "$graph")"
    if [ -z "$gen_after" ]; then gone="$gone <$graph>"; continue; fi
    case "$state" in building|rebuilding) ;; *) continue ;; esac
    if [ "$gen_after" != "$gen_before" ]; then renewed=$((renewed + 1)); else finished="$finished <$graph>"; fi
  done < "$RESULTS/rows/restart.caught.node$n"
  [ -z "$gone" ] || { record drill-restart FAIL "$(( $(now) - started ))" "read graphs gone after the restart:$gone"; return; }
  [ "$renewed" -gt 0 ] || { record drill-restart INCONCLUSIVE "$(( $(now) - started ))" "every rebuild seen on node$n ended before the restart stopped the daemon (a read graph still queued dirty proves nothing)"; return; }
  [ -z "$finished" ] || note "drill-restart: rebuilt before the daemon stopped, so they kept their generation:$finished"
  drill_end drill-restart "$n" "$started" "$renewed shared-layer read graphs the restart caught unfinished got a new generation and were rebuilt"
}

# kill_tree <pid>: stop a process and every process it started, by PID. The tree is listed before anything is stopped,
# as a stopped parent's children are handed to another parent.
kill_tree() {
  local all="$1" next="$1" p
  while [ -n "$next" ]; do
    next="$(ps -axo pid=,ppid= | awk -v list=" $next " 'index(list, " " $2 " ") { printf "%s ", $1 }')"
    all="$all $next"
  done
  for p in $all; do kill "$p" 2>/dev/null; done
}
# stop_writer <pid>: stop the kill drill's writer and the requests it has in flight, and reap it.
stop_writer() { kill_tree "$1"; wait "$1" 2>/dev/null; rm -f "$RESULTS/drill-kill.writer"; }
# acked_count <file>: lines in a file of acknowledged writes.
acked_count() { wc -l < "$1" | tr -d ' '; }
# drill_writes_missing <acked> <rows>: the drill writes listed in <acked> that the readback <rows> (query_rows of
# ?s ?name) lacks, or holds with another value, comma-separated; nothing when every one is there as written.
drill_writes_missing() {
  node -e '
    const fs = require("fs");
    const values = new Map();
    for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)) {
      const [s, name] = JSON.parse(line);
      (values.get(s) ?? values.set(s, []).get(s)).push(name);
    }
    const problems = [];
    for (const i of fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
      const found = values.get(`urn:read-graphs-drill:${i}`);
      if (!found) problems.push(`${i} missing`);
      else if (!found.includes(`drill ${i}`)) problems.push(`${i} holds ${JSON.stringify(found[0])}, not "drill ${i}"`);
    }
    process.stdout.write(problems.join(", "));' "$1" "$2"
}
# pid_alive <pid>: the process exists and is not a zombie.
pid_alive() { local s; s="$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' ')"; [ -n "$s" ] && [ "${s#Z}" = "$s" ]; }
# daemon_worker_pid <n>: the PID node <n>'s daemon.pid names, when that process is a live daemon worker; else nothing.
daemon_worker_pid() {
  local pid
  pid="$(tr -d '[:space:]' < "$DEVNET_DIR/node$1/daemon.pid" 2>/dev/null)"
  [ -n "$pid" ] && pid_alive "$pid" || return 0
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in *daemon-worker*|*daemon-foreground-worker*) echo "$pid" ;; esac
}

drill_kill_during_write() {
  local n="$KILL_NODE" started cg pid new_pid writer acked i resp missing body agent wm_graph inflight answers inflight_write overlap
  local attempt last_write kill_line why readback
  started="$(now)"; cg="read-graphs-drill-$(echo "$RUN_ID" | tr 'A-Z' 'a-z')"
  readback="SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }"
  acked="$RESULTS/drill-kill.acked"; : > "$acked"
  # The writes go to the node's own agent; the read graph they maintain is that agent's working-memory read graph.
  agent="$(field "$(body_of "$(api "$n" GET /api/agent/identity)")" agentAddress)"
  [ -n "$agent" ] || { record drill-kill INCONCLUSIVE 0 "node$n's agent address could not be read"; return; }
  wm_graph="$(wm_read_graph "$n" "$cg" "$agent")" \
    || { record drill-kill INCONCLUSIVE 0 "the working-memory read graph for node$n's agent could not be named"; return; }
  [ -n "$wm_graph" ] || { record drill-kill INCONCLUSIVE 0 "node$n's setting keeps no working-memory read graph, so its writes maintain none"; return; }
  # Bodies go into variables first: bash 3.2 brace-expands a JSON body with a comma written inline in
  # a command substitution that is itself an argument, and the node gets half of it.
  body="{\"id\":\"$cg\",\"name\":\"Read-graph drill\"}"
  resp="$(api "$n" POST /api/context-graph/create "$body")"
  case "$(code_of "$resp")" in
    200|201|409) ;;
    *) record drill-kill INCONCLUSIVE 0 "could not create context graph $cg on node$n (HTTP $(code_of "$resp"))"; return ;;
  esac
  # The read graph the crash will interrupt exists first: one write, and its working-memory read graph ready.
  api "$n" POST /api/knowledge-assets "{\"contextGraphId\":\"$cg\",\"name\":\"drill-0\"}" > /dev/null 2>&1 || true
  body="{\"contextGraphId\":\"$cg\",\"quads\":[{\"subject\":\"urn:read-graphs-drill:0\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"drill 0\\\"\"}]}"
  resp="$(api "$n" POST /api/knowledge-assets/drill-0/wm/write "$body")"
  case "$(code_of "$resp")" in 2??) ;; *) record drill-kill INCONCLUSIVE 0 "the first working-memory write on node$n failed (HTTP $(code_of "$resp"))"; return ;; esac
  wait_read_graph_ready "$n" "$wm_graph" "$READY_TIMEOUT" "$RESULTS/rows/drill-kill.wm-before.node$n" \
    || { record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "the working-memory read graph <$wm_graph> was not ready before the kill"; return; }
  pid="$(daemon_worker_pid "$n")"
  [ -n "$pid" ] || { record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "node$n's daemon.pid does not name a running daemon worker"; return; }
  # The writer marks each working-memory write in flight in $inflight, logs every outcome in $answers in order, and
  # records each acknowledged (HTTP 2xx) write in $acked. It sends the write with curl itself, so the outcome says
  # what the daemon had: exit 52 or 56 with the whole body uploaded means the worker took the request and its
  # connection was dropped unanswered; exit 7 means the request never reached it; exit 0 means it was answered.
  # After a write that was not acknowledged it waits a moment, so a restarting node does not use up its writes.
  inflight="$RESULTS/drill-kill.inflight"; answers="$RESULTS/drill-kill.answers"; : > "$inflight"; : > "$answers"
  (
    export DKG_API_MAXTIME=15
    for i in $(seq 1 1000); do
      api "$n" POST /api/knowledge-assets "{\"contextGraphId\":\"$cg\",\"name\":\"drill-$i\"}" > /dev/null 2>&1 || true
      body="{\"contextGraphId\":\"$cg\",\"quads\":[{\"subject\":\"urn:read-graphs-drill:$i\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"drill $i\\\"\"}]}"
      echo "$i" > "$inflight"
      out="$(curl -sS --max-time 15 --connect-timeout 5 -o /dev/null -w '%{http_code} %{size_upload}' -X POST \
        -H "Authorization: Bearer $(node_token "$n")" -H 'Content-Type: application/json' --data "$body" \
        "http://127.0.0.1:$(node_port "$n")/api/knowledge-assets/drill-$i/wm/write" 2>/dev/null)"; rc=$?
      code="${out%% *}"
      echo "write $i rc=$rc code=${code:-000} sent=${out##* } of ${#body}" >> "$answers"
      : > "$inflight"
      case "$code" in 2??) echo "$i" >> "$acked" ;; *) sleep 0.5 ;; esac
    done
  ) &
  writer=$!
  echo "$writer" > "$RESULTS/drill-kill.writer"
  # The crash must land on a working-memory write the worker has begun to process: once three were acknowledged, kill
  # the daemon worker while one is in flight. A crash counts only with evidence from both sides of the request:
  # - the transport: its whole request was uploaded, and its connection was dropped unanswered;
  # - the write path: its data is there after the restart. No other worker can have written it, as its connection was
  #   dropped and curl does not send it again, so the killed worker had begun to store it.
  # A request that was uploaded but not yet processed leaves no data, so that crash does not count. The send and the
  # kill race, so up to five crashes are tried; each one is a full crash with its own recovery. Whether a crash fell
  # inside the read-graph update itself, rather than after it, cannot be seen from outside the daemon; a pause hook at
  # the store-write boundary is a follow-up, and a kill in the middle of an engine write is covered by the storage
  # tests (oxigraph-worker-respawn.test.ts).
  overlap=""; attempt=0; last_write=0
  while [ -z "$overlap" ] && [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    inflight_write=""
    for i in $(seq 1 600); do
      kill -0 "$writer" 2>/dev/null || break
      if [ "$(acked_count "$acked")" -ge 3 ]; then
        inflight_write="$(tr -d '[:space:]' < "$inflight" 2>/dev/null)"
        # A moment for the request to reach the worker, and still the same write in flight.
        if [ -n "$inflight_write" ] && [ "$inflight_write" -gt "$last_write" ]; then
          sleep 0.05
          [ "$(tr -d '[:space:]' < "$inflight" 2>/dev/null)" = "$inflight_write" ] && break
        fi
        inflight_write=""
      fi
      sleep 0.1
    done
    if [ -z "$inflight_write" ]; then
      stop_writer "$writer"
      record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "no working-memory write was seen in flight after three were acknowledged ($(acked_count "$acked") acknowledged; crash $attempt), so no kill landed during one"
      return
    fi
    last_write="$inflight_write"
    # The crash must happen: SIGKILL delivered to the daemon worker, that worker gone, and a new worker in its place
    # before anything is checked. A daemon that answered throughout would prove nothing.
    pid="$(daemon_worker_pid "$n")"
    # The evidence must come after this line, taken before the kill: an outcome the kill caused can be logged at once.
    # The writes acknowledged so far must all be there after this crash.
    kill_line="$(wc -l < "$answers" | tr -d ' ')"; cp "$acked" "$RESULTS/drill-kill.acked-crash$attempt"
    if [ -z "$pid" ] || ! kill -9 "$pid" 2>/dev/null; then
      stop_writer "$writer"
      record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "SIGKILL could not be sent to node$n's daemon worker (PID ${pid:-none}), so no crash happened"; return
    fi
    echo "killed during write $inflight_write" >> "$answers"
    # Evidence that the worker died holding that write: its whole request was uploaded, and its connection was dropped
    # unanswered (curl exit 52 or 56), logged after the kill. A write that never connected (it was not sent yet), or
    # that was answered, did not overlap the crash.
    for i in $(seq 1 100); do awk -v w="$inflight_write" -v k="$kill_line" 'NR > k && $1 == "write" && $2 == w { found = 1 } END { exit !found }' "$answers" && break; sleep 0.2; done
    overlap="$(awk -v w="$inflight_write" -v k="$kill_line" 'NR > k && $1 == "write" && $2 == w && !seen { seen = 1; outcome = $0 }
      END {
        if (!seen) exit
        split(outcome, f, " "); rc = f[3]; sent = f[5]; total = f[7]; sub("rc=", "", rc); sub("sent=", "", sent)
        if ((rc == 52 || rc == 56) && sent == total && total > 0) print "curl exit " rc ", " sent " of " total " bytes sent"
      }' "$answers")"
    [ -n "$overlap" ] || note "drill-kill: crash $attempt did not overlap write $inflight_write ($(awk -v w="$inflight_write" -v k="$kill_line" 'NR > k && $1 == "write" && $2 == w { $1 = $2 = ""; print; exit }' "$answers" | sed 's/^ *//'))"
    for i in $(seq 1 40); do pid_alive "$pid" || break; sleep 0.5; done
    if pid_alive "$pid"; then
      stop_writer "$writer"
      record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "node$n's daemon worker (PID $pid) was still running 20 s after SIGKILL"; return
    fi
    # The supervisor starts a new worker; restart the node if it does not.
    wait_up "$n" 120 || restart_node "$n" || { stop_writer "$writer"; record drill-kill FAIL "$(( $(now) - started ))" "node$n did not come back after the kill"; return; }
    new_pid="$(daemon_worker_pid "$n")"
    if [ -z "$new_pid" ] || [ "$new_pid" = "$pid" ]; then
      stop_writer "$writer"
      record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "node$n answers after the kill, but its daemon.pid names no new daemon worker (PID $pid was killed)"; return
    fi
    # After every crash, read through the new worker (for up to a minute while it warms up): each write acknowledged
    # before the crash must be there as written, and the write-path side of the evidence is the held write's data.
    for i in $(seq 1 30); do
      why="$(query_rows "$RESULTS/rows/drill-kill.crash$attempt" "$n" "$cg" working-memory "$readback" s name)" && break
      sleep 2
    done
    [ -z "$why" ] || { stop_writer "$writer"; record drill-kill FAIL "$(( $(now) - started ))" "node$n's working memory could not be read after crash $attempt ($why)"; return; }
    missing="$(drill_writes_missing "$RESULTS/drill-kill.acked-crash$attempt" "$RESULTS/rows/drill-kill.crash$attempt")"
    [ -z "$missing" ] || { stop_writer "$writer"; record drill-kill FAIL "$(( $(now) - started ))" "writes acknowledged before crash $attempt are not there as written after it: $missing"; return; }
    [ -n "$overlap" ] || continue
    if ! grep -Fxq "[\"urn:read-graphs-drill:$inflight_write\",\"drill $inflight_write\"]" "$RESULTS/rows/drill-kill.crash$attempt"; then
      note "drill-kill: crash $attempt dropped write $inflight_write unanswered ($overlap), but its data is not there after the restart, so nothing shows the worker had begun to store it"
      overlap=""
    fi
  done
  stop_writer "$writer"
  if [ -z "$overlap" ]; then
    record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "none of $attempt crashes landed on a working-memory write the worker had begun to store (drill-kill.answers, notes.md), so no kill is known to have interrupted a write"; return
  fi
  # Every write the node acknowledged, before the crashes and after them, must be there with the value it wrote.
  why="$(query_rows "$RESULTS/rows/drill-kill.after" "$n" "$cg" working-memory "$readback" s name)" \
    || { record drill-kill FAIL "$(( $(now) - started ))" "the acknowledged writes could not be read back after the kill ($why)"; return; }
  missing="$(drill_writes_missing "$acked" "$RESULTS/rows/drill-kill.after")"
  [ -z "$missing" ] || { record drill-kill FAIL "$(( $(now) - started ))" "acknowledged writes are not there as written after the kill: $missing"; return; }
  # The read graph those writes maintain must be there and ready; drill_end then checks it with the rest.
  wait_read_graph_ready "$n" "$wm_graph" "$READY_TIMEOUT" "$RESULTS/rows/drill-kill.wm.node$n" \
    || { record drill-kill FAIL "$(( $(now) - started ))" "the working-memory read graph <$wm_graph> was not listed ready after the kill"; return; }
  drill_end drill-kill "$n" "$started" "killed node$n's daemon worker while it held working-memory write $inflight_write: its whole request was uploaded and its connection dropped unanswered ($overlap), and its data was there after the restart, so the worker had begun to store it (crash $attempt of at most 5); a new worker took over; all $(acked_count "$acked") acknowledged writes were there after it with the values written, and their read graph was rebuilt and consistent"
}

# finalized_jobs <n>: the node's count of finalized publish jobs, or "" when it cannot be read.
finalized_jobs() {
  dkg_cli "$1" publisher stats 2>/dev/null | node -e '
    let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => {
      try { const value = JSON.parse(d).finalized; if (Number.isSafeInteger(value)) process.stdout.write(String(value)); } catch {}
    });'
}

# generations_compared <before rows> <after rows> <same|new>: the shared-layer read graphs of <before> whose generation
# in <after> is not as asked (`same`: the one it had; `new`: another one), as " <graph> (generation A, then B)". Working-
# memory read graphs are left out: every start renews them.
generations_compared() {
  local state gen graph gen_after
  while read -r state gen graph; do
    case "$graph" in */_working_memory/*) continue ;; esac
    gen_after="$(generation_of "$2" "$graph")"
    if [ "$3" = same ] && [ "$gen_after" = "$gen" ]; then continue; fi
    if [ "$3" = new ] && [ -n "$gen_after" ] && [ "$gen_after" != "$gen" ]; then continue; fi
    printf ' <%s> (generation %s, then %s)' "$graph" "$gen" "${gen_after:-missing}"
  done < "$1"
}

drill_cli_write_daemon_down() {
  local n="" candidate jobs started before after output rc cleared renewed kept count dir="$RESULTS/rows"
  started="$(now)"
  # A node with finalized publish jobs, so the offline write has something to change, and with read graphs; the drill
  # node first.
  for candidate in "$CLI_NODE" $NODES; do
    jobs="$(finalized_jobs "$candidate")"
    [ -n "$jobs" ] && [ "$jobs" -gt 0 ] || continue
    if read_graph_rows "$candidate" 2>/dev/null | grep -q .; then n="$candidate"; break; fi
  done
  [ -n "$n" ] || { record drill-cli INCONCLUSIVE 0 "no node has both a finalized publish job and a read graph"; return; }
  before="$(finalized_jobs "$n")"
  # Nothing maintains read graphs in a CLI process, so a store it opens to write with the daemon down marks every read
  # graph it finds dirty first. Each must then get a new generation at the next start and be rebuilt. A plain restart
  # comes first, as the control: it keeps every ready shared-layer read graph at its generation, so a new one after the
  # offline write comes from that write.
  wait_all_ready drill-cli-before "$READY_TIMEOUT" "$n" \
    || { record drill-cli INCONCLUSIVE "$(( $(now) - started ))" "node$n's read graphs were not ready before the drill"; return; }
  restart_node "$n" || { record drill-cli FAIL "$(( $(now) - started ))" "node$n did not come back from a plain restart"; return; }
  wait_all_ready drill-cli-control "$READY_TIMEOUT" "$n" \
    || { record drill-cli FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after a plain restart"; return; }
  renewed="$(generations_compared "$dir/drill-cli-before.node$n" "$dir/drill-cli-control.node$n" same)"
  [ -z "$renewed" ] || { record drill-cli INCONCLUSIVE "$(( $(now) - started ))" "a plain restart already renewed read graphs, so what the offline write marked cannot be told apart:$renewed"; return; }
  count="$(grep -vc '/_working_memory/' "$dir/drill-cli-control.node$n")"
  [ "$count" -gt 0 ] || { record drill-cli INCONCLUSIVE "$(( $(now) - started ))" "node$n has no shared-layer read graph"; return; }
  stop_node "$n" || { record drill-cli INCONCLUSIVE "$(( $(now) - started ))" "could not stop node$n"; return; }
  output="$(dkg_cli "$n" publisher clear finalized 2>&1)"; rc=$?
  printf '%s\n' "$output" > "$RESULTS/drill-cli.log"
  start_node "$n" || { record drill-cli FAIL "$(( $(now) - started ))" "node$n did not come back"; return; }
  [ "$rc" = 0 ] || { record drill-cli FAIL "$(( $(now) - started ))" "\`dkg publisher clear finalized\` exited $rc with the daemon down (drill-cli.log)"; return; }
  cleared="$(printf '%s\n' "$output" | sed -n 's/^Cleared \([0-9][0-9]*\) publisher job.*/\1/p' | head -1)"
  if [ -z "$cleared" ] || [ "$cleared" = 0 ]; then
    record drill-cli FAIL "$(( $(now) - started ))" "with $before finalized jobs, the offline clear changed nothing (drill-cli.log)"; return
  fi
  # What the CLI wrote with the daemon down must hold once the daemon is back.
  after="$(finalized_jobs "$n")"
  if [ -z "$after" ] || [ "$after" -gt $((before - cleared)) ]; then
    record drill-cli FAIL "$(( $(now) - started ))" "node$n lists ${after:-?} finalized jobs after the restart; $before before, $cleared cleared offline"; return
  fi
  if ! wait_all_ready drill-cli "$READY_TIMEOUT" "$n"; then record drill-cli FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the restart"; return; fi
  kept="$(generations_compared "$dir/drill-cli-control.node$n" "$dir/drill-cli.node$n" new)"
  [ -z "$kept" ] || { record drill-cli FAIL "$(( $(now) - started ))" "read graphs came through the offline write without a new generation, so nothing marked them dirty:$kept"; return; }
  drill_end drill-cli "$n" "$started" "with node$n's daemon down, \`dkg publisher clear finalized\` cleared $cleared of $before jobs, which stayed cleared; the $count shared-layer read graphs that a plain restart kept got a new generation and were rebuilt"
}

# partition_graphs <endpoint> <out>: every graph the store holds in a read-graph partition (read graphs and
# state graphs), one per line, read from the store itself; fails when the store cannot be read.
partition_graphs() {
  node "$REPO_ROOT/scripts/read-graph-store-report.mjs" --endpoint "$1" --partition-graphs 2>> "$RESULTS/drill-rollback.log" \
    | node -e 'let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => { for (const g of JSON.parse(d).graphs) console.log(g); });' > "$2"
}

# member_graphs <endpoint> <out>: every other graph of a context graph, with its triples, read from the store.
member_graphs() {
  node "$REPO_ROOT/scripts/read-graph-store-report.mjs" --endpoint "$1" --member-graphs 2>> "$RESULTS/drill-rollback.log" > "$2"
}
# members_lost <before> <after> <exact|kept>: prints the first difference and fails, or prints nothing. `exact`: the
# same graphs with the same triples; `kept`: every graph of <before> still there, holding every triple it held.
members_lost() {
  node -e '
    const fs = require("fs");
    const [before, after] = process.argv.slice(1, 3).map((file) => JSON.parse(fs.readFileSync(file, "utf8")).graphs);
    const exact = process.argv[3] === "exact";
    for (const [graph, triples] of Object.entries(before)) {
      if (!(graph in after)) { console.log(`<${graph}> is gone`); process.exit(1); }
      const now = new Set(after[graph]);
      const lost = triples.find((triple) => !now.has(triple));
      if (lost) { console.log(`<${graph}> lost ${lost}`); process.exit(1); }
      if (exact && after[graph].length !== triples.length) {
        const had = new Set(triples);
        console.log(`<${graph}> gained ${after[graph].find((triple) => !had.has(triple))}`); process.exit(1);
      }
    }
    if (exact) for (const graph of Object.keys(after)) if (!(graph in before)) { console.log(`<${graph}> appeared`); process.exit(1); }
  ' "$1" "$2" "$3"
}

# rollback_steps <n> <endpoint> <version>: the rollback drill's changes, with node <n> stopped, its store at
# <endpoint>, and <version> the earlier release.
# It prints one line of four fields, outcome, detail, dropped and version, separated by the ASCII unit separator
# (a field may be empty): an empty outcome means every step held. The caller restores the node whatever it prints.
# asset_probe_record <n> <probe>: known assets to read through the earlier release, with what the build under test
# answers for them now: node <n>'s seeded working-memory draft, which must hold the value written, and one triple
# pattern of a verifiable-memory asset. Each probe is a line of <probe> (what, context graph, view, query and variable,
# \037 between), and its answer is <probe>.<line number>. Fails when no probe could be recorded.
asset_probe_record() {
  local n="$1" probe="$2" k=0 cg agent graph sp sparql
  : > "$probe"
  if [ -s "$RESULTS/rows/seed-wm.node$n" ]; then
    read -r cg agent < "$RESULTS/rows/seed-wm.node$n"
    sparql="SELECT ?name WHERE { <urn:read-graphs-seed:$n> <http://schema.org/name> ?name }"
    if query_rows "$probe.1" "$n" "$cg" working-memory "$sparql" name > /dev/null && grep -Fxq "[\"seed $n\"]" "$probe.1"; then
      k=1; printf 'the seeded working-memory draft\037%s\037working-memory\037%s\037name\n' "$cg" "$sparql" >> "$probe"
    else
      note "drill-rollback: the build under test did not answer node$n's seeded working-memory draft with the value written, so the draft is not read through the earlier release"
    fi
  fi
  # A verifiable-memory triple of one of the node's context graphs, by subject and predicate (IRIs that a query can
  # name as they are), and every object the build under test answers for that pair.
  for graph in $(awk '{ print $3 }' "$RESULTS/rows/rollback.before.node$n" | grep '/_~read/cg/_verifiable_memory$' | head -5); do
    cg="${graph#did:dkg:context-graph:}"; cg="${cg%/_~read/cg/_verifiable_memory}"
    query_rows "$probe.sample" "$n" "$cg" verifiable-memory "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20" s p o > /dev/null || continue
    sp="$(node -e '
      const named = (v) => /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]+$/.test(v);
      const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const row = rows.find(([s, p]) => named(s) && named(p));
      if (row) console.log(`${row[0]} ${row[1]}`);' "$probe.sample")"
    [ -n "$sp" ] || continue
    sparql="SELECT ?o WHERE { <${sp% *}> <${sp#* }> ?o }"
    query_rows "$probe.$((k + 1))" "$n" "$cg" verifiable-memory "$sparql" o > /dev/null && [ -s "$probe.$((k + 1))" ] || continue
    k=$((k + 1)); printf 'verifiable memory <%s> <%s> of %s\037%s\037verifiable-memory\037%s\037o\n' "${sp% *}" "${sp#* }" "$cg" "$cg" "$sparql" >> "$probe"
    break
  done
  rm -f "$probe.sample"
  [ "$k" -gt 0 ]
}
# asset_probe_check <n> <probe>: within a minute, node <n> answers every probe of <probe> as the build under test did
# (the same distinct rows). Prints the first difference and fails.
asset_probe_check() {
  local n="$1" probe="$2" k=0 what cg view sparql var why deadline
  while IFS="$(printf '\037')" read -r what cg view sparql var; do
    k=$((k + 1)); deadline=$(( $(now) + 60 ))
    while :; do
      if why="$(query_rows "$probe.$k.now" "$n" "$cg" "$view" "$sparql" "$var" < /dev/null)"; then
        [ "$(sort -u "$probe.$k.now")" = "$(sort -u "$probe.$k")" ] && break
        why="$(sort -u "$probe.$k.now" | head -3 | tr '\n' ' ' | sed 's/ $//')"
        why="answered ${why:-nothing}, where the build under test answered $(sort -u "$probe.$k" | head -3 | tr '\n' ' ' | sed 's/ $//')"
      fi
      [ "$(now)" -lt "$deadline" ] || { echo "did not answer for $what as the build under test did: $why"; return 1; }
      sleep 2
    done
  done < "$probe"
}

rollback_steps() {
  local n="$1" endpoint="$2" target_version="$3" probe="$4" before partition_before partition_after members_before members_after members_earlier dropped version lost
  partition_before="$RESULTS/rows/rollback.partition-before.node$n"; partition_after="$RESULTS/rows/rollback.partition-after.node$n"
  before="$partition_before"
  members_before="$RESULTS/rows/rollback.members-before.node$n.json"; members_after="$RESULTS/rows/rollback.members-after.node$n.json"
  members_earlier="$RESULTS/rows/rollback.members-earlier.node$n.json"
  # The store must show the partition and some asset data with the daemon down, or the checks below prove nothing.
  partition_graphs "$endpoint" "$partition_before" && member_graphs "$endpoint" "$members_before" \
    || { printf 'INCONCLUSIVE\037%s\037\037\n' "node$n's store cannot be read with its daemon down (a managed store stops with it)"; return; }
  [ -s "$partition_before" ] || { printf 'INCONCLUSIVE\037%s\037\037\n' "node$n's store showed no read-graph partition before the rollback step"; return; }
  grep -q 'did:dkg:context-graph:' "$members_before" \
    || { printf 'INCONCLUSIVE\037%s\037\037\n' "node$n's store holds no asset data, so keeping it cannot be checked"; return; }
  # The public rollback command readies the stopped node's stores for the earlier release, as `dkg rollback` does before
  # it switches versions: it drops the read graphs and readies the inventory. The devnet then switches versions.
  if ! dkg_cli "$n" rollback --stores-for "$target_version" >> "$RESULTS/drill-rollback.log" 2>&1; then
    printf 'FAIL\037%s\037\037\n' "\`dkg rollback --stores-for $target_version\` failed on node$n (drill-rollback.log)"; return
  fi
  dropped="$(wc -l < "$before" | tr -d ' ')"
  # Whatever the step reports: the whole partition gone, and every asset graph holding exactly the triples it held.
  partition_graphs "$endpoint" "$partition_after" && member_graphs "$endpoint" "$members_after" \
    || { printf 'FAIL\037%s\037%s\037\n' "node$n's store could not be read after the rollback step" "$dropped"; return; }
  if [ -s "$partition_after" ]; then
    printf 'FAIL\037%s\037%s\037\n' "the rollback step left $(wc -l < "$partition_after" | tr -d ' ') graphs in node$n's read-graph partitions, such as $(head -1 "$partition_after")" "$dropped"
    return
  fi
  lost="$(members_lost "$members_before" "$members_after" exact)" \
    || { printf 'FAIL\037%s\037%s\037\n' "the rollback step changed node$n's asset data: $lost" "$dropped"; return; }
  # The earlier release does not know the setting; it runs without it, on the same asset data.
  set_read_graphs "$n" "-"
  start_node "$n" DEVNET_VERSION_LAYOUT="all:current,$n:$ROLLBACK_FROM" \
    || { printf 'FAIL\037%s\037%s\037\n' "node$n did not start on $ROLLBACK_FROM (devnet-sh.log)" "$dropped"; return; }
  version="$(node_commit "$n")"
  [ "$version" != "$UNDER_TEST" ] || { printf 'FAIL\037%s\037%s\037%s\n' "node$n still ran the build under test, not $ROLLBACK_FROM" "$dropped" "$version"; return; }
  member_graphs "$endpoint" "$members_earlier" && lost="$(members_lost "$members_before" "$members_earlier" kept)" \
    || { printf 'FAIL\037%s\037%s\037%s\n' "node$n's asset data on $ROLLBACK_FROM: ${lost:-unreadable}" "$dropped" "$version"; return; }
  # Kept triples are not enough: the earlier daemon must also find and read the assets through its own query route.
  lost="$(asset_probe_check "$n" "$probe")" \
    || { printf 'FAIL\037%s\037%s\037%s\n' "on $ROLLBACK_FROM, node$n $lost" "$dropped" "$version"; return; }
  printf '\037\037%s\037%s\n' "$dropped" "$version"
}

drill_rollback_and_forward() {
  local n="$ROLLBACK_NODE" started endpoint restore result outcome detail dropped version lost rc version_dir target_version probe read_through
  started="$(now)"; probe="$RESULTS/rows/rollback.probe.node$n"
  [ "$ROLLBACK_FROM" != none ] || { record drill-rollback INCONCLUSIVE 0 "not run (READ_GRAPHS_ROLLBACK_FROM=none)"; return; }
  endpoint="$(store_endpoint "$n")"
  [ -n "$endpoint" ] || { record drill-rollback INCONCLUSIVE 0 "node$n's store cannot be read from outside its daemon, so the rollback cannot be checked: use a node on Blazegraph or an external SPARQL endpoint"; return; }
  read_graph_rows "$n" > "$RESULTS/rows/rollback.before.node$n" && [ -s "$RESULTS/rows/rollback.before.node$n" ] \
    || { record drill-rollback INCONCLUSIVE 0 "node$n has no read graph to drop"; return; }
  # Known assets to read through the earlier release, as the build under test answers them now.
  asset_probe_record "$n" "$probe" \
    || { record drill-rollback INCONCLUSIVE "$(( $(now) - started ))" "the build under test answered no known asset of node$n (no seeded working-memory draft, no verifiable-memory triple), so reading assets through $ROLLBACK_FROM cannot be checked"; return; }
  read_through="$(cut -d "$(printf '\037')" -f1 "$probe" | awk '{ printf "%s%s", (NR > 1 ? " and " : ""), $0 }')"
  # Build the earlier release first, while nothing has changed yet. Its node needs only the ABIs the repository holds,
  # not compiled contracts (the devnet's chain runs from this checkout), so the contract compile is skipped.
  DKG_SKIP_EVM_BUILD=1 "$DEVNET_SH" prepare-version "$ROLLBACK_FROM" > "$RESULTS/prepare-version.log" 2>&1; rc=$?
  cat "$RESULTS/prepare-version.log" >> "$RESULTS/devnet-sh.log"
  [ "$rc" = 0 ] || { record drill-rollback INCONCLUSIVE "$(( $(now) - started ))" "could not prepare $ROLLBACK_FROM (devnet-sh.log)"; return; }
  version_dir="$(sed -n "s/.*prepared at \([^ ]*\).*/\1/p" "$RESULTS/prepare-version.log" | tail -1)"
  target_version="$(node -e 'console.log(require(process.argv[1]).version)' "$version_dir/packages/cli/package.json" 2>/dev/null)"
  [ -n "$target_version" ] || { record drill-rollback INCONCLUSIVE "$(( $(now) - started ))" "the version of $ROLLBACK_FROM could not be read (prepare-version.log)"; return; }
  restore="$(read_graphs_setting "$n")"
  stop_node "$n" || { record drill-rollback INCONCLUSIVE 0 "could not stop node$n"; return; }
  result="$(rollback_steps "$n" "$endpoint" "$target_version" "$probe")"
  IFS="$(printf '\037')" read -r outcome detail dropped version <<EOF_RESULT
$result
EOF_RESULT
  # One restoration, whatever happened: the node's setting back, and the node on the build under test.
  stop_node "$n" > /dev/null 2>&1 || true
  set_read_graphs "$n" "${restore:--}"
  start_node "$n" DEVNET_VERSION_LAYOUT="all:current" \
    || { record drill-rollback FAIL "$(( $(now) - started ))" "node$n did not come back on the build under test${detail:+ ($detail)}"; return; }
  [ -z "$outcome" ] || { record drill-rollback "$outcome" "$(( $(now) - started ))" "$detail"; return; }
  # Forward again: every asset triple from before the rollback still there, then rebuilt read graphs.
  if ! wait_all_ready drill-rollback "$READY_TIMEOUT" "$n"; then record drill-rollback FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the forward start"; return; fi
  member_graphs "$endpoint" "$RESULTS/rows/rollback.members-forward.node$n.json" \
    && lost="$(members_lost "$RESULTS/rows/rollback.members-before.node$n.json" "$RESULTS/rows/rollback.members-forward.node$n.json" kept)" \
    || { record drill-rollback FAIL "$(( $(now) - started ))" "node$n's asset data after the forward start: ${lost:-unreadable}"; return; }
  drill_end drill-rollback "$n" "$started" "\`dkg rollback --stores-for $target_version\` removed all $dropped read-graph partition graphs and kept every asset triple; ran $version, which answered $read_through as the build under test did; then rebuilt from nothing"
}

drill_flag_off_and_back() {
  local n="$FLAG_NODE" started restore undirty="" state gen graph gen_after older=""
  started="$(now)"; restore="$(read_graphs_setting "$n")"
  read_graph_rows "$n" > "$RESULTS/rows/flag.before.node$n" && all_ready "$RESULTS/rows/flag.before.node$n" \
    || { record drill-flag INCONCLUSIVE 0 "node$n had no ready read graph"; return; }
  set_read_graphs "$n" '"off"'
  restart_node "$n" || { set_read_graphs "$n" "${restore:--}"; record drill-flag FAIL "$(( $(now) - started ))" "node$n did not come back with off"; return; }
  # The off state counts only as observed: a status that could not be read proves nothing.
  if ! read_graph_rows "$n" > "$RESULTS/rows/flag.off.node$n"; then
    set_read_graphs "$n" "${restore:--}"; restart_node "$n"
    record drill-flag INCONCLUSIVE "$(( $(now) - started ))" "node$n's status could not be read with off, so the off state was not observed"; return
  fi
  while read -r state gen graph; do [ "$state" = dirty ] || undirty="$undirty <$graph>:$state"; done < "$RESULTS/rows/flag.off.node$n"
  set_read_graphs "$n" "${restore:--}"
  # With off, the node keeps no read graph: status lists none, or lists them dirty.
  [ -s "$RESULTS/rows/flag.off.node$n" ] || note "drill-flag: with off, status listed no read graph on node$n"
  [ -z "$undirty" ] || { restart_node "$n"; record drill-flag FAIL "$(( $(now) - started ))" "with off, not dirty:$undirty"; return; }
  restart_node "$n" || { record drill-flag FAIL "$(( $(now) - started ))" "node$n did not come back with the setting"; return; }
  if ! wait_all_ready drill-flag "$READY_TIMEOUT" "$n"; then record drill-flag FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the setting came back"; return; fi
  while read -r state gen graph; do
    gen_after="$(generation_of "$RESULTS/rows/drill-flag.node$n" "$graph")"
    [ -n "$gen_after" ] && [ "$gen_after" != "$gen" ] || older="$older <$graph>"
  done < "$RESULTS/rows/flag.before.node$n"
  [ -z "$older" ] || { record drill-flag FAIL "$(( $(now) - started ))" "no new generation for:$older"; return; }
  drill_end drill-flag "$n" "$started" "with off no read graph was kept or ready; back on, each got a new generation and was rebuilt"
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
  [ "$STOPPED" = 0 ] || { record "$phase" INCONCLUSIVE 0 "not run: a precondition of an earlier step was not met"; continue; }
  "phase_$phase"
done
for phase in seed setup backfill measure gate drills; do
  case " $PHASES " in *" $phase "*) ;; *) note "$phase was not run (READ_GRAPHS_RUN_PHASES)"; GAPS=$((GAPS + 1)) ;; esac
done

if [ "$FAILS" -gt 0 ]; then say "FAIL"; exit 1; fi
if [ "$GAPS" -gt 0 ]; then say "INCONCLUSIVE"; exit "$SKIP_EXIT"; fi
say "PASS"
exit 0
