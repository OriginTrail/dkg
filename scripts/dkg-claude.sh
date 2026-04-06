#!/usr/bin/env bash
#
# dkg-claude — wrapper around `claude` that publishes session telemetry
# to the DKG dev-coordination context graph after each session.
#
# Usage:
#   dkg-claude "fix the staking tests"
#   dkg-claude -p "explain this module"
#   dkg-claude --summary "Refactored chain adapter" "update the tests"
#
# Requires: claude (Claude Code CLI), dkg (DKG CLI), jq, node

set -euo pipefail

CONTEXT_GRAPH_ID="${DKG_DEV_CONTEXT_GRAPH:-${DKG_DEV_PARANET:-dev-coordination}}"
DEVGRAPH_NS="https://ontology.dkg.io/devgraph#"
RDF_NS="http://www.w3.org/1999/02/22-rdf-syntax-ns#"

# ---------------------------------------------------------------------------
# Parse our flags (strip --summary before passing to claude)
# ---------------------------------------------------------------------------
SUMMARY_OVERRIDE=""
CLAUDE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary)
      SUMMARY_OVERRIDE="$2"
      shift 2
      ;;
    *)
      CLAUDE_ARGS+=("$1")
      shift
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Capture pre-session state
# ---------------------------------------------------------------------------
START_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
START_EPOCH=$(date +%s)
GIT_FILES_BEFORE=$(git diff --name-only HEAD 2>/dev/null || true)

# Find the most recent session file before running claude
CLAUDE_PROJECT_DIR="$HOME/.claude/projects"
PROJECT_DIR_ENCODED=$(pwd | sed 's|/|-|g')

get_latest_session() {
  local dir="$CLAUDE_PROJECT_DIR/$PROJECT_DIR_ENCODED"
  if [[ -d "$dir" ]]; then
    ls -t "$dir"/*.jsonl 2>/dev/null | head -1
  fi
}

SESSION_FILE_BEFORE=$(get_latest_session)

# ---------------------------------------------------------------------------
# Run claude
# ---------------------------------------------------------------------------
echo "🔗 DKG session tracking active (context graph: $CONTEXT_GRAPH_ID)"
echo ""

set +e
claude "${CLAUDE_ARGS[@]}"
CLAUDE_EXIT=$?
set -e

# ---------------------------------------------------------------------------
# Capture post-session state
# ---------------------------------------------------------------------------
END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
END_EPOCH=$(date +%s)
DURATION_SECS=$((END_EPOCH - START_EPOCH))

# Find modified files
GIT_FILES_AFTER=$(git diff --name-only HEAD 2>/dev/null || true)
MODIFIED_FILES=$(comm -13 <(echo "$GIT_FILES_BEFORE" | sort) <(echo "$GIT_FILES_AFTER" | sort) 2>/dev/null || true)
FILE_COUNT=$(echo "$MODIFIED_FILES" | grep -c '[^[:space:]]' 2>/dev/null || echo "0")

# Find the session file (could be the same or a new one)
SESSION_FILE_AFTER=$(get_latest_session)

# ---------------------------------------------------------------------------
# Parse token usage from the session JSONL
# ---------------------------------------------------------------------------
INPUT_TOKENS=0
OUTPUT_TOKENS=0
CACHE_TOKENS=0
SESSION_SUMMARY=""

parse_session() {
  local file="$1"
  [[ -z "$file" || ! -f "$file" ]] && return

  # Sum up token usage from all assistant messages
  while IFS= read -r line; do
    local type
    type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null) || continue

    if [[ "$type" == "assistant" ]]; then
      local input output cache
      input=$(echo "$line" | jq -r '.message.usage.input_tokens // 0' 2>/dev/null) || input=0
      output=$(echo "$line" | jq -r '.message.usage.output_tokens // 0' 2>/dev/null) || output=0
      cache=$(echo "$line" | jq -r '.message.usage.cache_read_input_tokens // 0' 2>/dev/null) || cache=0

      INPUT_TOKENS=$((INPUT_TOKENS + input))
      OUTPUT_TOKENS=$((OUTPUT_TOKENS + output))
      CACHE_TOKENS=$((CACHE_TOKENS + cache))
    fi

    if [[ "$type" == "summary" && -z "$SESSION_SUMMARY" ]]; then
      SESSION_SUMMARY=$(echo "$line" | jq -r '.summary // empty' 2>/dev/null) || true
    fi
  done < "$file"
}

if [[ -n "$SESSION_FILE_AFTER" ]]; then
  parse_session "$SESSION_FILE_AFTER"
fi

# Use override summary if provided
if [[ -n "$SUMMARY_OVERRIDE" ]]; then
  SESSION_SUMMARY="$SUMMARY_OVERRIDE"
fi

# Auto-generate summary from git if none available
if [[ -z "$SESSION_SUMMARY" && -n "$MODIFIED_FILES" ]]; then
  SESSION_SUMMARY="Modified ${FILE_COUNT} file(s): $(echo "$MODIFIED_FILES" | head -3 | tr '\n' ', ' | sed 's/,$//')"
fi

if [[ -z "$SESSION_SUMMARY" ]]; then
  SESSION_SUMMARY="Claude Code session (${DURATION_SECS}s)"
fi

# Estimate cost (rough: $3/M input, $15/M output for Opus; $0.30/$1.50 for cache)
COST=$(echo "scale=2; ($INPUT_TOKENS * 15 + $OUTPUT_TOKENS * 75 + $CACHE_TOKENS * 1.5) / 1000000" | bc 2>/dev/null || echo "0.00")

# ---------------------------------------------------------------------------
# Publish session telemetry to DKG
# ---------------------------------------------------------------------------
SESSION_URI="urn:session:${START_TIME}"
GRAPH_URI="did:dkg:context-graph:${CONTEXT_GRAPH_ID}"

build_quads() {
  local quads="["

  # Type triple
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${RDF_NS}type>\",\"object\":\"<${DEVGRAPH_NS}Session>\",\"graph\":\"<${GRAPH_URI}>\"},"

  # Properties
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}agent>\",\"object\":\"\\\"claude-code\\\"\",\"graph\":\"<${GRAPH_URI}>\"},"
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}inputTokens>\",\"object\":\"\\\"${INPUT_TOKENS}\\\"^^<http://www.w3.org/2001/XMLSchema#integer>\",\"graph\":\"<${GRAPH_URI}>\"},"
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}outputTokens>\",\"object\":\"\\\"${OUTPUT_TOKENS}\\\"^^<http://www.w3.org/2001/XMLSchema#integer>\",\"graph\":\"<${GRAPH_URI}>\"},"
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}cacheTokens>\",\"object\":\"\\\"${CACHE_TOKENS}\\\"^^<http://www.w3.org/2001/XMLSchema#integer>\",\"graph\":\"<${GRAPH_URI}>\"},"
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}estimatedCost>\",\"object\":\"\\\"\$${COST}\\\"\",\"graph\":\"<${GRAPH_URI}>\"},"
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}startedAt>\",\"object\":\"\\\"${START_TIME}\\\"^^<http://www.w3.org/2001/XMLSchema#dateTime>\",\"graph\":\"<${GRAPH_URI}>\"},"
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}endedAt>\",\"object\":\"\\\"${END_TIME}\\\"^^<http://www.w3.org/2001/XMLSchema#dateTime>\",\"graph\":\"<${GRAPH_URI}>\"},"
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}filesModified>\",\"object\":\"\\\"${FILE_COUNT}\\\"^^<http://www.w3.org/2001/XMLSchema#integer>\",\"graph\":\"<${GRAPH_URI}>\"},"

  # Escape summary for JSON
  local escaped_summary
  escaped_summary=$(echo "$SESSION_SUMMARY" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g')
  quads+="{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}summary>\",\"object\":\"\\\"${escaped_summary}\\\"\",\"graph\":\"<${GRAPH_URI}>\"}"

  # Modified file links
  if [[ -n "$MODIFIED_FILES" ]]; then
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      quads+=",{\"subject\":\"<${SESSION_URI}>\",\"predicate\":\"<${DEVGRAPH_NS}modifiedFile>\",\"object\":\"<file:${f}>\",\"graph\":\"<${GRAPH_URI}>\"}"
    done <<< "$MODIFIED_FILES"
  fi

  quads+="]"
  echo "$quads"
}

echo ""
echo "📊 Session telemetry:"
echo "   Tokens: ${INPUT_TOKENS} in / ${OUTPUT_TOKENS} out / ${CACHE_TOKENS} cache"
echo "   Cost:   ~\$${COST}"
echo "   Files:  ${FILE_COUNT} modified"
echo "   Time:   ${DURATION_SECS}s"

# Publish to DKG (best effort — don't fail the script if daemon is down)
if command -v dkg &>/dev/null; then
  QUADS=$(build_quads)
  echo ""
  echo "📤 Publishing to DKG context graph '${CONTEXT_GRAPH_ID}'..."

  # Use the DKG CLI's API to publish
  set +e
  RESULT=$(dkg publish "$CONTEXT_GRAPH_ID" --triples "$QUADS" 2>&1)
  PUBLISH_EXIT=$?
  set -e

  if [[ $PUBLISH_EXIT -eq 0 ]]; then
    echo "   ✅ Published: ${SESSION_URI}"
  else
    echo "   ⚠️  Could not publish (daemon may not be running): ${RESULT}"
  fi
else
  echo ""
  echo "ℹ️  DKG CLI not found — session telemetry not published."
  echo "   Install with: cd dkg-v9 && pnpm build && npm link packages/cli"
fi

exit $CLAUDE_EXIT
