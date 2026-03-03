#!/usr/bin/env bash
#
# Experiment A: Single Claude Code agent + DKG, sequential features.
# DKG MCP server must be registered with: claude mcp add -e DKG_API_PORT=9200 -s user dkg -- node .../mcp-server/dist/index.js
# The DKG code graph should be pre-indexed before running.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPERIMENT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$EXPERIMENT_DIR/results/exp-a"
OPENCLAW_DIR="${OPENCLAW_DIR:-/Users/aleatoric/dev/openclaw}"
CLAUDE_RUN="$SCRIPT_DIR/claude-run.mjs"

export DKG_API_PORT=9200

if [[ ! -d "$OPENCLAW_DIR" ]]; then
  echo "Error: OpenClaw not found at $OPENCLAW_DIR"
  exit 1
fi

mkdir -p "$RESULTS_DIR/round1" "$RESULTS_DIR/round2"

echo "=== Experiment A: Single Agent + DKG ==="
echo "  OpenClaw: $OPENCLAW_DIR"
echo "  Results:  $RESULTS_DIR"
echo ""

DKG_PREAMBLE='You have access to DKG MCP tools (dkg_query, dkg_publish, dkg_list_paranets, dkg_find_agents, dkg_status). The OpenClaw codebase has been indexed into a code graph in the dev-coordination paranet. BEFORE exploring files with Read/Grep/Glob, query the code graph using dkg_query with paranetId="dev-coordination" to find relevant modules, functions, classes, and packages. Examples:
- Find modules by keyword: SELECT ?path ?lineCount WHERE { ?m a <https://ontology.dkg.io/devgraph#CodeModule> ; <https://ontology.dkg.io/devgraph#path> ?path ; <https://ontology.dkg.io/devgraph#lineCount> ?lineCount . FILTER(CONTAINS(LCASE(?path), "keyword")) }
- Find functions: SELECT ?name ?sig WHERE { ?f a <https://ontology.dkg.io/devgraph#Function> ; <https://ontology.dkg.io/devgraph#name> ?name ; <https://ontology.dkg.io/devgraph#definedIn> ?mod . ?mod <https://ontology.dkg.io/devgraph#path> ?path . OPTIONAL { ?f <https://ontology.dkg.io/devgraph#signature> ?sig } FILTER(CONTAINS(?name, "keyword")) } LIMIT 20
- Find packages and deps: SELECT ?pkg ?dep WHERE { ?p a <https://ontology.dkg.io/devgraph#Package> ; <https://ontology.dkg.io/devgraph#name> ?pkg ; <https://ontology.dkg.io/devgraph#dependsOn> ?d . ?d <https://ontology.dkg.io/devgraph#name> ?dep }
- Find classes: SELECT ?name ?path WHERE { ?c a <https://ontology.dkg.io/devgraph#Class> ; <https://ontology.dkg.io/devgraph#name> ?name ; <https://ontology.dkg.io/devgraph#definedIn> ?mod . ?mod <https://ontology.dkg.io/devgraph#path> ?path }
This saves exploration tokens by letting you jump directly to relevant files. Always set paranetId="dev-coordination" in dkg_query calls.'

run_feature() {
  local round="$1" feature_id="$2" prompt="$3"
  local out_file="$RESULTS_DIR/round${round}/${feature_id}.json"

  echo "--- Round $round, Feature $feature_id ---"

  node "$CLAUDE_RUN" "$out_file" "$OPENCLAW_DIR" \
    -p \
    --output-format json \
    --max-turns 50 \
    --dangerously-skip-permissions \
    --append-system-prompt "$DKG_PREAMBLE" \
    "$prompt"

  echo ""
}

OVERALL_START=$(date +%s)

echo "=== Round 1 ==="

run_feature 1 r1-f1 \
  "Add a new X/Twitter DM channel extension at extensions/x-twitter/. Follow the existing channel extension patterns (look at extensions/discord/ and extensions/telegram/ for the structure). It must include: openclaw.plugin.json with kind='channels', a channel plugin class that can send and receive DMs via the X API v2, an onboarding step for API credentials, a probe for health checking the connection, and a basic unit test. Make it functional with proper TypeScript types."

run_feature 1 r1-f2 \
  "Add a Pinecone vector database memory backend extension at extensions/memory-pinecone/. Model it after extensions/memory-lancedb/ — use the same plugin interface and memory provider pattern. It must include: openclaw.plugin.json with kind='memory', a memory provider class implementing upsert/query/delete operations against Pinecone, config schema for API key and index name, and a unit test with mocked Pinecone client. Use the @pinecone-database/pinecone SDK."

run_feature 1 r1-f3 \
  "Add an 'openclaw sessions export' CLI subcommand that exports a session's chat transcript. Look at the existing CLI commands in src/cli/ and src/commands/ for the registration pattern. It must: connect to the gateway to fetch session history, support --format json|markdown flags, support --output for file path (default stdout), support --session-id to pick a specific session, format messages nicely with timestamps and role labels, and include a basic test. Use the existing session/gateway infrastructure."

run_feature 1 r1-f4 \
  "Add webhook delivery logging and query endpoints to the OpenClaw gateway. Look at the existing gateway server-methods in src/gateway/server-methods/ for the pattern. Add: (1) a delivery log store (in-memory ring buffer, max 1000 entries) that records each webhook dispatch with timestamp, URL, status code, response time, and payload hash, (2) a 'webhooks.deliveries' gateway method that returns recent deliveries with optional filtering by status and URL, (3) a 'webhooks.delivery' method for single delivery detail. Include a test."

echo "=== Round 2 ==="

run_feature 2 r2-f1 \
  "Add a Reddit channel extension at extensions/reddit/ for receiving and responding to Reddit messages and mentions. Follow the channel extension pattern (see extensions/discord/ or extensions/telegram/). Must include: openclaw.plugin.json, Reddit OAuth2 authentication flow, message polling for inbox and mention notifications, send capability for reply/DM, onboarding step, probe, and a unit test. Use the snoowrap or reddit-api-v2 SDK."

run_feature 2 r2-f2 \
  "Add a custom Matrix channel card to the OpenClaw Control UI. Look at the existing channel cards in ui/src/ui/views/ (discord, slack have custom cards) for the pattern. The Matrix channel currently uses the generic card. Create a Matrix-specific card that shows: homeserver URL, connected rooms count, sync status, last sync timestamp, and a test button. Wire it into the channel card registry. Include the card's Lit component and any needed CSS."

run_feature 2 r2-f3 \
  "Add session archiving to the OpenClaw gateway. Look at the existing session methods in src/gateway/server-methods/ for patterns. Add: (1) 'sessions.archive' method that marks a session as archived (soft-delete via an 'archived' flag), (2) 'sessions.archived' method to list archived sessions, (3) 'sessions.unarchive' method to restore an archived session, (4) modify 'sessions.list' to exclude archived sessions by default (add includeArchived option). Include a test."

run_feature 2 r2-f4 \
  "Add a Mistral AI portal authentication extension at extensions/mistral-portal-auth/. Follow the pattern of extensions/minimax-portal-auth/ and extensions/qwen-portal-auth/. Must include: openclaw.plugin.json with the auth provider kind, auth provider class that handles Mistral API key validation and rotation, config schema for API key and base URL, onboarding step, and a unit test. Use Mistral's standard API key authentication pattern."

OVERALL_END=$(date +%s)
echo "=== Experiment A complete ==="
echo "  Total time: $((OVERALL_END - OVERALL_START))s"
echo "  Results in: $RESULTS_DIR"
