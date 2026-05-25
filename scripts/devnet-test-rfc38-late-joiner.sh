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
#   SCENARIO C — outsider catchup (cores host ciphertext but
#                outsider has no chain key, expected fail-soft):
#     • Curator (N5) creates a THIRD curated CG with [N5, N4] in
#       allowlist. (N6 is NOT a member.)
#     • Curator writes 4 SWM triples.
#     • Curator goes OFFLINE.
#     • N6 (non-member, pretending to be a late joiner who somehow
#       discovered the CG) tries to catch up from the cores only.
#     • Asserts: cores host the ciphertext envelopes via LU-6 and
#       serve them; N6 cannot decrypt (no chain key) and applies
#       zero. The endpoint must NOT crash and must return cleanly
#       with 0 inserted triples. This is the *intended* outcome —
#       LU-6 ciphertext custody is decoupled from CG-membership
#       authority; non-members hit AEAD verify failure on apply.
#     • Curator comes back online.
#
#   SCENARIO D — LU-6 happy path (member-with-chain-key, curator
#                offline, cores serve ciphertext, member decrypts):
#     • Curator (N5) creates a curated CG with [N5, N6] in allowlist.
#       Both nodes pre-create the CG locally (sender-key handshake
#       needs both ends online).
#     • Curator writes 1 SWM triple — this triggers the sender-key
#       handshake and N6 receives the chain key (epoch 0).
#     • N6 is KILLED — but its on-disk sender-key receive state is
#       preserved (DKGAgentWallet + swm-sender-key files survive).
#     • Curator writes 5 more SWM triples (so 5 ciphertext envelopes
#       at epoch >= 1 are gossiped). N6 is offline, so misses live
#       gossip; cores receive via LU-6 host-mode and stash opaque
#       ciphertext.
#     • Curator is KILLED. Now no CG member is online except (the
#       offline) N6.
#     • N6 RESTARTS. Local SWM state still has the original 1
#       triple, NOT the 5 it missed.
#     • N6 calls /api/shared-memory/catchup — standard sync returns
#       0 (curator offline, no other member online); the LU-6
#       host-catchup fallback fires, pulls 5 ciphertext envelopes
#       from cores, decrypts with the local chain key, applies.
#     • Asserts: N6 ends with all 6 triples via SPARQL.
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

# Outsider (no chain key, no allowlist membership) MUST end with 0
# applied triples even though cores serve ciphertext via LU-6 — the
# Sender-Key AEAD step on the apply path rejects when no chain key
# is available. The endpoint must not crash.
[ "$INSERTED_C" = "0" ] \
  || fail "outsider applied $INSERTED_C triples from cores-only catchup — non-members must NOT be able to decrypt curated SWM ciphertext (LU-6 confidentiality invariant)"

[ -n "$PEERS_ATTEMPTED_C" ] && [ "$PEERS_ATTEMPTED_C" -gt 0 ] \
  || fail "EXPECTED-GAP endpoint regression: catchup endpoint did not attempt any peers (response: $CATCHUP_C)"

log "✓ SCENARIO C: outsider cores-only catchup returned 0 triples cleanly (LU-6 confidentiality invariant upheld)"

log "Restarting curator..."
restart_node "$CURATOR_NODE"
log "✓ curator back online"

# Give the rejoined curator time to settle libp2p before the next
# scenario relies on it.
sleep 5

# ===========================================================================
act "SCENARIO D: LU-6 happy path (member-with-chain-key catchup from cores)"
# ===========================================================================
CG_D="${CURATOR_AGENT}/lj-D-${STAMP}"
log "Create curated CG: $CG_D (allowlist=[curator, member])"
log "  Pre-create on members only (cores get host-mode via explicit API call below)."

# Only members pre-create the CG. Cores deliberately do NOT, because:
#   (a) the curator's allowlist is exactly [curator, member] — adding
#       cores into the on-the-wire DKG_ALLOWED_AGENT membership union
#       (via gossiped meta) would make them *real* members and shortcut
#       past the host-mode path we're trying to test.
#   (b) we want to prove the LU-6 path where cores host ciphertext
#       without being CG members.
for N in "$CURATOR_NODE" "$MEMBER_NODE"; do
  CR=$(api_call "$N" POST /api/context-graph/create "$(cat <<EOF
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
  else
    log "  node $N pre-created CG_D"
  fi
done

# Operator-driven host-mode designation: tell each core to subscribe
# in host mode for CG_D. This is the Phase A surface that maps onto
# the eventual sharding-table-driven auto-subscribe. Cores do NOT
# need the CG metadata locally — only the topic id.
log "Designating cores 1-4 as host-mode subscribers for CG_D..."
for N in 1 2 3 4; do
  SR=$(api_call "$N" POST /api/shared-memory/host-mode/subscribe "$(cat <<EOF
{ "contextGraphId": "$CG_D" }
EOF
)")
  log "  node $N host-mode/subscribe: $SR"
done

# Give cores a beat to wire up the pubsub topic listeners.
sleep 5

wait_for_peer_link "$CURATOR_NODE" "$MEMBER_PEER"

log "Initial write (1 triple) to drive sender-key handshake to member..."
D0_PAYLOAD=$(CG_ID="$CG_D" node -e '
  const cgId = process.env.CG_ID;
  console.log(JSON.stringify({
    contextGraphId: cgId,
    quads: [{
      subject: "urn:lj-D:e0",
      predicate: "http://schema.org/name",
      object: "\"value-D-0\"",
      graph: "did:dkg:context-graph:" + cgId,
    }],
  }));
')
WROTE_D0=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$D0_PAYLOAD")
TRIPLES_WROTE_D0=$(parse_json "$WROTE_D0" '.triplesWritten')
[ "$TRIPLES_WROTE_D0" = "1" ] || fail "expected 1 triplesWritten for handshake, got '$TRIPLES_WROTE_D0' (response: $WROTE_D0)"
log "✓ handshake write OK"

# Wait for the sender-key package to land + the first message to apply
# on member; otherwise N6's local receive state never gets the chain
# key and SCENARIO D's whole premise breaks.
log "Waiting for member to receive handshake + first triple..."
N_D_HANDSHAKE=""
for _ in $(seq 1 30); do
  Q_D_HANDSHAKE=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_D", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  N_D_HANDSHAKE=$(sparql_count "$Q_D_HANDSHAKE")
  [ "$N_D_HANDSHAKE" = "1" ] && break
  sleep 1
done
[ "$N_D_HANDSHAKE" = "1" ] || fail "member never received handshake triple (got '$N_D_HANDSHAKE') — sender-key package likely never landed"
log "✓ member received chain key + 1 triple"

log "Killing member ($MEMBER_NODE) before curator writes 5 more..."
kill_node "$MEMBER_NODE"
log "✓ member down (chain key persists on disk)"

log "Curator writes 5 SWM triples to CG_D while member is OFFLINE..."
D5_PAYLOAD=$(CG_ID="$CG_D" node -e '
  const cgId = process.env.CG_ID;
  const quads = [];
  for (let i = 1; i <= 5; i += 1) {
    quads.push({
      subject: "urn:lj-D:e" + i,
      predicate: "http://schema.org/name",
      object: "\"value-D-" + i + "\"",
      graph: "did:dkg:context-graph:" + cgId,
    });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WROTE_D5=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$D5_PAYLOAD")
TRIPLES_WROTE_D5=$(parse_json "$WROTE_D5" '.triplesWritten')
[ "$TRIPLES_WROTE_D5" = "5" ] || fail "expected 5 triplesWritten, got '$TRIPLES_WROTE_D5' (response: $WROTE_D5)"
log "✓ curator wrote 5 triples while member offline"

# Give cores a moment to absorb ciphertext into host-mode storage.
sleep 5

log "Probing core host-mode stores on all 4 cores to confirm ciphertext was captured for CG_D specifically..."
# Codex PR #610 R3: assert on per-CG entries for $CG_D rather
# than the global totalEntries — the latter would silently pass
# if SCENARIO C left residue but CG_D itself was never hosted.
HOST_D_TOTAL=0
for N in 1 2 3 4; do
  HS=$(api_call $N GET /api/shared-memory/host-mode/stats || true)
  log "  host-mode stats node$N: $HS"
  # NB: env-var prefix in a pipeline binds to the LEFTMOST command,
  # so `CG_ID=... printf | node` does NOT export CG_ID into node's
  # environment. Wrap the pipeline in a subshell with `export` so
  # CG_ID reaches the `process.env.CG_ID` lookup below.
  E=$(export CG_ID="$CG_D"; printf '%s' "$HS" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try {
        const j = JSON.parse(d);
        const cg = process.env.CG_ID;
        const perCg = j.perCg || {};
        const e = (perCg[cg] && perCg[cg].entries) || 0;
        console.log(e);
      } catch { console.log(0); }
    })')
  HOST_D_TOTAL=$((HOST_D_TOTAL + E))
done
log "  CG_D-specific host-mode entries across cores: $HOST_D_TOTAL"
[ "$HOST_D_TOTAL" -gt 0 ] \
  || fail "LU-6 host-mode regression: 0 ciphertext envelopes stored for CG_D across cores (expected at least 1)"

log "Killing curator ($CURATOR_NODE) — now no CG member is online."
kill_node "$CURATOR_NODE"
log "✓ curator down"

log "Restarting member ($MEMBER_NODE) — its on-disk chain-key state survives."
restart_node "$MEMBER_NODE"
log "✓ member back online"

# Sanity: confirm member still only has the 1 triple (the missed
# 5 are not yet visible because gossip happened while member was
# offline).
Q_D_PRE=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_D", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
N_D_PRE=$(sparql_count "$Q_D_PRE")
[ "$N_D_PRE" = "1" ] || fail "member should have only the 1 handshake triple before catchup, got '$N_D_PRE'"
log "  pre-catchup count on member: $N_D_PRE (expected 1, confirms 5 still missing)"

log "Member triggers /api/shared-memory/catchup — standard sync returns 0, LU-6 host-catchup fallback fires..."
CATCHUP_D=$(api_call "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_D" }
EOF
)")
HOST_APPLIED_D=$(parse_json "$CATCHUP_D" '.hostCatchup.appliedTotal')
HOST_RAN_D=$(parse_json "$CATCHUP_D" '.hostCatchup.ranFallback')
log "  catchup response: $CATCHUP_D"
log "  catchup hostCatchup.ranFallback=$HOST_RAN_D hostCatchup.appliedTotal=$HOST_APPLIED_D"

# The whole point of LU-6 is that the host-catchup fallback fires
# in this configuration. If standard sync magically resolves the
# data, something else is going on — fail loudly so we notice.
[ "$HOST_RAN_D" = "true" ] \
  || fail "LU-6 happy-path: host-catchup fallback did not fire (got hostCatchup.ranFallback=$HOST_RAN_D)"

# Final SPARQL check: 1 (handshake) + 5 (host-catchup decrypted) = 6.
N_D_POST=""
for _ in $(seq 1 30); do
  Q_D_POST=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_D", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  N_D_POST=$(sparql_count "$Q_D_POST")
  [ "$N_D_POST" = "6" ] && break
  sleep 1
done
[ "$N_D_POST" = "6" ] \
  || fail "LU-6 happy-path regression: member ended with '$N_D_POST' triples after catchup (expected 6 = 1 handshake + 5 host-catchup)"
log "✓ SCENARIO D: member recovered all 6 triples via LU-6 host-catchup decrypt (cores hosted, member decrypted)"

log "Restarting curator..."
restart_node "$CURATOR_NODE"
log "✓ curator back online"

# ===========================================================================
# SCENARIO E — OT-RFC-38 LU-6 Phase B: chain-event + discovery-beacon
#              driven AUTO-HOST (no operator-driven /host-mode/subscribe).
# ===========================================================================
# Phase B replaces SCENARIO D's manual /api/shared-memory/host-mode/subscribe
# with two complementary auto-host signals:
#
#   (1) The on-chain `ContextGraphCreated(nameHash, accessPolicy=1)` event.
#       Every core's chain-event poller hears it and engages host-mode for
#       the wire-id (keccak256(cleartextId)) without local CG metadata.
#
#   (2) The curator's discovery beacon, broadcast on the global
#       `dkg/cg-discovery` gossip topic at create-time and re-announced
#       periodically. Cores receive it, verify the curator-EOA signature
#       (first-claim-wins), and engage host-mode even BEFORE the on-chain
#       registration commits (pre-reg auto-host, gated by per-curator +
#       per-core sliding-window rate limits).
#
# SCENARIO E proves the new path end-to-end by repeating the SCENARIO D
# host-mode probe WITHOUT calling /host-mode/subscribe on any core. If
# cores absorb ciphertext for CG_E, the auto-host wiring is healthy. If
# they don't, Phase B regressed and we'd silently fall back to Phase A's
# operator-driven topology — which is exactly what we're killing.
log ""
log "================================================================"
log "  SCENARIO E — LU-6 Phase B auto-host (no /host-mode/subscribe)"
log "================================================================"

CG_E="$CURATOR_AGENT/lj-E-${STAMP}"
log "CG_E id: $CG_E"
log "Creating CG_E on curator + member (member off-chain, curator registers on-chain)..."
for N in "$CURATOR_NODE" "$MEMBER_NODE"; do
  CR=$(api_call "$N" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_E", "name": "lj-E ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT","$MEMBER_AGENT"],
  "register": $([ "$N" = "$CURATOR_NODE" ] && echo true || echo false) }
EOF
)")
  if [ "$N" = "$CURATOR_NODE" ]; then
    ON_CHAIN_E=$(parse_json "$CR" '.onChainId')
    [ -n "$ON_CHAIN_E" ] || fail "curator CG_E create failed: $CR"
    log "  curator created+registered CG_E: onChainId=$ON_CHAIN_E"
  else
    log "  node $N pre-created CG_E"
  fi
done

# NOTE: deliberately NO /api/shared-memory/host-mode/subscribe call here.
# Cores must auto-host via (1) chain-event + (2) discovery beacon.
log "Waiting for cores to absorb the ContextGraphCreated chain event + discovery beacon..."
sleep 8

wait_for_peer_link "$CURATOR_NODE" "$MEMBER_PEER"

log "Handshake write (1 triple) to drive sender-key broadcast to member..."
E0_PAYLOAD=$(CG_ID="$CG_E" node -e '
  const cgId = process.env.CG_ID;
  console.log(JSON.stringify({
    contextGraphId: cgId,
    quads: [{
      subject: "urn:lj-E:e0",
      predicate: "http://schema.org/name",
      object: "\"value-E-0\"",
      graph: "did:dkg:context-graph:" + cgId,
    }],
  }));
')
WROTE_E0=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$E0_PAYLOAD")
TRIPLES_WROTE_E0=$(parse_json "$WROTE_E0" '.triplesWritten')
[ "$TRIPLES_WROTE_E0" = "1" ] || fail "expected 1 triplesWritten for E handshake, got '$TRIPLES_WROTE_E0' (response: $WROTE_E0)"
log "✓ CG_E handshake write OK"

log "Waiting for member to receive handshake + first triple..."
N_E_HANDSHAKE=""
for _ in $(seq 1 30); do
  Q_E_HANDSHAKE=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_E", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  N_E_HANDSHAKE=$(sparql_count "$Q_E_HANDSHAKE")
  [ "$N_E_HANDSHAKE" = "1" ] && break
  sleep 1
done
[ "$N_E_HANDSHAKE" = "1" ] || fail "CG_E member never received handshake triple (got '$N_E_HANDSHAKE')"
log "✓ member received CG_E chain key + 1 triple"

log "Killing member ($MEMBER_NODE) before curator writes 5 more to CG_E..."
kill_node "$MEMBER_NODE"
log "✓ member down (chain key persists)"

log "Curator writes 5 SWM triples to CG_E while member is OFFLINE..."
E5_PAYLOAD=$(CG_ID="$CG_E" node -e '
  const cgId = process.env.CG_ID;
  const quads = [];
  for (let i = 1; i <= 5; i += 1) {
    quads.push({
      subject: "urn:lj-E:e" + i,
      predicate: "http://schema.org/name",
      object: "\"value-E-" + i + "\"",
      graph: "did:dkg:context-graph:" + cgId,
    });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WROTE_E5=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$E5_PAYLOAD")
TRIPLES_WROTE_E5=$(parse_json "$WROTE_E5" '.triplesWritten')
[ "$TRIPLES_WROTE_E5" = "5" ] || fail "expected 5 triplesWritten on CG_E, got '$TRIPLES_WROTE_E5' (response: $WROTE_E5)"
log "✓ curator wrote 5 triples to CG_E while member offline"

# Give cores a moment to absorb ciphertext via AUTO-HOST (no
# /host-mode/subscribe was ever called for CG_E).
sleep 5

log "Probing core host-mode stores on all 4 cores for CG_E (auto-host only)..."
HOST_E_TOTAL=0
for N in 1 2 3 4; do
  HS=$(api_call $N GET /api/shared-memory/host-mode/stats || true)
  log "  host-mode stats node$N: $HS"
  E=$(export CG_ID="$CG_E"; printf '%s' "$HS" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try {
        const j = JSON.parse(d);
        const cg = process.env.CG_ID;
        const perCg = j.perCg || {};
        const e = (perCg[cg] && perCg[cg].entries) || 0;
        console.log(e);
      } catch { console.log(0); }
    })')
  HOST_E_TOTAL=$((HOST_E_TOTAL + E))
done
log "  CG_E-specific host-mode entries across cores: $HOST_E_TOTAL"
[ "$HOST_E_TOTAL" -gt 0 ] \
  || fail "LU-6 Phase B regression: 0 ciphertext envelopes auto-hosted for CG_E (expected >=1; chain-event or beacon auto-host is not engaging)"

log "Killing curator ($CURATOR_NODE) — now no CG_E member is online."
kill_node "$CURATOR_NODE"
log "✓ curator down"

log "Restarting member ($MEMBER_NODE)..."
restart_node "$MEMBER_NODE"
log "✓ member back online"

# Sanity: member should still only have the handshake triple.
Q_E_PRE=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_E", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
N_E_PRE=$(sparql_count "$Q_E_PRE")
[ "$N_E_PRE" = "1" ] || fail "CG_E member should have only the 1 handshake triple before catchup, got '$N_E_PRE'"
log "  pre-catchup count on member for CG_E: $N_E_PRE (expected 1)"

log "Member triggers /api/shared-memory/catchup for CG_E — host-catchup fallback should fire..."
CATCHUP_E=$(api_call "$MEMBER_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_E" }
EOF
)")
HOST_APPLIED_E=$(parse_json "$CATCHUP_E" '.hostCatchup.appliedTotal')
HOST_RAN_E=$(parse_json "$CATCHUP_E" '.hostCatchup.ranFallback')
log "  catchup response: $CATCHUP_E"
log "  catchup hostCatchup.ranFallback=$HOST_RAN_E hostCatchup.appliedTotal=$HOST_APPLIED_E"
[ "$HOST_RAN_E" = "true" ] \
  || fail "LU-6 Phase B regression: host-catchup fallback did not fire on CG_E (got hostCatchup.ranFallback=$HOST_RAN_E)"

N_E_POST=""
for _ in $(seq 1 30); do
  Q_E_POST=$(api_call "$MEMBER_NODE" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_E", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  N_E_POST=$(sparql_count "$Q_E_POST")
  [ "$N_E_POST" = "6" ] && break
  sleep 1
done
[ "$N_E_POST" = "6" ] \
  || fail "LU-6 Phase B regression: member ended CG_E with '$N_E_POST' triples after catchup (expected 6)"
log "✓ SCENARIO E: AUTO-HOST path works end-to-end (no operator subscribe; member recovered all $N_E_POST triples)"

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
log "  CG_C (outsider catchup,         $CG_C  (onChainId=$ON_CHAIN_C)"
log "        no chain key):            cores-only catchup returned 0 (confidentiality upheld)"
log "  CG_D (LU-6 happy path,          $CG_D  (onChainId=$ON_CHAIN_D)"
log "        member decrypts cores):   member recovered all $N_D_POST triples via host-catchup"
log "  CG_E (LU-6 Phase B AUTO-HOST,   $CG_E  (onChainId=$ON_CHAIN_E)"
log "        no operator subscribe):   member recovered all $N_E_POST triples via auto-host + host-catchup"
log "================================================================"
