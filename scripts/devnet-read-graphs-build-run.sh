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
#   live      switch READ_GRAPHS_LIVE_CG (default devnet-test) live through the
#             settings API (PUT /api/store/read-graphs/settings), no restart, on
#             every node that holds it. Answers are checked with a join across
#             two working-memory drafts the node's agent writes first (<x> knows
#             <y> in one, <y> name in the other): off, where its read graphs go
#             and a merged request is refused as for a layer the node does not
#             serve; build, where they are rebuilt from nothing, ready, and the
#             full check is clean; serve for working and verifiable memory, where
#             the merged join returns the joined row and the per-asset one none;
#             and a default view semantics, followed by a request that names
#             none. Then, on READ_GRAPHS_LIVE_LOAD_NODE, switch its layers between
#             build and serve while the node's own agent writes drafts into it
#             (each switch must take effect while the writes go on: the modes it
#             asked for, and the merged join answered or refused accordingly;
#             writes must be acknowledged between every two switches, or the
#             phase is INCONCLUSIVE; every acknowledged write must be there after
#             it, and the full check clean), and restart the node: the settings
#             must hold and the join be answered across assets again without
#             being set again. The context graph stays in serve for working and
#             verifiable memory and in build for shared memory, so the gate runs
#             with it. The restart counts only when another daemon worker answers
#             afterwards. A restarted node refuses reads of a graph's shared
#             memory until it has accepted the graph's RFC-64 authority again, so
#             the phase then waits, at most READ_GRAPHS_LIVE_SWM_READY_TIMEOUT,
#             until the node reads the context graph's shared memory again: the
#             next phase starts outside that window, and the step's detail says
#             how long it took. Without the settings API the phase does not
#             apply (N/A) and the rest of the run can still pass;
#             READ_GRAPHS_SWITCH=api, as the bar for live settings uses it, stops
#             the run instead;
#   gate      run READ_GRAPHS_GATE_CMD (default scripts/devnet-comprehensive.sh)
#             with read graphs on, wait for `ready`, then run the full check
#             again. Every mismatch a check logs during the workload fails the
#             gate, even when the read graph was rebuilt by the end (except in
#             the context graphs a suite writes into the store directly). Only a complete pass of the comprehensive run counts
#             (completeSuccess in its REPORT.json); a filtered run is
#             INCONCLUSIVE;
#   drills    a restart during a rebuild (of the drill's own context graph,
#             whose shared memory takes seconds to copy: the read graphs a
#             devnet holds are rebuilt in milliseconds); a kill of the daemon worker while it
#             holds a working-memory write (writes of several hundred triples
#             from a writer bounded by time, while a second writer loads the
#             node; each kill aimed late in a write, at a share of the median
#             write time; up to two rounds of five crashes), with that agent's read graph
#             built first (a kill counts only when the write's whole request
#             was uploaded and dropped unanswered, and its data is there after
#             the restart, so the worker had begun to store it; the
#             worker gone and a new one in its place; every write the node acknowledged must be there after
#             it, whole, and the agent's working-memory read graph ready and
#             consistent); a CLI write with the daemon down (`dkg publisher clear
#             finalized`, after the drill finalized a publish job of its own on
#             the node; the cleared jobs must stay cleared; a store opened outside the daemon starts read
#             graphs as the daemon does, with the same settings: each shared-layer
#             read graph, which a plain restart first keeps at its generation,
#             must keep it; the write touches only the publisher's own graphs, so
#             the drill shows that start, not maintenance, which
#             publisher-store.test.ts covers, and with the settings unchanged it
#             cannot show a read graph marked dirty, which #3900 adds); a rollback and forward again (the
#             earlier release is
#             built first; `dkg rollback --stores-for <its version>` readies the
#             stopped node's stores, and after it the node's store must hold
#             no read-graph partition and every asset graph as before, and
#             still every triple of them once the earlier release runs (the
#             agents system graph aside: each daemon rewrites its own
#             registration there when it starts); the
#             earlier daemon must answer the node's seeded working-memory
#             draft and the drill's own verifiable-memory asset, which the node
#             publishes first, through /api/query as the build under test did; and
#             after the forward start every asset graph again (the agents
#             system graph aside, as before), so the drill
#             node needs a store that stays up with its daemon down:
#             Blazegraph or an external SPARQL endpoint); and the setting to
#             `off` and back (with the settings API, the live context graph's
#             layers through the API with no restart; otherwise the node's
#             config.json and a restart). Each must end
#             as designed (a new generation, or a dropped partition), and then
#             be `ready` again with a clean full check. A drill whose workload
#             did not happen is INCONCLUSIVE, never a pass. The drills make the
#             data they need, and they run after the gate even when the gate
#             failed, so one run reports them all (it stays FAIL); a failure in
#             any other phase stops every later one.
#
# It writes report.md and results.tsv to READ_GRAPHS_RUN_RESULTS (default
# $DEVNET_DIR/read-graphs-build-run/<UTC timestamp>; no spaces). It saves every
# node's config.json, and with the settings API every node's settings, before
# any phase runs. At the end, also after a failure or an interruption, unless
# READ_GRAPHS_RUN_KEEP=1, it:
#   - switches the live context graph off through the settings API on each node
#     it switched;
#   - puts back the config.json of each node it changed, restarts those nodes in
#     ascending order, and drops the read graphs their own settings do not keep;
#   - puts back the live context graph's own settings on each node it switched:
#     its own modes and its own view-semantics default, or none. The API can't
#     remove a layer's own setting, so a layer that had none gets the node's mode
#     from before the run as its own, and the report's Notes name those layers.
#
# The node-wide setting (READ_GRAPHS_SETTING) is always written to config.json,
# as node-wide policy stays there. Per-context-graph settings are switched
# through the settings API, and the read graphs a node must keep are worked out
# from its effective modes there for every context graph it has a setting for.
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
#   READ_GRAPHS_RUN_PHASES                     default "seed setup backfill measure live gate drills"
#   READ_GRAPHS_SWITCH                         auto (default: the settings API when the daemon answers it; on a
#                                              build without it, a plain 404, config.json only and the live phase
#                                              N/A; any other answer stops the run), api (stop unless it answers:
#                                              the bar for live settings), or config
#   READ_GRAPHS_LIVE_CG                        the context graph the live phase switches (default devnet-test)
#   READ_GRAPHS_LIVE_LOAD_NODE                 the node of the live phase's switches under write load and its
#                                              restart (default 1)
#   READ_GRAPHS_LIVE_SWM_READY_TIMEOUT         seconds the live phase waits, after its restart's checks, for the
#                                              node to read the live context graph's shared memory again (default 300)
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
#   READ_GRAPHS_DRILL_RESTART_TRIPLES          shared-memory triples in the restart drill's own context graph
#                                              (default 500000), READ_GRAPHS_DRILL_RESTART_ASSET_TRIPLES of them per
#                                              knowledge asset (default 2000)
#   READ_GRAPHS_DRILLS                         the drills the drills phase runs (default "restart kill cli rollback
#                                              flag"); one left out is INCONCLUSIVE, so the run cannot pass
#   READ_GRAPHS_DRILL_KILL_WRITE_TRIPLES       triples per working-memory write in the kill drill (default 500)
#   READ_GRAPHS_DRILL_KILL_WRITER_SECONDS      how long the kill drill's writer goes on at most (default 600; 3,000
#                                              writes at most)
#   READ_GRAPHS_PUBLISH_TIMEOUT                seconds the cli and rollback drills wait for their own publish job to
#                                              be finalized (default 300)
#   READ_GRAPHS_RUN_RESULTS, READ_GRAPHS_RUN_KEEP
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
DEVNET_SH="${DEVNET_SH:-$REPO_ROOT/scripts/devnet.sh}"
DKG_CLI_ENTRY="${DKG_CLI_ENTRY:-$REPO_ROOT/packages/cli/dist/cli.js}"
SETTING="${READ_GRAPHS_SETTING:-\"build\"}"
PHASES="${READ_GRAPHS_RUN_PHASES:-seed setup backfill measure live gate drills}"
SWITCH="${READ_GRAPHS_SWITCH:-auto}"
LIVE_CG="${READ_GRAPHS_LIVE_CG:-devnet-test}"
LOAD_NODE="${READ_GRAPHS_LIVE_LOAD_NODE:-1}"
SWM_READY_TIMEOUT="${READ_GRAPHS_LIVE_SWM_READY_TIMEOUT:-300}"
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
RESTART_TRIPLES="${READ_GRAPHS_DRILL_RESTART_TRIPLES:-500000}"
RESTART_ASSET_TRIPLES="${READ_GRAPHS_DRILL_RESTART_ASSET_TRIPLES:-2000}"
KILL_WRITE_TRIPLES="${READ_GRAPHS_DRILL_KILL_WRITE_TRIPLES:-500}"
KILL_WRITER_SECONDS="${READ_GRAPHS_DRILL_KILL_WRITER_SECONDS:-600}"
DRILLS="${READ_GRAPHS_DRILLS:-restart kill cli rollback flag}"
PUBLISH_TIMEOUT="${READ_GRAPHS_PUBLISH_TIMEOUT:-300}"
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
# shellcheck source=devnet-read-graphs-run-lib.sh
. "$REPO_ROOT/scripts/devnet-read-graphs-run-lib.sh" || early_exit "cannot source scripts/devnet-read-graphs-run-lib.sh"
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
# redial <n>: every other node of the run dials node <n> (POST /api/connect with its .devnet/nodeN/multiaddr). A node
# that did not restart does not dial a restarted one again by itself, and a publish from it needs the Cores' ACKs.
redial() {
  local k addr body
  addr="$(head -1 "$DEVNET_DIR/node$1/multiaddr" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$addr" ] || return 0
  body="{\"multiaddr\":\"$addr\"}"
  for k in $NODES; do
    [ "$k" = "$1" ] || api "$k" POST /api/connect "$body" > /dev/null 2>&1 || true
  done
}
# restart_node <n> [VAR=value ...]: bounce one node through devnet.sh, wait for its API, and have the others dial it.
restart_node() {
  local n="$1"; shift
  env "$@" "$DEVNET_SH" restart-node "$n" >> "$RESULTS/devnet-sh.log" 2>&1 || true
  wait_up "$n" 180 && redial "$n"
}
# The nodes whose config or running state this run changed; cleanup puts them back.
CHANGED=""
changed() { CHANGED="$CHANGED $1"; }
stop_node() { changed "$1"; "$DEVNET_SH" stop-node "$1" >> "$RESULTS/devnet-sh.log" 2>&1; }
start_node() {
  local n="$1"; shift
  env "$@" "$DEVNET_SH" start-node "$n" >> "$RESULTS/devnet-sh.log" 2>&1 || true
  wait_up "$n" 180 && redial "$n"
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
  local setting frames cg agent effective i=0
  setting="$(read_graphs_setting "$1")"
  # With the settings API, a context graph it lists takes its effective modes from there.
  effective="$(effective_map "$1")" || return 1
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
  SETTING_JSON="${setting:-\"off\"}" EFFECTIVE_JSON="$effective" LISTING_MODULE="$LISTING_MODULE" CORE_MODULE="$CORE_MODULE" \
    STORAGE_MODULE="$STORAGE_MODULE" QUERY_CONFIG_MODULE="$QUERY_CONFIG_MODULE" node --input-type=module -e '
    const fs = await import("node:fs");
    const { readListing } = await import(process.env.LISTING_MODULE);
    const core = await import(process.env.CORE_MODULE);
    const { readGraphModeOf } = await import(process.env.STORAGE_MODULE);
    const { resolveQueryConfig } = await import(process.env.QUERY_CONFIG_MODULE);
    const effective = JSON.parse(process.env.EFFECTIVE_JSON || "{}");
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
    const modeOf = (key) => effective.__policyDisabled ? "off" : effective[key.scope.contextGraphId]?.[key.layer] ?? readGraphModeOf(modes, key);
    for (const graph of listing.graphs) {
      if (graph.subscribed !== true || !core.isReadGraphEligibleContextGraphId(graph.id)) continue;
      const scopes = [core.readScope(graph.id), ...(subGraphs.get(graph.id) ?? []).map((name) => core.readScope(graph.id, name))];
      for (const scope of scopes) for (const layer of [core.MemoryLayer.VerifiableMemory, core.MemoryLayer.SharedWorkingMemory]) {
        const key = { scope, layer };
        if (modeOf(key) === "off") continue;
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
  local setting effective
  setting="$(read_graphs_setting "$1")"
  effective="$(effective_map "$1")" || return 1
  SETTING_JSON="${setting:-\"off\"}" EFFECTIVE_JSON="$effective" CORE_MODULE="$CORE_MODULE" STORAGE_MODULE="$STORAGE_MODULE" \
    QUERY_CONFIG_MODULE="$QUERY_CONFIG_MODULE" CG="$2" AGENT="$3" node --input-type=module -e '
    const core = await import(process.env.CORE_MODULE);
    const { readGraphModeOf } = await import(process.env.STORAGE_MODULE);
    const { resolveQueryConfig } = await import(process.env.QUERY_CONFIG_MODULE);
    const modes = resolveQueryConfig({ readGraphs: JSON.parse(process.env.SETTING_JSON) }).readGraphs;
    const effective = JSON.parse(process.env.EFFECTIVE_JSON || "{}");
    const key = { scope: core.readScope(process.env.CG), layer: core.MemoryLayer.WorkingMemory, agentAddress: process.env.AGENT };
    const mode = effective.__policyDisabled ? "off" : effective[process.env.CG]?.[key.layer] ?? readGraphModeOf(modes, key);
    if (mode !== "off") console.log(core.readGraphIri(key));
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

# ── the settings API: the one place that parses its answers ─────────────────
SETTINGS_PATH=/api/store/read-graphs/settings
urlencode() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
# settings_read <answer file> <what> [context graph] [layer]: one value from a settings answer ("<code>\n<body>", as
# api writes it):
#   code                    the HTTP code
#   effective <cg> <layer>  the effective mode of the layer (API name), "" when the answer does not list the context graph
#   rows <cg>               the context graph's stored modes as JSON with sorted keys, {} when it has none
#   default <cg>            its effective view semantics
#   refusal                 "HTTP <code> <code field>: <error>"
#   error-code              the body's code field, "" when it has none
#   effective-map           {"<cg>": {"WM": mode, "SWM": mode, "VM": mode}} for every context graph the answer lists,
#                           with "__policyDisabled": true when the node's policy switches read graphs off
#   restore-body <cg>       the PUT that sets the context graph's own settings as the answer lists them: each layer's own
#                           mode, else the node's (the API can't remove a layer's own setting); its own default, else null
#   inherited <cg>          the layers without an own mode, as "<layer>=<the node's mode>" separated by spaces
settings_read() {
  node -e '
    const fs = require("fs");
    const VIEWS = ["working-memory", "shared-working-memory", "verifiable-memory"];
    const [file, what, cg, layer] = process.argv.slice(1);
    const frame = fs.readFileSync(file, "utf8"); const at = frame.indexOf("\n");
    const code = (at === -1 ? frame : frame.slice(0, at)).trim();
    let body = null; try { body = JSON.parse(at === -1 ? "" : frame.slice(at + 1)); } catch { body = null; }
    const graphs = Array.isArray(body?.contextGraphs) ? body.contextGraphs : [];
    const one = (id) => graphs.find((graph) => graph?.contextGraphId === id);
    const out = (value) => process.stdout.write(value === undefined || value === null ? "" : String(value));
    const sorted = (object) => Object.fromEntries(Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    switch (what) {
      case "code": out(code); break;
      case "effective": out(one(cg)?.effective?.layers?.[layer]); break;
      case "rows": out(JSON.stringify(sorted(one(cg)?.layers))); break;
      case "default": out(one(cg)?.effective?.viewSemantics); break;
      case "refusal": out(`HTTP ${code}${body?.code ? ` ${body.code}` : ""}: ${body?.error ?? "no error text"}`); break;
      case "error-code": out(body?.code); break;
      case "restore-body": case "inherited": {
        // A layer without an own mode has the node mode, which the answer gives as node.layers (and in effective).
        const own = one(cg);
        const nodeMode = (view) => body?.node?.layers?.[view] ?? own?.effective?.layers?.[view] ?? "off";
        if (what === "inherited") {
          out(VIEWS.filter((view) => own?.layers?.[view] === undefined).map((view) => `${view}=${nodeMode(view)}`).join(" "));
          break;
        }
        const layers = Object.fromEntries(VIEWS.map((view) => [view, own?.layers?.[view] ?? nodeMode(view)]));
        out(JSON.stringify({ contextGraphId: cg, layers, viewSemantics: own?.viewSemantics ?? null }));
        break;
      }
      case "effective-map": {
        const map = {};
        if (body?.policy?.enabled === false) map.__policyDisabled = true;
        for (const graph of graphs) {
          const layers = graph?.effective?.layers;
          if (typeof graph?.contextGraphId !== "string" || !layers) continue;
          map[graph.contextGraphId] = { WM: layers["working-memory"], SWM: layers["shared-working-memory"], VM: layers["verifiable-memory"] };
        }
        out(JSON.stringify(map));
        break;
      }
      default: process.exit(2);
    }
  ' "$@"
}
# effective_map <n>: with the settings API, settings_read effective-map of node <n>'s settings; "{}" without it.
# Fails when the API answers something else than 200.
effective_map() {
  [ "$SWITCH" = api ] || { printf '{}'; return 0; }
  api "$1" GET "$SETTINGS_PATH" > "$RESULTS/rows/settings.node$1"
  [ "$(settings_read "$RESULTS/rows/settings.node$1" code)" = 200 ] \
    || { echo "settings of node$1: $(settings_read "$RESULTS/rows/settings.node$1" refusal)" >&2; return 1; }
  settings_read "$RESULTS/rows/settings.node$1" effective-map
}

dkg_cli "${NODES%% *}" store read-graphs --help > /dev/null 2>&1 \
  || early_exit "this build has no \`dkg store read-graphs\` commands"
# How per-context-graph modes are switched: through the settings API when the daemon answers it, else not at all
# (config: the node-wide setting in config.json only, and the live phase cannot run).
case "$SWITCH" in auto|api|config) ;; *) early_exit "READ_GRAPHS_SWITCH must be auto, api or config: $SWITCH" ;; esac
if [ "$SWITCH" != config ]; then
  api "${NODES%% *}" GET "$SETTINGS_PATH" > "$RESULTS/rows/settings-probe"
  settings_probe="$(settings_read "$RESULTS/rows/settings-probe" code)"
  if [ "$settings_probe" = 200 ]; then
    SWITCH=api
  elif [ "$SWITCH" = api ]; then
    early_exit "READ_GRAPHS_SWITCH=api, but node${NODES%% *} answers the settings API with $(settings_read "$RESULTS/rows/settings-probe" refusal)"
  elif [ "$settings_probe" = 404 ] && [ -z "$(settings_read "$RESULTS/rows/settings-probe" error-code)" ]; then
    # Only the daemon's plain 404 for a route it doesn't have (no code field) means a build without the settings API.
    note "node${NODES%% *} has no settings API (HTTP 404 for $SETTINGS_PATH), so modes are switched through config.json only and the live phase does not apply (READ_GRAPHS_SWITCH=api requires the API)"
    SWITCH=config
  else
    # A refusal, a server error or no answer is a settings API that doesn't work: the run stops, never a pass.
    early_exit "node${NODES%% *}'s settings API answered neither its settings nor a plain 404 (a build without it), so the live settings can't be checked (READ_GRAPHS_SWITCH=config runs without them): $(settings_read "$RESULTS/rows/settings-probe" refusal)"
  fi
fi
# With the settings API, every node's settings before any phase runs: cleanup puts back the live context graph's own.
if [ "$SWITCH" = api ]; then
  for n in $NODES; do
    api "$n" GET "$SETTINGS_PATH" > "$RESULTS/rows/settings-original.node$n"
    [ "$(settings_read "$RESULTS/rows/settings-original.node$n" code)" = 200 ] \
      || early_exit "node$n's settings could not be saved to be put back after the run: its settings API answered $(settings_read "$RESULTS/rows/settings-original.node$n" refusal)"
  done
fi
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
  local n changed w body inherited attempt
  for w in $(cat "$RESULTS/gate/watchers" 2>/dev/null); do kill "$w" 2>/dev/null; done
  # A kill drill or a live phase interrupted mid-run leaves its writer: stop it and its requests before any node is restored.
  w="$(cat "$RESULTS/drill-kill.writer" 2>/dev/null)"
  [ -n "$w" ] && stop_writer "$w"
  stop_load
  w="$(cat "$RESULTS/live-load.writer" 2>/dev/null)"
  [ -n "$w" ] && { kill_tree "$w"; wait "$w" 2>/dev/null; rm -f "$RESULTS/live-load.writer"; }
  # The live context graph off first, through the settings API, on each node the run switched it on, so the restarts
  # below and the drop of what a node does not keep find none of its read graphs in use (its settings come back last).
  if [ -s "$RESULTS/rows/live-changed" ] && [ "$KEEP" != 1 ]; then
    body="$(live_body off off off null)"
    for n in $(sort -nu "$RESULTS/rows/live-changed"); do
      node_up "$n" || { note "cleanup: node$n was down, so $LIVE_CG was not switched off there"; continue; }
      api "$n" PUT "$SETTINGS_PATH" "$body" > "$RESULTS/rows/live.cleanup.node$n"
      [ "$(settings_read "$RESULTS/rows/live.cleanup.node$n" code)" = 200 ] \
        || note "cleanup: switching $LIVE_CG off on node$n failed: $(settings_read "$RESULTS/rows/live.cleanup.node$n" refusal)"
    done
  fi
  changed="$(printf '%s\n' $CHANGED | sort -nu | tr '\n' ' ')"
  if [ -n "${changed// /}" ] && [ "$KEEP" != 1 ]; then
    say "putting back the config.json of nodes ${changed% }, restarting them, and dropping read graphs their settings do not keep"
    for n in $changed; do cp "$RESULTS/config/node$n.json" "$DEVNET_DIR/node$n/config.json"; done
    for n in $changed; do
      if ! restart_node "$n"; then note "cleanup: node$n did not come back after the restart"; status=1; continue; fi
      drop_unkept "$n" || note "cleanup: dropping the read graphs node$n's setting does not keep failed (see cli.log)"
    done
  fi
  # Then the live context graph's own settings as they were before the run, on each node the run switched it on. A node
  # left without them fails the run: its queries no longer behave as before it.
  if [ -s "$RESULTS/rows/live-changed" ] && [ "$KEEP" != 1 ]; then
    for n in $(sort -nu "$RESULTS/rows/live-changed"); do
      [ -s "$RESULTS/rows/settings-original.node$n" ] \
        || { note "cleanup: node$n's settings from before the run were not saved, so $LIVE_CG stays Off there"; status=1; continue; }
      node_up "$n" || { note "cleanup: node$n was down, so $LIVE_CG's settings were not put back there"; status=1; continue; }
      body="$(settings_read "$RESULTS/rows/settings-original.node$n" restore-body "$LIVE_CG")"
      for attempt in 1 2 3; do
        api "$n" PUT "$SETTINGS_PATH" "$body" > "$RESULTS/rows/live.restore.node$n"
        [ "$(settings_read "$RESULTS/rows/live.restore.node$n" code)" = 200 ] && break
        [ "$attempt" = 3 ] || sleep 5
      done
      if [ "$(settings_read "$RESULTS/rows/live.restore.node$n" code)" != 200 ]; then
        note "cleanup: putting back $LIVE_CG's settings on node$n was refused three times, so it stays Off there: $(settings_read "$RESULTS/rows/live.restore.node$n" refusal)"
        status=1; continue
      fi
      inherited="$(settings_read "$RESULTS/rows/settings-original.node$n" inherited "$LIVE_CG")"
      [ -z "$inherited" ] \
        || note "cleanup: $LIVE_CG's settings on node$n are back as before the run; the API can't remove a layer's own setting, so the layers that had none hold the node's mode from before the run as their own: $inherited"
    done
  fi
  # The verdict was printed before cleanup: a node cleanup could not put back fails the run, in the report too.
  [ "$status" != 1 ] || [ "$FAILS" -gt 0 ] || { record cleanup FAIL 0 "a node was not put back as it was before the run (see Notes)"; say "FAIL"; }
  write_report
  exit "$status"
}
write_report() {
  {
    echo "# Read-graph build run $RUN_ID"
    echo
    echo "- Setting: \`query.readGraphs = $SETTING\` on nodes $NODES"
    if [ "$SWITCH" = api ]; then echo "- Per-context-graph settings: through the settings API; the live phase switched \`$LIVE_CG\`"
    else echo "- Per-context-graph settings: none (the daemon offers no settings API, or READ_GRAPHS_SWITCH=config)"; fi
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

# ── live: one context graph switched through the settings API ──────────────
# rows/live-changed names the nodes whose settings for the live context graph the run changed (a file, as the calls
# run in command substitutions); cleanup puts back the context graph's own settings there (rows/settings-original.*).
RUN_SLUG="$(echo "$RUN_ID" | tr 'A-Z' 'a-z')"
# live_body <wm> <swm> <vm> [view semantics]: a PUT body for the live context graph, with the layers' modes ("-" leaves
# a layer out) and the view semantics ("merged", "per-asset", "null" to remove it, or "" to leave it out).
live_body() {
  node -e '
    const [contextGraphId, wm, swm, vm, semantics] = process.argv.slice(1);
    const layers = {};
    if (wm !== "-") layers["working-memory"] = wm;
    if (swm !== "-") layers["shared-working-memory"] = swm;
    if (vm !== "-") layers["verifiable-memory"] = vm;
    const body = { contextGraphId };
    if (Object.keys(layers).length) body.layers = layers;
    if (semantics) body.viewSemantics = semantics === "null" ? null : semantics;
    process.stdout.write(JSON.stringify(body));
  ' "$LIVE_CG" "$1" "$2" "$3" "${4:-}"
}
# live_put <n> <label> <body>: PUT node <n>'s settings; the answer goes to rows/live.<label>.node<n>. Prints the
# refusal and fails unless the node answers 200.
live_put() {
  local out="$RESULTS/rows/live.$2.node$1"
  echo "$1" >> "$RESULTS/rows/live-changed"
  api "$1" PUT "$SETTINGS_PATH" "$3" > "$out"
  [ "$(settings_read "$out" code)" = 200 ] || { settings_read "$out" refusal; return 1; }
}
# live_get <n> <label>: GET node <n>'s settings for the live context graph into rows/live.<label>.node<n>; fails unless 200.
live_get() {
  local out="$RESULTS/rows/live.$2.node$1"
  api "$1" GET "$SETTINGS_PATH?contextGraphId=$(urlencode "$LIVE_CG")" > "$out"
  [ "$(settings_read "$out" code)" = 200 ] || { settings_read "$out" refusal; return 1; }
}
# live_layers <n> <label>: the effective modes in rows/live.<label>.node<n>, as "wm=<mode> swm=<mode> vm=<mode>".
live_layers() {
  local f="$RESULTS/rows/live.$2.node$1"
  printf 'wm=%s swm=%s vm=%s' "$(settings_read "$f" effective "$LIVE_CG" working-memory)" \
    "$(settings_read "$f" effective "$LIVE_CG" shared-working-memory)" "$(settings_read "$f" effective "$LIVE_CG" verifiable-memory)"
}
# live_graphs <rows file>: the lines of a status listing that are read graphs of the live context graph.
live_graphs() {
  CORE_MODULE="$CORE_MODULE" CG="$LIVE_CG" ROWS="$1" node --input-type=module -e '
    const fs = await import("node:fs");
    const core = await import(process.env.CORE_MODULE);
    for (const line of fs.readFileSync(process.env.ROWS, "utf8").split("\n").filter(Boolean)) {
      const key = core.parseReadGraphIri(line.split(" ")[2]);
      if (key?.scope.contextGraphId === process.env.CG) console.log(line);
    }'
}
# holds_live_cg <n>: node <n> subscribes to the live context graph (its listing, read as context_graph_count reads it).
holds_live_cg() {
  api "$1" GET /api/context-graph/list | LISTING_MODULE="$LISTING_MODULE" CG="$LIVE_CG" node --input-type=module -e '
    const { readListing } = await import(process.env.LISTING_MODULE);
    let frame = ""; for await (const chunk of process.stdin) frame += chunk;
    const newline = frame.indexOf("\n");
    const listing = readListing(Number(newline === -1 ? frame : frame.slice(0, newline)), newline === -1 ? "" : frame.slice(newline + 1));
    process.exit(listing.ok && listing.graphs.some((graph) => graph.subscribed === true && graph.id === process.env.CG) ? 0 : 1);
  '
}
# live_wait_gone <n> <label>: until node <n>'s status lists no read graph of the live context graph; fails after
# READ_GRAPHS_READY_TIMEOUT, leaving the last listing in rows/live.<label>.node<n>.
live_wait_gone() {
  local rows="$RESULTS/rows/live.$2.node$1" deadline=$(( $(now) + READY_TIMEOUT ))
  while [ "$(now)" -lt "$deadline" ]; do
    if read_graph_rows "$1" > "$rows.all" 2>/dev/null && live_graphs "$rows.all" > "$rows" && [ ! -s "$rows" ]; then return 0; fi
    sleep 5
  done
  return 1
}
# live_query <n> <view> <semantics or ""> <out>: a view query on the live context graph. Prints "<HTTP code> <the
# semantics that answered, or the refusal's code>". An answer counts only with its result, one row whose count is a
# whole number; without one it prints "<HTTP code> <semantics> without a count", which never matches an expectation.
live_query() {
  local body resp
  body="$(node -e '
    const [contextGraphId, view, semantics] = process.argv.slice(1);
    const body = { contextGraphId, view, sparql: "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }" };
    if (semantics) body.semantics = semantics;
    process.stdout.write(JSON.stringify(body));' "$LIVE_CG" "$2" "$3")"
  resp="$(api "$1" POST /api/query "$body")"
  printf '%s\n' "$resp" > "$4"
  printf '%s %s' "$(code_of "$resp")" "$(body_of "$resp" | CODE="$(code_of "$resp")" node -e '
    let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
      let j; try { j = JSON.parse(d); } catch { return; }
      const label = String(j.semantics ?? j.result?.semantics ?? j.code ?? "");
      if (!/^2/.test(process.env.CODE ?? "")) { process.stdout.write(label); return; }
      // The count however the release renders it: "lexical"^^<datatype>, bare, or as an object.
      const bindings = Array.isArray(j.result?.bindings) ? j.result.bindings : [];
      const cell = bindings.length === 1 ? bindings[0]?.n : undefined;
      const text = String(cell && typeof cell === "object" ? cell.value ?? "" : cell ?? "");
      const lexical = /^"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? text;
      process.stdout.write(/^\d+$/.test(lexical) ? label : `${label} without a count`);
    });')"
}
# The answers are checked with a join across assets: two working-memory drafts of the node's own agent in the live
# context graph, one holding <x> knows <y> and the other <y> name "joined ...". Only an answer across assets joins them:
# a merged query must return the joined row, and a per-asset one must not.
JOIN_X="urn:read-graphs-live:$RUN_SLUG:x"
JOIN_Y="urn:read-graphs-live:$RUN_SLUG:y"
JOIN_NAME="joined $RUN_SLUG"
JOIN_SPARQL="SELECT ?name WHERE { <$JOIN_X> <http://schema.org/knows> ?y . ?y <http://schema.org/name> ?name }"
# live_join_fixture <n>: node <n>'s agent writes the two drafts. Prints why, and fails, unless both are acknowledged.
live_join_fixture() {
  local n="$1" body resp
  body="{\"contextGraphId\":\"$LIVE_CG\",\"name\":\"live-join-a-$RUN_SLUG\"}"
  api "$n" POST /api/knowledge-assets "$body" > /dev/null
  body="{\"contextGraphId\":\"$LIVE_CG\",\"quads\":[{\"subject\":\"$JOIN_X\",\"predicate\":\"http://schema.org/knows\",\"object\":\"$JOIN_Y\"}]}"
  resp="$(api "$n" POST "/api/knowledge-assets/live-join-a-$RUN_SLUG/wm/write" "$body")"
  case "$(code_of "$resp")" in 2??) ;; *) echo "the first draft of the join was not written (HTTP $(code_of "$resp"))"; return 1 ;; esac
  body="{\"contextGraphId\":\"$LIVE_CG\",\"name\":\"live-join-b-$RUN_SLUG\"}"
  api "$n" POST /api/knowledge-assets "$body" > /dev/null
  body="{\"contextGraphId\":\"$LIVE_CG\",\"quads\":[{\"subject\":\"$JOIN_Y\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"$JOIN_NAME\\\"\"}]}"
  resp="$(api "$n" POST "/api/knowledge-assets/live-join-b-$RUN_SLUG/wm/write" "$body")"
  case "$(code_of "$resp")" in 2??) ;; *) echo "the second draft of the join was not written (HTTP $(code_of "$resp"))"; return 1 ;; esac
}
# live_join_query <n> <semantics or ""> <out>: the join on working memory. Prints "<HTTP code> <the semantics that
# answered, or the refusal's code>", and with an answer " <rows>" when every row holds the joined name, else
# " <joined> joined and <other> other": the whole binding set counts, so an extra or a wrong row never matches.
live_join_query() {
  local body resp
  body="$(node -e '
    const [contextGraphId, semantics, sparql] = process.argv.slice(1);
    const body = { contextGraphId, view: "working-memory", sparql };
    if (semantics) body.semantics = semantics;
    process.stdout.write(JSON.stringify(body));' "$LIVE_CG" "$2" "$JOIN_SPARQL")"
  resp="$(api "$1" POST /api/query "$body")"
  printf '%s\n' "$resp" > "$3"
  printf '%s %s' "$(code_of "$resp")" "$(body_of "$resp" | NAME="$JOIN_NAME" node -e '
    let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
      let j; try { j = JSON.parse(d); } catch { return; }
      const label = String(j.semantics ?? j.result?.semantics ?? j.code ?? "");
      const bindings = Array.isArray(j.result?.bindings) ? j.result.bindings : null;
      // A literal however the release renders it: "lexical"^^<datatype>, "lexical"@lang, bare, or as an object.
      const value = (v) => { const t = String(v && typeof v === "object" ? v.value ?? "" : v ?? ""); const m = /^"((?:[^"\\]|\\.)*)"/.exec(t); return m ? m[1] : t; };
      if (bindings === null) { process.stdout.write(label); return; }
      const joined = bindings.filter((b) => value(b?.name) === process.env.NAME).length;
      const other = bindings.length - joined;
      process.stdout.write(`${label} ${other === 0 ? joined : `${joined} joined and ${other} other`}`);
    });')"
}
# live_expect <n> <label> <vm|join> <semantics or ""> <expected> [seconds to retry]: prints what the node answered
# instead, and fails, unless it answers as expected within the time given. vm: live_query on verifiable memory,
# "<code> <semantics or code>"; join: live_join_query, "<code> <semantics> <rows>" ("<code> <code>" for a refusal).
live_expect() {
  local got deadline=$(( $(now) + ${6:-0} ))
  while :; do
    if [ "$3" = join ]; then got="$(live_join_query "$1" "$4" "$RESULTS/rows/live.join-$2.node$1")"
    else got="$(live_query "$1" verifiable-memory "$4" "$RESULTS/rows/live.query-$2.node$1")"; fi
    [ "$got" = "$5" ] && return 0
    [ "$(now)" -lt "$deadline" ] || { echo "$got"; return 1; }
    sleep 5
  done
}

# live_node <n>: the live steps on one node. Prints why, and fails, at the first step that does not end as designed.
live_node() {
  local n="$1" body why got
  live_get "$n" before > /dev/null || { echo "reading the settings of $LIVE_CG: $(settings_read "$RESULTS/rows/live.before.node$n" refusal)"; return 1; }
  why="$(live_join_fixture "$n")" || { echo "$why"; return 1; }
  # Off: the context graph's read graphs go, and a merged request is refused as for a layer the node does not serve.
  body="$(live_body off off off)"
  why="$(live_put "$n" off "$body")" || { echo "switching it off was refused: $why"; return 1; }
  [ "$(live_layers "$n" off)" = "wm=off swm=off vm=off" ] || { echo "after off, the effective modes are $(live_layers "$n" off)"; return 1; }
  live_wait_gone "$n" gone || { echo "after off, read graphs of it were still listed after ${READY_TIMEOUT} s: $(awk '{ print "<" $3 "> (" $1 ")" }' "$RESULTS/rows/live.gone.node$n" | head -3 | paste -sd ',' -)"; return 1; }
  got="$(live_expect "$n" off vm merged "400 SEMANTICS_UNSUPPORTED")" || { echo "after off, a merged query answered $got, not 400 SEMANTICS_UNSUPPORTED"; return 1; }
  got="$(live_expect "$n" off join merged "400 SEMANTICS_UNSUPPORTED")" || { echo "after off, the merged join answered $got, not 400 SEMANTICS_UNSUPPORTED"; return 1; }
  # build: rebuilt from nothing, ready, and the full check clean.
  body="$(live_body build build build)"
  why="$(live_put "$n" build "$body")" || { echo "switching it to build was refused: $why"; return 1; }
  [ "$(live_layers "$n" build)" = "wm=build swm=build vm=build" ] || { echo "after build, the effective modes are $(live_layers "$n" build)"; return 1; }
  wait_all_ready "live-build" "$READY_TIMEOUT" "$n" || { echo "after build, not ready after ${READY_TIMEOUT} s$(unsettled "$RESULTS/rows/live-build.node$n")"; return 1; }
  [ -n "$(live_graphs "$RESULTS/rows/live-build.node$n")" ] || { echo "after build, status lists no read graph of it"; return 1; }
  full_checks "live-build" "$n" || { echo "after build, the full check is not clean: $(cat "$RESULTS/checks/live-build.failed")"; return 1; }
  got="$(live_expect "$n" build join merged "400 SEMANTICS_UNSUPPORTED")" || { echo "in build, the merged join answered $got, not 400 SEMANTICS_UNSUPPORTED"; return 1; }
  # serve for working memory and verifiable memory: the merged join returns the joined row, the per-asset one none.
  body="$(live_body serve - serve)"
  why="$(live_put "$n" serve "$body")" || { echo "switching working and verifiable memory to serve was refused: $why"; return 1; }
  [ "$(live_layers "$n" serve)" = "wm=serve swm=build vm=serve" ] || { echo "after serve, the effective modes are $(live_layers "$n" serve)"; return 1; }
  got="$(live_expect "$n" serve join merged "200 merged 1" 60)" || { echo "in serve, the merged join answered $got, not the joined row (200 merged 1)"; return 1; }
  got="$(live_expect "$n" serve-per-asset join per-asset "200 per-asset 0")" || { echo "in serve, the per-asset join answered $got, not 200 per-asset 0"; return 1; }
  got="$(live_expect "$n" serve vm merged "200 merged" 60)" || { echo "in serve, a merged query on verifiable memory answered $got, not 200 merged"; return 1; }
  # The context graph's default view semantics: followed by a request that names none, and removed again.
  body="$(live_body - - - merged)"
  why="$(live_put "$n" default "$body")" || { echo "setting the default semantics was refused: $why"; return 1; }
  got="$(live_expect "$n" default join "" "200 merged 1")" || { echo "with the default merged, the join naming no semantics answered $got, not the joined row"; return 1; }
  body="$(live_body - - - null)"
  why="$(live_put "$n" no-default "$body")" || { echo "removing the default semantics was refused: $why"; return 1; }
  got="$(live_expect "$n" no-default join "" "200 per-asset 0")" || { echo "with the default removed, the join naming no semantics answered $got, not 200 per-asset 0"; return 1; }
  return 0
}

# live_under_load: on LOAD_NODE, switch the live context graph's layers between build and serve while the node's own
# agent writes drafts into it; every acknowledged write must be there after it, its read graphs ready, and the full
# check clean. The switches count as under load only when writes were acknowledged between every two of them (each
# write and each switch is timed): otherwise INCONCLUSIVE (exit 3). Prints the outcome ("<n switches> <m acknowledged
# writes, k of them between the first and last switch>") or why, and fails.
live_under_load() {
  local n="$LOAD_NODE" acked="$RESULTS/live-load.acked" switched="$RESULTS/live-load.switched" writer step switches=0
  local i t body why refused="" wrong="" missing="" id gaps during want got expect
  # The modes the switches start from, as live_node leaves them.
  local wm=serve swm=build vm=serve
  : > "$acked"; : > "$switched"
  (
    export DKG_API_MAXTIME=15
    for i in $(seq 1 60); do
      id="live-$RUN_SLUG-$i"
      body="{\"contextGraphId\":\"$LIVE_CG\",\"name\":\"$id\"}"
      api "$n" POST /api/knowledge-assets "$body" > /dev/null 2>&1 || true
      body="{\"contextGraphId\":\"$LIVE_CG\",\"quads\":[{\"subject\":\"urn:read-graphs-live:$RUN_SLUG:$i\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"live $i\\\"\"}]}"
      # Each acknowledged write with the second it was acknowledged in.
      case "$(code_of "$(api "$n" POST "/api/knowledge-assets/$id/wm/write" "$body")")" in 2??) echo "$i $(date +%s)" >> "$acked" ;; esac
      sleep 0.3
    done
  ) &
  writer=$!
  echo "$writer" > "$RESULTS/live-load.writer"
  # Each step: wm, swm, vm ("-" keeps a layer as it is). The last leaves working memory in serve for the restart.
  for step in "serve serve -" "build build -" "serve - -" "build - -" "serve serve -" "serve build -"; do
    sleep 3
    switches=$((switches + 1))
    # shellcheck disable=SC2086 # the step is three words
    set -- $step
    [ "$1" = - ] || wm="$1"; [ "$2" = - ] || swm="$2"; [ "$3" = - ] || vm="$3"
    # shellcheck disable=SC2086
    body="$(live_body $step)"
    if ! why="$(live_put "$n" "load-$switches" "$body")"; then
      refused="$refused; switch $switches ($step): $why"; echo "$switches $(date +%s)" >> "$switched"; continue
    fi
    echo "$switches $(date +%s)" >> "$switched"
    # The switch must have taken effect while the writes go on: the modes it asked for, and the merged join answered
    # where working memory is served and refused where it is not.
    want="wm=$wm swm=$swm vm=$vm"; got="$(live_layers "$n" "load-$switches")"
    [ "$got" = "$want" ] || { wrong="$wrong; switch $switches ($step): the effective modes are $got, not $want"; continue; }
    if [ "$wm" = serve ]; then expect="200 merged 1"; else expect="400 SEMANTICS_UNSUPPORTED"; fi
    got="$(live_expect "$n" "load-$switches" join merged "$expect" 30)" || wrong="$wrong; switch $switches ($step): the merged join answered $got, not $expect"
  done
  wait "$writer" 2>/dev/null; rm -f "$RESULTS/live-load.writer"
  [ -z "$refused" ] || { echo "switches under write load were refused${refused}"; return 1; }
  [ -z "$wrong" ] || { echo "switches under write load did not take effect${wrong}"; return 1; }
  # Writes acknowledged between every two switches, or the switches were not under load.
  gaps="$(awk 'NR == FNR { at[$1] = $2; last = $1; next } { done_at[++w] = $2 }
    END { for (k = 1; k < last; k++) { c = 0; for (j = 1; j <= w; j++) if (done_at[j] >= at[k] && done_at[j] <= at[k + 1]) c++; if (c == 0) printf " %d-%d", k, k + 1 } }' "$switched" "$acked")"
  during="$(awk 'NR == FNR { if (FNR == 1) first = $2; final = $2; next } $2 >= first && $2 <= final { c++ } END { print c + 0 }' "$switched" "$acked")"
  [ -z "$gaps" ] || { echo "no write was acknowledged between switches$gaps ($(acked_count "$acked") acknowledged in all), so those switches were not under load"; return 3; }
  wait_all_ready "live-load" "$READY_TIMEOUT" "$n" || { echo "after the switches, not ready after ${READY_TIMEOUT} s$(unsettled "$RESULTS/rows/live-load.node$n")"; return 1; }
  full_checks "live-load" "$n" || { echo "after the switches, the full check is not clean: $(cat "$RESULTS/checks/live-load.failed")"; return 1; }
  why="$(query_rows "$RESULTS/rows/live-load.readback" "$n" "$LIVE_CG" working-memory "SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }" s name)" \
    || { echo "the drafts could not be read back: $why"; return 1; }
  # Each acknowledged draft as written: its subject with its name, one row of the readback (as query_rows prints it).
  while read -r i t; do
    grep -qxF "[\"urn:read-graphs-live:$RUN_SLUG:$i\",\"live $i\"]" "$RESULTS/rows/live-load.readback" || missing="$missing $i"
  done < "$acked"
  [ -z "$missing" ] || { echo "acknowledged writes missing or changed after the switches (subject and name compared):$(echo "$missing" | cut -c1-120)"; return 1; }
  printf '%s %s %s' "$switches" "$(acked_count "$acked")" "$during"
}

# shared_memory_wait <n> <since>: wait, at most SWM_READY_TIMEOUT seconds, until node <n> reads the live context
# graph's shared memory, that is until a bounded query of its shared working memory answers 200. A restarted node
# refuses those reads until it has accepted the graph's RFC-64 authority again, which on a devnet takes from about
# half a minute to more than a minute after its daemon starts. Prints the seconds since <since> (a now() time), then
# the last HTTP code and error code when it was not 200. Returns 0 once the node reads it, 1 at the bound or when the
# route refuses the request itself (400), and 2 when the node has no bounded query route (404), so there is nothing
# to wait on.
shared_memory_wait() {
  local n="$1" since="$2" body answer code deadline
  # A pattern that matches nothing: once the node admits the read, the route answers 200 with no row, however many
  # shared-memory graphs the context graph holds and on any store; the refusal comes before the query runs. A LIMIT
  # inside the pattern would not do: the view wraps the pattern in its graph scope, where a LIMIT applies per graph.
  body="$(node -e 'process.stdout.write(JSON.stringify({ version: 1, contextGraphId: process.argv[1], view: "shared-working-memory", sparql: "SELECT ?s WHERE { ?s <urn:read-graphs-run:shared-memory-probe> ?o }", maxRows: 1 }))' "$LIVE_CG")"
  deadline=$(( $(now) + SWM_READY_TIMEOUT ))
  while :; do
    answer="$(api "$n" POST /api/query/bounded "$body")"
    code="$(code_of "$answer")"
    printf '%s\n' "$answer" > "$RESULTS/rows/live.swm-ready.node$n"
    case "$code" in
      200) echo "$(( $(now) - since ))"; return 0 ;;
      400) echo "$(( $(now) - since )) $code $(field "$(body_of "$answer")" code)"; return 1 ;;
      404) echo "$(( $(now) - since )) $code"; return 2 ;;
    esac
    [ "$(now)" -lt "$deadline" ] || { echo "$(( $(now) - since )) $code $(field "$(body_of "$answer")" code)"; return 1; }
    sleep 2
  done
}

# live_restart: restart LOAD_NODE; its settings for the live context graph must hold, and the merged join and
# verifiable memory be served again without being set again. Then wait until the node reads the context graph's
# shared memory again, so the next phase does not start inside the restarted node's wait for the graph's authority.
# On success it prints the seconds from the restart to that, or nothing when the node cannot be asked.
live_restart() {
  local n="$LOAD_NODE" before after got worker_before worker_after since waited
  live_get "$n" pre-restart > /dev/null || { echo "reading the settings before the restart: $(settings_read "$RESULTS/rows/live.pre-restart.node$n" refusal)"; return 1; }
  before="$(settings_read "$RESULTS/rows/live.pre-restart.node$n" rows "$LIVE_CG")"
  # The restart counts only when another daemon worker answers afterwards (restart_node only waits for the API).
  worker_before="$(daemon_worker_pid "$n")"
  [ -n "$worker_before" ] || { echo "node$n's daemon.pid names no running daemon worker, so a restart could not be proven"; return 3; }
  since="$(now)"
  restart_node "$n" || { echo "node$n did not come back after the restart"; return 1; }
  worker_after="$(daemon_worker_pid "$n")"
  [ -n "$worker_after" ] && [ "$worker_after" != "$worker_before" ] \
    || { echo "the daemon was not replaced: its worker was PID $worker_before before the restart and ${worker_after:-none} after"; return 1; }
  live_get "$n" post-restart > /dev/null || { echo "reading the settings after the restart: $(settings_read "$RESULTS/rows/live.post-restart.node$n" refusal)"; return 1; }
  after="$(settings_read "$RESULTS/rows/live.post-restart.node$n" rows "$LIVE_CG")"
  [ "$after" = "$before" ] || { echo "the settings changed across the restart: $before before, $after after"; return 1; }
  wait_all_ready "live-restart" "$READY_TIMEOUT" "$n" || { echo "after the restart, not ready after ${READY_TIMEOUT} s$(unsettled "$RESULTS/rows/live-restart.node$n")"; return 1; }
  got="$(live_expect "$n" restart join merged "200 merged 1" 60)" || { echo "after the restart, the merged join answered $got, not the joined row (200 merged 1)"; return 1; }
  got="$(live_expect "$n" restart-per-asset join per-asset "200 per-asset 0")" || { echo "after the restart, the per-asset join answered $got, not 200 per-asset 0"; return 1; }
  got="$(live_expect "$n" restart vm merged "200 merged" 60)" || { echo "after the restart, a merged query on verifiable memory answered $got, not 200 merged"; return 1; }
  waited="$(shared_memory_wait "$n" "$since")"
  case $? in
    0) note "live: node$n read $LIVE_CG's shared memory again $waited s after its restart began"; echo "$waited" ;;
    2) note "live: node$n has no bounded query route, so the phase did not wait for it to read $LIVE_CG's shared memory again after the restart" ;;
    *) set -- $waited
       echo "node$n did not read $LIVE_CG's shared memory again within ${SWM_READY_TIMEOUT} s of the checks after its restart ($1 s after the restart began; last answer HTTP ${2:-?}${3:+ $3})"
       return 3 ;;
  esac
}

phase_live() {
  local started n why outcome rc holders="" swm_ready=""
  started="$(now)"
  # Without the settings API (READ_GRAPHS_SWITCH=auto on a daemon that has none, or =config) the phase does not apply:
  # N/A, neither a failure nor a gap. READ_GRAPHS_SWITCH=api, as the bar for live settings uses it, stops the run instead.
  [ "$SWITCH" = api ] || { record live N/A 0 "not run: no per-context-graph settings API in use (see Notes); READ_GRAPHS_SWITCH=api requires it"; return; }
  # The nodes that hold the live context graph; the others have nothing of it to switch.
  for n in $NODES; do
    if holds_live_cg "$n"; then holders="$holders $n"; else note "live: node$n does not subscribe to $LIVE_CG, so it is not switched there"; fi
  done
  holders="${holders# }"
  [ -n "$holders" ] || { record live INCONCLUSIVE 0 "no node subscribes to $LIVE_CG (READ_GRAPHS_LIVE_CG)"; return; }
  case " $holders " in *" $LOAD_NODE "*) ;; *) record live INCONCLUSIVE 0 "the write-load node node$LOAD_NODE does not hold $LIVE_CG or is not part of the run"; return ;; esac
  for n in $holders; do
    why="$(live_node "$n")" || { record live FAIL "$(( $(now) - started ))" "node$n, $LIVE_CG: $why"; return; }
  done
  outcome="$(live_under_load)"; rc=$?
  case "$rc" in
    0) ;;
    3) record live INCONCLUSIVE "$(( $(now) - started ))" "node$LOAD_NODE, $LIVE_CG under write load: $outcome"; return ;;
    *) record live FAIL "$(( $(now) - started ))" "node$LOAD_NODE, $LIVE_CG under write load: $outcome"; return ;;
  esac
  why="$(live_restart)"; rc=$?
  case "$rc" in
    0) ;;
    3) record live INCONCLUSIVE "$(( $(now) - started ))" "node$LOAD_NODE, $LIVE_CG across a restart: $why"; return ;;
    *) record live FAIL "$(( $(now) - started ))" "node$LOAD_NODE, $LIVE_CG across a restart: $why"; return ;;
  esac
  [ -z "$why" ] || swm_ready=", and the node read its shared memory again $why s after the restart began"
  set -- $outcome
  record live PASS "$(( $(now) - started ))" "$LIVE_CG through the settings API on nodes $holders: off dropped its read graphs; build rebuilt them with a clean full check; serve answered a join across two working-memory drafts with the joined row when merged and none per asset, and merged queries on verifiable memory; the default semantics was followed and removed. On node$LOAD_NODE: $1 switches between build and serve, each taking effect while the writes went on (its modes, and the merged join answered or refused accordingly), with writes acknowledged between every two ($3 of $2 acknowledged drafts between the first and last switch), every draft there afterwards as written and a clean full check; after a restart, with another daemon worker answering, the settings held and the join was answered across assets again$swm_ready"
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

phase_gate() {
  local n w watchers="" since
  mkdir -p "$RESULTS/gate"
  # A check that finds a mismatch marks the read graph dirty and the builder rebuilds it, so the full check at the end
  # can be clean although write maintenance failed during the workload. Every mismatch a check logs is kept.
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  for n in $NODES; do
    : > "$RESULTS/gate/mismatches.node$n"; : > "$RESULTS/gate/lost.node$n"; : > "$RESULTS/gate/watcher.node$n.stopped"
    w="$(watch_mismatches "$n" "$RESULTS/gate/mismatches.node$n" "$RESULTS/gate/lost.node$n" "$since" "$(log_position "$n")" \
      "$RESULTS/gate/watcher.node$n.stopped")"
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
    kill -0 "$(cat "$RESULTS/gate/watcher.node$n" 2>/dev/null)" 2>/dev/null \
      || unwatched="$unwatched node$n (its log watcher stopped$(head -1 "$RESULTS/gate/watcher.node$n.stopped" 2>/dev/null | cut -c1-200 | sed 's/^/: /'))"
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

# shared_read_graph <context graph>: the IRI of its shared-memory read graph, by the build's own rules.
shared_read_graph() {
  CORE_MODULE="$CORE_MODULE" CG="$1" node --input-type=module -e '
    const core = await import(process.env.CORE_MODULE);
    console.log(core.readGraphIri({ scope: core.readScope(process.env.CG), layer: core.MemoryLayer.SharedWorkingMemory }));'
}
# build_ms <n> <read graph> [since]: how long node <n>'s last build of that read graph took, in ms, from its
# daemon.log; with <since> (the log's local "YYYY-MM-DD HH:MM:SS"), only a build logged from then on.
build_ms() {
  grep -F "Built read graph $2 in " "$DEVNET_DIR/node$1/daemon.log" 2>/dev/null | awk -v s="${3:-}" 'substr($0, 1, 19) >= s' \
    | tail -1 | sed -E 's/.* in ([0-9]+) ms.*/\1/'
}

drill_restart_during_rebuild() {
  local n="$RESTART_NODE" started cg graph why seeded since rebuilt caught="" i gen_before gen_after
  started="$(now)"
  # The read graphs a devnet holds are rebuilt in tens of milliseconds, far quicker than a restart takes to stop the
  # daemon. So the drill builds its own: a context graph on the drill node whose shared memory takes seconds to copy
  # (about 100,000 triples a second: 100,000 took 1,045 ms in 12 batches on the devnet).
  cg="read-graphs-restart-$RUN_SLUG"
  graph="$(shared_read_graph "$cg")" && [ -n "$graph" ] \
    || { record drill-restart INCONCLUSIVE 0 "the shared-memory read graph of $cg could not be named by the build's rules"; return; }
  why="$(restart_drill_graph "$n" "$cg")" \
    || { record drill-restart INCONCLUSIVE "$(( $(now) - started ))" "node$n could not hold the drill's own context graph $cg: $why"; return; }
  seeded=$(( $(now) - started ))
  wait_read_graph_ready "$n" "$graph" "$READY_TIMEOUT" "$RESULTS/rows/restart.seeded.node$n" \
    || { record drill-restart INCONCLUSIVE "$(( $(now) - started ))" "node$n did not list <$graph> ready after the drill shared $RESTART_TRIPLES triples into it"; return; }
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  read_graph_rebuild "$n" "$cg" || { record drill-restart FAIL "$(( $(now) - started ))" "rebuild refused on node$n (cli.log)"; return; }
  # `rebuild` marks the read graph dirty; the builder's next pass rebuilds it. Restart while it is being rebuilt.
  for i in $(seq 1 300); do
    read_graph_rows "$n" > "$RESULTS/rows/restart.caught.node$n" 2>/dev/null || true
    if awk -v g="$graph" '$3 == g && ($1 == "rebuilding" || $1 == "building") { found = 1 } END { exit !found }' "$RESULTS/rows/restart.caught.node$n"; then
      caught=1; break
    fi
    sleep 0.2
  done
  [ -n "$caught" ] || { record drill-restart INCONCLUSIVE "$(( $(now) - started ))" "<$graph> was not seen being rebuilt on node$n (that rebuild took $(build_ms "$n" "$graph" "$since") ms)"; return; }
  gen_before="$(generation_of "$RESULTS/rows/restart.caught.node$n" "$graph")"
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  restart_node "$n" || { record drill-restart FAIL "$(( $(now) - started ))" "node$n did not come back"; return; }
  if ! wait_all_ready drill-restart "$READY_TIMEOUT" "$n"; then record drill-restart FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the restart"; return; fi
  # A read graph the restart caught being built gets a new generation at start. One whose rebuild ended in the moment
  # before the daemon stopped keeps its generation: that is fine, but proves nothing.
  gen_after="$(generation_of "$RESULTS/rows/drill-restart.node$n" "$graph")"
  [ -n "$gen_after" ] || { record drill-restart FAIL "$(( $(now) - started ))" "<$graph> was gone after the restart"; return; }
  [ "$gen_after" != "$gen_before" ] \
    || { record drill-restart INCONCLUSIVE "$(( $(now) - started ))" "the rebuild of <$graph> ended before the restart stopped the daemon (it took $(build_ms "$n" "$graph") ms; READ_GRAPHS_DRILL_RESTART_TRIPLES makes it longer)"; return; }
  # The rebuild after the start, as the daemon logs it once the read graph is ready again.
  for i in $(seq 1 10); do rebuilt="$(build_ms "$n" "$graph" "$since")"; [ -n "$rebuilt" ] && break; sleep 1; done
  drill_end drill-restart "$n" "$started" "the restart caught the drill's own shared-memory read graph <$graph> ($RESTART_TRIPLES triples, shared in $seeded s) being rebuilt; it got a new generation at the start and was rebuilt after it in ${rebuilt:-?} ms"
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
stop_writer() { kill_tree "$1"; wait "$1" 2>/dev/null; rm -f "$RESULTS/drill-kill.writer"; stop_load; }
# stop_load: stop the kill drill's load writer, by its PID, when it runs.
stop_load() {
  local l
  l="$(cat "$RESULTS/drill-kill.load" 2>/dev/null)"
  [ -n "$l" ] || return 0
  kill_tree "$l"; wait "$l" 2>/dev/null; rm -f "$RESULTS/drill-kill.load"
}
# drill_write_template <context graph> <subject prefix>: the JSON body of a kill-drill write, KILL_WRITE_TRIPLES triples
# on the subject <prefix>:@I@ (its name "drill @I@", then values), @I@ standing for the write's number.
drill_write_template() {
  node -e '
    const [contextGraphId, prefix, count] = [process.argv[1], process.argv[2], Number(process.argv[3])];
    const subject = `${prefix}:@I@`;
    const quads = [{ subject, predicate: "http://schema.org/name", object: "\"drill @I@\"" },
      ...Array.from({ length: Math.max(0, count - 1) }, (_, j) => ({ subject, predicate: "http://schema.org/value", object: `"@I@.${j}"` }))];
    process.stdout.write(JSON.stringify({ contextGraphId, quads }));' "$1" "$2" "$KILL_WRITE_TRIPLES"
}
# aim_kill <inflight> <answers> <acked> <acked copy> <pid> <fraction> <after> <timeout s>: wait for a kill-drill write
# after write <after> to start (its number appears in <inflight>); once it has run <fraction> of the median time of the
# writes acknowledged so far (curl's time_total in <answers>), and while it is still in flight, copy <acked> to
# <acked copy> and send SIGKILL to <pid>. A write answered before its aim is passed over for the next one. Prints
# "<write> <answers lines before the kill> <median ms>"; prints nothing when no write could be aimed at in time.
aim_kill() {
  node -e '
    const fs = require("fs");
    const [inflight, answers, acked, ackedCopy, pid, fraction, after, timeout] = process.argv.slice(1);
    const current = () => { try { return fs.readFileSync(inflight, "utf8").trim(); } catch { return ""; } };
    const median = () => {
      const times = [];
      for (const line of fs.readFileSync(answers, "utf8").split("\n")) {
        const m = /^write \d+ rc=0 code=2\d\d .* time=(\d+(?:\.\d+)?)$/.exec(line);
        if (m) times.push(Number(m[1]) * 1000);
      }
      times.sort((a, b) => a - b);
      return times.length >= 3 ? times[Math.floor(times.length / 2)] : undefined;
    };
    const deadline = Date.now() + Number(timeout) * 1000;
    let seen = current(), aim;
    const tick = () => {
      if (Date.now() > deadline) process.exit(0);
      const now = current();
      if (now !== seen) {
        seen = now;
        const m = /^\d+$/.test(now) && Number(now) > Number(after) ? median() : undefined;
        aim = m === undefined ? undefined : { at: Date.now() + Number(fraction) * m, median: m };
      }
      if (aim && Date.now() >= aim.at) {
        if (current() === seen) {
          const lines = fs.readFileSync(answers, "utf8").split("\n").filter(Boolean).length;
          fs.copyFileSync(acked, ackedCopy);
          try { process.kill(Number(pid), "SIGKILL"); } catch { process.exit(0); }
          console.log(`${seen} ${lines} ${Math.round(aim.median)}`);
          process.exit(0);
        }
        aim = undefined;
      }
      setTimeout(tick, 1);
    };
    tick();
  ' "$@"
}
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
# drill_writes_incomplete <acked> <counts> <values>: the drill writes listed in <acked> whose subject does not hold
# <values> values in <counts> (query_rows of ?s ?values), comma-separated; nothing when each holds them all.
drill_writes_incomplete() {
  node -e '
    const fs = require("fs");
    const counts = new Map();
    for (const line of fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean)) {
      const [s, values] = JSON.parse(line);
      counts.set(s, Number(values));
    }
    const problems = [];
    for (const i of fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
      const got = counts.get(`urn:read-graphs-drill:${i}`) ?? 0;
      if (got !== Number(process.argv[3])) problems.push(`${i} holds ${got} of ${process.argv[3]} values`);
    }
    process.stdout.write(problems.slice(0, 10).join(", ") + (problems.length > 10 ? `, and ${problems.length - 10} more` : ""));' "$1" "$2" "$3"
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
  local attempt last_write kill_line why readback template bodyfile incomplete load load_cg load_template load_body
  local fraction fractions aimed median
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
  # The writer marks each working-memory write in flight in $inflight, logs every outcome in $answers in order, with
  # curl's time for it, and records each acknowledged (HTTP 2xx) write in $acked. It sends the write with curl itself,
  # so the outcome says what the daemon had: exit 52 or 56 with the whole body uploaded means the worker took the
  # request and its connection was dropped unanswered; exit 7 means the request never reached it; exit 0 means it was
  # answered. After a write that was not acknowledged it waits a moment, so a restarting node does not use up its
  # writes. Each write is KILL_WRITE_TRIPLES triples on its own subject: its name, which the readback reads, and values
  # that make it heavier to store. Its body goes through a file. It stops after KILL_WRITER_SECONDS or 3,000 writes.
  inflight="$RESULTS/drill-kill.inflight"; answers="$RESULTS/drill-kill.answers"; : > "$inflight"; : > "$answers"
  template="$RESULTS/drill-kill.body-template"; bodyfile="$RESULTS/drill-kill.body"
  load_cg="$cg-load"; load_template="$RESULTS/drill-kill.load-template"; load_body="$RESULTS/drill-kill.load-body"
  drill_write_template "$cg" "urn:read-graphs-drill" > "$template" \
    && drill_write_template "$load_cg" "urn:read-graphs-drill-load" > "$load_template" \
    || { record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "the drill's write bodies could not be written"; return; }
  body="{\"id\":\"$load_cg\",\"name\":\"Read-graph drill load\"}"
  resp="$(api "$n" POST /api/context-graph/create "$body")"
  case "$(code_of "$resp")" in
    200|201|409) ;;
    *) record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "could not create the load's context graph $load_cg on node$n (HTTP $(code_of "$resp"))"; return ;;
  esac
  # The load: a second writer on a context graph of its own, as the gate's suites load a node, so the worker is busy and
  # a write's answer can lag its store write (on an idle node a write is answered within milliseconds of it). It starts
  # before the drill's writer and is stopped with it, by PID, whatever the outcome (stop_writer); the checks read only
  # the drill's own context graph.
  : > "$RESULTS/drill-kill.load-writes"
  (
    export DKG_API_MAXTIME=15
    j=0; until_s=$(( $(now) + KILL_WRITER_SECONDS ))
    while [ "$j" -lt 3000 ] && [ "$(now)" -lt "$until_s" ]; do
      j=$((j + 1))
      api "$n" POST /api/knowledge-assets "{\"contextGraphId\":\"$load_cg\",\"name\":\"load-$j\"}" > /dev/null 2>&1 || true
      sed "s/@I@/$j/g" "$load_template" > "$load_body"
      code="$(curl -sS --max-time 15 --connect-timeout 5 -o /dev/null -w '%{http_code}' -X POST \
        -H "Authorization: Bearer $(node_token "$n")" -H 'Content-Type: application/json' --data-binary "@$load_body" \
        "http://127.0.0.1:$(node_port "$n")/api/knowledge-assets/load-$j/wm/write" 2>/dev/null)"
      echo "$j ${code:-000}" >> "$RESULTS/drill-kill.load-writes"
      case "$code" in 2??) ;; *) sleep 0.5 ;; esac
    done
  ) &
  load=$!
  echo "$load" > "$RESULTS/drill-kill.load"
  (
    export DKG_API_MAXTIME=15
    i=0; until_s=$(( $(now) + KILL_WRITER_SECONDS ))
    while [ "$i" -lt 3000 ] && [ "$(now)" -lt "$until_s" ]; do
      i=$((i + 1))
      api "$n" POST /api/knowledge-assets "{\"contextGraphId\":\"$cg\",\"name\":\"drill-$i\"}" > /dev/null 2>&1 || true
      sed "s/@I@/$i/g" "$template" > "$bodyfile"
      size="$(wc -c < "$bodyfile" | tr -d ' ')"
      echo "$i" > "$inflight"
      out="$(curl -sS --max-time 15 --connect-timeout 5 -o /dev/null -w '%{http_code} %{size_upload} %{time_total}' -X POST \
        -H "Authorization: Bearer $(node_token "$n")" -H 'Content-Type: application/json' --data-binary "@$bodyfile" \
        "http://127.0.0.1:$(node_port "$n")/api/knowledge-assets/drill-$i/wm/write" 2>/dev/null)"; rc=$?
      set -- $out
      echo "write $i rc=$rc code=${1:-000} sent=${2:-0} of $size time=${3:-0}" >> "$answers"
      : > "$inflight"
      case "${1:-000}" in 2??) echo "$i" >> "$acked" ;; *) sleep 0.5 ;; esac
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
  overlap=""; attempt=0; last_write=0; fractions="0.60 0.75 0.85 0.92 0.97"
  while [ -z "$overlap" ] && [ "$attempt" -lt 10 ]; do
    attempt=$((attempt + 1))
    # Aim the kill late in a write: once three writes were acknowledged, at a share of the median time they took
    # (curl's time_total), swept from 60 % to 97 % over the five crashes of a round. The worker is resolved first, so
    # the kill follows the aim at once.
    fraction="$(echo "$fractions" | cut -d' ' -f$(( (attempt - 1) % 5 + 1 )))"
    for i in $(seq 1 600); do
      [ "$(acked_count "$acked")" -ge 3 ] && break
      kill -0 "$writer" 2>/dev/null || break
      sleep 0.1
    done
    pid="$(daemon_worker_pid "$n")"
    if [ -z "$pid" ]; then
      stop_writer "$writer"
      record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "node$n's daemon.pid named no running daemon worker before crash $attempt"; return
    fi
    aimed="$(aim_kill "$inflight" "$answers" "$acked" "$RESULTS/drill-kill.acked-crash$attempt" "$pid" "$fraction" "$last_write" 60)"
    if [ -z "$aimed" ]; then
      stop_writer "$writer"
      record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "no working-memory write could be aimed at within a minute after three were acknowledged ($(acked_count "$acked") acknowledged; crash $attempt), so no kill landed during one"
      return
    fi
    # The crash must happen: SIGKILL delivered to the daemon worker, that worker gone, and a new worker in its place
    # before anything is checked. A daemon that answered throughout would prove nothing. The evidence must come after
    # the answers line taken before the kill: an outcome the kill caused can be logged at once; the writes acknowledged
    # so far must all be there after this crash.
    read -r inflight_write kill_line median <<EOF_AIMED
$aimed
EOF_AIMED
    last_write="$inflight_write"
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
    # The supervisor starts a new worker, but not after its fifth crash in a run: then a full stop and start of the
    # node, which also begins a second round of five crashes. Otherwise the node is restarted if no worker comes.
    if [ $(( attempt % 5 )) = 0 ]; then
      note "drill-kill: crash $attempt is the supervisor's fifth in this run; node$n restarted${overlap:+ }"
      restart_node "$n"
    else
      wait_up "$n" 120 || restart_node "$n"
    fi || { stop_writer "$writer"; record drill-kill FAIL "$(( $(now) - started ))" "node$n did not come back after the kill"; return; }
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
    record drill-kill INCONCLUSIVE "$(( $(now) - started ))" "none of $attempt crashes landed on a working-memory write the worker had begun to store, though each was aimed late in a write, with a second writer loading the node (drill-kill.answers, notes.md), so no kill is known to have interrupted a write"; return
  fi
  # Every write the node acknowledged, before the crashes and after them, must be there with the value it wrote.
  why="$(query_rows "$RESULTS/rows/drill-kill.after" "$n" "$cg" working-memory "$readback" s name)" \
    || { record drill-kill FAIL "$(( $(now) - started ))" "the acknowledged writes could not be read back after the kill ($why)"; return; }
  missing="$(drill_writes_missing "$acked" "$RESULTS/rows/drill-kill.after")"
  [ -z "$missing" ] || { record drill-kill FAIL "$(( $(now) - started ))" "acknowledged writes are not there as written after the kill: $missing"; return; }
  # Their values too: each acknowledged write holds all KILL_WRITE_TRIPLES - 1 of them. (A write held at a crash and
  # never answered may be there in part; only what was acknowledged must be whole.)
  if [ "$KILL_WRITE_TRIPLES" -gt 1 ]; then
    why="$(query_rows "$RESULTS/rows/drill-kill.values" "$n" "$cg" working-memory \
      "SELECT ?s (COUNT(?v) AS ?values) WHERE { ?s <http://schema.org/value> ?v } GROUP BY ?s" s values)" \
      || { record drill-kill FAIL "$(( $(now) - started ))" "the values of the acknowledged writes could not be counted after the kill ($why)"; return; }
    incomplete="$(drill_writes_incomplete "$acked" "$RESULTS/rows/drill-kill.values" "$((KILL_WRITE_TRIPLES - 1))")"
    [ -z "$incomplete" ] || { record drill-kill FAIL "$(( $(now) - started ))" "acknowledged writes are there only in part after the kill: $incomplete"; return; }
  fi
  # The read graph those writes maintain must be there and ready; drill_end then checks it with the rest.
  wait_read_graph_ready "$n" "$wm_graph" "$READY_TIMEOUT" "$RESULTS/rows/drill-kill.wm.node$n" \
    || { record drill-kill FAIL "$(( $(now) - started ))" "the working-memory read graph <$wm_graph> was not listed ready after the kill"; return; }
  drill_end drill-kill "$n" "$started" "killed node$n's daemon worker while it held working-memory write $inflight_write: its whole request was uploaded and its connection dropped unanswered ($overlap), and its data was there after the restart, so the worker had begun to store it (crash $attempt of at most 10, in two rounds of five; aimed at ${fraction} of the median write time, ${median} ms, with a second writer loading the node: $(wc -l < "$RESULTS/drill-kill.load-writes" | tr -d ' ') writes into $load_cg); a new worker took over; all $(acked_count "$acked") acknowledged writes were there after it with the values written, and their read graph was rebuilt and consistent"
}

# finalized_jobs <n>: the node's count of finalized publish jobs, or "" when it cannot be read.
finalized_jobs() {
  dkg_cli "$1" publisher stats 2>/dev/null | node -e '
    let d = ""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => {
      try { const value = JSON.parse(d).finalized; if (Number.isSafeInteger(value)) process.stdout.write(String(value)); } catch {}
    });'
}
# connect_all <n>: node <n> dials every other node of the run (POST /api/connect with its .devnet/nodeK/multiaddr). A
# node that did not restart does not dial a restarted node again by itself, and a publish needs the Cores' ACKs.
connect_all() {
  local k addr body
  for k in $NODES; do
    [ "$k" != "$1" ] || continue
    addr="$(head -1 "$DEVNET_DIR/node$k/multiaddr" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$addr" ] || continue
    body="{\"multiaddr\":\"$addr\"}"
    api "$1" POST /api/connect "$body" > /dev/null 2>&1 || true
  done
}
# publish_finalized <n> <context graph> <name> <subject> <value>: node <n> writes knowledge asset <name> into the
# context graph (one triple, <subject> schema:name "<value>"), shares it to shared memory, and publishes it to
# verifiable memory through the async publisher; it waits up to PUBLISH_TIMEOUT s for the job to be finalized, also
# through a failure the publisher retries by itself. The node first dials every other node (connect_all). Prints the
# job ID; prints why and fails when a step is refused, the job fails for good, or it does not finalize in time.
publish_finalized() {
  local n="$1" cg="$2" name="$3" body resp job answer status="" deadline
  connect_all "$n"
  body="$(node -e '
    const [contextGraphId, name, subject, value] = process.argv.slice(1);
    const quads = [{ subject, predicate: "http://schema.org/name", object: JSON.stringify(value), graph: "" }];
    console.log(JSON.stringify({ contextGraphId, name, quads, finalize: true, alsoShareSwm: true }));
  ' "$cg" "$name" "$4" "$5")"
  resp="$(api "$n" POST /api/knowledge-assets "$body")"
  case "$(code_of "$resp")" in 2??) ;; *) echo "writing $name: HTTP $(code_of "$resp") $(body_of "$resp" | head -c 200)"; return 1 ;; esac
  shared_ok "$(body_of "$resp")" || { echo "$name was not shared: $(body_of "$resp" | head -c 200)"; return 1; }
  body="{\"contextGraphId\":\"$cg\"}"
  resp="$(api "$n" POST "/api/knowledge-assets/$name/vm/publish-async" "$body")"
  case "$(code_of "$resp")" in 2??) ;; *) echo "publish-async of $name: HTTP $(code_of "$resp") $(body_of "$resp" | head -c 200)"; return 1 ;; esac
  job="$(field "$(body_of "$resp")" jobId)"
  [ -n "$job" ] || { echo "publish-async of $name answered no job ID: $(body_of "$resp" | head -c 200)"; return 1; }
  deadline=$(( $(now) + PUBLISH_TIMEOUT ))
  while :; do
    answer="$(body_of "$(api "$n" GET "/api/publisher/job?id=$job")")"
    status="$(field "$answer" job.status)"
    case "$status" in
      finalized) echo "$job"; return 0 ;;
      failed)
        # A retryable failure (an ACK quorum not reached yet, say) goes back to the queue after its backoff.
        [ "$(field "$answer" job.failure.retryable)" = true ] && [ "$(field "$answer" retryState.autoRetryEligible)" = true ] \
          || { echo "publish job $job of $name failed: $(field "$answer" job.failure.message | head -c 300)"; return 1; }
        status="failed, to be retried ($(field "$answer" job.failure.code))" ;;
    esac
    [ "$(now)" -lt "$deadline" ] || { echo "publish job $job of $name was still ${status:-unreadable} after $PUBLISH_TIMEOUT s"; return 1; }
    sleep 3
  done
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
  local n="$CLI_NODE" job started before after output rc cleared renewed count state gen graph gen_after kept=0 moved="" dir="$RESULTS/rows"
  started="$(now)"
  # The offline write needs a finalized publish job to change. Neither a fresh devnet nor the gate leaves one (the
  # devnet suites clear theirs), so the drill makes its own on its node.
  job="$(publish_finalized "$n" "$LIVE_CG" "drill-cli-$RUN_SLUG" "urn:read-graphs-run:drill-cli:$RUN_SLUG" "drill cli $n")" \
    || { record drill-cli INCONCLUSIVE "$(( $(now) - started ))" "node$n could not make the drill's own finalized publish job: $job"; return; }
  before="$(finalized_jobs "$n")"
  [ -n "$before" ] && [ "$before" -gt 0 ] \
    || { record drill-cli INCONCLUSIVE "$(( $(now) - started ))" "\`dkg publisher stats\` on node$n counts ${before:-no} finalized jobs, after its job $job was finalized"; return; }
  read_graph_rows "$n" 2>/dev/null | grep -q . || { record drill-cli INCONCLUSIVE "$(( $(now) - started ))" "node$n has no read graph"; return; }
  # A store the CLI opens to write with the daemon down starts read graphs as the daemon does (createPublisherStore):
  # the read graphs the node's settings keep stay ready at their generation; every other read graph is marked dirty,
  # so the next start renews or drops it. The write here touches only the publisher's own graphs, outside every read
  # graph, so the drill shows that start, not maintenance (packages/cli/test/publisher-store.test.ts covers a write into
  # a kept read graph). A plain restart comes first, as the control: it keeps every ready shared-layer read graph at
  # its generation, so a change after the offline write comes from that write.
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
  # The node's settings do not change during the drill, so the CLI read the settings the daemon read: every read graph
  # the control kept is one they keep, and must keep its generation through the offline write. (The other half of the
  # rule, a read graph the settings do not keep being marked dirty, needs a settings change to show; that is #3900.)
  while read -r state gen graph; do
    case "$graph" in */_working_memory/*) continue ;; esac
    kept=$((kept + 1))
    gen_after="$(generation_of "$dir/drill-cli.node$n" "$graph")"
    [ "$gen_after" = "$gen" ] || moved="$moved <$graph> (generation $gen, then ${gen_after:-missing})"
  done < "$dir/drill-cli-control.node$n"
  [ -z "$moved" ] || { record drill-cli FAIL "$(( $(now) - started ))" "read graphs node$n's settings keep left their generation through the offline write, though the offline store starts them as kept:$moved"; return; }
  drill_end drill-cli "$n" "$started" "with node$n's daemon down, \`dkg publisher clear finalized\` cleared $cleared of $before jobs, which stayed cleared; the offline writable store started read graphs and left all $kept shared-layer ones, which its settings keep, at their generation; the write touches only the publisher's own graphs, so this drill does not show maintenance (covered by publisher-store.test.ts), and with the settings unchanged it cannot show a read graph marked dirty (#3900)"
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
# members_lost <before> <after> <exact|kept> [graph ...]: prints the first difference and fails, or prints nothing.
# `exact`: the same graphs with the same triples; `kept`: every graph of <before> still there, holding every triple it
# held. The graphs named after the mode are left out of the comparison.
members_lost() {
  node -e '
    const fs = require("fs");
    const [before, after] = process.argv.slice(1, 3).map((file) => JSON.parse(fs.readFileSync(file, "utf8")).graphs);
    const exact = process.argv[3] === "exact";
    const skipped = new Set(process.argv.slice(4));
    for (const [graph, triples] of Object.entries(before)) {
      if (skipped.has(graph)) continue;
      if (!(graph in after)) { console.log(`<${graph}> is gone`); process.exit(1); }
      const now = new Set(after[graph]);
      const lost = triples.find((triple) => !now.has(triple));
      if (lost) { console.log(`<${graph}> lost ${lost}`); process.exit(1); }
      if (exact && after[graph].length !== triples.length) {
        const had = new Set(triples);
        console.log(`<${graph}> gained ${after[graph].find((triple) => !had.has(triple))}`); process.exit(1);
      }
    }
    if (exact) for (const graph of Object.keys(after)) if (!(graph in before) && !skipped.has(graph)) { console.log(`<${graph}> appeared`); process.exit(1); }
  ' "$@"
}
# The agents system graph holds each daemon's own registration and liveness triples, which a daemon rewrites when it
# starts, on any release. It is not asset data, so the comparison across a daemon start leaves it out.
AGENTS_SYSTEM_GRAPH="did:dkg:context-graph:agents"

# rollback_steps <n> <endpoint> <version>: the rollback drill's changes, with node <n> stopped, its store at
# <endpoint>, and <version> the earlier release.
# It prints one line of four fields, outcome, detail, dropped and version, separated by the ASCII unit separator
# (a field may be empty): an empty outcome means every step held. The caller restores the node whatever it prints.
# asset_probe_record <n> <probe>: known assets to read through the earlier release, with what the build under test
# answers for them now. Both are required: node <n>'s seeded working-memory draft, which must hold the value written,
# and the drill's own verifiable-memory asset, which node <n> publishes now (what other verifiable memory a node holds
# depends on the suites that ran before). Each probe is a line of <probe> (what, context graph, view, query and
# variable, \037 between), and its answer is <probe>.<line number>. Prints why and returns 1 when a prerequisite is
# missing (no seeded draft on the node, the drill's asset not published), 2 when the build under test cannot read one
# of them.
asset_probe_record() {
  local n="$1" probe="$2" cg agent subject job sparql why got i
  : > "$probe"
  [ -s "$RESULTS/rows/seed-wm.node$n" ] || { echo "node$n has no seeded working-memory draft (the seed phase wrote none there)"; return 1; }
  read -r cg agent < "$RESULTS/rows/seed-wm.node$n"
  sparql="SELECT ?name WHERE { <urn:read-graphs-seed:$n> <http://schema.org/name> ?name }"
  for i in $(seq 1 15); do why="$(query_rows "$probe.1" "$n" "$cg" working-memory "$sparql" name)" && break; sleep 2; done
  [ -z "$why" ] || { echo "the build under test could not read node$n's seeded working-memory draft ($why)"; return 2; }
  if ! grep -Fxq "[\"seed $n\"]" "$probe.1"; then
    got="$(tr '\n' ' ' < "$probe.1" | sed 's/ $//')"
    echo "the build under test answered ${got:-nothing} for node$n's seeded working-memory draft, not [\"seed $n\"]"; return 2
  fi
  printf 'the seeded working-memory draft\037%s\037working-memory\037%s\037name\n' "$cg" "$sparql" >> "$probe"
  # The drill's own verifiable-memory asset: one triple, published on node <n> into the live context graph.
  subject="urn:read-graphs-run:rollback-probe:$RUN_SLUG"
  job="$(publish_finalized "$n" "$LIVE_CG" "drill-rollback-$RUN_SLUG" "$subject" "rollback probe $n")" \
    || { echo "node$n could not publish the drill's own verifiable-memory asset into $LIVE_CG: $job"; return 1; }
  sparql="SELECT ?o WHERE { <$subject> <http://schema.org/name> ?o }"
  for i in $(seq 1 15); do
    why="$(query_rows "$probe.2" "$n" "$LIVE_CG" verifiable-memory "$sparql" o)" && grep -Fxq "[\"rollback probe $n\"]" "$probe.2" && break
    sleep 2
  done
  [ -z "$why" ] || { echo "the build under test could not read the drill's own asset <$subject> in the verifiable memory of $LIVE_CG on node$n ($why)"; return 2; }
  if ! grep -Fxq "[\"rollback probe $n\"]" "$probe.2"; then
    got="$(tr '\n' ' ' < "$probe.2" | sed 's/ $//')"
    echo "the build under test answered ${got:-nothing} for the drill's own asset <$subject> in the verifiable memory of $LIVE_CG on node$n (publish job $job), not [\"rollback probe $n\"]"; return 2
  fi
  printf "the drill's own verifiable-memory asset in %s\037%s\037verifiable-memory\037%s\037o\n" "$LIVE_CG" "$LIVE_CG" "$sparql" >> "$probe"
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
  member_graphs "$endpoint" "$members_earlier" && lost="$(members_lost "$members_before" "$members_earlier" kept "$AGENTS_SYSTEM_GRAPH")" \
    || { printf 'FAIL\037%s\037%s\037%s\n' "node$n's asset data on $ROLLBACK_FROM: ${lost:-unreadable}" "$dropped" "$version"; return; }
  # Kept triples are not enough: the earlier daemon must also find and read the assets through its own query route.
  lost="$(asset_probe_check "$n" "$probe")" \
    || { printf 'FAIL\037%s\037%s\037%s\n' "on $ROLLBACK_FROM, node$n $lost" "$dropped" "$version"; return; }
  printf '\037\037%s\037%s\n' "$dropped" "$version"
}

drill_rollback_and_forward() {
  local n="$ROLLBACK_NODE" started endpoint restore result outcome detail dropped version lost rc version_dir target_version probe read_through why
  started="$(now)"; probe="$RESULTS/rows/rollback.probe.node$n"
  [ "$ROLLBACK_FROM" != none ] || { record drill-rollback INCONCLUSIVE 0 "not run (READ_GRAPHS_ROLLBACK_FROM=none)"; return; }
  endpoint="$(store_endpoint "$n")"
  [ -n "$endpoint" ] || { record drill-rollback INCONCLUSIVE 0 "node$n's store cannot be read from outside its daemon, so the rollback cannot be checked: use a node on Blazegraph or an external SPARQL endpoint"; return; }
  read_graph_rows "$n" > "$RESULTS/rows/rollback.before.node$n" && [ -s "$RESULTS/rows/rollback.before.node$n" ] \
    || { record drill-rollback INCONCLUSIVE 0 "node$n has no read graph to drop"; return; }
  # Known assets to read through the earlier release, as the build under test answers them now: both are required.
  why="$(asset_probe_record "$n" "$probe")"; rc=$?
  case "$rc" in
    0) ;;
    1) record drill-rollback INCONCLUSIVE "$(( $(now) - started ))" "$why, so reading assets through $ROLLBACK_FROM cannot be checked"; return ;;
    *) record drill-rollback FAIL "$(( $(now) - started ))" "before the rollback, $why"; return ;;
  esac
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
  # Forward again: every asset triple from before the rollback still there, then rebuilt read graphs. The agents
  # system graph is left out, as on the earlier release: the forward start rewrites the node's own registration there.
  if ! wait_all_ready drill-rollback "$READY_TIMEOUT" "$n"; then record drill-rollback FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after the forward start"; return; fi
  member_graphs "$endpoint" "$RESULTS/rows/rollback.members-forward.node$n.json" \
    && lost="$(members_lost "$RESULTS/rows/rollback.members-before.node$n.json" "$RESULTS/rows/rollback.members-forward.node$n.json" kept "$AGENTS_SYSTEM_GRAPH")" \
    || { record drill-rollback FAIL "$(( $(now) - started ))" "node$n's asset data after the forward start: ${lost:-unreadable}"; return; }
  drill_end drill-rollback "$n" "$started" "\`dkg rollback --stores-for $target_version\` removed all $dropped read-graph partition graphs and kept every asset triple; ran $version, which answered $read_through as the build under test did; then rebuilt from nothing"
}

drill_flag_off_and_back() {
  if [ "$SWITCH" = api ]; then drill_flag_api; else drill_flag_config; fi
}

# drill_flag_api: on FLAG_NODE, the live context graph's layers off through the settings API and back to what they
# were, with no restart: with off its read graphs go; back on, each gets a new generation and is rebuilt.
drill_flag_api() {
  local n="$FLAG_NODE" started body why wm swm vm state gen graph older=""
  started="$(now)"
  read_graph_rows "$n" > "$RESULTS/rows/flag.all.node$n" && live_graphs "$RESULTS/rows/flag.all.node$n" > "$RESULTS/rows/flag.before.node$n" \
    && all_ready "$RESULTS/rows/flag.before.node$n" \
    || { record drill-flag INCONCLUSIVE 0 "node$n had no ready read graph of $LIVE_CG (the live phase switches it on)"; return; }
  live_get "$n" flag-before > /dev/null || { record drill-flag INCONCLUSIVE 0 "node$n's settings could not be read: $(settings_read "$RESULTS/rows/live.flag-before.node$n" refusal)"; return; }
  wm="$(settings_read "$RESULTS/rows/live.flag-before.node$n" effective "$LIVE_CG" working-memory)"
  swm="$(settings_read "$RESULTS/rows/live.flag-before.node$n" effective "$LIVE_CG" shared-working-memory)"
  vm="$(settings_read "$RESULTS/rows/live.flag-before.node$n" effective "$LIVE_CG" verifiable-memory)"
  [ -n "$wm" ] && [ -n "$swm" ] && [ -n "$vm" ] || { record drill-flag INCONCLUSIVE 0 "node$n's settings answer has no effective modes for $LIVE_CG"; return; }
  body="$(live_body off off off)"
  why="$(live_put "$n" flag-off "$body")" || { record drill-flag FAIL "$(( $(now) - started ))" "switching $LIVE_CG off on node$n was refused: $why"; return; }
  # The off state counts only as observed: with off, the node lists no read graph of the context graph.
  live_wait_gone "$n" flag-off || { record drill-flag FAIL "$(( $(now) - started ))" "with off, read graphs of $LIVE_CG were still listed on node$n after ${READY_TIMEOUT} s"; return; }
  body="$(live_body "$wm" "$swm" "$vm")"
  why="$(live_put "$n" flag-back "$body")" || { record drill-flag FAIL "$(( $(now) - started ))" "switching $LIVE_CG back (wm=$wm swm=$swm vm=$vm) on node$n was refused: $why"; return; }
  if ! wait_all_ready drill-flag "$READY_TIMEOUT" "$n"; then record drill-flag FAIL "$(( $(now) - started ))" "node$n's read graphs not ready after $LIVE_CG was switched back"; return; fi
  # Off dropped them with their state, so each must be listed and ready again: rebuilt from nothing (a generation
  # number may start over, so it proves nothing here).
  while read -r state gen graph; do
    awk -v g="$graph" '$3 == g && $1 == "ready" { found = 1 } END { exit !found }' "$RESULTS/rows/drill-flag.node$n" || older="$older <$graph>"
  done < "$RESULTS/rows/flag.before.node$n"
  [ -z "$older" ] || { record drill-flag FAIL "$(( $(now) - started ))" "not ready again after $LIVE_CG was switched back:$older"; return; }
  drill_end drill-flag "$n" "$started" "$LIVE_CG off through the settings API, no restart: its read graphs went; back to wm=$wm swm=$swm vm=$vm, each was rebuilt from nothing"
}

drill_flag_config() {
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
  local n drill
  for n in "$RESTART_NODE" "$KILL_NODE" "$CLI_NODE" "$ROLLBACK_NODE" "$FLAG_NODE"; do
    case " $NODES " in *" $n "*) ;; *) record drills INCONCLUSIVE 0 "drill node node$n is not part of the run"; return ;; esac
  done
  # A drill left out of READ_GRAPHS_DRILLS did not run, so the run cannot pass.
  for drill in restart kill cli rollback flag; do
    case " $DRILLS " in *" $drill "*) ;; *) record "drill-$drill" INCONCLUSIVE 0 "not run (left out of READ_GRAPHS_DRILLS)"; continue ;; esac
    case "$drill" in
      restart) drill_restart_during_rebuild ;;
      kill) drill_kill_during_write ;;
      cli) drill_cli_write_daemon_down ;;
      rollback) drill_rollback_and_forward ;;
      flag) drill_flag_off_and_back ;;
    esac
  done
}

say "nodes $NODES; setting $SETTING; per-context-graph settings: $SWITCH; results in $RESULTS"
FAILS_BEFORE_GATE=""
for phase in $PHASES; do
  case "$phase" in
    seed|setup|backfill|measure|live|gate|drills) ;;
    *) record "$phase" INCONCLUSIVE 0 "unknown phase"; continue ;;
  esac
  # The drills make their own data, so they run after a failed gate too, and one run reports them all; the run stays
  # FAIL. A failure in any other phase stops every later one.
  if [ "$FAILS" != 0 ] && { [ "$phase" != drills ] || [ "$FAILS_BEFORE_GATE" != 0 ]; }; then
    record "$phase" INCONCLUSIVE 0 "not run: an earlier step failed"; continue
  fi
  [ "$STOPPED" = 0 ] || { record "$phase" INCONCLUSIVE 0 "not run: a precondition of an earlier step was not met"; continue; }
  [ "$phase" != gate ] || FAILS_BEFORE_GATE="$FAILS"
  "phase_$phase"
done
for phase in seed setup backfill measure live gate drills; do
  case " $PHASES " in *" $phase "*) ;; *) note "$phase was not run (READ_GRAPHS_RUN_PHASES)"; GAPS=$((GAPS + 1)) ;; esac
done

if [ "$FAILS" -gt 0 ]; then say "FAIL"; exit 1; fi
if [ "$GAPS" -gt 0 ]; then say "INCONCLUSIVE"; exit "$SKIP_EXIT"; fi
say "PASS"
exit 0
