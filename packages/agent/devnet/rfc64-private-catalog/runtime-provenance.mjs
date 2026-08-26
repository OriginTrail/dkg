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

/**
 * Collect the exact fixed-topology shutdown receipts used by the live gate.
 * Evidence becomes available only through a successful provenance-aware stop;
 * callers cannot accidentally seal mutable child side state or omit a role.
 */
export function createRfc64PrivateRuntimeEvidenceCollectorV1(sourceBuild) {
  const expectedIds = new Set(RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1);
  const evidenceById = new Map();
  return Object.freeze({
    record(id, shutdownReceipt) {
      if (!expectedIds.has(id)) {
        throw new Error(`RFC-64 private runtime evidence has unknown process id: ${id}`);
      }
      if (evidenceById.has(id)) {
        throw new Error(`RFC-64 private runtime evidence already recorded process: ${id}`);
      }
      const loaded = shutdownReceipt?.executedRuntimeManifest;
      if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
        throw new Error(`${id}: shutdown receipt did not contain executed runtime provenance`);
      }
      evidenceById.set(id, Object.freeze({ id, loaded }));
    },
    seal() {
      const processes = RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.map((id) => {
        const evidence = evidenceById.get(id);
        if (evidence === undefined) {
          throw new Error(`RFC-64 private runtime evidence is missing process: ${id}`);
        }
        return evidence;
      });
      return buildRfc64PrivateRuntimeProvenanceV1(sourceBuild, processes);
    },
  });
}

export function assertRfc64PrivateRuntimeProvenanceV1(provenance) {
  return assertRuntimeProcessProvenanceV1(provenance, {
    processIds: RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
    schema: RFC64_PRIVATE_RUNTIME_PROVENANCE_SCHEMA_V1,
  });
}
