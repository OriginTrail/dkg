#!/usr/bin/env bash
#
# Experiment B2: 4 Claude Code agents in parallel + optimized DKG semantic tools.
# Each agent works on one feature per round in its own git worktree.
# DKG MCP server must be registered at user level (claude mcp add).
# The DKG code graph should be pre-indexed before running.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$EXPERIMENT_DIR/results/exp-b2"
OPENCLAW_DIR="${OPENCLAW_DIR:-/Users/aleatoric/dev/openclaw}"
CLAUDE_RUN="$SCRIPT_DIR/claude-run.mjs"

export DKG_API_PORT=9200

if [[ ! -d "$OPENCLAW_DIR" ]]; then
  echo "Error: OpenClaw not found at $OPENCLAW_DIR"
  exit 1
fi

mkdir -p "$RESULTS_DIR/round1" "$RESULTS_DIR/round2"

echo "=== Experiment B2: Multi-Agent + Optimized DKG ==="
echo "  OpenClaw: $OPENCLAW_DIR"
echo "  Results:  $RESULTS_DIR"
echo ""

DKG_PREAMBLE='You have DKG code graph tools for the OpenClaw codebase. BEFORE reading files, use these tools to find what you need:
- dkg_find_modules(keyword) — find source files by path keyword
- dkg_find_functions(keyword, module?) — find functions/methods by name
- dkg_find_classes(keyword?, module?) — find classes
- dkg_find_packages(keyword?) — list packages and dependencies
- dkg_file_summary(path) — get functions, classes, and imports of a file without reading it
- dkg_query(sparql) — raw SPARQL fallback for complex queries
- dkg_publish(quads) — publish decisions/findings so parallel agents can see them
Other agents may be working in parallel on different features. Query for recent decisions before starting, and publish your own architectural decisions via dkg_publish.
Start with dkg_find_modules to locate relevant code, then dkg_file_summary to understand structure before reading.'

# Each agent gets its own worktree
setup_worktree() {
  local feature_id="$1"
  local worktree_dir="$OPENCLAW_DIR-worktrees/$feature_id"

  if [[ -d "$worktree_dir" ]]; then
    echo "$worktree_dir"
    return
  fi

  mkdir -p "$(dirname "$worktree_dir")"
  git -C "$OPENCLAW_DIR" worktree add "$worktree_dir" -b "exp-b2-${feature_id}" HEAD >/dev/null 2>&1 || true
  echo "$worktree_dir"
}

cleanup_worktrees() {
  echo "--- Cleaning up worktrees ---"
  local worktree_base="$OPENCLAW_DIR-worktrees"
  if [[ -d "$worktree_base" ]]; then
    for wt in "$worktree_base"/*/; do
      local name=$(basename "$wt")
      git -C "$OPENCLAW_DIR" worktree remove --force "$wt" 2>/dev/null || true
      git -C "$OPENCLAW_DIR" branch -D "exp-b2-${name}" 2>/dev/null || true
    done
    rm -rf "$worktree_base"
  fi
}

# Clean up old worktrees if any
cleanup_worktrees

run_feature_bg() {
  local round="$1" feature_id="$2" prompt="$3"
  local out_file="$RESULTS_DIR/round${round}/${feature_id}.json"
  local worktree
  worktree=$(setup_worktree "$feature_id")

  node "$CLAUDE_RUN" "$out_file" "$worktree" \
    -p \
    --output-format json \
    --max-turns 50 \
    --dangerously-skip-permissions \
    --append-system-prompt "$DKG_PREAMBLE" \
    "$prompt"
}

run_round_parallel() {
  local round="$1"
  shift

  local pids=()
  local features=()
  local start_time=$(date +%s)

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

  local end_time=$(date +%s)
  echo "  All agents finished in $((end_time - start_time))s ($failures failures)"
  echo ""
}

OVERALL_START=$(date +%s)

echo "=== Round 1 ==="
run_round_parallel 1 \
  r1-f1 "Add a new X/Twitter DM channel extension at extensions/x-twitter/. Follow the existing channel extension patterns (look at extensions/discord/ and extensions/telegram/ for the structure). It must include: openclaw.plugin.json with kind='channels', a channel plugin class that can send and receive DMs via the X API v2, an onboarding step for API credentials, a probe for health checking the connection, and a basic unit test. Make it functional with proper TypeScript types." \
  r1-f2 "Add a Pinecone vector database memory backend extension at extensions/memory-pinecone/. Model it after extensions/memory-lancedb/ — use the same plugin interface and memory provider pattern. It must include: openclaw.plugin.json with kind='memory', a memory provider class implementing upsert/query/delete operations against Pinecone, config schema for API key and index name, and a unit test with mocked Pinecone client. Use the @pinecone-database/pinecone SDK." \
  r1-f3 "Add an 'openclaw sessions export' CLI subcommand that exports a session's chat transcript. Look at the existing CLI commands in src/cli/ and src/commands/ for the registration pattern. It must: connect to the gateway to fetch session history, support --format json|markdown flags, support --output for file path (default stdout), support --session-id to pick a specific session, format messages nicely with timestamps and role labels, and include a basic test. Use the existing session/gateway infrastructure." \
  r1-f4 "Add webhook delivery logging and query endpoints to the OpenClaw gateway. Look at the existing gateway server-methods in src/gateway/server-methods/ for the pattern. Add: (1) a delivery log store (in-memory ring buffer, max 1000 entries) that records each webhook dispatch with timestamp, URL, status code, response time, and payload hash, (2) a 'webhooks.deliveries' gateway method that returns recent deliveries with optional filtering by status and URL, (3) a 'webhooks.delivery' method for single delivery detail. Include a test."

# Clean OpenClaw main + worktrees between rounds
cd "$OPENCLAW_DIR" && git checkout -- . && git clean -fd 2>/dev/null || true
cleanup_worktrees

echo "=== Round 2 ==="
run_round_parallel 2 \
  r2-f1 "Add a Reddit channel extension at extensions/reddit/ for receiving and responding to Reddit messages and mentions. Follow the channel extension pattern (see extensions/discord/ or extensions/telegram/). Must include: openclaw.plugin.json, Reddit OAuth2 authentication flow, message polling for inbox and mention notifications, send capability for reply/DM, onboarding step, probe, and a unit test. Use the snoowrap or reddit-api-v2 SDK." \
  r2-f2 "Add a custom Matrix channel card to the OpenClaw Control UI. Look at the existing channel cards in ui/src/ui/views/ (discord, slack have custom cards) for the pattern. The Matrix channel currently uses the generic card. Create a Matrix-specific card that shows: homeserver URL, connected rooms count, sync status, last sync timestamp, and a test button. Wire it into the channel card registry. Include the card's Lit component and any needed CSS." \
  r2-f3 "Add session archiving to the OpenClaw gateway. Look at the existing session methods in src/gateway/server-methods/ for patterns. Add: (1) 'sessions.archive' method that marks a session as archived (soft-delete via an 'archived' flag), (2) 'sessions.archived' method to list archived sessions, (3) 'sessions.unarchive' method to restore an archived session, (4) modify 'sessions.list' to exclude archived sessions by default (add includeArchived option). Include a test." \
  r2-f4 "Add a Mistral AI portal authentication extension at extensions/mistral-portal-auth/. Follow the pattern of extensions/minimax-portal-auth/ and extensions/qwen-portal-auth/. Must include: openclaw.plugin.json with the auth provider kind, auth provider class that handles Mistral API key validation and rotation, config schema for API key and base URL, onboarding step, and a unit test. Use Mistral's standard API key authentication pattern."

# Final cleanup
cleanup_worktrees

OVERALL_END=$(date +%s)
echo "=== Experiment B2 complete ==="
echo "  Total time: $((OVERALL_END - OVERALL_START))s"
echo "  Results in: $RESULTS_DIR"
