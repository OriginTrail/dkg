// SPDX-License-Identifier: Apache-2.0

import {
  ASSERTION_NAMED_GRAPH_PREFIX,
  assertSafeIri,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryMetaUri,
  contextGraphSharedMemoryUri,
  contextGraphSubGraphMetaUri,
  contextGraphSubGraphUri,
  escapeSparqlLiteral,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import { asGraphWriteRevisionSource, type QueryResult, type TripleStore } from '@origintrail-official/dkg-storage';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { isExcludedContentGraphTail, isScopedContentGraph } from './scoped-content-graph-policy.js';
import type { QueryOptions } from './query-engine.js';

const METADATA_BATCH_SIZE = 8;

interface ExactPartitionReads {
  query(sparql: string): Promise<QueryResult>;
}

/** Candidate facts are reloaded for every exact batch, even on external stores. */
export async function authorizeExactContextGraphPartitions(
  store: TripleStore,
  reads: ExactPartitionReads,
  contextGraphId: string,
  candidates: readonly string[],
  options: QueryOptions,
): Promise<{ allowed: string[]; assertUnchanged(): void }> {
  if (options.includePrivate) throw new ScopedQueryViolationError('Exact partition reads only admit public graphs');
  const root = assertSafeIri(contextGraphDataUri(contextGraphId));
  const subGraph = options.subGraphName;
  const dataGraph = subGraph ? contextGraphSubGraphUri(contextGraphId, subGraph) : root;
  const sharedGraph = contextGraphSharedMemoryUri(contextGraphId, subGraph);
  const swmOnly = options.graphSuffix === '_shared_memory';
  const metadata = new Set([
    ...(!swmOnly ? [contextGraphMetaUri(contextGraphId), ...(subGraph ? [contextGraphSubGraphMetaUri(contextGraphId, subGraph)] : [])] : []),
    contextGraphSharedMemoryMetaUri(contextGraphId, subGraph),
  ]);
  const staticContent = new Set([
    ...(!swmOnly ? [dataGraph] : []),
    ...(swmOnly || (options.includeSharedMemory ?? options.includeWorkspace) ? [sharedGraph] : []),
  ]);
  const relevant = [...new Set(candidates)].filter(graph => {
    if (metadata.has(graph) || graph === root) return true;
    return graph.startsWith(`${root}/`) && !graph.includes('/staging/')
      && !isExcludedContentGraphTail(graph.slice(root.length + 1));
  });
  const names = new Set<string>();
  const assertionParents = new Set<string>();
  const childCandidates = new Set<string>();
  for (const graph of relevant) {
    if (metadata.has(graph) || graph === root) continue;
    const tail = graph.slice(root.length + 1);
    const first = tail.split('/')[0];
    if (!subGraph && validateSubGraphName(first).valid) names.add(first);
    if (tail.startsWith('_working_memory/') || tail.includes('/_working_memory/')) {
      assertionParents.add(graph);
      let offset = graph.indexOf(ASSERTION_NAMED_GRAPH_PREFIX);
      while (offset >= 0) {
        assertionParents.add(graph.slice(0, offset));
        offset = graph.indexOf(ASSERTION_NAMED_GRAPH_PREFIX, offset + ASSERTION_NAMED_GRAPH_PREFIX.length);
      }
    }
    // Only a candidate's canonical ancestors can own that graph as a child CG.
    const parts = tail.split('/');
    for (let length = 1; length <= parts.length; length++) childCandidates.add(`${root}/${parts.slice(0, length).join('/')}`);
  }

  const revisionSource = asGraphWriteRevisionSource(store);
  const revisions = new Map<string, { generation: number; stable: boolean }>();
  const observe = (graph: string) => {
    if (revisionSource?.writeRevisionCoverage === 'all-writers' && !revisions.has(graph)) revisions.set(graph, revisionSource.getWriteRevision(graph));
  };
  const registeredNames = new Set(subGraph ? [subGraph] : []);
  const registeredAssertions = new Set<string>();
  const clauses = [
    ...(names.size ? [`{ VALUES ?requestedName { ${[...names].map(name => `"${escapeSparqlLiteral(name)}"`).join(' ')} } ?subGraph a <http://dkg.io/ontology/SubGraph> ; <http://schema.org/name> ?name . FILTER(STR(?name) = ?requestedName) }`] : []),
    ...(assertionParents.size ? [`{ ?assertion <http://dkg.io/ontology/assertionGraph> ?graph . VALUES ?graph { ${[...assertionParents].map(graph => `<${assertSafeIri(graph)}>`).join(' ')} } }`] : []),
  ];
  if (clauses.length) {
    const graph = contextGraphMetaUri(contextGraphId);
    observe(graph);
    const result = await reads.query(`SELECT DISTINCT ?name ?graph WHERE { GRAPH <${graph}> { ${clauses.join(' UNION ')} } }`);
    if (result.type !== 'bindings') throw new Error('Exact partition admission expected SELECT bindings');
    for (const row of result.bindings) {
      const name = row.name?.replace(/^"/, '').replace(/"(?:\^\^<[^>]+>|@[a-zA-Z-]+)?$/, '');
      if (name && names.has(name)) registeredNames.add(name);
      if (row.graph && assertionParents.has(row.graph)) registeredAssertions.add(row.graph);
    }
  }
  const children = new Set<string>();
  const childUris = [...childCandidates];
  for (let offset = 0; offset < childUris.length; offset += METADATA_BATCH_SIZE) {
    const batch = childUris.slice(offset, offset + METADATA_BATCH_SIZE);
    const branches = batch.map(uri => {
      const graph = assertSafeIri(`${uri}/_meta`);
      observe(graph);
      return `{ GRAPH <${graph}> { { <${uri}> a <https://dkg.network/ontology#ContextGraph> } UNION { <${uri}> <https://dkg.network/ontology#registrationStatus> ?status } } BIND(<${uri}> AS ?ctxGraph) }`;
    });
    const result = await reads.query(`SELECT DISTINCT ?ctxGraph WHERE { ${branches.join(' UNION ')} }`);
    if (result.type !== 'bindings') throw new Error('Exact partition child-CG admission expected SELECT bindings');
    for (const row of result.bindings) if (row.ctxGraph && childCandidates.has(row.ctxGraph)) children.add(row.ctxGraph);
  }
  return {
    allowed: relevant.filter(graph => {
      if (metadata.has(graph)) return true;
      if ([...children].some(child => graph === child || graph.startsWith(`${child}/`))) return false;
      if (staticContent.has(graph)) return true;
      if (swmOnly) return graph.startsWith(`${sharedGraph}/`);
      return isScopedContentGraph(graph, contextGraphId, registeredNames, registeredAssertions, children, subGraph);
    }),
    assertUnchanged() {
      for (const [graph, before] of revisions) {
        const after = revisionSource!.getWriteRevision(graph);
        if (!before.stable || !after.stable || before.generation !== after.generation) throw new ScopedQueryViolationError('Exact partition admission changed during the read');
      }
    },
  };
}
