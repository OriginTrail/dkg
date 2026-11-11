#!/usr/bin/env bash
#
# Retired devnet harness.
#
# This script proved OT-RFC-39 / LU-11: a curated publish commits a ciphertext
# chunk root on chain (getLatestCiphertextChunksRoot / getCiphertextChunkCount)
# and a Core proves those chunks in random sampling. OT-RFC-49 replaced that
# commitment: a curated publish now commits the public `_catalog`, Cores hold
# no private ciphertext, and the contract no longer has the two getters this
# script reads. It fails at that read on every build since the cutover.
#
# The scenario it stood for (curated publish, on-chain commitment, a Core's
# random-sampling proof of it) is covered by
# devnet-test-rfc49-catalog-sampling.sh, which the comprehensive devnet run
# registers; devnet-test-random-sampling.sh covers the public path. This file
# remains as a visible guard for operators who still try the old harness name.

set -euo pipefail

cat >&2 <<'MSG'
[rfc39-validate] retired: the ciphertext-chunk commitment this harness read was replaced
[rfc39-validate] by the catalog commitment of OT-RFC-49. Run
[rfc39-validate] scripts/devnet-test-rfc49-catalog-sampling.sh instead; do not re-enable this
[rfc39-validate] script without porting it to the catalog commitment.
MSG
exit 2
