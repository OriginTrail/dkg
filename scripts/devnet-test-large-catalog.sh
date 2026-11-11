#!/usr/bin/env bash
#
# large-catalog — scoped queries on a small context graph must answer on a node
# whose store holds a graph catalog larger than any caller's limit.
#
# The script loads the fixture of packages/query/test-live/large-catalog-fixture.ts
# into one devnet node's own store: about 100,000 graphs across four context
# graphs, a few triples each, written to the store directly. It restarts the
# node, so that the node reads its graph catalog cold, and then:
#
#   1. reads the small context graph through POST /api/query: ASK, SELECT and
#      CONSTRUCT on working, shared and verifiable memory, with and without a
#      sub-graph and a trust floor, and on the legacy route. Every read must
#      answer 200 with exactly the fixture's rows. After a restart a node
#      answers shared-memory reads as denied until it has accepted the graph's
#      authority again, so the reads start once shared memory answers, after
#      at most three minutes;
#   2. restarts the node with its node-side catalog ceiling
#      (DKG_STORE_GRAPH_CATALOG_MAX_BYTES) below the catalog, and expects a read
#      to answer 503 STORE_INTERNAL_LIMIT and the node to log a line naming the
#      limit.
#
# It always removes the graphs it loaded for the unrelated context graphs and
# restarts the node with its normal settings, also when a step fails. The small
# context graph stays, like any other test context graph.
#
# The node is LARGE_CATALOG_NODE, or else a node on the daemon-managed
# oxigraph-server other than node 1 (the store CI does not run the fixture on),
# then one on Blazegraph, then node 1. A node on any other store is a SKIP: its
# store cannot be written from outside the daemon.
#
# Exit codes (a run that exercised nothing never looks like a pass):
#   0 = PASS, 3 = SKIP (a precondition was unmet), other non-zero = FAIL.
#
# Env knobs: DEVNET_DIR, API_PORT_BASE, LARGE_CATALOG_NODE,
#   LARGE_CATALOG_LIMIT_BYTES (the lowered ceiling of step 2; default 1048576).
#
# Run standalone, against a running devnet: scripts/devnet-test-large-catalog.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
LIMIT_BYTES="${LARGE_CATALOG_LIMIT_BYTES:-1048576}"
SMALL_CONTEXT_GRAPH="catalog-fixture-small-graph"
CEILING_ENV="DKG_STORE_GRAPH_CATALOG_MAX_BYTES"
LIMIT_NAME="STORE_GRAPH_CATALOG_MAX_BYTES"
SKIP_EXIT=3

say()  { echo "[large-catalog] $*"; }
skip() { echo "[large-catalog] SKIP: $*"; exit "$SKIP_EXIT"; }
fail() { echo "[large-catalog] FAIL: $*" >&2; exit 1; }

[ -d "$DEVNET_DIR" ] || skip "no devnet at $DEVNET_DIR (start one first: ./scripts/devnet.sh start 6)"
command -v curl >/dev/null 2>&1 || skip "curl not available"
cd "$REPO_ROOT"
node --import tsx -e '' >/dev/null 2>&1 || skip "tsx is not installed (run pnpm install)"
[ -f "$REPO_ROOT/packages/storage/dist/index.js" ] || skip "the storage package is not built"
# shellcheck source=devnet-lib.sh
. "$REPO_ROOT/scripts/devnet-lib.sh" || skip "cannot source scripts/devnet-lib.sh"

# The nodes whose store this script can write, best first: "<n> <store kind> <store url>".
candidates="$(node -e '
  const fs = require("fs"), path = require("path");
  const [dir, only] = process.argv.slice(1);
  const rows = [];
  for (const name of fs.readdirSync(dir)) {
    const m = /^node(\d+)$/.exec(name);
    if (!m || (only && m[1] !== only)) continue;
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(dir, name, "config.json"), "utf8")); } catch { continue; }
    const backend = config.store?.backend, options = config.store?.options ?? {};
    const n = Number(m[1]);
    if (backend === "oxigraph-server") rows.push([n === 1 ? 2 : 0, n, backend, `http://127.0.0.1:${options.port || 7878}`]);
    if (backend === "blazegraph" && typeof options.url === "string") rows.push([1, n, backend, options.url]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  process.stdout.write(rows.map(row => row.slice(1).join(" ")).join("\n"));
' "$DEVNET_DIR" "${LARGE_CATALOG_NODE:-}")"
read -r target kind store_url <<<"$candidates" || true
[ -n "${target:-}" ] || skip "no node${LARGE_CATALOG_NODE:-} on Blazegraph or the daemon-managed oxigraph-server"
node_up "$target" || skip "node${target} API not responding on $(node_port "$target")"

API="http://127.0.0.1:$(node_port "$target")"
TOKEN_FILE="$DEVNET_DIR/node${target}/auth.token"
LOG_FILE="$DEVNET_DIR/node${target}/daemon.log"
helper() { node --import tsx "$REPO_ROOT/scripts/devnet-large-catalog-store.mjs" "$@"; }
# restart_node [ceiling]: bounce the node, with the ceiling set or with the variable unset.
restart_node() {
  local attempt
  if [ -n "${1:-}" ]; then
    env "$CEILING_ENV=$1" "$REPO_ROOT/scripts/devnet.sh" restart-node "$target" >/dev/null 2>&1 || true
  else
    env -u "$CEILING_ENV" "$REPO_ROOT/scripts/devnet.sh" restart-node "$target" >/dev/null 2>&1 || true
  fi
  for attempt in $(seq 1 60); do node_up "$target" && return 0; sleep 2; done
  return 1
}
say "node${target}: ${kind} at ${store_url}"

loaded=0
cleanup() {
  local status=$?
  trap - EXIT
  # A second signal must not interrupt the recovery.
  trap '' INT TERM
  if [ "$loaded" = 1 ]; then
    say "removing the loaded graphs and restarting node${target} with its normal settings"
    # A daemon-managed store is down while its node is: bring the node back, then remove again.
    if ! helper remove "$kind" "$store_url"; then
      { restart_node && helper remove "$kind" "$store_url"; } \
        || { echo "[large-catalog] FAIL: could not remove the loaded graphs" >&2; status=1; }
    fi
    restart_node || { echo "[large-catalog] FAIL: node${target} did not come back" >&2; status=1; }
  fi
  exit "$status"
}
trap cleanup EXIT
# Cancellation (the comprehensive runner sends TERM to the suite's group) leaves through cleanup.
trap 'exit 143' TERM
trap 'exit 130' INT

created="$(api "$target" POST /api/context-graph/create \
  "{\"id\":\"$SMALL_CONTEXT_GRAPH\",\"name\":\"Large catalog fixture\"}")"
case "$(code_of "$created")" in
  200|201|409) ;;
  *) fail "could not create context graph ${SMALL_CONTEXT_GRAPH}: $(body_of "$created" | head -c 300)" ;;
esac

loaded=1
helper load "$kind" "$store_url" || fail "loading the fixture into node${target}'s store failed"

say "step 1: restarting node${target} so that it reads its catalog cold"
restart_node || fail "node${target} did not come back after the restart"
helper check "$API" "$TOKEN_FILE" || fail "a scoped read of ${SMALL_CONTEXT_GRAPH} did not answer as expected"

say "step 2: restarting node${target} with its catalog ceiling at ${LIMIT_BYTES} bytes"
restart_node "$LIMIT_BYTES" || fail "node${target} did not come up with the lowered ceiling"
log_offset="$(wc -c < "$LOG_FILE" | tr -d ' ')"
helper node-limit "$API" "$TOKEN_FILE" || fail "a read past the node-side ceiling was not answered 503 STORE_INTERNAL_LIMIT"
sleep 1
if ! tail -c "+$((log_offset + 1))" "$LOG_FILE" | grep "$LIMIT_NAME" >/dev/null; then
  fail "node${target} logged no line naming ${LIMIT_NAME} for the read"
fi

say "PASS"
