#!/usr/bin/env bash
#
# Private context-graph membership recovery regression harness.
#
# Reproduces the v10.0.6 bootstrap inconsistency without mocks:
#
#   * node 5 creates a curated CG and is its only member;
#   * in auto mode, node 5 enables bounded open enrollment before going offline;
#   * node 5 writes root + sub-graph shared-memory fixtures;
#   * node 5 goes offline;
#   * fresh node 6 subscribes while only unrelated cores can answer;
#   * the subscription state is inspected through both HTTP and node-ui.db;
#   * node 5 returns and node 6 requests admission; node 5 either exposes the
#     request for manual approval or automatically approves it through the
#     persisted open-enrollment policy;
#   * recovery (or the persistent v10.0.6 wedge) is measured across a node-6
#     restart.
#
# The harness defaults to a PRESTARTED six-node devnet:
#
#   ./scripts/devnet.sh start 6
#   HARNESS_EXPECT=broken ./scripts/devnet-test-private-cg-membership-recovery.sh
#   HARNESS_EXPECT=fixed ADMISSION_MODE=manual ./scripts/devnet-test-private-cg-membership-recovery.sh
#   HARNESS_EXPECT=fixed ADMISSION_MODE=auto   ./scripts/devnet-test-private-cg-membership-recovery.sh
#
# It can run the same fixed/auto scenario with a local testnet edge as the
# curator/publisher and four explicitly supplied testnet core nodes. The local
# edge is stopped for the pre-admission empty-peer probe; one remote core is
# later restarted to prove recovered state is durable. The disruptive steps
# require an explicit acknowledgement plus the exact deployed commit:
#
#   HARNESS_TARGET=testnet HARNESS_EXPECT=fixed ADMISSION_MODE=auto \
#     TESTNET_LOCAL_EDGE_HOME="$HOME/.dkg-tn-edge" \
#     TESTNET_LOCAL_EDGE_CLI=/path/to/exact-candidate/packages/cli/dist/cli.js \
#     TESTNET_NODE_1_SSH=operator@host1 TESTNET_NODE_2_SSH=operator@host2 \
#     TESTNET_NODE_3_SSH=operator@host3 TESTNET_NODE_4_SSH=operator@host4 \
#     TESTNET_EXPECT_COMMIT=<deployed-git-sha> \
#     TESTNET_ALLOW_CORE_RESTARTS=I_UNDERSTAND \
#     ./scripts/devnet-test-private-cg-membership-recovery.sh
# Set TESTNET_PREFLIGHT_ONLY=1 and omit the restart acknowledgement to run
# every deployment/health check without creating a CG or stopping a node.
# Full testnet runs use two sync-load cohorts by default: 50 unpublished SWM
# KAs and 50 asynchronously finalized VM KAs, each with 1,000 unique triples.
# Each cohort is split evenly across the CG root and one sub-graph, so late-join
# recovery proves 50,000 exact triples in each layer independently. Publishing
# consumes only the VM cohort's SWM graphs; the separate SWM cohort remains the
# off-chain recovery oracle. The release gate rejects weaker testnet settings.
# Devnet retains the fast two-KA SWM smoke profile unless explicitly configured.
#
# ADMISSION_MODE defaults to manual. Auto mode requires the open-enrollment
# implementation and is intended for current/fixed builds.
#
# `broken` passes only after observing the exact false-ready state:
# synced=1, shared_memory_synced=1, meta_synced!=1, no local CG data, and at
# clean empty responses from every configured unrelated core peer. Post-approval recovery
# is still exercised and recorded, but is not required: the invariant breach is
# already the regression witness.
#
# `fixed` requires the pre-admission subscription to remain pending/not-ready,
# then requires metadata, authorization, root SWM, and sub-graph SWM to recover
# exactly and survive a node-6 restart.

# The JavaScript snippets deliberately use single-quoted shell strings and JS
# template literals; their `$` expressions belong to JavaScript, not Bash.
# The sourced helper path is computed from this script's absolute location.
# shellcheck disable=SC1091,SC2016
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
HARNESS_TARGET="${HARNESS_TARGET:-devnet}"
case "$HARNESS_TARGET" in
  devnet)
    CURATOR_NODE="${CURATOR_NODE:-5}"
    JOINER_NODE="${JOINER_NODE:-6}"
    NUM_NODES="${NUM_NODES:-6}"
    ;;
  testnet)
    # Logical node 0 is the local edge. Remote testnet cores remain 1..4.
    # Keeping the local controller outside the remote range makes the empty-
    # peer oracle explicit: every remote node except the joiner is unrelated.
    CURATOR_NODE="${CURATOR_NODE:-0}"
    JOINER_NODE="${JOINER_NODE:-2}"
    NUM_NODES="${NUM_NODES:-4}"
    ;;
  *)
    echo "HARNESS_TARGET must be devnet or testnet (got: $HARNESS_TARGET)" >&2
    exit 2
    ;;
esac

case "$CURATOR_NODE:$JOINER_NODE:$NUM_NODES" in
  *[!0-9:]*|:*|*::*|*:) echo "CURATOR_NODE, JOINER_NODE, and NUM_NODES must be non-negative integers" >&2; exit 2 ;;
esac
if [ "$HARNESS_TARGET" = "testnet" ]; then
  [ "$CURATOR_NODE" -eq 0 ] \
    || { echo "Testnet mode requires CURATOR_NODE=0 (the local testnet edge)." >&2; exit 2; }
else
  [ "$CURATOR_NODE" -ge 1 ] && [ "$CURATOR_NODE" -le "$NUM_NODES" ] \
    || { echo "CURATOR_NODE must identify one of the configured nodes" >&2; exit 2; }
fi
[ "$JOINER_NODE" -ge 1 ] && [ "$JOINER_NODE" -le "$NUM_NODES" ] \
  || { echo "JOINER_NODE must identify one of the configured nodes" >&2; exit 2; }
[ "$CURATOR_NODE" -ne "$JOINER_NODE" ] \
  || { echo "CURATOR_NODE and JOINER_NODE must be different" >&2; exit 2; }

UNRELATED_NODES=""
for node in $(seq 1 "$NUM_NODES"); do
  if [ "$node" -ne "$CURATOR_NODE" ] && [ "$node" -ne "$JOINER_NODE" ]; then
    UNRELATED_NODES="${UNRELATED_NODES:+$UNRELATED_NODES }$node"
  fi
done
if [ "$HARNESS_TARGET" = "testnet" ]; then
  # The curator is logical node 0 and is not one of the four remote cores.
  EXPECTED_UNRELATED_RESPONDERS=$((NUM_NODES - 1))
else
  EXPECTED_UNRELATED_RESPONDERS=$((NUM_NODES - 2))
fi

SUB_GRAPH_NAME="${SUB_GRAPH_NAME:-ai-tools}"
ROOT_TRIPLES="${ROOT_TRIPLES:-3}"
SUB_GRAPH_TRIPLES="${SUB_GRAPH_TRIPLES:-5}"
HARNESS_LOAD_PROFILE="${HARNESS_LOAD_PROFILE:-}"
[ -n "$HARNESS_LOAD_PROFILE" ] \
  || { [ "$HARNESS_TARGET" = "testnet" ] && HARNESS_LOAD_PROFILE=sync-load || HARNESS_LOAD_PROFILE=smoke; }
LOAD_KA_COUNT="${LOAD_KA_COUNT:-50}"
LOAD_TRIPLES_PER_KA="${LOAD_TRIPLES_PER_KA:-1000}"
VM_PUBLISH_MODE="${VM_PUBLISH_MODE:-}"
[ -n "$VM_PUBLISH_MODE" ] \
  || { [ "$HARNESS_TARGET" = "testnet" ] && VM_PUBLISH_MODE=async-all || VM_PUBLISH_MODE=none; }
case "$HARNESS_LOAD_PROFILE" in
  smoke|sync-load) ;;
  *)
    echo "HARNESS_LOAD_PROFILE must be smoke or sync-load (got: $HARNESS_LOAD_PROFILE)" >&2
    exit 2
    ;;
esac
[[ "$LOAD_KA_COUNT" =~ ^[0-9]+$ ]] && [ "$LOAD_KA_COUNT" -ge 1 ] \
  || { echo "LOAD_KA_COUNT must be a positive integer." >&2; exit 2; }
[[ "$LOAD_TRIPLES_PER_KA" =~ ^[0-9]+$ ]] && [ "$LOAD_TRIPLES_PER_KA" -ge 1 ] \
  || { echo "LOAD_TRIPLES_PER_KA must be a positive integer." >&2; exit 2; }
if [ "$HARNESS_LOAD_PROFILE" = "sync-load" ]; then
  SWM_PLANNED_KA_COUNT="$LOAD_KA_COUNT"
  [ "$VM_PUBLISH_MODE" = "async-all" ] \
    && VM_PLANNED_KA_COUNT="$LOAD_KA_COUNT" || VM_PLANNED_KA_COUNT=0
  PLANNED_KA_COUNT=$((SWM_PLANNED_KA_COUNT + VM_PLANNED_KA_COUNT))
  SWM_ROOT_KA_COUNT=$(((SWM_PLANNED_KA_COUNT + 1) / 2))
  SWM_SUB_GRAPH_KA_COUNT=$((SWM_PLANNED_KA_COUNT / 2))
  VM_ROOT_KA_COUNT=$(((VM_PLANNED_KA_COUNT + 1) / 2))
  VM_SUB_GRAPH_KA_COUNT=$((VM_PLANNED_KA_COUNT / 2))
  ROOT_KA_COUNT=$((SWM_ROOT_KA_COUNT + VM_ROOT_KA_COUNT))
  SUB_GRAPH_KA_COUNT=$((SWM_SUB_GRAPH_KA_COUNT + VM_SUB_GRAPH_KA_COUNT))
  ROOT_TRIPLES=$((SWM_ROOT_KA_COUNT * LOAD_TRIPLES_PER_KA))
  SUB_GRAPH_TRIPLES=$((SWM_SUB_GRAPH_KA_COUNT * LOAD_TRIPLES_PER_KA))
  VM_ROOT_TRIPLES=$((VM_ROOT_KA_COUNT * LOAD_TRIPLES_PER_KA))
  VM_SUB_GRAPH_TRIPLES=$((VM_SUB_GRAPH_KA_COUNT * LOAD_TRIPLES_PER_KA))
else
  SWM_PLANNED_KA_COUNT=2
  VM_PLANNED_KA_COUNT=0
  PLANNED_KA_COUNT=2
  SWM_ROOT_KA_COUNT=1
  SWM_SUB_GRAPH_KA_COUNT=1
  VM_ROOT_KA_COUNT=0
  VM_SUB_GRAPH_KA_COUNT=0
  ROOT_KA_COUNT=1
  SUB_GRAPH_KA_COUNT=1
  VM_ROOT_TRIPLES=0
  VM_SUB_GRAPH_TRIPLES=0
fi
SWM_TOTAL_TRIPLES=$((ROOT_TRIPLES + SUB_GRAPH_TRIPLES))
VM_TOTAL_TRIPLES=$((VM_ROOT_TRIPLES + VM_SUB_GRAPH_TRIPLES))
SEED_ROOT_TRIPLES=$((ROOT_TRIPLES + VM_ROOT_TRIPLES))
SEED_SUB_GRAPH_TRIPLES=$((SUB_GRAPH_TRIPLES + VM_SUB_GRAPH_TRIPLES))
TOTAL_TRIPLES=$((SWM_TOTAL_TRIPLES + VM_TOTAL_TRIPLES))
HARNESS_EXPECT="${HARNESS_EXPECT:-}"
ADMISSION_MODE="${ADMISSION_MODE:-manual}"
AUTO_MAX_MEMBERS="${AUTO_MAX_MEMBERS:-10}"
AUTO_MAX_APPROVALS_PER_HOUR="${AUTO_MAX_APPROVALS_PER_HOUR:-5}"
HARNESS_ARTIFACT_DIR="${HARNESS_ARTIFACT_DIR:-$REPO_ROOT/.harness-artifacts}"
[ -n "${CATCHUP_TIMEOUT_S:-}" ] \
  || { [ "$HARNESS_TARGET" = "testnet" ] && CATCHUP_TIMEOUT_S=360 || CATCHUP_TIMEOUT_S=120; }
JOIN_DELIVERY_TIMEOUT_S="${JOIN_DELIVERY_TIMEOUT_S:-90}"
VM_PUBLISH_TIMEOUT_S="${VM_PUBLISH_TIMEOUT_S:-10800}"
VM_PUBLISH_POLL_INTERVAL_S="${VM_PUBLISH_POLL_INTERVAL_S:-10}"
VM_PUBLISH_PROGRESS_EVERY_KAS="${VM_PUBLISH_PROGRESS_EVERY_KAS:-5}"
if [ "$HARNESS_LOAD_PROFILE" = "sync-load" ]; then
  RECOVERY_TIMEOUT_S="${RECOVERY_TIMEOUT_S:-1800}"
  POST_RESTART_TIMEOUT_S="${POST_RESTART_TIMEOUT_S:-600}"
  API_TIMEOUT_S="${API_TIMEOUT_S:-180}"
else
  RECOVERY_TIMEOUT_S="${RECOVERY_TIMEOUT_S:-150}"
  POST_RESTART_TIMEOUT_S="${POST_RESTART_TIMEOUT_S:-120}"
  API_TIMEOUT_S="${API_TIMEOUT_S:-30}"
fi
BROKEN_RECOVERY_OBSERVE_S="${BROKEN_RECOVERY_OBSERVE_S:-35}"
BROKEN_POST_RESTART_OBSERVE_S="${BROKEN_POST_RESTART_OBSERVE_S:-20}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-2}"
RECOVERY_EXACT_RECHECK_INTERVAL_S="${RECOVERY_EXACT_RECHECK_INTERVAL_S:-30}"
DEVNET_SH="$SCRIPT_DIR/devnet.sh"
TESTNET_NODE_1_SSH="${TESTNET_NODE_1_SSH:-}"
TESTNET_NODE_2_SSH="${TESTNET_NODE_2_SSH:-}"
TESTNET_NODE_3_SSH="${TESTNET_NODE_3_SSH:-}"
TESTNET_NODE_4_SSH="${TESTNET_NODE_4_SSH:-}"
TESTNET_EXPECT_COMMIT="${TESTNET_EXPECT_COMMIT:-}"
TESTNET_ALLOW_CORE_RESTARTS="${TESTNET_ALLOW_CORE_RESTARTS:-}"
TESTNET_PREFLIGHT_ONLY="${TESTNET_PREFLIGHT_ONLY:-0}"
TESTNET_LOCAL_EDGE_HOME="${TESTNET_LOCAL_EDGE_HOME:-$HOME/.dkg-tn-edge}"
TESTNET_LOCAL_EDGE_API_HOST="${TESTNET_LOCAL_EDGE_API_HOST:-127.0.0.1}"
TESTNET_LOCAL_EDGE_API_PORT="${TESTNET_LOCAL_EDGE_API_PORT:-}"
TESTNET_LOCAL_EDGE_CLI="${TESTNET_LOCAL_EDGE_CLI:-$REPO_ROOT/packages/cli/dist/cli.js}"
TESTNET_MAX_ACCEPT_QUEUE="${TESTNET_MAX_ACCEPT_QUEUE:-128}"
TESTNET_SERVICE="${TESTNET_SERVICE:-dkg-v9-node}"
TESTNET_SSH_CONNECT_TIMEOUT="${TESTNET_SSH_CONNECT_TIMEOUT:-90}"
INTEGRITY_PROGRESS_EVERY_KAS="${INTEGRITY_PROGRESS_EVERY_KAS:-10}"
INTEGRITY_RATE_LIMIT_BACKOFF_S="${INTEGRITY_RATE_LIMIT_BACKOFF_S:-61}"
INTEGRITY_RATE_LIMIT_MAX_RETRIES="${INTEGRITY_RATE_LIMIT_MAX_RETRIES:-3}"
HEALTH_SAMPLE_EVERY_KAS="${HEALTH_SAMPLE_EVERY_KAS:-5}"
HEALTH_SAMPLE_INTERVAL_S="${HEALTH_SAMPLE_INTERVAL_S:-15}"
TESTNET_MAX_MEMORY_USED_PERCENT="${TESTNET_MAX_MEMORY_USED_PERCENT:-90}"
TESTNET_MAX_LOAD_PER_CPU_PERCENT="${TESTNET_MAX_LOAD_PER_CPU_PERCENT:-200}"
TESTNET_SATURATION_CONSECUTIVE_SAMPLES="${TESTNET_SATURATION_CONSECUTIVE_SAMPLES:-3}"
TESTNET_PREFLIGHT_HEALTH_SAMPLE_ROUNDS="${TESTNET_PREFLIGHT_HEALTH_SAMPLE_ROUNDS:-3}"
TESTNET_PREFLIGHT_HEALTH_SAMPLE_INTERVAL_S="${TESTNET_PREFLIGHT_HEALTH_SAMPLE_INTERVAL_S:-5}"

case "$HARNESS_EXPECT" in
  broken|fixed) ;;
  *)
    echo "Usage: HARNESS_EXPECT=broken|fixed $0" >&2
    exit 2
    ;;
esac

case "$ADMISSION_MODE" in
  manual|auto) ;;
  *)
    echo "Usage: HARNESS_EXPECT=broken|fixed ADMISSION_MODE=manual|auto $0" >&2
    exit 2
    ;;
esac

case "$VM_PUBLISH_MODE" in
  none|async-all) ;;
  *)
    echo "VM_PUBLISH_MODE must be none or async-all (got: $VM_PUBLISH_MODE)" >&2
    exit 2
    ;;
esac
[ "$VM_PUBLISH_MODE" = "none" ] || [ "$HARNESS_LOAD_PROFILE" = "sync-load" ] || {
  echo "VM_PUBLISH_MODE=async-all requires HARNESS_LOAD_PROFILE=sync-load." >&2
  exit 2
}

if [ "$ADMISSION_MODE" = "auto" ]; then
  [[ "$AUTO_MAX_MEMBERS" =~ ^[0-9]+$ ]] && [ "$AUTO_MAX_MEMBERS" -ge 2 ] \
    || { echo "AUTO_MAX_MEMBERS must be an integer >= 2 (curator + joiner)." >&2; exit 2; }
  [[ "$AUTO_MAX_APPROVALS_PER_HOUR" =~ ^[0-9]+$ ]] && [ "$AUTO_MAX_APPROVALS_PER_HOUR" -ge 1 ] \
    || { echo "AUTO_MAX_APPROVALS_PER_HOUR must be a positive integer." >&2; exit 2; }
fi

for numeric in \
  "$CURATOR_NODE" "$JOINER_NODE" "$NUM_NODES" "$ROOT_TRIPLES" \
  "$SUB_GRAPH_TRIPLES" "$LOAD_KA_COUNT" "$LOAD_TRIPLES_PER_KA" \
  "$SWM_PLANNED_KA_COUNT" "$VM_PLANNED_KA_COUNT" "$PLANNED_KA_COUNT" \
  "$SWM_ROOT_KA_COUNT" "$SWM_SUB_GRAPH_KA_COUNT" \
  "$VM_ROOT_KA_COUNT" "$VM_SUB_GRAPH_KA_COUNT" \
  "$ROOT_KA_COUNT" "$SUB_GRAPH_KA_COUNT" \
  "$VM_ROOT_TRIPLES" "$VM_SUB_GRAPH_TRIPLES" \
  "$SWM_TOTAL_TRIPLES" "$VM_TOTAL_TRIPLES" \
  "$SEED_ROOT_TRIPLES" "$SEED_SUB_GRAPH_TRIPLES" "$TOTAL_TRIPLES" \
  "$CATCHUP_TIMEOUT_S" "$JOIN_DELIVERY_TIMEOUT_S" \
  "$VM_PUBLISH_TIMEOUT_S" "$VM_PUBLISH_POLL_INTERVAL_S" \
  "$VM_PUBLISH_PROGRESS_EVERY_KAS" \
  "$RECOVERY_TIMEOUT_S" "$POST_RESTART_TIMEOUT_S" \
  "$RECOVERY_EXACT_RECHECK_INTERVAL_S" \
  "$TESTNET_MAX_ACCEPT_QUEUE" "$TESTNET_SSH_CONNECT_TIMEOUT" \
  "$INTEGRITY_PROGRESS_EVERY_KAS" \
  "$INTEGRITY_RATE_LIMIT_BACKOFF_S" "$INTEGRITY_RATE_LIMIT_MAX_RETRIES" \
  "$HEALTH_SAMPLE_EVERY_KAS" \
  "$HEALTH_SAMPLE_INTERVAL_S" "$TESTNET_MAX_MEMORY_USED_PERCENT" \
  "$TESTNET_MAX_LOAD_PER_CPU_PERCENT" \
  "$TESTNET_SATURATION_CONSECUTIVE_SAMPLES" \
  "$TESTNET_PREFLIGHT_HEALTH_SAMPLE_ROUNDS" \
  "$TESTNET_PREFLIGHT_HEALTH_SAMPLE_INTERVAL_S"; do
  [[ "$numeric" =~ ^[0-9]+$ ]] || {
    echo "All node/count/timeout settings must be non-negative integers (got: $numeric)" >&2
    exit 2
  }
done
[ "$INTEGRITY_PROGRESS_EVERY_KAS" -ge 1 ] \
  || { echo "INTEGRITY_PROGRESS_EVERY_KAS must be at least 1." >&2; exit 2; }
[ "$INTEGRITY_RATE_LIMIT_BACKOFF_S" -ge 1 ] \
  || { echo "INTEGRITY_RATE_LIMIT_BACKOFF_S must be at least 1." >&2; exit 2; }
[ "$INTEGRITY_RATE_LIMIT_MAX_RETRIES" -ge 1 ] \
  || { echo "INTEGRITY_RATE_LIMIT_MAX_RETRIES must be at least 1." >&2; exit 2; }
[ "$VM_PUBLISH_POLL_INTERVAL_S" -ge 1 ] \
  || { echo "VM_PUBLISH_POLL_INTERVAL_S must be at least 1." >&2; exit 2; }
[ "$VM_PUBLISH_PROGRESS_EVERY_KAS" -ge 1 ] \
  || { echo "VM_PUBLISH_PROGRESS_EVERY_KAS must be at least 1." >&2; exit 2; }
[ "$RECOVERY_EXACT_RECHECK_INTERVAL_S" -ge 1 ] \
  || { echo "RECOVERY_EXACT_RECHECK_INTERVAL_S must be at least 1." >&2; exit 2; }
[ "$HEALTH_SAMPLE_EVERY_KAS" -ge 1 ] \
  || { echo "HEALTH_SAMPLE_EVERY_KAS must be at least 1." >&2; exit 2; }
[ "$HEALTH_SAMPLE_INTERVAL_S" -ge 1 ] \
  || { echo "HEALTH_SAMPLE_INTERVAL_S must be at least 1." >&2; exit 2; }
[ "$TESTNET_MAX_MEMORY_USED_PERCENT" -ge 1 ] && [ "$TESTNET_MAX_MEMORY_USED_PERCENT" -le 100 ] \
  || { echo "TESTNET_MAX_MEMORY_USED_PERCENT must be in 1..100." >&2; exit 2; }
[ "$TESTNET_MAX_LOAD_PER_CPU_PERCENT" -ge 1 ] \
  || { echo "TESTNET_MAX_LOAD_PER_CPU_PERCENT must be at least 1." >&2; exit 2; }
[ "$TESTNET_SATURATION_CONSECUTIVE_SAMPLES" -ge 2 ] \
  || { echo "TESTNET_SATURATION_CONSECUTIVE_SAMPLES must be at least 2." >&2; exit 2; }
[ "$TESTNET_PREFLIGHT_HEALTH_SAMPLE_ROUNDS" -ge "$TESTNET_SATURATION_CONSECUTIVE_SAMPLES" ] \
  || { echo "TESTNET_PREFLIGHT_HEALTH_SAMPLE_ROUNDS must cover the saturation streak threshold." >&2; exit 2; }
[ "$TESTNET_PREFLIGHT_HEALTH_SAMPLE_INTERVAL_S" -ge 1 ] \
  || { echo "TESTNET_PREFLIGHT_HEALTH_SAMPLE_INTERVAL_S must be at least 1." >&2; exit 2; }

if [ "$HARNESS_TARGET" = "devnet" ]; then
  if [ "$NUM_NODES" -ne 6 ] || [ "$CURATOR_NODE" -ne 5 ] || [ "$JOINER_NODE" -ne 6 ]; then
    echo "Devnet mode requires the default topology: cores 1-4, curator edge 5, joiner edge 6." >&2
    exit 2
  fi
else
  if [ "$NUM_NODES" -ne 4 ]; then
    echo "Testnet mode requires exactly four core nodes." >&2
    exit 2
  fi
  [ "$HARNESS_EXPECT" = "fixed" ] || {
    echo "Testnet mode is a release gate and only supports HARNESS_EXPECT=fixed." >&2
    exit 2
  }
  [ "$HARNESS_LOAD_PROFILE" = "sync-load" ] || {
    echo "Testnet release-gate runs require HARNESS_LOAD_PROFILE=sync-load." >&2
    exit 2
  }
  [ "$LOAD_KA_COUNT" -ge 50 ] || {
    echo "Testnet release-gate runs require LOAD_KA_COUNT >= 50." >&2
    exit 2
  }
  [ "$LOAD_TRIPLES_PER_KA" -ge 1000 ] || {
    echo "Testnet release-gate runs require LOAD_TRIPLES_PER_KA >= 1000." >&2
    exit 2
  }
  [ "$VM_PUBLISH_MODE" = "async-all" ] || {
    echo "Testnet release-gate runs require VM_PUBLISH_MODE=async-all." >&2
    exit 2
  }
  [ "$TESTNET_PREFLIGHT_ONLY" = "0" ] || [ "$TESTNET_PREFLIGHT_ONLY" = "1" ] || {
    echo "TESTNET_PREFLIGHT_ONLY must be 0 or 1." >&2
    exit 2
  }
  [ -n "$TESTNET_EXPECT_COMMIT" ] || {
    echo "TESTNET_EXPECT_COMMIT is required in testnet mode." >&2
    exit 2
  }
  [[ "$TESTNET_EXPECT_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || {
    echo "TESTNET_EXPECT_COMMIT must be a 7-40 character Git SHA." >&2
    exit 2
  }
  [[ "$TESTNET_SERVICE" =~ ^[a-zA-Z0-9_.@-]+$ ]] || {
    echo "TESTNET_SERVICE contains unsupported characters." >&2
    exit 2
  }
  [ -d "$TESTNET_LOCAL_EDGE_HOME" ] || {
    echo "Local testnet edge home does not exist: $TESTNET_LOCAL_EDGE_HOME" >&2
    exit 2
  }
  [ -f "$TESTNET_LOCAL_EDGE_HOME/config.json" ] || {
    echo "Local testnet edge config is missing: $TESTNET_LOCAL_EDGE_HOME/config.json" >&2
    exit 2
  }
  if [ -z "$TESTNET_LOCAL_EDGE_API_PORT" ]; then
    TESTNET_LOCAL_EDGE_API_PORT="$(tr -d '\r\n' < "$TESTNET_LOCAL_EDGE_HOME/api.port" 2>/dev/null || true)"
  fi
  if [ -z "$TESTNET_LOCAL_EDGE_API_PORT" ]; then
    TESTNET_LOCAL_EDGE_API_PORT="$(node -e '
      const fs = require("fs");
      try {
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).apiPort;
        if (Number.isInteger(value)) process.stdout.write(String(value));
      } catch {}
    ' "$TESTNET_LOCAL_EDGE_HOME/config.json")"
  fi
  [[ "$TESTNET_LOCAL_EDGE_API_PORT" =~ ^[0-9]+$ ]] \
    && [ "$TESTNET_LOCAL_EDGE_API_PORT" -ge 1 ] \
    && [ "$TESTNET_LOCAL_EDGE_API_PORT" -le 65535 ] || {
      echo "TESTNET_LOCAL_EDGE_API_PORT must be a valid TCP port." >&2
      exit 2
    }
  [[ "$TESTNET_LOCAL_EDGE_API_HOST" =~ ^[a-zA-Z0-9_.:-]+$ ]] || {
    echo "TESTNET_LOCAL_EDGE_API_HOST contains unsupported characters." >&2
    exit 2
  }
  [ "$TESTNET_PREFLIGHT_ONLY" = "1" ] || [ -f "$TESTNET_LOCAL_EDGE_CLI" ] || {
    echo "Exact-candidate local edge CLI is missing: $TESTNET_LOCAL_EDGE_CLI" >&2
    exit 2
  }
  if [ "$TESTNET_PREFLIGHT_ONLY" != "1" ] && [ "$TESTNET_ALLOW_CORE_RESTARTS" != "I_UNDERSTAND" ]; then
    echo "Full testnet mode stops the local edge and restarts the joiner core. Set TESTNET_ALLOW_CORE_RESTARTS=I_UNDERSTAND." >&2
    exit 2
  fi
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$HARNESS_ARTIFACT_DIR/private-cg-membership-recovery-$RUN_ID-$HARNESS_TARGET-$HARNESS_EXPECT-$ADMISSION_MODE"
mkdir -p "$RUN_DIR"
SEED_MANIFEST="$RUN_DIR/seed-manifest.jsonl"
SWM_MANIFEST="$RUN_DIR/swm-manifest.jsonl"
VM_SOURCE_MANIFEST="$RUN_DIR/vm-source-manifest.jsonl"
: > "$SEED_MANIFEST"
: > "$SWM_MANIFEST"
: > "$VM_SOURCE_MANIFEST"
VM_ENQUEUE_MANIFEST="$RUN_DIR/vm-enqueue-manifest.jsonl"
VM_PUBLISH_MANIFEST="$RUN_DIR/vm-publish-manifest.jsonl"
: > "$VM_ENQUEUE_MANIFEST"
: > "$VM_PUBLISH_MANIFEST"
TESTNET_JOURNAL_SINCE="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
export DEVNET_PUBLISH_STATE_FILE="$RUN_DIR/publish-state.json"
# Every call to devnet_create_shared_ka must remain exactly one named KA. This
# is what makes LOAD_KA_COUNT an asserted workload dimension rather than an
# estimate derived from the number of root entities in each payload.
export DEVNET_PUBLISH_PRESERVE_BATCH=1
if [ "$HARNESS_TARGET" = "testnet" ]; then
  mkdir -p "$RUN_DIR/tmp"
  DEVNET_DIR="$RUN_DIR/tmp"
fi
exec > >(tee -a "$RUN_DIR/harness.log") 2>&1

# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"

CG_ID=""
CG_ENCODED=""
CURATOR_AGENT=""
CURATOR_PEER=""
JOINER_AGENT=""
JOINER_PEER=""
EXPECTED_DELEGATION_AGENT_LOWER=""
EXPECTED_DELEGATION_PEER=""
EXPECTED_DELEGATION_OP_KEY_LOWER=""
EXPECTED_DELEGATION_SCOPE=""
EXPECTED_DELEGATION_ISSUED_AT=""
EXPECTED_DELEGATION_EXPIRES_AT=""
CURATOR_STOPPED=0
JOINER_STOPPED=0
FAIL_REASON=""
BROKEN_RECOVERED_BEFORE_RESTART=0
BROKEN_RECOVERED_AFTER_RESTART=0
AUTO_APPROVAL_OBSERVED=0
SEEDED_KA_COUNT=0
SEEDED_SWM_KA_COUNT=0
SEEDED_VM_SOURCE_KA_COUNT=0
SEEDED_ROOT_KA_COUNT=0
SEEDED_SUB_GRAPH_KA_COUNT=0
SEEDED_TRIPLE_COUNT=0
SEED_PAYLOAD_BYTES=0
MAX_SEED_PAYLOAD_BYTES=0
SEED_STARTED_AT_MS=0
SEED_FINISHED_AT_MS=0
SEED_DURATION_MS=0
LAST_SEED_WRITE=""
CURATOR_INTEGRITY_VERIFIED=0
JOINER_INTEGRITY_VERIFIED=0
POST_RESTART_INTEGRITY_VERIFIED=0
SWM_CURATOR_INTEGRITY_VERIFIED=0
SWM_JOINER_INTEGRITY_VERIFIED=0
SWM_POST_RESTART_INTEGRITY_VERIFIED=0
VM_ENQUEUED_KA_COUNT=0
VM_FINALIZED_KA_COUNT=0
VM_FAILED_KA_COUNT=0
VM_CURATOR_INTEGRITY_VERIFIED=0
VM_JOINER_INTEGRITY_VERIFIED=0
VM_POST_RESTART_INTEGRITY_VERIFIED=0
VM_PUBLISH_STARTED_AT_MS=0
VM_PUBLISH_FINISHED_AT_MS=0
VM_PUBLISH_DURATION_MS=0
LOCAL_EDGE_INITIAL_PID=0
LOCAL_EDGE_RESTARTED_PID=0
HEALTH_SAMPLE_COUNT=0
LAST_HEALTH_SAMPLE_EPOCH=0
HEALTH_AUDIT_PASSED=0

log()  { echo "[private-cg-recovery] $*"; }
warn() { echo "[private-cg-recovery] WARN: $*" >&2; }
act()  { echo; echo "[private-cg-recovery] === $* ==="; }
fail() {
  FAIL_REASON="$*"
  echo "[private-cg-recovery] FAIL: $*" >&2
  exit 1
}

TESTNET_SSH_OPTIONS=(
  -o BatchMode=yes
  -o "ConnectTimeout=$TESTNET_SSH_CONNECT_TIMEOUT"
  -o ControlMaster=auto
  -o ControlPersist=600
  -o "ControlPath=/tmp/dkg-private-cg-${UID:-0}-$$-%C"
)

testnet_node_ssh() {
  case "$1" in
    1) printf '%s' "$TESTNET_NODE_1_SSH" ;;
    2) printf '%s' "$TESTNET_NODE_2_SSH" ;;
    3) printf '%s' "$TESTNET_NODE_3_SSH" ;;
    4) printf '%s' "$TESTNET_NODE_4_SSH" ;;
    *) return 1 ;;
  esac
}

is_local_testnet_edge() {
  [ "$HARNESS_TARGET" = "testnet" ] && [ "$1" -eq 0 ]
}

local_edge_token() {
  grep -v '^#' "$TESTNET_LOCAL_EDGE_HOME/auth.token" 2>/dev/null \
    | head -n1 | tr -d '\r\n'
}

local_edge_daemon_pid() {
  local pid
  pid="$(tr -d '\r\n' < "$TESTNET_LOCAL_EDGE_HOME/daemon.pid" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null \
    && printf '%s' "$pid"
}

base64_one_line() {
  base64 | tr -d '\r\n'
}

commit_matches() {
  local actual expected
  actual="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  expected="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
  [ -n "$actual" ] && [ -n "$expected" ] \
    && { [[ "$actual" == "$expected"* ]] || [[ "$expected" == "$actual"* ]]; }
}

testnet_probe_node() {
  local node="$1" host
  host="$(testnet_node_ssh "$node")"
  ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- "$TESTNET_SERVICE" <<'REMOTE'
set -u
service="$1"
service_active="$(systemctl is-active "$service" 2>/dev/null || true)"
main_pid="$(systemctl show "$service" -p MainPID --value 2>/dev/null || true)"
worker_pid=""
if [[ "$main_pid" =~ ^[0-9]+$ ]] && [ "$main_pid" -gt 0 ]; then
  worker_pid="$(pgrep -P "$main_pid" -f 'daemon-foreground-worker' 2>/dev/null | head -n1 || true)"
fi
n_restarts="$(systemctl show "$service" -p NRestarts --value 2>/dev/null || true)"
memory_current="$(systemctl show "$service" -p MemoryCurrent --value 2>/dev/null || true)"
memory_peak="$(systemctl show "$service" -p MemoryPeak --value 2>/dev/null || true)"
cpu_usage_nsec="$(systemctl show "$service" -p CPUUsageNSec --value 2>/dev/null || true)"
control_group="$(systemctl show "$service" -p ControlGroup --value 2>/dev/null || true)"
oxigraph_pid="$(ps -eo pid=,comm= 2>/dev/null | awk '$2 ~ /^oxigraph-v/ {print $1; exit}')"
oxigraph_watchdog_pid="$(ps -eo pid=,comm=,args= 2>/dev/null | awk '$2 == "node" && $0 ~ /oxigraph-parent-watchdog[.]js/ {print $1; exit}')"
oxigraph_rss_kib=0
oxigraph_start_ticks=0
oxigraph_control_group=""
oxigraph_memory_current=0
oxigraph_memory_peak=0
oxigraph_oom_events=0
oxigraph_oom_kill_events=0
if [ -n "$oxigraph_pid" ] && [ -r "/proc/$oxigraph_pid/status" ]; then
  oxigraph_rss_kib="$(awk '$1 == "VmRSS:" {print $2}' "/proc/$oxigraph_pid/status")"
  oxigraph_start_ticks="$(awk '{print $22}' "/proc/$oxigraph_pid/stat")"
  oxigraph_control_group="$(awk -F: '$1 == "0" {print $3}' "/proc/$oxigraph_pid/cgroup")"
  if [ -n "$oxigraph_control_group" ]; then
    [ ! -r "/sys/fs/cgroup${oxigraph_control_group}/memory.current" ] \
      || oxigraph_memory_current="$(cat "/sys/fs/cgroup${oxigraph_control_group}/memory.current")"
    [ ! -r "/sys/fs/cgroup${oxigraph_control_group}/memory.peak" ] \
      || oxigraph_memory_peak="$(cat "/sys/fs/cgroup${oxigraph_control_group}/memory.peak")"
    if [ -r "/sys/fs/cgroup${oxigraph_control_group}/memory.events" ]; then
      oxigraph_oom_events="$(awk '$1 == "oom" {print $2}' "/sys/fs/cgroup${oxigraph_control_group}/memory.events")"
      oxigraph_oom_kill_events="$(awk '$1 == "oom_kill" {print $2}' "/sys/fs/cgroup${oxigraph_control_group}/memory.events")"
    fi
  fi
fi
current_commit="$(tr -d '\r\n' < "$HOME/.dkg/.current-commit" 2>/dev/null || true)"
active_git="$(git -C "$HOME/.dkg/releases/current" rev-parse HEAD 2>/dev/null || true)"
active_slot="$(readlink -f "$HOME/.dkg/releases/current" 2>/dev/null | sed 's#.*/##')"
accept_queue="$(ss -lnt 2>/dev/null | awk '$4 ~ /:9090$/ {print $2; exit}')"
cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || printf '1')"
load_one="$(awk '{print $1}' /proc/loadavg 2>/dev/null || printf '0')"
memory_total_kib="$(awk '$1 == "MemTotal:" {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
memory_available_kib="$(awk '$1 == "MemAvailable:" {print $2}' /proc/meminfo 2>/dev/null || printf '0')"
oom_events=0
oom_kill_events=0
if [ -n "$control_group" ] && [ -r "/sys/fs/cgroup${control_group}/memory.events" ]; then
  oom_events="$(awk '$1 == "oom" {print $2}' "/sys/fs/cgroup${control_group}/memory.events")"
  oom_kill_events="$(awk '$1 == "oom_kill" {print $2}' "/sys/fs/cgroup${control_group}/memory.events")"
fi
build_running=false
for pid in $(pgrep -f 'pnpm install|build-runtime-packages|vite.*build|tsup.*cli-default|typescript/bin/tsc' 2>/dev/null || true); do
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cwd" in
    "$HOME/.dkg/releases/"*) build_running=true; break ;;
  esac
done
worker_restart_allowed=false
if [[ "$worker_pid" =~ ^[0-9]+$ ]] && [ "$worker_pid" -gt 0 ] \
  && kill -0 "$worker_pid" 2>/dev/null; then
  worker_restart_allowed=true
fi
SERVICE_ACTIVE="$service_active" MAIN_PID="$main_pid" N_RESTARTS="$n_restarts" \
WORKER_PID="$worker_pid" WORKER_RESTART_ALLOWED="$worker_restart_allowed" \
MEMORY_CURRENT="$memory_current" MEMORY_PEAK="$memory_peak" CPU_USAGE_NSEC="$cpu_usage_nsec" \
CONTROL_GROUP="$control_group" OOM_EVENTS="$oom_events" OOM_KILL_EVENTS="$oom_kill_events" \
OXIGRAPH_PID="$oxigraph_pid" OXIGRAPH_WATCHDOG_PID="$oxigraph_watchdog_pid" \
OXIGRAPH_RSS_KIB="$oxigraph_rss_kib" OXIGRAPH_START_TICKS="$oxigraph_start_ticks" \
OXIGRAPH_CONTROL_GROUP="$oxigraph_control_group" \
OXIGRAPH_MEMORY_CURRENT="$oxigraph_memory_current" OXIGRAPH_MEMORY_PEAK="$oxigraph_memory_peak" \
OXIGRAPH_OOM_EVENTS="$oxigraph_oom_events" OXIGRAPH_OOM_KILL_EVENTS="$oxigraph_oom_kill_events" \
CPU_COUNT="$cpu_count" LOAD_ONE="$load_one" MEMORY_TOTAL_KIB="$memory_total_kib" \
MEMORY_AVAILABLE_KIB="$memory_available_kib" \
CURRENT_COMMIT="$current_commit" ACTIVE_GIT="$active_git" \
ACTIVE_SLOT="$active_slot" ACCEPT_QUEUE="$accept_queue" BUILD_RUNNING="$build_running" node -e '
  const integer = value => /^\d+$/.test(value || "") ? Number(value) : null;
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const memoryTotal = integer(process.env.MEMORY_TOTAL_KIB) ?? 0;
  const memoryAvailable = integer(process.env.MEMORY_AVAILABLE_KIB) ?? 0;
  process.stdout.write(JSON.stringify({
    serviceActive: process.env.SERVICE_ACTIVE,
    mainPid: integer(process.env.MAIN_PID),
    workerPid: integer(process.env.WORKER_PID),
    nRestarts: integer(process.env.N_RESTARTS),
    serviceMemoryCurrentBytes: integer(process.env.MEMORY_CURRENT),
    serviceMemoryPeakBytes: integer(process.env.MEMORY_PEAK),
    serviceCpuUsageNSec: integer(process.env.CPU_USAGE_NSEC),
    controlGroup: process.env.CONTROL_GROUP || null,
    oomEvents: integer(process.env.OOM_EVENTS) ?? 0,
    oomKillEvents: integer(process.env.OOM_KILL_EVENTS) ?? 0,
    oxigraphPid: integer(process.env.OXIGRAPH_PID),
    oxigraphWatchdogPid: integer(process.env.OXIGRAPH_WATCHDOG_PID),
    oxigraphRssKiB: integer(process.env.OXIGRAPH_RSS_KIB) ?? 0,
    oxigraphStartTicks: integer(process.env.OXIGRAPH_START_TICKS),
    oxigraphControlGroup: process.env.OXIGRAPH_CONTROL_GROUP || null,
    oxigraphMemoryCurrentBytes: integer(process.env.OXIGRAPH_MEMORY_CURRENT) ?? 0,
    oxigraphMemoryPeakBytes: integer(process.env.OXIGRAPH_MEMORY_PEAK) ?? 0,
    oxigraphOomEvents: integer(process.env.OXIGRAPH_OOM_EVENTS) ?? 0,
    oxigraphOomKillEvents: integer(process.env.OXIGRAPH_OOM_KILL_EVENTS) ?? 0,
    cpuCount: integer(process.env.CPU_COUNT) ?? 1,
    loadOne: finite(process.env.LOAD_ONE) ?? 0,
    hostMemoryTotalKiB: memoryTotal,
    hostMemoryAvailableKiB: memoryAvailable,
    hostMemoryUsedPercent: memoryTotal > 0
      ? Math.round(((memoryTotal - memoryAvailable) / memoryTotal) * 10000) / 100
      : null,
    currentCommit: process.env.CURRENT_COMMIT || null,
    activeGit: process.env.ACTIVE_GIT || null,
    activeSlot: process.env.ACTIVE_SLOT || null,
    acceptQueue: process.env.ACCEPT_QUEUE === "" ? null : Number(process.env.ACCEPT_QUEUE),
    buildRunning: process.env.BUILD_RUNNING === "true",
    workerRestartAllowed: process.env.WORKER_RESTART_ALLOWED === "true",
  }));
'
REMOTE
}

node_is_intentionally_stopped() {
  local node="$1"
  [ "$node" = "$CURATOR_NODE" ] && [ "$CURATOR_STOPPED" -eq 1 ] && return 0
  [ "$node" = "$JOINER_NODE" ] && [ "$JOINER_STOPPED" -eq 1 ] && return 0
  return 1
}

sample_node_health() {
  local phase="$1" node probe status ready peer timestamp
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  for node in $(seq 1 "$NUM_NODES"); do
    node_is_intentionally_stopped "$node" && continue
    if [ "$HARNESS_TARGET" = "testnet" ]; then
      probe="$(testnet_probe_node "$node" 2>/dev/null || true)"
      [ -n "$probe" ] || fail "health sample '$phase' could not probe testnet node $node"
      [ "$(json_get "$probe" serviceActive)" = "active" ] \
        || fail "health sample '$phase' found node $node service inactive: $probe"
      [ -n "$(json_get "$probe" mainPid)" ] && [ "$(json_get "$probe" mainPid)" != "0" ] \
        || fail "health sample '$phase' found node $node without a main process: $probe"
      [ -n "$(json_get "$probe" oxigraphPid)" ] && [ "$(json_get "$probe" oxigraphPid)" != "0" ] \
        || fail "health sample '$phase' found node $node without an Oxigraph process: $probe"
      [ -n "$(json_get "$probe" oxigraphWatchdogPid)" ] && [ "$(json_get "$probe" oxigraphWatchdogPid)" != "0" ] \
        || fail "health sample '$phase' found node $node without the Oxigraph watchdog: $probe"
    else
      status="$(API_TIMEOUT_OVERRIDE=10 api_call "$node" GET /api/status 2>/dev/null || true)"
      peer="$(json_get "$status" peerId)"
      [ -n "$peer" ] && ready=true || ready=false
      probe="$(READY="$ready" PEER="$peer" node -e '
        process.stdout.write(JSON.stringify({
          apiReady: process.env.READY === "true",
          peerId: process.env.PEER || null,
        }));
      ')"
    fi
    PHASE="$phase" NODE_ID="$node" TIMESTAMP="$timestamp" PROBE="$probe" node -e '
      process.stdout.write(JSON.stringify({
        timestamp: process.env.TIMESTAMP,
        phase: process.env.PHASE,
        node: Number(process.env.NODE_ID),
        ...JSON.parse(process.env.PROBE),
      }));
    ' >> "$RUN_DIR/health-samples.jsonl"
    printf '\n' >> "$RUN_DIR/health-samples.jsonl"
  done
  HEALTH_SAMPLE_COUNT=$((HEALTH_SAMPLE_COUNT + 1))
  LAST_HEALTH_SAMPLE_EPOCH="$(date +%s)"
}

maybe_sample_node_health() {
  local phase="$1" now
  now="$(date +%s)"
  if [ $((now - LAST_HEALTH_SAMPLE_EPOCH)) -ge "$HEALTH_SAMPLE_INTERVAL_S" ]; then
    sample_node_health "$phase"
  fi
}

record_devnet_log_offsets() {
  local node log_path size
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    log_path="$TESTNET_LOCAL_EDGE_HOME/daemon.log"
    size=0
    [ ! -f "$log_path" ] || size="$(wc -c < "$log_path" | tr -d '[:space:]')"
    printf '%s\n' "$size" > "$RUN_DIR/local-edge-daemon-log-start-byte"
    return 0
  fi
  for node in $(seq 1 "$NUM_NODES"); do
    log_path="$(node_log "$node")"
    size=0
    [ ! -f "$log_path" ] || size="$(wc -c < "$log_path" | tr -d '[:space:]')"
    printf '%s\n' "$size" > "$RUN_DIR/node${node}-daemon-log-start-byte"
  done
}

collect_testnet_health_journal() {
  local node="$1" host since_b64
  host="$(testnet_node_ssh "$node")"
  since_b64="$(printf '%s' "$TESTNET_JOURNAL_SINCE" | base64_one_line)"
  ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- \
    "$TESTNET_SERVICE" "$since_b64" <<'REMOTE'
set -u
service="$1"
since="$(printf '%s' "$2" | base64 -d)"
pattern='heap out of memory|oom-kill|out of memory|killed process|segmentation fault|segfault|core dumped|thread .* panicked|fatal runtime error|oxigraph.*(panic|fatal|crash|aborted)|code=killed, status=9/KILL'
{
  journalctl -u "$service" --since "$since" --no-pager 2>/dev/null || true
  journalctl -k --since "$since" --no-pager 2>/dev/null || true
} | grep -Ei "$pattern" || true
REMOTE
}

audit_testnet_health_samples() {
  local baseline_file="$RUN_DIR/health-baselines.jsonl"
  BASELINES_FILE="$baseline_file" SAMPLES_FILE="$RUN_DIR/health-samples.jsonl" \
    MAX_QUEUE="$TESTNET_MAX_ACCEPT_QUEUE" MAX_MEMORY="$TESTNET_MAX_MEMORY_USED_PERCENT" \
    MAX_LOAD="$TESTNET_MAX_LOAD_PER_CPU_PERCENT" \
    MAX_CONSECUTIVE="$TESTNET_SATURATION_CONSECUTIVE_SAMPLES" \
    CURATOR="$CURATOR_NODE" JOINER="$JOINER_NODE" node -e '
      const fs = require("node:fs");
      const readLines = file => fs.existsSync(file)
        ? fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).map(line => JSON.parse(line))
        : [];
      const baselines = new Map(readLines(process.env.BASELINES_FILE).map(row => [row.node, row]));
      const samples = readLines(process.env.SAMPLES_FILE);
      const maxQueue = Number(process.env.MAX_QUEUE);
      const maxMemory = Number(process.env.MAX_MEMORY);
      const maxLoad = Number(process.env.MAX_LOAD);
      const maxConsecutive = Number(process.env.MAX_CONSECUTIVE);
      const restartNodes = new Set([Number(process.env.CURATOR), Number(process.env.JOINER)]);
      const state = new Map();
      const failures = [];
      for (const sample of samples) {
        const baseline = baselines.get(sample.node);
        if (!baseline) {
          failures.push(`node ${sample.node} has samples without a baseline`);
          continue;
        }
        const prior = state.get(sample.node) ?? {
          supervisorPid: baseline.mainPid,
          supervisorPidChanges: 0,
          workerPid: baseline.workerPid,
          workerPidChanges: 0,
          oxigraphPid: baseline.oxigraphPid,
          oxigraphPidChanges: 0,
          streak: 0,
          maxStreak: 0,
          oomEvents: baseline.oomEvents ?? 0,
          oomKillEvents: baseline.oomKillEvents ?? 0,
          oxigraphOomEvents: baseline.oxigraphOomEvents ?? 0,
          oxigraphOomKillEvents: baseline.oxigraphOomKillEvents ?? 0,
          saturationSamples: [],
        };
        const requiredNumbers = [
          "mainPid", "workerPid", "nRestarts", "oxigraphPid", "oxigraphWatchdogPid",
          "acceptQueue", "cpuCount", "loadOne", "hostMemoryUsedPercent",
          "oomEvents", "oomKillEvents", "oxigraphOomEvents", "oxigraphOomKillEvents",
        ];
        for (const field of requiredNumbers) {
          if (sample[field] === null || sample[field] === undefined || !Number.isFinite(Number(sample[field]))) {
            failures.push(`node ${sample.node} sample ${sample.phase} omitted numeric ${field}`);
          }
        }
        if (prior.supervisorPid !== sample.mainPid) {
          prior.supervisorPid = sample.mainPid;
          prior.supervisorPidChanges += 1;
          prior.streak = 0;
        }
        if (prior.workerPid !== sample.workerPid) {
          prior.workerPid = sample.workerPid;
          prior.workerPidChanges += 1;
          prior.streak = 0;
        }
        if (prior.oxigraphPid !== sample.oxigraphPid) {
          prior.oxigraphPid = sample.oxigraphPid;
          prior.oxigraphPidChanges += 1;
          prior.streak = 0;
        }
        const checkCounter = (label, currentRaw, previousRaw) => {
          const current = Number(currentRaw ?? 0);
          const previous = Number(previousRaw ?? 0);
          if (current > previous || (current < previous && current > 0)) {
            failures.push(`node ${sample.node} ${label} increased during ${sample.phase}`);
          }
          return current;
        };
        prior.oomEvents = checkCounter("daemon cgroup OOM counter", sample.oomEvents, prior.oomEvents);
        prior.oomKillEvents = checkCounter("daemon cgroup OOM-kill counter", sample.oomKillEvents, prior.oomKillEvents);
        prior.oxigraphOomEvents = checkCounter(
          "Oxigraph cgroup OOM counter", sample.oxigraphOomEvents, prior.oxigraphOomEvents,
        );
        prior.oxigraphOomKillEvents = checkCounter(
          "Oxigraph cgroup OOM-kill counter", sample.oxigraphOomKillEvents, prior.oxigraphOomKillEvents,
        );
        if (Number(sample.nRestarts) !== Number(baseline.nRestarts)) {
          failures.push(`node ${sample.node} systemd NRestarts changed during ${sample.phase}`);
        }
        const loadPerCpuPercent = Number(sample.cpuCount) > 0
          ? (Number(sample.loadOne) / Number(sample.cpuCount)) * 100
          : Infinity;
        const reasons = [];
        if (Number(sample.acceptQueue) > maxQueue) reasons.push(`acceptQueue=${sample.acceptQueue}`);
        if (Number(sample.hostMemoryUsedPercent) >= maxMemory) reasons.push(`memory=${sample.hostMemoryUsedPercent}%`);
        if (loadPerCpuPercent >= maxLoad) reasons.push(`loadPerCpu=${loadPerCpuPercent.toFixed(1)}%`);
        if (reasons.length > 0) {
          prior.streak += 1;
          prior.saturationSamples.push({ phase: sample.phase, reasons });
        } else {
          prior.streak = 0;
        }
        prior.maxStreak = Math.max(prior.maxStreak, prior.streak);
        state.set(sample.node, prior);
      }
      for (const [node, value] of state) {
        const allowedPidChanges = restartNodes.has(node) ? 1 : 0;
        if (value.supervisorPidChanges > 0) {
          failures.push(`node ${node} systemd supervisor PID changed ${value.supervisorPidChanges} times; allowed 0`);
        }
        if (value.workerPidChanges > allowedPidChanges) {
          failures.push(`node ${node} daemon worker PID changed ${value.workerPidChanges} times; allowed ${allowedPidChanges}`);
        }
        if (value.oxigraphPidChanges > allowedPidChanges) {
          failures.push(`node ${node} Oxigraph PID changed ${value.oxigraphPidChanges} times; allowed ${allowedPidChanges}`);
        }
        if (value.maxStreak >= maxConsecutive) {
          failures.push(
            `node ${node} sustained saturation for ${value.maxStreak} samples: ` +
            JSON.stringify(value.saturationSamples.slice(-value.maxStreak)),
          );
        }
      }
      const report = {
        thresholds: {
          maxAcceptQueue: maxQueue,
          maxHostMemoryUsedPercent: maxMemory,
          maxLoadPerCpuPercent: maxLoad,
          consecutiveSamples: maxConsecutive,
        },
        sampleRows: samples.length,
        nodes: Object.fromEntries([...state].map(([node, value]) => [node, {
          supervisorPidChanges: value.supervisorPidChanges,
          daemonWorkerPidChanges: value.workerPidChanges,
          oxigraphPidChanges: value.oxigraphPidChanges,
          maxConsecutiveSaturationSamples: value.maxStreak,
          saturationSamples: value.saturationSamples,
        }])),
        failures,
        passed: failures.length === 0,
      };
      process.stdout.write(JSON.stringify(report, null, 2));
      if (failures.length > 0) process.exitCode = 1;
    '
}

audit_node_health() {
  local node baseline probe journal findings=0 health_report
  local local_status local_pid local_stats local_active log_path start size start_from recent
  sample_node_health final
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    wait_node_ready "$CURATOR_NODE" 30 \
      || fail "local testnet edge is not API-ready at the final health gate"
    local_status="$(api_call "$CURATOR_NODE" GET /api/status)"
    commit_matches "$(json_get "$local_status" commit)" "$TESTNET_EXPECT_COMMIT" \
      || fail "local edge changed deployed commit during the run: $local_status"
    [ "$(json_get "$local_status" asyncPublisher.available)" = "true" ] \
      || fail "local edge publisher is unavailable at the final health gate: $local_status"
    local_pid="$(local_edge_daemon_pid || true)"
    [ "$local_pid" = "$LOCAL_EDGE_RESTARTED_PID" ] \
      || fail "local edge daemon changed PID after its planned restart (expected=$LOCAL_EDGE_RESTARTED_PID current=${local_pid:-missing})"
    local_stats="$(api_call "$CURATOR_NODE" GET /api/publisher/stats)"
    local_active="$(printf '%s' "$local_stats" | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const value = JSON.parse(input);
        const active = ["accepted", "claimed", "validated", "broadcast", "included"]
          .reduce((sum, status) => sum + Number(value?.[status] || 0), 0);
        process.stdout.write(String(active));
      });
    ' 2>/dev/null || true)"
    [ "$local_active" = "0" ] \
      || fail "local edge still has ${local_active:-unreadable} active publisher jobs at the final gate: $local_stats"
    save_artifact "local-edge-final-status.json" "$local_status"
    save_artifact "local-edge-final-publisher-stats.json" "$local_stats"
    log_path="$TESTNET_LOCAL_EDGE_HOME/daemon.log"
    start="$(cat "$RUN_DIR/local-edge-daemon-log-start-byte" 2>/dev/null || printf '0')"
    size=0
    [ ! -f "$log_path" ] || size="$(wc -c < "$log_path" | tr -d '[:space:]')"
    [ "$size" -ge "$start" ] && start_from=$((start + 1)) || start_from=1
    recent="$(tail -c "+$start_from" "$log_path" 2>/dev/null \
      | grep -Ei 'heap out of memory|oom-kill|out of memory|killed process|segmentation fault|segfault|core dumped|thread .* panicked|fatal runtime error|oxigraph.*(panic|fatal|crash|aborted)' || true)"
    printf '%s\n' "$recent" | sanitize_stream > "$RUN_DIR/local-edge-health-log.log"
    [ -z "$recent" ] || findings=$((findings + 1))
    for node in $(seq 1 "$NUM_NODES"); do
      baseline="$(sed -n "${node}p" "$RUN_DIR/health-baselines.jsonl")"
      probe="$(testnet_probe_node "$node")" || fail "final health probe failed for node $node"
      [ "$(json_get "$probe" serviceActive)" = "active" ] \
        || fail "node $node service is not active at the final gate: $probe"
      [ "$(json_get "$probe" nRestarts)" = "$(json_get "$baseline" nRestarts)" ] \
        || fail "node $node had an unexpected systemd restart: baseline=$baseline final=$probe"
      commit_matches "$(json_get "$probe" currentCommit)" "$TESTNET_EXPECT_COMMIT" \
        || fail "node $node changed deployed commit during the run: $probe"
      journal="$(collect_testnet_health_journal "$node" 2>/dev/null || true)"
      printf '%s\n' "$journal" | sanitize_stream > "$RUN_DIR/node${node}-health-journal.log"
      if [ -n "$journal" ]; then
        findings=$((findings + 1))
      fi
    done
    [ "$findings" -eq 0 ] \
      || fail "$findings testnet node(s) logged an OOM, process crash, or Oxigraph fatal condition"
    if ! health_report="$(audit_testnet_health_samples 2>&1)"; then
      save_artifact "health-audit.json" "$health_report"
      fail "testnet health samples failed the OOM/sustained-saturation gate"
    fi
    save_artifact "health-audit.json" "$health_report"
  else
    for node in $(seq 1 "$NUM_NODES"); do
      wait_node_ready "$node" 30 || fail "devnet node $node is not API-ready at the final health gate"
      local log_path start size start_from recent
      log_path="$(node_log "$node")"
      start="$(cat "$RUN_DIR/node${node}-daemon-log-start-byte" 2>/dev/null || printf '0')"
      size=0
      [ ! -f "$log_path" ] || size="$(wc -c < "$log_path" | tr -d '[:space:]')"
      [ "$size" -ge "$start" ] && start_from=$((start + 1)) || start_from=1
      recent="$(tail -c "+$start_from" "$log_path" 2>/dev/null \
        | grep -Ei 'heap out of memory|oom-kill|out of memory|killed process|segmentation fault|segfault|core dumped|thread .* panicked|fatal runtime error|oxigraph.*(panic|fatal|crash|aborted)' || true)"
      printf '%s\n' "$recent" | sanitize_stream > "$RUN_DIR/node${node}-health-log.log"
      [ -z "$recent" ] || findings=$((findings + 1))
    done
    [ "$findings" -eq 0 ] \
      || fail "$findings devnet node(s) logged an OOM, process crash, or Oxigraph fatal condition"
    save_artifact "health-audit.json" "$(SAMPLES="$HEALTH_SAMPLE_COUNT" node -e '
      process.stdout.write(JSON.stringify({
        target: "devnet",
        sampleRounds: Number(process.env.SAMPLES),
        finalApisReady: true,
        fatalLogFindings: 0,
        passed: true,
      }, null, 2));
    ')"
  fi
  HEALTH_AUDIT_PASSED=1
}

stop_node() {
  local node="$1" host
  if is_local_testnet_edge "$node"; then
    DKG_HOME="$TESTNET_LOCAL_EDGE_HOME" node "$TESTNET_LOCAL_EDGE_CLI" stop
    return
  fi
  if [ "$HARNESS_TARGET" = "devnet" ]; then
    "$DEVNET_SH" stop-node "$node"
    return
  fi
  host="$(testnet_node_ssh "$node")"
  ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" \
    sudo -n /usr/bin/systemctl stop "$TESTNET_SERVICE"
}

restart_node() {
  local node="$1" host
  if is_local_testnet_edge "$node"; then
    # The scenario calls this only after the edge has been stopped. Starting
    # through the exact candidate CLI keeps the recovered half of the test on
    # the same code that served the seed and publish phases.
    DKG_HOME="$TESTNET_LOCAL_EDGE_HOME" node "$TESTNET_LOCAL_EDGE_CLI" start
    return
  fi
  if [ "$HARNESS_TARGET" = "devnet" ]; then
    "$DEVNET_SH" restart-node "$node"
    return
  fi
  host="$(testnet_node_ssh "$node")"
  # Keep systemd's foreground supervisor alive and crash only its worker. The
  # supervisor deliberately respawns non-zero worker exits, which gives this
  # persistence gate a real abrupt-restart boundary without requiring sudo or
  # incrementing systemd NRestarts. The Oxigraph parent watchdog tears down the
  # old store process before the replacement worker starts it again.
  ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- "$TESTNET_SERVICE" <<'REMOTE'
set -eu
service="$1"
main_pid="$(systemctl show "$service" -p MainPID --value)"
[[ "$main_pid" =~ ^[0-9]+$ ]] && [ "$main_pid" -gt 0 ] \
  || { echo "service $service has no live supervisor" >&2; exit 1; }
old_worker="$(pgrep -P "$main_pid" -f 'daemon-foreground-worker' | head -n1)"
[[ "$old_worker" =~ ^[0-9]+$ ]] && [ "$old_worker" -gt 0 ] \
  || { echo "service $service has no daemon worker" >&2; exit 1; }
kill -KILL "$old_worker"
for _ in $(seq 1 120); do
  new_worker="$(pgrep -P "$main_pid" -f 'daemon-foreground-worker' 2>/dev/null | head -n1 || true)"
  if [[ "$new_worker" =~ ^[0-9]+$ ]] && [ "$new_worker" -gt 0 ] \
    && [ "$new_worker" != "$old_worker" ] && kill -0 "$new_worker" 2>/dev/null; then
    exit 0
  fi
  sleep 0.25
done
echo "service $service supervisor did not respawn its daemon worker" >&2
exit 1
REMOTE
}

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_db()    { echo "$(node_dir "$1")/node-ui.db"; }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }
node_token() {
  grep -v '^#' "$(node_dir "$1")/auth.token" 2>/dev/null | head -1 | tr -d '\r\n'
}

urlencode() {
  VALUE="$1" node -e 'process.stdout.write(encodeURIComponent(process.env.VALUE || ""))'
}

json_get() {
  local json="$1" path="$2"
  printf '%s' "$json" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(d);
        for (const part of process.argv[1].split(".")) {
          if (!part) continue;
          value = value == null ? undefined : value[part];
        }
        if (value === undefined) return;
        if (value === null) process.stdout.write("null");
        else if (typeof value === "object") process.stdout.write(JSON.stringify(value));
        else process.stdout.write(String(value));
      } catch {}
    });
  ' "$path"
}

join_request_present() {
  local json="$1" agent="$2"
  printf '%s' "$json" | AGENT="$agent" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        if (!Array.isArray(j.requests)) {
          process.stdout.write("invalid");
          return;
        }
        const target = process.env.AGENT.toLowerCase();
        process.stdout.write(j.requests.some(
          r => String(r.agentAddress || "").toLowerCase() === target,
        ) ? "1" : "0");
      } catch { process.stdout.write("invalid"); }
    });
  '
}

assert_open_join_policy() {
  local response="$1" label="$2"
  [ "$(json_get "$response" mode)" = "open" ] \
    || fail "$label did not report mode=open: $response"
  [ "$(json_get "$response" source)" = "persisted" ] \
    || fail "$label did not report a persisted policy: $response"
  [ "$(json_get "$response" maxMembers)" = "$AUTO_MAX_MEMBERS" ] \
    || fail "$label reported the wrong member cap: $response"
  [ "$(json_get "$response" maxApprovalsPerHour)" = "$AUTO_MAX_APPROVALS_PER_HOUR" ] \
    || fail "$label reported the wrong hourly approval cap: $response"
}

json_empty_response_count() {
  printf '%s' "$1" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const root = JSON.parse(d);
        let total = 0;
        const visit = value => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "emptyResponses" && Number.isFinite(Number(child))) total += Number(child);
            else visit(child);
          }
        };
        visit(root);
        process.stdout.write(String(total));
      } catch { process.stdout.write("0"); }
    });
  '
}

json_inserted_triple_count() {
  printf '%s' "$1" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const root = JSON.parse(d);
        let total = 0;
        const visit = value => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if ((key === "insertedMetaTriples" || key === "insertedDataTriples")
                && Number.isFinite(Number(child))) total += Number(child);
            else visit(child);
          }
        };
        visit(root);
        process.stdout.write(String(total));
      } catch { process.stdout.write("0"); }
    });
  '
}

sanitize_stream() {
  node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      d = d
        .replace(/("(?:signature|privateKey|private_key|authToken|auth_token|token)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2")
        .replace(/0x[0-9a-f]{96,}/gi, "<redacted-long-hex>");
      process.stdout.write(d);
    });
  '
}

save_artifact() {
  local name="$1" content="${2:-}"
  printf '%s\n' "$content" | sanitize_stream > "$RUN_DIR/$name"
}

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local request_timeout="${API_TIMEOUT_OVERRIDE:-$API_TIMEOUT_S}"
  if is_local_testnet_edge "$node"; then
    local token
    token="$(local_edge_token)"
    local -a local_args=(
      -sS --max-time "$request_timeout" -X "$method"
      -H 'Content-Type: application/json'
    )
    [ -z "$token" ] || local_args+=(-H "Authorization: Bearer $token")
    [ -n "$data" ] && local_args+=(--data-binary @-)
    local_args+=("http://${TESTNET_LOCAL_EDGE_API_HOST}:${TESTNET_LOCAL_EDGE_API_PORT}${path}")
    if [ -n "$data" ]; then
      printf '%s' "$data" | curl "${local_args[@]}"
    else
      curl "${local_args[@]}"
    fi
    return
  fi
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    local host path_b64 has_data remote_script remote_command
    host="$(testnet_node_ssh "$node")"
    path_b64="$(printf '%s' "$path" | base64_one_line)"
    has_data=0
    [ -n "$data" ] && has_data=1
    # Do not put request bodies in SSH argv. A 1,000-triple KA is hundreds of
    # kilobytes once encoded and can exceed the remote per-argument limit.
    # Quote only the compact script/metadata into the remote command and stream
    # the raw JSON body over stdin directly into curl.
    remote_script='set -euo pipefail
method="$1"
path="$(printf "%s" "$2" | base64 -d)"
timeout="$3"
has_data="$4"
token="$(grep -v "^#" "$HOME/.dkg/auth.token" 2>/dev/null | head -n1 | tr -d "\r\n")"
port="$(tr -d "\r\n" < "$HOME/.dkg/api.port" 2>/dev/null || printf "9200")"
host="$(tailscale ip -4 | head -n1)"
[ -n "$token" ] && [ -n "$host" ]
args=(
  -sS --max-time "$timeout" -X "$method"
  -H "Authorization: Bearer $token"
  -H "Content-Type: application/json"
)
[ "$has_data" = "1" ] && args+=(--data-binary @-)
args+=("http://${host}:${port}${path}")
curl "${args[@]}"'
    printf -v remote_command '/bin/bash -c %q -- %q %q %q %q' \
      "$remote_script" "$method" "$path_b64" "$request_timeout" "$has_data"
    if [ "$has_data" = "1" ]; then
      # shellcheck disable=SC2029 # remote_command is intentionally %q-quoted above.
      printf '%s' "$data" | ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" "$remote_command"
    else
      # shellcheck disable=SC2029 # remote_command is intentionally %q-quoted above.
      ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" "$remote_command" </dev/null
    fi
    return
  fi
  local token port
  token="$(node_token "$node")"
  port="$(node_port "$node")"
  [ -n "$token" ] || return 1
  local -a args=(
    -sS --max-time "$request_timeout" -X "$method"
    -H "Authorization: Bearer $token"
    -H 'Content-Type: application/json'
  )
  [ -n "$data" ] && args+=(--data-binary @-)
  args+=("http://127.0.0.1:${port}${path}")
  if [ -n "$data" ]; then
    printf '%s' "$data" | curl "${args[@]}"
  else
    curl "${args[@]}"
  fi
}

# Integrity certification deliberately performs exact, per-KA reads. Testnet
# cores rate-limit API clients to a fixed one-minute window, so a valid run can
# otherwise misread the JSON 429 response as an empty SPARQL result. Retry only
# this read-only certification traffic; keep all state-changing API calls and
# negative-path assertions on the original fail-fast semantics.
integrity_api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local response attempt=0
  while [ "$attempt" -le "$INTEGRITY_RATE_LIMIT_MAX_RETRIES" ]; do
    if ! response="$(api_call "$node" "$method" "$path" "$data")"; then
      return 1
    fi
    case "$response" in
      *"Too many requests"*)
        if [ "$attempt" -ge "$INTEGRITY_RATE_LIMIT_MAX_RETRIES" ]; then
          printf '%s' "$response"
          return 1
        fi
        attempt=$((attempt + 1))
        printf '%s node=%s method=%s path=%s attempt=%s backoff_s=%s\n' \
          "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$node" "$method" "$path" \
          "$attempt" "$INTEGRITY_RATE_LIMIT_BACKOFF_S" \
          >> "$RUN_DIR/integrity-rate-limit-retries.log"
        sleep "$INTEGRITY_RATE_LIMIT_BACKOFF_S"
        ;;
      *)
        printf '%s' "$response"
        return 0
        ;;
    esac
  done
  return 1
}

node_ready() {
  local node="$1" body
  body="$(API_TIMEOUT_OVERRIDE=5 api_call "$node" GET /api/status 2>/dev/null || true)"
  [ -n "$(json_get "$body" peerId)" ]
}

wait_node_ready() {
  local node="$1" timeout="${2:-90}" start
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$timeout" ]; do
    if node_ready "$node"; then return 0; fi
    sleep 1
  done
  return 1
}

wait_node_down() {
  local node="$1" timeout="${2:-45}" start
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$timeout" ]; do
    if is_local_testnet_edge "$node"; then
      if ! node_ready "$node"; then return 0; fi
    elif [ "$HARNESS_TARGET" = "testnet" ]; then
      local host state
      host="$(testnet_node_ssh "$node")"
      state="$(ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- "$TESTNET_SERVICE" 2>/dev/null <<'REMOTE' || true
systemctl is-active "$1"
REMOTE
)"
      [ "$state" != "active" ] && return 0
    elif ! node_ready "$node"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

node_role() {
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    local status
    status="$(api_call "$1" GET /api/status 2>/dev/null || true)"
    json_get "$status" nodeRole
    return
  fi
  local config
  config="$(node_dir "$1")/config.json"
  node -e '
    const fs = require("fs");
    try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).nodeRole || ""); }
    catch {}
  ' "$config"
}

db_subscription_row() {
  local node="$1" db
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    local host cg_b64
    host="$(testnet_node_ssh "$node")"
    cg_b64="$(printf '%s' "$CG_ID" | base64_one_line)"
    ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- "$cg_b64" <<'REMOTE'
set -euo pipefail
cg="$(printf '%s' "$1" | base64 -d)"
db="$HOME/.dkg/node-ui.db"
[ -f "$db" ] || { printf 'null'; exit 0; }
cd "$HOME/.dkg/releases/current/packages/cli"
DB_PATH="$db" DB_CG_ID="$cg" node --input-type=commonjs <<'NODE'
const Database = require('better-sqlite3');

try {
  const db = new Database(process.env.DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  const row = db.prepare(`
    SELECT context_graph_id, subscribed, synced, shared_memory_synced,
           meta_synced, on_chain_id, sync_scoped, updated_at
      FROM context_graph_subscriptions
     WHERE context_graph_id = ?
  `).get(process.env.DB_CG_ID);
  db.close();
  process.stdout.write(JSON.stringify(row || null));
} catch {
  process.stdout.write('null');
}
NODE
REMOTE
    return
  fi
  db="$(node_db "$node")"
  [ -f "$db" ] || { printf 'null'; return 0; }
  # Open the live WAL database read-only (not immutable) so SQLite still sees
  # committed WAL frames while the daemon is running. Resolve better-sqlite3
  # from packages/cli, which owns the daemon-side subscription-store wiring.
  (
    cd "$REPO_ROOT/packages/cli"
    DB_PATH="$db" DB_CG_ID="$CG_ID" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';

try {
  const db = new Database(process.env.DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  const row = db.prepare(`
    SELECT context_graph_id, subscribed, synced, shared_memory_synced,
           meta_synced, on_chain_id, sync_scoped, updated_at
      FROM context_graph_subscriptions
     WHERE context_graph_id = ?
  `).get(process.env.DB_CG_ID);
  db.close();
  process.stdout.write(JSON.stringify(row || null));
} catch {
  process.stdout.write('null');
}
NODE
  )
}

wait_subscription_row() {
  local timeout="${1:-15}" start row
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$timeout" ]; do
    row="$(db_subscription_row "$JOINER_NODE")"
    if [ "$row" != "null" ] && [ -n "$row" ]; then
      printf '%s' "$row"
      return 0
    fi
    sleep 1
  done
  return 1
}

sparql_count() {
  printf '%s' "$1" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const bindings = j?.result?.bindings ?? j?.result?.results?.bindings ?? j?.results?.bindings ?? j?.bindings ?? [];
        const b = bindings[0] || {};
        const term = b.n ?? b.cnt ?? b.count;
        const raw = term && typeof term === "object" ? term.value : term;
        const match = String(raw ?? "").match(/-?\d+/);
        if (match) process.stdout.write(match[0]);
      } catch {}
    });
  '
}

# The query API returns an empty bindings array (rather than COUNT=0) when the
# caller has no local catalog entry for the requested private graph. For the
# pre-admission security checks, both forms mean "no readable local material".
count_is_absent() {
  [ -z "${1:-}" ] || [ "$1" = "0" ]
}

query_count() {
  local node="$1" graph_suffix="$2" pattern="$3" sub_graph="${4:-}" body response
  body="$(CG="$CG_ID" SUFFIX="$graph_suffix" PATTERN="$pattern" SUB="$sub_graph" node -e '
    const suffix = process.env.SUFFIX;
    const subGraph = process.env.SUB;
    const graphPattern = suffix === "_meta"
      ? `GRAPH <did:dkg:context-graph:${process.env.CG}/_meta> { ${process.env.PATTERN} }`
      : process.env.PATTERN;
    const out = {
      contextGraphId: process.env.CG,
      sparql: `SELECT (COUNT(*) AS ?n) WHERE { ${graphPattern} }`,
    };
    // `_meta` is not a memory-layer route. It is queried through the
    // query engine same-CG explicit-GRAPH allow-list; passing the unknown
    // suffix used to silently route this probe to the data graph and report
    // a false zero after an otherwise successful recovery.
    if (suffix !== "_meta") out.graphSuffix = suffix;
    if (subGraph) out.subGraphName = subGraph;
    process.stdout.write(JSON.stringify(out));
  ')"
  response="$(api_call "$node" POST /api/query "$body" 2>/dev/null || true)"
  sparql_count "$response"
}

root_count() {
  query_count "$1" _shared_memory '?s <http://schema.org/name> ?o'
}

subgraph_count() {
  query_count "$1" _shared_memory '?s <http://schema.org/name> ?o' "$SUB_GRAPH_NAME"
}

vm_count() {
  local node="$1" sub_graph="${2:-}" body response
  body="$(CG="$CG_ID" SUB="$sub_graph" node -e '
    process.stdout.write(JSON.stringify({
      contextGraphId: process.env.CG,
      view: "verifiable-memory",
      sparql: "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }",
      ...(process.env.SUB ? { subGraphName: process.env.SUB } : {}),
    }));
  ')"
  response="$(api_call "$node" POST /api/query "$body" 2>/dev/null || true)"
  sparql_count "$response"
}

root_vm_count() {
  local node="$1" all_vm subgraph_vm
  # An unscoped verifiable-memory view intentionally fans out across the CG
  # root and every registered sub-graph. This fixture creates exactly one
  # sub-graph, so derive the root-only count by removing that scoped lane.
  all_vm="$(vm_count "$node")"
  subgraph_vm="$(subgraph_vm_count "$node")"
  printf '%s' "$((all_vm - subgraph_vm))"
}

subgraph_vm_count() {
  vm_count "$1" "$SUB_GRAPH_NAME"
}

meta_count() {
  query_count "$1" _meta '?s ?p ?o'
}

knowledge_asset_count() {
  query_count "$1" _meta '?s <http://dkg.io/ontology/assertionName> ?name'
}

integrity_head_query() {
  local node="$1" manifest_row="$2" lane ual meta_graph body
  lane="$(json_get "$manifest_row" lane)"
  ual="$(json_get "$manifest_row" kaUal)"
  if [ "$lane" = "subgraph" ]; then
    meta_graph="did:dkg:context-graph:$CG_ID/$SUB_GRAPH_NAME/_shared_memory_meta"
  else
    meta_graph="did:dkg:context-graph:$CG_ID/_shared_memory_meta"
  fi
  body="$(CG="$CG_ID" LANE="$lane" SUB="$SUB_GRAPH_NAME" META="$meta_graph" UAL="$ual" node -e '
    const dkg = "http://dkg.io/ontology/";
    const sparql = `SELECT ?scopeVersion ?kaUal ?assertionVersion ?assertionGraph
                            ?shareOperationId ?digest ?publicCount ?privateCount WHERE {
      GRAPH <${process.env.META}> {
        ?head <${dkg}contentScopeVersion> ?scopeVersion ;
              <${dkg}kaUal> <${process.env.UAL}> ;
              <${dkg}kaUal> ?kaUal ;
              <${dkg}assertionVersion> ?assertionVersion ;
              <${dkg}assertionGraph> ?assertionGraph ;
              <${dkg}shareOperationId> ?shareOperationId .
        ?operation <${dkg}shareOperationId> ?shareOperationId ;
                   <${dkg}kaUal> <${process.env.UAL}> ;
                   <${dkg}assertionVersion> ?assertionVersion ;
                   <${dkg}publicQuadsDigest> ?digest ;
                   <${dkg}publicQuadsCount> ?publicCount ;
                   <${dkg}privateTripleCount> ?privateCount .
      }
    }`;
    process.stdout.write(JSON.stringify({
      contextGraphId: process.env.CG,
      sparql,
      ...(process.env.LANE === "subgraph" ? { subGraphName: process.env.SUB } : {}),
    }));
  ')"
  integrity_api_call "$node" POST /api/query "$body"
}

validate_integrity_head_response() {
  local manifest_row="$1"
  EXPECTED="$manifest_row" node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const expected = JSON.parse(process.env.EXPECTED);
      const payload = JSON.parse(input);
      const bindings = payload?.result?.bindings
        ?? payload?.result?.results?.bindings
        ?? payload?.results?.bindings
        ?? payload?.bindings
        ?? [];
      const raw = value => typeof value === "string" ? value : value?.value;
      const lexical = value => {
        const text = String(raw(value) ?? "");
        const match = text.match(/^("(?:[^"\\]|\\.)*")/);
        return match ? JSON.parse(match[1]) : text;
      };
      const integer = value => {
        const match = lexical(value).match(/^-?\d+$/);
        return match ? Number(match[0]) : NaN;
      };
      if (bindings.length !== 1) {
        throw new Error(`expected one SWM head binding, found ${bindings.length}`);
      }
      const row = bindings[0];
      const actual = {
        contentScopeVersion: integer(row.scopeVersion),
        kaUal: lexical(row.kaUal),
        assertionVersion: integer(row.assertionVersion),
        assertionGraph: lexical(row.assertionGraph),
        shareOperationId: lexical(row.shareOperationId),
        publicQuadsDigest: lexical(row.digest),
        publicTripleCount: integer(row.publicCount),
        privateTripleCount: integer(row.privateCount),
      };
      const mismatches = [];
      if (actual.contentScopeVersion !== 2) mismatches.push("contentScopeVersion");
      if (actual.kaUal !== expected.kaUal) mismatches.push("kaUal");
      if (actual.assertionVersion !== Number(expected.assertionVersion)) mismatches.push("assertionVersion");
      if (actual.assertionGraph !== expected.assertionGraph) mismatches.push("assertionGraph");
      if (actual.shareOperationId !== expected.shareOperationId) mismatches.push("shareOperationId");
      if (actual.publicQuadsDigest !== expected.publicQuadsDigest) mismatches.push("publicQuadsDigest");
      if (actual.publicTripleCount !== Number(expected.triplesExpected)) mismatches.push("publicTripleCount");
      if (actual.privateTripleCount !== 0) mismatches.push("privateTripleCount");
      if (mismatches.length > 0) {
        throw new Error(`SWM head mismatch (${mismatches.join(", ")}): ${JSON.stringify(actual)}`);
      }
      process.stdout.write(JSON.stringify(actual));
    });
  '
}

integrity_data_query() {
  local node="$1" manifest_row="$2" lane graph body
  lane="$(json_get "$manifest_row" lane)"
  graph="$(json_get "$manifest_row" assertionGraph)"
  body="$(CG="$CG_ID" LANE="$lane" SUB="$SUB_GRAPH_NAME" GRAPH_IRI="$graph" node -e '
    const sparql = `SELECT ?s ?p ?o WHERE {
      GRAPH ?g { ?s ?p ?o }
      FILTER(STR(?g) = ${JSON.stringify(process.env.GRAPH_IRI)})
    }`;
    process.stdout.write(JSON.stringify({
      contextGraphId: process.env.CG,
      sparql,
      includeContextGraphPartitions: true,
      ...(process.env.LANE === "subgraph" ? { subGraphName: process.env.SUB } : {}),
    }));
  ')"
  integrity_api_call "$node" POST /api/query "$body"
}

validate_integrity_data_response() {
  local manifest_row="$1"
  EXPECTED="$manifest_row" node -e '
    const { createHash } = require("node:crypto");
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const expected = JSON.parse(process.env.EXPECTED);
      const payload = JSON.parse(input);
      const bindings = payload?.result?.bindings
        ?? payload?.result?.results?.bindings
        ?? payload?.results?.bindings
        ?? payload?.bindings
        ?? [];
      const term = value => String(typeof value === "string" ? value : value?.value ?? "");
      const canonical = bindings
        .map(row => [term(row.s), term(row.p), term(row.o), ""])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const digest = `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
      if (bindings.length !== Number(expected.triplesExpected)) {
        throw new Error(`assertion graph count ${bindings.length}, expected ${expected.triplesExpected}`);
      }
      if (digest !== expected.publicQuadsDigest) {
        throw new Error(`assertion graph digest ${digest}, expected ${expected.publicQuadsDigest}`);
      }
      process.stdout.write(JSON.stringify({
        publicTripleCount: bindings.length,
        publicQuadsDigest: digest,
      }));
    });
  '
}

vm_integrity_data_query() {
  local node="$1" vm_row="$2" lane graph body
  lane="$(json_get "$vm_row" lane)"
  graph="$(json_get "$vm_row" vmAssertionGraph)"
  body="$(CG="$CG_ID" LANE="$lane" SUB="$SUB_GRAPH_NAME" GRAPH_IRI="$graph" node -e '
    const sparql = `SELECT ?s ?p ?o WHERE {
      GRAPH ?g { ?s ?p ?o }
      FILTER(STR(?g) = ${JSON.stringify(process.env.GRAPH_IRI)})
    }`;
    process.stdout.write(JSON.stringify({
      contextGraphId: process.env.CG,
      view: "verifiable-memory",
      sparql,
      ...(process.env.LANE === "subgraph" ? { subGraphName: process.env.SUB } : {}),
    }));
  ')"
  integrity_api_call "$node" POST /api/query "$body"
}

validate_vm_descriptor() {
  local vm_row="$1"
  EXPECTED="$vm_row" node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const expected = JSON.parse(process.env.EXPECTED);
      const actual = JSON.parse(input);
      const mismatches = [];
      if (actual.contextGraphId !== expected.contextGraphId) mismatches.push("contextGraphId");
      if (actual.name !== expected.name) mismatches.push("name");
      if (String(actual.reservedUal || "").toLowerCase() !== String(expected.kaUal || "").toLowerCase()) {
        mismatches.push("reservedUal");
      }
      if (actual.publishedUal !== expected.publishedUal) mismatches.push("publishedUal");
      if (actual.assertionGraph !== expected.vmAssertionGraph) mismatches.push("assertionGraph");
      if (actual.status !== "vm-confirmed") mismatches.push("status");
      if (actual.memoryLayer !== "VM") mismatches.push("memoryLayer");
      const expectedRoot = String(expected.merkleRoot || "").replace(/^0x/, "").toLowerCase();
      const actualRoot = String(actual.vmCurrentAssertion || "").replace(/^0x/, "").toLowerCase();
      if (!expectedRoot || actualRoot !== expectedRoot) mismatches.push("vmCurrentAssertion");
      if (mismatches.length > 0) {
        throw new Error(`VM descriptor mismatch (${mismatches.join(", ")}): ${JSON.stringify(actual)}`);
      }
      process.stdout.write(JSON.stringify({
        reservedUal: actual.reservedUal,
        publishedUal: actual.publishedUal,
        assertionGraph: actual.assertionGraph,
        status: actual.status,
        memoryLayer: actual.memoryLayer,
        vmCurrentAssertion: actual.vmCurrentAssertion,
      }));
    });
  '
}

validate_empty_assertion_data_response() {
  node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const bindings = payload?.result?.bindings
        ?? payload?.result?.results?.bindings
        ?? payload?.results?.bindings
        ?? payload?.bindings
        ?? [];
      if (bindings.length !== 0) {
        throw new Error(`consumed SWM assertion graph still contains ${bindings.length} triples`);
      }
      process.stdout.write(JSON.stringify({ publicTripleCount: 0 }));
    });
  '
}

verify_vm_manifest_on_node() {
  local node="$1" phase="$2" report seed_row vm_row ordinal
  local swm_response swm_result vm_response vm_result descriptor descriptor_result verified=0
  report="$RUN_DIR/${phase}-node${node}-swm-vm-integrity.jsonl"
  : > "$report"
  while IFS= read -r vm_row; do
    [ -n "$vm_row" ] || continue
    ordinal="$(json_get "$vm_row" ordinal)"
    seed_row="$(sed -n "${ordinal}p" "$SEED_MANIFEST")"
    [ -n "$seed_row" ] \
      || fail "$phase node $node has no SWM manifest row for VM KA $ordinal"
    if ! swm_response="$(integrity_data_query "$node" "$seed_row" 2>/dev/null)"; then
      fail "$phase node $node could not query retained SWM graph for KA $ordinal"
    fi
    if ! swm_result="$(printf '%s' "$swm_response" | validate_empty_assertion_data_response 2>&1)"; then
      save_artifact "${phase}-node${node}-ka-${ordinal}-swm-error.json" "$swm_response"
      fail "$phase node $node failed consumed-SWM cleanup for VM KA $ordinal: $swm_result"
    fi
    if ! vm_response="$(vm_integrity_data_query "$node" "$vm_row" 2>/dev/null)"; then
      fail "$phase node $node could not query exact VM graph for KA $ordinal"
    fi
    if ! vm_result="$(printf '%s' "$vm_response" | validate_integrity_data_response "$vm_row" 2>&1)"; then
      save_artifact "${phase}-node${node}-ka-${ordinal}-vm-error.json" "$vm_response"
      fail "$phase node $node failed VM assertion-graph integrity for KA $ordinal: $vm_result"
    fi
    # A late joiner reads assets authored by the curator, while a plain-name
    # descriptor lookup defaults to the bearer token's local author lane. Use
    # the immutable UAL alias so resolveByKaId recovers the actual author from
    # synced lifecycle metadata; querying by name here produces a false 404 on
    # every otherwise-correct cross-node VM sync.
    descriptor="$(knowledge_asset_descriptor "$node" "$(json_get "$vm_row" kaUal)" "$(json_get "$vm_row" lane)" 2>/dev/null || true)"
    if ! descriptor_result="$(printf '%s' "$descriptor" | validate_vm_descriptor "$vm_row" 2>&1)"; then
      save_artifact "${phase}-node${node}-ka-${ordinal}-descriptor-error.json" "$descriptor"
      fail "$phase node $node failed VM lifecycle-pointer integrity for KA $ordinal: $descriptor_result"
    fi
    EXPECTED="$vm_row" SWM_RESULT="$swm_result" VM_RESULT="$vm_result" \
      DESCRIPTOR_RESULT="$descriptor_result" NODE_ID="$node" PHASE="$phase" node -e '
        process.stdout.write(JSON.stringify({
          phase: process.env.PHASE,
          node: Number(process.env.NODE_ID),
          expected: JSON.parse(process.env.EXPECTED),
          consumedSwmGraph: JSON.parse(process.env.SWM_RESULT),
          vmAssertionGraph: JSON.parse(process.env.VM_RESULT),
          descriptor: JSON.parse(process.env.DESCRIPTOR_RESULT),
          verified: true,
        }));
      ' >> "$report"
    printf '\n' >> "$report"
    verified=$((verified + 1))
    if [ $((verified % INTEGRITY_PROGRESS_EVERY_KAS)) -eq 0 ] || [ "$verified" -eq "$VM_PLANNED_KA_COUNT" ]; then
      log "$phase node $node exact VM integrity: $verified/$VM_PLANNED_KA_COUNT"
      maybe_sample_node_health "$phase-vm-integrity-$verified"
    fi
  done < "$VM_PUBLISH_MANIFEST"
  [ "$verified" = "$VM_PLANNED_KA_COUNT" ] \
    || fail "$phase node $node verified $verified VM KAs, expected $VM_PLANNED_KA_COUNT"
  case "$phase" in
    curator-vm) VM_CURATOR_INTEGRITY_VERIFIED="$verified" ;;
    joiner-recovered-vm) VM_JOINER_INTEGRITY_VERIFIED="$verified" ;;
    joiner-post-restart-vm) VM_POST_RESTART_INTEGRITY_VERIFIED="$verified" ;;
  esac
}

verify_manifest_on_node() {
  local node="$1" phase="$2" manifest_file="${3:-$SEED_MANIFEST}" expected_count="${4:-$PLANNED_KA_COUNT}" report
  report="$RUN_DIR/${phase}-node${node}-integrity.jsonl"
  local manifest_row head_response head_result data_response data_result verified=0
  : > "$report"
  while IFS= read -r manifest_row; do
    [ -n "$manifest_row" ] || continue
    if ! head_response="$(integrity_head_query "$node" "$manifest_row" 2>/dev/null)"; then
      fail "$phase node $node could not query SWM head for KA $(json_get "$manifest_row" ordinal)"
    fi
    if ! head_result="$(printf '%s' "$head_response" | validate_integrity_head_response "$manifest_row" 2>&1)"; then
      save_artifact "${phase}-node${node}-ka-$(json_get "$manifest_row" ordinal)-head-error.json" "$head_response"
      fail "$phase node $node failed SWM-head integrity for KA $(json_get "$manifest_row" ordinal): $head_result"
    fi
    if ! data_response="$(integrity_data_query "$node" "$manifest_row" 2>/dev/null)"; then
      fail "$phase node $node could not query exact assertion graph for KA $(json_get "$manifest_row" ordinal)"
    fi
    if ! data_result="$(printf '%s' "$data_response" | validate_integrity_data_response "$manifest_row" 2>&1)"; then
      save_artifact "${phase}-node${node}-ka-$(json_get "$manifest_row" ordinal)-data-error.json" "$data_response"
      fail "$phase node $node failed assertion-graph integrity for KA $(json_get "$manifest_row" ordinal): $data_result"
    fi
    EXPECTED="$manifest_row" HEAD_RESULT="$head_result" DATA_RESULT="$data_result" \
      NODE_ID="$node" PHASE="$phase" node -e '
        process.stdout.write(JSON.stringify({
          phase: process.env.PHASE,
          node: Number(process.env.NODE_ID),
          expected: JSON.parse(process.env.EXPECTED),
          swmHead: JSON.parse(process.env.HEAD_RESULT),
          assertionGraph: JSON.parse(process.env.DATA_RESULT),
          verified: true,
        }));
      ' >> "$report"
    printf '\n' >> "$report"
    verified=$((verified + 1))
    if [ $((verified % INTEGRITY_PROGRESS_EVERY_KAS)) -eq 0 ] || [ "$verified" -eq "$expected_count" ]; then
      log "$phase node $node per-KA integrity: $verified/$expected_count"
      maybe_sample_node_health "$phase-integrity-$verified"
    fi
  done < "$manifest_file"
  [ "$verified" = "$expected_count" ] \
    || fail "$phase node $node verified $verified KAs, expected $expected_count"
  case "$phase" in
    curator-seed) CURATOR_INTEGRITY_VERIFIED="$verified" ;;
    curator-swm) SWM_CURATOR_INTEGRITY_VERIFIED="$verified" ;;
    joiner-recovered-swm) SWM_JOINER_INTEGRITY_VERIFIED="$verified" ;;
    joiner-post-restart-swm) SWM_POST_RESTART_INTEGRITY_VERIFIED="$verified" ;;
    joiner-recovered) JOINER_INTEGRITY_VERIFIED="$verified" ;;
    joiner-post-restart) POST_RESTART_INTEGRITY_VERIFIED="$verified" ;;
  esac
}

private_policy_count() {
  query_count "$1" _meta \
    "<did:dkg:context-graph:$CG_ID> <https://dkg.network/ontology#accessPolicy> \"private\""
}

joiner_allowlist_count() {
  query_count "$1" _meta \
    "<did:dkg:context-graph:$CG_ID> <https://dkg.network/ontology#allowedAgent> \"$JOINER_AGENT\""
}

joiner_delegation_count() {
  local delegation_subject pattern
  if [ -z "$EXPECTED_DELEGATION_AGENT_LOWER" ] \
    || [ -z "$EXPECTED_DELEGATION_PEER" ] \
    || [ -z "$EXPECTED_DELEGATION_OP_KEY_LOWER" ] \
    || [ -z "$EXPECTED_DELEGATION_ISSUED_AT" ] \
    || [ -z "$EXPECTED_DELEGATION_EXPIRES_AT" ]; then
    printf '0'
    return 0
  fi
  delegation_subject="did:dkg:agent-delegation:$CG_ID:$EXPECTED_DELEGATION_AGENT_LOWER"
  pattern="<$delegation_subject> <https://dkg.network/ontology#delegationAgent> \"$EXPECTED_DELEGATION_AGENT_LOWER\" ;
    <https://dkg.network/ontology#delegationIssuedAt> \"$EXPECTED_DELEGATION_ISSUED_AT\" ;
    <https://dkg.network/ontology#delegationExpiresAt> \"$EXPECTED_DELEGATION_EXPIRES_AT\" ;
    <https://dkg.network/ontology#allowedDelegateePeer> \"$EXPECTED_DELEGATION_PEER\" ;
    <https://dkg.network/ontology#allowedDelegateeKey> \"$EXPECTED_DELEGATION_OP_KEY_LOWER\" ."
  query_count "$1" _meta "$pattern"
}

context_graph_exists() {
  local node="$1" response
  response="$(api_call "$node" GET "/api/context-graph/exists?id=$CG_ENCODED" 2>/dev/null || true)"
  json_get "$response" exists
}

catchup_status() {
  api_call "$JOINER_NODE" GET "/api/sync/catchup-status?contextGraphId=$CG_ENCODED" 2>/dev/null || true
}

poll_catchup_terminal() {
  local start status response last=""
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$CATCHUP_TIMEOUT_S" ]; do
    response="$(catchup_status)"
    status="$(json_get "$response" status)"
    if [ -n "$status" ] && [ "$status" != "$last" ]; then
      # The caller captures this function's stdout as the terminal JSON body.
      # Keep progress on stderr so it reaches the transcript without corrupting
      # that captured JSON value.
      log "catch-up status: $status" >&2
      last="$status"
    fi
    case "$status" in
      done|failed|denied|unreachable)
        printf '%s' "$response"
        return 0
        ;;
    esac
    sleep "$POLL_INTERVAL_S"
  done
  return 1
}

build_swm_payload() {
  local count="$1" label="$2" sub_graph="${3:-}"
  CG="$CG_ID" COUNT="$count" LABEL="$label" SUB="$sub_graph" RUN="$RUN_ID" node -e '
    const count = Number(process.env.COUNT);
    const root = `urn:private-cg-recovery:${process.env.RUN}:${process.env.LABEL}:root`;
    const quads = [];
    for (let i = 0; i < count; i++) {
      quads.push({
        // A KA is one logical asset. Keep one root entity and vary the object
        // so the workload is 1,000 distinct RDF statements without also
        // multiplying seal/lifecycle root metadata by 1,000.
        subject: root,
        predicate: "http://schema.org/name",
        object: `"private-cg-recovery-${process.env.LABEL}-${i}"`,
        graph: `did:dkg:context-graph:${process.env.CG}`,
      });
    }
    const out = { contextGraphId: process.env.CG, quads };
    if (process.env.SUB) out.subGraphName = process.env.SUB;
    process.stdout.write(JSON.stringify(out));
  '
}

# Keep this byte-for-byte aligned with
# packages/publisher/src/workspace-snapshot-store.ts:workspacePublicQuadsDigest.
# The graph component is deliberately normalized to the empty string because
# graph-scoped KA sharing pins every submitted triple into the UAL-derived SWM
# graph before computing the durable public commitment.
payload_public_digest() {
  node -e '
    const { createHash } = require("node:crypto");
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const quads = Array.isArray(payload.quads) ? payload.quads : [];
      const canonical = quads
        .map(quad => [String(quad.subject), String(quad.predicate), String(quad.object), ""])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const hash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
      process.stdout.write(`sha256:${hash}`);
    });
  '
}

knowledge_asset_descriptor() {
  local node="$1" name="$2" lane="$3" path
  path="/api/knowledge-assets/$(urlencode "$name")?contextGraphId=$(urlencode "$CG_ID")"
  if [ "$lane" = "subgraph" ]; then
    path="$path&subGraphName=$(urlencode "$SUB_GRAPH_NAME")"
  fi
  integrity_api_call "$node" GET "$path"
}

epoch_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

record_seed_manifest() {
  local ordinal="$1" cohort="$2" lane="$3" label="$4" triples="$5"
  local payload_bytes="$6" duration_ms="$7" expected_digest="$8"
  local descriptor="$9" write_response="${10}"
  printf '%s' "$write_response" \
    | ORDINAL="$ordinal" COHORT="$cohort" LANE="$lane" LABEL="$label" TRIPLES="$triples" \
      PAYLOAD_BYTES="$payload_bytes" DURATION_MS="$duration_ms" \
      EXPECTED_DIGEST="$expected_digest" DESCRIPTOR="$descriptor" node -e '
        let input = "";
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => {
          const response = JSON.parse(input);
          const descriptor = JSON.parse(process.env.DESCRIPTOR);
          const createResponse = Array.isArray(response.responses) ? response.responses[0] : undefined;
          process.stdout.write(JSON.stringify({
            ordinal: Number(process.env.ORDINAL),
            cohort: process.env.COHORT,
            lane: process.env.LANE,
            label: process.env.LABEL,
            name: Array.isArray(response.names) ? response.names[0] : null,
            kaUal: descriptor.reservedUal || null,
            assertionVersion: 1,
            assertionGraph: descriptor.assertionGraph || null,
            triplesExpected: Number(process.env.TRIPLES),
            triplesWritten: Number(response.triplesWritten),
            publicQuadsDigest: process.env.EXPECTED_DIGEST,
            payloadBytes: Number(process.env.PAYLOAD_BYTES),
            durationMs: Number(process.env.DURATION_MS),
            names: Array.isArray(response.names) ? response.names : [],
            shareOperationId: createResponse?.shareOperationId || descriptor.currentShareOperationId || null,
            merkleRoot: createResponse?.merkleRoot || descriptor.swmCurrentAssertion || null,
            responses: (Array.isArray(response.responses) ? response.responses : []).map(item => ({
              shareOperationId: item.shareOperationId || null,
              swmShared: item.swmShared === true,
              publishReady: item.publishReady === true,
              promotedCount: Number(item.promotedCount || 0),
            })),
          }));
        });
      ' | sanitize_stream >> "$SEED_MANIFEST"
  printf '\n' >> "$SEED_MANIFEST"
  if [ "$cohort" = "vm" ]; then
    tail -n1 "$SEED_MANIFEST" >> "$VM_SOURCE_MANIFEST"
  else
    tail -n1 "$SEED_MANIFEST" >> "$SWM_MANIFEST"
  fi
}

seed_named_ka() {
  local ordinal="$1" cohort="$2" lane="$3" triples="$4" label="$5"
  local payload payload_bytes expected_digest started_ms finished_ms duration_ms
  local write_response name_prefix name descriptor reserved_ual assertion_graph
  local share_operation_id descriptor_share_operation_id
  case "$lane" in
    root)
      payload="$(build_swm_payload "$triples" "$label")"
      ;;
    subgraph)
      payload="$(build_swm_payload "$triples" "$label" "$SUB_GRAPH_NAME")"
      ;;
    *) fail "unsupported seed lane: $lane" ;;
  esac
  payload_bytes="$(printf '%s' "$payload" | wc -c | tr -d '[:space:]')"
  expected_digest="$(printf '%s' "$payload" | payload_public_digest)"
  [[ "$expected_digest" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail "KA $ordinal ($lane) expected digest could not be computed"
  started_ms="$(epoch_ms)"
  [ "$SEED_STARTED_AT_MS" != "0" ] || SEED_STARTED_AT_MS="$started_ms"
  name_prefix="private-cg-recovery-${cohort}-${lane}-$(printf '%03d' "$ordinal")"
  if ! write_response="$(devnet_create_shared_ka "$CURATOR_NODE" "$payload" "$name_prefix")"; then
    fail "KA $ordinal ($lane) create/finalize/share request failed"
  fi
  [ "$(json_get "$write_response" triplesWritten)" = "$triples" ] \
    || fail "KA $ordinal ($lane) wrote the wrong triple count: $write_response"
  [ "$(printf '%s' "$(json_get "$write_response" names)" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try { process.stdout.write(String(JSON.parse(d).length)); }
      catch { process.stdout.write("0"); }
    });
  ')" = "1" ] || fail "KA $ordinal ($lane) did not produce exactly one named KA: $write_response"
  [ "$(json_get "$write_response" responses.0.promotedCount)" = "$triples" ] \
    || fail "KA $ordinal ($lane) did not share all $triples triples to SWM: $write_response"
  name="$(json_get "$write_response" names.0)"
  descriptor="$(knowledge_asset_descriptor "$CURATOR_NODE" "$name" "$lane" 2>/dev/null || true)"
  reserved_ual="$(json_get "$descriptor" reservedUal)"
  assertion_graph="$(json_get "$descriptor" assertionGraph)"
  share_operation_id="$(json_get "$write_response" responses.0.shareOperationId)"
  # Metadata-trimmed graph-scoped KAs keep the share operation on the
  # canonical promoted lifecycle event and may omit the redundant
  # lifecycle-level currentShareOperationId row. Read both shapes so the
  # harness remains strict about identity without requiring legacy metadata.
  descriptor_share_operation_id="$(printf '%s' "$descriptor" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      const promoted = Array.isArray(value.events)
        ? [...value.events].reverse().find(event => event?.type === "promoted" && event?.shareOperationId)
        : undefined;
      process.stdout.write(String(value.currentShareOperationId || promoted?.shareOperationId || ""));
    });
  ')"
  [ -n "$reserved_ual" ] && [[ "$reserved_ual" == did:dkg:* ]] \
    || fail "KA $ordinal ($lane) descriptor omitted its reserved UAL: $descriptor"
  [ -n "$assertion_graph" ] && [[ "$assertion_graph" == *"/_shared_memory/"* ]] \
    || fail "KA $ordinal ($lane) descriptor did not point at an exact SWM graph: $descriptor"
  [ -n "$share_operation_id" ] && [ "$descriptor_share_operation_id" = "$share_operation_id" ] \
    || fail "KA $ordinal ($lane) descriptor/share operation mismatch: descriptor=$descriptor response=$write_response"
  finished_ms="$(epoch_ms)"
  duration_ms=$((finished_ms - started_ms))
  SEED_FINISHED_AT_MS="$finished_ms"
  SEED_DURATION_MS=$((SEED_FINISHED_AT_MS - SEED_STARTED_AT_MS))
  SEEDED_KA_COUNT=$((SEEDED_KA_COUNT + 1))
  if [ "$cohort" = "vm" ]; then
    SEEDED_VM_SOURCE_KA_COUNT=$((SEEDED_VM_SOURCE_KA_COUNT + 1))
  else
    SEEDED_SWM_KA_COUNT=$((SEEDED_SWM_KA_COUNT + 1))
  fi
  SEEDED_TRIPLE_COUNT=$((SEEDED_TRIPLE_COUNT + triples))
  SEED_PAYLOAD_BYTES=$((SEED_PAYLOAD_BYTES + payload_bytes))
  [ "$payload_bytes" -le "$MAX_SEED_PAYLOAD_BYTES" ] \
    || MAX_SEED_PAYLOAD_BYTES="$payload_bytes"
  if [ "$lane" = "root" ]; then
    SEEDED_ROOT_KA_COUNT=$((SEEDED_ROOT_KA_COUNT + 1))
  else
    SEEDED_SUB_GRAPH_KA_COUNT=$((SEEDED_SUB_GRAPH_KA_COUNT + 1))
  fi
  record_seed_manifest "$ordinal" "$cohort" "$lane" "$label" "$triples" \
    "$payload_bytes" "$duration_ms" "$expected_digest" "$descriptor" "$write_response"
  LAST_SEED_WRITE="$write_response"
  log "seeded KA $ordinal/$PLANNED_KA_COUNT cohort=$cohort lane=$lane triples=$triples payloadBytes=$payload_bytes durationMs=$duration_ms"
  if [ $((ordinal % HEALTH_SAMPLE_EVERY_KAS)) -eq 0 ] || [ "$ordinal" -eq "$PLANNED_KA_COUNT" ]; then
    sample_node_health "seed-$ordinal"
  fi
}

enqueue_vm_publish() {
  local manifest_row="$1" ordinal lane name body response job_id
  ordinal="$(json_get "$manifest_row" ordinal)"
  lane="$(json_get "$manifest_row" lane)"
  name="$(json_get "$manifest_row" name)"
  body="$(CG="$CG_ID" LANE="$lane" SUB="$SUB_GRAPH_NAME" node -e '
    process.stdout.write(JSON.stringify({
      contextGraphId: process.env.CG,
      ...(process.env.LANE === "subgraph" ? { subGraphName: process.env.SUB } : {}),
      options: { clearAfter: false },
    }));
  ')"
  response="$(api_call "$CURATOR_NODE" POST "/api/knowledge-assets/$(urlencode "$name")/vm/publish-async" "$body" 2>/dev/null || true)"
  job_id="$(json_get "$response" jobId)"
  [ -n "$job_id" ] && [ "$(json_get "$response" status)" = "accepted" ] \
    || { save_artifact "vm-enqueue-ka-${ordinal}-error.json" "$response"; fail "VM enqueue failed for KA $ordinal: $response"; }
  [ "$(json_get "$response" contentScopeVersion)" = "2" ] \
    || fail "VM enqueue for KA $ordinal omitted rootless contentScopeVersion=2: $response"
  [ "$(json_get "$response" publicTripleCount)" = "$(json_get "$manifest_row" triplesExpected)" ] \
    || fail "VM enqueue for KA $ordinal snapshotted the wrong public triple count: $response"
  [ "$(json_get "$response" privateTripleCount)" = "0" ] \
    || fail "VM enqueue for KA $ordinal unexpectedly included private triples: $response"
  [ "$(printf '%s' "$(json_get "$response" kaUal)" | tr '[:upper:]' '[:lower:]')" \
    = "$(printf '%s' "$(json_get "$manifest_row" kaUal)" | tr '[:upper:]' '[:lower:]')" ] \
    || fail "VM enqueue for KA $ordinal changed its reserved UAL: $response"
  EXPECTED="$manifest_row" ENQUEUE="$response" node -e '
    const expected = JSON.parse(process.env.EXPECTED);
    const enqueue = JSON.parse(process.env.ENQUEUE);
    process.stdout.write(JSON.stringify({
      ordinal: expected.ordinal,
      lane: expected.lane,
      name: expected.name,
      kaUal: expected.kaUal,
      assertionVersion: expected.assertionVersion,
      triplesExpected: expected.triplesExpected,
      publicQuadsDigest: expected.publicQuadsDigest,
      shareOperationId: expected.shareOperationId,
      merkleRoot: expected.merkleRoot,
      jobId: enqueue.jobId,
      intentKey: enqueue.intentKey,
      accepted: true,
    }));
  ' >> "$VM_ENQUEUE_MANIFEST"
  printf '\n' >> "$VM_ENQUEUE_MANIFEST"
  VM_ENQUEUED_KA_COUNT=$((VM_ENQUEUED_KA_COUNT + 1))
  if [ $((VM_ENQUEUED_KA_COUNT % VM_PUBLISH_PROGRESS_EVERY_KAS)) -eq 0 ] \
    || [ "$VM_ENQUEUED_KA_COUNT" -eq "$VM_PLANNED_KA_COUNT" ]; then
    log "VM publish jobs enqueued: $VM_ENQUEUED_KA_COUNT/$VM_PLANNED_KA_COUNT"
    maybe_sample_node_health "vm-enqueue-$VM_ENQUEUED_KA_COUNT"
  fi
}

vm_publish_progress() {
  ENQUEUE_FILE="$VM_ENQUEUE_MANIFEST" node -e '
    const fs = require("node:fs");
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
      const tracked = fs.readFileSync(process.env.ENQUEUE_FILE, "utf8")
        .split(/\n+/).filter(Boolean).map(line => JSON.parse(line));
      const byId = new Map(jobs.map(job => [job.jobId, job]));
      const counts = {};
      const missing = [];
      const failed = [];
      let terminal = 0;
      let retryEligible = 0;
      for (const row of tracked) {
        const job = byId.get(row.jobId);
        if (!job) {
          missing.push(row.jobId);
          continue;
        }
        counts[job.status] = (counts[job.status] || 0) + 1;
        if (job.status === "finalized" || job.status === "failed") terminal += 1;
        if (job.status === "failed") {
          if (
            job.failure?.retryable === true &&
            job.failure?.resolution !== "retry_recovery" &&
            Number(job.retries?.retryCount || 0) < Number(job.retries?.maxRetries || 0)
          ) {
            retryEligible += 1;
          }
          failed.push({
            ordinal: row.ordinal,
            jobId: row.jobId,
            failure: job.failure || null,
            retries: job.retries || null,
          });
        }
      }
      process.stdout.write(JSON.stringify({
        tracked: tracked.length,
        terminal,
        finalized: counts.finalized || 0,
        failed: counts.failed || 0,
        retryEligible,
        globalFailed: jobs.filter(job => job.status === "failed").length,
        missing,
        statuses: counts,
        failures: failed,
      }));
    });
  '
}

publisher_job_from_response() {
  local job_id="$1"
  JOB_ID="$job_id" node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const job = (payload.jobs || []).find(item => item.jobId === process.env.JOB_ID);
      process.stdout.write(JSON.stringify(job || null));
    });
  '
}

record_vm_publish_manifest_row() {
  local seed_row="$1" enqueue_row="$2" job="$3" descriptor="$4"
  EXPECTED="$seed_row" ENQUEUE="$enqueue_row" JOB="$job" DESCRIPTOR="$descriptor" \
    CG="$CG_ID" SUB="$SUB_GRAPH_NAME" node -e '
      const expected = JSON.parse(process.env.EXPECTED);
      const enqueue = JSON.parse(process.env.ENQUEUE);
      const job = JSON.parse(process.env.JOB);
      const descriptor = JSON.parse(process.env.DESCRIPTOR);
      const request = job?.request?.knowledgeAssetVmPublish;
      if (job?.status !== "finalized") throw new Error(`job is ${job?.status || "missing"}`);
      if (job?.finalization?.mode !== "published") throw new Error("job did not finalize on chain");
      const hashes = [job?.broadcast?.txHash, job?.inclusion?.txHash, job?.finalization?.txHash];
      if (!hashes.every(hash => /^0x[0-9a-fA-F]{64}$/.test(String(hash || "")))) {
        throw new Error("job omitted canonical transaction hashes");
      }
      if (!hashes.every(hash => hash.toLowerCase() === hashes[0].toLowerCase())) {
        throw new Error("job transaction hashes disagree across phases");
      }
      if (request?.contextGraphId !== process.env.CG || request?.name !== expected.name) {
        throw new Error("job request target does not match the seeded KA");
      }
      if ((request?.subGraphName || "") !== (expected.lane === "subgraph" ? process.env.SUB : "")) {
        throw new Error("job request sub-graph lane does not match the seeded KA");
      }
      if (String(request?.reservedUal || "").toLowerCase() !== String(expected.kaUal).toLowerCase()) {
        throw new Error("job changed the reserved UAL");
      }
      if (request?.shareOperationId !== expected.shareOperationId) {
        throw new Error("job changed the SWM share operation");
      }
      if (Number(job?.validation?.swmQuadCount) !== Number(expected.triplesExpected)) {
        throw new Error("job validated the wrong SWM triple count");
      }
      if (String(job?.broadcast?.merkleRoot || "").toLowerCase() !== String(expected.merkleRoot).toLowerCase()) {
        throw new Error("job broadcast a different sealed merkle root");
      }
      const reserved = String(expected.kaUal).match(/\/(0x[0-9a-fA-F]{40})\/(\d+)$/);
      if (!reserved) throw new Error(`cannot derive VM graph from ${expected.kaUal}`);
      const base = `did:dkg:context-graph:${process.env.CG}` +
        (expected.lane === "subgraph" ? `/${process.env.SUB}` : "");
      const vmAssertionGraph = `${base}/_verifiable_memory/${reserved[1].toLowerCase()}/${reserved[2]}`;
      const publishedUal = job?.finalization?.ual;
      if (!String(publishedUal || "").startsWith("did:dkg:")) throw new Error("job omitted published UAL");
      const descriptorMismatches = [];
      if (descriptor?.assertionGraph !== vmAssertionGraph) descriptorMismatches.push("assertionGraph");
      if (descriptor?.publishedUal !== publishedUal) descriptorMismatches.push("publishedUal");
      if (descriptor?.status !== "vm-confirmed") descriptorMismatches.push("status");
      if (descriptor?.memoryLayer !== "VM") descriptorMismatches.push("memoryLayer");
      const expectedRoot = String(expected.merkleRoot).replace(/^0x/, "").toLowerCase();
      const actualRoot = String(descriptor?.vmCurrentAssertion || "").replace(/^0x/, "").toLowerCase();
      if (actualRoot !== expectedRoot) descriptorMismatches.push("vmCurrentAssertion");
      if (descriptorMismatches.length) {
        throw new Error(`post-publish descriptor mismatch: ${descriptorMismatches.join(", ")}`);
      }
      process.stdout.write(JSON.stringify({
        contextGraphId: process.env.CG,
        ordinal: expected.ordinal,
        lane: expected.lane,
        label: expected.label,
        name: expected.name,
        kaUal: expected.kaUal,
        assertionVersion: expected.assertionVersion,
        swmAssertionGraph: expected.assertionGraph,
        vmAssertionGraph,
        triplesExpected: expected.triplesExpected,
        publicQuadsDigest: expected.publicQuadsDigest,
        shareOperationId: expected.shareOperationId,
        merkleRoot: expected.merkleRoot,
        jobId: enqueue.jobId,
        retryCount: Number(job?.retries?.retryCount || 0),
        txHash: hashes[0],
        blockNumber: job.inclusion.blockNumber,
        publishedUal,
        finalizationMode: job.finalization.mode,
        finalizedAtMs: job?.timestamps?.finalizedAt || null,
        operationSucceeded: true,
      }));
    '
}

publish_seed_manifest_to_vm() {
  [ "$VM_PUBLISH_MODE" = "async-all" ] || return 0
  local row jobs_response progress previous_progress="" retry_response retry_count start now
  local enqueue_row job_id job descriptor vm_row ordinal
  VM_PUBLISH_STARTED_AT_MS="$(epoch_ms)"
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    enqueue_vm_publish "$row"
  done < "$VM_SOURCE_MANIFEST"
  [ "$VM_ENQUEUED_KA_COUNT" = "$VM_PLANNED_KA_COUNT" ] \
    || fail "enqueued $VM_ENQUEUED_KA_COUNT VM publishes, expected $VM_PLANNED_KA_COUNT"

  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$VM_PUBLISH_TIMEOUT_S" ]; do
    jobs_response="$(api_call "$CURATOR_NODE" GET /api/publisher/jobs 2>/dev/null || true)"
    progress="$(printf '%s' "$jobs_response" | vm_publish_progress 2>/dev/null || true)"
    [ -n "$progress" ] || fail "local edge publisher job list became unreadable"
    if [ "$progress" != "$previous_progress" ]; then
      log "VM publisher progress: $(json_get "$progress" terminal)/$VM_PLANNED_KA_COUNT terminal; statuses=$(json_get "$progress" statuses)"
      previous_progress="$progress"
    fi
    if [ "$(json_get "$progress" failed)" != "0" ] \
      && [ "$(json_get "$progress" retryEligible)" = "$(json_get "$progress" failed)" ]; then
      # Lift jobs intentionally expose retryable failures as a durable failed
      # state plus an explicit retry control-plane action. Exercise that path
      # instead of treating a transient all-RPC outage as terminal. The retry
      # endpoint currently operates on every failed publisher job, so fail
      # closed if this dedicated harness edge has any unrelated failed job.
      [ "$(json_get "$progress" globalFailed)" = "$(json_get "$progress" failed)" ] \
        || fail "refusing global publisher retry while unrelated failed jobs exist: $progress"
      retry_response="$(api_call "$CURATOR_NODE" POST /api/publisher/retry '{"status":"failed"}' 2>/dev/null || true)"
      retry_count="$(json_get "$retry_response" retried 2>/dev/null || true)"
      [ -n "$retry_count" ] && [ "$retry_count" != "0" ] \
        || fail "publisher declined retry for tracked retryable VM jobs: response=$retry_response progress=$progress"
      log "VM publisher control plane requeued $retry_count retryable job(s)"
      maybe_sample_node_health vm-publish-retry
      sleep "$VM_PUBLISH_POLL_INTERVAL_S"
      continue
    fi
    # A publisher status transition currently replaces its RDF row as a
    # delete followed by an insert. A concurrent list call can therefore miss
    # that job for one poll even though it remains durable and is progressing.
    # Treat a missing row as non-terminal here; the terminal snapshot below is
    # still strict and requires every tracked job to be present and finalized.
    if [ "$(json_get "$progress" terminal)" = "$VM_PLANNED_KA_COUNT" ]; then
      break
    fi
    maybe_sample_node_health vm-publish-wait
    sleep "$VM_PUBLISH_POLL_INTERVAL_S"
  done
  jobs_response="$(api_call "$CURATOR_NODE" GET /api/publisher/jobs 2>/dev/null || true)"
  progress="$(printf '%s' "$jobs_response" | vm_publish_progress 2>/dev/null || true)"
  save_artifact "vm-publisher-jobs-terminal.json" "$jobs_response"
  save_artifact "vm-publisher-progress-terminal.json" "$progress"
  VM_FINALIZED_KA_COUNT="$(json_get "$progress" finalized)"
  VM_FAILED_KA_COUNT="$(json_get "$progress" failed)"
  [ "$(json_get "$progress" terminal)" = "$VM_PLANNED_KA_COUNT" ] \
    || fail "VM publisher did not reach a terminal state for all KAs within ${VM_PUBLISH_TIMEOUT_S}s: $progress"
  [ "$VM_FINALIZED_KA_COUNT" = "$VM_PLANNED_KA_COUNT" ] \
    || fail "VM publisher finalized only $VM_FINALIZED_KA_COUNT/$VM_PLANNED_KA_COUNT KAs: $progress"

  while IFS= read -r row; do
    [ -n "$row" ] || continue
    ordinal="$(json_get "$row" ordinal)"
    enqueue_row="$(sed -n "${ordinal}p" "$VM_ENQUEUE_MANIFEST")"
    job_id="$(json_get "$enqueue_row" jobId)"
    job="$(printf '%s' "$jobs_response" | publisher_job_from_response "$job_id")"
    descriptor="$(knowledge_asset_descriptor "$CURATOR_NODE" "$(json_get "$row" name)" "$(json_get "$row" lane)" 2>/dev/null || true)"
    if ! vm_row="$(record_vm_publish_manifest_row "$row" "$enqueue_row" "$job" "$descriptor" 2>&1)"; then
      save_artifact "vm-finalized-ka-${ordinal}-job.json" "$job"
      save_artifact "vm-finalized-ka-${ordinal}-descriptor.json" "$descriptor"
      fail "VM finalization evidence failed for KA $ordinal: $vm_row"
    fi
    printf '%s\n' "$vm_row" >> "$VM_PUBLISH_MANIFEST"
  done < "$VM_SOURCE_MANIFEST"
  [ "$(wc -l < "$VM_PUBLISH_MANIFEST" | tr -d '[:space:]')" = "$VM_PLANNED_KA_COUNT" ] \
    || fail "VM publish manifest is incomplete"
  VM_PUBLISH_FINISHED_AT_MS="$(epoch_ms)"
  VM_PUBLISH_DURATION_MS=$((VM_PUBLISH_FINISHED_AT_MS - VM_PUBLISH_STARTED_AT_MS))
  log "VM publication finalized on chain: $VM_FINALIZED_KA_COUNT/$VM_PLANNED_KA_COUNT KAs in ${VM_PUBLISH_DURATION_MS}ms"
}

write_seed_summary_artifact() {
  save_artifact "seed-summary.json" "$(
    PROFILE="$HARNESS_LOAD_PROFILE" PLANNED_KAS="$PLANNED_KA_COUNT" \
    PLANNED_SWM_KAS="$SWM_PLANNED_KA_COUNT" PLANNED_VM_KAS="$VM_PLANNED_KA_COUNT" \
    TRIPLES_PER_KA="$LOAD_TRIPLES_PER_KA" ROOT_KAS="$ROOT_KA_COUNT" \
    SUB_KAS="$SUB_GRAPH_KA_COUNT" ROOT_TRIPLES_ENV="$SEED_ROOT_TRIPLES" \
    SUB_TRIPLES_ENV="$SEED_SUB_GRAPH_TRIPLES" TOTAL_TRIPLES_ENV="$TOTAL_TRIPLES" \
    SEEDED_KAS="$SEEDED_KA_COUNT" SEEDED_SWM_KAS="$SEEDED_SWM_KA_COUNT" \
    SEEDED_VM_KAS="$SEEDED_VM_SOURCE_KA_COUNT" SEEDED_ROOT_KAS="$SEEDED_ROOT_KA_COUNT" \
    SEEDED_SUB_KAS="$SEEDED_SUB_GRAPH_KA_COUNT" SEEDED_TRIPLES="$SEEDED_TRIPLE_COUNT" \
    PAYLOAD_BYTES="$SEED_PAYLOAD_BYTES" MAX_PAYLOAD_BYTES="$MAX_SEED_PAYLOAD_BYTES" \
    DURATION_MS="$SEED_DURATION_MS" node -e '
      const syncLoad = process.env.PROFILE === "sync-load";
      const planned = {
        kaCount: Number(process.env.PLANNED_KAS),
        swmCohortKaCount: Number(process.env.PLANNED_SWM_KAS),
        vmSourceCohortKaCount: Number(process.env.PLANNED_VM_KAS),
        triplesPerKa: syncLoad ? Number(process.env.TRIPLES_PER_KA) : null,
        rootKaCount: Number(process.env.ROOT_KAS),
        subgraphKaCount: Number(process.env.SUB_KAS),
        rootTriples: Number(process.env.ROOT_TRIPLES_ENV),
        subgraphTriples: Number(process.env.SUB_TRIPLES_ENV),
        totalTriples: Number(process.env.TOTAL_TRIPLES_ENV),
      };
      const actual = {
        kaCount: Number(process.env.SEEDED_KAS),
        swmCohortKaCount: Number(process.env.SEEDED_SWM_KAS),
        vmSourceCohortKaCount: Number(process.env.SEEDED_VM_KAS),
        rootKaCount: Number(process.env.SEEDED_ROOT_KAS),
        subgraphKaCount: Number(process.env.SEEDED_SUB_KAS),
        totalTriples: Number(process.env.SEEDED_TRIPLES),
        totalPayloadBytes: Number(process.env.PAYLOAD_BYTES),
        maxKaPayloadBytes: Number(process.env.MAX_PAYLOAD_BYTES),
        durationMs: Number(process.env.DURATION_MS),
      };
      process.stdout.write(JSON.stringify({
        profile: process.env.PROFILE,
        planned,
        actual,
        completed: actual.kaCount === planned.kaCount
          && actual.swmCohortKaCount === planned.swmCohortKaCount
          && actual.vmSourceCohortKaCount === planned.vmSourceCohortKaCount
          && actual.rootKaCount === planned.rootKaCount
          && actual.subgraphKaCount === planned.subgraphKaCount
          && actual.totalTriples === planned.totalTriples,
      }, null, 2));
    '
  )"
}

subscription_flags_ready() {
  local row="$1"
  [ "$(json_get "$row" subscribed)" = "1" ] \
    && [ "$(json_get "$row" synced)" = "1" ] \
    && [ "$(json_get "$row" shared_memory_synced)" = "1" ] \
    && [ "$(json_get "$row" meta_synced)" = "1" ]
}

full_recovery_present() {
  local row="${1:-}" bound_on_chain_id root sub root_vm sub_vm meta knowledge_assets policy allowed delegation
  [ -n "$row" ] || row="$(db_subscription_row "$JOINER_NODE")"
  subscription_flags_ready "$row" || return 1
  bound_on_chain_id="$(json_get "$row" on_chain_id)"
  root="$(root_count "$JOINER_NODE")"
  sub="$(subgraph_count "$JOINER_NODE")"
  root_vm="$(root_vm_count "$JOINER_NODE")"
  sub_vm="$(subgraph_vm_count "$JOINER_NODE")"
  meta="$(meta_count "$JOINER_NODE")"
  knowledge_assets="$(knowledge_asset_count "$JOINER_NODE")"
  policy="$(private_policy_count "$JOINER_NODE")"
  allowed="$(joiner_allowlist_count "$JOINER_NODE")"
  delegation="$(joiner_delegation_count "$JOINER_NODE")"
  [ "$bound_on_chain_id" = "$ON_CHAIN_ID" ] \
    && [ "$root" = "$ROOT_TRIPLES" ] \
    && [ "$sub" = "$SUB_GRAPH_TRIPLES" ] \
    && { [ "$VM_PUBLISH_MODE" = "none" ] \
      || { [ "$root_vm" = "$VM_ROOT_TRIPLES" ] && [ "$sub_vm" = "$VM_SUB_GRAPH_TRIPLES" ]; }; } \
    && [ -n "$meta" ] && [ "$meta" -gt 0 ] \
    && [ "$knowledge_assets" = "$PLANNED_KA_COUNT" ] \
    && [ "$policy" = "1" ] \
    && [ "$allowed" = "1" ] \
    && [ "$delegation" -ge 1 ] 2>/dev/null
}

wait_full_recovery() {
  local timeout="$1" start now row next_exact_check=0
  start="$(date +%s)"
  while true; do
    now="$(date +%s)"
    [ $((now - start)) -lt "$timeout" ] || break
    # Poll only the durable SQLite readiness flags while sync is in flight.
    # The previous loop ran nine exact SPARQL counts every two seconds, adding
    # store load precisely while the joiner was trying to ingest data. Flags
    # are only a readiness hint: once they are complete, run the original full
    # count/ACL assertion. If that assertion catches an eventual-consistency or
    # product bug, retry it at a bounded cadence instead of hammering the store.
    row="$(db_subscription_row "$JOINER_NODE" 2>/dev/null || printf 'null')"
    if subscription_flags_ready "$row" \
      && [ "$(json_get "$row" on_chain_id)" = "$ON_CHAIN_ID" ] \
      && [ "$now" -ge "$next_exact_check" ]; then
      if full_recovery_present "$row"; then return 0; fi
      next_exact_check=$((now + RECOVERY_EXACT_RECHECK_INTERVAL_S))
    fi
    maybe_sample_node_health recovery-wait
    sleep "$POLL_INTERVAL_S"
  done
  return 1
}

list_row() {
  local response
  response="$(api_call "$JOINER_NODE" GET /api/context-graph/list 2>/dev/null || true)"
  printf '%s' "$response" | CG="$CG_ID" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const row = (j.contextGraphs || []).find(x => x && x.id === process.env.CG);
        process.stdout.write(JSON.stringify(row || null));
      } catch { process.stdout.write("null"); }
    });
  '
}

assert_fixed_list_state() {
  local row
  row="$(list_row)"
  [ "$row" != "null" ] || fail "recovered CG is absent from node $JOINER_NODE /api/context-graph/list"
  [ "$(json_get "$row" callerInvolved)" = "true" ] \
    || fail "recovered CG does not report callerInvolved=true: $row"
  [ "$(json_get "$row" subscribed)" = "true" ] \
    || fail "recovered CG does not report subscribed=true: $row"
  [ "$(json_get "$row" synced)" = "true" ] \
    || fail "recovered CG does not report synced=true: $row"
}

reactivate_joiner_subscription_if_dormant() {
  local subscriptions state response body
  subscriptions="$(integrity_api_call "$JOINER_NODE" GET /api/context-graph/subscriptions 2>/dev/null || true)"
  state="$(printf '%s' "$subscriptions" | CG="$CG_ID" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const payload = JSON.parse(d);
        const active = (payload.subscriptions || [])
          .some(row => row?.contextGraphId === process.env.CG);
        const dormant = (payload.rehydration?.dormantIds || [])
          .includes(process.env.CG);
        process.stdout.write(dormant ? "dormant" : active ? "active" : "absent");
      } catch {
        process.stdout.write("unreadable");
      }
    });
  ')"
  [ "$state" = "dormant" ] || return 0

  # Testnet deliberately caps startup activation of non-hosted subscriptions
  # to protect the store from a stale-backlog fan-out. Repeated harness runs
  # can therefore leave this freshly verified CG persisted but dormant after
  # restart. Explicit access is the documented reactivation path: exercise it
  # and then let the normal recovery/durability assertions prove exact state.
  save_artifact "post-restart-rehydration-before-reactivation.json" "$subscriptions"
  body="$(CG="$CG_ID" node -e '
    process.stdout.write(JSON.stringify({
      contextGraphId: process.env.CG,
      includeSharedMemory: true,
    }));
  ')"
  response="$(api_call "$JOINER_NODE" POST /api/context-graph/subscribe "$body")"
  save_artifact "post-restart-reactivation-response.json" "$response"
  [ "$(json_get "$response" subscribed)" = "$CG_ID" ] \
    || fail "joiner could not reactivate its persisted dormant subscription after restart: $response"
  log "joiner reactivated the persisted CG after the configured startup subscription cap left it dormant"
}

snapshot_phase() {
  local phase="$1" row list subscriptions catchup root sub root_vm sub_vm meta knowledge_assets policy allowed delegation
  row="$(db_subscription_row "$JOINER_NODE" 2>/dev/null || printf 'null')"
  list="$(api_call "$JOINER_NODE" GET /api/context-graph/list 2>/dev/null || true)"
  subscriptions="$(api_call "$JOINER_NODE" GET /api/context-graph/subscriptions 2>/dev/null || true)"
  catchup="$(catchup_status)"
  root="$(root_count "$JOINER_NODE")"
  sub="$(subgraph_count "$JOINER_NODE")"
  root_vm="$(root_vm_count "$JOINER_NODE")"
  sub_vm="$(subgraph_vm_count "$JOINER_NODE")"
  meta="$(meta_count "$JOINER_NODE")"
  knowledge_assets="$(knowledge_asset_count "$JOINER_NODE")"
  policy="$(private_policy_count "$JOINER_NODE")"
  allowed="$(joiner_allowlist_count "$JOINER_NODE")"
  delegation="$(joiner_delegation_count "$JOINER_NODE")"
  save_artifact "$phase-subscription-db.json" "$row"
  save_artifact "$phase-context-graph-list.json" "$list"
  save_artifact "$phase-subscriptions-api.json" "$subscriptions"
  save_artifact "$phase-catchup.json" "$catchup"
  save_artifact "$phase-counts.json" "$(ROOT="$root" SUB="$sub" ROOT_VM="$root_vm" SUB_VM="$sub_vm" META="$meta" KNOWLEDGE_ASSETS="$knowledge_assets" POLICY="$policy" ALLOWED="$allowed" DELEGATION="$delegation" DELEGATION_AGENT="$EXPECTED_DELEGATION_AGENT_LOWER" DELEGATION_PEER="$EXPECTED_DELEGATION_PEER" DELEGATION_KEY="$EXPECTED_DELEGATION_OP_KEY_LOWER" DELEGATION_SCOPE="$EXPECTED_DELEGATION_SCOPE" DELEGATION_ISSUED="$EXPECTED_DELEGATION_ISSUED_AT" DELEGATION_EXPIRES="$EXPECTED_DELEGATION_EXPIRES_AT" node -e '
    process.stdout.write(JSON.stringify({
      rootSwm: process.env.ROOT || null,
      subgraphSwm: process.env.SUB || null,
      rootVm: process.env.ROOT_VM || null,
      subgraphVm: process.env.SUB_VM || null,
      meta: process.env.META || null,
      knowledgeAssets: process.env.KNOWLEDGE_ASSETS || null,
      privatePolicy: process.env.POLICY || null,
      joinerAllowed: process.env.ALLOWED || null,
      joinerDelegationTupleMatches: process.env.DELEGATION || null,
      expectedDelegation: {
        agentAddress: process.env.DELEGATION_AGENT || null,
        delegateePeerId: process.env.DELEGATION_PEER || null,
        delegateeOpKey: process.env.DELEGATION_KEY || null,
        scope: process.env.DELEGATION_SCOPE || null,
        issuedAtMs: process.env.DELEGATION_ISSUED || null,
        expiresAtMs: process.env.DELEGATION_EXPIRES || null,
      },
    }, null, 2));
  ')"
}

collect_filtered_logs() {
  [ -n "$CG_ID" ] || return 0
  local node log_path host cg_b64 since_b64 start recent
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    log_path="$TESTNET_LOCAL_EDGE_HOME/daemon.log"
    if [ -f "$log_path" ]; then
      start="$(cat "$RUN_DIR/local-edge-daemon-log-start-byte" 2>/dev/null || printf '0')"
      recent="$(tail -c "+$((start + 1))" "$log_path" 2>/dev/null || true)"
      printf '%s\n' "$recent" | grep -F "$CG_ID" | tail -n 1000 | sanitize_stream \
        > "$RUN_DIR/local-edge-cg-filtered.log" || true
    fi
  fi
  for node in $(seq 1 "$NUM_NODES"); do
    if [ "$HARNESS_TARGET" = "testnet" ]; then
      host="$(testnet_node_ssh "$node")"
      cg_b64="$(printf '%s' "$CG_ID" | base64_one_line)"
      since_b64="$(printf '%s' "$TESTNET_JOURNAL_SINCE" | base64_one_line)"
      ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- \
        "$TESTNET_SERVICE" "$cg_b64" "$since_b64" <<'REMOTE' 2>/dev/null \
        | sanitize_stream > "$RUN_DIR/node${node}-cg-filtered.log" || true
service="$1"
cg="$(printf '%s' "$2" | base64 -d)"
since="$(printf '%s' "$3" | base64 -d)"
journalctl -u "$service" --since "$since" --no-pager 2>/dev/null \
  | grep -F -- "$cg" | tail -n 500 || true
REMOTE
      continue
    fi
    log_path="$(node_log "$node")"
    [ -f "$log_path" ] || continue
    grep -F "$CG_ID" "$log_path" 2>/dev/null | tail -n 500 | sanitize_stream \
      > "$RUN_DIR/node${node}-cg-filtered.log" || true
  done
}

write_summary() {
  local exit_code="$1"
  TARGET="$HARNESS_TARGET" EXPECT="$HARNESS_EXPECT" ADMISSION="$ADMISSION_MODE" \
    PREFLIGHT_ONLY="$TESTNET_PREFLIGHT_ONLY" EXPECTED_COMMIT="$TESTNET_EXPECT_COMMIT" \
    EXIT_CODE="$exit_code" RUN_ID_ENV="$RUN_ID" \
    CG="$CG_ID" CURATOR="$CURATOR_NODE" JOINER="$JOINER_NODE" \
    LOCAL_EDGE_HOME="$TESTNET_LOCAL_EDGE_HOME" LOCAL_EDGE_HOST="$TESTNET_LOCAL_EDGE_API_HOST" \
    LOCAL_EDGE_PORT="$TESTNET_LOCAL_EDGE_API_PORT" \
    LOAD_PROFILE="$HARNESS_LOAD_PROFILE" PLANNED_KAS="$PLANNED_KA_COUNT" \
    PLANNED_SWM_KAS="$SWM_PLANNED_KA_COUNT" PLANNED_VM_KAS="$VM_PLANNED_KA_COUNT" \
    TRIPLES_PER_KA="$LOAD_TRIPLES_PER_KA" ROOT_KAS="$ROOT_KA_COUNT" \
    SUB_KAS="$SUB_GRAPH_KA_COUNT" ROOT_TRIPLES_ENV="$SEED_ROOT_TRIPLES" \
    SUB_TRIPLES_ENV="$SEED_SUB_GRAPH_TRIPLES" TOTAL_TRIPLES_ENV="$TOTAL_TRIPLES" \
    SWM_ROOT_TRIPLES="$ROOT_TRIPLES" SWM_SUB_TRIPLES="$SUB_GRAPH_TRIPLES" \
    VM_ROOT_TRIPLES_ENV="$VM_ROOT_TRIPLES" VM_SUB_TRIPLES_ENV="$VM_SUB_GRAPH_TRIPLES" \
    SEEDED_KAS="$SEEDED_KA_COUNT" SEEDED_SWM_KAS="$SEEDED_SWM_KA_COUNT" \
    SEEDED_VM_KAS="$SEEDED_VM_SOURCE_KA_COUNT" SEEDED_ROOT_KAS="$SEEDED_ROOT_KA_COUNT" \
    SEEDED_SUB_KAS="$SEEDED_SUB_GRAPH_KA_COUNT" SEEDED_TRIPLES="$SEEDED_TRIPLE_COUNT" \
    SEED_PAYLOAD_BYTES="$SEED_PAYLOAD_BYTES" MAX_SEED_PAYLOAD_BYTES="$MAX_SEED_PAYLOAD_BYTES" \
    SEED_DURATION_MS="$SEED_DURATION_MS" \
    CURATOR_INTEGRITY="$CURATOR_INTEGRITY_VERIFIED" \
    JOINER_INTEGRITY="$JOINER_INTEGRITY_VERIFIED" \
    POST_RESTART_INTEGRITY="$POST_RESTART_INTEGRITY_VERIFIED" \
    SWM_CURATOR_INTEGRITY="$SWM_CURATOR_INTEGRITY_VERIFIED" \
    SWM_JOINER_INTEGRITY="$SWM_JOINER_INTEGRITY_VERIFIED" \
    SWM_POST_RESTART_INTEGRITY="$SWM_POST_RESTART_INTEGRITY_VERIFIED" \
    VM_MODE="$VM_PUBLISH_MODE" VM_ENQUEUED="$VM_ENQUEUED_KA_COUNT" \
    VM_FINALIZED="$VM_FINALIZED_KA_COUNT" VM_FAILED="$VM_FAILED_KA_COUNT" \
    VM_DURATION_MS="$VM_PUBLISH_DURATION_MS" \
    VM_CURATOR_INTEGRITY="$VM_CURATOR_INTEGRITY_VERIFIED" \
    VM_JOINER_INTEGRITY="$VM_JOINER_INTEGRITY_VERIFIED" \
    VM_POST_RESTART_INTEGRITY="$VM_POST_RESTART_INTEGRITY_VERIFIED" \
    HEALTH_SAMPLES="$HEALTH_SAMPLE_COUNT" HEALTH_PASSED="$HEALTH_AUDIT_PASSED" \
    AUTO_OBSERVED="$AUTO_APPROVAL_OBSERVED" AUTO_MEMBERS="$AUTO_MAX_MEMBERS" \
    AUTO_HOURLY="$AUTO_MAX_APPROVALS_PER_HOUR" \
    FAILURE="$FAIL_REASON" RECOVERED_BEFORE="$BROKEN_RECOVERED_BEFORE_RESTART" \
    RECOVERED_AFTER="$BROKEN_RECOVERED_AFTER_RESTART" node -e '
      process.stdout.write(JSON.stringify({
        runId: process.env.RUN_ID_ENV,
        target: process.env.TARGET,
        expectation: process.env.EXPECT,
        admissionMode: process.env.ADMISSION,
        preflightOnly: process.env.PREFLIGHT_ONLY === "1",
        expectedCommit: process.env.EXPECTED_COMMIT || null,
        exitCode: Number(process.env.EXIT_CODE),
        contextGraphId: process.env.CG || null,
        curatorNode: Number(process.env.CURATOR),
        joinerNode: Number(process.env.JOINER),
        curatorMode: process.env.TARGET === "testnet" ? "local-edge" : "devnet-node",
        localEdge: process.env.TARGET === "testnet" ? {
          home: process.env.LOCAL_EDGE_HOME,
          apiHost: process.env.LOCAL_EDGE_HOST,
          apiPort: Number(process.env.LOCAL_EDGE_PORT),
        } : null,
        failure: process.env.FAILURE || null,
        load: {
          profile: process.env.LOAD_PROFILE,
          planned: {
            kaCount: Number(process.env.PLANNED_KAS),
            swmCohortKaCount: Number(process.env.PLANNED_SWM_KAS),
            vmSourceCohortKaCount: Number(process.env.PLANNED_VM_KAS),
            triplesPerKa: process.env.LOAD_PROFILE === "sync-load"
              ? Number(process.env.TRIPLES_PER_KA)
              : null,
            rootKaCount: Number(process.env.ROOT_KAS),
            subgraphKaCount: Number(process.env.SUB_KAS),
            rootTriples: Number(process.env.ROOT_TRIPLES_ENV),
            subgraphTriples: Number(process.env.SUB_TRIPLES_ENV),
            totalTriples: Number(process.env.TOTAL_TRIPLES_ENV),
          },
          actual: {
            kaCount: Number(process.env.SEEDED_KAS),
            swmCohortKaCount: Number(process.env.SEEDED_SWM_KAS),
            vmSourceCohortKaCount: Number(process.env.SEEDED_VM_KAS),
            rootKaCount: Number(process.env.SEEDED_ROOT_KAS),
            subgraphKaCount: Number(process.env.SEEDED_SUB_KAS),
            totalTriples: Number(process.env.SEEDED_TRIPLES),
            totalPayloadBytes: Number(process.env.SEED_PAYLOAD_BYTES),
            maxKaPayloadBytes: Number(process.env.MAX_SEED_PAYLOAD_BYTES),
            durationMs: Number(process.env.SEED_DURATION_MS),
          },
          completed: Number(process.env.SEEDED_KAS) === Number(process.env.PLANNED_KAS)
            && Number(process.env.SEEDED_SWM_KAS) === Number(process.env.PLANNED_SWM_KAS)
            && Number(process.env.SEEDED_VM_KAS) === Number(process.env.PLANNED_VM_KAS)
            && Number(process.env.SEEDED_ROOT_KAS) === Number(process.env.ROOT_KAS)
            && Number(process.env.SEEDED_SUB_KAS) === Number(process.env.SUB_KAS)
            && Number(process.env.SEEDED_TRIPLES) === Number(process.env.TOTAL_TRIPLES_ENV),
        },
        integrity: {
          curatorVerifiedKAs: Number(process.env.CURATOR_INTEGRITY),
          recoveredJoinerVerifiedKAs: Number(process.env.JOINER_INTEGRITY),
          postRestartJoinerVerifiedKAs: Number(process.env.POST_RESTART_INTEGRITY),
          complete: process.env.EXPECT !== "fixed" || (
            Number(process.env.CURATOR_INTEGRITY) === Number(process.env.PLANNED_KAS)
            && Number(process.env.JOINER_INTEGRITY) === Number(process.env.PLANNED_KAS)
            && Number(process.env.POST_RESTART_INTEGRITY) === Number(process.env.PLANNED_KAS)
            && (process.env.VM_MODE !== "async-all" || (
              Number(process.env.SWM_CURATOR_INTEGRITY) === Number(process.env.PLANNED_SWM_KAS)
              && Number(process.env.SWM_JOINER_INTEGRITY) === Number(process.env.PLANNED_SWM_KAS)
              && Number(process.env.SWM_POST_RESTART_INTEGRITY) === Number(process.env.PLANNED_SWM_KAS)
              && Number(process.env.VM_CURATOR_INTEGRITY) === Number(process.env.PLANNED_VM_KAS)
              && Number(process.env.VM_JOINER_INTEGRITY) === Number(process.env.PLANNED_VM_KAS)
              && Number(process.env.VM_POST_RESTART_INTEGRITY) === Number(process.env.PLANNED_VM_KAS)
            ))
          ),
          swmCohort: {
            plannedKAs: Number(process.env.PLANNED_SWM_KAS),
            rootTriples: Number(process.env.SWM_ROOT_TRIPLES),
            subgraphTriples: Number(process.env.SWM_SUB_TRIPLES),
            curatorVerifiedKAs: Number(process.env.SWM_CURATOR_INTEGRITY),
            recoveredJoinerVerifiedKAs: Number(process.env.SWM_JOINER_INTEGRITY),
            postRestartJoinerVerifiedKAs: Number(process.env.SWM_POST_RESTART_INTEGRITY),
          },
          vmCohort: {
            plannedKAs: Number(process.env.PLANNED_VM_KAS),
            rootTriples: Number(process.env.VM_ROOT_TRIPLES_ENV),
            subgraphTriples: Number(process.env.VM_SUB_TRIPLES_ENV),
            curatorVerifiedKAs: Number(process.env.VM_CURATOR_INTEGRITY),
            recoveredJoinerVerifiedKAs: Number(process.env.VM_JOINER_INTEGRITY),
            postRestartJoinerVerifiedKAs: Number(process.env.VM_POST_RESTART_INTEGRITY),
          },
        },
        vmPublication: {
          mode: process.env.VM_MODE,
          enqueuedKAs: Number(process.env.VM_ENQUEUED),
          finalizedKAs: Number(process.env.VM_FINALIZED),
          failedKAs: Number(process.env.VM_FAILED),
          durationMs: Number(process.env.VM_DURATION_MS),
          successPercent: Number(process.env.PLANNED_VM_KAS) > 0
            ? Math.round((Number(process.env.VM_FINALIZED) / Number(process.env.PLANNED_VM_KAS)) * 10000) / 100
            : 0,
          complete: process.env.VM_MODE !== "async-all"
            || Number(process.env.VM_FINALIZED) === Number(process.env.PLANNED_VM_KAS),
          curatorVerifiedKAs: Number(process.env.VM_CURATOR_INTEGRITY),
          recoveredJoinerVerifiedKAs: Number(process.env.VM_JOINER_INTEGRITY),
          postRestartJoinerVerifiedKAs: Number(process.env.VM_POST_RESTART_INTEGRITY),
        },
        health: {
          sampleRounds: Number(process.env.HEALTH_SAMPLES),
          passed: process.env.HEALTH_PASSED === "1",
        },
        autoApproval: {
          enabled: process.env.ADMISSION === "auto",
          observed: process.env.AUTO_OBSERVED === "1",
          maxMembers: process.env.ADMISSION === "auto" ? Number(process.env.AUTO_MEMBERS) : null,
          maxApprovalsPerHour: process.env.ADMISSION === "auto" ? Number(process.env.AUTO_HOURLY) : null,
        },
        brokenModeRecovery: {
          beforeJoinerRestart: process.env.RECOVERED_BEFORE === "1",
          afterJoinerRestart: process.env.RECOVERED_AFTER === "1",
        },
      }, null, 2));
    ' | sanitize_stream > "$RUN_DIR/summary.json"
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  collect_filtered_logs

  if [ "$JOINER_STOPPED" -eq 1 ]; then
    warn "cleanup: restarting node $JOINER_NODE"
    restart_node "$JOINER_NODE" >/dev/null 2>&1
    wait_node_ready "$JOINER_NODE" 90 || warn "cleanup: node $JOINER_NODE did not become ready"
  fi
  if [ "$CURATOR_STOPPED" -eq 1 ]; then
    warn "cleanup: restarting node $CURATOR_NODE"
    restart_node "$CURATOR_NODE" >/dev/null 2>&1
    wait_node_ready "$CURATOR_NODE" 90 || warn "cleanup: node $CURATOR_NODE did not become ready"
  fi

  write_seed_summary_artifact
  write_summary "$exit_code"
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    for node in $(seq 1 "$NUM_NODES"); do
      host="$(testnet_node_ssh "$node")"
      ssh "${TESTNET_SSH_OPTIONS[@]}" -O exit "$host" >/dev/null 2>&1 || true
    done
  fi
  log "artifacts: $RUN_DIR"
  exit "$exit_code"
}

# Diagnostic/recovery entrypoint: let an operator source the harness helpers
# against an already-created artifact directory without replaying the
# destructive create/publish/restart scenario. This is intentionally checked
# only after every helper has been defined, and before the EXIT trap/test body
# is installed. The caller remains responsible for assigning RUN_DIR,
# manifests, and CG identity before invoking individual verification helpers.
if [ "${HARNESS_LIBRARY_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
trap cleanup EXIT

cd "$REPO_ROOT"

act "Preflight: $HARNESS_TARGET topology and release health"
if [ "$HARNESS_LOAD_PROFILE" = "sync-load" ]; then
  log "load plan: $SWM_PLANNED_KA_COUNT SWM KAs + $VM_PLANNED_KA_COUNT VM-source KAs, each x $LOAD_TRIPLES_PER_KA triples = $TOTAL_TRIPLES unique triples"
else
  log "load plan: smoke profile with $PLANNED_KA_COUNT named KAs and $TOTAL_TRIPLES unique triples"
fi
for command in curl node base64; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done
if [ "$HARNESS_TARGET" = "devnet" ]; then
  [ -x "$DEVNET_SH" ] || fail "missing executable: $DEVNET_SH"
else
  command -v ssh >/dev/null 2>&1 || fail "required command not found: ssh"
fi

SEEN_TESTNET_PEERS=" "
PUBLISHER_PARTICIPANT_AGENTS_JSON='[]'
: > "$RUN_DIR/health-baselines.jsonl"
: > "$RUN_DIR/health-samples.jsonl"
if [ "$HARNESS_TARGET" = "testnet" ]; then
  [ -f "$TESTNET_LOCAL_EDGE_HOME/auth.token" ] \
    || fail "local testnet edge auth token is missing: $TESTNET_LOCAL_EDGE_HOME/auth.token"
  wait_node_ready "$CURATOR_NODE" 15 \
    || fail "local testnet edge is not API-ready at ${TESTNET_LOCAL_EDGE_API_HOST}:${TESTNET_LOCAL_EDGE_API_PORT}"
  LOCAL_EDGE_INITIAL_PID="$(local_edge_daemon_pid || true)"
  [ "$LOCAL_EDGE_INITIAL_PID" -gt 0 ] \
    || fail "local testnet edge daemon.pid is missing or stale"
  LOCAL_EDGE_STATUS="$(api_call "$CURATOR_NODE" GET /api/status)"
  save_artifact "preflight-local-edge-status.json" "$LOCAL_EDGE_STATUS"
  [ "$(json_get "$LOCAL_EDGE_STATUS" nodeRole)" = "edge" ] \
    || fail "local curator is not an edge node: $LOCAL_EDGE_STATUS"
  [ "$(json_get "$LOCAL_EDGE_STATUS" networkConfig)" = "testnet" ] \
    || fail "local edge is not configured for testnet: $LOCAL_EDGE_STATUS"
  LOCAL_EDGE_COMMIT="$(json_get "$LOCAL_EDGE_STATUS" commit)"
  commit_matches "$LOCAL_EDGE_COMMIT" "$TESTNET_EXPECT_COMMIT" \
    || fail "local edge API serves commit '${LOCAL_EDGE_COMMIT:-unknown}', expected $TESTNET_EXPECT_COMMIT"
  [ "$(json_get "$LOCAL_EDGE_STATUS" asyncPublisher.available)" = "true" ] \
    || fail "local edge asynchronous publisher is unavailable: $LOCAL_EDGE_STATUS"
  LOCAL_EDGE_IDENTITY="$(api_call "$CURATOR_NODE" GET /api/agent/identity)"
  LOCAL_EDGE_PEER="$(json_get "$LOCAL_EDGE_IDENTITY" peerId)"
  LOCAL_EDGE_AGENT="$(json_get "$LOCAL_EDGE_IDENTITY" agentAddress)"
  [ -n "$LOCAL_EDGE_PEER" ] && [ -n "$LOCAL_EDGE_AGENT" ] \
    || fail "local edge has no usable agent identity: $LOCAL_EDGE_IDENTITY"
  LOCAL_EDGE_RPC_HEALTH="$(api_call "$CURATOR_NODE" GET /api/chain/rpc-health)"
  [ "$(json_get "$LOCAL_EDGE_RPC_HEALTH" ok)" = "true" ] \
    || fail "local edge chain RPC health is not ready: $LOCAL_EDGE_RPC_HEALTH"
  LOCAL_EDGE_PUBLISHER_STATS="$(api_call "$CURATOR_NODE" GET /api/publisher/stats)"
  LOCAL_EDGE_ACTIVE_PUBLISHER_JOBS="$(printf '%s' "$LOCAL_EDGE_PUBLISHER_STATS" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (!value || typeof value !== "object" || Array.isArray(value)) process.exit(1);
      const active = ["accepted", "claimed", "validated", "broadcast", "included"]
        .reduce((sum, status) => sum + Number(value[status] || 0), 0);
      process.stdout.write(String(active));
    });
  ' 2>/dev/null || true)"
  [[ "$LOCAL_EDGE_ACTIVE_PUBLISHER_JOBS" =~ ^[0-9]+$ ]] \
    || fail "local edge publisher stats are unreadable: $LOCAL_EDGE_PUBLISHER_STATS"
  [ "$LOCAL_EDGE_ACTIVE_PUBLISHER_JOBS" -eq 0 ] \
    || fail "local edge already has $LOCAL_EDGE_ACTIVE_PUBLISHER_JOBS active publisher jobs; wait for that queue before starting the isolated gate"
  PUBLISHER_WALLETS_FILE="$TESTNET_LOCAL_EDGE_HOME/publisher-wallets.json"
  [ -f "$PUBLISHER_WALLETS_FILE" ] \
    || fail "local edge publisher wallet registry is missing: $PUBLISHER_WALLETS_FILE"
  PUBLISHER_PARTICIPANT_AGENTS_JSON="$(node - "$PUBLISHER_WALLETS_FILE" <<'NODE'
const fs = require('node:fs');
const registry = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const wallets = Array.isArray(registry?.wallets) ? registry.wallets : [];
const addresses = wallets.map((wallet, index) => {
  const address = wallet?.address;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`publisher wallet ${index + 1} has no valid EVM address`);
  }
  if (/^0x0{40}$/i.test(address)) {
    throw new Error(`publisher wallet ${index + 1} uses the zero address`);
  }
  return address;
});
if (addresses.length === 0) throw new Error('no publisher wallets are configured');
const unique = new Set(addresses.map((address) => address.toLowerCase()));
if (unique.size !== addresses.length) throw new Error('publisher wallet registry contains duplicate addresses');
process.stdout.write(JSON.stringify(addresses));
NODE
  )" || fail "could not derive on-chain participant agents from the local edge publisher wallets"
  PUBLISHER_PARTICIPANT_AGENT_COUNT="$(printf '%s' "$PUBLISHER_PARTICIPANT_AGENTS_JSON" | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => process.stdout.write(String(JSON.parse(input).length)));
  ')"
  [ "$PUBLISHER_PARTICIPANT_AGENT_COUNT" -le 255 ] \
    || fail "publisher wallets plus the curator exceed the 256-address on-chain participant limit"
  save_artifact "preflight-local-edge-identity.json" "$LOCAL_EDGE_IDENTITY"
  save_artifact "preflight-local-edge-rpc-health.json" "$LOCAL_EDGE_RPC_HEALTH"
  save_artifact "preflight-local-edge-publisher-stats.json" "$LOCAL_EDGE_PUBLISHER_STATS"
  save_artifact "preflight-publisher-participant-agents.json" "$PUBLISHER_PARTICIPANT_AGENTS_JSON"
  SEEN_TESTNET_PEERS="$SEEN_TESTNET_PEERS$LOCAL_EDGE_PEER "
  log "local curator/publisher ready (role=edge, commit=${LOCAL_EDGE_COMMIT:0:8}, publisherWallets=$PUBLISHER_PARTICIPANT_AGENT_COUNT, peer=$LOCAL_EDGE_PEER)"
fi
for node in $(seq 1 "$NUM_NODES"); do
  if [ "$HARNESS_TARGET" = "devnet" ]; then
    [ -f "$(node_dir "$node")/auth.token" ] || fail "node $node auth token is missing under $DEVNET_DIR"
    [ -f "$(node_db "$node")" ] || fail "node $node database is missing: $(node_db "$node")"
  else
    host="$(testnet_node_ssh "$node")"
    [ -n "$host" ] || fail "TESTNET_NODE_${node}_SSH is required"
    [[ "$host" != -* ]] || fail "TESTNET_NODE_${node}_SSH must not begin with '-'"
  fi
  wait_node_ready "$node" 15 || fail "node $node is not API-ready"
  role="$(node_role "$node")"
  expected_role=core
  if [ "$HARNESS_TARGET" = "devnet" ] && [ "$node" -gt 4 ]; then
    expected_role=edge
  fi
  [ "$role" = "$expected_role" ] \
    || fail "node $node role is '$role', expected '$expected_role' for the deterministic topology"
  status="$(api_call "$node" GET /api/status)"
  save_artifact "preflight-node${node}-status.json" "$status"
  peer="$(json_get "$status" peerId)"
  [ -n "$peer" ] || fail "node $node status omitted peerId"
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    [ "$(json_get "$status" networkConfig)" = "testnet" ] \
      || fail "node $node is not configured for testnet: $status"
    [ "$(json_get "$status" hasIdentity)" = "true" ] \
      || fail "node $node has no on-chain identity"
    status_commit="$(json_get "$status" commit)"
    commit_matches "$status_commit" "$TESTNET_EXPECT_COMMIT" \
      || fail "node $node API serves commit '${status_commit:-unknown}', expected $TESTNET_EXPECT_COMMIT"
    [ "$(json_get "$status" updateAvailable)" != "true" ] \
      || fail "node $node still reports an update available"
    latest_commit="$(json_get "$status" latestCommit)"
    if [ -n "$latest_commit" ] && [ "$latest_commit" != "null" ]; then
      commit_matches "$latest_commit" "$TESTNET_EXPECT_COMMIT" \
        || fail "node $node update channel points at $latest_commit, expected $TESTNET_EXPECT_COMMIT"
    fi
    probe="$(testnet_probe_node "$node")" || fail "could not probe testnet node $node over SSH"
    save_artifact "preflight-node${node}-host.json" "$probe"
    NODE_ID="$node" PROBE="$probe" node -e '
      process.stdout.write(JSON.stringify({
        node: Number(process.env.NODE_ID),
        ...JSON.parse(process.env.PROBE),
      }));
    ' >> "$RUN_DIR/health-baselines.jsonl"
    printf '\n' >> "$RUN_DIR/health-baselines.jsonl"
    [ "$(json_get "$probe" serviceActive)" = "active" ] \
      || fail "node $node service is not active: $probe"
    for metric in mainPid workerPid nRestarts oxigraphPid oxigraphWatchdogPid acceptQueue cpuCount \
      oomEvents oomKillEvents oxigraphOomEvents oxigraphOomKillEvents; do
      metric_value="$(json_get "$probe" "$metric")"
      [[ "$metric_value" =~ ^[0-9]+$ ]] \
        || fail "node $node host probe omitted numeric $metric: $probe"
    done
    [ "$(json_get "$probe" mainPid)" -gt 0 ] && [ "$(json_get "$probe" oxigraphPid)" -gt 0 ] \
      && [ "$(json_get "$probe" workerPid)" -gt 0 ] \
      && [ "$(json_get "$probe" oxigraphWatchdogPid)" -gt 0 ] \
      || fail "node $node daemon/Oxigraph processes are not all running: $probe"
    [ "$(json_get "$probe" buildRunning)" = "false" ] \
      || fail "node $node is still building an auto-update: $probe"
    if [ "$node" -eq "$JOINER_NODE" ]; then
      [ "$(json_get "$probe" workerRestartAllowed)" = "true" ] \
        || fail "joiner node $node SSH user cannot signal the supervised daemon worker for $TESTNET_SERVICE"
    fi
    current_commit="$(json_get "$probe" currentCommit)"
    active_git="$(json_get "$probe" activeGit)"
    commit_matches "$current_commit" "$TESTNET_EXPECT_COMMIT" \
      || fail "node $node .current-commit is '${current_commit:-unknown}', expected $TESTNET_EXPECT_COMMIT"
    commit_matches "$active_git" "$TESTNET_EXPECT_COMMIT" \
      || fail "node $node active release is '${active_git:-unknown}', expected $TESTNET_EXPECT_COMMIT"
    accept_queue="$(json_get "$probe" acceptQueue)"
    [[ "$accept_queue" =~ ^[0-9]+$ ]] \
      || fail "node $node peer accept queue is unreadable: $probe"
    [ "$accept_queue" -le "$TESTNET_MAX_ACCEPT_QUEUE" ] \
      || fail "node $node peer accept queue is $accept_queue, above safe threshold $TESTNET_MAX_ACCEPT_QUEUE"
    case "$SEEN_TESTNET_PEERS" in
      *" $peer "*) fail "testnet nodes are not distinct; peer $peer appears more than once" ;;
    esac
    SEEN_TESTNET_PEERS="$SEEN_TESTNET_PEERS$peer "
    log "node $node ready (role=$role, commit=${status_commit:0:8}, queue=$accept_queue, peer=$peer)"
  else
    log "node $node ready (role=$role, peer=$peer)"
  fi
done
record_devnet_log_offsets
sample_node_health preflight
if [ "$HARNESS_TARGET" = "testnet" ]; then
  for round in $(seq 2 "$TESTNET_PREFLIGHT_HEALTH_SAMPLE_ROUNDS"); do
    sleep "$TESTNET_PREFLIGHT_HEALTH_SAMPLE_INTERVAL_S"
    sample_node_health "preflight-$round"
  done
  if ! PREFLIGHT_HEALTH_REPORT="$(audit_testnet_health_samples 2>&1)"; then
    save_artifact "preflight-health-audit.json" "$PREFLIGHT_HEALTH_REPORT"
    fail "testnet preflight detected OOM/restart evidence or sustained queue, memory, or load saturation"
  fi
  save_artifact "preflight-health-audit.json" "$PREFLIGHT_HEALTH_REPORT"
fi

if [ "$HARNESS_TARGET" = "testnet" ]; then
  # Exercise the local-edge request path with a read-only payload larger than
  # Linux's common 128 KiB per-argument ceiling. This catches harness transport
  # regressions before a live run creates its CG and begins the 50-KA seed.
  STREAM_PROBE_BODY="$(node -e '
    process.stdout.write(JSON.stringify({
      sparql: "SELECT (1 AS ?n) WHERE {}",
      padding: "x".repeat(300000),
    }));
  ')"
  STREAM_PROBE_BYTES="$(printf '%s' "$STREAM_PROBE_BODY" | wc -c | tr -d '[:space:]')"
  STREAM_PROBE_RESPONSE="$(api_call "$CURATOR_NODE" POST /api/query "$STREAM_PROBE_BODY")"
  [ "$(sparql_count "$STREAM_PROBE_RESPONSE")" = "1" ] \
    || fail "large streamed-body query probe failed: $STREAM_PROBE_RESPONSE"
  save_artifact "preflight-streamed-body-probe.json" "$STREAM_PROBE_RESPONSE"
  log "local-edge large request-body transport ready (read-only ${STREAM_PROBE_BYTES}-byte probe passed)"
fi

PACKAGE_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
{
  echo "gitCommit=$(git rev-parse HEAD 2>/dev/null || true)"
  echo "gitDescribe=$(git describe --tags --always --dirty 2>/dev/null || true)"
  echo "packageVersion=$PACKAGE_VERSION"
  echo "harnessTarget=$HARNESS_TARGET"
  echo "testnetExpectedCommit=$TESTNET_EXPECT_COMMIT"
  echo "testnetCuratorMode=local-edge"
  echo "testnetLocalEdgeHome=$TESTNET_LOCAL_EDGE_HOME"
  echo "testnetLocalEdgeApi=${TESTNET_LOCAL_EDGE_API_HOST}:${TESTNET_LOCAL_EDGE_API_PORT}"
  echo "devnetDir=$DEVNET_DIR"
  echo "apiPortBase=$API_PORT_BASE"
  echo "admissionMode=$ADMISSION_MODE"
  echo "loadProfile=$HARNESS_LOAD_PROFILE"
  echo "plannedKaCount=$PLANNED_KA_COUNT"
  echo "plannedSwmKaCount=$SWM_PLANNED_KA_COUNT"
  echo "plannedVmKaCount=$VM_PLANNED_KA_COUNT"
  echo "triplesPerKa=$([ "$HARNESS_LOAD_PROFILE" = "sync-load" ] && printf '%s' "$LOAD_TRIPLES_PER_KA" || printf 'varied')"
  echo "rootKaCount=$ROOT_KA_COUNT"
  echo "subgraphKaCount=$SUB_GRAPH_KA_COUNT"
  echo "seedRootTriples=$SEED_ROOT_TRIPLES"
  echo "seedSubgraphTriples=$SEED_SUB_GRAPH_TRIPLES"
  echo "finalSwmRootTriples=$ROOT_TRIPLES"
  echo "finalSwmSubgraphTriples=$SUB_GRAPH_TRIPLES"
  echo "finalVmRootTriples=$VM_ROOT_TRIPLES"
  echo "finalVmSubgraphTriples=$VM_SUB_GRAPH_TRIPLES"
  echo "totalTriples=$TOTAL_TRIPLES"
  echo "apiTimeoutSeconds=$API_TIMEOUT_S"
  echo "recoveryTimeoutSeconds=$RECOVERY_TIMEOUT_S"
  echo "postRestartTimeoutSeconds=$POST_RESTART_TIMEOUT_S"
  echo "recoveryExactRecheckIntervalSeconds=$RECOVERY_EXACT_RECHECK_INTERVAL_S"
  echo "catchupTimeoutSeconds=$CATCHUP_TIMEOUT_S"
  echo "vmPublishMode=$VM_PUBLISH_MODE"
  echo "vmPublishTimeoutSeconds=$VM_PUBLISH_TIMEOUT_S"
  echo "vmPublishPollIntervalSeconds=$VM_PUBLISH_POLL_INTERVAL_S"
  echo "integrityProgressEveryKas=$INTEGRITY_PROGRESS_EVERY_KAS"
  echo "healthSampleEveryKas=$HEALTH_SAMPLE_EVERY_KAS"
  echo "healthSampleIntervalSeconds=$HEALTH_SAMPLE_INTERVAL_S"
  echo "testnetMaxAcceptQueue=$TESTNET_MAX_ACCEPT_QUEUE"
  echo "testnetMaxMemoryUsedPercent=$TESTNET_MAX_MEMORY_USED_PERCENT"
  echo "testnetMaxLoadPerCpuPercent=$TESTNET_MAX_LOAD_PER_CPU_PERCENT"
  echo "testnetSaturationConsecutiveSamples=$TESTNET_SATURATION_CONSECUTIVE_SAMPLES"
  echo "testnetPreflightHealthSampleRounds=$TESTNET_PREFLIGHT_HEALTH_SAMPLE_ROUNDS"
  echo "testnetPreflightHealthSampleIntervalSeconds=$TESTNET_PREFLIGHT_HEALTH_SAMPLE_INTERVAL_S"
  echo "autoMaxMembers=$AUTO_MAX_MEMBERS"
  echo "autoMaxApprovalsPerHour=$AUTO_MAX_APPROVALS_PER_HOUR"
} > "$RUN_DIR/runtime.txt"

if [ "$HARNESS_TARGET" = "testnet" ] && [ "$TESTNET_PREFLIGHT_ONLY" = "1" ]; then
  log "PASS (testnet preflight only): the local edge and all four cores are healthy on $TESTNET_EXPECT_COMMIT; planned load is $PLANNED_KA_COUNT KAs / $TOTAL_TRIPLES triples; no state was changed."
  exit 0
fi

CURATOR_IDENTITY="$(api_call "$CURATOR_NODE" GET /api/agent/identity)"
JOINER_IDENTITY="$(api_call "$JOINER_NODE" GET /api/agent/identity)"
CURATOR_AGENT="$(json_get "$CURATOR_IDENTITY" agentAddress)"
CURATOR_PEER="$(json_get "$CURATOR_IDENTITY" peerId)"
JOINER_AGENT="$(json_get "$JOINER_IDENTITY" agentAddress)"
JOINER_PEER="$(json_get "$JOINER_IDENTITY" peerId)"
[ -n "$CURATOR_AGENT" ] && [ -n "$CURATOR_PEER" ] \
  || fail "could not resolve node $CURATOR_NODE curator identity"
[ -n "$JOINER_AGENT" ] && [ -n "$JOINER_PEER" ] \
  || fail "could not resolve node $JOINER_NODE joiner identity"
save_artifact "curator-identity.json" "$CURATOR_IDENTITY"
save_artifact "joiner-identity.json" "$JOINER_IDENTITY"
log "curator: node $CURATOR_NODE agent=$CURATOR_AGENT peer=$CURATOR_PEER"
log "joiner:  node $JOINER_NODE agent=$JOINER_AGENT peer=$JOINER_PEER"

STAMP="$(date -u +%s)"
CG_ID="${CURATOR_AGENT}/private-cg-recovery-${STAMP}-$$"
CG_ENCODED="$(urlencode "$CG_ID")"

act "Create a private CG with curator-only data access and open operational-wallet publishing"
CREATE_BODY="$(CG="$CG_ID" CURATOR="$CURATOR_AGENT" RUN="$RUN_ID" \
  PUBLISHERS="$PUBLISHER_PARTICIPANT_AGENTS_JSON" node -e '
  process.stdout.write(JSON.stringify({
    id: process.env.CG,
    name: `private-cg-recovery ${process.env.RUN}`,
    description: "Private CG membership recovery harness",
    accessPolicy: 1,
    // Publishing authority and private data membership are separate axes.
    // The async operational wallets are not DKG agents and therefore have no
    // encryption keys; adding them as participantAgents makes SWM encryption
    // treat them as recipients. Open publishing lets the configured signer
    // pool submit the VM cohort while allowedAgents remains curator-only.
    publishPolicy: 1,
    allowedAgents: [process.env.CURATOR],
    participantAgents: [],
    register: true,
  }));
')"
CREATE_RESPONSE="$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$CREATE_BODY")"
ON_CHAIN_ID="$(json_get "$CREATE_RESPONSE" onChainId)"
[ -n "$ON_CHAIN_ID" ] && [ "$ON_CHAIN_ID" != "null" ] \
  || fail "curated CG create/register failed: $CREATE_RESPONSE"
save_artifact "create-response.json" "$CREATE_RESPONSE"
log "created $CG_ID (onChainId=$ON_CHAIN_ID)"

if [ "$ADMISSION_MODE" = "auto" ]; then
  act "Enable bounded open enrollment before the curator restart"
  OPEN_POLICY_BODY="$(MODE=open MAX_MEMBERS="$AUTO_MAX_MEMBERS" MAX_HOURLY="$AUTO_MAX_APPROVALS_PER_HOUR" node -e '
    process.stdout.write(JSON.stringify({
      mode: process.env.MODE,
      maxMembers: Number(process.env.MAX_MEMBERS),
      maxApprovalsPerHour: Number(process.env.MAX_HOURLY),
      acknowledgeOpenEnrollment: true,
    }));
  ')"
  OPEN_POLICY_RESPONSE="$(api_call "$CURATOR_NODE" PUT "/api/context-graph/$CG_ENCODED/join-policy" "$OPEN_POLICY_BODY" 2>/dev/null || true)"
  save_artifact "join-policy-enable-response.json" "$OPEN_POLICY_RESPONSE"
  assert_open_join_policy "$OPEN_POLICY_RESPONSE" "open-enrollment enable response"

  OPEN_POLICY_STATUS="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-policy" 2>/dev/null || true)"
  save_artifact "join-policy-before-curator-restart.json" "$OPEN_POLICY_STATUS"
  assert_open_join_policy "$OPEN_POLICY_STATUS" "open-enrollment status before curator restart"
  log "open enrollment enabled: maxMembers=$AUTO_MAX_MEMBERS maxApprovalsPerHour=$AUTO_MAX_APPROVALS_PER_HOUR"
fi

SUBGRAPH_RESPONSE="$(api_call "$CURATOR_NODE" POST /api/sub-graph/create \
  "$(CG="$CG_ID" SUB="$SUB_GRAPH_NAME" node -e 'process.stdout.write(JSON.stringify({contextGraphId:process.env.CG,subGraphName:process.env.SUB}))')")"
[ "$(json_get "$SUBGRAPH_RESPONSE" created)" = "$SUB_GRAPH_NAME" ] \
  || fail "sub-graph create failed: $SUBGRAPH_RESPONSE"
save_artifact "subgraph-create-response.json" "$SUBGRAPH_RESPONSE"

act "Seed $PLANNED_KA_COUNT named KAs / $TOTAL_TRIPLES unique SWM triples"
if [ "$HARNESS_LOAD_PROFILE" = "sync-load" ]; then
  for ordinal in $(seq 1 "$PLANNED_KA_COUNT"); do
    if [ "$ordinal" -le "$VM_PLANNED_KA_COUNT" ]; then
      cohort=vm
      cohort_ordinal="$ordinal"
    else
      cohort=swm
      cohort_ordinal=$((ordinal - VM_PLANNED_KA_COUNT))
    fi
    if [ $((cohort_ordinal % 2)) -eq 1 ]; then
      lane=root
    else
      lane=subgraph
    fi
    printf -v label '%s-%s-ka-%03d' "$cohort" "$lane" "$cohort_ordinal"
    seed_named_ka "$ordinal" "$cohort" "$lane" "$LOAD_TRIPLES_PER_KA" "$label"
  done
else
  seed_named_ka 1 swm root "$ROOT_TRIPLES" root
  ROOT_WRITE="$LAST_SEED_WRITE"
  seed_named_ka 2 swm subgraph "$SUB_GRAPH_TRIPLES" sub
  SUB_WRITE="$LAST_SEED_WRITE"
  # Preserve the original smoke-profile artifact names for existing consumers.
  save_artifact "root-write-summary.json" "$ROOT_WRITE"
  save_artifact "subgraph-write-summary.json" "$SUB_WRITE"
fi

[ "$SEEDED_KA_COUNT" = "$PLANNED_KA_COUNT" ] \
  || fail "seeded $SEEDED_KA_COUNT KAs, expected $PLANNED_KA_COUNT"
[ "$SEEDED_SWM_KA_COUNT" = "$SWM_PLANNED_KA_COUNT" ] \
  || fail "seeded $SEEDED_SWM_KA_COUNT SWM-cohort KAs, expected $SWM_PLANNED_KA_COUNT"
[ "$SEEDED_VM_SOURCE_KA_COUNT" = "$VM_PLANNED_KA_COUNT" ] \
  || fail "seeded $SEEDED_VM_SOURCE_KA_COUNT VM-source KAs, expected $VM_PLANNED_KA_COUNT"
[ "$SEEDED_ROOT_KA_COUNT" = "$ROOT_KA_COUNT" ] \
  || fail "seeded $SEEDED_ROOT_KA_COUNT root KAs, expected $ROOT_KA_COUNT"
[ "$SEEDED_SUB_GRAPH_KA_COUNT" = "$SUB_GRAPH_KA_COUNT" ] \
  || fail "seeded $SEEDED_SUB_GRAPH_KA_COUNT sub-graph KAs, expected $SUB_GRAPH_KA_COUNT"
[ "$SEEDED_TRIPLE_COUNT" = "$TOTAL_TRIPLES" ] \
  || fail "seeded $SEEDED_TRIPLE_COUNT triples, expected $TOTAL_TRIPLES"
MANIFEST_ROWS="$(wc -l < "$SEED_MANIFEST" | tr -d '[:space:]')"
[ "$MANIFEST_ROWS" = "$PLANNED_KA_COUNT" ] \
  || fail "seed manifest contains $MANIFEST_ROWS rows, expected $PLANNED_KA_COUNT"
[ "$(wc -l < "$SWM_MANIFEST" | tr -d '[:space:]')" = "$SWM_PLANNED_KA_COUNT" ] \
  || fail "SWM cohort manifest is incomplete"
[ "$(wc -l < "$VM_SOURCE_MANIFEST" | tr -d '[:space:]')" = "$VM_PLANNED_KA_COUNT" ] \
  || fail "VM-source cohort manifest is incomplete"
write_seed_summary_artifact

CURATOR_ROOT="$(root_count "$CURATOR_NODE")"
CURATOR_SUB="$(subgraph_count "$CURATOR_NODE")"
CURATOR_KAS="$(knowledge_asset_count "$CURATOR_NODE")"
[ "$CURATOR_ROOT" = "$SEED_ROOT_TRIPLES" ] \
  || fail "curator seeded root SWM count is '$CURATOR_ROOT', expected $SEED_ROOT_TRIPLES"
[ "$CURATOR_SUB" = "$SEED_SUB_GRAPH_TRIPLES" ] \
  || fail "curator seeded sub-graph SWM count is '$CURATOR_SUB', expected $SEED_SUB_GRAPH_TRIPLES"
[ "$CURATOR_KAS" = "$PLANNED_KA_COUNT" ] \
  || fail "curator metadata contains $CURATOR_KAS named KAs, expected $PLANNED_KA_COUNT"
log "curator seed verified: KAs=$CURATOR_KAS (SWM cohort=$SWM_PLANNED_KA_COUNT, VM-source cohort=$VM_PLANNED_KA_COUNT) triples=$SEEDED_TRIPLE_COUNT root=$CURATOR_ROOT subgraph=$CURATOR_SUB payloadBytes=$SEED_PAYLOAD_BYTES"
if [ "$HARNESS_EXPECT" = "fixed" ]; then
  act "Verify every curator SWM head and exact per-KA assertion graph"
  verify_manifest_on_node "$CURATOR_NODE" curator-seed "$SEED_MANIFEST" "$PLANNED_KA_COUNT"
fi

if [ "$VM_PUBLISH_MODE" = "async-all" ]; then
  act "Publish the $VM_PLANNED_KA_COUNT VM-source KAs through the local edge queue"
  publish_seed_manifest_to_vm
  CURATOR_ROOT_AFTER_VM="$(root_count "$CURATOR_NODE")"
  CURATOR_SUB_AFTER_VM="$(subgraph_count "$CURATOR_NODE")"
  CURATOR_ROOT_VM="$(root_vm_count "$CURATOR_NODE")"
  CURATOR_SUB_VM="$(subgraph_vm_count "$CURATOR_NODE")"
  [ "$CURATOR_ROOT_AFTER_VM" = "$ROOT_TRIPLES" ] \
    || fail "VM publication did not leave exactly the unpublished root SWM cohort: got $CURATOR_ROOT_AFTER_VM, expected $ROOT_TRIPLES"
  [ "$CURATOR_SUB_AFTER_VM" = "$SUB_GRAPH_TRIPLES" ] \
    || fail "VM publication did not leave exactly the unpublished sub-graph SWM cohort: got $CURATOR_SUB_AFTER_VM, expected $SUB_GRAPH_TRIPLES"
  [ "$CURATOR_ROOT_VM" = "$VM_ROOT_TRIPLES" ] \
    || fail "curator root VM count is '$CURATOR_ROOT_VM', expected $VM_ROOT_TRIPLES"
  [ "$CURATOR_SUB_VM" = "$VM_SUB_GRAPH_TRIPLES" ] \
    || fail "curator sub-graph VM count is '$CURATOR_SUB_VM', expected $VM_SUB_GRAPH_TRIPLES"
  act "Verify the curator's unpublished SWM cohort and finalized VM cohort independently"
  verify_manifest_on_node "$CURATOR_NODE" curator-swm "$SWM_MANIFEST" "$SWM_PLANNED_KA_COUNT"
  verify_vm_manifest_on_node "$CURATOR_NODE" curator-vm
  log "curator SWM+VM verified: SWM=$SWM_PLANNED_KA_COUNT KAs/$SWM_TOTAL_TRIPLES triples, VM=$VM_FINALIZED_KA_COUNT KAs/$VM_TOTAL_TRIPLES triples"
fi

act "Prove unrelated nodes ($UNRELATED_NODES) and joiner $JOINER_NODE do not already hold the private CG"
for node in $UNRELATED_NODES "$JOINER_NODE"; do
  exists="$(context_graph_exists "$node")"
  root="$(root_count "$node")"
  sub="$(subgraph_count "$node")"
  root_vm="$(root_vm_count "$node")"
  sub_vm="$(subgraph_vm_count "$node")"
  meta="$(meta_count "$node")"
  [ "$exists" = "false" ] \
    || fail "node $node already reports contextGraphExists=$exists for the private CG; empty-peer precondition is invalid"
  if ! count_is_absent "$root" || ! count_is_absent "$sub" \
    || ! count_is_absent "$root_vm" || ! count_is_absent "$sub_vm" \
    || ! count_is_absent "$meta"; then
    fail "node $node already has private-CG material (rootSwm=${root:-unreadable} subSwm=${sub:-unreadable} rootVm=${root_vm:-unreadable} subVm=${sub_vm:-unreadable} meta=${meta:-unreadable})"
  fi
  log "node $node is unrelated: exists=false rootSwm=0 subgraphSwm=0 rootVm=0 subgraphVm=0 meta=0"
done

act "Stop curator node $CURATOR_NODE"
if is_local_testnet_edge "$CURATOR_NODE"; then
  LOCAL_EDGE_PID_BEFORE_STOP="$(local_edge_daemon_pid || true)"
  [ "$LOCAL_EDGE_PID_BEFORE_STOP" = "$LOCAL_EDGE_INITIAL_PID" ] \
    || fail "local edge daemon changed PID before the planned restart (initial=$LOCAL_EDGE_INITIAL_PID current=${LOCAL_EDGE_PID_BEFORE_STOP:-missing})"
fi
CURATOR_STOPPED=1
stop_node "$CURATOR_NODE"
wait_node_down "$CURATOR_NODE" 45 \
  || fail "curator node $CURATOR_NODE did not become unreachable"
log "curator is offline; unrelated core peers remain online"

act "Joiner subscribes before admission while curator is offline"
SUBSCRIBE_RESPONSE="$(api_call "$JOINER_NODE" POST /api/context-graph/subscribe \
  "$(CG="$CG_ID" node -e 'process.stdout.write(JSON.stringify({contextGraphId:process.env.CG,includeSharedMemory:true}))')")"
[ "$(json_get "$SUBSCRIBE_RESPONSE" subscribed)" = "$CG_ID" ] \
  || fail "joiner subscribe failed: $SUBSCRIBE_RESPONSE"
save_artifact "pre-admission-subscribe-response.json" "$SUBSCRIBE_RESPONSE"

CATCHUP_RESPONSE="$(poll_catchup_terminal)" \
  || fail "pre-admission catch-up did not reach a terminal state within ${CATCHUP_TIMEOUT_S}s"
save_artifact "pre-admission-catchup-terminal.json" "$CATCHUP_RESPONSE"
CATCHUP_STATE="$(json_get "$CATCHUP_RESPONSE" status)"
EMPTY_RESPONSES="$(json_empty_response_count "$CATCHUP_RESPONSE")"
INSERTED_TRIPLES="$(json_inserted_triple_count "$CATCHUP_RESPONSE")"
RESULT_DATA_SYNCED="$(json_get "$CATCHUP_RESPONSE" result.dataSynced)"
RESULT_SWM_SYNCED="$(json_get "$CATCHUP_RESPONSE" result.sharedMemorySynced)"
SYNC_CAPABLE_PEERS="$(json_get "$CATCHUP_RESPONSE" result.syncCapablePeers)"
PEERS_RESPONDED="$(json_get "$CATCHUP_RESPONSE" result.peersResponded)"
DURABLE_EMPTY_PEERS="$(json_get "$CATCHUP_RESPONSE" result.cleanPlaneCompletions.durable.emptyPeers)"
SHARED_MEMORY_EMPTY_PEERS="$(json_get "$CATCHUP_RESPONSE" result.cleanPlaneCompletions.sharedMemory.emptyPeers)"
[ -n "$PEERS_RESPONDED" ] && [ "$PEERS_RESPONDED" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
  || fail "catch-up received replies from only ${PEERS_RESPONDED:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
[ -n "$DURABLE_EMPTY_PEERS" ] && [ "$DURABLE_EMPTY_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
  || fail "durable catch-up completed empty with only ${DURABLE_EMPTY_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
if [ "$HARNESS_EXPECT" = "broken" ]; then
  [ -n "$SHARED_MEMORY_EMPTY_PEERS" ] && [ "$SHARED_MEMORY_EMPTY_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
    || fail "shared-memory catch-up completed empty with only ${SHARED_MEMORY_EMPTY_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
else
  # A fixed node may fail closed as soon as durable sync proves that no peer
  # has authoritative metadata. In that stricter path shared-memory sync has
  # no authorized graph plan to execute, so zero shared-memory responses is
  # expected. Older fixed builds may still complete the plane against all four
  # unrelated peers; reject only a partial plane completion.
  [ "$SHARED_MEMORY_EMPTY_PEERS" = "0" ] \
    || { [ -n "$SHARED_MEMORY_EMPTY_PEERS" ] && [ "$SHARED_MEMORY_EMPTY_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null; } \
    || fail "shared-memory catch-up partially completed with ${SHARED_MEMORY_EMPTY_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
fi
[ -n "$SYNC_CAPABLE_PEERS" ] && [ "$SYNC_CAPABLE_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
  || fail "catch-up reached only ${SYNC_CAPABLE_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS sync-capable unrelated peers: $CATCHUP_RESPONSE"
[ "$INSERTED_TRIPLES" = "0" ] \
  && [ "$RESULT_DATA_SYNCED" = "0" ] \
  && [ "$RESULT_SWM_SYNCED" = "0" ] \
  || fail "pre-admission catch-up unexpectedly inserted private-CG material: $CATCHUP_RESPONSE"

SUB_ROW="$(wait_subscription_row 20)" \
  || fail "joiner subscription row was not persisted"
ROOT_BEFORE="$(root_count "$JOINER_NODE")"
SUB_BEFORE="$(subgraph_count "$JOINER_NODE")"
ROOT_VM_BEFORE="$(root_vm_count "$JOINER_NODE")"
SUB_VM_BEFORE="$(subgraph_vm_count "$JOINER_NODE")"
META_BEFORE="$(meta_count "$JOINER_NODE")"
if ! count_is_absent "$ROOT_BEFORE" || ! count_is_absent "$SUB_BEFORE" \
  || ! count_is_absent "$ROOT_VM_BEFORE" || ! count_is_absent "$SUB_VM_BEFORE" \
  || ! count_is_absent "$META_BEFORE"; then
  fail "pre-admission joiner unexpectedly holds CG material (rootSwm=${ROOT_BEFORE:-unreadable} subSwm=${SUB_BEFORE:-unreadable} rootVm=${ROOT_VM_BEFORE:-unreadable} subVm=${SUB_VM_BEFORE:-unreadable} meta=${META_BEFORE:-unreadable})"
fi

SUBSCRIBED_FLAG="$(json_get "$SUB_ROW" subscribed)"
SYNCED_FLAG="$(json_get "$SUB_ROW" synced)"
SHARED_FLAG="$(json_get "$SUB_ROW" shared_memory_synced)"
META_FLAG="$(json_get "$SUB_ROW" meta_synced)"
[ "$SUBSCRIBED_FLAG" = "1" ] || fail "subscription row is not active: $SUB_ROW"

if [ "$HARNESS_EXPECT" = "broken" ]; then
  [ "$CATCHUP_STATE" = "done" ] \
    || fail "broken oracle expected catch-up status=done, got '$CATCHUP_STATE'"
  [ "$SYNCED_FLAG" = "1" ] && [ "$SHARED_FLAG" = "1" ] && [ "$META_FLAG" != "1" ] \
    || fail "broken oracle not observed; expected synced=1 shared_memory_synced=1 meta_synced!=1, got $SUB_ROW"
  log "RED ORACLE OBSERVED: status=done syncCapablePeers=$SYNC_CAPABLE_PEERS emptyResponses=$EMPTY_RESPONSES synced=1 shared=1 meta=${META_FLAG:-null}, with no metadata or data"
else
  [ "$SYNCED_FLAG" != "1" ] && [ "$SHARED_FLAG" != "1" ] && [ "$META_FLAG" != "1" ] \
    || fail "fixed oracle violated: pre-admission state claims readiness: $SUB_ROW"
  log "GREEN PRECONDITION: syncCapablePeers=$SYNC_CAPABLE_PEERS emptyResponses=$EMPTY_RESPONSES but subscription remains pending/not-ready"
fi
snapshot_phase pre-admission

act "Restart curator and deliver a signed admission request"
restart_node "$CURATOR_NODE"
wait_node_ready "$CURATOR_NODE" 90 \
  || fail "curator node $CURATOR_NODE did not become ready after restart"
CURATOR_STOPPED=0
if is_local_testnet_edge "$CURATOR_NODE"; then
  LOCAL_EDGE_RESTARTED_PID="$(local_edge_daemon_pid || true)"
  [ "$LOCAL_EDGE_RESTARTED_PID" -gt 0 ] && [ "$LOCAL_EDGE_RESTARTED_PID" != "$LOCAL_EDGE_INITIAL_PID" ] \
    || fail "local edge did not acquire a fresh live PID after its planned restart"
fi

if [ "$ADMISSION_MODE" = "auto" ]; then
  OPEN_POLICY_AFTER_RESTART="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-policy" 2>/dev/null || true)"
  save_artifact "join-policy-after-curator-restart.json" "$OPEN_POLICY_AFTER_RESTART"
  assert_open_join_policy "$OPEN_POLICY_AFTER_RESTART" "open-enrollment status after curator restart"
  log "persisted open-enrollment policy survived the curator restart"
fi

SIGN_RESPONSE="$(api_call "$JOINER_NODE" POST "/api/context-graph/$CG_ENCODED/sign-join" '{}')"
[ "$(json_get "$SIGN_RESPONSE" ok)" = "true" ] \
  || fail "sign-join failed: $(json_get "$SIGN_RESPONSE" error)"
DELEGATION="$(json_get "$SIGN_RESPONSE" delegation)"
[ -n "$DELEGATION" ] && [ "$DELEGATION" != "null" ] \
  || fail "sign-join returned no delegation"
EXPECTED_DELEGATION_AGENT="$(json_get "$DELEGATION" agentAddress)"
EXPECTED_DELEGATION_PEER="$(json_get "$DELEGATION" delegateePeerId)"
EXPECTED_DELEGATION_OP_KEY="$(json_get "$DELEGATION" delegateeOpKey)"
EXPECTED_DELEGATION_SCOPE="$(json_get "$DELEGATION" scope)"
EXPECTED_DELEGATION_ISSUED_AT="$(json_get "$DELEGATION" issuedAtMs)"
EXPECTED_DELEGATION_EXPIRES_AT="$(json_get "$DELEGATION" expiresAtMs)"
EXPECTED_DELEGATION_AGENT_LOWER="$(printf '%s' "$EXPECTED_DELEGATION_AGENT" | tr '[:upper:]' '[:lower:]')"
EXPECTED_DELEGATION_OP_KEY_LOWER="$(printf '%s' "$EXPECTED_DELEGATION_OP_KEY" | tr '[:upper:]' '[:lower:]')"
JOINER_AGENT_LOWER="$(printf '%s' "$JOINER_AGENT" | tr '[:upper:]' '[:lower:]')"
[ "$EXPECTED_DELEGATION_AGENT_LOWER" = "$JOINER_AGENT_LOWER" ] \
  || fail "signed delegation agent does not match the joining member: $DELEGATION"
[ "$EXPECTED_DELEGATION_PEER" = "$JOINER_PEER" ] \
  || fail "signed delegation peer does not match the joining node: $DELEGATION"
[[ "$EXPECTED_DELEGATION_OP_KEY_LOWER" =~ ^0x[[:xdigit:]]{40}$ ]] \
  || fail "signed delegation has no valid operational delegatee key: $DELEGATION"
[ "$(SCOPE="$EXPECTED_DELEGATION_SCOPE" CG="$CG_ID" node -e '
  const scope = process.env.SCOPE || "";
  const cg = process.env.CG || "";
  process.stdout.write(scope.startsWith("sync:deployment=") && scope.endsWith(`:${cg}`) ? "1" : "0");
')" = "1" ] || fail "signed delegation scope is not bound to this deployment and context graph: $DELEGATION"
[[ "$EXPECTED_DELEGATION_ISSUED_AT" =~ ^[0-9]+$ ]] \
  && [[ "$EXPECTED_DELEGATION_EXPIRES_AT" =~ ^[0-9]+$ ]] \
  && [ "$EXPECTED_DELEGATION_EXPIRES_AT" -gt "$EXPECTED_DELEGATION_ISSUED_AT" ] \
  && [ "$EXPECTED_DELEGATION_EXPIRES_AT" -gt "$(node -e 'process.stdout.write(String(Date.now()))')" ] \
  || fail "signed delegation has an invalid or expired validity window: $DELEGATION"

REQUEST_BODY="$(DELEGATION="$DELEGATION" CURATOR_PEER_ENV="$CURATOR_PEER" node -e '
  process.stdout.write(JSON.stringify({
    delegation: JSON.parse(process.env.DELEGATION),
    curatorPeerId: process.env.CURATOR_PEER_ENV,
    agentName: "private-cg-recovery-harness",
  }));
')"

REQUEST_RESPONSE=""
REQUEST_STATUS=""
REQUEST_START="$(date +%s)"
while [ $(( $(date +%s) - REQUEST_START )) -lt "$JOIN_DELIVERY_TIMEOUT_S" ]; do
  REQUEST_RESPONSE="$(api_call "$JOINER_NODE" POST "/api/context-graph/$CG_ENCODED/request-join" "$REQUEST_BODY" 2>/dev/null || true)"
  REQUEST_STATUS="$(json_get "$REQUEST_RESPONSE" status)"
  case "$REQUEST_STATUS" in
    approved|already-member) break ;;
    pending)
      # Manual admission is expected to stop at pending. Open enrollment can
      # transiently return pending after a curator restart until the joiner's
      # active encryption key has propagated again, so keep retrying the same
      # signed request within the bounded delivery window.
      [ "$ADMISSION_MODE" = "manual" ] && break
      ;;
  esac
  sleep 3
done
save_artifact "join-request-response.json" "$REQUEST_RESPONSE"

if [ "$ADMISSION_MODE" = "manual" ]; then
  [ "$REQUEST_STATUS" = "pending" ] \
    || fail "join request was not delivered as pending within ${JOIN_DELIVERY_TIMEOUT_S}s: $REQUEST_RESPONSE"

  PENDING_FOUND=0
  PENDING_RESPONSE=""
  PENDING_START="$(date +%s)"
  while [ $(( $(date +%s) - PENDING_START )) -lt "$JOIN_DELIVERY_TIMEOUT_S" ]; do
    PENDING_RESPONSE="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-requests" 2>/dev/null || true)"
    PENDING_FOUND="$(join_request_present "$PENDING_RESPONSE" "$JOINER_AGENT")"
    [ "$PENDING_FOUND" = "1" ] && break
    sleep 2
  done
  save_artifact "curator-pending-join-requests.json" "$PENDING_RESPONSE"
  [ "$PENDING_FOUND" = "1" ] \
    || fail "curator never exposed the joiner's pending request"

  APPROVE_RESPONSE="$(api_call "$CURATOR_NODE" POST "/api/context-graph/$CG_ENCODED/approve-join" \
    "$(AGENT="$JOINER_AGENT" node -e 'process.stdout.write(JSON.stringify({agentAddress:process.env.AGENT}))')")"
  save_artifact "approve-response.json" "$APPROVE_RESPONSE"
  [ "$(json_get "$APPROVE_RESPONSE" status)" = "approved" ] \
    || fail "approve-join failed: $APPROVE_RESPONSE"
  log "curator manually approved $JOINER_AGENT"
else
  [ "$REQUEST_STATUS" = "approved" ] \
    || fail "open enrollment did not automatically approve the join request: $REQUEST_RESPONSE"
  [ "$(json_get "$REQUEST_RESPONSE" autoApproved)" = "true" ] \
    || fail "approved join response did not identify automatic approval: $REQUEST_RESPONSE"
  [ "$(json_get "$REQUEST_RESPONSE" alreadyMember)" = "true" ] \
    || fail "automatic approval response omitted the rolling-upgrade alreadyMember alias: $REQUEST_RESPONSE"
  AUTO_APPROVAL_OBSERVED=1

  PENDING_RESPONSE="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-requests" 2>/dev/null || true)"
  save_artifact "curator-join-requests-after-auto-approval.json" "$PENDING_RESPONSE"
  PENDING_FOUND="$(join_request_present "$PENDING_RESPONSE" "$JOINER_AGENT")"
  [ "$PENDING_FOUND" != "invalid" ] \
    || fail "curator join-request list was unreadable after automatic approval: $PENDING_RESPONSE"
  [ "$PENDING_FOUND" = "0" ] \
    || fail "automatically approved joiner remained in the pending-request list: $PENDING_RESPONSE"

  OPEN_POLICY_AFTER_APPROVAL="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-policy" 2>/dev/null || true)"
  save_artifact "join-policy-after-auto-approval.json" "$OPEN_POLICY_AFTER_APPROVAL"
  assert_open_join_policy "$OPEN_POLICY_AFTER_APPROVAL" "open-enrollment status after automatic approval"
  AUTO_APPROVALS_LAST_HOUR="$(json_get "$OPEN_POLICY_AFTER_APPROVAL" approvalsLastHour)"
  AUTO_MEMBER_COUNT="$(json_get "$OPEN_POLICY_AFTER_APPROVAL" memberCount)"
  [ -n "$AUTO_APPROVALS_LAST_HOUR" ] && [ "$AUTO_APPROVALS_LAST_HOUR" -ge 1 ] 2>/dev/null \
    || fail "automatic approval was not reflected in policy usage: $OPEN_POLICY_AFTER_APPROVAL"
  [ "$AUTO_MEMBER_COUNT" = "2" ] \
    || fail "automatic approval did not produce the expected curator + joiner membership: $OPEN_POLICY_AFTER_APPROVAL"
  log "curator automatically approved $JOINER_AGENT; no manual approve-join call was made"
fi

act "Measure post-approval metadata/data recovery"
if [ "$HARNESS_EXPECT" = "fixed" ]; then
  wait_full_recovery "$RECOVERY_TIMEOUT_S" \
    || { snapshot_phase post-approval-timeout; fail "fixed build did not recover metadata + exact SWM/VM fixtures within ${RECOVERY_TIMEOUT_S}s"; }
  assert_fixed_list_state
  if [ "$VM_PUBLISH_MODE" = "async-all" ]; then
    act "Verify the recovered joiner's SWM and VM cohorts independently"
    verify_manifest_on_node "$JOINER_NODE" joiner-recovered-swm "$SWM_MANIFEST" "$SWM_PLANNED_KA_COUNT"
    verify_vm_manifest_on_node "$JOINER_NODE" joiner-recovered-vm
    JOINER_INTEGRITY_VERIFIED=$((SWM_JOINER_INTEGRITY_VERIFIED + VM_JOINER_INTEGRITY_VERIFIED))
    log "recovered: metadata private+allowlisted+delegated, SWM=$SWM_PLANNED_KA_COUNT KAs/$SWM_TOTAL_TRIPLES triples, VM=$VM_PLANNED_KA_COUNT KAs/$VM_TOTAL_TRIPLES triples"
  else
    act "Verify every recovered joiner SWM head and exact per-KA assertion graph"
    verify_manifest_on_node "$JOINER_NODE" joiner-recovered
    log "recovered: metadata private+allowlisted+delegated, KAs=$PLANNED_KA_COUNT, root=$ROOT_TRIPLES, subgraph=$SUB_GRAPH_TRIPLES"
  fi
else
  if wait_full_recovery "$BROKEN_RECOVERY_OBSERVE_S"; then
    BROKEN_RECOVERED_BEFORE_RESTART=1
    log "v10.0.6 red invariant was observed, but approval subsequently healed the node"
  else
    log "v10.0.6 remains wedged after approval (recorded as part of the red witness)"
  fi
fi
snapshot_phase post-approval

act "Restart joiner node $JOINER_NODE and recheck durable state"
JOINER_STOPPED=1
restart_node "$JOINER_NODE"
wait_node_ready "$JOINER_NODE" 90 \
  || fail "joiner node $JOINER_NODE did not become ready after restart"
JOINER_STOPPED=0

if [ "$HARNESS_EXPECT" = "fixed" ]; then
  reactivate_joiner_subscription_if_dormant
  wait_full_recovery "$POST_RESTART_TIMEOUT_S" \
    || { snapshot_phase post-restart-timeout; fail "fixed state did not survive/recover after joiner restart"; }
  assert_fixed_list_state
  if [ "$VM_PUBLISH_MODE" = "async-all" ]; then
    act "Re-verify the joiner's SWM and VM cohorts after restart"
    verify_manifest_on_node "$JOINER_NODE" joiner-post-restart-swm "$SWM_MANIFEST" "$SWM_PLANNED_KA_COUNT"
    verify_vm_manifest_on_node "$JOINER_NODE" joiner-post-restart-vm
    POST_RESTART_INTEGRITY_VERIFIED=$((SWM_POST_RESTART_INTEGRITY_VERIFIED + VM_POST_RESTART_INTEGRITY_VERIFIED))
  else
    act "Re-verify every joiner SWM head and exact per-KA graph after restart"
    verify_manifest_on_node "$JOINER_NODE" joiner-post-restart
  fi
  log "restart persistence verified"
else
  if wait_full_recovery "$BROKEN_POST_RESTART_OBSERVE_S"; then
    BROKEN_RECOVERED_AFTER_RESTART=1
    log "restart/post-approval reconciliation eventually healed the node; the earlier false-ready red oracle remains proven"
  else
    row_after="$(db_subscription_row "$JOINER_NODE")"
    root_after="$(root_count "$JOINER_NODE")"
    sub_after="$(subgraph_count "$JOINER_NODE")"
    meta_after="$(meta_count "$JOINER_NODE")"
    log "wedge persisted after restart: row=$row_after root=${root_after:-unreadable} sub=${sub_after:-unreadable} meta=${meta_after:-unreadable}"
  fi
fi
snapshot_phase post-restart

if [ "$HARNESS_EXPECT" = "fixed" ]; then
  act "Audit daemon, Oxigraph, OOM, and sustained-saturation health"
  audit_node_health
  log "health gate passed: no crash/OOM evidence and no sustained queue, memory, or load saturation"
fi

echo
if [ "$HARNESS_EXPECT" = "broken" ]; then
  log "PASS (broken oracle, $ADMISSION_MODE approval): the build claimed a private CG was synced without authoritative metadata or data."
else
  if [ "$VM_PUBLISH_MODE" = "async-all" ]; then
    log "PASS (fixed oracle, $ADMISSION_MODE approval): empty unrelated responses never claimed readiness; $PLANNED_KA_COUNT KAs / $TOTAL_TRIPLES triples recovered independently from both SWM and VM and survived restart."
  else
    log "PASS (fixed oracle, $ADMISSION_MODE approval): empty unrelated responses never claimed readiness; $PLANNED_KA_COUNT KAs / $TOTAL_TRIPLES triples recovered and survived restart."
  fi
fi
log "CG: $CG_ID"
log "artifacts: $RUN_DIR"
