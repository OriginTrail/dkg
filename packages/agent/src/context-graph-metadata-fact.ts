// SPDX-License-Identifier: Apache-2.0

import { SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri } from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

export interface ContextGraphMetadataFact {
  readonly predicate: string;
  readonly object: string;
  /**
   * Where the fact goes: `contextGraphMetadataGraphs` for a node that keeps
   * the graph's own record, `contextGraphMetadataHomeGraph` otherwise.
   */
  readonly graphs: readonly string[];
  /** Written in the same insert as the fact. */
  readonly alsoInsert?: readonly Quad[];
}

/**
 * Write a single-valued metadata fact of a Context Graph, such as its
 * on-chain id binding or its name. Earlier values are cleared from the
 * target graphs and from `ontology`, where a curated graph's fact must not
 * stay, so readers never see two values.
 */
export async function replaceContextGraphMetadataFact(
  store: TripleStore,
  contextGraphId: string,
  fact: ContextGraphMetadataFact,
): Promise<void> {
  const subject = contextGraphDataGraphUri(contextGraphId);
  const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  for (const graph of new Set([ontologyGraph, ...fact.graphs])) {
    await deleteByPatternWithoutCount(store, { graph, subject, predicate: fact.predicate });
  }
  await store.insert([
    ...fact.graphs.map((graph) => ({ subject, predicate: fact.predicate, object: fact.object, graph })),
    ...(fact.alsoInsert ?? []),
  ]);
}
