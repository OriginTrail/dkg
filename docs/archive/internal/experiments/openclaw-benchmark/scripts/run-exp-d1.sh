#!/usr/bin/env bash
#
# Experiment D1: 4-agent swarm on ONE shared task, using shared Markdown memory.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$EXPERIMENT_DIR/results/exp-d1"
OPENCLAW_DIR="${OPENCLAW_DIR:-/Users/aleatoric/dev/openclaw}"
CLAUDE_RUN="$SCRIPT_DIR/claude-run.mjs"
MD_LOG="$SCRIPT_DIR/collab-md-log.py"
RUN_ID="${RUN_ID:-d1-$(date +%Y%m%d-%H%M%S)}"
SHARED_DIR="$RESULTS_DIR/shared/$RUN_ID"

mkdir -p "$RESULTS_DIR/round1" "$SHARED_DIR"
chmod +x "$MD_LOG"

PLAN_MD="$SHARED_DIR/plan.md"
DECISIONS_MD="$SHARED_DIR/decisions.md"
INTERFACES_MD="$SHARED_DIR/interfaces.md"
HANDOFFS_MD="$SHARED_DIR/handoffs.md"

cat >"$PLAN_MD" <<EOF
# Experiment D1 Shared Plan
runId: $RUN_ID
task: notification-orchestration-subsystem
EOF
cat >"$DECISIONS_MD" <<EOF
# Decisions
runId: $RUN_ID
EOF
cat >"$INTERFACES_MD" <<EOF
# Interfaces
runId: $RUN_ID
EOF
cat >"$HANDOFFS_MD" <<EOF
# Handoffs
runId: $RUN_ID
EOF

echo "=== Experiment D1 (Shared MD) ==="
echo "Run ID: $RUN_ID"
echo "Shared dir: $SHARED_DIR"

setup_worktree() {
  local stream="$1"
  local wt="$OPENCLAW_DIR-worktrees/$stream"
  if [[ -d "$wt" ]]; then echo "$wt"; return; fi
  mkdir -p "$(dirname "$wt")"
  git -C "$OPENCLAW_DIR" worktree add "$wt" -b "exp-d1-$stream" HEAD >/dev/null 2>&1 || true
  echo "$wt"
}

cleanup_worktrees() {
  local base="$OPENCLAW_DIR-worktrees"
  if [[ -d "$base" ]]; then
    for wt in "$base"/*/; do
      local name; name=$(basename "$wt")
      git -C "$OPENCLAW_DIR" worktree remove --force "$wt" 2>/dev/null || true
      git -C "$OPENCLAW_DIR" branch -D "exp-d1-$name" 2>/dev/null || true
    done
    rm -rf "$base"
  fi
}

cleanup_worktrees

run_stream_bg() {
  local stream="$1" prompt="$2"
  local out="$RESULTS_DIR/round1/${stream}.json"
  local wt; wt=$(setup_worktree "$stream")
  local agent="d1-$stream"

  local task_prompt="SHARED SWARM TASK (D1)
runId: $RUN_ID
agentId: $agent
stream: $stream
shared markdown dir: $SHARED_DIR

MANDATORY COLLAB PROTOCOL:
1) FIRST: read all shared files:
- $PLAN_MD
- $DECISIONS_MD
- $INTERFACES_MD
- $HANDOFFS_MD

2) Publish your plan update:
python \"$MD_LOG\" --file \"$PLAN_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$stream\" --kind \"plan\" --text \"<your implementation scope and files>\"

3) Publish at least one decision:
python \"$MD_LOG\" --file \"$DECISIONS_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$stream\" --kind \"decision\" --text \"<key architectural decision>\"

4) If you change API/contracts, publish to interfaces:
python \"$MD_LOG\" --file \"$INTERFACES_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$stream\" --kind \"interface\" --text \"<contract change>\"

5) Before finalizing, write a handoff:
python \"$MD_LOG\" --file \"$HANDOFFS_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$stream\" --kind \"handoff\" --text \"<what others should know>\"

GLOBAL TASK: Build a multi-channel notification orchestration subsystem spanning gateway API, persistence/state, UI status panel, and integration tests.

YOUR STREAM SCOPE:
$prompt"

  node "$CLAUDE_RUN" "$out" "$wt" \
    -p \
    --output-format json \
    --max-turns 50 \
    --dangerously-skip-permissions \
    "$task_prompt"
}

START=$(date +%s)
echo "--- Round 1 (shared-task swarm) ---"

run_stream_bg stream-api "Define and implement API contract + validation layer for the notification orchestration subsystem in gateway server methods and protocol schema." &
P1=$!
run_stream_bg stream-core "Implement gateway orchestration internals and state model (queueing, fanout policy, delivery status lifecycle)." &
P2=$!
run_stream_bg stream-ui "Implement UI status panel and controls for orchestration health and per-channel delivery state." &
P3=$!
run_stream_bg stream-test "Implement integration tests and fixtures for end-to-end orchestration flows and failure cases." &
P4=$!

wait $P1 || true
wait $P2 || true
wait $P3 || true
wait $P4 || true

cleanup_worktrees
END=$(date +%s)
echo "=== Experiment D1 complete ==="
echo "Run ID: $RUN_ID"
echo "Total time: $((END-START))s"
echo "Results: $RESULTS_DIR"
