// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { GraphManager, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { resolveKnowledgeAssetWorkspaceHead } from '@origintrail-official/dkg-publisher';
import {
  checkWorkspaceDraftReplacementOrder,
  headIsUnpromotedOwedAckCopy,
  workspacePublisherOperationTimestamp,
  type ConfirmedKnowledgeAssetVersionReader,
} from '@origintrail-official/dkg-publisher/dist/workspace-resolution.js';
import { operationIdentityKey, type GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import { stripMetadataLiteral } from '../metadata-literal.js';
import type { StoredWorkspaceHeadState } from './swm-snapshot-materializer.js';

/** Exact-subject cardinality view retained for metadata corruption repairs. */
export async function readStoredWorkspaceHead(store: TripleStore, descriptor: GraphScopedSwmRecoveryDescriptor): Promise<StoredWorkspaceHeadState> {
  const result = await store.query(
    `SELECT (MAX(?v) AS ?maxVersion) (COUNT(DISTINCT ?v) AS ?versions) `
    + `(COUNT(DISTINCT ?op) AS ?operations) (SAMPLE(?op) AS ?anyOp) WHERE { `
    + `GRAPH <${assertSafeIri(descriptor.metaGraph)}> { `
    + `<${assertSafeIri(descriptor.headSubject)}> <http://dkg.io/ontology/assertionVersion> ?v ; `
    + `<http://dkg.io/ontology/shareOperationId> ?op } }`,
    { priority: 'background', source: 'agent.sharedMemorySync.snapshotMaterializer.readStoredHead' },
  );
  const literal = (value: string | undefined) => value === undefined ? undefined : /^"([^"]*)"/.exec(value)?.[1] ?? value;
  if (result.type !== 'bindings' || result.bindings.length === 0) return { version: null, needsRepair: false, shareOperationId: null };
  const row = result.bindings[0];
  const version = literal(row?.['maxVersion']);
  const operations = Number.parseInt(literal(row?.['operations']) ?? '0', 10);
  const op = literal(row?.['anyOp']);
  return { version: version || null, needsRepair: Number.parseInt(literal(row?.['versions']) ?? '0', 10) > 1 || operations > 1, shareOperationId: operations === 1 && op ? op : null };
}

/** Called under the shared KA lock, again after any awaited snapshot/authority read. */
export async function recoveredDraftMayReplace(input: {
  store: TripleStore;
  contextGraphId: string;
  descriptor: GraphScopedSwmRecoveryDescriptor;
  readConfirmedVersion?: ConfirmedKnowledgeAssetVersionReader;
  contentAlreadyEquivalent?: boolean;
  pendingAckTxWindowMs?: number;
}): Promise<boolean> {
  const { store, descriptor } = input;
  const stored = await readStoredWorkspaceHead(store, descriptor);
  if (stored.version === null) return true;
  // Id-equal repair reinstalls one immutable operation; it is not a new draft.
  // The canonical head decoder may reject the very residue being repaired.
  try { BigInt(stored.version); } catch { return input.contentAlreadyEquivalent === true; }
  if (stored.shareOperationId === descriptor.shareOperationId) return true;
  const key = operationIdentityKey(descriptor.metadataQuads.filter(row => row.subject === descriptor.operationSubject));
  if (key !== null && stored.version === descriptor.assertionVersion) {
    const operations = await store.query(`CONSTRUCT { ?op ?p ?o } WHERE { GRAPH <${assertSafeIri(descriptor.metaGraph)}> { <${assertSafeIri(descriptor.headSubject)}> <http://dkg.io/ontology/shareOperationId> ?id . ?op <http://dkg.io/ontology/shareOperationId> ?id ; ?p ?o } }`, { priority: 'background', source: 'agent.swmRecovery.draftOrder.equivalence' });
    if (operations.type === 'quads') {
      const subjects = [...new Set(operations.quads.map(row => row.subject))].filter(subject => subject !== descriptor.headSubject);
      if (subjects.length > 0 && subjects.every(subject => operationIdentityKey(operations.quads.filter(row => row.subject === subject)) === key)) return true;
    }
  }
  let head;
  try {
    head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId: input.contextGraphId, kaUal: descriptor.kaUal, subGraphName: descriptor.subGraphName, queryOptions: { priority: 'background', source: 'agent.swmRecovery.draftOrder' } });
  } catch {
    // Exact content proof may heal an unreadable head's metadata. It cannot
    // authorize replacing different bytes when publisher ordering is unknown.
    return input.contentAlreadyEquivalent === true;
  }
  if (!head) return false;
  if (descriptor.publisherOperationTimestampMs === undefined) return false;
  if (await headIsUnpromotedOwedAckCopy({ store, graphManager: new GraphManager(store), contextGraphId: input.contextGraphId, head, version: BigInt(head.assertionVersion), subGraphName: descriptor.subGraphName, pendingAckTxWindowMs: input.pendingAckTxWindowMs ?? 300_000, readConfirmedKnowledgeAssetVersion: input.readConfirmedVersion })) return false;
  return await checkWorkspaceDraftReplacementOrder({ head, incomingVersion: BigInt(descriptor.assertionVersion), publisherPeerId: descriptor.publisherPeerId, timestamp: new Date(descriptor.publisherOperationTimestampMs), readConfirmedVersion: input.readConfirmedVersion }) === undefined;
}

/** Empty projections need a decodable complete alias class, not a single pointer. */
export async function readRecoveryAliasIds(store: TripleStore, contextGraphId: string, descriptor: GraphScopedSwmRecoveryDescriptor): Promise<readonly string[] | null> {
  try {
    const head = await resolveKnowledgeAssetWorkspaceHead({ store, graphManager: new GraphManager(store), contextGraphId, kaUal: descriptor.kaUal, subGraphName: descriptor.subGraphName, queryOptions: { priority: 'background', source: 'agent.swmRecovery.emptyProjectionAliases' } });
    return head?.assertionVersion === descriptor.assertionVersion ? head.operationAliases.map(alias => alias.shareOperationId) : null;
  } catch { return null; }
}

/** Retain the latest validated publisher clock alongside an equivalent local alias. */
export function retainedPublisherAlias(descriptor: GraphScopedSwmRecoveryDescriptor, winnerShareOperationId: string, storedOperations: readonly Quad[]) {
  const DKG = 'http://dkg.io/ontology/';
  const literal = (rows: readonly Quad[], predicate: string) => stripMetadataLiteral(rows.find(row => row.predicate === `${DKG}${predicate}`)?.object ?? '');
  const candidates = [...new Set(storedOperations.map(row => row.subject))]
    .map(subject => storedOperations.filter(row => row.subject === subject));
  const winner = candidates.find(rows => literal(rows, 'shareOperationId') === winnerShareOperationId);
  if (!winner) return null;
  const owner = literal(winner, 'publisherPeerId');
  if (descriptor.publisherPeerId === owner && descriptor.publisherOperationId) {
    const subject = descriptor.metadataQuads.find(row => row.subject !== descriptor.headSubject && row.predicate === `${DKG}shareOperationId` && stripMetadataLiteral(row.object) === descriptor.publisherOperationId)?.subject;
    if (subject) candidates.push(descriptor.metadataQuads.filter(row => row.subject === subject));
  }
  const publisher = candidates
    .filter(rows => literal(rows, 'publisherPeerId') === owner)
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
