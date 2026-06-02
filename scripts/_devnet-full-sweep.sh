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
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NUM_NODES="${NUM_NODES:-6}"
AUTH=$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" 2>/dev/null | head -1 || echo "")

# Order matters: run baseline workflow scripts before the heavy/destructive
# RFC-38 stress/restart cases. Random-sampling and soak run last so a single
# chain advance doesn't poison the in-flight challenges of the cheaper scripts.
SCRIPTS=(
  "publish"
  "sharing"
  "swm-ownership-restart"
  "invite-flow"
  "cli-invite"
  "reject-flow"
  "rfc38-curator-offline-midbatch"
  "rfc38-revocation"
  "rfc38-prereg-bytecap-stress"
  "rfc38-unclean-restart"
  "random-sampling"
)

# soak-rs is intentionally NOT in the default list — it's 30+ minutes and
# only meaningful as a separate long-running test. Add SOAK=1 to include.
if [ "${SOAK:-0}" = "1" ]; then
  SCRIPTS+=("soak-rs")
fi

declare -a RESULTS

node_status_code() {
  local n="$1"
  local port=$((API_PORT_BASE + n - 1))
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $AUTH" \
    "http://127.0.0.1:$port/api/status" 2>/dev/null || echo "000")
  case "$code" in
    200) echo "200" ;;
    *) echo "000" ;;
  esac
}

ensure_nodes_healthy() {
  local label="$1"
  local down="" n code port
  for n in $(seq 1 "$NUM_NODES"); do
    code=$(node_status_code "$n")
    port=$((API_PORT_BASE + n - 1))
    [ "$code" = "200" ] || down="${down} node${n}(port=$port,http=$code)"
  done
  if [ -z "$down" ]; then
    echo "[sweep] Health OK before $label — all $NUM_NODES nodes responding"
    return 0
  fi

  echo "[sweep] Health repair before $label — restarting:${down}"
  for n in $(seq 1 "$NUM_NODES"); do
    code=$(node_status_code "$n")
    if [ "$code" != "200" ]; then
      "$REPO_ROOT/scripts/devnet.sh" restart-node "$n" || return 1
    fi
  done

  local deadline=$(( $(date +%s) + ${DEVNET_HEALTH_REPAIR_TIMEOUT_SECONDS:-90} ))
  while true; do
    down=""
    for n in $(seq 1 "$NUM_NODES"); do
      code=$(node_status_code "$n")
      port=$((API_PORT_BASE + n - 1))
      [ "$code" = "200" ] || down="${down} node${n}(port=$port,http=$code)"
    done
    if [ -z "$down" ]; then
      echo "[sweep] Health repair complete before $label — all $NUM_NODES nodes responding"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "[sweep] Health repair failed before $label. Still down:${down}"
      return 1
    fi
    sleep 2
  done
}

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

  if [ -z "$AUTH" ]; then
    echo "[sweep] FAIL: no auth token found at $DEVNET_DIR/node1/auth.token"
    RESULTS+=("$id:FAIL:auth")
    continue
  fi

  if ! ensure_nodes_healthy "$id"; then
    echo "[sweep] FAIL: $id (health repair failed before script)"
    RESULTS+=("$id:FAIL:health")
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
