#!/usr/bin/env bash
#
# Retired devnet harness.
#
# This stress test depended on pre-registration loose SWM writes. Loose SWM
# write routes are no longer part of the public API; supported writes now enter
# through the named knowledge-asset lifecycle. Byte-cap/rate-limit invariants
# are covered by the host-mode store and discovery-rate-limit tests.

set -euo pipefail

cat >&2 <<'MSG'
[cap] retired: this harness depended on removed pre-registration loose SWM writes.
[cap] Use named KA lifecycle share coverage plus host-mode byte-cap/rate-limit tests;
[cap] do not re-enable this script without porting the stressor to supported KA routes.
MSG
exit 2
