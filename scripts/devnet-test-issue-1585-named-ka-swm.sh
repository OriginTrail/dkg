#!/usr/bin/env bash
# Live order-stress regression for #1585. Three suites run back to back on one
# running devnet, so that each one meets the state the one before left behind:
#
#   1. devnet-test-seal-decouple.sh: a draft is sealed and shared on a graph
#      that was never registered, and publishing registers it. (This phase used
#      to prove a skipSeal share and its seal-in-SWM recovery; both were removed
#      with graph-scoped Knowledge Assets, and the script now holds their
#      refusals instead.)
#   2. the named-KA lifecycle suite (pnpm test:devnet:ka-lifecycle-cli), which
#      leaves lifecycle residue: shared-only, re-opened, queued and published
#      assets, in the root graph and in a sub-graph.
#   3. the sub-graph publish and random-sampling suite
#      (pnpm test:devnet:pr1385-subgraph-rs) against that residue.
#
# A legacy-bucket/exact-scope mismatch fails phase 1; a family-wide named
# publish bundles or stomps co-resident state in phase 3.
#
# Needs a six-node devnet whose nodes accept queued publications, which is how
# the release process starts it: DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh
# start 6. Phase 2 queues publications; on a devnet started without that
# variable every one of them is refused, so the script does not start.
#
# Exit codes: 0 = all three phases passed, 3 = did not run (no devnet, or its
# nodes have no publisher wallet), other non-zero = a phase failed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
skip() { echo "[#1585] SKIP: $*"; exit 3; }

[[ -d "$DEVNET_DIR/node1" ]] || skip "no devnet at $DEVNET_DIR; start one first: DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6"
# shellcheck source=devnet-lib.sh
. "$ROOT/scripts/devnet-lib.sh"
status="$(api 1 GET /api/status)"
[[ "$(code_of "$status")" == 200 ]] || skip "node 1 does not answer /api/status"
[[ "$(field "$(body_of "$status")" asyncPublisher.available)" == true ]] \
  || skip "node 1 accepts no queued publication ($(field "$(body_of "$status")" asyncPublisher.reason)); start the devnet with DEVNET_ENABLE_PUBLISHER=1"

echo "[#1585] phase 1/3: seal and publish on a never-registered graph"
./scripts/devnet-test-seal-decouple.sh
echo "[#1585] phase 2/3: create named-KA lifecycle residue"
pnpm test:devnet:ka-lifecycle-cli
echo "[#1585] phase 3/3: run subgraph publish/RS against the same residue"
pnpm test:devnet:pr1385-subgraph-rs
echo "[#1585] PASS: the three suites passed in order on one devnet; named publish preserved exact SWM scope"
