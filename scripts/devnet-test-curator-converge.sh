#!/usr/bin/env bash
#
# Retired devnet harness.
#
# This scenario depended on the removed loose SWM in-place write routes. The
# supported product path is now the named knowledge-asset lifecycle:
# create/write/finalize/share, then vm/publish or vm/publish-async. Replacement
# coverage lives in the agent/CLI lifecycle tests and the RFC-49 named-KA devnet
# scripts; this file remains as a visible guard for operators who still try the
# old harness name.

set -euo pipefail

cat >&2 <<'MSG'
[curator-converge] retired: this harness depended on removed loose SWM write routes.
[curator-converge] Use named KA lifecycle convergence coverage instead; do not re-enable
[curator-converge] this script without porting the scenario to create/write/finalize/share/publish.
MSG
exit 2
