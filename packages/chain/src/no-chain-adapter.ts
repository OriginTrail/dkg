import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  PublishParams,
  OnChainPublishResult,
  UpdateKAParams,
  ExtendStorageParams,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateContextGraphParams,
  V10PublishDirectParams,
} from './chain-adapter.js';

function noChain(): never {
  throw new Error(
    'No blockchain configured. To use on-chain operations, provide chainConfig ' +
    '(rpcUrl, hubAddress, privateKey) when creating the agent, or set DKG_PRIVATE_KEY.',
  );
}

/**
 * Stub chain adapter that throws on every operation.
 * Used when no blockchain is configured — the node can still do P2P and queries.
 * This is NOT a mock; it doesn't simulate any behavior.
 */
export class NoChainAdapter implements ChainAdapter {
  readonly chainType = 'evm' as const;
  readonly chainId = 'none';

  async registerIdentity(_proof: IdentityProof): Promise<bigint> { noChain(); }
  async getIdentityId(): Promise<bigint> { return 0n; }
  async ensureProfile(_options?: { nodeName?: string; stakeAmount?: bigint }): Promise<bigint> { noChain(); }
  async reserveUALRange(_count: number): Promise<ReservedRange> { noChain(); }
  async batchMintKnowledgeAssets(_params: BatchMintParams): Promise<BatchMintResult> { noChain(); }
  async publishKnowledgeAssets(_params: PublishParams): Promise<OnChainPublishResult> { noChain(); }
  async updateKnowledgeAssets(_params: UpdateKAParams): Promise<TxResult> { noChain(); }
  async extendStorage(_params: ExtendStorageParams): Promise<TxResult> { noChain(); }
  async transferNamespace(_newOwner: string): Promise<TxResult> { noChain(); }
  async *listenForEvents(_filter: EventFilter): AsyncIterable<ChainEvent> { noChain(); }
  async createContextGraph(_params: CreateContextGraphParams): Promise<TxResult> { noChain(); }
  async submitToContextGraph(_kcId: string, _contextGraphId: string): Promise<TxResult> { noChain(); }
  async revealContextGraphMetadata(_contextGraphId: string, _name: string, _description: string): Promise<TxResult> { noChain(); }
  async createKnowledgeAssetsV10(_params: V10PublishDirectParams): Promise<OnChainPublishResult> { noChain(); }
  async getKnowledgeAssetsV10Address(): Promise<string> { noChain(); }
  async getEvmChainId(): Promise<bigint> { noChain(); }
}
