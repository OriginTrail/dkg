#!/usr/bin/env bash
#
# Experiment C2: Parallel collaborative agents using full DKG publishing.
# - Shared code graph + shared decision memory in common paranet
# - Agents must query and publish structured decisions during execution
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$EXPERIMENT_DIR/results/exp-c2"
OPENCLAW_DIR="${OPENCLAW_DIR:-/Users/aleatoric/dev/openclaw}"
CLAUDE_RUN="$SCRIPT_DIR/claude-run.mjs"

export DKG_API_PORT=9200
RUN_ID="${RUN_ID:-c2-$(date +%Y%m%d-%H%M%S)}"
PARANET_ID="${PARANET_ID:-dev-coordination}"
GRAPH_URI="did:dkg:paranet:${PARANET_ID}"
DECISION_CLASS="https://ontology.dkg.io/devgraph#Decision"
PRED_SUMMARY="https://ontology.dkg.io/devgraph#summary"
PRED_FEATURE="https://ontology.dkg.io/devgraph#feature"
PRED_AGENT="https://ontology.dkg.io/devgraph#agent"
PRED_KIND="https://ontology.dkg.io/devgraph#kind"

if [[ ! -d "$OPENCLAW_DIR" ]]; then
  echo "Error: OpenClaw not found at $OPENCLAW_DIR"
  exit 1
fi

mkdir -p "$RESULTS_DIR/round1" "$RESULTS_DIR/round2"

echo "=== Experiment C2: Full Publishing Collaboration ==="
echo "  Run ID:    $RUN_ID"
echo "  Paranet:   $PARANET_ID"
echo "  OpenClaw:  $OPENCLAW_DIR"
echo "  Results:   $RESULTS_DIR"
echo ""

DKG_PREAMBLE='You have DKG MCP tools (dkg_query, dkg_publish) and MUST collaborate through a shared paranet memory.
Always query the code graph before broad file reads.
Always publish plan and final decisions as Decision entities in the same paranet.'

setup_worktree() {
  local feature_id="$1"
  local worktree_dir="$OPENCLAW_DIR-worktrees/$feature_id"
  if [[ -d "$worktree_dir" ]]; then
    echo "$worktree_dir"
    return
  fi
  mkdir -p "$(dirname "$worktree_dir")"
  git -C "$OPENCLAW_DIR" worktree add "$worktree_dir" -b "exp-c2-${feature_id}" HEAD >/dev/null 2>&1 || true
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
      git -C "$OPENCLAW_DIR" branch -D "exp-c2-${name}" 2>/dev/null || true
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
  local agent_id="c2-${feature_id}"

  local collab_prompt="COLLAB PROTOCOL (MANDATORY)
- runId: $RUN_ID
- agentId: $agent_id
- featureId: $feature_id
- paranetId: $PARANET_ID

1) FIRST ACTION: query shared decisions already published by other agents in this run:
SELECT ?d ?summary ?feature ?agent ?kind WHERE {
  ?d a <${DECISION_CLASS}> ;
     <${PRED_SUMMARY}> ?summary ;
     <${PRED_FEATURE}> ?feature ;
     <${PRED_AGENT}> ?agent ;
     <${PRED_KIND}> ?kind .
  FILTER(CONTAINS(STR(?d), \"urn:exp-c2:${RUN_ID}:\"))
}

2) After initial discovery, publish your PLAN decision with dkg_publish.
Use subject: urn:exp-c2:${RUN_ID}:${agent_id}:${feature_id}:plan

3) Before final answer, publish your FINAL decision with dkg_publish.
Use subject: urn:exp-c2:${RUN_ID}:${agent_id}:${feature_id}:final

4) Required quad template for each publish:
- subject: \"urn:exp-c2:${RUN_ID}:${agent_id}:${feature_id}:<plan|final>\"
- predicate: \"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\", object: \"${DECISION_CLASS}\", graph: \"${GRAPH_URI}\"
- predicate: \"${PRED_FEATURE}\", object: \"\\\"${feature_id}\\\"\", graph: \"${GRAPH_URI}\"
- predicate: \"${PRED_AGENT}\", object: \"\\\"${agent_id}\\\"\", graph: \"${GRAPH_URI}\"
- predicate: \"${PRED_KIND}\", object: \"\\\"<plan|final>\\\"\", graph: \"${GRAPH_URI}\"
- predicate: \"${PRED_SUMMARY}\", object: \"\\\"<short summary>\\\"\", graph: \"${GRAPH_URI}\"

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
echo "=== Experiment C2 complete ==="
echo "  Run ID:    $RUN_ID"
echo "  Total time: $((OVERALL_END - OVERALL_START))s"
echo "  Results in: $RESULTS_DIR"
