// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import type { SyncPageProgress } from './page-fetch.js';

/**
 * How much one round of a full-graph durable DATA phase may hold.
 *
 * A rootless snapshot is a concatenation of exact graphs in manifest order, so
 * a round can end at any complete graph: the requester verifies and stores the
 * leading graphs, checkpoints that boundary, and the next round resumes there.
 * The soft limits end a round at the first such boundary after either is
 * reached. The hard limits end it even without one: the round then makes no
 * progress, but it never grows past them. One legal asset (at most 100,000
 * rows in its 4 MiB envelope) plus one page always fits between the two, so a
 * round that reaches its soft limit inside the largest asset can still finish
 * that asset.
 */
export interface DurableDataRoundBudget {
  readonly softRows: number;
  readonly softHeapBytes: number;
  readonly maxRows: number;
  readonly maxHeapBytes: number;
}

export const DEFAULT_DURABLE_DATA_ROUND_BUDGET: DurableDataRoundBudget = Object.freeze({
  softRows: 131_072,
  softHeapBytes: 64 * 1024 * 1024,
  maxRows: 262_144,
  maxHeapBytes: 128 * 1024 * 1024,
});

/**
 * Whether the rows in (resumedFromOffset, nextOffset] hold a complete graph
 * that an incomplete round keeps: a graph boundary strictly inside the range.
 * An incomplete round never checkpoints a final graph that ends exactly at the
 * stop offset (the next round must receive at least one verified graph), so
 * stopping there with only that graph would replay it and make no progress.
 */
export function manifestHasCheckpointableGraph(
  manifest: GraphScopedDurableManifestPlan,
  resumedFromOffset: number,
  nextOffset: number,
): boolean {
  let boundary = 0;
  for (const descriptor of manifest.descriptors) {
    boundary += descriptor.publicTripleCount;
    if (boundary >= nextOffset) return false;
    if (boundary > resumedFromOffset) return true;
  }
  return false;
}

/**
 * The page boundary of one full-graph durable DATA round: stop after a page
 * once the round reached a soft limit (or its recovery slice's soft deadline)
 * and holds a checkpointable graph, or once it reached a hard limit. A hard
 * limit therefore ends only a round that holds no checkpointable graph.
 */
export function createDurableDataRoundBoundary(input: {
  readonly manifest: GraphScopedDurableManifestPlan;
  /** Soft wall-clock end of a recovery slice, when the caller has one. */
  readonly settlementSliceDeadline?: number;
  readonly budget?: DurableDataRoundBudget;
  /** Called once, when a hard limit ends the round. */
  readonly onHardLimit?: (progress: SyncPageProgress) => void;
  readonly now?: () => number;
}): (progress: SyncPageProgress) => boolean {
  const budget = input.budget ?? DEFAULT_DURABLE_DATA_ROUND_BUDGET;
  const now = input.now ?? Date.now;
  return (progress) => {
    const due = progress.acceptedQuads >= budget.softRows
      || progress.acceptedHeapBytesEstimate >= budget.softHeapBytes
      || (input.settlementSliceDeadline !== undefined && now() >= input.settlementSliceDeadline);
    if (due && manifestHasCheckpointableGraph(
      input.manifest,
      progress.resumedFromOffset,
      progress.nextOffset,
    )) return true;
    if (
      progress.acceptedQuads < budget.maxRows
      && progress.acceptedHeapBytesEstimate < budget.maxHeapBytes
    ) return false;
    input.onHardLimit?.(progress);
    return true;
  };
}
