#!/usr/bin/env bash
#
# Analyze experiment results — extract token usage and timing from session JSON.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="$(dirname "$SCRIPT_DIR")/results"
ANALYSIS_DIR="$(dirname "$SCRIPT_DIR")/analysis"

mkdir -p "$ANALYSIS_DIR"

echo "=== Experiment Analysis ==="
echo ""

extract_metrics() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "  (missing)"
    return
  fi

  local input_tokens output_tokens cost duration
  input_tokens=$(jq -r '.usage.input_tokens // .result.usage.input_tokens // 0' "$file" 2>/dev/null || echo 0)
  output_tokens=$(jq -r '.usage.output_tokens // .result.usage.output_tokens // 0' "$file" 2>/dev/null || echo 0)
  cost=$(jq -r '.cost_usd // .result.cost_usd // "N/A"' "$file" 2>/dev/null || echo "N/A")

  echo "  Input: $input_tokens  Output: $output_tokens  Cost: $cost"
}

for arm in control exp-a exp-b; do
  echo "--- $arm ---"
  for round in round1 round2; do
    echo "  $round:"
    dir="$RESULTS_DIR/$arm/$round"
    if [[ ! -d "$dir" ]]; then
      echo "    (no results)"
      continue
    fi
    for f in "$dir"/*.json; do
      [[ -f "$f" ]] || continue
      local_name=$(basename "$f" .json)
      echo -n "    $local_name: "
      extract_metrics "$f"
    done
  done
  echo ""
done

# Summary table
cat > "$ANALYSIS_DIR/summary.md" << 'EOF'
# Experiment Results Summary

| Arm | Round | Feature | Input Tokens | Output Tokens | Cost (USD) | Duration (s) |
|-----|-------|---------|-------------|---------------|------------|-------------|
EOF

for arm in control exp-a exp-b; do
  for round in round1 round2; do
    dir="$RESULTS_DIR/$arm/$round"
    [[ -d "$dir" ]] || continue
    for f in "$dir"/*.json; do
      [[ -f "$f" ]] || continue
      feature=$(basename "$f" .json)
      input=$(jq -r '.usage.input_tokens // 0' "$f" 2>/dev/null || echo 0)
      output=$(jq -r '.usage.output_tokens // 0' "$f" 2>/dev/null || echo 0)
      cost=$(jq -r '.cost_usd // "N/A"' "$f" 2>/dev/null || echo "N/A")
      echo "| $arm | $round | $feature | $input | $output | $cost | — |" >> "$ANALYSIS_DIR/summary.md"
    done
  done
done

echo "Summary written to: $ANALYSIS_DIR/summary.md"
