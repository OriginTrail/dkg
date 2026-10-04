// SPDX-License-Identifier: Apache-2.0
import { workspaceOperationSubject } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  checkWorkspaceDraftReplacementOrder,
  headIsUnpromotedOwedAckCopy,
  type ConfirmedKnowledgeAssetVersionReader,
} from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { isAuthenticatedPublisherCandidate, type PreparedSwmRecoveryDescriptor } from './swm-recovered-provenance.js';

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
  const stored = descriptor.storedHead;
  if (stored.status === 'missing') return true;
  const incoming = descriptor.operationCandidates.find(candidate => candidate.operationSubject === descriptor.operationSubject);
  const completeEquivalent = () => incoming?.identityKey != null
    && descriptor.storedOperationCandidates !== null && descriptor.storedOperationCandidates.length > 0
    && descriptor.storedOperationCandidates.every(candidate => candidate.identityKey === incoming.identityKey
      && candidate.semantics.publisherIdentity === descriptor.publisherPeerId);
  // Public bytes alone cannot certify private roots, access, author, or version.
  // Corrupt metadata may be healed only against complete immutable operation
  // equivalence; storage failures continue to propagate from both acquisitions.
  if (stored.status === 'corrupt') return input.contentAlreadyEquivalent === true && completeEquivalent();
  if (stored.head.shareOperationId === descriptor.shareOperationId) return completeEquivalent();
  if (stored.head.assertionVersion === descriptor.assertionVersion && completeEquivalent()) return true;
  // The canonical acquisition already validated the complete alias class.
  // Only actual corruption needs content-equivalent metadata healing.
  const head = stored.head;
  if (descriptor.authenticatedPublisherOperation === undefined) return false;
  if (await headIsUnpromotedOwedAckCopy({ store, graphManager: new GraphManager(store), contextGraphId: input.contextGraphId, head, version: BigInt(head.assertionVersion), subGraphName: descriptor.subGraphName, pendingAckTxWindowMs: input.pendingAckTxWindowMs ?? 300_000, readConfirmedKnowledgeAssetVersion: input.readConfirmedVersion })) return false;
  return await checkWorkspaceDraftReplacementOrder({ head, incomingVersion: BigInt(descriptor.assertionVersion), publisherPeerId: descriptor.publisherPeerId, timestamp: new Date(descriptor.authenticatedPublisherOperation.provenance.publishedAtMs), readConfirmedVersion: input.readConfirmedVersion }) === undefined;
}

/** Called after equivalence/serveability admission; extend a healthy class without retiring any identity. */
export function healthyRecoveredAliasRows(contextGraphId: string, descriptor: PreparedSwmRecoveryDescriptor): Quad[] | null {
  if (descriptor.storedHead.status !== 'resolved') return null;
  const ownedSubjects = new Set(descriptor.storedHead.head.operationAliases.map(alias => workspaceOperationSubject(contextGraphId, alias.shareOperationId)));
  const rows = descriptor.metadataQuads.filter(row => row.subject !== descriptor.headSubject && !ownedSubjects.has(row.subject));
  const publisherAlias = descriptor.authenticatedPublisherOperation;
  if (publisherAlias && !ownedSubjects.has(publisherAlias.operationSubject)) {
    const idRow = descriptor.metadataQuads.find(row => row.subject === descriptor.headSubject && row.predicate === 'http://dkg.io/ontology/shareOperationId');
    if (idRow) rows.push({ ...idRow, object: JSON.stringify(publisherAlias.shareOperationId) });
  }
  return rows;
}

/** Retain the latest validated publisher clock alongside an equivalent local alias. */
export function retainedPublisherAlias(descriptor: PreparedSwmRecoveryDescriptor, winnerShareOperationId: string) {
  const candidates = [...descriptor.storedOperationCandidates ?? []];
  const winner = candidates.find(candidate => candidate.shareOperationId === winnerShareOperationId);
  if (!winner) return null;
  const incoming = descriptor.authenticatedPublisherOperation;
  if (incoming) candidates.push(incoming);
  const publisher = candidates
    .filter(candidate => candidate.semantics.publisherIdentity === winner.semantics.publisherIdentity
      && isAuthenticatedPublisherCandidate(candidate))
    .sort((a, b) => b.provenance.publishedAtMs - a.provenance.publishedAtMs
      || (a.shareOperationId === winnerShareOperationId ? -1
        : b.shareOperationId === winnerShareOperationId ? 1 : a.shareOperationId.localeCompare(b.shareOperationId)))[0];
  if (!publisher || publisher.shareOperationId === winnerShareOperationId) return null;
  const template = descriptor.metadataQuads.find(row => row.subject === descriptor.headSubject && row.predicate === 'http://dkg.io/ontology/shareOperationId');
  if (!template) return null;
  return { headRow: { ...template, object: JSON.stringify(publisher.shareOperationId) },
    operationSubject: publisher.operationSubject, operationRows: publisher.operationRows };
}
