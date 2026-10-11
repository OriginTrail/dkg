import {
  normalizeKnowledgeAssetUpdateIdentity,
  type ChainEvent,
  type KnowledgeAssetUpdateIdentity,
} from '@origintrail-official/dkg-chain';

export type NormalizedCollectionUpdateEvent = ChainEvent & {
  readonly type: 'KnowledgeAssetUpdated';
  readonly updateIdentity: KnowledgeAssetUpdateIdentity;
};

function isNormalizedCollectionUpdateEvent(event: ChainEvent): event is NormalizedCollectionUpdateEvent {
  return event.type === 'KnowledgeAssetUpdated' && event.updateIdentity !== undefined;
}

/** The collection-update lane binds legacy evidence and replay identity once. */
export function prepareCollectionUpdateEvent(incoming: ChainEvent): { readonly event: NormalizedCollectionUpdateEvent; readonly replayKey: string } {
  let event: NormalizedCollectionUpdateEvent;
  if (isNormalizedCollectionUpdateEvent(incoming)) {
    event = incoming;
  } else {
    if (incoming.type !== 'KnowledgeAssetUpdated') {
      throw new TypeError('Update event requires a normalized identity');
    }
    event = { ...incoming, type: 'KnowledgeAssetUpdated', updateIdentity: normalizeKnowledgeAssetUpdateIdentity({
      blockNumber: incoming.blockNumber, txHash: incoming.data.txHash,
      logIndex: incoming.data.logIndex, blockHash: incoming.data.blockHash,
    }) };
  }
  const data = event.data;
  const metadata = event.updateIdentity;
  return { event, replayKey: [
    event.type,
    metadata.blockNumber ?? event.blockNumber,
    metadata.blockHash,
    metadata.logIndex,
    metadata.txHash,
    data.batchId,
    data.merkleRoot,
  ].map((part) => String(part ?? '')).join('\0') };
}
