// SPDX-License-Identifier: Apache-2.0

import {
  GATE2_RUNTIME_EVIDENCE_PROFILE_V1,
  type Gate2ExecutedRuntimeManifestV1,
} from './runtime-provenance.ts';

const legacySourceCommit = process.env.DKG_RFC64_GATE2_RUNTIME_SOURCE_COMMIT;
if (process.env.DKG_RFC64_RUNTIME_SOURCE_COMMIT === undefined && legacySourceCommit !== undefined) {
  process.env.DKG_RFC64_RUNTIME_SOURCE_COMMIT = legacySourceCommit;
}

const { sealExecutedRuntimeManifestV1 } = await import('../rfc64-runtime-load-hook.mts');

/** Gate 2 compatibility wrapper around the neutral loader hook. */
export function sealGate2ExecutedRuntimeManifestV1(): Readonly<Gate2ExecutedRuntimeManifestV1> {
  return sealExecutedRuntimeManifestV1(
    GATE2_RUNTIME_EVIDENCE_PROFILE_V1,
  ) as Readonly<Gate2ExecutedRuntimeManifestV1>;
}
