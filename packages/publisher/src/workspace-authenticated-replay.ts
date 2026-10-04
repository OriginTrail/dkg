// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { GraphManager, TripleStore } from '@origintrail-official/dkg-storage';
import { persistWorkspaceOperationEvidence } from './workspace-operation-alias.js';
import { normalizeWorkspaceOperationProvenance } from './workspace-operation-equivalence.js';
import type { KnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { workspaceOperationSubject } from './workspace-metadata-subjects.js';
import { xsdDateTimeLiteral } from './storage-ack-ledger.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';

/** Called under the live KA lock after the authenticated exact-content checks. */
export async function authenticateWorkspaceOperationReplay(input: {
  store: TripleStore; graphManager: GraphManager; contextGraphId: string;
  subGraphName?: string; head: KnowledgeAssetWorkspaceHead;
  shareOperationId: string; timestamp: Date;
}): Promise<void> {
  const alias = input.head.operationAliases.find(alias => alias.shareOperationId === input.shareOperationId);
  if (!alias) throw new Error('Authenticated replay has no matching head alias');
  // An older exact replay cannot downgrade established publisher chronology.
  if (normalizeWorkspaceOperationProvenance(alias).publisherChronologyAuthenticated) return;
  const subject = workspaceOperationSubject(input.contextGraphId, input.shareOperationId);
  const graph = input.graphManager.sharedMemoryMetaUri(input.contextGraphId, input.subGraphName);
  const acquired = await input.store.query(`CONSTRUCT { <${assertSafeIri(subject)}> ?p ?o } WHERE {
    GRAPH <${assertSafeIri(graph)}> { <${subject}> ?p ?o }
  }`, { source: 'publisher.workspace.authenticatedReplay' });
  if (acquired.type !== 'quads' || acquired.quads.length === 0) throw new Error('Authenticated replay operation is unavailable');
  const publishedAt = 'http://dkg.io/ontology/publishedAt';
  const rows = acquired.quads.filter(row => row.predicate !== publishedAt)
    .map(row => ({ ...row, graph }));
  const clock = { subject, predicate: publishedAt, object: xsdDateTimeLiteral(input.timestamp), graph };
  // Authenticate the signed wire clock, never the provider's retained clock.
  // Immutable semantics were checked by the caller; keep every head alias and
  // snapshot locator so queued references retain their exact operation identity.
  const replacement = [...rows, clock];
  await replaceSubjectAtomicallyOrFallback(input.store, graph, subject, replacement, 'publisher.workspace.authenticatedReplay');
  await persistWorkspaceOperationEvidence(input.store, replacement);
}
