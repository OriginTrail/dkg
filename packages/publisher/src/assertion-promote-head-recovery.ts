// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri, GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import type { GraphManager, TripleStore } from '@origintrail-official/dkg-storage';
import { workspaceOperationSubject, workspaceKnowledgeAssetHeadSubject } from './workspace-metadata-subjects.js';
import type { AssertionPromoteSourceContext } from './assertion-promote-source.js';

/**
 * A replay can delete its old operation metadata before a not-started insertion.
 * Admit only that missing operation: the caller has validated the complete SWM
 * seal and immutable durable intent, and holds the KA SWM lock. A partial row,
 * extra alias, changed version or graph is still corruption. This proof does not
 * expose completion; the normal durable tail must restore metadata and the head.
 */
export async function isInterruptedOwnPromoteHead(
  store: TripleStore, graphManager: GraphManager, context: AssertionPromoteSourceContext, operationId: string,
): Promise<boolean> {
  const graph = graphManager.sharedMemoryMetaUri(context.contextGraphId, context.subGraphName);
  const subject = workspaceKnowledgeAssetHeadSubject(context.contentScope.ual);
  const operation = workspaceOperationSubject(context.contextGraphId, operationId);
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(graph)}> {
    { <${assertSafeIri(subject)}> ?p ?o . BIND(<${assertSafeIri(subject)}> AS ?s) } UNION
    { <${assertSafeIri(operation)}> ?p ?o . BIND(<${assertSafeIri(operation)}> AS ?s) }
  } } LIMIT 6`);
  if (result.type !== 'bindings' || result.bindings.length !== 5) return false;
  const dkg = 'http://dkg.io/ontology/';
  const integer = (value: number | string) => `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
  const expected = new Map([
    [`${dkg}contentScopeVersion`, integer(GRAPH_KA_CONTENT_SCOPE_VERSION)],
    [`${dkg}kaUal`, context.contentScope.ual],
    [`${dkg}assertionVersion`, integer(context.contentScope.assertionVersion)],
    [`${dkg}assertionGraph`, context.swmGraphUri],
    [`${dkg}shareOperationId`, JSON.stringify(operationId)],
  ]);
  for (const row of result.bindings) {
    if (row['s'] !== subject || !expected.has(row['p']!) || expected.get(row['p']!) !== row['o']) return false;
    expected.delete(row['p']!);
  }
  return expected.size === 0;
}
