import { formatSparqlTerm } from '@origintrail-official/dkg-core';
// SPDX-License-Identifier: Apache-2.0

import { deleteByPatternWithoutCount, tryUpdateWithTouchedGraphs, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { buildNamedKaVmLifecycleMutation, type PublishedNamedKaVmLifecycleInput } from './internal/named-ka-vm-lifecycle-mutation.js';
import type { ObservedStoreMutation } from './internal/observed-store-mutation.js';

export type { PublishedNamedKaVmLifecycleInput } from './internal/named-ka-vm-lifecycle-mutation.js';
export type PublishedNamedKaVmLifecycleWriter = (input: PublishedNamedKaVmLifecycleInput) => Promise<void>;

async function applyOrderedReplacements(store: TripleStore, replacements: readonly Quad[]): Promise<void> {
  for (const quad of replacements) {
    await deleteByPatternWithoutCount(store, {
      subject: quad.subject, predicate: quad.predicate, graph: quad.graph,
    });
    await store.insert([quad]);
  }
}

/** Explicit compatibility writer; no store-identity discovery or wrapper traversal. */
export async function applyPublishedNamedKaVmLifecycle(
  store: TripleStore,
  input: PublishedNamedKaVmLifecycleInput,
): Promise<void> {
  await applyOrderedReplacements(store, buildNamedKaVmLifecycleMutation(input).replacements);
}

/** Compose over the configured decorated store and its observed fallback at agent construction. */
export function createPublishedNamedKaVmLifecycleWriter({ updateStore, fallbackStore, executeMutation }: {
  readonly updateStore: TripleStore;
  readonly fallbackStore: TripleStore;
  readonly executeMutation: ObservedStoreMutation;
}): PublishedNamedKaVmLifecycleWriter {
  return async input => {
    // Query and observer scope have one closed, validated source of truth.
    const plan = buildNamedKaVmLifecycleMutation(input);
    if (typeof updateStore.update === 'function' && await executeMutation(
      () => tryUpdateWithTouchedGraphs(updateStore, plan.sparql, [plan.graph], {
        source: 'agent.publish.namedKaVmLifecycle',
      }),
      updated => updated,
      plan.mutation,
      'update',
    )) return;
    // Only absent or typed unsupported capability reaches this ordered path.
    await applyOrderedReplacements(fallbackStore, plan.replacements);
  };
}

/** Completion requires every row from the writer's mutation, including its final fallback writes. */
export async function publishedNamedKaVmLifecycleMatches(store: TripleStore, input: PublishedNamedKaVmLifecycleInput): Promise<boolean> {
  const plan = buildNamedKaVmLifecycleMutation(input);
  const triples = plan.replacements.map(row => `${formatSparqlTerm(row.subject, { position: 'subject' })} ${formatSparqlTerm(row.predicate, { position: 'predicate' })} ${formatSparqlTerm(row.object, { position: 'object' })} .`).join(' ');
  const result = await store.query(`ASK { GRAPH ${formatSparqlTerm(plan.graph, { position: 'graph' })} { ${triples} } }`,
    { source: 'agent.publish.namedKaVmLifecycle.complete' });
  return result.type === 'boolean' && result.value;
}
