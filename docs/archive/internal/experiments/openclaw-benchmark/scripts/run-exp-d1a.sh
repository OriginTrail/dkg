#!/usr/bin/env bash
#
# Experiment D1A (apples-to-apples): 8-feature benchmark with shared MD collaboration.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$EXPERIMENT_DIR/results/exp-d1a"
OPENCLAW_DIR="${OPENCLAW_DIR:-/Users/aleatoric/dev/openclaw}"
CLAUDE_RUN="$SCRIPT_DIR/claude-run.mjs"
MD_LOG="$SCRIPT_DIR/collab-md-log.py"
RUN_ID="${RUN_ID:-d1a-$(date +%Y%m%d-%H%M%S)}"

SHARED_DIR="$RESULTS_DIR/shared/$RUN_ID"
PLAN_MD="$SHARED_DIR/plan.md"
DECISIONS_MD="$SHARED_DIR/decisions.md"
INTERFACES_MD="$SHARED_DIR/interfaces.md"
HANDOFFS_MD="$SHARED_DIR/handoffs.md"

mkdir -p "$RESULTS_DIR/round1" "$RESULTS_DIR/round2" "$SHARED_DIR"
chmod +x "$MD_LOG"

cat >"$PLAN_MD" <<EOF
# D1A Shared Plan
runId: $RUN_ID
scope: 8-feature benchmark (round1+round2)
EOF
cat >"$DECISIONS_MD" <<EOF
# D1A Decisions
runId: $RUN_ID
EOF
cat >"$INTERFACES_MD" <<EOF
# D1A Interfaces
runId: $RUN_ID
EOF
cat >"$HANDOFFS_MD" <<EOF
# D1A Handoffs
runId: $RUN_ID
EOF

echo "=== Experiment D1A (Shared MD, apples-to-apples) ==="
echo "Run ID: $RUN_ID"
echo "Shared dir: $SHARED_DIR"
echo "Results: $RESULTS_DIR"

setup_worktree() {
  local feature_id="$1"
  local wt="$OPENCLAW_DIR-worktrees/$feature_id"
  if [[ -d "$wt" ]]; then echo "$wt"; return; fi
  mkdir -p "$(dirname "$wt")"
  git -C "$OPENCLAW_DIR" worktree add "$wt" -b "exp-d1a-$feature_id" HEAD >/dev/null 2>&1 || true
  echo "$wt"
}

cleanup_worktrees() {
  local base="$OPENCLAW_DIR-worktrees"
  if [[ -d "$base" ]]; then
    for wt in "$base"/*/; do
      local name; name=$(basename "$wt")
      git -C "$OPENCLAW_DIR" worktree remove --force "$wt" 2>/dev/null || true
      git -C "$OPENCLAW_DIR" branch -D "exp-d1a-$name" 2>/dev/null || true
    done
    rm -rf "$base"
  fi
}

cleanup_worktrees

run_feature_bg() {
  local round="$1" feature_id="$2" prompt="$3"
  local out_file="$RESULTS_DIR/round${round}/${feature_id}.json"
  local wt; wt=$(setup_worktree "$feature_id")
  local agent="d1a-${feature_id}"

  local collab_prompt="COLLAB PROTOCOL (D1A - shared markdown)
runId: $RUN_ID
agentId: $agent
featureId: $feature_id
round: $round

FIRST read shared state files:
- $PLAN_MD
- $DECISIONS_MD
- $INTERFACES_MD
- $HANDOFFS_MD

Then publish:
1) plan:
python \"$MD_LOG\" --file \"$PLAN_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$feature_id\" --kind \"plan\" --text \"<scope and files>\"
2) at least one decision:
python \"$MD_LOG\" --file \"$DECISIONS_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$feature_id\" --kind \"decision\" --text \"<key decision>\"
3) if interface/schema changed:
python \"$MD_LOG\" --file \"$INTERFACES_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$feature_id\" --kind \"interface\" --text \"<contract>\"
4) final handoff:
python \"$MD_LOG\" --file \"$HANDOFFS_MD\" --run-id \"$RUN_ID\" --agent \"$agent\" --stream \"$feature_id\" --kind \"handoff\" --text \"<final notes>\"

Feature task:
$prompt"

  node "$CLAUDE_RUN" "$out_file" "$wt" \
    -p \
    --output-format json \
    --max-turns 50 \
    --dangerously-skip-permissions \
    "$collab_prompt"
}

run_round_parallel() {
  local round="$1"; shift
  local pids=(); local features=()
  local start; start=$(date +%s)
  echo "--- Round $round (4 agents parallel) ---"
  while [[ $# -ge 2 ]]; do
    local fid="$1" pr="$2"; shift 2
    echo "  Launching $fid..."
    run_feature_bg "$round" "$fid" "$pr" &
    pids+=($!); features+=("$fid")
  done
  for i in "${!pids[@]}"; do wait "${pids[$i]}" || true; echo "  ✓ ${features[$i]} done"; done
  local end; end=$(date +%s)
  echo "  Round $round done in $((end-start))s"
}

OVERALL_START=$(date +%s)

echo "=== Round 1 ==="
run_round_parallel 1 \
  r1-f1 "Add a new X/Twitter DM channel extension at extensions/x-twitter/. Follow the existing channel extension patterns (look at extensions/discord/ and extensions/telegram/ for the structure). It must include: openclaw.plugin.json with kind='channels', a channel plugin class that can send and receive DMs via the X API v2, an onboarding step for API credentials, a probe for health checking the connection, and a basic unit test. Make it functional with proper TypeScript types." \
  r1-f2 "Add a Pinecone vector database memory backend extension at extensions/memory-pinecone/. Model it after extensions/memory-lancedb/ — use the same plugin interface and memory provider pattern. It must include: openclaw.plugin.json with kind='memory', a memory provider class implementing upsert/query/delete operations against Pinecone, config schema for API key and index name, and a unit test with mocked Pinecone client. Use the @pinecone-database/pinecone SDK." \
  r1-f3 "Add an 'openclaw sessions export' CLI subcommand that exports a session's chat transcript. Look at the existing CLI commands in src/cli/ and src/commands/ for the registration pattern. It must: connect to the gateway to fetch session history, support --format json|markdown flags, support --output for file path (default stdout), support --session-id to pick a specific session, format messages nicely with timestamps and role labels, and include a basic test. Use the existing session/gateway infrastructure." \
  r1-f4 "Add webhook delivery logging and query endpoints to the OpenClaw gateway. Look at the existing gateway server-methods in src/gateway/server-methods/ for the pattern. Add: (1) a delivery log store (in-memory ring buffer, max 1000 entries) that records each webhook dispatch with timestamp, URL, status code, response time, and payload hash, (2) a 'webhooks.deliveries' gateway method that returns recent deliveries with optional filtering by status and URL, (3) a 'webhooks.delivery' method for single delivery detail. Include a test."

cd "$OPENCLAW_DIR" && git checkout -- . && git clean -fd >/dev/null 2>&1 || true
cleanup_worktrees

echo "=== Round 2 ==="
run_round_parallel 2 \
  r2-f1 "Add a Reddit channel extension at extensions/reddit/ for receiving and responding to Reddit messages and mentions. Follow the channel extension pattern (see extensions/discord/ or extensions/telegram/). Must include: openclaw.plugin.json, Reddit OAuth2 authentication flow, message polling for inbox and mention notifications, send capability for reply/DM, onboarding step, probe, and a unit test. Use the snoowrap or reddit-api-v2 SDK." \
  r2-f2 "Add a custom Matrix channel card to the OpenClaw Control UI. Look at the existing channel cards in ui/src/ui/views/ (discord, slack have custom cards) for the pattern. The Matrix channel currently uses the generic card. Create a Matrix-specific card that shows: homeserver URL, connected rooms count, sync status, last sync timestamp, and a test button. Wire it into the channel card registry. Include the card's Lit component and any needed CSS." \
  r2-f3 "Add session archiving to the OpenClaw gateway. Look at the existing session methods in src/gateway/server-methods/ for patterns. Add: (1) 'sessions.archive' method that marks a session as archived (soft-delete via an 'archived' flag), (2) 'sessions.archived' method to list archived sessions, (3) 'sessions.unarchive' method to restore an archived session, (4) modify 'sessions.list' to exclude archived sessions by default (add includeArchived option). Include a test." \
  r2-f4 "Add a Mistral AI portal authentication extension at extensions/mistral-portal-auth/. Follow the pattern of extensions/minimax-portal-auth/ and extensions/qwen-portal-auth/. Must include: openclaw.plugin.json with the auth provider kind, auth provider class that handles Mistral API key validation and rotation, config schema for API key and base URL, onboarding step, and a unit test. Use Mistral's standard API key authentication pattern."

cleanup_worktrees
OVERALL_END=$(date +%s)
echo "=== Experiment D1A complete ==="
echo "Run ID: $RUN_ID"
echo "Total time: $((OVERALL_END-OVERALL_START))s"
echo "Results: $RESULTS_DIR"
