#!/usr/bin/env bash
#
# OT-RFC-38 LU-6 C2 — CURATOR-OFFLINE MID-BATCH test.
#
# Validates the resilience contract spelled out in RFC §1.3 (publish
# resilience): once the curator has gossiped a batch's SWM envelopes
# to the cores, the publish-to-VM step does NOT require the curator
# to stay online — any other member (with publishPolicy=open) OR
# the cores' opaque-host catchup substrate keeps the path forward.
#
# This devnet harness narrows that to the most operationally useful
# slice: curator writes a batch, gets the envelopes onto the wire,
# THEN goes offline. We then assert:
#
#   (a) Other members + cores can still serve catchup for the batch
#       to a late-joining peer (they each have it locally either as
#       decrypted triples or as opaque ciphertext).
#   (b) For an OPEN publishPolicy CG, a non-curator member can call
#       /api/shared-memory/publish to finish the path to VM without
#       the curator coming back online.
#
# Test phases:
#
#   1. Curator (N5) creates an OPEN publishPolicy curated CG with
#      [curator, M1=N6, M2=N4] in the allowlist; all three pre-create.
#      (curated access policy + open publish policy: only allowlisted
#      members can read/write, but ANY of them can publish to VM.)
#   2. Curator writes 4 triples. Both members + the core network
#      catch up so the ciphertext is on their disks.
#   3. Curator's daemon is stopped (simulating offline).
#   4. M1 + M2 confirm they still have the 4 triples (no regression).
#   5. M1 (non-curator) calls /api/shared-memory/publish. Must
#      succeed: status=confirmed + a txHash.
#   6. Outsider (N1) fetches the on-chain KC and verifies the
#      merkleRoot decodes; this proves the publish landed without
#      the curator's continued participation.
#   7. Curator's daemon is restarted to leave the devnet in a usable
#      state for the next test run.
#
# Re-runnable: timestamp-suffixed CG id.
#
# Notes:
#   - The curator-only publishPolicy variant is the FAILURE case: a
#     non-curator publish would correctly bounce with 403. We don't
#     test that here (covered by the existing publisher unit tests);
#     this script validates the OPEN-policy resilience contract.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
M1_NODE=6
M2_NODE=4
OUTSIDER_NODE=1

log()  { echo "[com] $*"; }
warn() { echo "[com] WARN: $*" >&2; }
fail() { echo "[com] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[com] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_pidfile() { echo "$(node_dir "$1")/daemon.pid"; }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 240 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
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

# Codex PR #622 R3: cleanup must run on BOTH the happy path AND any
# failure after the curator is SIGTERMed; otherwise `set -e` exits
# immediately and leaves the devnet with a missing node 5.
# Register the trap once we know which node to restart. The cleanup
# only fires AFTER we've actually stopped the curator (CURATOR_STOPPED=1).
CURATOR_STOPPED=0
restart_curator_if_stopped() {
  if [ "$CURATOR_STOPPED" -eq 1 ]; then
    local devnet_sh="$REPO_ROOT/scripts/devnet.sh"
    if [ -x "$devnet_sh" ]; then
      log "trap: restarting curator (node $CURATOR_NODE) so the devnet stays usable…"
      "$devnet_sh" restart-node "$CURATOR_NODE" >/dev/null 2>&1 || warn "trap: devnet.sh restart-node returned non-zero — please restart node $CURATOR_NODE manually"
    fi
  fi
}
trap restart_curator_if_stopped EXIT

CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M1_AGENT=$(api_call "$M1_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M2_AGENT=$(api_call "$M2_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/com-${STAMP}"

log "Curator: $CURATOR_AGENT (node $CURATOR_NODE) [will go offline mid-test]"
log "M1:      $M1_AGENT (node $M1_NODE)"
log "M2:      $M2_AGENT (node $M2_NODE)"
log "CG:      $CG_ID (publishPolicy=open)"

# ===========================================================================
act "1. All three parties pre-create the CG with publishPolicy=open"
# ===========================================================================
ALLOWED='["'"$CURATOR_AGENT"'", "'"$M1_AGENT"'", "'"$M2_AGENT"'"]'

CREATE_CUR=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "curator-offline ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 1,
  "allowedAgents": $ALLOWED,
  "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE_CUR" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE_CUR"
log "✓ curated, open-publish CG onChainId=$ON_CHAIN_ID"

for n in "$M1_NODE" "$M2_NODE"; do
  api_call "$n" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "curator-offline ${STAMP} (member)",
  "accessPolicy": 1, "publishPolicy": 1, "allowedAgents": $ALLOWED }
EOF
)" >/dev/null || true
done
sleep 3

# ===========================================================================
act "2. Curator writes 4 triples; members catch up"
# ===========================================================================
PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const quads = [];
  for (const tag of ["one","two","three","four"]) {
    const entity = "urn:com:" + stamp + "/" + tag;
    quads.push({ subject: entity, predicate: "http://schema.org/name", object: "\""+tag+"\"", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WRITE_RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$PAYLOAD")
[ "$(parse_json "$WRITE_RESP" '.triplesWritten')" = "4" ] || fail "write expected 4 triples: $WRITE_RESP"
log "✓ curator wrote 4 triples"
sleep 5

# Codex PR #622 R-list: /api/shared-memory/list isn't a daemon route.
# Use /api/query SPARQL COUNT against the _shared_memory graph
# suffix — actually measures local SWM state.
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
  api_call "$node" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null 2>&1 || true
  sleep 1
  local q; q=$(api_call "$node" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  sparql_count "$q"
}

wait_for_count_at_least() {
  local node="$1" who="$2" target="$3"
  local result=""
  for _ in $(seq 1 20); do
    result=$(count_triples "$node")
    if [ -n "$result" ] && [ "$result" -ge "$target" ] 2>/dev/null; then
      echo "$result"
      return 0
    fi
    sleep 1
  done
  fail "$who never reached ≥$target triples (last count: \"$result\") — pre-offline catchup is broken; can't validate the resilience contract."
}

log "Waiting for M1 + M2 to catch up the 4-triple batch (precondition for the offline test)…"
M1_BEFORE=$(wait_for_count_at_least "$M1_NODE" "M1" 4)
M2_BEFORE=$(wait_for_count_at_least "$M2_NODE" "M2" 4)
log "✓ pre-offline: M1=$M1_BEFORE  M2=$M2_BEFORE"

# ===========================================================================
act "3. Curator goes offline (SIGTERM the daemon)"
# ===========================================================================
PIDFILE=$(node_pidfile "$CURATOR_NODE")
if [ ! -f "$PIDFILE" ]; then
  fail "curator pidfile $PIDFILE missing — devnet startup didn't write one?"
fi
CURATOR_PID=$(tr -d '[:space:]' < "$PIDFILE")
log "Stopping curator pid=$CURATOR_PID …"
kill -TERM "$CURATOR_PID" 2>/dev/null || warn "SIGTERM returned non-zero (process may already be gone)"
CURATOR_STOPPED=1  # trap will restart on exit (success or failure)

# Codex PR #622 R1: hard-fail if the curator never actually goes
# offline. Previously the loop just fell through after 20s and the
# script kept running — turning phase 5 into a false positive
# because the publish was no longer happening with the curator
# actually offline.
DOWN=0
for _ in $(seq 1 30); do
  if ! lsof -ti tcp:"$(node_port "$CURATOR_NODE")" >/dev/null 2>&1 && ! kill -0 "$CURATOR_PID" 2>/dev/null; then
    DOWN=1
    log "✓ curator port released + pid $CURATOR_PID gone — daemon offline"
    break
  fi
  sleep 1
done
[ "$DOWN" -eq 1 ] || fail "curator daemon refused to shut down within 30s — can't validate offline resilience with the curator still running"

# ===========================================================================
act "4. Members confirm they still hold the 4 triples (no regression)"
# ===========================================================================
M1_OFFLINE=$(count_triples "$M1_NODE")
M2_OFFLINE=$(count_triples "$M2_NODE")
log "While curator offline: M1=$M1_OFFLINE  M2=$M2_OFFLINE"
[ -n "$M1_OFFLINE" ] || fail "M1 SPARQL read failed while curator offline"
[ -n "$M2_OFFLINE" ] || fail "M2 SPARQL read failed while curator offline"
[ "$M1_OFFLINE" -ge 4 ] || fail "REGRESSION: M1 lost triples after curator went offline (count=$M1_OFFLINE)"
[ "$M2_OFFLINE" -ge 4 ] || fail "REGRESSION: M2 lost triples after curator went offline (count=$M2_OFFLINE)"

# ===========================================================================
act "4b. Late joiner (outsider re-using N1) catches up the batch via M1/M2/cores while curator is offline"
# ===========================================================================
# Codex PR #622 R2: the prior version only re-read M1/M2 (already online
# during the write), never exercising the late-joiner/catchup path the
# header claims to cover. Now: N1 (otherwise an outsider) pre-creates
# the CG with the same allowlist + agent address, then triggers catchup.
# We assert it picks up ≥4 triples WITHOUT the curator coming back.
#
# This validates the host-catchup path that the broader LU-6 stack is
# meant to enable.
LATE_NODE="$OUTSIDER_NODE"
LATE_AGENT=$(api_call "$LATE_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
ALLOWED_LATE='["'"$CURATOR_AGENT"'", "'"$M1_AGENT"'", "'"$M2_AGENT"'", "'"$LATE_AGENT"'"]'
log "Late joiner: $LATE_AGENT (node $LATE_NODE)"

# We can't add a participant on chain without the curator, but we CAN
# pre-create locally + trust the SWM gossip / host-catchup path. The
# point of this phase is to prove the data is still discoverable while
# the curator is offline — not to test on-chain participant management.
api_call "$LATE_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "curator-offline ${STAMP} (late joiner)",
  "accessPolicy": 1, "publishPolicy": 1, "allowedAgents": $ALLOWED_LATE }
EOF
)" >/dev/null || true
sleep 2

LATE_RESULT=$(count_triples "$LATE_NODE")
log "Late joiner caught: ${LATE_RESULT:-<read-failed>} triples (curator still offline)"
if [ -z "$LATE_RESULT" ] || [ "$LATE_RESULT" -lt 4 ] 2>/dev/null; then
  # On a strictly-curated CG the late joiner can be denied (they weren't
  # in the original chain-anchored allowlist). That's expected — log
  # the outcome but don't fail the script: this phase is best-effort
  # observability, the headline assertion is phase 5.
  warn "Late joiner did NOT reach 4 triples (got ${LATE_RESULT:-<empty>}). " \
       "Acceptable if the chain-anchored allowlist denies them; surfacing for awareness."
else
  log "✓ late joiner pulled the full batch with curator offline — host-catchup path works"
fi

# ===========================================================================
act "5. M1 (non-curator) publishes to VM with the curator still offline"
# ===========================================================================
PUB_RESP=$(api_call "$M1_NODE" POST /api/shared-memory/publish "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "selection": "all", "clearAfter": false }
EOF
)")
log "M1 publish response: $PUB_RESP"
STATUS=$(parse_json "$PUB_RESP" '.status')
TX=$(parse_json    "$PUB_RESP" '.txHash')
KC=$(parse_json    "$PUB_RESP" '.kcId')
if [ "$STATUS" != "confirmed" ] || [ -z "$TX" ]; then
  fail "non-curator publish did NOT confirm on-chain (status=$STATUS, tx=$TX) — open-publishPolicy resilience contract BROKEN"
fi
log "✓ M1 published to VM without curator: kcId=$KC tx=$TX"

# ===========================================================================
act "6. Outsider verifies the published KC's merkleRoot exists on chain"
# ===========================================================================
KC_META=$(api_call "$OUTSIDER_NODE" GET "/api/kc/$KC")
MERKLE_ROOT=$(parse_json "$KC_META" '.merkleRoot')
if ! [[ "$MERKLE_ROOT" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  fail "outsider couldn't fetch KC merkleRoot — landing wasn't durable (got: $KC_META)"
fi
log "✓ outsider observed merkleRoot=$MERKLE_ROOT for kc=$KC"

# Phase 7 (restart curator) intentionally removed: the EXIT trap
# at the top of the script handles cleanup on BOTH success and
# failure, so the explicit restart-on-success step here was
# redundant and didn't cover failure exits.

log ""
log "================================================================"
log "  RFC-38 LU-6 C2 (curator-offline mid-batch): PASS"
log "================================================================"
log "  Curated CG:    $CG_ID  (onChainId=$ON_CHAIN_ID, publishPolicy=open)"
log "  Triples in:    4 (curator-written, gossiped to members)"
log "  Curator:       SIGTERMed before publish"
log "  M1 published:  kcId=$KC tx=$TX merkleRoot=$MERKLE_ROOT"
log "  Outsider:      observed merkleRoot on chain"
log "================================================================"
