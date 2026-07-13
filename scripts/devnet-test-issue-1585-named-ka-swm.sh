#!/usr/bin/env bash
# Live order-stress regression for #1585. The first suite intentionally leaves
# named-KA SWM lifecycle residue; the subgraph RS suite then publishes on the
# same running devnet. The buggy family-wide named publish bundles/stomps that
# co-resident state and fails the second suite's merkle/cleanup assertions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -d "${DEVNET_DIR:-$ROOT/.devnet}/node1" ]] || {
  echo "[#1585] FAIL: start a six-node publisher-enabled devnet first" >&2
  exit 1
}

echo "[#1585] phase 1/2: create named-KA lifecycle residue"
pnpm test:devnet:ka-lifecycle-cli
echo "[#1585] phase 2/2: run subgraph publish/RS against the same residue"
pnpm test:devnet:pr1385-subgraph-rs
echo "[#1585] PASS: order-stressed named publish preserved co-resident SWM state"
