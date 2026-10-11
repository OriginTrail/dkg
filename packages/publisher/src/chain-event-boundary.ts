import {
  normalizeKnowledgeAssetUpdateIdentity,
  type ChainEvent,
  type KnowledgeAssetUpdateIdentity,
} from '@origintrail-official/dkg-chain';

export type NormalizedCollectionUpdateEvent = ChainEvent & {
  readonly type: 'KnowledgeAssetUpdated';
  readonly updateIdentity: KnowledgeAssetUpdateIdentity;
};

export function requireNormalizedCollectionUpdateEvent(event: ChainEvent): NormalizedCollectionUpdateEvent {
  if (event.type !== 'KnowledgeAssetUpdated' || event.updateIdentity === undefined) {
    throw new TypeError('Update event requires a normalized identity');
  }
  return event as NormalizedCollectionUpdateEvent;
}

/** Adapt legacy evidence and bind replay identity before generic lane dispatch. */
export function prepareChainEvent(incoming: ChainEvent): { readonly event: ChainEvent; readonly replayKey: string } {
  const event = incoming.type === 'KnowledgeAssetUpdated' && incoming.updateIdentity === undefined
    ? { ...incoming, updateIdentity: normalizeKnowledgeAssetUpdateIdentity({
      blockNumber: incoming.blockNumber, txHash: incoming.data.txHash,
      logIndex: incoming.data.logIndex, blockHash: incoming.data.blockHash,
    }) } : incoming;
  const data = event.data;
  const metadata = event.type === 'KnowledgeAssetUpdated'
    ? requireNormalizedCollectionUpdateEvent(event).updateIdentity : data;
  return { event, replayKey: [
    event.type,
    event.type === 'KnowledgeAssetUpdated' ? metadata.blockNumber ?? event.blockNumber : event.blockNumber,
    metadata.blockHash,
    metadata.logIndex,
    metadata.txHash,
    data.batchId,
    data.merkleRoot,
  ].map((part) => String(part ?? '')).join('\0') };
}
