// SPDX-License-Identifier: Apache-2.0
import { UnsupportedTripleStoreCapabilityError } from './unsupported-capability-error.js';
import { isStoreOperationNotStarted } from './store-operation-outcome.js';
import type { Quad, QueryOptions, TripleStore } from './triple-store.js';

export type AtomicSubjectMutation = 'replaceSubject' | 'replaceSubjectPredicates';

/** Preserve capability refusal before decorator bookkeeping or backend dispatch. */
export function forwardAtomicSubjectMutation(
  inner: TripleStore, backend: string, graph: string, subject: string,
  predicates: readonly string[] | undefined, quads: Quad[], options: QueryOptions | undefined,
  run: (operation: AtomicSubjectMutation, execute: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const operation = predicates === undefined ? 'replaceSubject' : 'replaceSubjectPredicates';
  if (operation === 'replaceSubject') {
    const replace = inner.replaceSubject;
    if (typeof replace !== 'function') throw new UnsupportedTripleStoreCapabilityError(operation, backend);
    return run(operation, () => replace.call(inner, graph, subject, quads, options));
  }
  const replace = inner.replaceSubjectPredicates;
  if (typeof replace !== 'function') throw new UnsupportedTripleStoreCapabilityError(operation, backend);
  return run(operation, () => replace.call(inner, graph, subject, predicates!, quads, options));
}

/** Index maintenance must distinguish clean refusal from possibly committed dispatch. */
export async function runIndexedAtomicSubjectMutation(
  operation: AtomicSubjectMutation, execute: () => Promise<void>,
  index: { enabled: boolean; uncertain(): void; committed(): void; maintain(): Promise<void> },
): Promise<void> {
  if (!index.enabled) return execute();
  try { await execute(); }
  catch (error) {
    // A committed subject replace could add/remove the graph's first/last row;
    // dirty the index so a lazy rebuild re-derives membership — unless this was
    // a clean preflight capability refusal, where nothing was mutated.
    if (!isStoreOperationNotStarted(error, operation)) index.uncertain();
    throw error;
  }
  index.committed();
  await index.maintain();
}
