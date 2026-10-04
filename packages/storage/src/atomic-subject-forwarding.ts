// SPDX-License-Identifier: Apache-2.0
import { UnsupportedTripleStoreCapabilityError } from './unsupported-capability-error.js';
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
