/**
 * The production lookup behind `LegacyAgentProfileGateV1` (#2052 D-8).
 *
 * A thin adapter and nothing more: it holds no policy, caches nothing, and decides
 * nothing. The gate owns the classification, storage owns the two bounded reads and both
 * of :926's byte caps, and this exists only because the gate must not import a storage
 * internal directly.
 *
 * MODE IS PASSED IN, NEVER DERIVED HERE. The projection mode has one home — the
 * materializer's `SystemRecordLaneActivationV1` — and a second copy of it living in the
 * agent package is exactly the defect the ruling on this slice forbids. So the type comes
 * from storage and the value comes from the caller; this module cannot invent one.
 */

import {
  readLegacyAgentProfileAppliedRootsV1,
  readLegacyAgentProfileProjectionV1,
  type SystemRecordMaterializationModeV1,
} from '@origintrail-official/dkg-storage/internal/system-record-legacy-gate-read-v1';
import type { TripleStore } from '@origintrail-official/dkg-storage';

import type { LegacyAgentProfileGateLookupV1 } from './legacy-profile-gate-v1.js';

export function createLegacyAgentProfileGateLookupV1(input: {
  readonly store: TripleStore;
  readonly networkId: string;
  readonly mode: SystemRecordMaterializationModeV1;
}): LegacyAgentProfileGateLookupV1 {
  const { store, networkId, mode } = input;
  return Object.freeze({
    lookupAppliedRoots: (roots: readonly string[], signal?: AbortSignal) =>
      readLegacyAgentProfileAppliedRootsV1({ store, networkId, mode, roots, signal }),
    lookupProjectionMembership: (subjects: readonly string[], signal?: AbortSignal) =>
      readLegacyAgentProfileProjectionV1({ store, mode, subjects, signal }),
  });
}
