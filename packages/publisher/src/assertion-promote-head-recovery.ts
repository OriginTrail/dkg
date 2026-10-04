// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { GraphManager, TripleStore } from '@origintrail-official/dkg-storage';
import { workspaceOperationSubject } from './workspace-metadata-subjects.js';
import { knowledgeAssetWorkspaceHeadRows } from './workspace-head-rows.js';
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
  const expectedRows = knowledgeAssetWorkspaceHeadRows({ graphManager, contextGraphId: context.contextGraphId,
    kaUal: context.contentScope.ual, assertionVersion: context.contentScope.assertionVersion,
    shareOperationId: operationId, subGraphName: context.subGraphName });
  const subject = expectedRows[0]!.subject;
  const operation = workspaceOperationSubject(context.contextGraphId, operationId);
  const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(graph)}> {
    { <${assertSafeIri(subject)}> ?p ?o . BIND(<${assertSafeIri(subject)}> AS ?s) } UNION
    { <${assertSafeIri(operation)}> ?p ?o . BIND(<${assertSafeIri(operation)}> AS ?s) }
  } } LIMIT ${expectedRows.length + 1}`);
  if (result.type !== 'bindings' || result.bindings.length !== expectedRows.length) return false;
  const expected = new Map(expectedRows.map(row => [row.predicate, row.object]));
  for (const row of result.bindings) {
    if (row['s'] !== subject || !expected.has(row['p']!) || expected.get(row['p']!) !== row['o']) return false;
    expected.delete(row['p']!);
  }
  return expected.size === 0;
}
