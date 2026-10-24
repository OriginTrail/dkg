#!/usr/bin/env bash
set -euo pipefail

# Keep the established developer/CI entry point; the importable manifest owns
# scope selection and file routing. Each test retains its own Hardhat lifecycle.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/run-evm-integration.mjs" "$@"
