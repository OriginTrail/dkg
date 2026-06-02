#!/usr/bin/env bash
#
# Post-rc.12 node-ui devnet subset.
#
# This is intentionally narrower than the full Playwright devnet suite:
# it targets the live-daemon surfaces touched by #847/#855/#877/#890/#898/#899
# without turning the release gate into a full UI soak.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_NODE="${DEVNET_NODE:-1}"

cd "$REPO_ROOT/packages/node-ui"

PWTEST_DEVNET=1 DEVNET_NODE="$DEVNET_NODE" pnpm exec playwright test \
  --project=devnet-ui \
  e2e/specs/devnet/cg-variants.devnet.spec.ts \
  e2e/specs/devnet/wm-swm-vm-lifecycle.devnet.spec.ts \
  e2e/specs/devnet/publishing-lifecycle.devnet.spec.ts
