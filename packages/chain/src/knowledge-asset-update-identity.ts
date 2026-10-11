// SPDX-License-Identifier: Apache-2.0

export interface ChainEvent {
  /** Normalized update evidence; absent only on legacy adapters or other event types. */
  updateIdentity?: KnowledgeAssetUpdateIdentity;
  type: string;
  blockNumber: number;
  data: Record<string, unknown>;
}

/**
 * Legacy adapters explicitly describe only the event position they can prove.
 * Block of the update event, when known. A chain view older than it has
 * not seen the update, so it can never settle the target as current. Only
 * targets with a block hold the event lane's persisted cursor.
 * Hash of the event's block distinguishes a replacement fork; log position
 * distinguishes two updates with the same root in one block. Transaction
 * identity is retained when a log position is unavailable or a block reorganizes.
 */
export type KnowledgeAssetUpdateIdentity =
  | { readonly eventKind: 'legacy-unpositioned'; readonly blockNumber?: never; readonly logIndex?: never; readonly blockHash?: string; readonly txHash?: string }
  | { readonly eventKind: 'legacy-block'; readonly blockNumber: number; readonly logIndex?: never; readonly blockHash?: string; readonly txHash?: never }
  | { readonly eventKind: 'transaction'; readonly blockNumber: number; readonly txHash: string; readonly blockHash?: string; readonly logIndex?: never }
  | { readonly eventKind: 'log'; readonly blockNumber: number; readonly logIndex: number; readonly blockHash?: string; readonly txHash?: string };

export interface KnowledgeAssetUpdateMetadata {
  readonly blockNumber?: unknown;
  readonly logIndex?: unknown;
  readonly blockHash?: unknown;
  readonly txHash?: unknown;
}

/** Normalize raw/legacy adapter evidence once, before it enters a typed callback. */
export function normalizeKnowledgeAssetUpdateIdentity(metadata: KnowledgeAssetUpdateMetadata): KnowledgeAssetUpdateIdentity {
  const hash = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value.toLowerCase() : undefined;
  const blockHash = hash(metadata.blockHash);
  const txHash = hash(metadata.txHash);
  const blockNumber = typeof metadata.blockNumber === 'number'
    && Number.isSafeInteger(metadata.blockNumber) && metadata.blockNumber >= 0 ? metadata.blockNumber : undefined;
  if (blockNumber === undefined) return { eventKind: 'legacy-unpositioned', ...(blockHash === undefined ? {} : { blockHash }), ...(txHash === undefined ? {} : { txHash }) };
  const logIndex = typeof metadata.logIndex === 'number'
    && Number.isSafeInteger(metadata.logIndex) && metadata.logIndex >= 0 ? metadata.logIndex : undefined;
  if (logIndex !== undefined) return {
    eventKind: 'log', blockNumber, logIndex,
    ...(blockHash === undefined ? {} : { blockHash }), ...(txHash === undefined ? {} : { txHash }),
  };
  if (txHash !== undefined) return { eventKind: 'transaction', blockNumber, txHash, ...(blockHash === undefined ? {} : { blockHash }) };
  return { eventKind: 'legacy-block', blockNumber, ...(blockHash === undefined ? {} : { blockHash }) };
}

export function knowledgeAssetUpdateKey(identity: KnowledgeAssetUpdateIdentity, merkleRoot: string): string {
  // Complete positions remain distinct, including across forks. Legacy
  // adapters without a position can only coalesce the evidence they supply.
  switch (identity.eventKind) {
    case 'legacy-unpositioned': return JSON.stringify(['legacy', merkleRoot]);
    case 'legacy-block': return JSON.stringify(['legacy-block', identity.blockNumber, merkleRoot]);
    case 'transaction': return JSON.stringify(['transaction', identity.blockNumber, identity.blockHash, identity.txHash, merkleRoot]);
    case 'log': return JSON.stringify(['log', identity.blockNumber, identity.logIndex, identity.blockHash, identity.txHash, merkleRoot]);
    default: throw new TypeError('Knowledge Asset update identity is invalid');
  }
}

export type KnowledgeAssetUpdateComparison =
  | { readonly kind: 'duplicate' | 'superseded' }
  | { readonly kind: 'replacement'; readonly relation: 'older' | 'newer' | 'incomparable'; readonly checkVersion: boolean };

/** One comparison owns exact replay, historical replay and replacement ordering. */
export function compareKnowledgeAssetUpdates(
  incoming: KnowledgeAssetUpdateIdentity, incomingRoot: string,
  held: KnowledgeAssetUpdateIdentity, heldRoot: string,
  supersededKeys: ReadonlySet<string>,
): KnowledgeAssetUpdateComparison {
  const incomingKey = knowledgeAssetUpdateKey(incoming, incomingRoot);
  if (incomingKey === knowledgeAssetUpdateKey(held, heldRoot)) return { kind: 'duplicate' };
  if (supersededKeys.has(incomingKey)) return { kind: 'superseded' };
  let relation: 'older' | 'newer' | 'incomparable' = 'incomparable';
  if (incoming.blockNumber !== undefined && held.blockNumber !== undefined) {
    if (incoming.blockNumber !== held.blockNumber) relation = incoming.blockNumber < held.blockNumber ? 'older' : 'newer';
    else if (incoming.logIndex !== undefined && held.logIndex !== undefined && incoming.logIndex !== held.logIndex) {
      relation = incoming.logIndex < held.logIndex ? 'older' : 'newer';
    }
  }
  return { kind: 'replacement', relation, checkVersion: incomingRoot === heldRoot || relation === 'older' };
}
