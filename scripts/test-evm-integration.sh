#!/usr/bin/env bash
set -euo pipefail

# Runs only the EVM integration tests (requires Hardhat node spawn internally).
# Each test file manages its own Hardhat lifecycle via hardhat-harness.ts.
#
# Usage:
#   ./scripts/test-evm-integration.sh          # run all
#   ./scripts/test-evm-integration.sh chain     # chain adapter tests only
#   ./scripts/test-evm-integration.sh publisher  # publisher E2E only
#   ./scripts/test-evm-integration.sh agent      # agent E2E only

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

CHAIN_TESTS=(
  "packages/chain/test/evm-adapter.test.ts"
  "packages/chain/test/evm-e2e.test.ts"
)
PUBLISHER_TESTS=(
  "packages/publisher/test/publisher-evm-e2e.test.ts"
)
AGENT_TESTS=(
  "packages/agent/test/e2e-chain.test.ts"
)

files=()
scope="${1:-all}"

case "$scope" in
  chain)     files+=("${CHAIN_TESTS[@]}") ;;
  publisher) files+=("${PUBLISHER_TESTS[@]}") ;;
  agent)     files+=("${AGENT_TESTS[@]}") ;;
  all)
    files+=("${CHAIN_TESTS[@]}")
    files+=("${PUBLISHER_TESTS[@]}")
    files+=("${AGENT_TESTS[@]}")
    ;;
  *)
    echo "Unknown scope: $scope (use chain|publisher|agent|all)"
    exit 1
    ;;
esac

echo "╔══════════════════════════════════════════════╗"
echo "║  EVM Integration Tests  (scope: $scope)"
echo "╠══════════════════════════════════════════════╣"
echo "║  Files: ${#files[@]}"
echo "╚══════════════════════════════════════════════╝"
echo ""

cd "$ROOT"

# Run sequentially — each test spawns its own Hardhat node on a unique port,
# but we still serialize to avoid port collisions and reduce CI flakiness.
exit_code=0
for f in "${files[@]}"; do
  echo "──── Running: $f ────"
  if ! npx vitest run "$f" --reporter=verbose; then
    exit_code=1
    echo "FAIL: $f"
  fi
  echo ""
done

if [ "$exit_code" -ne 0 ]; then
  echo "❌ Some EVM integration tests failed."
else
  echo "✅ All EVM integration tests passed."
fi

exit $exit_code
