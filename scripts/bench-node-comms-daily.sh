#!/usr/bin/env bash
#
# Daily node-communication benchmark runner.
#
# Rebuilds the agent (so the benchmark measures current code), runs the
# node-comms benchmark, and lets the benchmark's own regression check decide the
# exit code:
#   - exit 0  : no regression above threshold (or this run established a baseline)
#   - exit 1  : at least one tracked metric regressed beyond the threshold (FLAGGED)
#   - exit 2  : the benchmark itself failed to run
#
# Designed for an unattended cron / launchd job. On exit 1, the scheduler (or a
# wrapper) should alert. A timestamped log is written under
# bench/results/node-comms/logs/.
#
# Usage:
#   scripts/bench-node-comms-daily.sh [-- <extra args forwarded to the benchmark>]
#
# Environment:
#   BENCH_REGRESSION_THRESHOLD_PCT   delta % that flags a regression (default 15)
#   BENCH_NODE_COMMS_SKIP_BUILD=1    skip the rebuild step (use existing dist)
#   BENCH_NODE_COMMS_ITERATIONS / _BULK / _CATCHUP_ITER   scenario sizing
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

RESULTS_DIR="${REPO_ROOT}/bench/results/node-comms"
LOG_DIR="${RESULTS_DIR}/logs"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/$(date +%Y%m%d-%H%M%S).log"

# Make pnpm available the same way the repo expects (corepack-managed).
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
fi
PNPM="pnpm"
command -v pnpm >/dev/null 2>&1 || PNPM="corepack pnpm"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*" | tee -a "${LOG_FILE}"; }

log "node-comms daily benchmark starting (repo: ${REPO_ROOT})"

if [ "${BENCH_NODE_COMMS_SKIP_BUILD:-0}" != "1" ]; then
  log "building agent + dependencies so the benchmark reflects current code…"
  if ! ${PNPM} --filter "@origintrail-official/dkg-agent..." build >>"${LOG_FILE}" 2>&1; then
    log "✗ build failed — see ${LOG_FILE} (exit 2)"
    exit 2
  fi
else
  log "skipping build (BENCH_NODE_COMMS_SKIP_BUILD=1)"
fi

log "running benchmark…"
# Match the npm script: `--expose-gc` lets the runner take a post-GC heap
# reading, keeping the memory metrics stable enough to compare day-over-day.
set +e
node --import tsx --expose-gc "${REPO_ROOT}/bench/node-comms/run-node-comms-bench.ts" "$@" 2>&1 | tee -a "${LOG_FILE}"
STATUS="${PIPESTATUS[0]}"
set -e

case "${STATUS}" in
  0) log "✅ no regression flagged (exit 0)" ;;
  1) log "🚩 REGRESSION FLAGGED — see ${RESULTS_DIR}/regression-report.json (exit 1)" ;;
  *) log "✗ benchmark failed to run (exit ${STATUS})" ;;
esac

log "log written to ${LOG_FILE}"
exit "${STATUS}"
