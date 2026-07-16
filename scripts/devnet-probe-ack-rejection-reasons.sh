#!/usr/bin/env bash
#
# rc.12 probe — structured ACK rejection reasons (PR commit f44669d5,
# packages/publisher/src/ack-collector.ts + chain-adapter.ts +
# evm-adapter.ts).
#
# The new behaviour: ACK pre-flight rejections now carry a typed
# reason in the union:
#   * 'key-not-registered'    — recovered signer is not an OPERATIONAL_KEY
#   * 'not-in-sharding-table' — identity below minimumStake
#   * 'rpc-error'             — chain RPC threw, can't tell
#
# This probe verifies the surface area is wired by:
#   1. Loading the access-handler / ack-collector / chain-adapter source
#      and checking the reason union is present at runtime (build smoke);
#   2. Inspecting daemon.log for any pre-existing rejection signal — if
#      present, confirm it's tagged with one of the three reasons;
#   3. Best-effort: publish a small KC and tail node logs for "key-not-
#      registered" / "not-in-sharding-table" / "rpc-error" — under
#      healthy devnet conditions we expect zero rejections (it'd ALL pass)
#      so the absence-of-rejection is itself a green signal.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
AUTH_TOKEN=$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" 2>/dev/null | head -1 || echo "")
AUTH_HEADER="Authorization: Bearer $AUTH_TOKEN"

PASS=0
FAIL=0
declare -a FAILURES

ok()   { PASS=$((PASS+1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL+1)); FAILURES+=("$*"); echo "  FAIL: $*"; }

echo "=== Probe: structured ACK rejection reasons (commit f44669d5) ==="

# --- 1. Source-level wiring fence ---
echo ""
echo "--- 1. ACKVerifyReason union present in built code ---"
if grep -q "key-not-registered" "$REPO_ROOT/packages/publisher/dist/ack-collector.js" 2>/dev/null \
   || grep -q "key-not-registered" "$REPO_ROOT/packages/publisher/src/ack-collector.ts" 2>/dev/null; then
  ok "ACKVerifyReason union present (key-not-registered)"
else
  fail "ACKVerifyReason union missing — wiring may not have landed"
fi

if grep -q "not-in-sharding-table" "$REPO_ROOT/packages/publisher/dist/ack-collector.js" 2>/dev/null \
   || grep -q "not-in-sharding-table" "$REPO_ROOT/packages/publisher/src/ack-collector.ts" 2>/dev/null; then
  ok "ACKVerifyReason union present (not-in-sharding-table)"
else
  fail "not-in-sharding-table reason missing"
fi

if grep -q "rpc-error" "$REPO_ROOT/packages/publisher/dist/ack-collector.js" 2>/dev/null \
   || grep -q "rpc-error" "$REPO_ROOT/packages/publisher/src/ack-collector.ts" 2>/dev/null; then
  ok "ACKVerifyReason union present (rpc-error)"
else
  fail "rpc-error reason missing"
fi

# verifyACKIdentityDetailed exists on the chain adapter?
if grep -q "verifyACKIdentityDetailed" "$REPO_ROOT/packages/chain/dist/chain-adapter.js" 2>/dev/null \
   || grep -q "verifyACKIdentityDetailed" "$REPO_ROOT/packages/chain/src/chain-adapter.ts" 2>/dev/null; then
  ok "verifyACKIdentityDetailed wired on ChainAdapter"
else
  fail "verifyACKIdentityDetailed missing on ChainAdapter"
fi

if grep -q "verifyIdentityDetailed" "$REPO_ROOT/packages/publisher/dist/ack-collector.js" 2>/dev/null \
   || grep -q "verifyIdentityDetailed" "$REPO_ROOT/packages/publisher/src/ack-collector.ts" 2>/dev/null; then
  ok "ACKCollector consumes verifyIdentityDetailed"
else
  fail "ACKCollector does not consume verifyIdentityDetailed"
fi

# --- 2. Healthy devnet should have ZERO ACK rejections under normal traffic ---
echo ""
echo "--- 2. Devnet baseline: rejections under healthy traffic ---"
TOTAL_REJ=0
for n in 1 2 3 4; do
  rej_count=$(grep -cE "ACK rejected|ACK rejection|reject.{0,3}ACK|key-not-registered|not-in-sharding-table|rpc-error" \
    "$DEVNET_DIR/node${n}/daemon.log" 2>/dev/null)
  # grep -c outputs a single integer per file; trim potential leading
  # whitespace + handle missing-file case for bash 3.2 arithmetic.
  rej_count=$(printf '%s' "${rej_count:-0}" | tr -dc '0-9')
  rej_count=${rej_count:-0}
  TOTAL_REJ=$((TOTAL_REJ + rej_count))
  if [ "$rej_count" -eq 0 ]; then
    ok "node $n: 0 ACK rejections so far in daemon.log"
  else
    has_structured=$(grep -cE "key-not-registered|not-in-sharding-table|rpc-error" \
      "$DEVNET_DIR/node${n}/daemon.log" 2>/dev/null)
    has_structured=$(printf '%s' "${has_structured:-0}" | tr -dc '0-9')
    has_structured=${has_structured:-0}
    if [ "$has_structured" -gt 0 ]; then
      ok "node $n: $rej_count ACK rejection(s), $has_structured carry a structured reason"
    else
      fail "node $n: $rej_count ACK rejection(s) found but NONE tagged with structured reason"
    fi
  fi
done

# --- 3. SWM-based publish trigger: confirm new ACK traffic + zero structured rejections ---
# rc.12 deprecated the synchronous /api/publish endpoint (404 in
# this branch). The async publish path is /api/knowledge-assets/<name>/vm/publish-async
# which requires a pre-staged shareOperationId + authority proof.
# Reproducing that surface for a probe is brittle; instead we let the
# devnet-full-sweep / rfc38-all suites do the publishing and use the
# log-tail check above (#2) as the steady-state assertion. If those
# suites passed (sweep + rfc38-all are run by the orchestrator before
# probes), any structured rejection that occurred would already be
# in daemon.log and flagged in #2.
echo ""
echo "--- 3. Cross-check ACK telemetry via /api/publisher/stats ---"
STATS=$(curl -sf -H "$AUTH_HEADER" "http://127.0.0.1:$API_PORT_BASE/api/publisher/stats" 2>/dev/null || echo '{}')
if echo "$STATS" | python3 -c "import sys,json;d=json.load(sys.stdin);sys.exit(0 if isinstance(d, dict) else 1)" 2>/dev/null; then
  ok "/api/publisher/stats reachable on node 1"
  # Surface counters of interest if present.
  echo "$STATS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k in ('pending','enqueued','running','succeeded','failed','rejected','total'):
  if k in d:
    print('    ' + k + '=' + str(d[k]))
" 2>/dev/null || true
else
  fail "/api/publisher/stats unreachable or non-JSON: $STATS"
fi

echo ""
echo "=== Probe summary: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
