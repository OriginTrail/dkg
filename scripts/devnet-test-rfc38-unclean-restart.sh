#!/usr/bin/env bash
#
# OT-RFC-38 LU-6 C5 — UNCLEAN RESTART RECOVERY test.
#
# Validates that a `kill -9` of a host-mode core after it has captured
# ciphertext does not corrupt the host-mode store and that a member can
# catch up correctly from that core after it is restarted.
#
# Implicitly validates the LU-6 follow-ups:
#   * B2 (orphan .log reconcile on init) — a hard kill can leave
#     a fresh .log without a synced .meta. The next init must
#     reap it, not let it accumulate.
#   * B3 (host-only designation persistence) — the core must
#     re-engage its previously-subscribed CGs after restart, not
#     wait for a chain event to re-derive them.
#   * Post-restart host-catchup serve — the member must recover the
#     missed ciphertext from the restarted core and be able to read it.
#
# Test phases:
#
#   1. Curator (N5) and member (N6) create a curated CG. A core (N1)
#      is told to host-mode subscribe explicitly so it stores opaque
#      ciphertext without becoming a CG member.
#   2. Curator writes one handshake triple so N6 stores the sender key,
#      then N6 is stopped before the bulk write.
#   3. Curator writes large triples while N6 is offline and the core's
#      host-mode store must capture ciphertext for this exact CG.
#   4. The core is SIGKILLed (`kill -9`) — simulates power loss, not
#      graceful shutdown.
#   5. The core is restarted via `devnet.sh restart-node N1`.
#   6. Core stats endpoint MUST report `enabled: true` and still
#      list this CG in subscribedCgIds / perCg after restart.
#   7. N6 restarts, catches up from the restarted core by peerId, and
#      can read the recovered triples.
#
# Re-runnable: timestamp-suffixed CG id.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
M1_NODE=6
CORE_NODE=1
DEVNET_SH="$REPO_ROOT/scripts/devnet.sh"

# Tune via env. Defaults are suite-friendly and stay comfortably below the
# generic sync route's 10 MiB read cap.
WRITES_COUNT="${WRITES_COUNT:-200}"
WRITE_PAYLOAD_BYTES="${WRITE_PAYLOAD_BYTES:-4096}"
WRITES_PER_BATCH="${WRITES_PER_BATCH:-20}"

log()  { echo "[urr] $*"; }
warn() { echo "[urr] WARN: $*" >&2; }
fail() { echo "[urr] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[urr] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
# Codex PR #624 R2: `devnet.sh` writes its supervisor pid to
# `devnet.pid` and the inner CLI/daemon worker writes `daemon.pid`.
# Sending kill -9 only to the inner worker can race with the
# supervisor respawning it, so this test may never exercise a real
# unclean outage. Kill the supervisor pid (and the inner worker as
# belt-and-braces in case they differ).
node_supervisor_pidfile() { echo "$(node_dir "$1")/devnet.pid"; }
node_inner_pidfile()      { echo "$(node_dir "$1")/daemon.pid"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time "${CURL_MAX_TIME_SECONDS:-240}" -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  # Stream the body through stdin (`-d @-`) instead of putting it on the
  # argv. Pre-fix, large stress payloads (80 writes × 16 KiB ≈ 1.3 MiB
  # JSON body) hit macOS's ARG_MAX with "Argument list too long" before
  # curl ever ran. -d @- has no length limit beyond available memory.
  if [ -n "$data" ]; then
    curl_args+=(-d @-)
    curl_args+=("http://127.0.0.1:${port}${path}")
    printf '%s' "$data" | curl "${curl_args[@]}"
  else
    curl_args+=("http://127.0.0.1:${port}${path}")
    curl "${curl_args[@]}"
  fi
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

catchup_peer_error() {
  printf '%s' "$1" | node -e '
    let d = "";
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const results = Array.isArray(j.results) ? j.results : [];
        const hit = results.find((r) => r && (r.swmError || r.durableError || r.error));
        const value = hit ? (hit.swmError || hit.durableError || hit.error || "") : "";
        console.log(value && typeof value === "object" ? JSON.stringify(value) : (value || ""));
      } catch {
        process.exit(1);
      }
    });
  '
}

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

count_triples() {
  local node="$1"
  local q; q=$(api_call "$node" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/note> ?o }" }
EOF
)")
  sparql_count "$q"
}

wait_for_port_open() {
  local node="$1" max="${2:-30}"
  local port; port=$(node_port "$node")
  for _ in $(seq 1 "$max"); do
    if lsof -ti tcp:"$port" >/dev/null 2>&1; then
      sleep 1
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_devnet_node() {
  local node="$1" label="${2:-node $node}"
  local supervisor_pidfile inner_pidfile supervisor_pid inner_pid
  supervisor_pidfile=$(node_supervisor_pidfile "$node")
  inner_pidfile=$(node_inner_pidfile "$node")
  [ -f "$supervisor_pidfile" ] || fail "$label supervisor pidfile $supervisor_pidfile missing"
  supervisor_pid=$(tr -d '[:space:]' < "$supervisor_pidfile")
  inner_pid=""
  if [ -f "$inner_pidfile" ]; then
    inner_pid=$(tr -d '[:space:]' < "$inner_pidfile")
  fi
  log "stopping $label supervisor=$supervisor_pid inner=${inner_pid:-<none>}"
  kill "$supervisor_pid" 2>/dev/null || warn "TERM $label supervisor returned non-zero (process may have exited)"
  for _ in $(seq 1 10); do
    if ! kill -0 "$supervisor_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if kill -0 "$supervisor_pid" 2>/dev/null; then
    warn "$label did not stop after TERM; sending SIGKILL"
    kill -9 "$supervisor_pid" 2>/dev/null || true
  fi
  if [ -n "$inner_pid" ] && [ "$inner_pid" != "$supervisor_pid" ] && kill -0 "$inner_pid" 2>/dev/null; then
    kill -9 "$inner_pid" 2>/dev/null || true
  fi
  if ! wait_for_port_closed "$node" 30; then
    fail "$label port still open after stop"
  fi
}

kill_devnet_node_unclean() {
  local node="$1" label="${2:-node $node}"
  local supervisor_pidfile inner_pidfile supervisor_pid inner_pid
  supervisor_pidfile=$(node_supervisor_pidfile "$node")
  inner_pidfile=$(node_inner_pidfile "$node")
  [ -f "$supervisor_pidfile" ] || fail "$label supervisor pidfile $supervisor_pidfile missing"
  supervisor_pid=$(tr -d '[:space:]' < "$supervisor_pidfile")
  inner_pid=""
  if [ -f "$inner_pidfile" ]; then
    inner_pid=$(tr -d '[:space:]' < "$inner_pidfile")
  fi
  log "kill -9 $label supervisor=$supervisor_pid inner=${inner_pid:-<none>}"
  kill -9 "$supervisor_pid" 2>/dev/null || warn "kill -9 $label supervisor returned non-zero (process may have exited)"
  if [ -n "$inner_pid" ] && [ "$inner_pid" != "$supervisor_pid" ] && kill -0 "$inner_pid" 2>/dev/null; then
    kill -9 "$inner_pid" 2>/dev/null || true
  fi
  if ! wait_for_port_closed "$node" 30; then
    fail "$label port still open after 30s — kill did NOT take effect (supervisor respawn?). Can't validate unclean-restart recovery against a still-running daemon."
  fi
}

restart_devnet_node() {
  local node="$1" label="${2:-node $node}"
  [ -x "$DEVNET_SH" ] || fail "scripts/devnet.sh not executable — can't restart $label programmatically"
  "$DEVNET_SH" restart-node "$node" >/dev/null 2>&1 || warn "devnet.sh restart-node $node returned non-zero"
  if ! wait_for_port_open "$node" 60; then
    fail "$label API never came back online after restart"
  fi
}

wait_for_port_closed() {
  local node="$1" max="${2:-15}"
  local port; port=$(node_port "$node")
  for _ in $(seq 1 "$max"); do
    if ! lsof -ti tcp:"$port" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M1_AGENT=$(api_call "$M1_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

# Codex PR #624 follow-up: resolve the CORE's peerId BEFORE we kill
# it. The post-restart catchup calls below will pin to this peerId
# so we're explicitly exercising recovery from the killed core,
# not silently succeeding by pulling data from the curator or
# another connected host. /api/status returns `peerId` as the
# libp2p identity. We grab it from the running daemon now while
# it's still up.
CORE_PEER_ID=$(api_call "$CORE_NODE" GET /api/status \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);console.log(j.peerId||"")}catch{console.log("")}})')
[ -n "$CORE_PEER_ID" ] || fail "core /api/status did not return a peerId — can't pin post-restart catchup to the node we're killing"

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/urr-${STAMP}"

log "Curator: $CURATOR_AGENT (node $CURATOR_NODE)"
log "M1:      $M1_AGENT (node $M1_NODE)"
log "Core:    node $CORE_NODE peerId=$CORE_PEER_ID [will be SIGKILLed before post-restart catchup]"
log "CG:      $CG_ID"
log "Stress:  $WRITES_COUNT writes × ${WRITE_PAYLOAD_BYTES} bytes"

# ===========================================================================
act "1. Curator/member create curated CG, core host-mode subscribes"
# ===========================================================================
for N in "$CURATOR_NODE" "$M1_NODE"; do
  CREATE_RESP=$(api_call "$N" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "unclean ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT","$M1_AGENT"],
  "register": $([ "$N" = "$CURATOR_NODE" ] && echo true || echo false) }
EOF
)")
  if [ "$N" = "$CURATOR_NODE" ]; then
    ON_CHAIN_ID=$(parse_json "$CREATE_RESP" '.onChainId')
    [ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE_RESP"
    log "✓ curated CG onChainId=$ON_CHAIN_ID"
  else
    log "✓ member pre-created CG metadata"
  fi
done

SUB_RESP=$(api_call "$CORE_NODE" POST /api/shared-memory/host-mode/subscribe "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)")
log "Core subscribe response: $SUB_RESP"
SUBSCRIBED=$(parse_json "$SUB_RESP" '.subscribed' 2>/dev/null || echo "")
ALREADY_SUBSCRIBED=$(parse_json "$SUB_RESP" '.alreadySubscribed' 2>/dev/null || echo "")
MEMBER_MODE=$(parse_json "$SUB_RESP" '.memberMode' 2>/dev/null || echo "")
if [ "$MEMBER_MODE" = "true" ]; then
  fail "core joined CG in member-mode; host-mode persistence test requires a host-only core. Response: $SUB_RESP"
fi
if [ "$SUBSCRIBED" != "true" ] && [ "$ALREADY_SUBSCRIBED" != "true" ]; then
  fail "core did not engage host-mode for $CG_ID. Response: $SUB_RESP"
fi
log "✓ core host-mode subscribed (subscribed=$SUBSCRIBED alreadySubscribed=$ALREADY_SUBSCRIBED)"

# The explicit subscribe can race the core's chain-event poller: the curator's
# create call has returned an onChainId, but the host core may not yet have
# observed that registration. If we write immediately after a large pre-reg
# stress test, the core can classify the first envelopes as pre-reg and reject
# them against the 1 MiB/minute curator budget. Wait until THIS core sees the
# on-chain id, then re-run the idempotent subscribe so maybeMarkRegisteredForHostMode()
# flips the host store to the registered-CG limits before the stress write.
CORE_SEES_ONCHAIN=""
CORE_ONCHAIN_MATCH=""
for _ in $(seq 1 60); do
  LIST_RESP=$(api_call "$CORE_NODE" GET /api/context-graph/list 2>/dev/null || echo "{}")
  CORE_ONCHAIN_MATCH=$(CG_ID="$CG_ID" ON_CHAIN_ID="$ON_CHAIN_ID" node -e '
    let d = "";
    process.stdin.on("data", c => { d += c; });
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const list = Array.isArray(j) ? j : (Array.isArray(j.contextGraphs) ? j.contextGraphs : []);
        const expectedUri = "did:dkg:context-graph:" + process.env.CG_ID;
        const hit = list.find(cg => {
          if (!cg || String(cg.onChainId || "") !== String(process.env.ON_CHAIN_ID || "")) return false;
          return cg.id === process.env.CG_ID || cg.uri === expectedUri || /^0x[0-9a-fA-F]{64}$/.test(String(cg.id || ""));
        });
        console.log(hit ? String(hit.id || hit.uri || "matched") : "");
      } catch {
        console.log("");
      }
    });
  ' <<<"$LIST_RESP")
  [ -n "$CORE_ONCHAIN_MATCH" ] && CORE_SEES_ONCHAIN="true"
  [ "$CORE_SEES_ONCHAIN" = "true" ] && break
  sleep 1
done
[ "$CORE_SEES_ONCHAIN" = "true" ] \
  || fail "core never observed onChainId=$ON_CHAIN_ID for $CG_ID before stress write"
log "✓ core sees registered CG on-chain (onChainId=$ON_CHAIN_ID via $CORE_ONCHAIN_MATCH)"

SUB_RESP_REGISTERED=$(api_call "$CORE_NODE" POST /api/shared-memory/host-mode/subscribe "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)")
log "Core registered-limit subscribe response: $SUB_RESP_REGISTERED"
sleep 2

# ===========================================================================
act "2. Curator writes one handshake triple; member stores the sender key"
# ===========================================================================
HANDSHAKE_PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  console.log(JSON.stringify({
    contextGraphId: cgId,
    quads: [{
      subject: "urn:urr:" + stamp + "/handshake",
      predicate: "http://schema.org/note",
      object: "\"handshake\"",
      graph: "",
    }],
  }));
')
HANDSHAKE_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$HANDSHAKE_PAYLOAD")
HANDSHAKE_WRITTEN=$(parse_json "$HANDSHAKE_RESP" '.triplesWritten')
[ "$HANDSHAKE_WRITTEN" = "1" ] || fail "expected 1 handshake triple, got '$HANDSHAKE_WRITTEN': $HANDSHAKE_RESP"

M1_HANDSHAKE=""
for _ in $(seq 1 30); do
  M1_HANDSHAKE=$(count_triples "$M1_NODE")
  [ "$M1_HANDSHAKE" = "1" ] && break
  sleep 1
done
[ "$M1_HANDSHAKE" = "1" ] \
  || fail "member did not receive handshake triple / sender key before offline phase (got '$M1_HANDSHAKE')"
log "✓ member received sender key + 1 handshake triple"

log "Stopping member node $M1_NODE before the bulk write so recovery must use catchup"
stop_devnet_node "$M1_NODE" "member node $M1_NODE"
log "✓ member stopped"

# ===========================================================================
act "3. Curator writes $WRITES_COUNT missed triples (batched ≤$WRITES_PER_BATCH per POST to fit MAX_BODY_BYTES)"
# ===========================================================================
TOTAL_WRITTEN=0
BATCH_START=0
while [ "$BATCH_START" -lt "$WRITES_COUNT" ]; do
  BATCH_END=$(( BATCH_START + WRITES_PER_BATCH ))
  [ "$BATCH_END" -gt "$WRITES_COUNT" ] && BATCH_END="$WRITES_COUNT"
  BATCH_LEN=$(( BATCH_END - BATCH_START ))
  PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" START="$BATCH_START" END="$BATCH_END" BYTES="$WRITE_PAYLOAD_BYTES" node -e '
    const stamp = process.env.STAMP;
    const cgId = process.env.CG_ID;
    const start = Number(process.env.START);
    const end = Number(process.env.END);
    const bytes = Number(process.env.BYTES);
    const filler = "f".repeat(bytes);
    const quads = [];
    for (let i = start; i < end; i++) {
      const entity = "urn:urr:" + stamp + "/t-" + i;
      quads.push({ subject: entity, predicate: "http://schema.org/note", object: "\"" + filler + "\"", graph: "" });
    }
    console.log(JSON.stringify({ contextGraphId: cgId, quads }));
  ')
  W=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$PAYLOAD")
  GOT=$(parse_json "$W" '.triplesWritten')
  [ "$GOT" = "$BATCH_LEN" ] || fail "batch [$BATCH_START..$BATCH_END) expected $BATCH_LEN triples, got '$GOT': $W"
  TOTAL_WRITTEN=$(( TOTAL_WRITTEN + BATCH_LEN ))
  BATCH_START="$BATCH_END"
done
[ "$TOTAL_WRITTEN" = "$WRITES_COUNT" ] || fail "expected $WRITES_COUNT total triples written, got $TOTAL_WRITTEN"
log "✓ $WRITES_COUNT triples written (across batches of ≤$WRITES_PER_BATCH)"
sleep 4

# ===========================================================================
act "4. Core host-mode store captures ciphertext for this CG"
# ===========================================================================
CORE_STATS_BEFORE=""
CORE_ENTRIES_BEFORE=0
CORE_BYTES_BEFORE=0
for _ in $(seq 1 30); do
  CORE_STATS_BEFORE=$(api_call "$CORE_NODE" GET /api/shared-memory/host-mode/stats)
  CORE_ENTRIES_BEFORE=$(parse_json "$CORE_STATS_BEFORE" ".perCg['$CG_ID'].entries" 2>/dev/null || echo "0")
  CORE_BYTES_BEFORE=$(parse_json "$CORE_STATS_BEFORE" ".perCg['$CG_ID'].bytes" 2>/dev/null || echo "0")
  CORE_ENTRIES_BEFORE=${CORE_ENTRIES_BEFORE:-0}
  CORE_BYTES_BEFORE=${CORE_BYTES_BEFORE:-0}
  if [ "$CORE_ENTRIES_BEFORE" -gt 0 ] 2>/dev/null; then
    break
  fi
  sleep 1
done
log "Core pre-kill perCg[$CG_ID]: entries=$CORE_ENTRIES_BEFORE bytes=$CORE_BYTES_BEFORE"
[ "$CORE_ENTRIES_BEFORE" -gt 0 ] 2>/dev/null \
  || fail "core host-mode store did not capture ciphertext for $CG_ID before kill. Stats: $CORE_STATS_BEFORE"

# ===========================================================================
act "5. SIGKILL the core (unclean shutdown — no graceful close)"
# ===========================================================================
kill_devnet_node_unclean "$CORE_NODE" "core node $CORE_NODE"
# Codex PR #624 R2: hard-fail if the API never goes down. A respawn
# or a kill that missed would otherwise let phase 6 pass against a
# still-running core, defeating the unclean-restart contract.
log "✓ core forcibly stopped (port closed, supervisor + inner pid gone)"

# ===========================================================================
act "6. Restart the core (B2 orphan reconcile + B3 host-mode restore must fire)"
# ===========================================================================
restart_devnet_node "$CORE_NODE" "core node $CORE_NODE"
log "✓ core restarted (port open)"

# ===========================================================================
act "7. Restarted core still reports hosted ciphertext for this CG"
# ===========================================================================
CORE_STATS_AFTER=""
CORE_ENTRIES_AFTER=0
CORE_BYTES_AFTER=0
for _ in $(seq 1 30); do
  CORE_STATS_AFTER=$(api_call "$CORE_NODE" GET /api/shared-memory/host-mode/stats)
  CORE_ENTRIES_AFTER=$(parse_json "$CORE_STATS_AFTER" ".perCg['$CG_ID'].entries" 2>/dev/null || echo "0")
  CORE_BYTES_AFTER=$(parse_json "$CORE_STATS_AFTER" ".perCg['$CG_ID'].bytes" 2>/dev/null || echo "0")
  CORE_ENTRIES_AFTER=${CORE_ENTRIES_AFTER:-0}
  CORE_BYTES_AFTER=${CORE_BYTES_AFTER:-0}
  if [ "$CORE_ENTRIES_AFTER" -gt 0 ] 2>/dev/null; then
    break
  fi
  sleep 1
done
log "Core post-restart perCg[$CG_ID]: entries=$CORE_ENTRIES_AFTER bytes=$CORE_BYTES_AFTER"
[ "$CORE_ENTRIES_AFTER" -gt 0 ] 2>/dev/null \
  || fail "restarted core lost hosted ciphertext for $CG_ID. Stats: $CORE_STATS_AFTER"

# ===========================================================================
act "8. Core stats still healthy — host-mode survived unclean shutdown"
# ===========================================================================
STATS=$(api_call "$CORE_NODE" GET /api/shared-memory/host-mode/stats)
log "Stats: $STATS"
ENABLED=$(parse_json "$STATS" '.enabled')
[ "$ENABLED" = "true" ] || fail "core host-mode NOT enabled after restart — B3 persistence regression"

# Codex PR #624 R3: asserting only `enabled === true` is too weak
# for the B3 guarantee — host mode can be globally enabled while
# the restarted core has forgotten THIS specific contextGraphId.
# Check that $CG_ID is still in subscribedCgIds OR perCg after the
# unclean restart.
SUBSCRIBED_FOUND=$(parse_json "$STATS" ".subscribedCgIds.includes('$CG_ID')" 2>/dev/null || echo "")
PERCG_BYTES=$(parse_json "$STATS" ".perCg['$CG_ID'].bytes" 2>/dev/null || echo "")
if [ "$SUBSCRIBED_FOUND" != "true" ] && [ -z "$PERCG_BYTES" ]; then
  fail "B3 PERSISTENCE REGRESSION: core no longer subscribed to $CG_ID after restart. " \
       "Host mode is enabled globally (good) but the per-CG host-only designation was NOT restored. " \
       "Stats: $STATS"
fi
log "✓ core still subscribed to $CG_ID after restart (subscribedFound=$SUBSCRIBED_FOUND perCg.bytes=${PERCG_BYTES:-<none>})"

BYTES_AFTER="${PERCG_BYTES:-0}"
log "Core perCg[$CG_ID].bytes after restart: $BYTES_AFTER"

# ===========================================================================
act "9. Member resumes catchup from restarted core and can read recovered triples"
# ===========================================================================
restart_devnet_node "$M1_NODE" "member node $M1_NODE"
log "✓ member restarted"

EXPECTED_TOTAL=$((WRITES_COUNT + 1))
M1_PRE=$(count_triples "$M1_NODE")
[ "$M1_PRE" = "1" ] \
  || fail "member should still have only the handshake triple before post-restart catchup, got '$M1_PRE'"
log "Member pre-catchup note count: $M1_PRE (expected 1)"

CATCHUP_AFTER=$(api_call "$M1_NODE" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "peerId": "$CORE_PEER_ID" }
EOF
)")
HOST_RAN_AFTER=$(parse_json "$CATCHUP_AFTER" '.hostCatchup.ranFallback')
HOST_APPLIED_AFTER=$(parse_json "$CATCHUP_AFTER" '.hostCatchup.appliedTotal')
HOST_APPLIED_AFTER=${HOST_APPLIED_AFTER:-0}
CATCHUP_ERROR=$(catchup_peer_error "$CATCHUP_AFTER" 2>/dev/null || echo "")
log "Catchup response: $CATCHUP_AFTER"
log "hostCatchup.ranFallback=$HOST_RAN_AFTER hostCatchup.appliedTotal=$HOST_APPLIED_AFTER peerError=${CATCHUP_ERROR:-<none>}"

[ "$HOST_RAN_AFTER" = "true" ] \
  || fail "post-restart catchup did not run host-catchup fallback against restarted core"
[ "$HOST_APPLIED_AFTER" -gt 0 ] 2>/dev/null \
  || fail "post-restart host-catchup applied no triples (response: $CATCHUP_AFTER)"

M1_POST=""
for _ in $(seq 1 30); do
  M1_POST=$(count_triples "$M1_NODE")
  [ "$M1_POST" = "$EXPECTED_TOTAL" ] && break
  sleep 1
done
[ "$M1_POST" = "$EXPECTED_TOTAL" ] \
  || fail "member ended with '$M1_POST' readable triples after post-restart catchup; expected $EXPECTED_TOTAL"
log "✓ member recovered and can read all $EXPECTED_TOTAL triples from restarted core"

log ""
log "================================================================"
log "  RFC-38 LU-6 C5 (unclean restart recovery): PASS"
log "================================================================"
log "  Curated CG:        $CG_ID  (onChainId=$ON_CHAIN_ID)"
log "  Curator wrote:     1 handshake + $WRITES_COUNT missed triples"
log "  Core kill:         SIGKILL (no graceful shutdown)"
log "  Core pre-kill:     $CORE_ENTRIES_BEFORE hosted envelopes (${CORE_BYTES_BEFORE} bytes)"
log "  Core post-restart: $CORE_ENTRIES_AFTER hosted envelopes (${CORE_BYTES_AFTER} bytes)"
log "  Core host-mode:    enabled=true and CG subscription restored"
log "  Member recovery:   $M1_POST readable triples after host-catchup from restarted core"
log "================================================================"
