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
 * reached, so a round holds at most the soft limits and one page once its
 * first graph is whole.
 *
 * That first graph is held whole whatever its size. Verification and the
 * atomic write take one asset at once, so a round that stopped inside it could
 * never make progress; the graph's declared row count is its explicit
 * allowance. The hard limits end a round that holds more rows than that graph
 * declares before it is whole, or rows past the manifest's end.
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

/** Where the first graph with rows after `resumedFromOffset` ends, if the manifest has one. */
export function manifestFirstGraphEnd(
  manifest: GraphScopedDurableManifestPlan,
  resumedFromOffset: number,
): number | undefined {
  let boundary = 0;
  for (const descriptor of manifest.descriptors) {
    boundary += descriptor.publicTripleCount;
    if (boundary > resumedFromOffset) return boundary;
  }
  return undefined;
}

/**
 * The page boundary of one full-graph durable DATA round: stop after a page
 * once the round reached a soft limit (or its recovery slice's soft deadline)
 * and holds a checkpointable graph; read on while the round is inside its
 * first graph; otherwise stop at a hard limit. A hard limit therefore ends
 * only a round that holds no checkpointable graph.
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
    const firstGraphEnd = manifestFirstGraphEnd(input.manifest, progress.resumedFromOffset);
    if (
      firstGraphEnd !== undefined
      && progress.nextOffset <= firstGraphEnd
      && progress.acceptedQuads <= firstGraphEnd - progress.resumedFromOffset
    ) return false;
    if (
      progress.acceptedQuads < budget.maxRows
      && progress.acceptedHeapBytesEstimate < budget.maxHeapBytes
    ) return false;
    input.onHardLimit?.(progress);
    return true;
  };
}
