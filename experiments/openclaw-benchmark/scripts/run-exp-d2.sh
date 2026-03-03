#!/usr/bin/env bash
#
# Experiment D2: 4-agent swarm on ONE shared task, using DKG publish/query.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$EXPERIMENT_DIR/results/exp-d2"
OPENCLAW_DIR="${OPENCLAW_DIR:-/Users/aleatoric/dev/openclaw}"
CLAUDE_RUN="$SCRIPT_DIR/claude-run.mjs"
RUN_ID="${RUN_ID:-d2-$(date +%Y%m%d-%H%M%S)}"
PARANET_ID="${PARANET_ID:-dev-coordination}"

mkdir -p "$RESULTS_DIR/round1"

echo "=== Experiment D2 (DKG Swarm) ==="
echo "Run ID: $RUN_ID"
echo "Paranet: $PARANET_ID"

setup_worktree() {
  local stream="$1"
  local wt="$OPENCLAW_DIR-worktrees/$stream"
  if [[ -d "$wt" ]]; then echo "$wt"; return; fi
  mkdir -p "$(dirname "$wt")"
  git -C "$OPENCLAW_DIR" worktree add "$wt" -b "exp-d2-$stream" HEAD >/dev/null 2>&1 || true
  echo "$wt"
}

cleanup_worktrees() {
  local base="$OPENCLAW_DIR-worktrees"
  if [[ -d "$base" ]]; then
    for wt in "$base"/*/; do
      local name; name=$(basename "$wt")
      git -C "$OPENCLAW_DIR" worktree remove --force "$wt" 2>/dev/null || true
      git -C "$OPENCLAW_DIR" branch -D "exp-d2-$name" 2>/dev/null || true
    done
    rm -rf "$base"
  fi
}

cleanup_worktrees

run_stream_bg() {
  local stream="$1" prompt="$2"
  local out="$RESULTS_DIR/round1/${stream}.json"
  local wt; wt=$(setup_worktree "$stream")
  local agent="d2-$stream"

  local task_prompt="SHARED SWARM TASK (D2)
runId: $RUN_ID
agentId: $agent
stream: $stream
paranetId: $PARANET_ID

MANDATORY COLLAB PROTOCOL (DKG):
1) FIRST query prior run entities:
SELECT ?s ?summary ?kind WHERE {
  ?s <https://ontology.dkg.io/devgraph#summary> ?summary ;
     <https://ontology.dkg.io/devgraph#kind> ?kind .
  FILTER(CONTAINS(STR(?s), \"urn:exp-d2:$RUN_ID:\"))
}

2) Publish PLAN entity via dkg_publish with subject:
urn:exp-d2:$RUN_ID:$agent:$stream:plan

3) Publish at least one DECISION entity:
urn:exp-d2:$RUN_ID:$agent:$stream:decision:<n>

4) Publish FINAL HANDOFF entity:
urn:exp-d2:$RUN_ID:$agent:$stream:handoff

Use graph: did:dkg:paranet:$PARANET_ID
Include predicates:
- rdf:type
- https://ontology.dkg.io/devgraph#summary
- https://ontology.dkg.io/devgraph#kind
- https://ontology.dkg.io/devgraph#agent
- https://ontology.dkg.io/devgraph#feature

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
echo "=== Experiment D2 complete ==="
echo "Run ID: $RUN_ID"
echo "Total time: $((END-START))s"
echo "Results: $RESULTS_DIR"
