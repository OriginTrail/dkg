// SPDX-License-Identifier: Apache-2.0

import {
  assertRuntimeProcessProvenanceV1,
  buildRuntimeProcessProvenanceV1,
} from '../../../../devnet/rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';

export const RFC64_PRIVATE_RUNTIME_PROVENANCE_SCHEMA_V1 =
  'dkg-rfc64-private-runtime-provenance-v1';

export const RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1 = Object.freeze([
  'probe-owner',
  'probe-provider2',
  'probe-receiver',
  'probe-outsider',
  'owner',
  'provider2',
  'receiver',
  'outsider',
  'receiver-restart',
]);

export function buildRfc64PrivateRuntimeProvenanceV1(sourceBuild, processes) {
  return buildRuntimeProcessProvenanceV1({
    expectedProcessIds: RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
    processes,
    schema: RFC64_PRIVATE_RUNTIME_PROVENANCE_SCHEMA_V1,
    sourceBuild,
  });
}

export function assertRfc64PrivateRuntimeProvenanceV1(provenance) {
  return assertRuntimeProcessProvenanceV1(provenance, {
    processIds: RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
    schema: RFC64_PRIVATE_RUNTIME_PROVENANCE_SCHEMA_V1,
  });
}
