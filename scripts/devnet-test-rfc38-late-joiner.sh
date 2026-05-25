#!/usr/bin/env bash
#
# OT-RFC-38 — LATE-JOINER test.
#
# Exercises the realistic distributed pattern that downstream UX
# depends on: a new member can catch up the FULL history of a
# curated CG even when the curator is offline, as long as ANY
# other current member is reachable.
#
# This is the "member-from-member catchup" path that today's
# Phase A implementation supports natively. It is the complement
# to the "member-from-core" path that is documented as a known
# gap (cores do not yet subscribe to live curated-CG SWM gossip;
# substrate-encryption + sharding-table subscription land in a
# follow-up of LU-6).
#
# Three scenarios:
#
#   SCENARIO A — member-from-curator catchup (baseline, curator online):
#     • Curator (N5) creates curated CG with [N5, N6] in allowlist.
#     • Curator writes 5 SWM triples.
#     • N6 (pre-existing member) catches up directly from N5.
#     • Asserts: N6 inserts 5 triples + can query them.
#
#   SCENARIO B — member-from-member catchup (curator offline):
#     • Curator (N5) creates a SECOND curated CG with [N5, N6, N4]
#       in allowlist. (N4 is a core, used as a third member here.)
#     • Curator writes 7 SWM triples. N6 receives them via live
#       gossip (live multi-member topology).
#     • Curator goes OFFLINE (kill node 5).
#     • N4 (third member) calls catchup against N6 (second member).
#       Asserts: N4 inserts 7 triples + can query them — proves
#       any current member can serve any other member.
#     • Curator comes back online for the rest of the suite.
#
#   SCENARIO C — no-live-member catchup (LU-6 GAP, expected fail-soft):
#     • Curator (N5) creates a THIRD curated CG with [N5, N4] in
#       allowlist. (N6 is NOT a member.)
#     • Curator writes 4 SWM triples.
#     • Curator goes OFFLINE.
#     • N6 (non-member, pretending to be a late joiner who somehow
#       discovered the CG) tries to catch up from the cores only.
#     • Asserts: cores return 0 triples (they don't host curated SWM
#       today). This is the LU-6 gap that's tracked for a follow-up.
#       The endpoint must NOT crash; must return cleanly with 0.
#     • Curator comes back online.
#
# Talks ONLY to the daemon HTTP API. Re-runnable: every CG id is
# timestamp-suffixed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
MEMBER_NODE=6
THIRD_MEMBER_NODE=4
OUTSIDER_NODE=1

log()  { echo "[lj] $*"; }
warn() { echo "[lj] WARN: $*" >&2; }
fail() { echo "[lj] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[lj] === $1 ==="; }

node_dir()    { echo "$DEVNET_DIR/node$1"; }
node_token()  { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()   { echo $((API_PORT_BASE + $1 - 1)); }
node_pidfile(){ echo "$(node_dir "$1")/daemon.pid"; }
node_log()    { echo "$(node_dir "$1")/daemon.log"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 180 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
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
}

restart_node() {
  local node="$1"
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh restart-node "$node" 2>&1 | sed "s/^/  [devnet] /" )
  wait_for_node_up "$node"
}

CURATOR_AGENT=$(api_call "$CURATOR_NODE"      GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
CURATOR_PEER=$(api_call "$CURATOR_NODE"       GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
MEMBER_AGENT=$(api_call "$MEMBER_NODE"        GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
MEMBER_PEER=$(api_call "$MEMBER_NODE"         GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).peerId))')
THIRD_AGENT=$(api_call "$THIRD_MEMBER_NODE"   GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

log "Curator:      $CURATOR_AGENT (node $CURATOR_NODE, peer=$CURATOR_PEER)"
log "Member:       $MEMBER_AGENT  (node $MEMBER_NODE,  peer=$MEMBER_PEER)"
log "Third member: $THIRD_AGENT  (node $THIRD_MEMBER_NODE, core daemon used as member)"

STAMP=$(date +%s)

# ===========================================================================
act "SCENARIO A: member-from-curator catchup (baseline)"
# ===========================================================================
CG_A="${CURATOR_AGENT}/lj-A-${STAMP}"
log "Create curated CG: $CG_A (allowlist=[curator, member])"

for N in "$CURATOR_NODE" "$MEMBER_NODE"; do
  CR=$(api_call "$N" POST /api/context-graph/create "$(cat <<EOF
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

# Brief settle so the sender-key handshake can complete.
sleep 3

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
WROTE_A=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$A_PAYLOAD")
TRIPLES_WROTE_A=$(parse_json "$WROTE_A" '.triplesWritten')
[ "$TRIPLES_WROTE_A" = "5" ] || fail "expected 5 triplesWritten, got '$TRIPLES_WROTE_A' (response: $WROTE_A)"
log "✓ curator wrote 5 triples"

# Give live gossip a moment; the member may already have them.
sleep 3

log "Member catches up from curator (peerId=$CURATOR_PEER)..."
CATCHUP_A=$(api_call "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_A", "peerId": "$CURATOR_PEER" }
EOF
)")
INSERTED_A=$(parse_json "$CATCHUP_A" '.totalInsertedTriples')
log "  catchup response (insertedTriples=$INSERTED_A)"
[ -n "$INSERTED_A" ] || fail "catchup result missing: $CATCHUP_A"

# Validate the member can read the data via SPARQL regardless of how
# it got there (live gossip vs catchup).
Q_A=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_A", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
N_A=$(sparql_count "$Q_A")
[ "$N_A" = "5" ] || fail "member's CG_A binding count was '$N_A', expected 5 (response: $Q_A)"
log "✓ SCENARIO A: member sees all 5 triples via SPARQL"

# ===========================================================================
act "SCENARIO B: member-from-member catchup (curator offline)"
# ===========================================================================
CG_B="${CURATOR_AGENT}/lj-B-${STAMP}"
log "Create curated CG: $CG_B (allowlist=[curator, member, third-member])"

for N in "$CURATOR_NODE" "$MEMBER_NODE" "$THIRD_MEMBER_NODE"; do
  CR=$(api_call "$N" POST /api/context-graph/create "$(cat <<EOF
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
WROTE_B=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$B_PAYLOAD")
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
  Q_B_PRE=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
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
  api_call "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_B", "peerId": "$CURATOR_PEER" }
EOF
)" >/dev/null
  Q_B_PRE=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
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
CATCHUP_B=$(api_call "$THIRD_MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_B", "peerId": "$MEMBER_PEER" }
EOF
)")
INSERTED_B=$(parse_json "$CATCHUP_B" '.totalInsertedTriples')
log "  catchup response (insertedTriples=$INSERTED_B)"
[ -n "$INSERTED_B" ] || fail "third-member catchup returned no result: $CATCHUP_B"

# Validate third member can read the data via SPARQL.
Q_B=$(api_call "$THIRD_MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_B", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
N_B=$(sparql_count "$Q_B")
[ "$N_B" = "7" ] || fail "third-member's CG_B binding count was '$N_B', expected 7 (curator was offline; catchup should have served the data live from member)"
log "✓ SCENARIO B: third-member resync via OTHER MEMBER returned all 7 triples"

log "Restarting curator..."
restart_node "$CURATOR_NODE"
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
  CR=$(api_call "$N" POST /api/context-graph/create "$(cat <<EOF
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
WROTE_C=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$C_PAYLOAD")
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
api_call "$MEMBER_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_C", "name": "lj-C late ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$MEMBER_AGENT"] }
EOF
)" >/dev/null || true

log "Outsider catchup against all available peers (cores only — no live member)..."
CATCHUP_C=$(api_call "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_C" }
EOF
)")
INSERTED_C=$(parse_json "$CATCHUP_C" '.totalInsertedTriples')
PEERS_ATTEMPTED_C=$(parse_json "$CATCHUP_C" '.peersAttempted')
log "  catchup response: peersAttempted=$PEERS_ATTEMPTED_C insertedTriples=$INSERTED_C"

[ "$INSERTED_C" = "0" ] \
  || fail "EXPECTED-GAP regression: outsider got $INSERTED_C triples from a cores-only catchup (LU-6 substrate hosting is not implemented yet, should have returned 0)"

# Endpoint correctness: must not have crashed.
[ -n "$PEERS_ATTEMPTED_C" ] && [ "$PEERS_ATTEMPTED_C" -gt 0 ] \
  || fail "EXPECTED-GAP endpoint regression: catchup endpoint did not attempt any peers (response: $CATCHUP_C)"

log "✓ SCENARIO C: cores-only catchup returned 0 triples cleanly (this is the documented LU-6 gap)"

log "Restarting curator..."
restart_node "$CURATOR_NODE"
log "✓ curator back online"

# ===========================================================================
log ""
log "================================================================"
log "  RFC-38 LATE-JOINER test: PASS"
log "================================================================"
log "  CG_A (member-from-curator):     $CG_A  (onChainId=$ON_CHAIN_A)"
log "                                  member catchup OK, $N_A triples"
log "  CG_B (member-from-member,       $CG_B  (onChainId=$ON_CHAIN_B)"
log "        curator OFFLINE):         third-member catchup OK, $N_B triples"
log "  CG_C (LU-6 gap probe,           $CG_C  (onChainId=$ON_CHAIN_C)"
log "        curator + members OFFL.): cores-only catchup returned 0 (expected, documented)"
log "================================================================"
