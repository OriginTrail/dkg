#!/usr/bin/env bash
#
# storage-ack-store-outage — the PRIMARY 2026-07-07 mainnet incident cause, and
# the G1 devnet gap (no coverage for a store failing mid-publish).
#
# On mainnet a core's Blazegraph went unreachable under the sync storm; the
# core's StorageACK handler then failed to read the SWM data and — before the
# fixes — dead-aired past the publisher's 20s timeout, so the publisher
# mislabeled the empty reply INVALID_SIGNATURE and the whole round burned. The
# fixes make that path graceful: the handler returns a TYPED
# CORE_TEMPORARILY_UNAVAILABLE decline, the publish still reaches quorum via the
# HEALTHY cores, and the core ACKs again once its store recovers.
#
# Unit tests prove the handler RETURNS that decline when its store throws, but
# they mock the store. This script covers the INTEGRATION the incident actually
# exercised: a REAL store going down mid-publish, end-to-end across live nodes.
#
# How: we target ONE core that uses a per-node HTTP store (oxigraph-server /
# sparql-http on devnet), SIGSTOP its store process to simulate a transient
# outage (fully reversible — no restart, no data loss), publish, assert, then
# SIGCONT to recover. Shared-Blazegraph / in-process-oxigraph clusters can't
# isolate one core's store, so the script SKIPs (exit 0) with guidance.
#
# Exit codes: 0 = PASS or SKIP (precondition unmet); non-zero = real failure.
#
# Run standalone (against a running devnet):  scripts/devnet-test-store-outage.sh
# Or via the suite:                           pnpm test:devnet:storage-ack-store-outage
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NUM_CORE_NODES="${NUM_CORE_NODES:-4}"
CLI="$REPO_ROOT/packages/cli/dist/cli.js"
CONTEXT_GRAPH="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
PUBLISHER_NODE="${STORE_OUTAGE_PUBLISHER:-1}"   # node that issues the publishes

say()  { echo "[store-outage] $*"; }
skip() { echo "[store-outage] SKIP: $*"; exit 0; }
fail() { echo "[store-outage] FAIL: $*" >&2; cleanup; exit 1; }

STORE_PID=""
cleanup() {
  # Always resume a paused store so a failure never leaves the devnet wedged.
  if [ -n "$STORE_PID" ] && kill -0 "$STORE_PID" 2>/dev/null; then
    kill -CONT "$STORE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- preconditions ----------------------------------------------------------
[ -d "$DEVNET_DIR" ] || skip "no devnet at $DEVNET_DIR (start one first)"
[ -f "$CLI" ] || skip "no built CLI at $CLI (pnpm build)"
command -v lsof >/dev/null 2>&1 || skip "lsof not available (needed to find the store process)"

node1_dir="$DEVNET_DIR/node${PUBLISHER_NODE}"
pub_port=$((API_PORT_BASE + PUBLISHER_NODE - 1))
auth_token=""
[ -f "$node1_dir/auth.token" ] && auth_token="$(tail -1 "$node1_dir/auth.token" 2>/dev/null || echo "")"
auth_hdr=()
[ -n "$auth_token" ] && auth_hdr=(-H "Authorization: Bearer $auth_token")

curl -sf "${auth_hdr[@]}" "http://127.0.0.1:${pub_port}/api/status" >/dev/null 2>&1 \
  || skip "publisher node${PUBLISHER_NODE} API not responding on ${pub_port}"

# Read a JSON field from a node config with node (no jq dependency).
cfg_field() { # <node_dir> <js-expr on `c`>
  node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1]+'/config.json','utf8'));process.stdout.write(String((()=>{return $2})()??''))}catch(e){process.stdout.write('')}" "$1"
}

# --- pick a target core with a per-node HTTP store --------------------------
target_node=""
target_port=""
for n in $(seq 1 "$NUM_CORE_NODES"); do
  if [ "$n" = "$PUBLISHER_NODE" ]; then continue; fi   # keep the publisher healthy
  ndir="$DEVNET_DIR/node${n}"
  [ -d "$ndir" ] || continue
  role="$(cfg_field "$ndir" 'c.nodeRole')"
  [ "$role" = "core" ] || continue
  backend="$(cfg_field "$ndir" 'c.store&&c.store.backend')"
  case "$backend" in
    oxigraph-server)
      target_port="$(cfg_field "$ndir" 'c.store.options&&c.store.options.port')" ;;
    sparql-http)
      # queryEndpoint like http://127.0.0.1:7878/query
      target_port="$(cfg_field "$ndir" '(c.store.options&&c.store.options.queryEndpoint||"").replace(/.*:(\\d+).*/,"$1")')" ;;
    *)
      continue ;;
  esac
  if [ -n "$target_port" ]; then target_node="$n"; break; fi
done

[ -n "$target_node" ] || skip "no non-publisher core uses a per-node HTTP store (oxigraph-server/sparql-http) — cannot isolate one store. Start the devnet so a core (e.g. node 2) runs the oxigraph-server backend."

target_dir="$DEVNET_DIR/node${target_node}"
target_log="$target_dir/daemon.log"
target_api=$((API_PORT_BASE + target_node - 1))
say "target core = node${target_node} (store on port ${target_port}); publisher = node${PUBLISHER_NODE}"

# SAFETY (otReviewAgent #1517): we are about to send process-control signals to
# whatever is on ${target_port}. A stale .devnet dir could point at a port some
# UNRELATED local service now owns, and we must never SIGSTOP that. Two guards:
#
#   1. The target node must actually be RUNNING — its /api/status must answer.
#      A live node proves the config we read the port from is current, not stale.
#      (/api/status is unauthenticated, matching the devnet harness.)
#   2. The process on the port must LOOK like a triple store (oxigraph /
#      blazegraph / sparql / java). If it doesn't, we refuse to signal it.
#
# If either guard fails the script SKIPs (exit 0) rather than touching a process
# it can't positively identify as this node's store.
curl -sf "http://127.0.0.1:${target_api}/api/status" >/dev/null 2>&1 \
  || skip "target core node${target_node} API not responding on ${target_api} — the .devnet config may be stale; refusing to signal any process by port"

STORE_PID="$(lsof -ti "tcp:${target_port}" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
[ -n "$STORE_PID" ] || skip "no process is LISTENing on the store port ${target_port} for node${target_node}"

store_cmd="$(ps -p "$STORE_PID" -o args= 2>/dev/null || true)"
[ -n "$store_cmd" ] || store_cmd="$(ps -p "$STORE_PID" -o command= 2>/dev/null || true)"
case "$store_cmd" in
  *oxigraph*|*blazegraph*|*sparql*|*java*) : ;;   # recognized triple-store process
  *) skip "process ${STORE_PID} on port ${target_port} does not look like a triple store (cmd: ${store_cmd:-unknown}) — refusing to SIGSTOP an unidentified process" ;;
esac
say "store process pid = ${STORE_PID} (cmd: ${store_cmd})"

# --- publish helper ---------------------------------------------------------
publish_ka() { # <name-suffix> -> prints combined CLI output; returns publish exit code
  local suffix="$1"
  local name="store-outage-${suffix}-$(node -e 'process.stdout.write(Date.now().toString(36))')"
  local triples='[{"subject":"https://example.org/store-outage/'"${suffix}"'","predicate":"http://schema.org/name","object":"\"store outage '"${suffix}"'\""}]'
  DKG_HOME="$node1_dir" node "$CLI" ka create "$name" \
    --context-graph-id "$CONTEXT_GRAPH" --triples "$triples" --share >/dev/null 2>&1 || return 1
  DKG_HOME="$node1_dir" node "$CLI" ka publish "$name" --context-graph-id "$CONTEXT_GRAPH" 2>&1
}

# --- 1. outage: publish must still confirm; target must decline gracefully ---
log_before=0
[ -f "$target_log" ] && log_before="$(wc -l < "$target_log" | tr -d ' ')"

say "pausing node${target_node}'s store (SIGSTOP ${STORE_PID}) ..."
kill -STOP "$STORE_PID"

say "publishing during the outage ..."
out="$(publish_ka outage || true)"
echo "$out" | sed 's/^/[store-outage][publish] /'

echo "$out" | grep -qiE 'Status:[[:space:]]*(confirmed|finalized)' \
  || fail "publish did NOT confirm during a single-core store outage — quorum should have formed on the healthy cores"
echo "$out" | grep -qiE 'K[AC] ID:[[:space:]]*[0-9]+' \
  || fail "publish reported no positive KA ID during the outage"
say "OK: publish confirmed via the healthy cores while node${target_node}'s store was down"

# The paused core should have logged a TYPED transient decline (not dead-air /
# crash). Give it a moment for the ACK round + the handler deadline to elapse.
sleep 3
declined=""
if [ -f "$target_log" ]; then
  declined="$(tail -n "+$((log_before + 1))" "$target_log" 2>/dev/null | grep -a 'CORE_TEMPORARILY_UNAVAILABLE' | head -1 || true)"
fi
if [ -n "$declined" ]; then
  say "OK: node${target_node} returned a typed CORE_TEMPORARILY_UNAVAILABLE decline:"
  echo "$declined" | sed 's/^/[store-outage][decline] /'
else
  # Non-fatal: on this run the publisher may have reached quorum before dialing
  # the paused core (dial order is latency-driven), so the decline needn't
  # appear. The load-bearing assertion is that the publish still confirmed.
  say "note: no CORE_TEMPORARILY_UNAVAILABLE line from node${target_node} this run (publisher likely reached quorum before dialing it) — the confirm above is the pass condition"
fi

# --- 2. recovery: store resumes, cluster keeps publishing -------------------
say "resuming node${target_node}'s store (SIGCONT ${STORE_PID}) ..."
kill -CONT "$STORE_PID"
STORE_PID=""   # resumed; disarm the cleanup pause

# Wait for the store endpoint to answer again.
recovered=false
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:${target_port}/query?query=$(node -e 'process.stdout.write(encodeURIComponent("ASK{}"))')" >/dev/null 2>&1 \
     || curl -sf "http://127.0.0.1:${target_port}/" >/dev/null 2>&1; then
    recovered=true; break
  fi
  sleep 1
done
$recovered || say "note: store port ${target_port} did not answer a probe within 20s (endpoint path may differ); continuing to the functional recovery check"

say "publishing after recovery ..."
out2="$(publish_ka recovery || true)"
echo "$out2" | sed 's/^/[store-outage][publish] /'
echo "$out2" | grep -qiE 'Status:[[:space:]]*(confirmed|finalized)' \
  || fail "publish did NOT confirm after the store recovered"
say "OK: publish confirmed after node${target_node}'s store recovered"

say "PASS"
exit 0
