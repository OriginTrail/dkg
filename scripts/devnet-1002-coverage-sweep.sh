#!/usr/bin/env bash
#
# DKG 10.0.2 coverage comprehensive sweep (long-running).
#
# ORDER MATTERS (learned the hard way): the stability loop runs on a HEALTHY
# devnet FIRST; the destructive shell orchestrator (which restarts nodes and can
# leave the devnet degraded) runs LAST so it can't poison the loop. Every
# stability round is HEALTH-GUARDED — if the devnet goes unreachable the loop
# ABORTS immediately instead of hammering a dead devnet.
#
# Phases:
#   1. ONE PASS of the 7 new PR-coverage suites + v10-end-to-end (baseline).
#   2. STABILITY LOOP of those suites until (TARGET - ORCH reserve) elapses,
#      health-guarded, aggregating per-suite pass-rates → surfaces intermittents
#      (RS timing, finalization dual-home race, SWM convergence).
#   3. (opt-in, LAST) devnet-comprehensive.sh WITH soak — destructive; runs only
#      if RUN_ORCHESTRATOR=1, time-boxed, and nothing runs after it.
#
# Sequential, native-oxigraph only (no emulated blazegraph node) → bounded load.
#
# Env: TARGET_SECONDS (default 14400=4h) · RUN_ORCHESTRATOR (default 0) ·
#      ORCH_RESERVE_SECONDS (default 5400=1.5h if orchestrator on, else 0) ·
#      SOAK_RS_SECONDS (default 1800) · STABILITY_SUITES (override list)
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
TS=$(date -u +'%Y%m%dT%H%M%SZ')
RESULTS="${RESULTS_DIR:-$REPO_ROOT/.devnet/1002-sweep/$TS}"; mkdir -p "$RESULTS"
ln -sfn "$RESULTS" "$(dirname "$RESULTS")/latest" 2>/dev/null || true
SUMMARY="$RESULTS/summary.log"; START=$(date +%s)
TARGET_SECONDS="${TARGET_SECONDS:-14400}"
RUN_ORCHESTRATOR="${RUN_ORCHESTRATOR:-0}"
SOAK_RS_SECONDS="${SOAK_RS_SECONDS:-1800}"
if [ "$RUN_ORCHESTRATOR" = "1" ]; then ORCH_RESERVE_SECONDS="${ORCH_RESERVE_SECONDS:-5400}"; else ORCH_RESERVE_SECONDS=0; fi

# Suite list is single-sourced in devnet/suites.json (guarded against drift by
# devnet/_bootstrap/suite-manifest.test.ts). Read the PR-coverage set from there.
SUITES_JSON="$REPO_ROOT/devnet/suites.json"
NEW_SUITES=($(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).prCoverage.join(' '))" "$SUITES_JSON" 2>/dev/null))
[ "${#NEW_SUITES[@]}" -gt 0 ] || { echo "FATAL: could not read prCoverage from $SUITES_JSON (need node in PATH)"; exit 2; }
STABILITY_SUITES="${STABILITY_SUITES:-${NEW_SUITES[*]} v10-end-to-end}"

log() { echo "[1002-sweep $(date -u +'%H:%M:%S')] $*" | tee -a "$SUMMARY"; }
elapsed() { echo $(( $(date +%s) - START )); }
loop_deadline() { echo $(( TARGET_SECONDS - ORCH_RESERVE_SECONDS )); }

# devnet health: all 6 node APIs + hardhat reachable. Returns 0 healthy / 1 not.
# BLIP-TOLERANT: a single probe can transiently ECONNRESET / time out on a busy
# node without the devnet being dead (observed: a healthy devnet tripped a naive
# single-probe check). Retry the whole check up to 3× with a 5s gap before
# declaring the devnet down — real death stays down across retries; a blip clears.
_probe_once() {
  curl -sf --max-time 5 http://127.0.0.1:8545 -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' >/dev/null 2>&1 || return 1
  local n code
  for n in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:920$n/api/status" 2>/dev/null || echo 000)
    [ "$code" = "200" ] || return 1
  done
  return 0
}
healthy() {
  local i
  for i in 1 2 3; do
    _probe_once && return 0
    [ "$i" -lt 3 ] && sleep 5
  done
  return 1
}

TALLY_NAMES=(); TALLY_PASS=(); TALLY_FAIL=(); TALLY_SKIP=()
tally() { # $1=name $2=pass|fail|skip
  local i found=-1
  for i in "${!TALLY_NAMES[@]}"; do [ "${TALLY_NAMES[$i]}" = "$1" ] && found=$i; done
  if [ "$found" -lt 0 ]; then TALLY_NAMES+=("$1"); TALLY_PASS+=(0); TALLY_FAIL+=(0); TALLY_SKIP+=(0); found=$(( ${#TALLY_NAMES[@]} - 1 )); fi
  case "$2" in
    pass) TALLY_PASS[$found]=$(( ${TALLY_PASS[$found]} + 1 ));;
    skip) TALLY_SKIP[$found]=$(( ${TALLY_SKIP[$found]} + 1 ));;
    *)    TALLY_FAIL[$found]=$(( ${TALLY_FAIL[$found]} + 1 ));;
  esac
}

# Run one suite. Echoes pass|fail|skip. A run whose only outcome is skipped tests
# is 'skip' (NOT fail — some existing suites skip when a precondition is absent).
run_suite() { # $1=suiteDir $2=logTag
  local dir="$1" tag="$2" rc logf="$RESULTS/${2}.log"
  [ -f "devnet/$dir/vitest.config.ts" ] || { echo skip; return; }
  pnpm vitest run --config "devnet/$dir/vitest.config.ts" > "$logf" 2>&1; rc=$?
  if [ $rc -eq 0 ]; then echo pass; return; fi
  # non-zero: distinguish "all skipped" (benign) from a real failure.
  if grep -qE "Tests +[0-9]+ skipped" "$logf" && ! grep -qE "Tests +[0-9]+ failed" "$logf"; then
    echo skip; return
  fi
  echo fail
}

# ── Pre-flight ────────────────────────────────────────────────────
log "10.0.2 sweep. target=${TARGET_SECONDS}s orch=${RUN_ORCHESTRATOR} loop_deadline=$(loop_deadline)s results=$RESULTS"
# Fail fast if the suite manifest drifted from disk/pnpm-workspace/package.json —
# else NEW_SUITES (read from suites.json) could silently under-test.
if ! pnpm vitest run --config devnet/_bootstrap/vitest.manifest.config.ts > "$RESULTS/manifest-guard.log" 2>&1; then
  log "FATAL: suite manifest drift — see $RESULTS/manifest-guard.log (run 'pnpm test:devnet:manifest')"; exit 2
fi
log "suite manifest consistent ($( echo "${NEW_SUITES[*]}" | wc -w | tr -d ' ') PR-coverage suites)."
if ! healthy; then log "FATAL: devnet not healthy at start — restart it first"; exit 2; fi
log "devnet healthy (6 nodes + hardhat)."

# ── Phase 1: baseline one pass ────────────────────────────────────
log "═══ PHASE 1: baseline one pass (${STABILITY_SUITES}) ═══"
for s in $STABILITY_SUITES; do r=$(run_suite "$s" "P1-$s"); log "  $(printf '%-6s' "$r") $s"; tally "$s" "$r"; done

# ── Phase 2: health-guarded stability loop ────────────────────────
log "═══ PHASE 2: stability loop until $(loop_deadline)s elapsed (health-guarded) ═══"
ROUND=0; ABORTED=0
while [ "$(elapsed)" -lt "$(loop_deadline)" ]; do
  if ! healthy; then
    log "⚠ DEVNET UNHEALTHY before round $((ROUND+1)) — ABORTING stability loop (elapsed $(elapsed)s). Not looping on a dead devnet."
    ABORTED=1; break
  fi
  ROUND=$(( ROUND + 1 ))
  log "── round $ROUND (elapsed $(elapsed)s / $(loop_deadline)s) ──"
  for s in $STABILITY_SUITES; do
    [ "$(elapsed)" -lt "$(loop_deadline)" ] || break
    r=$(run_suite "$s" "P2-r${ROUND}-$s")
    [ "$r" = "pass" ] || log "    $r $s (round $ROUND)"
    tally "$s" "$r"
  done
done
[ "$ABORTED" = "0" ] && log "PHASE 2 done: $ROUND rounds."

# ── Phase 3: destructive orchestrator LAST (opt-in) ───────────────
# ORCH_RC: "" = didn't run; 0 = ok; 124/137 = hit the time-box cap (EXPECTED,
# non-fatal); any other non-zero = a real orchestrator failure (gates the sweep).
ORCH_RC=""
if [ "$RUN_ORCHESTRATOR" = "1" ] && healthy; then
  TO_BIN=""; command -v gtimeout >/dev/null 2>&1 && TO_BIN=gtimeout || { command -v timeout >/dev/null 2>&1 && TO_BIN=timeout; }
  CAP=$(( TARGET_SECONDS - $(elapsed) - 60 )); [ "$CAP" -lt 300 ] && CAP=300
  log "═══ PHASE 3 (LAST): devnet-comprehensive.sh WITH soak (SOAK_RS_SECONDS=$SOAK_RS_SECONDS, cap=${CAP}s) — destructive, runs last ═══"
  if [ -n "$TO_BIN" ]; then
    SOAK_RS_SECONDS="$SOAK_RS_SECONDS" RESULTS_DIR="$RESULTS/orchestrator" "$TO_BIN" -k 60 "$CAP" \
      bash "$REPO_ROOT/scripts/devnet-comprehensive.sh" > "$RESULTS/orchestrator.log" 2>&1
    ORCH_RC=$?
  else
    SOAK_RS_SECONDS="$SOAK_RS_SECONDS" RESULTS_DIR="$RESULTS/orchestrator" \
      bash "$REPO_ROOT/scripts/devnet-comprehensive.sh" > "$RESULTS/orchestrator.log" 2>&1
    ORCH_RC=$?
  fi
  log "PHASE 3 (orchestrator) exit=$ORCH_RC — see orchestrator.log + orchestrator/"
elif [ "$RUN_ORCHESTRATOR" = "1" ]; then
  log "PHASE 3 skipped — devnet not healthy after stability loop."
  ORCH_RC="skipped"
fi

# ── Aggregate + exit code ─────────────────────────────────────────
# Exit non-zero so callers/CI can gate on this sweep (otReviewAgent #1397):
#   0 = all pass (skips allowed) · 1 = one or more suites FAILED ·
#   2 = health-guarded loop aborted (infra) · 3 = orchestrator failed.
TOTAL_FAILS=0
log "═══ PASS-RATES ($ROUND stability rounds + 1 baseline) ═══"
for i in "${!TALLY_NAMES[@]}"; do
  p=${TALLY_PASS[$i]}; f=${TALLY_FAIL[$i]}; k=${TALLY_SKIP[$i]}; tot=$(( p + f + k ))
  TOTAL_FAILS=$(( TOTAL_FAILS + f ))
  log "  $(printf '%-38s' "${TALLY_NAMES[$i]}") ${p}/${tot} pass$( [ "$f" -gt 0 ] && echo "  ⚠ ${f} FAIL" )$( [ "$k" -gt 0 ] && echo "  (${k} skip)" )"
done
# Orchestrator counts as failed on any non-zero EXCEPT the expected time-box
# cap (124 = timeout, 137 = SIGKILL after -k grace) and "skipped"/"" (didn't run).
ORCH_FAILED=0
case "$ORCH_RC" in ""|skipped|0|124|137) ;; *) ORCH_FAILED=1 ;; esac
log "TOTAL elapsed $(elapsed)s. aborted=$ABORTED. suite-failures=$TOTAL_FAILS. orchestrator=${ORCH_RC:-n/a}. Results: $RESULTS"
log "10.0.2 coverage sweep complete."
if [ "$TOTAL_FAILS" -gt 0 ]; then log "EXIT 1 — $TOTAL_FAILS suite failure(s)."; exit 1; fi
if [ "$ABORTED" != "0" ]; then log "EXIT 2 — health-guarded loop aborted (infra), no suite failures."; exit 2; fi
if [ "$ORCH_FAILED" = "1" ]; then log "EXIT 3 — orchestrator failed (exit=$ORCH_RC), no suite failures."; exit 3; fi
log "EXIT 0 — all pass."
exit 0
