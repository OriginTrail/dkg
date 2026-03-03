#!/usr/bin/env bash
#
# Experiment C1: Parallel collaborative agents using shared workspace memory.
# - Shared code graph access via dkg_query
# - Shared agent memory via workspace JSONL log (outside worktrees)
# - Common paranet: dev-coordination
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$EXPERIMENT_DIR/results/exp-c1"
OPENCLAW_DIR="${OPENCLAW_DIR:-/Users/aleatoric/dev/openclaw}"
CLAUDE_RUN="$SCRIPT_DIR/claude-run.mjs"
WORKSPACE_LOG_TOOL="$SCRIPT_DIR/collab-workspace-log.py"

export DKG_API_PORT=9200
RUN_ID="${RUN_ID:-c1-$(date +%Y%m%d-%H%M%S)}"
SHARED_DIR="$RESULTS_DIR/shared"
SHARED_LOG="$SHARED_DIR/${RUN_ID}.jsonl"

if [[ ! -d "$OPENCLAW_DIR" ]]; then
  echo "Error: OpenClaw not found at $OPENCLAW_DIR"
  exit 1
fi

mkdir -p "$RESULTS_DIR/round1" "$RESULTS_DIR/round2" "$SHARED_DIR"
chmod +x "$WORKSPACE_LOG_TOOL"

echo "=== Experiment C1: Workspace Collaboration ==="
echo "  Run ID:   $RUN_ID"
echo "  OpenClaw: $OPENCLAW_DIR"
echo "  Results:  $RESULTS_DIR"
echo "  Shared:   $SHARED_LOG"
echo ""

DKG_PREAMBLE='You have DKG MCP tools (dkg_query, dkg_publish). The code graph is in a shared paranet (dev-coordination). Before broad file exploration, run targeted dkg_query calls to locate modules, functions, classes, and package dependencies.'

setup_worktree() {
  local feature_id="$1"
  local worktree_dir="$OPENCLAW_DIR-worktrees/$feature_id"
  if [[ -d "$worktree_dir" ]]; then
    echo "$worktree_dir"
    return
  fi
  mkdir -p "$(dirname "$worktree_dir")"
  git -C "$OPENCLAW_DIR" worktree add "$worktree_dir" -b "exp-c1-${feature_id}" HEAD >/dev/null 2>&1 || true
  echo "$worktree_dir"
}

cleanup_worktrees() {
  echo "--- Cleaning up worktrees ---"
  local worktree_base="$OPENCLAW_DIR-worktrees"
  if [[ -d "$worktree_base" ]]; then
    for wt in "$worktree_base"/*/; do
      local name
      name=$(basename "$wt")
      git -C "$OPENCLAW_DIR" worktree remove --force "$wt" 2>/dev/null || true
      git -C "$OPENCLAW_DIR" branch -D "exp-c1-${name}" 2>/dev/null || true
    done
    rm -rf "$worktree_base"
  fi
}

cleanup_worktrees

run_feature_bg() {
  local round="$1" feature_id="$2" prompt="$3"
  local out_file="$RESULTS_DIR/round${round}/${feature_id}.json"
  local worktree
  worktree=$(setup_worktree "$feature_id")
  local agent_id="c1-${feature_id}"

  local collab_prompt="COLLAB PROTOCOL (MANDATORY)
- runId: $RUN_ID
- agentId: $agent_id
- featureId: $feature_id
- sharedLog: $SHARED_LOG

1) FIRST ACTION: read shared memory:
python \"$WORKSPACE_LOG_TOOL\" read --file \"$SHARED_LOG\" --limit 40

2) After initial code-graph discovery, write your plan:
python \"$WORKSPACE_LOG_TOOL\" write --file \"$SHARED_LOG\" --run-id \"$RUN_ID\" --agent \"$agent_id\" --feature \"$feature_id\" --kind \"plan\" --summary \"<1-2 sentence implementation plan>\" --paths \"<comma-separated target files>\"

3) If you discover assumptions, blockers, or interface decisions, write updates:
python \"$WORKSPACE_LOG_TOOL\" write --file \"$SHARED_LOG\" --run-id \"$RUN_ID\" --agent \"$agent_id\" --feature \"$feature_id\" --kind \"decision\" --summary \"<decision text>\" --paths \"<files touched>\"

4) Before finishing, read shared memory again and ensure consistency with prior decisions.

Feature task:
$prompt"

  node "$CLAUDE_RUN" "$out_file" "$worktree" \
    -p \
    --output-format json \
    --max-turns 50 \
    --dangerously-skip-permissions \
    --append-system-prompt "$DKG_PREAMBLE" \
    "$collab_prompt"
}

run_round_parallel() {
  local round="$1"
  shift
  local pids=()
  local features=()
  local start_time
  start_time=$(date +%s)

  echo "--- Round $round (4 agents in parallel) ---"
  while [[ $# -ge 2 ]]; do
    local feature_id="$1" prompt="$2"
    shift 2
    echo "  Launching agent for $feature_id..."
    run_feature_bg "$round" "$feature_id" "$prompt" &
    pids+=($!)
    features+=("$feature_id")
  done

  echo "  Waiting for all agents..."
  local failures=0
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      echo "  ✓ ${features[$i]} done"
    else
      echo "  ✗ ${features[$i]} failed"
      ((failures++))
    fi
  done

  local end_time
  end_time=$(date +%s)
  echo "  All agents finished in $((end_time - start_time))s ($failures failures)"
  echo ""
}

OVERALL_START=$(date +%s)

echo "=== Round 1 ==="
run_round_parallel 1 \
  r1-f1 "Add a new X/Twitter DM channel extension at extensions/x-twitter/. Follow existing channel extension patterns. Include plugin manifest, channel plugin class, X API v2 DM send/receive, onboarding, probe, and a basic unit test." \
  r1-f2 "Add a Pinecone memory backend extension at extensions/memory-pinecone/. Match memory-lancedb interface. Include config schema, upsert/query/delete, mocked unit test." \
  r1-f3 "Add an openclaw sessions export CLI subcommand with --format json|markdown, --output, --session-id. Include tests and use existing gateway/session infrastructure." \
  r1-f4 "Add webhook delivery logging and query endpoints in gateway with in-memory ring buffer and methods webhooks.deliveries + webhooks.delivery, with test."

cd "$OPENCLAW_DIR" && git checkout -- . && git clean -fd 2>/dev/null || true
cleanup_worktrees

echo "=== Round 2 ==="
run_round_parallel 2 \
  r2-f1 "Add a Reddit channel extension at extensions/reddit/ with OAuth2, inbox/mention polling, reply/DM send capability, onboarding, probe, and unit test." \
  r2-f2 "Add a custom Matrix channel card in the UI with homeserver URL, connected rooms count, sync status, last sync timestamp, and test button." \
  r2-f3 "Add session archiving methods: sessions.archive, sessions.archived, sessions.unarchive, and sessions.list includeArchived option. Add tests." \
  r2-f4 "Add a Mistral portal auth extension at extensions/mistral-portal-auth/ with key validation/rotation, config schema, onboarding, and unit test."

cleanup_worktrees

OVERALL_END=$(date +%s)
echo "=== Experiment C1 complete ==="
echo "  Run ID:    $RUN_ID"
echo "  Total time: $((OVERALL_END - OVERALL_START))s"
echo "  Results in: $RESULTS_DIR"
