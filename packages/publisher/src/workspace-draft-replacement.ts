// SPDX-License-Identifier: Apache-2.0
import type { TripleStore, GraphManager } from '@origintrail-official/dkg-storage';
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { KnowledgeAssetWorkspaceHead } from './workspace-resolution.js';
import { storageAckOwedCopiesByScopeQuery, STORAGE_ACK_OPERATION_ID_PREFIX } from './storage-ack-ledger.js';

export type ConfirmedKnowledgeAssetVersionReader = (kaUal: string) => Promise<bigint | null>;
export type DraftReplacementRejection = { phase: 'validation' | 'corrupt-head'; reason: string };

/** Only publisher aliases establish draft chronology; ACK clocks are local receipts. */
export function workspacePublisherOperationTimestamp(aliases: readonly { shareOperationId: string; publishedAt?: string | number; publisherChronologyAuthenticated?: boolean }[]): number | undefined {
  const value = Math.max(...aliases.filter(alias => alias.publisherChronologyAuthenticated !== false && !alias.shareOperationId.startsWith(STORAGE_ACK_OPERATION_ID_PREFIX))
    .map(alias => Number(alias.publishedAt ?? NaN)).filter(Number.isFinite));
  return Number.isFinite(value) ? value : undefined;
}

/** Authenticated share ordering is independent of reused draft version numbers. */
export async function checkWorkspaceDraftReplacementOrder(input: {
  head: Pick<KnowledgeAssetWorkspaceHead, 'kaUal' | 'assertionVersion' | 'publisherPeerId' | 'operationAliases'>;
  incomingVersion: bigint;
  publisherPeerId: string;
  timestamp: Date;
  readConfirmedVersion?: ConfirmedKnowledgeAssetVersionReader;
}): Promise<DraftReplacementRejection | undefined> {
  const { head, incomingVersion, publisherPeerId, timestamp, readConfirmedVersion } = input;
  const currentVersion = BigInt(head.assertionVersion);
  if (head.publisherPeerId !== publisherPeerId) return {
    phase: 'validation', reason: `KA_PUBLISHER_MISMATCH: ${head.kaUal} is owned in SWM by ${head.publisherPeerId}, not ${publisherPeerId}`,
  };
  const currentTimestamp = workspacePublisherOperationTimestamp(head.operationAliases) ?? NaN;
  if (Number.isFinite(currentTimestamp) && timestamp.getTime() < currentTimestamp) return {
    phase: 'validation', reason: 'STALE_KA_SHARE_OPERATION: authenticated publisher operation precedes the current head',
  };
  // A recovered clock cannot fence a later authenticated forward assertion.
  // Reuse/lower replacement still needs a trusted predecessor chronology.
  if (!Number.isFinite(currentTimestamp) && (incomingVersion <= currentVersion || !head.operationAliases.every(alias => alias.publisherChronologyAuthenticated === false))) return { phase: 'corrupt-head', reason: 'DRAFT_REPLACEMENT_PROOF_UNAVAILABLE: authenticated publisher chronology is unavailable' };
  if (incomingVersion > currentVersion) return;
  const reason = incomingVersion < currentVersion
    ? `STALE_KA_ASSERTION_VERSION: incoming=${incomingVersion}, current=${currentVersion}`
    : `CONFLICTING_KA_ASSERTION_VERSION: ${head.kaUal} version ${incomingVersion} is already bound to a different operation or content digest`;
  if (!Number.isFinite(currentTimestamp) || timestamp.getTime() <= currentTimestamp || !readConfirmedVersion) {
    return { phase: 'validation', reason };
  }
  return checkWorkspaceDraftVersionsUnpublished(head.kaUal, currentVersion, incomingVersion, readConfirmedVersion, reason);
}

/** Call again immediately before replacing content after awaited CAS/authority reads. */
export async function checkWorkspaceDraftVersionsUnpublished(
  kaUal: string,
  currentVersion: bigint,
  incomingVersion: bigint,
  read: ConfirmedKnowledgeAssetVersionReader | undefined,
  reason = 'CONFIRMED_KA_ASSERTION: draft became confirmed before replacement',
): Promise<DraftReplacementRejection | undefined> {
  const confirmed = read ? await read(kaUal) : null;
  if (confirmed === null) return { phase: 'corrupt-head', reason: 'DRAFT_REPLACEMENT_PROOF_UNAVAILABLE: coherent published version is unavailable' };
  if (confirmed >= incomingVersion || confirmed >= currentVersion) return { phase: 'validation', reason: `${reason}; a confirmed assertion cannot be replaced as a draft` };
}

/** The ACK signature's retained copy outlives draft edits until VM or proven expiry. */
export async function headIsUnpromotedOwedAckCopy(input: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  head: { readonly kaUal: string };
  version: bigint;
  subGraphName?: string;
  pendingAckTxWindowMs: number;
  readConfirmedKnowledgeAssetVersion?: ConfirmedKnowledgeAssetVersionReader;
}): Promise<boolean> {
  const { store, graphManager, contextGraphId, head, version, subGraphName, pendingAckTxWindowMs, readConfirmedKnowledgeAssetVersion } = input;
  const owed = await store.query(storageAckOwedCopiesByScopeQuery({
    namespace: contextGraphId,
    metaGraph: graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName),
    kaUal: head.kaUal,
    assertionVersion: version,
  }), {
    source: 'publisher.swm.graphScoped.owedAckCopy',
  });
  if (owed.type !== 'bindings' || owed.bindings.length === 0) return false;
  const now = Date.now();
  const expired = owed.bindings.every(row => {
    const value = row['signedAt'] ?? '';
    const lexical = value.startsWith('"') ? value.slice(1, value.indexOf('"', 1)) : value;
    const signedAt = Date.parse(lexical);
    return Number.isFinite(signedAt) && now - signedAt > pendingAckTxWindowMs;
  });
  if (expired && readConfirmedKnowledgeAssetVersion) {
    const confirmed = await readConfirmedKnowledgeAssetVersion(head.kaUal);
    if (confirmed !== null && confirmed < version) return false;
  }
  const promoted = await store.query(
    `ASK { GRAPH <${contextGraphMetaUri(contextGraphId)}> {
      <${head.kaUal}> <http://dkg.io/ontology/status> "confirmed" ;
        <http://dkg.io/ontology/assertionVersion> ?version .
      FILTER(?version >= ${version})
    } }`,
    { source: 'publisher.swm.graphScoped.owedAckCopyPromoted' },
  );
  return !(promoted.type === 'boolean' && promoted.value);
}
