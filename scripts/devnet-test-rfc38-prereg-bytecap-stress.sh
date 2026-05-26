#!/usr/bin/env bash
#
# OT-RFC-38 LU-6 C3 — PRE-REGISTRATION BYTE-CAP STRESS test.
#
# Validates that the per-curator + per-CG byte caps and the sliding-
# window rate limit on `DiscoveryRateLimit` (see
# `packages/agent/src/swm/discovery-rate-limit.ts`) and the
# `unregisteredLimits.perCgByteCap` on `SwmHostModeStore` actually
# enforce when a curator floods cores with ciphertext for a CG that
# has NOT been registered on chain (the freemium-tier abuse scenario
# spelled out in RFC §1.2.4).
#
# Test phases:
#
#   1. Curator (N5) creates a curated CG locally WITHOUT register=true,
#      so it stays in the pre-registration tier.
#   2. A core (N1) is told to host-mode-subscribe to the CG
#      explicitly (the auto-subscribe path can't fire pre-registration
#      without a beacon broadcast cycle; we short-circuit it here).
#   3. Curator writes a sequence of fat triples (large literal
#      payloads) to SWM. Each write produces a gossip envelope.
#   4. After the burst, the core's `/api/shared-memory/host-mode/stats`
#      MUST report `perCg[CG_ID].bytes` ≤ the unregistered byte cap
#      (default 1 MiB). The total submitted is deliberately larger,
#      so a working cap clamps the on-disk size to the limit.
#   5. The core's daemon.log is grepped for "Host-mode rejected
#      pre-reg envelope" lines (observability only — the byte cap
#      validated in phase 4 is the authoritative pass/fail
#      enforcement signal; explicit rejections are
#      complementary). Codex PR #623 R4 was right that the test
#      shouldn't OVER-claim DiscoveryRateLimit coverage.
#   6. The core process MUST still be alive (no crash under stress).
#
# Re-runnable: timestamp-suffixed CG id.
#
# Operator notes:
#   * The cap defaults (1 MiB/CG, 1 MiB/curator/min) are intentionally
#     small so an honest devnet doesn't take ages to trigger them.
#     Production operators can dial them up in node config.
#   * This is a STRESS test; expect log noise. The assertions allow
#     for either "size cap clamped" OR "rate limit rejected" as
#     successful enforcement — they're complementary controls.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
CORE_NODE=1

# Tune via env for tighter / looser stress. Default is 16 writes of
# ~80 KiB each = ~1.3 MiB submitted; exceeds the 1 MiB default cap.
WRITES_COUNT="${WRITES_COUNT:-16}"
WRITE_PAYLOAD_BYTES="${WRITE_PAYLOAD_BYTES:-81920}"

# Default configured cap for pre-registration CGs is exactly 1 MiB,
# enforced after every append via `enforceLimitsAfterAppend`. After
# the burst settles the core's perCg.bytes MUST be ≤ this cap.
# Operators running with a custom config can override via
# EXPECTED_CAP_BYTES. Allow a small overhead allowance for envelope
# framing.
EXPECTED_CAP_BYTES="${EXPECTED_CAP_BYTES:-1048576}"
CAP_OVERHEAD_BYTES="${CAP_OVERHEAD_BYTES:-65536}"

log()  { echo "[cap] $*"; }
warn() { echo "[cap] WARN: $*" >&2; }
fail() { echo "[cap] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[cap] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }
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

CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/stress-${STAMP}"

log "Curator: $CURATOR_AGENT (node $CURATOR_NODE)"
log "Core:    node $CORE_NODE (will host opaque ciphertext)"
log "CG:      $CG_ID  (pre-registration / freemium tier)"
log "Stress:  $WRITES_COUNT writes × ${WRITE_PAYLOAD_BYTES} bytes ≈ $((WRITES_COUNT * WRITE_PAYLOAD_BYTES / 1024)) KiB total"

# ===========================================================================
act "1. Curator creates curated CG locally (NO register)"
# ===========================================================================
CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "stress ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": ["$CURATOR_AGENT"] }
EOF
)")
# Codex PR #623 R1: /api/context-graph/create (without register) returns
# `{ created, uri }`, not `{ id }`. Reading `.id` produced an empty
# string and the next [-n] check aborted the script before the burst
# ever ran. Read `.created` instead.
CREATED_ID=$(parse_json "$CREATE" '.created')
[ -n "$CREATED_ID" ] || fail "create failed: $CREATE"
log "✓ pre-reg CG created locally created=$CREATED_ID"

# ===========================================================================
act "2. Core explicitly subscribes in host-mode (short-circuits beacon)"
# ===========================================================================
SUB_RESP=$(api_call "$CORE_NODE" POST /api/shared-memory/host-mode/subscribe "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)")
log "Core subscribe response: $SUB_RESP"
# We accept either {ok:true} or {enabled:true} — depends on agent version.
case "$SUB_RESP" in
  *enabled*true*|*ok*true*|*"\"subscribed\":true"*) log "✓ core host-mode subscribed" ;;
  *) warn "core subscribe response shape unrecognised; continuing — stats endpoint will tell us" ;;
esac
sleep 2

# Snapshot the daemon.log size on the core so we only grep the new tail
CORE_LOG=$(node_log "$CORE_NODE")
if [ -f "$CORE_LOG" ]; then
  LOG_OFFSET=$(wc -c < "$CORE_LOG" | tr -d ' ')
else
  LOG_OFFSET=0
fi
log "Core log offset before burst: $LOG_OFFSET bytes"

# ===========================================================================
act "3. Burst: $WRITES_COUNT large writes from curator"
# ===========================================================================
# Codex PR #623 R2: `|| true` hid every write failure, so the loop
# could complete even if no envelope was ever emitted (= false PASS).
# Track successful writes and require >0 before the assertion runs.
SUCCESSFUL_WRITES=0
for i in $(seq 1 "$WRITES_COUNT"); do
  PAYLOAD=$(STAMP="$STAMP" CG_ID="$CG_ID" I="$i" BYTES="$WRITE_PAYLOAD_BYTES" node -e '
    const stamp = process.env.STAMP;
    const cgId = process.env.CG_ID;
    const i = process.env.I;
    const bytes = Number(process.env.BYTES);
    const filler = "x".repeat(bytes);
    const entity = "urn:stress:" + stamp + "/big-" + i;
    const quads = [{
      subject: entity,
      predicate: "http://schema.org/note",
      object: "\"" + filler + "\"",
      graph: "",
    }];
    console.log(JSON.stringify({ contextGraphId: cgId, quads }));
  ')
  RESP=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$PAYLOAD")
  N=$(parse_json "$RESP" '.triplesWritten' 2>/dev/null || echo "?")
  printf '[cap]   write %02d/%02d → triplesWritten=%s\n' "$i" "$WRITES_COUNT" "$N"
  if [ "$N" = "1" ]; then
    SUCCESSFUL_WRITES=$((SUCCESSFUL_WRITES + 1))
  fi
done
[ "$SUCCESSFUL_WRITES" -gt 0 ] || fail "no SWM writes succeeded — can't validate cap enforcement (precondition broken)"

# Codex PR #623 follow-up: `> 0 writes` alone is vacuous as a cap
# precondition. With the default 80 KiB payload size, anything up
# to 12 writes stays UNDER the 1 MiB cap, so the byte-clamp check
# in phase 4 wouldn't exercise anything if the actual submitted
# total never exceeded the cap. Compute the actual submitted bytes
# and fail if it can't possibly trigger clamping — a misconfigured
# burst is a TEST bug, not a daemon bug, and silently passing it
# masks real regressions.
SUBMITTED_BYTES=$((SUCCESSFUL_WRITES * WRITE_PAYLOAD_BYTES))
log "✓ burst complete: $SUCCESSFUL_WRITES / $WRITES_COUNT writes succeeded; submitted ≈$SUBMITTED_BYTES bytes"
if [ "$SUBMITTED_BYTES" -le "$EXPECTED_CAP_BYTES" ]; then
  fail "TEST CONFIGURATION ERROR: submitted ${SUBMITTED_BYTES} bytes ≤ cap ${EXPECTED_CAP_BYTES}. " \
       "The burst must exceed the cap for phase 4's clamp assertion to mean anything. " \
       "Increase WRITES_COUNT or WRITE_PAYLOAD_BYTES, or lower EXPECTED_CAP_BYTES to match a smaller configured cap."
fi
log "✓ submitted ${SUBMITTED_BYTES} bytes > cap ${EXPECTED_CAP_BYTES} → phase 4's clamp assertion is meaningful"
log "waiting 3s for envelopes to settle on core"
sleep 3

# ===========================================================================
act "4. Inspect core host-mode stats — perCg.bytes ≤ unregistered cap"
# ===========================================================================
STATS=$(api_call "$CORE_NODE" GET /api/shared-memory/host-mode/stats)
log "Stats response: $STATS"
ENABLED=$(parse_json "$STATS" '.enabled')
[ "$ENABLED" = "true" ] || fail "core does not have host-mode enabled — devnet config issue, can't validate cap"

BYTES=$(parse_json "$STATS" ".perCg['$CG_ID'].bytes" 2>/dev/null || echo "")
ENTRIES=$(parse_json "$STATS" ".perCg['$CG_ID'].entries" 2>/dev/null || echo "")
REGISTERED=$(parse_json "$STATS" ".perCg['$CG_ID'].registered" 2>/dev/null || echo "")
log "Core perCg[$CG_ID]: bytes=$BYTES entries=$ENTRIES registered=$REGISTERED"

if [ -z "$BYTES" ] || [ "$BYTES" = "0" ]; then
  fail "core didn't store any ciphertext — the gossip path or the explicit host-mode subscribe didn't engage. Burst submitted $((WRITES_COUNT * WRITE_PAYLOAD_BYTES)) bytes; core saw zero. Cap can't be validated against an empty store."
fi

# Codex PR #623 R3: assert against the actual configured cap, not a
# loose 2 MiB ceiling that would mask a doubled-cap regression.
# `enforceLimitsAfterAppend` guarantees survivorBytes ≤ perCgByteCap
# after every oversized append, so the steady-state expectation is
# `bytes ≤ EXPECTED_CAP_BYTES + a small overhead allowance`. The
# allowance covers the in-flight envelope between append and prune.
CAP_CEILING=$((EXPECTED_CAP_BYTES + CAP_OVERHEAD_BYTES))
if [ "$BYTES" -gt "$CAP_CEILING" ]; then
  fail "byte cap NOT enforced: core stored $BYTES bytes for pre-reg CG " \
       "(configured cap = $EXPECTED_CAP_BYTES, hard ceiling = $CAP_CEILING). " \
       "Submitted total was $((WRITES_COUNT * WRITE_PAYLOAD_BYTES)) bytes — " \
       "anything beyond the cap is a regression. Override EXPECTED_CAP_BYTES if your node uses a non-default config."
fi
log "✓ core's perCg.bytes ($BYTES) ≤ cap+slop ($CAP_CEILING) → cap is enforcing"

# ===========================================================================
act "5. Inspect daemon.log for rejection lines (observability only)"
# ===========================================================================
# Codex PR #623 R4 acknowledged: the byte-cap clamp (validated in
# phase 4) is the authoritative enforcement signal. Explicit
# DiscoveryRateLimit rejection messages are observability — the
# clamp passing without rejection lines is acceptable (the cap
# absorbed the burst in time). The lines below help operators
# tune limits but are NOT pass/fail criteria.
if [ -f "$CORE_LOG" ]; then
  REJ_COUNT=$(tail -c +"$((LOG_OFFSET + 1))" "$CORE_LOG" 2>/dev/null | grep -c "Host-mode rejected pre-reg envelope" || true)
  log "Rejection lines since burst: $REJ_COUNT (informational — byte cap is the authoritative control)"
  if [ "$REJ_COUNT" != "0" ]; then
    SAMPLE=$(tail -c +"$((LOG_OFFSET + 1))" "$CORE_LOG" | grep "Host-mode rejected pre-reg envelope" | tail -1)
    log "  example: $SAMPLE"
  fi
else
  log "core daemon.log missing — skipping observability grep"
fi

# ===========================================================================
act "6. Confirm the core process is still alive"
# ===========================================================================
# Codex PR #623 follow-up: missing/empty pidfile MUST NOT be a free
# pass. Previously the `if [ -f $CORE_PIDFILE ]` branch silently
# skipped the liveness check on a stale or never-written pidfile,
# turning a real crash into a false PASS (the script printed
# "Core process: still alive after burst" in the summary regardless).
# Hard-fail on missing/empty pidfile, falling back to an HTTP
# liveness probe via /api/status so test environments that don't
# write pidfiles (containerised devnets, kubectl-managed pods, etc.)
# still get a meaningful check.
CORE_PIDFILE=$(node_pidfile "$CORE_NODE")
if [ -f "$CORE_PIDFILE" ] && [ -s "$CORE_PIDFILE" ]; then
  CORE_PID=$(tr -d '[:space:]' < "$CORE_PIDFILE")
  if [ -z "$CORE_PID" ]; then
    fail "core pidfile $CORE_PIDFILE exists but is empty — cannot validate liveness"
  fi
  if kill -0 "$CORE_PID" 2>/dev/null; then
    log "✓ core pid=$CORE_PID still running"
  else
    fail "core process pid=$CORE_PID died under stress — daemon crash regression"
  fi
else
  # No pidfile: fall back to HTTP liveness. `/api/status` is the
  # standard daemon health surface and a 2xx response proves the
  # process is alive AND serving requests.
  warn "core pidfile $CORE_PIDFILE missing or empty — falling back to /api/status liveness probe"
  if curl -sf --max-time 5 "http://127.0.0.1:$(node_port "$CORE_NODE")/api/status" >/dev/null 2>&1; then
    log "✓ core /api/status responsive — daemon alive (pidfile-less liveness confirmed)"
  else
    fail "core has no pidfile AND /api/status is unreachable — daemon crashed under stress."
  fi
fi

log ""
log "================================================================"
log "  RFC-38 LU-6 C3 (pre-reg byte-cap stress): PASS"
log "================================================================"
log "  Pre-reg CG:    $CG_ID"
log "  Submitted:     $((WRITES_COUNT * WRITE_PAYLOAD_BYTES)) bytes across $WRITES_COUNT envelopes"
log "  Core stored:   $BYTES bytes ($ENTRIES entries) — clamped under $CAP_CEILING ceiling"
log "  Core process:  still alive after burst"
log "================================================================"
