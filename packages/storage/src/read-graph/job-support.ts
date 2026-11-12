// SPDX-License-Identifier: Apache-2.0

/** Small helpers of the read-graph jobs (`./rebuild.ts`). */

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '../triple-store.js';
import type { ReadGraphBatching } from './rebuild.js';
import type { InMemoryReadGraphStateMirror } from './runtime.js';
import type { ReadGraphStateRow } from './state.js';
import type { ReadGraphFence } from './statements.js';

export function fenceOf(row: ReadGraphStateRow): ReadGraphFence {
  return { state: row.state, generation: row.generation };
}

export function setMirror(mirror: InMemoryReadGraphStateMirror, readGraph: string, row: ReadGraphStateRow | undefined): void {
  if (row) mirror.set(row);
  else mirror.remove(readGraph);
}

export function sameRow(left: ReadGraphStateRow | undefined, right: ReadGraphStateRow | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.readGraph === right.readGraph && left.state === right.state && left.generation === right.generation
    && left.ruleVersion === right.ruleVersion && left.builderVersion === right.builderVersion;
}

/** Halve a batch that took more than its target time; double one that took under a quarter of it. */
export function nextBatchSize(size: number, elapsedMs: number, batching: ReadGraphBatching): number {
  if (elapsedMs > batching.targetBatchMs) return Math.max(1, Math.floor(size / 2));
  return elapsedMs < batching.targetBatchMs / 4 ? Math.min(batching.maxGraphsPerBatch, size * 2) : size;
}

export function foregroundQueued(store: TripleStore): boolean {
  const pressure = store.getPressureSnapshot?.();
  return pressure !== undefined && pressure.normalQueued + pressure.ackQueued + (pressure.healthQueued ?? 0) > 0;
}

export function isSafeName(graph: string): boolean {
  try {
    assertSafeIri(graph);
    return true;
  } catch {
    return false;
  }
}
