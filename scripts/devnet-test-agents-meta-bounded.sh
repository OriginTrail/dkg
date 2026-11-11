#!/usr/bin/env bash
#
# #1234 (fixes #1233) — agents/_meta growth is BOUNDED: devnet proof.
#
# Before #1234, every agent-profile heartbeat appended a per-publish tentative
# tracking record to `<agents>/_meta` keyed by a fresh UAL, never pruned, gossip-
# fanned per peer — growing without bound (~386 records/agent observed). #1234
# suppresses that write at the two highest-volume paths (gossip receiver + local
# publish terminal) gated on isAgentRegistryContextGraph(), while the agent
# profile DATA still lands in the data graph.
#
# This asserts on a running fleet that the AGENT REGISTRY DATA graph is populated
# (profiles present) while `<agents>/_meta` stays bounded (no tentative-record
# accumulation). This is the lightweight static check; a longer-running variant
# can force a small heartbeat (config.network.agentProfileHeartbeatMs) and assert
# zero growth across N heartbeats.
#
# Requires a running devnet (./scripts/devnet.sh start 6). Self-contained and
# read-only. Registered in scripts/devnet-comprehensive.sh (group "regression"),
# late in the run: the longer the fleet has been heartbeating, the more the
# bound means.
#   Run:  ./scripts/devnet-test-agents-meta-bounded.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NUM_NODES="${NUM_NODES:-6}"
META_MAX="${META_MAX:-50}"   # generous ceiling; pre-#1234 bloat was hundreds/agent

PASS=0; FAIL=0
log() { echo "[agents-meta] $*"; }
ok()  { echo "[agents-meta]   PASS: $*"; PASS=$((PASS+1)); }
bad() { echo "[agents-meta]   FAIL: $*" >&2; FAIL=$((FAIL+1)); }

# shared node auth / HTTP / JSON helpers (node_token, node_port, api, field, …)
. "$REPO_ROOT/scripts/devnet-lib.sh" || { echo "[agents-meta] FATAL: cannot source devnet-lib.sh" >&2; exit 2; }

# validated query observations: an error answer is never read as a count
. "$REPO_ROOT/scripts/devnet-observation-helpers.sh" || { echo "[agents-meta] FATAL: cannot source devnet-observation-helpers.sh" >&2; exit 2; }

# node graph -> integer count ("" when the node gave no valid count).
# The query is scoped to the agents context graph: since v10.0.17 a node answers
# an unscoped query only on a store with all-writer consistency coverage, and a
# scoped query may name the graph itself and its `_meta` (any other graph is
# refused, not read as empty).
qcount() {
  local n="$1" g="$2"
  devnet_query_api "http://127.0.0.1:$(node_port "$n")" "$(node_token "$n")" \
    "SELECT (COUNT(*) AS ?c) WHERE { GRAPH <$g> { ?s ?p ?o } }" c count '{"contextGraphId":"agents"}' 2>/dev/null || true
}

AG='did:dkg:context-graph:agents'
META='did:dkg:context-graph:agents/_meta'

# A devnet that is down / under-provisioned must FAIL, not silently pass: every
# expected fleet member is required. Missing token, unreachable node, or an
# unreadable _meta count are all failures (not skips), and the run fails if it
# checked fewer than NUM_NODES. NB an empty _meta graph returns COUNT "0" (a
# value), so a healthy-but-quiet fleet still passes — only a query *failure*
# yields "" and trips the unreadable guard.
CHECKED=0
for n in $(seq 1 "$NUM_NODES"); do
  if [ ! -f "$DEVNET_DIR/node$n/auth.token" ]; then
    bad "node$n: no auth.token — expected fleet member not provisioned (is './scripts/devnet.sh start $NUM_NODES' up?)"
    continue
  fi
  DATA=$(qcount "$n" "$AG"); MT=$(qcount "$n" "$META")
  if [ -z "$DATA" ]; then
    bad "node$n unreachable — agent-registry DATA query failed (node down?)"
    continue
  fi
  CHECKED=$((CHECKED+1))
  if [ "$DATA" -gt 0 ] 2>/dev/null; then
    ok "node$n agent-registry DATA populated ($DATA quads)"
  else
    bad "node$n agent-registry DATA empty (expected profiles) — phonebook not replicating?"
  fi
  if [ -z "$MT" ]; then
    bad "node$n agents/_meta count unreadable (query failed) — cannot prove bounded"
  elif [ "$MT" -le "$META_MAX" ] 2>/dev/null; then
    ok "node$n agents/_meta BOUNDED ($MT <= $META_MAX; #1234 suppression holding)"
  else
    bad "node$n agents/_meta UNBOUNDED ($MT > $META_MAX) — #1234 regression"
  fi
done

echo
log "──────── SUMMARY ────────"
log "CHECKED=$CHECKED/$NUM_NODES  PASS=$PASS  FAIL=$FAIL  (META_MAX=$META_MAX)"
if [ "$CHECKED" -eq 0 ]; then
  log "NO NODES CHECKED — devnet not running or DEVNET_DIR wrong (expected $NUM_NODES nodes at $DEVNET_DIR)"
  log "SOME CHECKS FAILED"; exit 1
fi
if [ "$CHECKED" -lt "$NUM_NODES" ]; then
  bad "only $CHECKED/$NUM_NODES expected nodes were checked (missing/unreachable members above)"
fi
[ "$FAIL" -eq 0 ] && { log "ALL AGENTS-META CHECKS PASSED ($CHECKED/$NUM_NODES nodes)"; exit 0; } || { log "SOME CHECKS FAILED"; exit 1; }
