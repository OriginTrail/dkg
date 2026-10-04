// SPDX-License-Identifier: Apache-2.0
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';

/** Preserve atomic subject capabilities and mutation invalidation through the agent facade. */
export function atomicSubjectMutationFacade(
  inner: TripleStore,
  run: (operation: 'replaceSubject' | 'replaceSubjectPredicates', graph: string, subject: string,
    quads: Quad[], execute: () => Promise<void>) => Promise<void>,
): Pick<TripleStore, 'replaceSubject' | 'replaceSubjectPredicates'> {
  return {
    // #1863 — the async-lift publisher persists a job transition via this atomic
    // single-subject replace. Preserve the optional capability through the agent
    // decorator just like replaceGraph/replaceGraphAndSubject/update; omitting it
    // makes every capable production backend appear unsupported, so the publisher
    // silently falls back to non-atomic delete-then-insert and the fix is a no-op.
    replaceSubject: inner.replaceSubject ? (graph, subject, quads, options) =>
      run('replaceSubject', graph, subject, quads, () => inner.replaceSubject!(graph, subject, quads, options)) : undefined,
    replaceSubjectPredicates: inner.replaceSubjectPredicates
      ? (graph: string, subject: string, predicates: readonly string[], quads: Quad[], options?: QueryOptions) =>
        run('replaceSubjectPredicates', graph, subject, quads, () => inner.replaceSubjectPredicates!(graph, subject, predicates, quads, options))
      : undefined,
  };
}
