#!/usr/bin/env bash
#
# OT-RFC-38 — LATE-JOINER test.
#
# Exercises the realistic distributed pattern that downstream UX
# depends on: a new member can catch up the FULL history of a
# curated CG even when the curator is offline, as long as ANY
# other current member is reachable.
#
# Private SWM travels directly between authorized members. Cores do not
# retain curated ciphertext under the current strip policy; this suite
# checks member recovery and the zero-custody boundary together.
#
# Five scenarios:
#
#   SCENARIO A — member-from-curator catchup (baseline, curator online):
#     • Curator (N5) creates curated CG with [N5, N6] in allowlist.
#     • Curator writes 5 SWM triples.
#     • N6 (pre-existing member) catches up directly from N5.
#     • Asserts: N6 inserts 5 triples + can query them.
#
#   SCENARIO B — member-from-member catchup (curator offline):
#     • Curator (N5) creates a SECOND curated CG with [N5, N6, N3]
#       in allowlist. (N3 is a core, used as a third member here.)
#     • Curator writes 7 SWM triples. N6 receives them via live
#       gossip (live multi-member topology).
#     • Curator goes OFFLINE (kill node 5).
#     • N3 (third member) calls catchup against N6 (second member).
#       Asserts: N3 sees 7 triples via query — proves
#       any current member can serve any other member.
#     • Curator comes back online for the rest of the suite.
#
#   SCENARIO C — outsider catchup (no private core custody,
#                expected fail-soft):
#     • Curator (N5) creates a THIRD curated CG with [N5, N3] in
#       allowlist. (N6 is NOT a member.)
#     • Curator writes 4 SWM triples.
#     • Curator goes OFFLINE.
#     • N6 (non-member, pretending to be a late joiner who somehow
#       discovered the CG) tries to catch up from the cores only.
#     • Asserts: cores serve no private history, N6 applies zero,
#       and the endpoint returns cleanly without leaking graph data.
#     • Curator comes back online.
#
#   SCENARIO D — private member reconnect under the current transport:
#     • Curator (N5) writes 1 triple while N6 is online, then 5 while
#       N6 is offline. A manual host-mode subscribe on cores cannot
#       override the private-ciphertext strip.
#     • With curator offline, N6 restarts and still has only 1 triple;
#       the cores hold zero private ciphertext for this graph.
#     • Once curator returns, N6 catches up all 6 triples from that
#       authorized member and verifies them through SPARQL.
#
#   SCENARIO E — chain/beacon auto-host cannot retain private data:
#     • Create a second registered private CG without a manual core
#       subscription, share a triple to its member, and confirm cores
#       have zero host-mode entries for that graph.
#
# Uses daemon HTTP APIs plus local devnet configs and multiaddrs.
# Re-runnable: every CG id is timestamp-suffixed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
MEMBER_NODE=6
THIRD_MEMBER_NODE=3
OUTSIDER_NODE=1
CORE_NODES=(1 2 3 4)

log()  { echo "[lj] $*"; }
warn() { echo "[lj] WARN: $*" >&2; }
fail() { echo "[lj] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[lj] === $1 ==="; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_agent_token() {
  local node="$1"
  AGENT_KEYSTORE="$(node_dir "$node")/agent-keystore.json" node -e '
    const fs = require("fs");
    try {
      const records = Object.values(JSON.parse(fs.readFileSync(process.env.AGENT_KEYSTORE, "utf8")));
      const token = records.find((record) => typeof record?.authToken === "string")?.authToken ?? "";
      process.stdout.write(token);
    } catch {
      process.stdout.write("");
    }
  '
}
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }
node_pidfile(){ echo "$(node_dir "$1")/daemon.pid"; }
node_log()    { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token="${DEVNET_API_TOKEN_OVERRIDE:-$(node_token "$node")}"
  local -a curl_args=(-sS --max-time 180 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

api_call_agent() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local token; token="$(node_agent_token "$node")"
  [ -n "$token" ] || token="$(node_token "$node")"
  DEVNET_API_TOKEN_OVERRIDE="$token" api_call "$node" "$method" "$path" "$data"
}

devnet_create_shared_ka_agent() {
  local node="$1" payload="$2" name_prefix="${3:-devnet-ka}" extra_fields="${4:-}"
  local token; token="$(node_agent_token "$node")"
  [ -n "$token" ] || token="$(node_token "$node")"
  DEVNET_API_TOKEN_OVERRIDE="$token" devnet_create_shared_ka "$node" "$payload" "$name_prefix" "$extra_fields"
}

parse_json() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch (e) { process.exit(1); }
    })
  "
}

# Extract the bare numeric value from a SPARQL bindings response so
# `"5"^^<...XMLSchema#integer>` becomes `5`. Helps avoid leaking
# RDF literal type quoting into shell-side numeric comparisons.
sparql_count() {
  printf '%s' "$1" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try {
        const j = JSON.parse(d);
        const b = (j && j.result && j.result.bindings && j.result.bindings[0]) || {};
        const raw = b.n || b.cnt || b.count || "";
        const m = String(raw).match(/^"?(-?\d+)"?/);
        console.log(m ? m[1] : "");
      } catch { console.log(""); }
    });
  '
}

wait_for_node_down() {
  local node="$1"
  local port; port=$(node_port "$node")
  for _ in $(seq 1 60); do
    if ! curl -s --max-time 1 -o /dev/null "http://127.0.0.1:${port}/api/agent/identity" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  fail "node $node did not stop within 30s"
}

wait_for_node_up() {
  local node="$1"
  local port; port=$(node_port "$node")
  # `/api/status` is one of the two unauthenticated routes the
  # daemon allowlists (see daemon/lifecycle.ts) — usable for a
  # liveness probe without re-reading the (rotated) auth token.
  # Daemon cold-start can take 30-60s under load (libp2p relay
  # rediscovery + chain catchup). Poll for up to 120s.
  for _ in $(seq 1 240); do
    if curl -s --max-time 1 -o /dev/null --fail "http://127.0.0.1:${port}/api/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  fail "node $node did not start within 120s"
}

kill_node() {
  local node="$1"
  local pid
  pid=$(cat "$(node_pidfile "$node")" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  kill "$pid" 2>/dev/null || true
  # SIGTERM first; SIGKILL after 15s if the daemon hasn't drained.
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "  node $node not down after SIGTERM, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
  wait_for_node_down "$node"
  case "$node" in
    5) CURATOR_NEEDS_RESTART=1 ;;
    6) MEMBER_NEEDS_RESTART=1 ;;
  esac
}

restart_node() {
  local node="$1"
  # Startup output can include local auth material. Report only the outcome.
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh restart-node "$node" >/dev/null 2>&1 )
  wait_for_node_up "$node"
  case "$node" in
    5) CURATOR_NEEDS_RESTART=0 ;;
    6) MEMBER_NEEDS_RESTART=0 ;;
  esac
  log "✓ node $node restarted"
}

CURATOR_NEEDS_RESTART=0
MEMBER_NEEDS_RESTART=0
restore_offline_nodes_on_exit() {
  local status="$1"
  trap - EXIT INT TERM
  if [ "$CURATOR_NEEDS_RESTART" = 1 ] && ! restart_node "$CURATOR_NODE"; then
    warn "curator did not recover during cleanup"
    status=1
  fi
  if [ "$MEMBER_NEEDS_RESTART" = 1 ] && ! restart_node "$MEMBER_NODE"; then
    warn "member did not recover during cleanup"
    status=1
  fi
  exit "$status"
}
trap 'restore_offline_nodes_on_exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

republish_agent_profile() {
  local node="$1" label="${2:-node $1}"
  local resp ok
  resp=$(api_call "$node" POST /api/agent/publish-profile '{}')
  ok=$(parse_json "$resp" '.ok')
  if [ "$ok" != "true" ]; then
    fail "could not republish agent profile for $label: $resp"
  fi
  log "✓ republished current agent profile for $label"
}

connect_member_to_curator() {
  local multiaddr body response
  multiaddr=$(cat "$(node_dir "$CURATOR_NODE")/multiaddr" 2>/dev/null) ||
    fail "curator multiaddr is unavailable"
  body=$(MULTIADDR="$multiaddr" node -e '
    console.log(JSON.stringify({multiaddr:process.env.MULTIADDR}));
  ')
  for _ in 1 2 3; do
    response=$(api_call_agent "$MEMBER_NODE" POST /api/connect "$body") || response=""
    if [ -n "$response" ] && [ "$(parse_json "$response" '.connected')" = true ]; then
      log "✓ member reconnected to curator"
      return 0
    fi
    sleep 5
  done
  fail "member could not reconnect to curator"
}

# Poll `/api/connections` on $node until $targetPeer is in the
# connection list (direct OR relayed). The sender-key handshake send
# has a 20s deadline; if libp2p hasn't converged after a restart, the
# first SWM write fails with `send timeout: backoff aborted by
# overall deadline`. This polls for up to 90s so the test is not
# subject to libp2p re-dial timing.
wait_for_peer_link() {
  local node="$1" target_peer="$2"
  local label="node $node → $target_peer"
  for _ in $(seq 1 90); do
    local conn
    conn=$(api_call "$node" GET /api/connections 2>/dev/null | TARGET="$target_peer" node -e '
      let d=""; process.stdin.on("data",c=>d+=c);
      process.stdin.on("end",()=>{
        try {
          const j = JSON.parse(d);
          const list = Array.isArray(j.connections) ? j.connections : [];
          const found = list.some(c => c.peerId === process.env.TARGET);
          console.log(found ? "1" : "0");
        } catch { console.log("0"); }
      });
    ' 2>/dev/null || echo 0)
    if [ "$conn" = "1" ]; then
      log "  peer-link OK: $label"
      return 0
    fi
    sleep 1
  done
  warn "peer-link probe timed out: $label (continuing; SWM write may fail)"
  return 1
}

CURATOR_AGENT=$(api_call "$CURATOR_NODE"      GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
CURATOR_PEER=$(api_call "$CURATOR_NODE"       GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
MEMBER_AGENT=$(api_call "$MEMBER_NODE"        GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
MEMBER_PEER=$(api_call "$MEMBER_NODE"         GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
THIRD_AGENT=$(api_call "$THIRD_MEMBER_NODE"   GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

log "Curator:      $CURATOR_AGENT (node $CURATOR_NODE, peer=$CURATOR_PEER)"
log "Member:       $MEMBER_AGENT  (node $MEMBER_NODE,  peer=$MEMBER_PEER)"
log "Third member: $THIRD_AGENT  (node $THIRD_MEMBER_NODE, core daemon used as member)"
republish_agent_profile "$CURATOR_NODE" "curator"
republish_agent_profile "$MEMBER_NODE" "member"
republish_agent_profile "$THIRD_MEMBER_NODE" "third member"
connect_member_to_curator
sleep 5

STAMP=$(date +%s)

# ===========================================================================
act "SCENARIO A: member-from-curator catchup (baseline)"
# ===========================================================================
CG_A="${CURATOR_AGENT}/lj-A-${STAMP}"
log "Create curated CG: $CG_A (allowlist=[curator, member])"

for N in "$CURATOR_NODE" "$MEMBER_NODE"; do
  CR=$(api_call_agent "$N" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_A", "name": "lj-A ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT","$MEMBER_AGENT"],
  "register": $([ "$N" = "$CURATOR_NODE" ] && echo true || echo false) }
EOF
)")
  if [ "$N" = "$CURATOR_NODE" ]; then
    ON_CHAIN_A=$(parse_json "$CR" '.onChainId')
    [ -n "$ON_CHAIN_A" ] || fail "curator CG_A create failed: $CR"
    log "  curator created+registered: onChainId=$ON_CHAIN_A"
  else
    log "  node $N pre-created CG_A"
  fi
done

# Establish a current peer link before the sender-key handshake and identity
# probe. A node recently restarted by the preceding suite can still hold a
# failed probe in backoff even after its HTTP API has reopened.
sleep 3
wait_for_peer_link "$CURATOR_NODE" "$MEMBER_PEER"

log "Curator writes 5 SWM triples to CG_A..."
A_PAYLOAD=$(CG_ID="$CG_A" N=5 LABEL="A" node -e '
  const cgId = process.env.CG_ID;
  const n = parseInt(process.env.N, 10);
  const label = process.env.LABEL;
  const quads = [];
  for (let i = 0; i < n; i++) {
    quads.push({
      subject: "urn:lj-" + label + ":e" + i,
      predicate: "http://schema.org/name",
      object: "\"value-" + label + "-" + i + "\"",
      graph: "did:dkg:context-graph:" + cgId,
    });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WROTE_A=$(devnet_create_shared_ka_agent "$CURATOR_NODE" "$A_PAYLOAD")
TRIPLES_WROTE_A=$(parse_json "$WROTE_A" '.triplesWritten')
[ "$TRIPLES_WROTE_A" = "5" ] || fail "expected 5 triplesWritten, got '$TRIPLES_WROTE_A' (response: $WROTE_A)"
log "✓ curator wrote 5 triples"

# Give live gossip a moment; the member may already have them.
sleep 3

log "Member catches up from curator (peerId=$CURATOR_PEER)..."
N_A=""
for attempt in $(seq 1 6); do
  CATCHUP_A=$(api_call_agent "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_A", "peerId": "$CURATOR_PEER" }
EOF
)")
  INSERTED_A=$(parse_json "$CATCHUP_A" '.totalInsertedTriples')
  [ -n "$INSERTED_A" ] || fail "catchup result missing: $CATCHUP_A"
  Q_A=$(api_call_agent "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_A", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  N_A=$(sparql_count "$Q_A")
  [ "$N_A" = 5 ] && break
  log "  catch-up attempt $attempt/6 transferred $INSERTED_A; member has ${N_A:-unknown}/5"
  sleep 5
done
[ "$N_A" = "5" ] || fail "member's CG_A binding count was '$N_A', expected 5 (response: $Q_A)"
log "✓ SCENARIO A: member sees all 5 triples via SPARQL"

# ===========================================================================
act "SCENARIO B: member-from-member catchup (curator offline)"
# ===========================================================================
CG_B="${CURATOR_AGENT}/lj-B-${STAMP}"
log "Create curated CG: $CG_B (allowlist=[curator, member, third-member])"

for N in "$CURATOR_NODE" "$MEMBER_NODE" "$THIRD_MEMBER_NODE"; do
  CR=$(api_call_agent "$N" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_B", "name": "lj-B ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT","$MEMBER_AGENT","$THIRD_AGENT"],
  "register": $([ "$N" = "$CURATOR_NODE" ] && echo true || echo false) }
EOF
)")
  if [ "$N" = "$CURATOR_NODE" ]; then
    ON_CHAIN_B=$(parse_json "$CR" '.onChainId')
    [ -n "$ON_CHAIN_B" ] || fail "curator CG_B create failed: $CR"
    log "  curator created+registered: onChainId=$ON_CHAIN_B"
  else
    log "  node $N pre-created CG_B"
  fi
done

sleep 3

# Sender-key handshake from curator → both other members fans out
# in parallel and tolerates no "All multiaddr dials failed" loss.
# Probe libp2p connectivity to both BEFORE the write so we don't
# burn the ~20s sender-key-setup deadline waiting for a re-dial
# (devnet-test-rfc38-all triggers this transition with stale dials
# from SCENARIO A still in some caches).
wait_for_peer_link "$CURATOR_NODE" "$MEMBER_PEER"
wait_for_peer_link "$CURATOR_NODE" "$(api_call "$THIRD_MEMBER_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')"

log "Curator writes 7 SWM triples to CG_B..."
B_PAYLOAD=$(CG_ID="$CG_B" N=7 LABEL="B" node -e '
  const cgId = process.env.CG_ID;
  const n = parseInt(process.env.N, 10);
  const label = process.env.LABEL;
  const quads = [];
  for (let i = 0; i < n; i++) {
    quads.push({
      subject: "urn:lj-" + label + ":e" + i,
      predicate: "http://schema.org/name",
      object: "\"value-" + label + "-" + i + "\"",
      graph: "did:dkg:context-graph:" + cgId,
    });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WROTE_B=$(devnet_create_shared_ka_agent "$CURATOR_NODE" "$B_PAYLOAD")
TRIPLES_WROTE_B=$(parse_json "$WROTE_B" '.triplesWritten')
[ "$TRIPLES_WROTE_B" = "7" ] || fail "expected 7 triplesWritten, got '$TRIPLES_WROTE_B' (response: $WROTE_B)"
log "✓ curator wrote 7 triples"

# Let live gossip propagate to MEMBER_NODE (the would-be helper).
# Gossip across 3 fresh-handshake members can take 5-15s on devnet —
# poll up to 30s rather than a single fixed wait. If gossip is slow,
# fall back to an explicit catchup from the curator: SCENARIO B is
# about the *catchup* path being a valid resync source, so we just
# need MEMBER to have the data before curator goes down — how it got
# there is incidental.
N_B_PRE=""
for _ in $(seq 1 30); do
  Q_B_PRE=$(api_call_agent "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_B", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  N_B_PRE=$(sparql_count "$Q_B_PRE")
  [ "$N_B_PRE" = "7" ] && break
  sleep 1
done
log "  member's CG_B live-gossip count BEFORE curator-down: $N_B_PRE"
if [ "$N_B_PRE" != "7" ]; then
  log "  live gossip incomplete; running fallback explicit catchup against curator..."
  api_call_agent "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_B", "peerId": "$CURATOR_PEER" }
EOF
)" >/dev/null
  Q_B_PRE=$(api_call_agent "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_B", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  N_B_PRE=$(sparql_count "$Q_B_PRE")
  log "  member's CG_B count after explicit catchup: $N_B_PRE"
fi
[ "$N_B_PRE" = "7" ] || fail "member should have CG_B (gossip + fallback catchup), got '$N_B_PRE'"

log "Killing curator (node $CURATOR_NODE)..."
kill_node "$CURATOR_NODE"
log "✓ curator down"

# Force "third member" to re-discover via member. peerId is required
# because by default catchup fans out to all connected peers and
# would also include cores that don't host curated SWM.
log "Third-member ($THIRD_MEMBER_NODE) catchup against member ($MEMBER_NODE, peer=$MEMBER_PEER)..."
CATCHUP_B=$(api_call_agent "$THIRD_MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_B", "peerId": "$MEMBER_PEER" }
EOF
)")
INSERTED_B=$(parse_json "$CATCHUP_B" '.totalInsertedTriples')
log "  catchup response (insertedTriples=$INSERTED_B)"
[ -n "$INSERTED_B" ] || fail "third-member catchup returned no result: $CATCHUP_B"

# Validate third member can read the data via SPARQL.
Q_B=$(api_call_agent "$THIRD_MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_B", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
N_B=$(sparql_count "$Q_B")
[ "$N_B" = "7" ] || fail "third-member's CG_B binding count was '$N_B', expected 7 (curator was offline; catchup should have served the data live from member)"
log "✓ SCENARIO B: third-member resync via OTHER MEMBER returned all 7 triples"

log "Restarting curator..."
restart_node "$CURATOR_NODE"
connect_member_to_curator
log "✓ curator back online"

# Give the rejoined curator time to settle libp2p before any
# downstream test relies on it.
sleep 5

# ===========================================================================
act "SCENARIO C: no-live-member catchup (LU-6 gap, expected fail-soft)"
# ===========================================================================
CG_C="${CURATOR_AGENT}/lj-C-${STAMP}"
log "Create curated CG: $CG_C (allowlist=[curator, third-member], member is OUTSIDER)"

for N in "$CURATOR_NODE" "$THIRD_MEMBER_NODE"; do
  CR=$(api_call_agent "$N" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_C", "name": "lj-C ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT","$THIRD_AGENT"],
  "register": $([ "$N" = "$CURATOR_NODE" ] && echo true || echo false) }
EOF
)")
  if [ "$N" = "$CURATOR_NODE" ]; then
    ON_CHAIN_C=$(parse_json "$CR" '.onChainId')
    [ -n "$ON_CHAIN_C" ] || fail "curator CG_C create failed: $CR"
    log "  curator created+registered: onChainId=$ON_CHAIN_C"
  else
    log "  node $N pre-created CG_C"
  fi
done

sleep 3

# Third-member (N4) is the only other allowed agent — wait for the
# curator→N4 link to come up after the prior SCENARIO B restart so
# the sender-key setup doesn't time out.
THIRD_PEER=$(api_call "$THIRD_MEMBER_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
wait_for_peer_link "$CURATOR_NODE" "$THIRD_PEER"

log "Curator writes 4 SWM triples to CG_C..."
C_PAYLOAD=$(CG_ID="$CG_C" N=4 LABEL="C" node -e '
  const cgId = process.env.CG_ID;
  const n = parseInt(process.env.N, 10);
  const label = process.env.LABEL;
  const quads = [];
  for (let i = 0; i < n; i++) {
    quads.push({
      subject: "urn:lj-" + label + ":e" + i,
      predicate: "http://schema.org/name",
      object: "\"value-" + label + "-" + i + "\"",
      graph: "did:dkg:context-graph:" + cgId,
    });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WROTE_C=$(devnet_create_shared_ka_agent "$CURATOR_NODE" "$C_PAYLOAD")
TRIPLES_WROTE_C=$(parse_json "$WROTE_C" '.triplesWritten')
[ "$TRIPLES_WROTE_C" = "4" ] || fail "expected 4 triplesWritten, got '$TRIPLES_WROTE_C' (response: $WROTE_C)"
log "✓ curator wrote 4 triples"

sleep 3
log "Killing curator (third member is also offline-as-helper because they're a core node — cores don't gossip-relay curated CG SWM today)..."
kill_node "$CURATOR_NODE"
log "✓ curator down"

# Now node 6 (member from OTHER scenarios; NOT in CG_C allowlist)
# pretends to be a late joiner that somehow knows the CG id.
# Pre-create locally so the local gate accepts the catchup attempt,
# then catchup against the cores only — these don't host curated
# CG SWM today (LU-6 gap), so we expect 0 triples and a clean response.
log "Outsider (node $MEMBER_NODE) pre-creates CG_C locally to bypass the local read gate..."
api_call_agent "$MEMBER_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_C", "name": "lj-C late ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$MEMBER_AGENT"] }
EOF
)" >/dev/null || true

log "Outsider catchup against all available peers (cores only — no live member)..."
CATCHUP_C=$(api_call_agent "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_C" }
EOF
)")
INSERTED_C=$(parse_json "$CATCHUP_C" '.totalInsertedTriples')
PEERS_ATTEMPTED_C=$(parse_json "$CATCHUP_C" '.peersAttempted')
HOST_PEERS_ATTEMPTED_C=$(printf '%s' "$CATCHUP_C" | node -e '
  let d = "";
  process.stdin.on("data", c => d += c);
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(d);
      const total = (j.hostCatchup?.perContextGraph ?? [])
        .reduce((sum, entry) => sum + (Array.isArray(entry.peers) ? entry.peers.length : 0), 0);
      console.log(total);
    } catch {
      console.log(0);
    }
  });
')
log "  catchup response: peersAttempted=$PEERS_ATTEMPTED_C hostPeersAttempted=$HOST_PEERS_ATTEMPTED_C insertedTriples=$INSERTED_C"

# Outsider (no chain key, no allowlist membership) MUST end with 0
# applied triples even though cores serve ciphertext via LU-6 — the
# Sender-Key AEAD step on the apply path rejects when no chain key
# is available. The endpoint must not crash.
[ "$INSERTED_C" = "0" ] \
  || fail "outsider applied $INSERTED_C triples from cores-only catchup — non-members must NOT be able to decrypt curated SWM ciphertext (LU-6 confidentiality invariant)"

if ! { [ -n "$PEERS_ATTEMPTED_C" ] && [ "$PEERS_ATTEMPTED_C" -gt 0 ]; } \
  && ! { [ -n "$HOST_PEERS_ATTEMPTED_C" ] && [ "$HOST_PEERS_ATTEMPTED_C" -gt 0 ]; }; then
  fail "EXPECTED-GAP endpoint regression: catchup endpoint did not attempt any standard or host-mode peers (response: $CATCHUP_C)"
fi

log "✓ SCENARIO C: outsider cores-only catchup returned 0 triples cleanly (LU-6 confidentiality invariant upheld)"

log "Restarting curator..."
restart_node "$CURATOR_NODE"
connect_member_to_curator
log "✓ curator back online"

# Give the rejoined curator time to settle libp2p before the next
# scenario relies on it.
sleep 5

# ===========================================================================
act "SCENARIO D: private late joiner recovers from an authorized member"
# ===========================================================================
CG_D="${CURATOR_AGENT}/lj-D-${STAMP}"
log "Create curated CG: $CG_D (allowlist=[curator, member])"

# Default OT-RFC-49 policy strips private ciphertext on cores. Check the
# actual node config before using zero host-mode entries as an invariant.
for N in "${CORE_NODES[@]}"; do
  python3 - "$(node_dir "$N")/config.json" <<'PYCONFIG' || fail "core $N does not have private-ciphertext stripping enabled"
import json,sys
c=json.load(open(sys.argv[1]))
assert c.get('swmHostMode',{}).get('stripCiphertext') is not False
PYCONFIG
done

host_entries_for_graph() {
  local node="$1" cg="$2" wire stats
  wire=$(cd "$REPO_ROOT/packages/agent" && CG_ID="$cg" node -e '
    const {keccak256,toUtf8Bytes}=require("ethers");
    process.stdout.write(keccak256(toUtf8Bytes(process.env.CG_ID)));
  ') || return 1
  stats=$(api_call "$node" GET /api/shared-memory/host-mode/stats) || return 1
  printf '%s' "$stats" | CG_ID="$cg" WIRE_ID="$wire" node -e '
    let input="";process.stdin.on("data",c=>input+=c);
    process.stdin.on("end",()=>{
      try {
        const data=JSON.parse(input), rows=data.perCg || {};
        if(data.enabled!==true) process.exit(1);
        const keys=new Set([process.env.CG_ID,process.env.WIRE_ID,process.env.WIRE_ID.toLowerCase()]);
        let count=0;
        for(const key of keys) count+=Number(rows[key]?.entries || 0);
        if(!Number.isSafeInteger(count) || count<0) process.exit(1);
        console.log(count);
      } catch { process.exit(1); }
    });
  '
}

assert_no_private_core_custody() {
  local cg="$1" node entries
  for node in "${CORE_NODES[@]}"; do
    entries=$(host_entries_for_graph "$node" "$cg") || fail "cannot read node $node host-mode stats"
    [ "$entries" = 0 ] || fail "node $node retained $entries private ciphertext envelopes for $cg"
    log "  node $node private host-mode entries for this graph: $entries"
  done
}

query_member_count() {
  local cg="$1" response
  response=$(api_call_agent "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$cg", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)") || return 1
  sparql_count "$response"
}

for N in "$CURATOR_NODE" "$MEMBER_NODE"; do
  CR=$(api_call_agent "$N" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_D", "name": "lj-D ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT","$MEMBER_AGENT"],
  "register": $([ "$N" = "$CURATOR_NODE" ] && echo true || echo false) }
EOF
)")
  if [ "$N" = "$CURATOR_NODE" ]; then
    ON_CHAIN_D=$(parse_json "$CR" '.onChainId')
    [ -n "$ON_CHAIN_D" ] || fail "curator CG_D create failed: $CR"
    log "  curator created+registered: onChainId=$ON_CHAIN_D"
  fi
done

# Exercise the operator hatch explicitly. A core may already know the topic
# by its chain event, but neither path may retain private ciphertext.
for N in "${CORE_NODES[@]}"; do
  SR=$(api_call "$N" POST /api/shared-memory/host-mode/subscribe "{\"contextGraphId\":\"$CG_D\"}")
  [ "$(parse_json "$SR" '.hostingEnabled')" = true ] || fail "core $N host-mode API unavailable: $SR"
done
sleep 5
wait_for_peer_link "$CURATOR_NODE" "$MEMBER_PEER"

D0_PAYLOAD=$(CG_ID="$CG_D" node -e '
  const cg=process.env.CG_ID;
  console.log(JSON.stringify({contextGraphId:cg,quads:[{
    subject:"urn:lj-D:e0",predicate:"http://schema.org/name",
    object:"\"value-D-0\"",graph:"did:dkg:context-graph:"+cg}]}));
')
WROTE_D0=$(devnet_create_shared_ka_agent "$CURATOR_NODE" "$D0_PAYLOAD")
[ "$(parse_json "$WROTE_D0" '.triplesWritten')" = 1 ] || fail "CG_D handshake write failed: $WROTE_D0"
N_D_HANDSHAKE=""
for _ in $(seq 1 30); do
  N_D_HANDSHAKE=$(query_member_count "$CG_D")
  [ "$N_D_HANDSHAKE" = 1 ] && break
  sleep 1
done
[ "$N_D_HANDSHAKE" = 1 ] || fail "member did not receive CG_D's first triple"
log "✓ member received the first private triple"

kill_node "$MEMBER_NODE"
D5_PAYLOAD=$(CG_ID="$CG_D" node -e '
  const cg=process.env.CG_ID;
  const quads=Array.from({length:5},(_,index)=>({
    subject:"urn:lj-D:e"+(index+1),predicate:"http://schema.org/name",
    object:"\"value-D-"+(index+1)+"\"",graph:"did:dkg:context-graph:"+cg}));
  console.log(JSON.stringify({contextGraphId:cg,quads}));
')
WROTE_D5=$(devnet_create_shared_ka_agent "$CURATOR_NODE" "$D5_PAYLOAD")
[ "$(parse_json "$WROTE_D5" '.triplesWritten')" = 5 ] || fail "CG_D offline-member write failed: $WROTE_D5"
sleep 5
assert_no_private_core_custody "$CG_D"
log "✓ manually designated cores retained zero private ciphertext"

kill_node "$CURATOR_NODE"
restart_node "$MEMBER_NODE"
N_D_PRE=$(query_member_count "$CG_D")
[ "$N_D_PRE" = 1 ] || fail "member gained private history without an authorized peer: count=$N_D_PRE"
CATCHUP_D_OFFLINE=$(api_call_agent "$MEMBER_NODE" POST /api/shared-memory/catchup "{\"contextGraphId\":\"$CG_D\"}")
N_D_OFFLINE=$(query_member_count "$CG_D")
[ "$N_D_OFFLINE" = 1 ] || fail "cores served private history while curator was offline: count=$N_D_OFFLINE"
log "✓ offline member remained at 1 triple with curator unavailable"

restart_node "$CURATOR_NODE"
connect_member_to_curator
wait_for_peer_link "$CURATOR_NODE" "$MEMBER_PEER"
N_D_POST=""
for attempt in $(seq 1 6); do
  CATCHUP_D=$(api_call_agent "$MEMBER_NODE" POST /api/shared-memory/catchup "{\"contextGraphId\":\"$CG_D\"}")
  for _ in $(seq 1 10); do
    N_D_POST=$(query_member_count "$CG_D")
    [ "$N_D_POST" = 6 ] && break 2
    sleep 2
  done
  log "  curator catch-up retry $attempt/6; member has ${N_D_POST:-unknown}/6 triples"
done
[ "$N_D_POST" = 6 ] || fail "member did not recover all private history from curator: count=$N_D_POST"
log "✓ SCENARIO D: member recovered all 6 triples from the authorized curator"

# ===========================================================================
act "SCENARIO E: chain/beacon discovery retains no private ciphertext"
# ===========================================================================
CG_E="${CURATOR_AGENT}/lj-E-${STAMP}"
for N in "$CURATOR_NODE" "$MEMBER_NODE"; do
  CR=$(api_call_agent "$N" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_E", "name": "lj-E ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT","$MEMBER_AGENT"],
  "register": $([ "$N" = "$CURATOR_NODE" ] && echo true || echo false) }
EOF
)")
  if [ "$N" = "$CURATOR_NODE" ]; then
    ON_CHAIN_E=$(parse_json "$CR" '.onChainId')
    [ -n "$ON_CHAIN_E" ] || fail "curator CG_E create failed: $CR"
  fi
done
sleep 8
wait_for_peer_link "$CURATOR_NODE" "$MEMBER_PEER"
E_PAYLOAD=$(CG_ID="$CG_E" node -e '
  const cg=process.env.CG_ID;
  console.log(JSON.stringify({contextGraphId:cg,quads:[{
    subject:"urn:lj-E:e0",predicate:"http://schema.org/name",
    object:"\"value-E-0\"",graph:"did:dkg:context-graph:"+cg}]}));
')
WROTE_E=$(devnet_create_shared_ka_agent "$CURATOR_NODE" "$E_PAYLOAD")
[ "$(parse_json "$WROTE_E" '.triplesWritten')" = 1 ] || fail "CG_E write failed: $WROTE_E"
N_E_MEMBER=""
for _ in $(seq 1 30); do
  N_E_MEMBER=$(query_member_count "$CG_E")
  [ "$N_E_MEMBER" = 1 ] && break
  sleep 1
done
[ "$N_E_MEMBER" = 1 ] || fail "CG_E member did not receive the share"
sleep 5
assert_no_private_core_custody "$CG_E"
log "✓ SCENARIO E: auto-discovery retained zero private ciphertext on cores"

log ""
log "================================================================"
log "  RFC-38 LATE-JOINER test: PASS"
log "================================================================"
log "  CG_A: curator-to-member catch-up, $N_A triples"
log "  CG_B: member-to-member catch-up with curator offline, $N_B triples"
log "  CG_C: outsider cores-only catch-up returned zero"
log "  CG_D: private member recovered $N_D_POST triples after curator returned"
log "  CG_E: chain/beacon auto-discovery retained zero private ciphertext"
log "================================================================"
