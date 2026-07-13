#!/usr/bin/env bash
# Live order-stress regression for #1585. First prove the supported
# skipSeal -> finalize(layer:swm) -> publish recovery on a real fleet, then
# leave named-KA lifecycle residue and publish the subgraph RS suite against the
# same running devnet. A legacy-bucket/exact-scope mismatch fails phase 1; a
# family-wide named publish bundles or stomps co-resident state in phase 3.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -d "${DEVNET_DIR:-$ROOT/.devnet}/node1" ]] || {
  echo "[#1585] FAIL: start a six-node publisher-enabled devnet first" >&2
  exit 1
}

echo "[#1585] phase 1/3: recover a skipSeal share through finalize(layer:swm)"
./scripts/devnet-test-seal-decouple.sh
echo "[#1585] phase 2/3: create named-KA lifecycle residue"
pnpm test:devnet:ka-lifecycle-cli
echo "[#1585] phase 3/3: run subgraph publish/RS against the same residue"
pnpm test:devnet:pr1385-subgraph-rs
echo "[#1585] PASS: skipSeal recovery and order-stressed named publish preserved exact SWM scope"
