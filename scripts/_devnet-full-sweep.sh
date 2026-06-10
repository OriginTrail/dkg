#!/usr/bin/env bash
#
# Internal sweep — runs every devnet-test script not already covered by
# devnet-test-rfc38-all.sh, plus the non-RFC-38 baseline harnesses.
# Aggregates pass/fail and writes per-script logs for triage.
#
# Prerequisite: devnet running (./scripts/devnet.sh start).

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="$REPO_ROOT/scripts"
RESULTS_DIR="${RESULTS_DIR:-$REPO_ROOT/.devnet/full-sweep/$(date +%s)}"
mkdir -p "$RESULTS_DIR"

# Order matters for the stateful ones: revocation / unclean-restart mutate
# the devnet in ways subsequent scripts have to tolerate. Random-sampling
# and soak run last so a single chain advance doesn't poison the in-flight
# challenges of the cheaper scripts.
SCRIPTS=(
  "rfc38-curator-offline-midbatch"
  "rfc38-revocation"
  "rfc38-prereg-bytecap-stress"
  "rfc38-unclean-restart"
  "publish"
  "sharing"
  "swm-ownership-restart"
  "invite-flow"
  "cli-invite"
  "reject-flow"
  "random-sampling"
)

# DESTRUCTIVE subscription tests are OPT-IN (SUBSCRIPTION_TESTS=1) — NOT in the
# default sweep. They DELETE a node's context-graph subscriptions and restart it;
# against a REUSED operator devnet that silently drops pre-existing subscriptions
# (subscription-cap now snapshots + restores its node's cap, but subscription-clear
# wipes the active subscription set, which the sweep can't restore). When enabled
# they run LAST, on disjoint nodes (clear→node1, cap→node2) so neither restarts
# the other's node and the publish ACK quorum is left intact for earlier scripts.
if [ "${SUBSCRIPTION_TESTS:-0}" = "1" ]; then
  SCRIPTS+=("subscription-clear" "subscription-cap")
fi

# soak-rs is intentionally NOT in the default list — it's 30+ minutes and
# only meaningful as a separate long-running test. Add SOAK=1 to include.
if [ "${SOAK:-0}" = "1" ]; then
  SCRIPTS+=("soak-rs")
fi

declare -a RESULTS

START_TS=$(date +%s)
echo "[sweep] Run started at $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "[sweep] Results dir: $RESULTS_DIR"
echo ""

for id in "${SCRIPTS[@]}"; do
  # Two naming conventions in scripts/: devnet-test-* and devnet-soak-*
  if [ "$id" = "soak-rs" ]; then
    script="devnet-soak-rs.sh"
  else
    script="devnet-test-${id}.sh"
  fi

  echo "================================================================"
  echo "[sweep] Running $id ($script)"
  echo "================================================================"

  if [ ! -x "$SCRIPTS_DIR/$script" ]; then
    echo "[sweep] MISSING: $script"
    RESULTS+=("$id:MISSING")
    continue
  fi

  LOGFILE="$RESULTS_DIR/${id}.log"
  if ( cd "$REPO_ROOT" && "$SCRIPTS_DIR/$script" ) > "$LOGFILE" 2>&1; then
    echo "[sweep] PASS: $id"
    RESULTS+=("$id:PASS")
  else
    EC=$?
    echo "[sweep] FAIL: $id (exit=$EC)"
    echo "[sweep]   last 15 lines:"
    tail -n 15 "$LOGFILE" | sed 's/^/    /'
    RESULTS+=("$id:FAIL:$EC")
  fi

  # Short settle between scripts so chain mining, gossip, and replication
  # have headroom — same logic as devnet-test-rfc38-all.sh.
  sleep 8
done

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))

echo ""
echo "================================================================"
echo "[sweep] FULL SWEEP SUMMARY (${ELAPSED}s wall)"
echo "================================================================"
FAILS=0
for r in "${RESULTS[@]}"; do
  printf '  %-40s %s\n' "${r%%:*}" "${r#*:}"
  case "$r" in
    *:PASS) ;;
    *) FAILS=$((FAILS + 1)) ;;
  esac
done
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "[sweep] ALL PASS (${#RESULTS[@]} scripts, ${ELAPSED}s)"
  exit 0
else
  echo "[sweep] $FAILS / ${#RESULTS[@]} scripts FAILED"
  exit $((FAILS > 99 ? 99 : FAILS))
fi
