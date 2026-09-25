import type {
  KnowledgeAssetReadModelFactoryOptions,
  KnowledgeAssetReadOptions,
} from '@origintrail-official/dkg-chain';
import type {
  KnowledgeAssetReadKind,
  KnowledgeAssetResultByKind,
} from '@origintrail-official/dkg-chain/internal/chain-index-worker';

export type ChainIndexReadMethod = KnowledgeAssetReadKind;
export type ChainIndexReadResult<K extends ChainIndexReadMethod = ChainIndexReadMethod> = KnowledgeAssetResultByKind[K];

export type ChainIndexReadInput<K extends ChainIndexReadMethod = ChainIndexReadMethod> = {
  [P in K]: { method: P; key: bigint } & (P extends 'ordinal' ? { index: bigint } : { index?: never });
}[K];

export type ChainIndexReadRequest<K extends ChainIndexReadMethod = ChainIndexReadMethod> = ChainIndexReadInput<K> & {
  type: 'read';
  id: number;
  model: KnowledgeAssetReadModelFactoryOptions;
  options: Omit<KnowledgeAssetReadOptions, 'signal'>;
  deadlineAt: number;
};

export interface ChainIndexReadFence {
  revision: number;
  lineage: string;
  topicSetVersion: string;
}

export interface ChainIndexReadMetrics {
  rowsRead: number;
  readMs: number;
  decodeMs: number;
}

export type ChainIndexReadRefusal = 'unavailable' | 'proof-miss' | 'row-limit' | 'timeout' | 'read-error';

/** A generic operation stays coupled while its implementation awaits I/O. */
export type ChainIndexReadResponseFor<K extends ChainIndexReadMethod> = ChainIndexReadMetrics & { id: number; method: K } & (
  | { reason: 'served'; result: ChainIndexReadResult<K>; fence: ChainIndexReadFence }
  | { reason: ChainIndexReadRefusal; result?: never; fence?: never }
);

/** Distribute over kinds so a received message cannot pair an operation with another result. */
export type ChainIndexReadResponse<K extends ChainIndexReadMethod = ChainIndexReadMethod> = {
  [P in K]: ChainIndexReadResponseFor<P>;
}[K];

export type ChainIndexReadMessage = ChainIndexReadRequest | { type: 'cancel'; id: number };
export type ChainIndexReadWorkerMessage = ChainIndexReadResponse | { type: 'ready' };
