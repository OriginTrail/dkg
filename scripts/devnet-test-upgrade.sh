#!/usr/bin/env bash
#
# In-place upgrade of a devnet: previous release -> the build under test.
#
# Every other devnet suite starts all six nodes on one build with empty data.
# This one does what a release does to a running network:
#
#   1. start the six-node devnet on the PREVIOUS RELEASE
#      (DEVNET_VERSION_LAYOUT="all:<ref>", see scripts/devnet.sh);
#   2. write through that release, on every store backend;
#   3. restart every node on the build under test with
#      `devnet.sh restart-node N`, one node at a time, on the same data;
#   4. require that every node starts, reports the new version and build, still
#      serves what was written, and can publish and receive again.
#
# IT OWNS THE DEVNET. A devnet that is running is stopped and replaced (its
# node logs are copied to the results directory first). The devnet is left
# running on the build under test when the script ends, like the other suites
# leave it. In scripts/devnet-comprehensive.sh this is therefore the last suite.
#
# What is written (default layout: nodes 1-2 managed Oxigraph, 3-4 Blazegraph,
# 5-6 an external SPARQL endpoint; 1-4 are Cores, 5-6 are Edges). Each backend
# has one node that writes and one that receives, and a writer's member is on
# another backend:
#
#     writer 1 (managed Oxigraph)   -> member 6 (external endpoint)
#     writer 3 (Blazegraph)         -> member 2 (managed Oxigraph)
#     writer 5 (external endpoint)  -> member 4 (Blazegraph)
#
#   Per writer, a PUBLIC and a PRIVATE context graph, both created and
#   registered on the previous release. The member subscribes to the public
#   one and joins the private one through the signed join request. In each:
#     - a shared-memory asset                    (member reads it in shared memory)
#     - a published asset, then an UPDATE of it  (member reads the updated
#                                                 version, and only that one, in
#                                                 verified memory; see "The
#                                                 writer's read" below)
#     - a QUEUED (asynchronous) publication      (the job finalizes; member reads
#                                                 it in verified memory)
#     - a working-memory draft that is not shared before the upgrade
#   Plus one published asset from EVERY node in the registered public graph the
#   devnet starts with (DEVNET_CONTEXT_GRAPH, default devnet-test), which every
#   node must read.
#
# After the upgrade, without writing anything first:
#     every node reports the version and commit of the build under test and
#     its backend;
#     every read above still answers the same; every draft is still there;
#     every member still lists both subscriptions; every writer still holds its
#     queued publications as finalized.
# Then, on the upgraded network:
#     each writer shares a new asset, publishes a new asset, queues a
#     publication, updates the asset it published before the upgrade, and shares
#     the draft it wrote before the upgrade; its member must read all five.
#     Every node publishes once more into the common graph and every node must
#     read all six.
# Optionally (DEVNET_UPGRADE_WAL_PAUSE_NODE), one managed-Oxigraph node is then
# made to meet a write-ahead-log maintenance pause.
#
# The writer's read of an asset it updated. A member must read the updated
# version and nothing else. The writer's own store also keeps the copy its
# publication made for the random-sampling prover, in the graph of the context
# graph's on-chain id, and an update does not restate that copy: the writer
# answers the version the asset was published with beside the current one. That
# is a defect of the node, not of an upgrade, and not what this suite is for.
# So the writer's read must contain the current version, may contain the
# published one ("asset version 1"), and nothing else: an intermediate version
# left behind by the upgrade still fails.
# Each such read prints `also read [...] tolerated`, and the summary counts
# them, so the leftover stays visible until the node no longer keeps it; then
# the tolerance can go.
#
# Every node runs the SHIPPED chain-request budget here, not the local one the
# other suites run with: scripts/devnet.sh gives the local budget only to a
# node it starts on the build under test, and a restart keeps the node's
# configuration, as an operator's upgrade does. The control run is started the
# same way, so that it differs from an upgrade in the build alone.
#
# Exit codes (the convention of devnet-test-store-outage.sh):
#   0 = the upgrade was exercised and every check held.
#   3 = the upgrade was NOT exercised: the previous release could not be
#       resolved, built, started, written through, or did not reach the
#       expected state itself. Nothing here says anything about the build
#       under test, and it is never a pass.
#   other non-zero = a check failed on or after the first upgraded node.
#
# Env:
#   DEVNET_UPGRADE_FROM       the ref the devnet starts on. Default `prev`: the
#                             newest release tag below the workspace version
#                             (DEVNET_PREV_VERSION overrides it, as for
#                             DEVNET_VERSION_LAYOUT). A tag such as v10.0.23, or
#                             `current`: no upgrade, the same build restarted on
#                             its data (a control for this scenario itself).
#   DEVNET_UPGRADE_RESULTS    where logs and read results go
#                             (default $DEVNET_DIR/upgrade-results/<utc time>).
#   DEVNET_UPGRADE_BASELINE_WAIT_S  seconds the previous release has to reach the
#                             written state (default 300).
#   DEVNET_UPGRADE_SERVE_WAIT_S     seconds an upgraded network has to serve
#                             again what it held (default 240).
#   DEVNET_UPGRADE_RECEIVE_WAIT_S   seconds new writes have to arrive after the
#                             upgrade (default 300).
#   DEVNET_UPGRADE_MESH_WAIT_S      seconds the restarted nodes have to connect to
#                             each other before the checks begin (default 90;
#                             reported, never a failure by itself).
#   DEVNET_UPGRADE_WAL_PAUSE_NODE   optional last step, off by default: the node
#                             (1 or 2, the managed-Oxigraph nodes) that is made
#                             to meet a write-ahead-log maintenance pause on the
#                             upgraded network. It runs
#                             devnet-test-oxigraph-wal-pause.sh, which sets a
#                             small limit on that node, writes until the node
#                             pauses its store work, and requires that a write
#                             refused during the pause succeeds when repeated
#                             and that the node serves again. WAL_PAUSE_BYTES and
#                             the other knobs of that script pass through.
#   DEVNET_DIR, API_PORT_BASE, HARDHAT_PORT, DEVNET_CONTEXT_GRAPH and the store
#   ports of scripts/devnet.sh are honoured.
#
# The first run on a ref builds it once under .devnet-versions/<ref> (several
# minutes); later runs reuse that build. Contracts are deployed from the build
# under test, as for every version layout.
#
# Run:  ./scripts/devnet-test-upgrade.sh
#       DEVNET_UPGRADE_FROM=v10.0.23 ./scripts/devnet-test-upgrade.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export REPO_ROOT
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
export DEVNET_DIR
API_PORT_BASE="${API_PORT_BASE:-9201}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
NUM_NODES=6
COMMON_GRAPH="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
BASELINE_WAIT_S="${DEVNET_UPGRADE_BASELINE_WAIT_S:-300}"
SERVE_WAIT_S="${DEVNET_UPGRADE_SERVE_WAIT_S:-240}"
RECEIVE_WAIT_S="${DEVNET_UPGRADE_RECEIVE_WAIT_S:-300}"
MESH_WAIT_S="${DEVNET_UPGRADE_MESH_WAIT_S:-90}"
WAL_PAUSE_NODE="${DEVNET_UPGRADE_WAL_PAUSE_NODE:-}"
DKG_API_MAXTIME="${DKG_API_MAXTIME:-180}"
# The update-seal helpers read the chain through RPC_URL.
export RPC_URL="${RPC_URL:-http://127.0.0.1:$HARDHAT_PORT}"
SKIP_EXIT=3
SCHEMA_NAME="http://schema.org/name"
STAMP="$(date +%s)"
RESULTS="${DEVNET_UPGRADE_RESULTS:-$DEVNET_DIR/upgrade-results/$(date -u +'%Y%m%dT%H%M%SZ')}"

WRITERS=(1 3 5)
member_of() { case "$1" in 1) echo 6 ;; 3) echo 2 ;; 5) echo 4 ;; esac; }
expected_backend() { case "$1" in 1|2) echo oxigraph-server ;; 3|4) echo blazegraph ;; 5|6) echo sparql-http ;; esac; }
backend_label() { case "$1" in 1|2) echo "managed Oxigraph" ;; 3|4) echo "Blazegraph" ;; 5|6) echo "external SPARQL endpoint" ;; esac; }

PASS=0; FAIL=0
PHASE="previous release"
say()  { echo "[upgrade] $*"; }
BEGAN=$(date +%s)
step() { echo; echo "[upgrade] === $* === (+$(( $(date +%s) - BEGAN ))s)"; }
ok()   { PASS=$((PASS + 1)); echo "[upgrade]   ok: $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "[upgrade]   FAIL: $*" >&2; }
skip() { echo "[upgrade] SKIP: $*"; echo "[upgrade] The upgrade was not exercised (exit $SKIP_EXIT)."; exit "$SKIP_EXIT"; }
# Before the first node is upgraded a problem is the previous release's or the
# harness's, so the upgrade was not exercised; afterwards it is a failed check.
stop_here() {
  if [ "$PHASE" = "previous release" ]; then skip "$*"; fi
  echo "[upgrade] FAIL: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || skip "curl not available"
command -v node >/dev/null 2>&1 || skip "node not available"
command -v git >/dev/null 2>&1 || skip "git not available"
case "$WAL_PAUSE_NODE" in
  ''|1|2) : ;;
  *) skip "DEVNET_UPGRADE_WAL_PAUSE_NODE='$WAL_PAUSE_NODE' is not a managed-Oxigraph node of the devnet layout (1 or 2)" ;;
esac

# shellcheck source=devnet-lib.sh
. "$SCRIPT_DIR/devnet-lib.sh" || skip "cannot source scripts/devnet-lib.sh"
# The curated-join and update-seal helpers call api_call (body on stdout).
api_call() { body_of "$(api "$@")"; }
# shellcheck source=devnet-publish-helpers.sh
. "$SCRIPT_DIR/devnet-publish-helpers.sh" || skip "cannot source scripts/devnet-publish-helpers.sh"
# shellcheck source=devnet-curated-join-helpers.sh
. "$SCRIPT_DIR/devnet-curated-join-helpers.sh" || skip "cannot source scripts/devnet-curated-join-helpers.sh"
# shellcheck source=devnet-update-helpers.sh
. "$SCRIPT_DIR/devnet-update-helpers.sh" || skip "cannot source scripts/devnet-update-helpers.sh"

DEVNET_SH="$SCRIPT_DIR/devnet.sh"

# ---------------------------------------------------------------------------
# 0. Which builds
# ---------------------------------------------------------------------------
FROM_REF="${DEVNET_UPGRADE_FROM:-prev}"
if [ "$FROM_REF" = "prev" ]; then
  # devnet.sh owns the meaning of `prev`; ask it rather than keep a copy.
  FROM_REF="$(
    set +u
    DEVNET_SOURCE_ONLY=1
    # shellcheck source=devnet.sh
    . "$SCRIPT_DIR/devnet.sh" >/dev/null 2>&1 && resolve_prev_version 2>/dev/null
  )" || FROM_REF=""
  [ -n "$FROM_REF" ] || skip "no release tag below the workspace version was found (a checkout without tags?); set DEVNET_UPGRADE_FROM to the ref to upgrade from"
fi

# The identity a node of the build under test reports: stamped at compile time
# when the build has a stamp, else the checkout's commit (scripts/devnet.sh and
# the status route follow the same order).
NEW_COMMIT="$(BUILD_INFO="$REPO_ROOT/packages/cli/build-info.json" node -e '
  try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.env.BUILD_INFO, "utf8")).commit ?? "")); }
  catch { process.stdout.write(""); }')"
case "$NEW_COMMIT" in ''|unknown|uncommitted) NEW_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)" ;; esac
[ -n "$NEW_COMMIT" ] || skip "cannot tell which commit the build under test is (no packages/cli/build-info.json and no git checkout)"
[ -f "$REPO_ROOT/packages/cli/dist/cli.js" ] || skip "the build under test is not built (packages/cli/dist/cli.js is missing); run pnpm build first"
# The version a node of the build under test reports: the CLI package's.
NEW_VERSION="$(PACKAGE="$REPO_ROOT/packages/cli/package.json" node -e '
  try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.env.PACKAGE, "utf8")).version ?? "")); }
  catch { process.stdout.write(""); }')"
[ -n "$NEW_VERSION" ] || skip "cannot read the version of the build under test from packages/cli/package.json"

if [ "$FROM_REF" = "current" ]; then
  CONTROL=1
  FROM_COMMIT="$NEW_COMMIT"
  FROM_LAYOUT="all:current"
else
  CONTROL=0
  FROM_COMMIT="$(git -C "$REPO_ROOT" rev-parse --verify --quiet "${FROM_REF}^{commit}" 2>/dev/null || true)"
  [ -n "$FROM_COMMIT" ] || skip "ref '$FROM_REF' does not resolve to a commit in this checkout (fetch the release tags, or set DEVNET_UPGRADE_FROM)"
  FROM_LAYOUT="all:$FROM_REF"
  case "$NEW_COMMIT" in
    "$FROM_COMMIT"*) skip "'$FROM_REF' is the commit of the build under test (${FROM_COMMIT:0:9}): there is nothing to upgrade. Set DEVNET_UPGRADE_FROM to an older release, or to 'current' for the restart control" ;;
  esac
fi

mkdir -p "$RESULTS" || skip "cannot create the results directory $RESULTS"
say "results: $RESULTS"
if [ "$CONTROL" = "1" ]; then
  say "CONTROL RUN (DEVNET_UPGRADE_FROM=current): the build under test (${NEW_COMMIT:0:9}) is restarted on its own data; no upgrade is exercised"
else
  say "upgrade from $FROM_REF (${FROM_COMMIT:0:9}) to the build under test (v$NEW_VERSION ${NEW_COMMIT:0:9})"
fi

# All three store backends need Docker for two of them. Find out before the
# running devnet is touched.
command -v docker >/dev/null 2>&1 || skip "docker not available: the Blazegraph and external-endpoint nodes cannot be provisioned"
( docker info >/dev/null 2>&1 ) & docker_probe=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$docker_probe" 2>/dev/null || break; sleep 1; done
if kill -0 "$docker_probe" 2>/dev/null; then
  kill -9 "$docker_probe" 2>/dev/null; wait "$docker_probe" 2>/dev/null
  skip "docker did not answer within 10s: the Blazegraph and external-endpoint nodes cannot be provisioned"
fi
wait "$docker_probe" 2>/dev/null || skip "docker is not running: the Blazegraph and external-endpoint nodes cannot be provisioned"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
status_field() { # <node> <field> -> value ("" when the node does not answer 200)
  local response
  response="$(api "$1" GET /api/status)"
  [ "$(code_of "$response")" = "200" ] || { printf ''; return 1; }
  field "$(body_of "$response")" "$2"
}

wait_node_up() { # <node> <seconds>
  local i
  for i in $(seq 1 "$2"); do
    node_up "$1" && return 0
    sleep 1
  done
  return 1
}

# Every node must report the expected commit and its backend, and the expected
# version when one is given.
# <label> <expected commit> [expected version] -> 0 when all six do; prints one line per node.
report_builds() {
  local label="$1" expected="$2" expected_version="${3:-}" n version commit backend role wrong=0
  for n in $(seq 1 "$NUM_NODES"); do
    version="$(status_field "$n" version)"; commit="$(status_field "$n" commit)"
    backend="$(status_field "$n" storeBackend)"; role="$(status_field "$n" nodeRole)"
    if [ -z "$commit" ]; then
      say "  node $n: no answer from /api/status"
      wrong=$((wrong + 1))
      continue
    fi
    say "  node $n ($role, $backend): v$version ${commit:0:9}${commit:40}"
    printf '%s\tnode%s\t%s\t%s\tv%s\t%s\n' "$label" "$n" "$role" "$backend" "$version" "$commit" >> "$RESULTS/builds.tsv"
    case "$commit" in "$expected"*) : ;; *) wrong=$((wrong + 1)); say "    expected commit ${expected:0:9}" ;; esac
    if [ -n "$expected_version" ] && [ "$version" != "$expected_version" ]; then
      wrong=$((wrong + 1)); say "    expected version $expected_version"
    fi
    [ "$backend" = "$(expected_backend "$n")" ] || { wrong=$((wrong + 1)); say "    expected store backend $(expected_backend "$n")"; }
  done
  [ "$wrong" -eq 0 ]
}

quads_json() { # <subject> <value> -> one schema:name quad as a JSON array
  SUBJECT="$1" VALUE="$2" PREDICATE="$SCHEMA_NAME" node -e '
    process.stdout.write(JSON.stringify([{ subject: process.env.SUBJECT, predicate: process.env.PREDICATE,
      object: JSON.stringify(process.env.VALUE), graph: "" }]))'
}

LAST_ERROR=""
created() { case "$1" in 200|201) return 0 ;; *) return 1 ;; esac; }   # POST /api/knowledge-assets answers 201
# create_graph <node> <id> <title> <accessPolicy> <publishPolicy> [allowedAgents JSON] -> 0 when registered
create_graph() {
  local body response
  body="$(ID="$2" TITLE="$3" ACCESS="$4" PUBLISH="$5" ALLOWED="${6:-}" node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({ id: e.ID, name: e.TITLE, accessPolicy: Number(e.ACCESS), publishPolicy: Number(e.PUBLISH),
      ...(e.ALLOWED ? { allowedAgents: JSON.parse(e.ALLOWED) } : {}), register: true }))')"
  response="$(api "$1" POST /api/context-graph/create "$body")"
  if [ "$(code_of "$response")" = "200" ] && [ -n "$(field "$(body_of "$response")" onChainId)" ]; then return 0; fi
  LAST_ERROR="HTTP $(code_of "$response"): $(body_of "$response" | head -c 400)"
  return 1
}

# subscribe <node> <graph>: the node's own subscription, shared memory included.
# The route answers a retryable 503 while the node's view of the chain catches up.
subscribe() {
  local body response i
  body="$(ID="$2" node -e 'process.stdout.write(JSON.stringify({ contextGraphId: process.env.ID, includeSharedMemory: true }))')"
  for i in $(seq 1 30); do
    response="$(api "$1" POST /api/context-graph/subscribe "$body")"
    if [ "$(code_of "$response")" = "200" ] && [ "$(field "$(body_of "$response")" subscribed)" = "$2" ]; then return 0; fi
    sleep 4
  done
  LAST_ERROR="HTTP $(code_of "$response"): $(body_of "$response" | head -c 400)"
  return 1
}

# share_asset <node> <graph> <asset name> <subject> <value>: create, seal and share (shared memory).
share_asset() {
  local body response answer share_body attempt
  body="$(ID="$2" NAME="$3" QUADS="$(quads_json "$4" "$5")" node -e '
    const e = process.env;
    process.stdout.write(JSON.stringify({ contextGraphId: e.ID, name: e.NAME, quads: JSON.parse(e.QUADS), finalize: true, alsoShareSwm: true }))')"
  response="$(api "$1" POST /api/knowledge-assets "$body")"
  answer="$(body_of "$response")"
  if created "$(code_of "$response")" && [ "$(field "$answer" swmShared)" = "true" ]; then return 0; fi
  # Created and sealed, but the share did not complete: the share step can be
  # asked again by name (the create cannot). The other devnet suites retry it
  # the same way (devnet_create_shared_ka); here every retry is printed.
  if [ "$(field "$answer" created)" = "true" ] && [ "$(field "$answer" status)" = "wm-sealed" ]; then
    share_body="$(ID="$2" node -e 'process.stdout.write(JSON.stringify({ contextGraphId: process.env.ID }))')"
    for attempt in 1 2 3; do
      say "  share of '$3' on node $1 did not complete ($(printf '%s' "$answer" | head -c 200)); asking again ($attempt of 3)"
      sleep $((attempt * 2))
      response="$(api "$1" POST "/api/knowledge-assets/$3/swm/share" "$share_body")"
      answer="$(body_of "$response")"
      if [ "$(code_of "$response")" = "200" ] && [ "$(field "$answer" swmShared)" = "true" ]; then return 0; fi
    done
  fi
  LAST_ERROR="HTTP $(code_of "$response"): $(printf '%s' "$answer" | head -c 400)"
  return 1
}

# publish_asset <node> <graph> <asset name> -> prints the asset id; 0 only for a confirmed publication.
publish_asset() {
  local body response answer
  body="$(ID="$2" node -e 'process.stdout.write(JSON.stringify({ contextGraphId: process.env.ID, options: { clearAfter: false } }))')"
  response="$(api "$1" POST "/api/knowledge-assets/$3/vm/publish" "$body")"
  answer="$(body_of "$response")"
  if [ "$(code_of "$response")" = "200" ] && [ "$(field "$answer" status)" = "confirmed" ] && [ -n "$(field "$answer" kaId)" ]; then
    field "$answer" kaId
    return 0
  fi
  LAST_ERROR="HTTP $(code_of "$response"): $(printf '%s' "$answer" | head -c 400)"
  return 1
}

# update_asset <node> <graph> <asset id> <subject> <value>: owner-sealed update of a published asset.
update_asset() {
  local body response answer
  body="$(build_update_body "$1" "$3" "$2" "$(quads_json "$4" "$5")")" || { LAST_ERROR="could not seal the update of asset $3 (owner key or chain read)"; return 1; }
  response="$(api "$1" POST /api/update "$body")"
  answer="$(body_of "$response")"
  if [ "$(code_of "$response")" = "200" ] && [ "$(field "$answer" status)" = "confirmed" ] && [ "$(field "$answer" kaId)" = "$3" ]; then return 0; fi
  LAST_ERROR="HTTP $(code_of "$response"): $(printf '%s' "$answer" | head -c 400)"
  return 1
}

# queue_publication <node> <graph> <asset name> -> prints the job id of a queued (asynchronous) publication.
queue_publication() {
  local body response answer
  body="$(ID="$2" node -e 'process.stdout.write(JSON.stringify({ contextGraphId: process.env.ID }))')"
  response="$(api "$1" POST "/api/knowledge-assets/$3/vm/publish-async" "$body")"
  answer="$(body_of "$response")"
  if [ "$(code_of "$response")" = "202" ] && [ -n "$(field "$answer" jobId)" ]; then
    field "$answer" jobId
    return 0
  fi
  LAST_ERROR="HTTP $(code_of "$response"): $(printf '%s' "$answer" | head -c 400)"
  return 1
}

# job_status <node> <job id> -> prints the status the node holds for a queued publication ("" when it has none).
job_status() {
  local response
  response="$(api "$1" GET "/api/publisher/job?id=$2")"
  [ "$(code_of "$response")" = "200" ] || { LAST_ERROR="HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; printf ''; return 1; }
  field "$(body_of "$response")" job.status
}

# wait_job_finalized <node> <job id> <seconds>: 0 when the queued publication is finalized; a failed job ends the wait.
wait_job_finalized() {
  local i status=""
  for i in $(seq 1 "$(( $3 / 2 ))"); do
    status="$(job_status "$1" "$2")"
    case "$status" in
      finalized) return 0 ;;
      failed) break ;;
    esac
    sleep 2
  done
  LAST_ERROR="queued publication $2 is '${status:-unknown}' after ${3}s"
  return 1
}

# draft_asset <node> <graph> <asset name> <subject> <value>: a working-memory draft, not sealed, not shared.
draft_asset() {
  local response
  response="$(api "$1" POST /api/knowledge-assets "$(ID="$2" NAME="$3" node -e 'process.stdout.write(JSON.stringify({ contextGraphId: process.env.ID, name: process.env.NAME }))')")"
  created "$(code_of "$response")" || { LAST_ERROR="create: HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; return 1; }
  response="$(api "$1" POST "/api/knowledge-assets/$3/wm/write" "$(ID="$2" QUADS="$(quads_json "$4" "$5")" node -e 'process.stdout.write(JSON.stringify({ contextGraphId: process.env.ID, quads: JSON.parse(process.env.QUADS) }))')")"
  [ "$(code_of "$response")" = "200" ] || { LAST_ERROR="write: HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; return 1; }
}

# draft_holds <node> <graph> <asset name> <value>: 0 when the draft still reads back with its value.
draft_holds() {
  local response encoded
  encoded="$(ID="$2" node -e 'process.stdout.write(encodeURIComponent(process.env.ID))')"
  response="$(api "$1" GET "/api/knowledge-assets/$3/wm/quads?contextGraphId=$encoded")"
  [ "$(code_of "$response")" = "200" ] || { LAST_ERROR="HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; return 1; }
  if BODY="$(body_of "$response")" VALUE="$4" node -e '
    const answer = JSON.parse(process.env.BODY);
    const quads = Array.isArray(answer) ? answer : (answer.quads ?? []);
    process.exit(quads.some((quad) => String(quad.object ?? "").includes(process.env.VALUE)) ? 0 : 1);' 2>/dev/null; then return 0; fi
  LAST_ERROR="the draft does not read back with its value: $(body_of "$response" | head -c 300)"
  return 1
}

# share_draft <node> <graph> <asset name>: seal a draft and share it.
share_draft() {
  local body response
  body="$(ID="$2" node -e 'process.stdout.write(JSON.stringify({ contextGraphId: process.env.ID }))')"
  response="$(api "$1" POST "/api/knowledge-assets/$3/wm/finalize" "$body")"
  [ "$(code_of "$response")" = "200" ] || { LAST_ERROR="finalize: HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; return 1; }
  response="$(api "$1" POST "/api/knowledge-assets/$3/swm/share" "$body")"
  [ "$(code_of "$response")" = "200" ] || { LAST_ERROR="share: HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; return 1; }
}

# subscribed <node> <graph>: 0 when the node lists an active subscription to the graph.
subscribed() {
  local response
  response="$(api "$1" GET /api/context-graph/subscriptions)"
  [ "$(code_of "$response")" = "200" ] || { LAST_ERROR="HTTP $(code_of "$response"): $(body_of "$response" | head -c 300)"; return 1; }
  if BODY="$(body_of "$response")" ID="$2" node -e '
    const rows = JSON.parse(process.env.BODY).subscriptions ?? [];
    process.exit(rows.some((row) => row.contextGraphId === process.env.ID && row.subscribed === true) ? 0 : 1);' 2>/dev/null; then return 0; fi
  LAST_ERROR="the graph is not among the node's active subscriptions"
  return 1
}

# The reads a node must answer, as tab-separated lines:
#   label <TAB> node <TAB> graph <TAB> view <TAB> subject <TAB> value <TAB> tolerated
# `tolerated` is empty, or the one value that may be read beside `value`.
EXPECT_BEFORE="$RESULTS/expected-before.tsv"   # written before the upgrade
EXPECT_AFTER="$RESULTS/expected-after.tsv"     # the state after the writes on the upgraded network
: > "$EXPECT_BEFORE"; : > "$EXPECT_AFTER"
expect() { # <file> <label> <node> <graph> <view> <subject> <value> [tolerated]
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$2" "$3" "$4" "$5" "$6" "$7" "${8:-}" >> "$1"
}
# The version an asset was published with: what a writer may still read beside
# the current version of an asset it updated (see the header).
PUBLISHED_VERSION="asset version 1"
# expect_updated <file> <writer> <member> <kind> <graph> <current version>
expect_updated() {
  expect "$1" "writer node $2 reads the updated asset of node $2's $4 graph (verified memory; the version it was published with is tolerated beside it)" \
    "$2" "$5" "$VM" "$(subject "$2" "$4" asset)" "$6" "$PUBLISHED_VERSION"
  expect "$1" "member node $3 reads the updated asset of node $2's $4 graph, and only that version (verified memory)" \
    "$3" "$5" "$VM" "$(subject "$2" "$4" asset)" "$6"
}

# check_state <name> <tsv> <seconds>: wait for every read of the list. 0 all met,
# 1 a valid read showed another state, 2 a read never became valid.
check_state() {
  local name="$1" tsv="$2" seconds="$3" status
  TSV="$tsv" node -e '
    const lines = require("fs").readFileSync(process.env.TSV, "utf8").split("\n").filter(Boolean);
    process.stdout.write(JSON.stringify(lines.map((line) => {
      const [label, node, contextGraphId, view, subject, value, tolerated] = line.split("\t");
      return { label, node: Number(node), contextGraphId, view, subject, values: [value], ...(tolerated ? { tolerated: [tolerated] } : {}) };
    })));' > "$RESULTS/$name.expected.json" || return 2
  node "$SCRIPT_DIR/lib/qa/expected-state-cli.mjs" "$RESULTS/$name.expected.json" \
    --devnet-dir "$DEVNET_DIR" --api-port-base "$API_PORT_BASE" --timeout-s "$seconds" --interval-s 3 \
    --out "$RESULTS/$name.results.json" > "$RESULTS/$name.log" 2>&1
  status=$?
  sed 's/^/[upgrade]     /' "$RESULTS/$name.log"
  TOLERATED_LAST="$(grep -c '; also read ' "$RESULTS/$name.log" 2>/dev/null || true)"
  if [ "${TOLERATED_LAST:-0}" -gt 0 ]; then
    say "  note: $TOLERATED_LAST of these reads also returned the version an updated asset was published with (not part of the verdict, see the header)"
    printf '%s\t%s\n' "$name" "$TOLERATED_LAST" >> "$RESULTS/tolerated-reads.tsv"
  fi
  return "$status"
}

VM="verifiable-memory"
SWM="shared-working-memory"
AGENT=(); PUBLIC=(); PRIVATE=(); ASSET_ID_PUBLIC=(); ASSET_ID_PRIVATE=(); JOB_PUBLIC=(); JOB_PRIVATE=()
subject() { echo "urn:dkg-upgrade:$STAMP:n$1:$2:$3"; }     # <node> <public|private|common> <what>
asset_name() { echo "upg-$STAMP-n$1-$2-$3"; }
graph_of() { if [ "$2" = "public" ]; then echo "${PUBLIC[$1]}"; else echo "${PRIVATE[$1]}"; fi; }

# ---------------------------------------------------------------------------
# 1. Replace the running devnet with one on the previous release
# ---------------------------------------------------------------------------
step "1. start the devnet on ${FROM_REF} (layout ${FROM_LAYOUT})"
if ls "$DEVNET_DIR"/node*/daemon.log >/dev/null 2>&1; then
  mkdir -p "$RESULTS/replaced-devnet"
  for log in "$DEVNET_DIR"/node*/daemon.log; do
    cp "$log" "$RESULTS/replaced-devnet/$(basename "$(dirname "$log")")-daemon.log" 2>/dev/null || true
  done
  say "kept the node logs of the devnet being replaced in $RESULTS/replaced-devnet"
fi
"$DEVNET_SH" stop > "$RESULTS/devnet-stop.log" 2>&1 || true
START_BEGAN=$(date +%s)
# DEVNET_ENABLE_PUBLISHER=1 is how the release process starts the devnet: it
# gives every node a publisher wallet, without which a node accepts no queued
# publication. DEVNET_RPC_BUDGET=shipped: see the header.
if ! DEVNET_VERSION_LAYOUT="$FROM_LAYOUT" DEVNET_REQUIRE_ALL_BACKENDS=1 DEVNET_ENABLE_PUBLISHER=1 DEVNET_RPC_BUDGET=shipped \
  "$DEVNET_SH" start "$NUM_NODES" > "$RESULTS/devnet-start.log" 2>&1; then
  tail -n 25 "$RESULTS/devnet-start.log" | sed 's/^/[upgrade]     /'
  skip "the devnet did not start on $FROM_REF (log: $RESULTS/devnet-start.log)"
fi
say "devnet started in $(( $(date +%s) - START_BEGAN ))s"
report_builds before "$FROM_COMMIT" || skip "not every node runs $FROM_REF (${FROM_COMMIT:0:9}) on its expected store backend after the start"

for n in $(seq 1 "$NUM_NODES"); do
  AGENT[$n]="$(field "$(body_of "$(api "$n" GET /api/agent/identity)")" agentAddress)"
  [ -n "${AGENT[$n]}" ] || skip "node $n did not report its agent address"
done

# ---------------------------------------------------------------------------
# 2. Write through the previous release
# ---------------------------------------------------------------------------
step "2. write on ${FROM_REF}: every node publishes into the common public graph '$COMMON_GRAPH'"
for n in $(seq 1 "$NUM_NODES"); do
  share_asset "$n" "$COMMON_GRAPH" "$(asset_name "$n" common before)" "$(subject "$n" common before)" "common before the upgrade, from node $n" \
    || skip "node $n ($(backend_label "$n")) could not share into '$COMMON_GRAPH' on $FROM_REF: $LAST_ERROR"
  publish_asset "$n" "$COMMON_GRAPH" "$(asset_name "$n" common before)" >/dev/null \
    || skip "node $n ($(backend_label "$n")) could not publish into '$COMMON_GRAPH' on $FROM_REF: $LAST_ERROR"
  say "  node $n published"
  for reader in $(seq 1 "$NUM_NODES"); do
    for file in "$EXPECT_BEFORE" "$EXPECT_AFTER"; do
      expect "$file" "node $reader reads node $n's asset in '$COMMON_GRAPH' (verified memory)" "$reader" "$COMMON_GRAPH" "$VM" \
        "$(subject "$n" common before)" "common before the upgrade, from node $n"
    done
  done
done

for w in "${WRITERS[@]}"; do
  m="$(member_of "$w")"
  step "2. write on ${FROM_REF}: writer node $w ($(backend_label "$w")), member node $m ($(backend_label "$m"))"
  PUBLIC[$w]="${AGENT[$w]}/upgrade-$STAMP-public"
  PRIVATE[$w]="${AGENT[$w]}/upgrade-$STAMP-private"

  create_graph "$w" "${PUBLIC[$w]}" "upgrade $STAMP public (node $w)" 0 1 \
    || skip "node $w could not create and register its public graph on $FROM_REF: $LAST_ERROR"
  subscribe "$m" "${PUBLIC[$w]}" \
    || skip "member node $m could not subscribe to node $w's public graph on $FROM_REF: $LAST_ERROR"
  create_graph "$w" "${PRIVATE[$w]}" "upgrade $STAMP private (node $w)" 1 0 "[\"${AGENT[$w]}\",\"${AGENT[$m]}\"]" \
    || skip "node $w could not create and register its private graph on $FROM_REF: $LAST_ERROR"
  devnet_join_curated_member "$m" "$w" "${PRIVATE[$w]}" "${AGENT[$m]}" \
    || skip "member node $m could not join node $w's private graph on $FROM_REF (signed join request, approval, subscription)"
  say "  graphs created; member subscribed to the public graph and joined the private one"

  for kind in public private; do
    g="$(graph_of "$w" "$kind")"
    share_asset "$w" "$g" "$(asset_name "$w" "$kind" shared)" "$(subject "$w" "$kind" shared)" "shared before the upgrade" \
      || skip "node $w could not share into its $kind graph on $FROM_REF: $LAST_ERROR"
    share_asset "$w" "$g" "$(asset_name "$w" "$kind" asset)" "$(subject "$w" "$kind" asset)" "$PUBLISHED_VERSION" \
      || skip "node $w could not share the asset it is about to publish ($kind graph) on $FROM_REF: $LAST_ERROR"
    asset_id="$(publish_asset "$w" "$g" "$(asset_name "$w" "$kind" asset)")" \
      || skip "node $w could not publish into its $kind graph on $FROM_REF: $LAST_ERROR"
    update_asset "$w" "$g" "$asset_id" "$(subject "$w" "$kind" asset)" "asset version 2, updated before the upgrade" \
      || skip "node $w could not update its published asset ($kind graph) on $FROM_REF: $LAST_ERROR"
    draft_asset "$w" "$g" "$(asset_name "$w" "$kind" draft)" "$(subject "$w" "$kind" draft)" "draft written before the upgrade" \
      || skip "node $w could not write a working-memory draft ($kind graph) on $FROM_REF: $LAST_ERROR"
    share_asset "$w" "$g" "$(asset_name "$w" "$kind" queued)" "$(subject "$w" "$kind" queued)" "queued before the upgrade" \
      || skip "node $w could not share the asset it is about to queue ($kind graph) on $FROM_REF: $LAST_ERROR"
    job_id="$(queue_publication "$w" "$g" "$(asset_name "$w" "$kind" queued)")" \
      || skip "node $w did not accept a queued publication ($kind graph) on $FROM_REF: $LAST_ERROR"
    wait_job_finalized "$w" "$job_id" 180 \
      || skip "node $w did not finalize its queued publication ($kind graph) on $FROM_REF: $LAST_ERROR"
    if [ "$kind" = "public" ]; then ASSET_ID_PUBLIC[$w]="$asset_id"; JOB_PUBLIC[$w]="$job_id"; else ASSET_ID_PRIVATE[$w]="$asset_id"; JOB_PRIVATE[$w]="$job_id"; fi
    say "  $kind graph: shared, published (asset $asset_id), updated, draft written, queued publication finalized (job $job_id)"
    for reader in "$w" "$m"; do
      if [ "$reader" = "$w" ]; then who="writer node $w"; else who="member node $m"; fi
      expect "$EXPECT_BEFORE" "$who reads the shared asset of node $w's $kind graph (shared memory)" "$reader" "$g" "$SWM" \
        "$(subject "$w" "$kind" shared)" "shared before the upgrade"
      expect "$EXPECT_AFTER" "$who reads the shared asset of node $w's $kind graph (shared memory)" "$reader" "$g" "$SWM" \
        "$(subject "$w" "$kind" shared)" "shared before the upgrade"
      for file in "$EXPECT_BEFORE" "$EXPECT_AFTER"; do
        expect "$file" "$who reads the queued publication of node $w's $kind graph (verified memory)" "$reader" "$g" "$VM" \
          "$(subject "$w" "$kind" queued)" "queued before the upgrade"
      done
    done
    expect_updated "$EXPECT_BEFORE" "$w" "$m" "$kind" "$g" "asset version 2, updated before the upgrade"
  done
done

step "2. the previous release reaches the written state (up to ${BASELINE_WAIT_S}s)"
check_state before-upgrade "$EXPECT_BEFORE" "$BASELINE_WAIT_S" \
  || skip "$FROM_REF did not reach the state written through it (reads above; results: $RESULTS/before-upgrade.results.json)"
for w in "${WRITERS[@]}"; do
  m="$(member_of "$w")"
  for kind in public private; do
    g="$(graph_of "$w" "$kind")"
    draft_holds "$w" "$g" "$(asset_name "$w" "$kind" draft)" "draft written before the upgrade" \
      || skip "node $w does not read back its $kind draft on $FROM_REF: $LAST_ERROR"
    subscribed "$m" "$g" || skip "member node $m does not list its subscription to node $w's $kind graph on $FROM_REF: $LAST_ERROR"
  done
done
say "baseline holds: $(wc -l < "$EXPECT_BEFORE" | tr -d ' ') reads, 6 drafts, 6 subscriptions, 6 queued publications"

# ---------------------------------------------------------------------------
# 3. Upgrade: restart every node on the build under test, on the same data
# ---------------------------------------------------------------------------
step "3. restart every node on the build under test (${NEW_COMMIT:0:9}), one at a time"
PHASE="upgrade"
for n in $(seq 1 "$NUM_NODES"); do
  began=$(date +%s)
  DEVNET_VERSION_LAYOUT="all:current" "$DEVNET_SH" restart-node "$n" > "$RESULTS/restart-node$n.log" 2>&1 \
    || say "  devnet.sh restart-node $n returned non-zero (log: $RESULTS/restart-node$n.log)"
  if ! wait_node_up "$n" 120; then
    tail -n 30 "$DEVNET_DIR/node$n/daemon.log" 2>/dev/null | sed 's/^/[upgrade]     /'
    stop_here "node $n ($(backend_label "$n")) did not start on the build under test with the data written by $FROM_REF (logs: $DEVNET_DIR/node$n/daemon.log, $DEVNET_DIR/node$n/console.log)"
  fi
  commit="$(status_field "$n" commit)"
  case "$commit" in
    "$NEW_COMMIT"*) ok "node $n ($(backend_label "$n")) answers on ${commit:0:9}${commit:40} after $(( $(date +%s) - began ))s" ;;
    *) stop_here "node $n answers on '${commit:0:9}' after its restart, not on the build under test (${NEW_COMMIT:0:9})" ;;
  esac
done
report_builds after "$NEW_COMMIT" "$NEW_VERSION" \
  || stop_here "not every node reports the build under test (v$NEW_VERSION ${NEW_COMMIT:0:9}) on its store backend after the upgrade"

# Every node has restarted and dialled its bootstrap peers as it came up. Give
# the mesh a bounded time to complete and print what each node holds. It is
# reported, not judged: a publication that cannot reach its Cores fails below
# with the node's own message, and this line then says why.
mesh_began=$(date +%s)
while :; do
  short=""
  for n in $(seq 1 "$NUM_NODES"); do
    peers="$(status_field "$n" connectedPeers)"
    [ "${peers:-0}" -ge $((NUM_NODES - 1)) ] 2>/dev/null || short="$short node$n=${peers:-none}"
  done
  [ -z "$short" ] && break
  [ $(( $(date +%s) - mesh_began )) -ge "$MESH_WAIT_S" ] && break
  sleep 3
done
if [ -z "$short" ]; then
  say "every node is connected to the other $((NUM_NODES - 1)) after $(( $(date +%s) - mesh_began ))s"
else
  say "note: after ${MESH_WAIT_S}s not every node is connected to the other $((NUM_NODES - 1)) (peers held:$short)"
fi

# ---------------------------------------------------------------------------
# 4. The upgraded network still serves what was written
# ---------------------------------------------------------------------------
step "4. every node still serves what it held (up to ${SERVE_WAIT_S}s, nothing written yet)"
if check_state still-serves "$EXPECT_BEFORE" "$SERVE_WAIT_S"; then
  ok "all $(wc -l < "$EXPECT_BEFORE" | tr -d ' ') reads answer as before the upgrade"
else
  bad "$(grep -c -v '^ok ' "$RESULTS/still-serves.log") of $(wc -l < "$EXPECT_BEFORE" | tr -d ' ') reads do not answer as before the upgrade (results: $RESULTS/still-serves.results.json)"
fi
for w in "${WRITERS[@]}"; do
  m="$(member_of "$w")"
  for kind in public private; do
    g="$(graph_of "$w" "$kind")"
    if draft_holds "$w" "$g" "$(asset_name "$w" "$kind" draft)" "draft written before the upgrade"; then
      ok "node $w still holds the draft of its $kind graph"
    else
      bad "node $w lost the working-memory draft of its $kind graph: $LAST_ERROR"
    fi
    if subscribed "$m" "$g"; then
      ok "member node $m still lists its subscription to node $w's $kind graph"
    else
      bad "member node $m no longer lists its subscription to node $w's $kind graph: $LAST_ERROR"
    fi
    if [ "$kind" = "public" ]; then job_id="${JOB_PUBLIC[$w]}"; else job_id="${JOB_PRIVATE[$w]}"; fi
    status="$(job_status "$w" "$job_id")"
    if [ "$status" = "finalized" ]; then
      ok "node $w still holds its queued publication of the $kind graph as finalized (job $job_id)"
    else
      bad "node $w reports its finalized queued publication of the $kind graph as '${status:-unknown}' after the upgrade (job $job_id): $LAST_ERROR"
    fi
  done
done

# ---------------------------------------------------------------------------
# 5. The upgraded network can publish and receive again
# ---------------------------------------------------------------------------
step "5. write on the upgraded network"
for n in $(seq 1 "$NUM_NODES"); do
  if share_asset "$n" "$COMMON_GRAPH" "$(asset_name "$n" common after)" "$(subject "$n" common after)" "common after the upgrade, from node $n" \
    && publish_asset "$n" "$COMMON_GRAPH" "$(asset_name "$n" common after)" >/dev/null; then
    ok "node $n ($(backend_label "$n")) published into '$COMMON_GRAPH'"
  else
    bad "node $n ($(backend_label "$n")) could not publish into '$COMMON_GRAPH' after the upgrade: $LAST_ERROR"
  fi
  for reader in $(seq 1 "$NUM_NODES"); do
    expect "$EXPECT_AFTER" "node $reader reads node $n's new asset in '$COMMON_GRAPH' (verified memory)" "$reader" "$COMMON_GRAPH" "$VM" \
      "$(subject "$n" common after)" "common after the upgrade, from node $n"
  done
done

for w in "${WRITERS[@]}"; do
  m="$(member_of "$w")"
  for kind in public private; do
    g="$(graph_of "$w" "$kind")"
    if [ "$kind" = "public" ]; then asset_id="${ASSET_ID_PUBLIC[$w]}"; else asset_id="${ASSET_ID_PRIVATE[$w]}"; fi
    if share_asset "$w" "$g" "$(asset_name "$w" "$kind" shared-after)" "$(subject "$w" "$kind" shared-after)" "shared after the upgrade"; then
      ok "node $w shared a new asset into its $kind graph"
    else
      bad "node $w could not share into its $kind graph after the upgrade: $LAST_ERROR"
    fi
    if share_asset "$w" "$g" "$(asset_name "$w" "$kind" asset-after)" "$(subject "$w" "$kind" asset-after)" "asset published after the upgrade" \
      && publish_asset "$w" "$g" "$(asset_name "$w" "$kind" asset-after)" >/dev/null; then
      ok "node $w published a new asset into its $kind graph"
    else
      bad "node $w could not publish into its $kind graph after the upgrade: $LAST_ERROR"
    fi
    if update_asset "$w" "$g" "$asset_id" "$(subject "$w" "$kind" asset)" "asset version 3, updated after the upgrade"; then
      ok "node $w updated the asset it published before the upgrade ($kind graph, asset $asset_id)"
    else
      bad "node $w could not update the asset it published before the upgrade ($kind graph, asset $asset_id): $LAST_ERROR"
    fi
    if share_asset "$w" "$g" "$(asset_name "$w" "$kind" queued-after)" "$(subject "$w" "$kind" queued-after)" "queued after the upgrade" \
      && job_id="$(queue_publication "$w" "$g" "$(asset_name "$w" "$kind" queued-after)")" \
      && wait_job_finalized "$w" "$job_id" 180; then
      ok "node $w finalized a queued publication into its $kind graph (job $job_id)"
    else
      bad "node $w could not finalize a queued publication into its $kind graph after the upgrade: $LAST_ERROR"
    fi
    if share_draft "$w" "$g" "$(asset_name "$w" "$kind" draft)"; then
      ok "node $w shared the draft it wrote before the upgrade ($kind graph)"
    else
      bad "node $w could not share the draft it wrote before the upgrade ($kind graph): $LAST_ERROR"
    fi
    for reader in "$w" "$m"; do
      if [ "$reader" = "$w" ]; then who="writer node $w"; else who="member node $m"; fi
      expect "$EXPECT_AFTER" "$who reads the asset shared after the upgrade in node $w's $kind graph (shared memory)" "$reader" "$g" "$SWM" \
        "$(subject "$w" "$kind" shared-after)" "shared after the upgrade"
      expect "$EXPECT_AFTER" "$who reads the asset published after the upgrade in node $w's $kind graph (verified memory)" "$reader" "$g" "$VM" \
        "$(subject "$w" "$kind" asset-after)" "asset published after the upgrade"
      expect "$EXPECT_AFTER" "$who reads the publication queued after the upgrade in node $w's $kind graph (verified memory)" "$reader" "$g" "$VM" \
        "$(subject "$w" "$kind" queued-after)" "queued after the upgrade"
      expect "$EXPECT_AFTER" "$who reads the draft shared after the upgrade in node $w's $kind graph (shared memory)" "$reader" "$g" "$SWM" \
        "$(subject "$w" "$kind" draft)" "draft written before the upgrade"
    done
    expect_updated "$EXPECT_AFTER" "$w" "$m" "$kind" "$g" "asset version 3, updated after the upgrade"
  done
done

step "5. every write arrives (up to ${RECEIVE_WAIT_S}s)"
if check_state after-upgrade "$EXPECT_AFTER" "$RECEIVE_WAIT_S"; then
  ok "all $(wc -l < "$EXPECT_AFTER" | tr -d ' ') reads hold on the upgraded network"
else
  bad "$(grep -c -v '^ok ' "$RESULTS/after-upgrade.log") of $(wc -l < "$EXPECT_AFTER" | tr -d ' ') reads do not hold on the upgraded network (results: $RESULTS/after-upgrade.results.json)"
fi

# ---------------------------------------------------------------------------
# 6. Optional: a store maintenance pause on the upgraded network
# ---------------------------------------------------------------------------
if [ -n "$WAL_PAUSE_NODE" ]; then
  step "6. a write-ahead-log maintenance pause on node $WAL_PAUSE_NODE of the upgraded network"
  DEVNET_VERSION_LAYOUT="all:current" WAL_PAUSE_NODE="$WAL_PAUSE_NODE" WAL_PAUSE_RESULTS="$RESULTS/wal-pause" \
    "$SCRIPT_DIR/devnet-test-oxigraph-wal-pause.sh" > "$RESULTS/wal-pause.log" 2>&1
  pause_status=$?
  sed 's/^/[upgrade]     /' "$RESULTS/wal-pause.log"
  case "$pause_status" in
    0) ok "node $WAL_PAUSE_NODE met a maintenance pause: the refused write succeeded when repeated and the node serves again" ;;
    3) bad "the maintenance pause on node $WAL_PAUSE_NODE was asked for and not exercised (log: $RESULTS/wal-pause.log)" ;;
    *) bad "the maintenance pause on node $WAL_PAUSE_NODE did not hold (exit $pause_status; log: $RESULTS/wal-pause.log)" ;;
  esac
fi

# Informational, never part of the verdict: what each node logged since it came
# up on the build under test. A pass with hundreds of errors is worth a look.
step "log lines since each node's last start (informational)"
for n in $(seq 1 "$NUM_NODES"); do
  counts="$(LOG="$DEVNET_DIR/node$n/daemon.log" node -e '
    const lines = require("fs").readFileSync(process.env.LOG, "utf8").split("\n");
    let start = 0;
    for (let i = lines.length - 1; i >= 0; i--) if (/Starting DKG (core|edge) node/.test(lines[i])) { start = i; break; }
    const since = lines.slice(start);
    const ending = (suffix) => since.filter((line) => line.endsWith(suffix)).length;
    const restarts = since.filter((line) => line.includes("terminating server for supervised recovery")).length;
    process.stdout.write(`errors=${ending("[ERROR]")} warnings=${ending("[WARN]")} store-restarts=${restarts}`);' 2>/dev/null)"
  say "  node $n ($(backend_label "$n")): ${counts:-log not readable}"
  printf 'node%s\t%s\n' "$n" "${counts:-unreadable}" >> "$RESULTS/log-counts-after-upgrade.tsv"
done

echo
say "──────── SUMMARY ────────"
say "from $FROM_REF (${FROM_COMMIT:0:9}) to ${NEW_COMMIT:0:9}; checks passed=$PASS failed=$FAIL; $(( $(date +%s) - BEGAN ))s; results: $RESULTS"
if [ -s "$RESULTS/tolerated-reads.tsv" ]; then
  say "note: reads that also returned the version an updated asset was published with (tolerated, see the header): $(tr '\t\n' '= ' < "$RESULTS/tolerated-reads.tsv")"
fi
if [ "$FAIL" -eq 0 ]; then
  if [ "$CONTROL" = "1" ]; then say "PASS (control: the build under test restarted on its own data)"; else say "PASS (upgrade from $FROM_REF)"; fi
  exit 0
fi
say "SOME CHECKS FAILED"
exit 1
