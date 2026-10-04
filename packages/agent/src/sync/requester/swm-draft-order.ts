// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  tryResolveKnowledgeAssetWorkspaceHead,
  checkWorkspaceDraftReplacementOrder,
  headIsUnpromotedOwedAckCopy,
  workspacePublisherOperationTimestamp,
  type ConfirmedKnowledgeAssetVersionReader,
} from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { operationIdentityKey, type GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import { RECOVERED_OPERATION_CHRONOLOGY, readAuthenticatedWorkspaceOperations } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { stripMetadataLiteral } from '../metadata-literal.js';
import type { KnowledgeAssetWorkspaceHeadResolution } from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import type { PreparedSwmRecoveryDescriptor } from './swm-recovered-provenance.js';

/** Reuse the canonical missing/resolved/corrupt union; storage errors propagate. */
export async function readStoredWorkspaceHead(store: TripleStore, descriptor: GraphScopedSwmRecoveryDescriptor): Promise<KnowledgeAssetWorkspaceHeadResolution> {
  const contextGraphId = stripMetadataLiteral(descriptor.metadataQuads.find(row => row.subject === descriptor.operationSubject && row.predicate === 'http://dkg.io/ontology/contextGraphId')?.object ?? '');
  return tryResolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId, kaUal: descriptor.kaUal, subGraphName: descriptor.subGraphName, queryOptions: { priority: 'background', source: 'agent.swmRecovery.storedHead' } });
}

/** Called under the shared KA lock, again after any awaited snapshot/authority read. */
export async function recoveredDraftMayReplace(input: {
  store: TripleStore;
  contextGraphId: string;
  descriptor: PreparedSwmRecoveryDescriptor;
  readConfirmedVersion?: ConfirmedKnowledgeAssetVersionReader;
  contentAlreadyEquivalent?: boolean;
  pendingAckTxWindowMs?: number;
}): Promise<boolean> {
  const { store, descriptor } = input;
  const stored = await readStoredWorkspaceHead(store, descriptor);
  if (stored.status === 'missing') return true;
  const key = operationIdentityKey(descriptor.metadataQuads.filter(row => row.subject === descriptor.operationSubject));
  const completeEquivalent = async () => {
    if (key === null) return false;
    const operations = await store.query(`CONSTRUCT { ?op ?p ?o } WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { <${assertSafeIri(descriptor.headSubject)}> <http://dkg.io/ontology/shareOperationId> ?id . ?op <http://dkg.io/ontology/shareOperationId> ?id ; ?p ?o } }`, { priority: 'background', source: 'agent.swmRecovery.draftOrder.equivalence' });
    if (operations.type !== 'quads') throw new Error('Recovery operation equivalence is unavailable');
    const subjects = [...new Set(operations.quads.map(row => row.subject))].filter(subject => subject !== descriptor.headSubject);
    return subjects.length > 0 && subjects.every(subject => {
      const rows = operations.quads.filter(row => row.subject === subject);
      const publisher = stripMetadataLiteral(rows.find(row => row.predicate === 'http://dkg.io/ontology/publisherPeerId')?.object ?? '');
      return operationIdentityKey(rows) === key && publisher === descriptor.publisherPeerId;
    });
  };
  // Public bytes alone cannot certify private roots, access, author, or version.
  // Corrupt metadata may be healed only against complete immutable operation
  // equivalence; storage failures continue to propagate from both acquisitions.
  if (stored.status === 'corrupt') return input.contentAlreadyEquivalent === true && await completeEquivalent();
  if (stored.head.shareOperationId === descriptor.shareOperationId) return await completeEquivalent();
  if (stored.head.assertionVersion === descriptor.assertionVersion && await completeEquivalent()) return true;
  // The canonical acquisition already validated the complete alias class.
  // Only actual corruption needs content-equivalent metadata healing.
  const head = stored.head;
  if (descriptor.authenticatedPublisherOperation === undefined) return false;
  if (await headIsUnpromotedOwedAckCopy({ store, graphManager: new GraphManager(store), contextGraphId: input.contextGraphId, head, version: BigInt(head.assertionVersion), subGraphName: descriptor.subGraphName, pendingAckTxWindowMs: input.pendingAckTxWindowMs ?? 300_000, readConfirmedKnowledgeAssetVersion: input.readConfirmedVersion })) return false;
  return await checkWorkspaceDraftReplacementOrder({ head, incomingVersion: BigInt(descriptor.assertionVersion), publisherPeerId: descriptor.publisherPeerId, timestamp: new Date(descriptor.authenticatedPublisherOperation.timestampMs), readConfirmedVersion: input.readConfirmedVersion }) === undefined;
}

/** Retain the latest validated publisher clock alongside an equivalent local alias. */
export async function retainedPublisherAlias(store: TripleStore, descriptor: PreparedSwmRecoveryDescriptor, winnerShareOperationId: string, storedOperations: readonly Quad[]) {
  const DKG = 'http://dkg.io/ontology/';
  const literal = (rows: readonly Quad[], predicate: string) => stripMetadataLiteral(rows.find(row => row.predicate === `${DKG}${predicate}`)?.object ?? '');
  const authenticated = new Set(await readAuthenticatedWorkspaceOperations(store, storedOperations));
  const candidates = [...new Set(storedOperations.map(row => row.subject))]
    .map(subject => storedOperations.filter(row => row.subject === subject));
  const winner = candidates.find(rows => literal(rows, 'shareOperationId') === winnerShareOperationId);
  if (!winner) return null;
  const owner = literal(winner, 'publisherPeerId');
  if (descriptor.authenticatedPublisherOperation?.id) {
    const rows = descriptor.metadataQuads.filter(row => row.subject !== descriptor.headSubject && literal(descriptor.metadataQuads.filter(candidate => candidate.subject === row.subject), 'shareOperationId') === descriptor.authenticatedPublisherOperation?.id);
    if (rows.length > 0 && !rows.some(row => row.predicate === RECOVERED_OPERATION_CHRONOLOGY)) { candidates.push(rows); authenticated.add(rows[0]!.subject); }
  }
  const publisher = candidates
    .filter(rows => literal(rows, 'publisherPeerId') === owner && authenticated.has(rows[0]!.subject))
    .map(rows => ({
      rows,
      id: literal(rows, 'shareOperationId'),
      timestamp: workspacePublisherOperationTimestamp([{
        shareOperationId: literal(rows, 'shareOperationId'),
        publishedAt: Date.parse(literal(rows, 'publishedAt')),
      }]),
    }))
    .filter(candidate => candidate.timestamp !== undefined)
    .sort((a, b) => b.timestamp! - a.timestamp!
      || (a.id === winnerShareOperationId ? -1
        : b.id === winnerShareOperationId ? 1 : a.id.localeCompare(b.id)))[0];
  if (!publisher || publisher.id === winnerShareOperationId) return null;
  const template = descriptor.metadataQuads.find(row => row.subject === descriptor.headSubject && row.predicate === `${DKG}shareOperationId`);
  if (!template) return null;
  return { headRow: { ...template, object: JSON.stringify(publisher.id) }, operationSubject: publisher.rows[0]!.subject, operationRows: publisher.rows };
}
