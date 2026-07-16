#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pnpm run build
./scripts/devnet.sh clean
./scripts/devnet.sh start 6
pnpm test:devnet:chat-access-matrix
