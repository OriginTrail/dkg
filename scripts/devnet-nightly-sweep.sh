#!/bin/bash
# devnet-nightly-sweep.sh — run the FULL devnet suite set against fresh local
# devnets, suite list derived from devnet/suites.json so suite renames/additions
# never silently drift out of the nightly (the 2026-07 conviction-lazy-settle →
# conviction-emission-bell rename broke a hardcoded list; this script is the fix).
#
# Used by the DKG-Devnet-Tests Jenkins job (titan, Tests view) and runnable
# locally:
#
#   ./scripts/devnet-nightly-sweep.sh                 # full sweep
#   SMOKE=true ./scripts/devnet-nightly-sweep.sh      # manifest + 2-node rfc51 only
#
# Environment:
#   RESULTS_DIR        where RESULTS.log / verdict / per-suite logs go
#                      (default: ./devnet-results)
#   SMOKE              "true" = fast plumbing check only
#   KNOWN_ISSUES       space-separated suites whose failure must NOT redden the
#                      run (verdict KNOWN_ONLY instead of UNEXPECTED)
#   SUITE_TIMEOUT_S    per-suite hard cap (default 1500)
#   DEADLINE_UTC_HHMM  optional HHMM; once reached (within a 75-min window),
#                      remaining suites are SKIPPED — used on shared CI hosts to
#                      yield to other jobs' devnets. Empty = disabled.
#   API_PORT_BASE / DEVNET_ENABLE_PUBLISHER are honoured (publisher defaults on:
#   ka-lifecycle-cli + async VM publishes need the publisher runtime).
#
# Verdict contract (written to $RESULTS_DIR/verdict):
#   PASS_ALL    every suite passed
#   KNOWN_ONLY  only KNOWN_ISSUES suites failed (or deadline skips occurred)
#   UNEXPECTED  anything else failed — treat as a real regression
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RD="${RESULTS_DIR:-$REPO_ROOT/devnet-results}"
rm -rf "$RD"; mkdir -p "$RD"
RESULTS="$RD/RESULTS.log"
KNOWN_ISSUES="${KNOWN_ISSUES:-}"
SUITE_TIMEOUT_S="${SUITE_TIMEOUT_S:-1500}"
SMOKE="${SMOKE:-false}"
DEADLINE="${DEADLINE_UTC_HHMM:-}"
export DEVNET_ENABLE_PUBLISHER="${DEVNET_ENABLE_PUBLISHER:-1}"

UNEXPECTED=0; KNOWN_FAILED=0; SKIPPED=0

# GNU timeout exists on Linux CI; macOS may have it as gtimeout (coreutils) or
# not at all — degrade to no per-suite cap rather than exit-127 every suite.
if command -v timeout >/dev/null 2>&1; then TIMEOUT_CMD="timeout $SUITE_TIMEOUT_S"
elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_CMD="gtimeout $SUITE_TIMEOUT_S"
else TIMEOUT_CMD=""; fi

# ── suite list from suites.json (single source of truth) ────────────────────
# Emits "suite script" pairs; fails loudly on any suite without a runnable
# script so list drift is a visible error, never a silent gap.
suite_script_pairs() {
  node -e '
    const fs = require("fs");
    const suites = JSON.parse(fs.readFileSync("devnet/suites.json", "utf8")).all;
    const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts;
    const unmapped = [];
    for (const s of suites) {
      let script = null;
      if (scripts["test:devnet:" + s]) script = s;
      else {
        // alias: script whose vitest --config path points into this suite dir
        for (const [k, v] of Object.entries(scripts)) {
          if (k.startsWith("test:devnet:") && String(v).includes("devnet/" + s + "/")) {
            script = k.replace("test:devnet:", ""); break;
          }
        }
      }
      if (script) console.log(s + " " + script); else unmapped.push(s);
    }
    if (unmapped.length) { console.error("UNMAPPED SUITES (no test:devnet script): " + unmapped.join(", ")); process.exit(1); }
  '
}

past_deadline() {
  [ -n "$DEADLINE" ] || return 1
  local hm; hm=$(date -u +%H%M)
  local end=$(( 10#$DEADLINE + 75 ))
  [ "$hm" -ge "$DEADLINE" ] && [ "$hm" -le "$end" ]
}

run_suite() {
  local name=$1 script=${2:-$1}
  if past_deadline; then
    echo "SUITE $name: SKIPPED (deadline guard $DEADLINE UTC — yielding host)" >> "$RESULTS"
    SKIPPED=$((SKIPPED+1)); return
  fi
  local t0; t0=$(date +%s)
  $TIMEOUT_CMD pnpm "test:devnet:$script" > "$RD/$name.log" 2>&1
  local code=$?; local dt=$(( $(date +%s) - t0 ))
  if [ $code -eq 0 ]; then
    echo "SUITE $name: PASS (${dt}s)" >> "$RESULTS"
  elif echo " $KNOWN_ISSUES " | grep -q " $name "; then
    echo "SUITE $name: FAIL-KNOWN exit=$code (${dt}s) [known issue — run stays non-red]" >> "$RESULTS"
    KNOWN_FAILED=$((KNOWN_FAILED+1))
  else
    echo "SUITE $name: FAIL exit=$code (${dt}s) — see $name.log" >> "$RESULTS"
    UNEXPECTED=$((UNEXPECTED+1))
  fi
}

boot() {
  ./scripts/devnet.sh clean >> "$RD/boot.log" 2>&1 || true
  ./scripts/devnet.sh start "$1" >> "$RD/boot.log" 2>&1
  # capture-then-grep: piping status straight into grep -q SIGPIPEs the status
  # script on first match, and with pipefail that reads as a boot failure.
  local st
  for _ in 1 2 3; do
    st=$(./scripts/devnet.sh status 2>/dev/null || true)
    printf '%s\n' "$st" >> "$RD/boot.log"
    if printf '%s' "$st" | grep -Eq 'Node 1:[[:space:]]+RUNNING'; then return 0; fi
    sleep 5
  done
  return 1
}

echo "SWEEP START commit=$(git rev-parse --short HEAD) $(date -u '+%F %H:%M:%S UTC')" >> "$RESULTS"
run_suite manifest

if [ "$SMOKE" = "true" ]; then
  if boot 2; then echo "BOOT 2-node: OK" >> "$RESULTS"; run_suite rfc51-publishing-allocation
  else echo "BOOT 2-node: FAILED" >> "$RESULTS"; UNEXPECTED=$((UNEXPECTED+1)); fi
else
  PAIRS=$(suite_script_pairs) || { echo "SUITE-LIST DERIVATION FAILED — see above" >> "$RESULTS"; UNEXPECTED=$((UNEXPECTED+1)); PAIRS=""; }

  # Special lanes/ordering; everything else runs on the 6-node lane in
  # suites.json order. Pinned:
  #   rpc-quiet-window     — FIRST, pre-bootstrap (needs an idle chain)
  #   v10-core-flows       — right after bootstrap (freshest state; RS-timing sensitive)
  #   storage-ack-store-outage — near-last (pauses/resumes a core mid-publish)
  #   core-peers-features  — LAST (kills/restarts cores — destructive)
  #   agent-provenance     — own 5-node boot
  #   rfc51-publishing-allocation — own 2-node boot
  if boot 6; then
    echo "BOOT 6-node (publisher on): OK" >> "$RESULTS"
    sleep 90
    run_suite rpc-quiet-window
    node devnet/_bootstrap/bootstrap.cjs > "$RD/bootstrap.log" 2>&1 \
      && echo "BOOTSTRAP: OK" >> "$RESULTS" \
      || { echo "BOOTSTRAP: FAILED" >> "$RESULTS"; UNEXPECTED=$((UNEXPECTED+1)); }
    run_suite v10-core-flows
    while read -r name script; do
      case "$name" in
        manifest|rpc-quiet-window|v10-core-flows|storage-ack-store-outage|core-peers-features|agent-provenance|rfc51-publishing-allocation) continue ;;
      esac
      run_suite "$name" "$script"
    done <<< "$PAIRS"
    run_suite storage-ack-store-outage
    run_suite core-peers-features
  else
    echo "BOOT 6-node: FAILED" >> "$RESULTS"; UNEXPECTED=$((UNEXPECTED+1))
  fi

  if boot 5; then echo "BOOT 5-node: OK" >> "$RESULTS"; run_suite agent-provenance
  else echo "BOOT 5-node: FAILED" >> "$RESULTS"; UNEXPECTED=$((UNEXPECTED+1)); fi

  if boot 2; then echo "BOOT 2-node: OK" >> "$RESULTS"; run_suite rfc51-publishing-allocation
  else echo "BOOT 2-node: FAILED" >> "$RESULTS"; UNEXPECTED=$((UNEXPECTED+1)); fi
fi

./scripts/devnet.sh stop >> "$RD/boot.log" 2>&1 || true
echo "SWEEP DONE $(date -u '+%F %H:%M:%S UTC') unexpected=$UNEXPECTED known_failed=$KNOWN_FAILED skipped=$SKIPPED" >> "$RESULTS"

if [ $UNEXPECTED -gt 0 ]; then echo UNEXPECTED > "$RD/verdict"
elif [ $KNOWN_FAILED -gt 0 ] || [ $SKIPPED -gt 0 ]; then echo KNOWN_ONLY > "$RD/verdict"
else echo PASS_ALL > "$RD/verdict"; fi
exit 0
