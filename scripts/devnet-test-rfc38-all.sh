#!/usr/bin/env bash
#
# OT-RFC-38 — full integration runner. Executes every per-LU devnet
# validation script in sequence and prints a consolidated summary.
#
# Prerequisite: devnet is up (`./scripts/devnet.sh up`) with all 6 nodes
# healthy. The script does not rebuild — call this AFTER the per-LU
# scripts have already exercised their own restart cycles, OR after a
# clean `./scripts/devnet.sh restart-all`. It only reads.
#
# Exit status: 0 if every LU's exit was 0, else the count of failing
# LUs (capped to 99 to fit a single byte).

set -u  # don't exit on errors — we want the summary

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="$REPO_ROOT/scripts"
RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/.devnet/integration-runs/$(date +%s)}"
mkdir -p "$RESULTS_DIR"

log()  { echo "[lu-all] $*"; }
note() { echo "[lu-all] $*" | tee -a "$RESULTS_DIR/summary.txt" >/dev/null; }

# Each entry: "<short id>:<script>:<description>"
SCENARIOS=(
  "lu5-pub:devnet-test-rfc38-lu5-public.sh:LU-5 public CG regression (edge publishes plaintext to VM, no encryption)"
  "lu5-cur:devnet-test-rfc38-lu5.sh:LU-5 curated CG edge publish (chain-key AEAD wrap + no-attribution VM publish)"
  "lu7:devnet-test-rfc38-lu7.sh:LU-7 SWMCatchupRequest (public anonymous + curated member-auth + outsider denial)"
  "lu8:devnet-test-rfc38-lu8.sh:LU-8 verify-batch + report-batch-rejection (member post-decrypt root recompute + gossip)"
  "lu9:devnet-test-rfc38-lu9.sh:LU-9 member-attestation mint+verify (roundtrip + 3 negative-path scenarios)"
  "lu10:devnet-test-rfc38-lu10.sh:LU-10 public-CG regression sweep (publish + anonymous catchup + verify-batch + attestation, all on public CG)"
  "e2e:devnet-test-rfc38-e2e.sh:RFC-38 end-to-end lifecycle (LU-5 → LU-7 → LU-8 → LU-9 composed in a single user-visible scenario)"
  "xcg:devnet-test-rfc38-cross-cg.sh:RFC-38 cross-CG isolation (member of CG-A cannot read CG-B; outsider catchup denied; curator can still decrypt its own CGs)"
  "mm:devnet-test-rfc38-multi-member.sh:RFC-38 multi-member CG (3 distinct member wallets; each verify-batches the same root; outsider cross-verifies all 3 attestations)"
  "scale:devnet-test-rfc38-scale.sh:RFC-38 scale probe (50 triples / 25 KAs in one curated batch; full verify + attestation roundtrip)"
  "lj:devnet-test-rfc38-late-joiner.sh:RFC-38 late-joiner (member-from-curator + member-from-member-with-curator-offline; documented LU-6 cores-only gap)"
)

declare -a RESULTS

START_TS=$(date +%s)
log "Run started at $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
log "Results directory: $RESULTS_DIR"
log ""

FIRST=1
for entry in "${SCENARIOS[@]}"; do
  IFS=':' read -r id script desc <<< "$entry"
  log "================================================================"
  log "Running $id — $desc"
  log "  script: $script"
  log "================================================================"
  if [ ! -x "$SCRIPTS_DIR/$script" ]; then
    log "FAIL: $script is not executable or does not exist"
    RESULTS+=("$id:MISSING:$desc")
    continue
  fi
  # Give the devnet a moment between back-to-back tests so SWM gossip,
  # sender-key broadcasts, and durable batch fanout can settle. Each
  # standalone LU script passes on a quiet devnet, but the integration
  # suite drives them sequentially without intermediate idle time —
  # which is exactly what surfaces "passes alone, fails together"
  # timing bugs in caller-facing flows. 10s is enough headroom without
  # making the whole suite drag.
  if [ "$FIRST" -eq 0 ]; then
    log "Settle window (10s) between scenarios..."
    sleep 10
  fi
  FIRST=0
  LOGFILE="$RESULTS_DIR/${id}.log"
  if (
    cd "$REPO_ROOT" && "$SCRIPTS_DIR/$script"
  ) > "$LOGFILE" 2>&1; then
    log "PASS: $id"
    RESULTS+=("$id:PASS:$desc")
  else
    EC=$?
    log "FAIL: $id (exit=$EC)"
    log "  last 20 lines of $LOGFILE:"
    tail -n 20 "$LOGFILE" | sed 's/^/    /'
    RESULTS+=("$id:FAIL($EC):$desc")
  fi
  log ""
done

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

log ""
log "================================================================"
log "  OT-RFC-38 INTEGRATION RUN SUMMARY"
log "================================================================"
note "OT-RFC-38 INTEGRATION RUN SUMMARY"
# Codex PR #609: `date -r <epoch>` is BSD/macOS syntax; on GNU/Linux
# `-r` expects a FILE path, so the summary step previously errored on
# Linux CI / dev environments. Probe for BSD vs. GNU once and use the
# portable form for each.
epoch_to_iso() {
  local epoch="$1"
  if date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ' >/dev/null 2>&1; then
    date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ'        # BSD (macOS)
  else
    date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ'       # GNU coreutils
  fi
}
note "Run started: $(epoch_to_iso "$START_TS")"
note "Run ended:   $(epoch_to_iso "$END_TS")"
note "Duration:    ${DURATION}s"
note ""

FAIL_COUNT=0
for r in "${RESULTS[@]}"; do
  IFS=':' read -r id status desc <<< "$r"
  marker="[ok]"
  case "$status" in
    PASS) marker="[ok]" ;;
    MISSING) marker="[!!]" FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    FAIL*) marker="[XX]" FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
  esac
  printf '%-5s %-10s %-12s %s\n' "$marker" "$id" "$status" "$desc" | tee -a "$RESULTS_DIR/summary.txt"
done

log ""
log "Per-script logs available under: $RESULTS_DIR"
log "Summary file: $RESULTS_DIR/summary.txt"
log ""
if [ "$FAIL_COUNT" -eq 0 ]; then
  log "All ${#RESULTS[@]} scenarios PASSED."
else
  log "${FAIL_COUNT} of ${#RESULTS[@]} scenarios FAILED."
fi

[ "$FAIL_COUNT" -gt 99 ] && FAIL_COUNT=99
exit "$FAIL_COUNT"
