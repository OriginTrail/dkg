// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';

export const CONTEXT_GRAPH_READINESS_VERSION = 1;

export interface ContextGraphReadinessPatch {
  durableVerified: boolean;
  sharedMemoryVerified: boolean;
}

export interface ContextGraphPlaneEvidence {
  /** Counts toward this bounded job's observed completion. */
  ready: boolean;
  /** Strong enough to become sticky subscription readiness. */
  persistable: boolean;
}

export const NO_CONTEXT_GRAPH_PLANE_EVIDENCE: ContextGraphPlaneEvidence = Object.freeze({
  ready: false, persistable: false,
});
export type ContextGraphIndependentPlaneEvidence = Readonly<Partial<Record<
  'durable' | 'sharedMemory', ContextGraphPlaneEvidence
>>>;

/** Independent sources can prove one plane without borrowing another plane's evidence. */
export function composeContextGraphPlaneEvidence(
  first: ContextGraphPlaneEvidence,
  second: ContextGraphPlaneEvidence,
): ContextGraphPlaneEvidence {
  return {
    ready: first.ready || second.ready,
    persistable: first.persistable || second.persistable,
  };
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

/** Combine independent plane proofs without importing a peer job result. */
export function reduceContextGraphPlaneEvidence(
  previous: ContextGraphReadinessProvenance,
  evidence: Readonly<{
    durable: ContextGraphPlaneEvidence;
    sharedMemory: ContextGraphPlaneEvidence;
  }>,
): Readonly<{
  observed: ContextGraphReadinessPatch;
  persisted: ContextGraphReadinessPatch;
  writeReady: boolean;
}> {
  const observed = mergeContextGraphPlaneEvidence(previous, {
    durableVerified: evidence.durable.ready,
    sharedMemoryVerified: evidence.sharedMemory.ready,
  });
  const persisted = mergeContextGraphPlaneEvidence(previous, {
    durableVerified: evidence.durable.persistable,
    sharedMemoryVerified: evidence.sharedMemory.persistable,
  });
  return {
    observed,
    persisted,
    writeReady: persisted.durableVerified || persisted.sharedMemoryVerified,
  };
}
