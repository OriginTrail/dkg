// SPDX-License-Identifier: Apache-2.0

/**
 * Registry fences. Where only a read after a registry write tells what it
 * changed, the layer takes the ready read graphs of the write's context graphs
 * out of service until that read, in the backend's mirror only: no query
 * takes a union that the store's new registry may no longer give. Lifting a
 * fence puts back each read graph it still holds. An explicit dirty mark ends
 * a fence, and that read graph stays out of service.
 */

import { parseReadGraphIri } from '@origintrail-official/dkg-core';
import { readGraphMembership, type ReadGraphRegistrySnapshot } from './membership.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
import { nextReadGraphState, type ReadGraphStateRow } from './state.js';

/** A ready row taken out of service in the mirror while a registry write runs, and the row it was. */
export interface ReadGraphFence {
  readonly row: ReadGraphStateRow;
  readonly fence: ReadGraphStateRow;
}

/** The fences registry writes have set on each backend's read graphs and not lifted, by read graph. */
const ACTIVE_FENCES = new WeakMap<ReadGraphBackendRuntime, Map<string, ReadGraphStateRow>>();

function activeFences(runtime: ReadGraphBackendRuntime): Map<string, ReadGraphStateRow> {
  let fences = ACTIVE_FENCES.get(runtime);
  if (!fences) {
    fences = new Map();
    ACTIVE_FENCES.set(runtime, fences);
  }
  return fences;
}

/** Take the ready ones of `readGraphs` out of service, in the mirror only, and return what to put back. */
export function fenceReadGraphs(runtime: ReadGraphBackendRuntime, readGraphs: readonly string[]): ReadGraphFence[] {
  return readGraphs.flatMap((readGraph) => {
    const row = runtime.mirror.get(readGraph);
    if (row?.state !== 'ready') return [];
    const fence = nextReadGraphState(row, { kind: 'mark-dirty' })!;
    runtime.mirror.set(fence);
    activeFences(runtime).set(readGraph, fence);
    return [{ row, fence }];
  });
}

/**
 * Put back each fenced read graph the mirror still holds as fenced: in
 * service again where its membership is the same under the registry from
 * before the write (`before`) and the one now cached, and as it was before
 * the fence otherwise, for a mark from its row. A refresh that moved a
 * membership has marked that read graph already.
 */
export function liftReadGraphFences(
  runtime: ReadGraphBackendRuntime,
  fences: readonly ReadGraphFence[],
  before: ReadGraphRegistrySnapshot | undefined,
): void {
  const identity = runtime.workingMemoryIdentity;
  for (const { row, fence } of fences) {
    // A mark since the fence was set made the read graph dirty for good.
    if (activeFences(runtime).get(row.readGraph) !== fence) continue;
    activeFences(runtime).delete(row.readGraph);
    const current = runtime.mirror.get(row.readGraph);
    if (!current || current.state !== fence.state || current.generation !== fence.generation) continue;
    const key = parseReadGraphIri(row.readGraph);
    const after = key ? runtime.registries.get(key.scope.contextGraphId) : undefined;
    const kept = before !== undefined && after !== undefined && key !== undefined
      && JSON.stringify(readGraphMembership(key, before, identity)) === JSON.stringify(readGraphMembership(key, after, identity));
    if (kept || before === undefined) runtime.mirror.set(row);
  }
}

/** End the fences on `readGraphs`: they were marked dirty, and stay out of service. */
export function endReadGraphFences(runtime: ReadGraphBackendRuntime, readGraphs: Iterable<string>): void {
  for (const readGraph of readGraphs) activeFences(runtime).delete(readGraph);
}
