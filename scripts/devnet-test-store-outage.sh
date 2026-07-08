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
# How: SIGSTOP one core's daemon-managed oxigraph-server process to simulate a
# transient outage (fully reversible — no restart, no data loss), publish from
# an EDGE node, assert the publish confirms AND the paused core logs the typed
# decline, then SIGCONT and assert the cluster publishes again.
#
# TOPOLOGY — why the publisher defaults to an EDGE node (otReviewAgent #1517):
# `minimumRequiredSignatures` is pinned to 3 on the devnet chain and a publisher
# does NOT sign its own quorum (scripts/devnet.sh, "Pin minimumRequiredSignatures"
# note). On the default `./scripts/devnet.sh start 6` layout (cores 1-4, edges
# 5-6) a CORE publisher that pauses one other core leaves only 2 healthy peer
# cores — quorum impossible. An EDGE publisher keeps all 4 cores as ACK
# candidates, so pausing one leaves exactly the 3 the quorum needs (the same
# shape devnet/ack-candidate-isolation and devnet/agent-provenance exercise).
# The script also recomputes that arithmetic against the LIVE topology and
# SKIPs before pausing anything when it cannot hold.
#
# TYPED DECLINE — why it is a HARD assertion (otReviewAgent #1517): the
# publisher dials EVERY connected core peer concurrently at the start of the
# ACK round (packages/publisher/src/ack-collector.ts runACKRound), so the
# paused core always receives the request. Its store read then hangs until the
# sparql-http client timeout (default 30s) and the handler logs
# `V10 StorageACK declined: code=CORE_TEMPORARILY_UNAVAILABLE ...`
# (packages/agent dkg-agent-lifecycle onDecline). Dead-air here IS the incident
# regression this suite exists to catch, so the script polls the target's log
# for up to DECLINE_WAIT_SECS and FAILS if the decline never appears — a green
# run proves quorum-with-outage AND the typed decline, not just quorum.
#
# SAFETY — never signal a process we cannot prove is ours (otReviewAgent
# #1517): only cores on the daemon-managed `oxigraph-server` backend are
# eligible targets. The daemon spawns that server as
#   oxigraph serve --location <node_dir>/oxigraph-data --bind 127.0.0.1:<port>
# (packages/cli/src/daemon/oxigraph-server.ts), so before SIGSTOP we require:
#   1. the target node's /api/status answers — a live daemon proves the config
#      the port was read from is current, not a stale .devnet leftover;
#   2. exactly ONE process LISTENs on that port (ambiguity → no signal);
#   3. its command line contains `oxigraph`, the target node's own directory,
#      and `:<port>` — positively tying the PID to THIS node's managed store.
# Anything else → SKIP (exit 0), no signal. Shared Blazegraph and in-process
# oxigraph cannot isolate one core's store, and a `sparql-http` listener is
# Docker infrastructure (docker-proxy) that cannot be attributed to a devnet
# node — neither is ever signaled.
#
# Exit codes: 0 = PASS or SKIP (precondition unmet); non-zero = real failure.
# A paused store is ALWAYS resumed on exit, including mid-assert failures.
#
# Env knobs: DEVNET_DIR, API_PORT_BASE, DEVNET_CONTEXT_GRAPH,
#   STORE_OUTAGE_PUBLISHER (node number; default = first responsive edge),
#   STORE_OUTAGE_TARGET (node number; default = first eligible core, preferring
#   not-node1 so the mesh anchor / default curator stays pristine),
#   STORE_OUTAGE_MIN_SIG (default 3), STORE_OUTAGE_DECLINE_WAIT_SECS (default 75).
#
# Run standalone (against a running devnet):  scripts/devnet-test-store-outage.sh
# Or via the suite:                           pnpm test:devnet:storage-ack-store-outage
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
DKG_API_MAXTIME="${DKG_API_MAXTIME:-90}"   # per-call curl budget for devnet-lib api()
CONTEXT_GRAPH="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
MIN_SIG="${STORE_OUTAGE_MIN_SIG:-3}"       # devnet.sh pins minimumRequiredSignatures=3
DECLINE_WAIT_SECS="${STORE_OUTAGE_DECLINE_WAIT_SECS:-75}"  # ≥ 30s store timeout + dial/log slack

say()  { echo "[store-outage] $*"; }
skip() { echo "[store-outage] SKIP: $*"; exit 0; }
fail() { echo "[store-outage] FAIL: $*" >&2; exit 1; }   # EXIT trap resumes the store

STORE_PID=""
STORE_CMD=""
cleanup() {
  # Always resume a paused store so a failure never leaves the devnet wedged.
  # Idempotent (STORE_PID is cleared) and re-verifies the command line so a
  # PID is never CONTed after it stopped being the process we paused.
  if [ -n "$STORE_PID" ]; then
    local now_cmd
    now_cmd="$(ps -p "$STORE_PID" -o args= 2>/dev/null || true)"
    if [ -n "$now_cmd" ] && [ "$now_cmd" = "$STORE_CMD" ]; then
      kill -CONT "$STORE_PID" 2>/dev/null || true
    fi
    STORE_PID=""
  fi
}
trap cleanup EXIT
trap 'cleanup; trap - EXIT; exit 130' INT TERM

# --- preconditions -----------------------------------------------------------
[ -d "$DEVNET_DIR" ] || skip "no devnet at $DEVNET_DIR (start one first: ./scripts/devnet.sh start 6)"
command -v lsof >/dev/null 2>&1 || skip "lsof not available (needed to find the store process)"

# Canonical devnet helpers (otReviewAgent #1517: reuse the shared harness, don't
# grow another local auth/curl/JSON variant): node_token, node_port, api(),
# code_of/body_of, field(). Contract: DEVNET_DIR + API_PORT_BASE set above.
# shellcheck source=devnet-lib.sh
. "$REPO_ROOT/scripts/devnet-lib.sh" || skip "cannot source scripts/devnet-lib.sh"

node_up() { [ "$(code_of "$(api "$1" GET /api/status)")" = "200" ]; }

# --- live topology (one structured parser — otReviewAgent #1517: no shell-quoted
# JS expressions). One line per node dir: "<n> <role> <backend> <port>", where
# <port> is only set for the daemon-managed oxigraph-server backend (default
# bind port 7878 when options.port is unset — oxigraph-managed.ts). ------------
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
    const role = c.nodeRole === "core" ? "core" : "edge";
    const backend = (c.store && c.store.backend) || "";
    let port = "";
    if (backend === "oxigraph-server") {
      port = String((c.store.options && c.store.options.port) || 7878);
    }
    rows.push([Number(m[1]), role, backend || "-", port || "-"]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  process.stdout.write(rows.map((r) => r.join(" ")).join("\n"));
' "$DEVNET_DIR")"
[ -n "$topology" ] || skip "no node<N>/config.json found under $DEVNET_DIR"

node_ids=()
role_of=()
backend_of=()
port_of=()
while read -r n role backend port; do
  [ -n "$n" ] || continue
  node_ids+=("$n")
  role_of[$n]="$role"
  backend_of[$n]="$backend"
  port_of[$n]="$port"
done <<<"$topology"

# --- publisher: an EDGE node so every core stays an ACK candidate -------------
PUBLISHER_NODE="${STORE_OUTAGE_PUBLISHER:-}"
if [ -n "$PUBLISHER_NODE" ]; then
  case "$PUBLISHER_NODE" in (*[!0-9]*|'') skip "STORE_OUTAGE_PUBLISHER='$PUBLISHER_NODE' is not a node number" ;; esac
  [ -n "${role_of[$PUBLISHER_NODE]:-}" ] || skip "no node${PUBLISHER_NODE}/config.json under $DEVNET_DIR (STORE_OUTAGE_PUBLISHER)"
  node_up "$PUBLISHER_NODE" || skip "requested publisher node${PUBLISHER_NODE} API not responding on $(node_port "$PUBLISHER_NODE")"
else
  for n in "${node_ids[@]}"; do
    [ "${role_of[$n]}" = "edge" ] || continue
    if node_up "$n"; then PUBLISHER_NODE="$n"; break; fi
  done
  [ -n "$PUBLISHER_NODE" ] || skip "no responsive EDGE node found — the publisher must be an edge so all cores remain ACK candidates (./scripts/devnet.sh start 6 gives edges 5-6). To publish from a core instead, set STORE_OUTAGE_PUBLISHER on a devnet with ≥ $((MIN_SIG + 2)) cores."
fi

# --- target: a non-publisher core on the daemon-managed oxigraph-server -------
candidates=()
for n in "${node_ids[@]}"; do
  [ "$n" = "$PUBLISHER_NODE" ] && continue
  [ "${role_of[$n]}" = "core" ] || continue
  [ "${backend_of[$n]}" = "oxigraph-server" ] || continue
  [ "${port_of[$n]}" != "-" ] || continue
  candidates+=("$n")
done

target_node=""
if [ -n "${STORE_OUTAGE_TARGET:-}" ]; then
  for c in ${candidates[@]+"${candidates[@]}"}; do
    [ "$c" = "$STORE_OUTAGE_TARGET" ] && target_node="$c"
  done
  [ -n "$target_node" ] || skip "STORE_OUTAGE_TARGET=node${STORE_OUTAGE_TARGET} is not a non-publisher core on the oxigraph-server backend (eligible: ${candidates[*]:-none})"
else
  # Prefer a target other than node1: node1 is the mesh anchor and the default
  # publisher/curator for other devnet tooling — keep it pristine when we can.
  for c in ${candidates[@]+"${candidates[@]}"}; do
    if [ "$c" != "1" ]; then target_node="$c"; break; fi
  done
  [ -n "$target_node" ] || target_node="${candidates[0]:-}"
fi
[ -n "$target_node" ] || skip "no non-publisher core uses the daemon-managed oxigraph-server backend — cannot isolate (and positively identify) one core's store. Shared Blazegraph / in-process oxigraph can't be paused per-core, and sparql-http listeners are Docker infra we refuse to signal. Default './scripts/devnet.sh start 6' puts oxigraph-server on cores 1-2."

target_dir="$DEVNET_DIR/node${target_node}"
target_log="$target_dir/daemon.log"
target_port="${port_of[$target_node]}"
say "target core = node${target_node} (oxigraph-server on port ${target_port}); publisher = ${role_of[$PUBLISHER_NODE]} node${PUBLISHER_NODE}"

# --- quorum arithmetic: enough healthy peer cores must remain -----------------
# A publisher does not sign its own quorum, so after pausing the target the
# publish needs MIN_SIG ACKs from OTHER healthy cores (otReviewAgent #1517).
healthy_peer_cores=0
for n in "${node_ids[@]}"; do
  [ "$n" = "$target_node" ] && continue
  [ "$n" = "$PUBLISHER_NODE" ] && continue
  [ "${role_of[$n]}" = "core" ] || continue
  if node_up "$n"; then healthy_peer_cores=$((healthy_peer_cores + 1)); fi
done
[ "$healthy_peer_cores" -ge "$MIN_SIG" ] || skip "only ${healthy_peer_cores} healthy non-target peer core(s) would remain but the publish needs ${MIN_SIG} StorageACKs (the publisher's own ACK does not count) — quorum could not form during the outage. Start './scripts/devnet.sh start 6' (4 cores + edge publisher) or add cores."
say "quorum check: ${healthy_peer_cores} healthy peer cores remain for the ${MIN_SIG}-ACK quorum with node${target_node} paused"

# --- positively identify the store process before signaling it ----------------
node_up "$target_node" || skip "target core node${target_node} API not responding on $(node_port "$target_node") — the .devnet config may be stale; refusing to signal any process by port"

store_pids="$(lsof -ti "tcp:${target_port}" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
[ -n "$store_pids" ] || skip "no process is LISTENing on the store port ${target_port} for node${target_node}"
[ "$(echo "$store_pids" | wc -l | tr -d ' ')" = "1" ] || skip "multiple processes LISTEN on port ${target_port} ($(echo "$store_pids" | tr '\n' ' ')) — ambiguous; refusing to signal"
STORE_PID="$store_pids"

STORE_CMD="$(ps -p "$STORE_PID" -o args= 2>/dev/null || true)"
[ -n "$STORE_CMD" ] || STORE_CMD="$(ps -p "$STORE_PID" -o command= 2>/dev/null || true)"
target_dir_phys="$(cd "$target_dir" 2>/dev/null && pwd -P || echo "$target_dir")"
case "$STORE_CMD" in
  *oxigraph*) : ;;
  *) STORE_PID=""; skip "process ${store_pids} on port ${target_port} is not an oxigraph server (cmd: ${STORE_CMD:-unknown}) — refusing to SIGSTOP an unidentified process" ;;
esac
case "$STORE_CMD" in
  *"$target_dir"*|*"$target_dir_phys"*) : ;;
  *) STORE_PID=""; skip "oxigraph process ${store_pids} on port ${target_port} does not reference node${target_node}'s directory (cmd: ${STORE_CMD}) — not this node's managed store; refusing to signal" ;;
esac
case "$STORE_CMD" in
  *":${target_port}"*) : ;;
  *) STORE_PID=""; skip "oxigraph process ${store_pids} command line does not bind :${target_port} (cmd: ${STORE_CMD}) — refusing to signal" ;;
esac
say "store process pid = ${STORE_PID} (cmd: ${STORE_CMD})"

# --- publish helper (structured daemon API, not CLI text — otReviewAgent #1517)
# Mirrors devnet-soak.sh publish_ka: named-KA lifecycle create → wm/write →
# wm/finalize → swm/share → vm/publish. The synchronous vm/publish route answers
# HTTP 200 ONLY for a confirmed publish (207 partial / 502 tentative-or-failed —
# routes/knowledge-assets.ts classifyVmPublish), and 'confirmed' is only set
# after the real ACK-quorum + on-chain submit, so the assertion is structural
# rather than a display-format grep.
PUBLISH_CODE=""; PUBLISH_STATUS=""; PUBLISH_KAID=""; PUBLISH_BODY=""
publish_ka() { # <tag> -> 0 on confirmed publish; sets PUBLISH_CODE/STATUS/KAID/BODY
  local tag="$1" name subj r
  name="store-outage-${tag}-$(date +%s)-$$"
  subj="urn:store-outage:${tag}:$(date +%s)"
  api "$PUBLISHER_NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$name\"}" >/dev/null
  api "$PUBLISHER_NODE" POST "/api/knowledge-assets/$name/wm/write" \
    "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"quads\":[{\"subject\":\"$subj\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"store outage $tag\\\"\",\"graph\":\"\"}]}" >/dev/null
  api "$PUBLISHER_NODE" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" >/dev/null
  api "$PUBLISHER_NODE" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" >/dev/null
  r=$(api "$PUBLISHER_NODE" POST "/api/knowledge-assets/$name/vm/publish" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
  PUBLISH_CODE="$(code_of "$r")"
  PUBLISH_BODY="$(body_of "$r")"
  PUBLISH_STATUS="$(field "$PUBLISH_BODY" status)"
  PUBLISH_KAID="$(field "$PUBLISH_BODY" kaId)"
  [ "$PUBLISH_CODE" = "200" ] && [ "$PUBLISH_STATUS" = "confirmed" ] && [ -n "$PUBLISH_KAID" ]
}

# --- 1. outage: publish must confirm AND the target must decline (typed) ------
log_before=0
[ -f "$target_log" ] && log_before="$(wc -l < "$target_log" | tr -d ' ')"

say "pausing node${target_node}'s store (SIGSTOP ${STORE_PID}) ..."
kill -STOP "$STORE_PID"

say "publishing during the outage (from node${PUBLISHER_NODE}) ..."
if ! publish_ka outage; then
  fail "publish did NOT confirm during a single-core store outage (HTTP ${PUBLISH_CODE:-?}, status '${PUBLISH_STATUS:-?}') — quorum should have formed on the ${healthy_peer_cores} healthy cores. Response: ${PUBLISH_BODY:-<none>}"
fi
say "OK: publish confirmed via the healthy cores while node${target_node}'s store was down (kaId=${PUBLISH_KAID})"

# The paused core was dialed at ACK-round start (the collector dials every
# connected core concurrently); its store read hangs until the ~30s sparql-http
# client timeout, THEN the typed decline is logged. Poll for it — absence is
# the dead-air incident regression, so it FAILS the suite (otReviewAgent #1517).
say "waiting up to ${DECLINE_WAIT_SECS}s for node${target_node}'s typed decline (store reads hang until the ~30s client timeout) ..."
declined=""
waited=0
while [ "$waited" -lt "$DECLINE_WAIT_SECS" ]; do
  if [ -f "$target_log" ]; then
    declined="$(tail -n "+$((log_before + 1))" "$target_log" 2>/dev/null | grep -a 'StorageACK declined.*CORE_TEMPORARILY_UNAVAILABLE' | head -1 || true)"
    [ -n "$declined" ] && break
  fi
  sleep 3
  waited=$((waited + 3))
done
if [ -z "$declined" ]; then
  fail "node${target_node} logged NO typed 'StorageACK declined: code=CORE_TEMPORARILY_UNAVAILABLE' within ${DECLINE_WAIT_SECS}s of the outage publish — the paused core dead-aired (or was never dialed), which is exactly the incident regression this suite exists to catch. Log: $target_log"
fi
say "OK: node${target_node} returned a typed CORE_TEMPORARILY_UNAVAILABLE decline:"
echo "$declined" | sed 's/^/[store-outage][decline] /'

# --- 2. recovery: store resumes, cluster keeps publishing ---------------------
say "resuming node${target_node}'s store (SIGCONT ${STORE_PID}) ..."
kill -CONT "$STORE_PID"
STORE_PID=""   # resumed; disarm the cleanup pause

# Informational probe that the SPARQL endpoint answers again (the functional
# recovery check is the publish below).
recovered=false
for _ in $(seq 1 20); do
  if curl -sf --max-time 3 "http://127.0.0.1:${target_port}/query?query=ASK%20%7B%7D" \
       -H 'Accept: application/sparql-results+json' >/dev/null 2>&1; then
    recovered=true
    break
  fi
  sleep 1
done
$recovered || say "note: store port ${target_port} did not answer an ASK probe within 20s; continuing to the functional recovery check"

say "publishing after recovery (from node${PUBLISHER_NODE}) ..."
if ! publish_ka recovery; then
  fail "publish did NOT confirm after the store recovered (HTTP ${PUBLISH_CODE:-?}, status '${PUBLISH_STATUS:-?}'). Response: ${PUBLISH_BODY:-<none>}"
fi
say "OK: publish confirmed after node${target_node}'s store recovered (kaId=${PUBLISH_KAID})"

say "PASS"
exit 0
