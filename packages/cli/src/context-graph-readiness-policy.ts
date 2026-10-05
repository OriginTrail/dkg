// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';

export const CONTEXT_GRAPH_READINESS_VERSION = 1;

export interface ContextGraphReadinessPatch {
  durableVerified: boolean;
  sharedMemoryVerified: boolean;
}

/** Merge independently proven planes while respecting the persisted version. */
export function mergeContextGraphPlaneEvidence(
  previous: ContextGraphReadinessProvenance,
  evidence: Readonly<ContextGraphReadinessPatch>,
): ContextGraphReadinessPatch {
  const verified = previous.version >= CONTEXT_GRAPH_READINESS_VERSION;
  return {
    durableVerified: evidence.durableVerified || (verified && previous.durableVerified),
    sharedMemoryVerified: evidence.sharedMemoryVerified || (verified && previous.sharedMemoryVerified),
  };
}
