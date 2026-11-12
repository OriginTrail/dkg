// SPDX-License-Identifier: Apache-2.0

/**
 * The work a live switch or a start-up leaves to the builder, per backend:
 * at most one pending kind per read graph, and a later request replaces an
 * earlier one of the other kind.
 * - `drop`: a read graph out of service because its mode is `off`, with
 *   contents and a state row still in the store. A live switch to `off`
 *   (`./live-modes.ts`) and a start-up that finds rows it does not maintain
 *   (`./startup.ts`) ask for it. The builder removes it while its mode stays
 *   `off` (`removeReadGraph`).
 * - `build`: a read graph a live switch on could not take into service, which
 *   the node may not list among the read graphs it wants. The builder builds
 *   it while its mode stays on, which takes it into service.
 * The builder forgets a read graph's work once the job ends, or once its mode
 * no longer asks for it. The work is kept in memory only: after a restart,
 * the start-up finds the rows again.
 */

import type { ReadGraphBackendRuntime } from './runtime.js';

export type ReadGraphWorkKind = 'build' | 'drop';

const PENDING = new WeakMap<ReadGraphBackendRuntime, Map<string, ReadGraphWorkKind>>();

/** Ask the builder for work on read graphs of a backend. */
export function requestReadGraphWork(runtime: ReadGraphBackendRuntime, kind: ReadGraphWorkKind, readGraphs: Iterable<string>): void {
  let pending = PENDING.get(runtime);
  if (!pending) PENDING.set(runtime, pending = new Map());
  for (const readGraph of readGraphs) pending.set(readGraph, kind);
}

/** The read graphs whose work of `kind`, or of either kind, was asked for and has not ended. */
export function readGraphWork(runtime: ReadGraphBackendRuntime, kind?: ReadGraphWorkKind): readonly string[] {
  return [...(PENDING.get(runtime) ?? [])].filter(([, pending]) => kind === undefined || pending === kind).map(([readGraph]) => readGraph);
}

/** Forget a read graph's work: of `kind` only when given, so a newer request of the other kind stays. */
export function forgetReadGraphWork(runtime: ReadGraphBackendRuntime, readGraph: string, kind?: ReadGraphWorkKind): void {
  const pending = PENDING.get(runtime);
  if (pending && (kind === undefined || pending.get(readGraph) === kind)) pending.delete(readGraph);
}
