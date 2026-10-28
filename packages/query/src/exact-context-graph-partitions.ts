import { describeScopedContentGraph, assertionRegistrationCandidates } from './scoped-content-partition.js';
import { registeredSubGraphBranches } from './registered-sub-graphs.js';
import { registeredAssertionGraphPattern, CHILD_CONTEXT_GRAPH_PREDICATES, decodePartitionMetadataFact } from './partition-metadata-facts.js';
// SPDX-License-Identifier: Apache-2.0

import {
  assertSafeIri,
  contextGraphMetaUri,
  escapeSparqlLiteral,
} from '@origintrail-official/dkg-core';
import { asGraphWriteRevisionSource, type QueryResult, type TripleStore } from '@origintrail-official/dkg-storage';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { createScopedContentGraphRoutePolicy, isScopedRoutePartition } from './scoped-content-graph-policy.js';


const METADATA_BATCH_SIZE = 8;

interface ExactPartitionReads {
  query(sparql: string): Promise<QueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
}

/** Candidate facts are reloaded for every exact batch, even on external stores. */
export async function authorizeExactContextGraphPartitions(
  store: TripleStore,
  reads: ExactPartitionReads,
  policy: ReturnType<typeof createScopedContentGraphRoutePolicy>,
  candidates: readonly string[],
): Promise<{ allowed: string[]; assertUnchanged(): void }> {
  const { contextGraphId } = policy;
  const root = policy.rootGraph;
  const subGraph = policy.subGraphName;
  const metadata = new Set(policy.metadataGraphs);
  const visible = store.graphEnumerationVisibility?.bind(store);
  const enumerated = visible ? undefined : new Set(await reads.listGraphsByPrefix(root));
  const relevant = [...new Set(candidates)].filter(graph => {
    if (!(visible ? visible(graph) : enumerated!.has(graph))) return false;
    if (metadata.has(graph) || graph === root) return true;
    // Judge exclusions below the root, as inventory does, so a CG ID or subgraph named `staging` stays readable.
    return graph.startsWith(`${root}/`);
  });
  const names = new Set<string>();
  const assertionParents = new Set<string>();
  const childCandidates = new Set<string>();
  for (const graph of relevant) {
    if (metadata.has(graph) || graph === root) continue;
    const description = describeScopedContentGraph(graph, contextGraphId);
    if (!description) continue;
    if (!subGraph && description.subGraphName) names.add(description.subGraphName);
    if (description.kind === 'draft') {
      for (const parent of assertionRegistrationCandidates(graph)) assertionParents.add(parent);
    }
    // Only exact admission needs metadata for every possible child-CG ancestor.
    const parts = graph.slice(root.length + 1).split('/');
    for (let i = 0; i < parts.length; i++) childCandidates.add(`${root}/${parts.slice(0, i + 1).join('/')}`);
  }

  const revisionSource = asGraphWriteRevisionSource(store);
  const revisions = new Map<string, { generation: number; stable: boolean }>();
  const observe = (graph: string) => {
    if (revisionSource?.writeRevisionCoverage === 'all-writers' && !revisions.has(graph)) revisions.set(graph, revisionSource.getWriteRevision(graph));
  };
  const registeredNames = new Set(subGraph ? [subGraph] : []);
  const registeredAssertions = new Set<string>();
  const clauses = [
    ...(names.size ? registeredSubGraphBranches(contextGraphId).map(branch =>
      `{ ${branch} FILTER(STR(?name) IN (${[...names].map(name => `"${escapeSparqlLiteral(name)}"`).join(', ')})) }`) : []),
    ...(assertionParents.size ? [`{ ${registeredAssertionGraphPattern(contextGraphId)} VALUES ?assertionGraph {
      ${[...assertionParents].map(graph => `<${assertSafeIri(graph)}>`).join(' ')} } }`] : []),
  ];
  if (clauses.length) {
    observe(contextGraphMetaUri(contextGraphId));
    const result = await reads.query(`SELECT DISTINCT ?name ?assertionGraph WHERE { ${clauses.join(' UNION ')} }`);
    if (result.type !== 'bindings') throw new Error('Exact partition admission expected SELECT bindings');
    for (const row of result.bindings) {
      const fact = decodePartitionMetadataFact(row);
      if (fact.subGraphName && names.has(fact.subGraphName)) registeredNames.add(fact.subGraphName);
      if (fact.assertionGraph && assertionParents.has(fact.assertionGraph)) registeredAssertions.add(fact.assertionGraph);
    }
  }
  const children = new Set<string>();
  const childUris = [...childCandidates];
  for (let offset = 0; offset < childUris.length; offset += METADATA_BATCH_SIZE) {
    const batch = childUris.slice(offset, offset + METADATA_BATCH_SIZE);
    const branches = batch.map(uri => {
      const graph = assertSafeIri(`${uri}/_meta`);
      observe(graph);
      return CHILD_CONTEXT_GRAPH_PREDICATES.map(pattern =>
        `{ GRAPH <${graph}> { <${uri}> ${pattern} . } BIND(<${uri}> AS ?ctxGraph) }`).join(' UNION ');
    });
    const result = await reads.query(`SELECT DISTINCT ?ctxGraph WHERE { ${branches.join(' UNION ')} }`);
    if (result.type !== 'bindings') throw new Error('Exact partition child-CG admission expected SELECT bindings');
    for (const row of result.bindings) {
      const child = decodePartitionMetadataFact(row).childContextGraph;
      if (child && childCandidates.has(child)) children.add(child);
    }
  }
  return {
    allowed: relevant.filter(graph => isScopedRoutePartition(policy, graph,
      registeredNames, registeredAssertions, children)),
    assertUnchanged() {
      for (const [graph, before] of revisions) {
        const after = revisionSource!.getWriteRevision(graph);
        if (!before.stable || !after.stable || before.generation !== after.generation) throw new ScopedQueryViolationError('Exact partition admission changed during the read');
      }
    },
  };
}
