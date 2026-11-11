#!/usr/bin/env bash
#
# Retired devnet harness.
#
# This script proved that a member's explicit shared-memory recovery
# (POST /api/context-graph/recover-shared-memory) REPLACES a stale value with
# the owner's current one instead of keeping both. It modelled the owner's
# update as a second shared asset holding the same subject with a new value.
#
# Under graph-scoped Knowledge Assets that is not an update. Each named asset
# keeps its own shared-memory graph, so the owner itself reads both values. A
# shared asset that is re-opened can only gain statements, and a value is
# replaced by updating the published asset. The scenario has no stale value
# left to replace, and the script fails at its own precondition ("owner not at
# v2") on every current build. It also stopped the member with
# `devnet.sh stop <N>`, which stops the WHOLE devnet, and restarted it with a
# command that does not exist, falling back to `devnet.sh start 2`, which wipes
# every node: it could not run on a devnet shared with other suites.
#
# Where the behaviour is covered now: the exact replacement of a stale copy on
# a member that was offline during an update is asserted by
# devnet-test-rfc49-catalog-sampling.sh (the member's verified memory after the
# update it missed), which the comprehensive devnet run registers. The
# recovery function behind the route is covered by the agent package's tests
# (swm-recovery, sync-policy, durable-sync-lifecycle-binding). The HTTP route
# itself has no devnet test. This file remains as a visible guard for operators
# who still try the old harness name.

set -euo pipefail

cat >&2 <<'MSG'
[swm-rec] retired: this harness modelled an update as a second shared asset with the same
[swm-rec] subject, which graph-scoped Knowledge Assets keep side by side, and it stopped the
[swm-rec] whole devnet to stop one node. See the header for where the behaviour is covered;
[swm-rec] do not re-enable this script without a scenario that replaces a value in shared memory.
MSG
exit 2
