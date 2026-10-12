#!/usr/bin/env bash
#
# Retired devnet harness.
#
# This script drove four OT-RFC-39 / LU-11 scenarios (public sampling, curated
# single-chunk, curated multi-chunk, late-join chunk backfill) and in each one
# read the ciphertext chunk commitment of the publish from the chain
# (getLatestCiphertextChunksRoot / getCiphertextChunkCount). OT-RFC-49 replaced
# that commitment: a curated publish now commits the public `_catalog`, Cores
# hold no private ciphertext by default, and the contract no longer has the two
# getters. The script fails at that read in its first scenario on every build
# since the cutover.
#
# Its first three scenarios have successors that the comprehensive devnet run
# registers: devnet-test-rfc49-catalog-sampling.sh (curated publish and update,
# on-chain catalog commitment, custody on stripped and unstripped Cores, a
# Core's random-sampling proof) and devnet-test-random-sampling.sh (the public
# path). The fourth, a Core that was offline fetching the ciphertext chunks it
# missed before proving them, has none: a Core no longer proves chunks, and by
# default no longer holds any. This file remains as a visible guard for
# operators who still try the old harness name.

set -euo pipefail

cat >&2 <<'MSG'
[rfc39-comp] retired: the ciphertext-chunk commitment this harness read was replaced by the
[rfc39-comp] catalog commitment of OT-RFC-49. Run scripts/devnet-test-rfc49-catalog-sampling.sh
[rfc39-comp] and scripts/devnet-test-random-sampling.sh instead; do not re-enable this script
[rfc39-comp] without porting its scenarios to the catalog commitment.
MSG
exit 2
