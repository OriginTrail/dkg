// SPDX-License-Identifier: Apache-2.0

/**
 * The read graphs of a backend to drop: out of service because their mode is
 * `off`, with contents and a state row still in the store. A live switch to
 * `off` (`./live-modes.ts`) and a start-up that finds rows it does not
 * maintain (`./startup.ts`) ask for them. The builder removes each one while
 * its mode stays `off` (`removeReadGraph`), and forgets one whose mode is on
 * again. They are kept in memory only: after a restart, the start-up finds the
 * rows again.
 */

import type { ReadGraphBackendRuntime } from './runtime.js';

const REQUESTED = new WeakMap<ReadGraphBackendRuntime, Set<string>>();

/** Ask the builder to drop read graphs of a backend. */
export function requestReadGraphDrops(runtime: ReadGraphBackendRuntime, readGraphs: Iterable<string>): void {
  let requested = REQUESTED.get(runtime);
  if (!requested) REQUESTED.set(runtime, requested = new Set());
  for (const readGraph of readGraphs) requested.add(readGraph);
}

/** The read graphs whose drop was asked for and has not ended. */
export function readGraphDropRequests(runtime: ReadGraphBackendRuntime): readonly string[] {
  return [...(REQUESTED.get(runtime) ?? [])];
}

/** Forget the drop of a read graph: it ended, or its mode is on again. */
export function forgetReadGraphDropRequest(runtime: ReadGraphBackendRuntime, readGraph: string): void {
  REQUESTED.get(runtime)?.delete(readGraph);
}
