// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { readAuthenticatedWorkspaceOperations } from './workspace-operation-alias.js';
import { workspaceKnowledgeAssetHeadSubject, normalizeWorkspaceSubGraphName } from './workspace-metadata-subjects.js';
import type { ResolveKnowledgeAssetWorkspaceHeadParams } from './workspace-resolution.js';

/** One snapshot acquires a head and its exact referenced operation class. */
export async function acquireKnowledgeAssetWorkspaceHead(params: ResolveKnowledgeAssetWorkspaceHeadParams) {
  const scope = createGraphKnowledgeAssetScope(params.kaUal, 1);
  const metaGraph = params.graphManager.sharedMemoryMetaUri(params.contextGraphId, normalizeWorkspaceSubGraphName(params.subGraphName));
  const subject = workspaceKnowledgeAssetHeadSubject(scope.ual);
  // ONE query acquires every row the resolver will normalize — the head
  // subject's own rows plus the rows of every operation subject the head
  // references — so both phases read one store snapshot and no head
  // swap between reads can interleave a stale id with fresh metadata.
  const acquisition = await params.store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(metaGraph)}> { ` +
    `{ <${assertSafeIri(subject)}> ?p ?o . BIND(<${assertSafeIri(subject)}> AS ?s) } UNION ` +
    `{ <${assertSafeIri(subject)}> <http://dkg.io/ontology/shareOperationId> ?id . ` +
    `?op <http://dkg.io/ontology/shareOperationId> ?id ; ?p ?o . BIND(?op AS ?s) } } }`,
    ...(params.queryOptions === undefined ? [] : [params.queryOptions]),
  );
  if (acquisition.type !== 'bindings') throw new Error(`Unexpected graph-scoped SWM head query result for ${scope.ual}: ${acquisition.type}`);
  const rows: Quad[] = acquisition.bindings.map(row => ({ subject: row['s'] ?? '', predicate: row['p'] ?? '', object: row['o'] ?? '', graph: metaGraph }));
  const authenticatedOperations = await readAuthenticatedWorkspaceOperations(params.store, rows.filter(row => row.subject !== subject));
  return { rows, authenticatedOperations };
}
