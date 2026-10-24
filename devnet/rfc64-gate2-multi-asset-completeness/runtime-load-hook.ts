// SPDX-License-Identifier: Apache-2.0

import {
  GATE2_RUNTIME_EVIDENCE_V1,
  type Gate2ExecutedRuntimeManifestV1,
} from './runtime-provenance.ts';

const legacySourceCommit = process.env.DKG_RFC64_GATE2_RUNTIME_SOURCE_COMMIT;
if (process.env.DKG_RFC64_RUNTIME_SOURCE_COMMIT === undefined && legacySourceCommit !== undefined) {
  process.env.DKG_RFC64_RUNTIME_SOURCE_COMMIT = legacySourceCommit;
}

const { createExecutedRuntimeManifestSealerV1 } = await import(
  '../rfc64-runtime-load-hook.mts'
);
const sealGate2Runtime = createExecutedRuntimeManifestSealerV1(
  GATE2_RUNTIME_EVIDENCE_V1,
);

/** Gate 2 compatibility wrapper around the neutral loader hook. */
export function sealGate2ExecutedRuntimeManifestV1(): Readonly<Gate2ExecutedRuntimeManifestV1> {
  return sealGate2Runtime();
}
