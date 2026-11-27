// SPDX-License-Identifier: Apache-2.0
import type { GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import { createGraphScopedDurablePrefix } from '../durable-prefix.js';
export { manifestGraphsAfter } from '../durable-prefix.js';
import { estimateQuadHeapBytes } from '../memory-telemetry.js';
import type { SyncPageProgress } from './page-fetch.js';

/**
 * How much one round of a full-graph durable DATA phase may hold.
 *
 * A rootless snapshot is a concatenation of exact graphs in manifest order, so
 * a round can end at any complete graph: the requester verifies and stores the
 * leading graphs, checkpoints that boundary, and the next round resumes there.
 * The soft limits end a round once it holds a graph it can checkpoint, so a
 * round holds at most the soft limits and one page once its first graph is
 * whole.
 *
 * That first graph is held whole whatever its size. Verification and the
 * atomic write take one asset at once, so a round that stopped inside it could
 * never make progress; its rows, up to the count it declares, are the round's
 * explicit allowance. The hard limits bound every other row the round holds.
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
 * The page boundary of one full-graph durable DATA round. It counts the rows a
 * round retains graph by graph, as the bounded planner does: the responder's
 * raw offset can run ahead of them when rows are filtered. After a page it
 * stops once the round reached a soft limit (or its recovery slice's soft
 * deadline) and holds a graph the planner keeps; it reads on while only its
 * first graph's rows are past the hard limits; otherwise it stops at a hard
 * limit, which therefore ends only a round with nothing to checkpoint. Once
 * every remaining graph is whole it reads on to the end of the phase, where
 * the last graph completes: no graph starts at the manifest's end to resume.
 *
 * Responders serve whole exact graphs in manifest order (both sides sort them
 * by code point). A row outside the first graph that arrives before that graph
 * is whole therefore means the responder lacks it, or sent rows the planner
 * rejects: no round could make progress from such rows, at any size.
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
  let prefix: ReturnType<typeof createGraphScopedDurablePrefix> | undefined;
  let firstGraphRows = 0;
  let firstGraphHeapBytes = 0;
  return (progress) => {
    prefix ??= createGraphScopedDurablePrefix(input.manifest, progress.resumedFromOffset);
    prefix.observe(progress.pageQuads);
    const first = prefix.graphs[0];
    for (const quad of progress.pageQuads) {
      if (quad.graph === first?.graph) { firstGraphRows += 1; firstGraphHeapBytes += estimateQuadHeapBytes(quad); }
    }
    const retained = prefix.prefix(progress.nextOffset, false);
    const checkpointable = retained !== null && !retained.allGraphsComplete && retained.completedGraphCount > 0;
    const due = progress.acceptedQuads >= budget.softRows
      || progress.acceptedHeapBytesEstimate >= budget.softHeapBytes
      || (input.settlementSliceDeadline !== undefined && now() >= input.settlementSliceDeadline);
    if (due && checkpointable) return true;
    if (
      !(first && firstGraphRows > first.rows)
      && progress.acceptedQuads - firstGraphRows < budget.maxRows
      && progress.acceptedHeapBytesEstimate - firstGraphHeapBytes < budget.maxHeapBytes
    ) return false;
    input.onHardLimit?.(progress);
    return true;
  };
}
