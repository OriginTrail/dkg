import type {
  ContextGraphForKaAnswer,
  ContextGraphKaList,
  KnowledgeAssetReadModelFactoryOptions,
  KnowledgeAssetReadOptions,
} from '@origintrail-official/dkg-chain';

export type ChainIndexReadMethod = 'binding' | 'ordinal' | 'list';
export type ChainIndexReadResult = ContextGraphForKaAnswer | ContextGraphKaList |
  Readonly<{ kaId: bigint; asOfBlockNumber: number }>;

export interface ChainIndexReadRequest {
  type: 'read';
  id: number;
  model: KnowledgeAssetReadModelFactoryOptions;
  method: ChainIndexReadMethod;
  key: bigint;
  index?: bigint;
  options: Omit<KnowledgeAssetReadOptions, 'signal'>;
  deadlineAt: number;
}

export interface ChainIndexReadFence {
  revision: number;
  lineage: string;
  topicSetVersion: string;
}

export interface ChainIndexReadResponse {
  id: number;
  result?: ChainIndexReadResult;
  fence?: ChainIndexReadFence;
  reason?: string;
  rowsRead: number;
  readMs: number;
  decodeMs: number;
}

export type ChainIndexReadMessage = ChainIndexReadRequest | { type: 'cancel'; id: number };
export type ChainIndexReadWorkerMessage = ChainIndexReadResponse | { type: 'ready' };
