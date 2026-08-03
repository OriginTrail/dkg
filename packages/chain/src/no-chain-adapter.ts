import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  OnChainPublishResult,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateContextGraphParams,
  V10PublishParams,
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
  readonly deploymentId = 'none';

  async registerIdentity(_proof: IdentityProof): Promise<bigint> { noChain(); }
  async getIdentityId(): Promise<bigint> { return 0n; }
  async ensureProfile(_options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> { noChain(); }
  async reserveUALRange(_count: number): Promise<ReservedRange> { noChain(); }
  async batchMintKnowledgeAssets(_params: BatchMintParams): Promise<BatchMintResult> { noChain(); }
  async *listenForEvents(_filter: EventFilter, _options?: { signal?: AbortSignal }): AsyncIterable<ChainEvent> { noChain(); }
  async createContextGraph(_params: CreateContextGraphParams): Promise<TxResult> { noChain(); }
  async submitToContextGraph(_kcId: string, _contextGraphId: string): Promise<TxResult> { noChain(); }
  async revealContextGraphMetadata(_contextGraphId: string, _name: string, _description: string): Promise<TxResult> { noChain(); }
  async createKnowledgeAssets(_params: V10PublishParams): Promise<OnChainPublishResult> { noChain(); }
  async isOperationalWalletRegistered(_identityId: bigint, _address: string): Promise<boolean> { return false; }
  async getKnowledgeAssetsLifecycleAddress(): Promise<string> { noChain(); }
  async getEvmChainId(): Promise<bigint> { noChain(); }
  async getKnowledgeAssetOwner(_kaId: bigint): Promise<string> { noChain(); }
  async getPublishingConvictionAccountOwner(_accountId: bigint): Promise<string> { noChain(); }
  // The 7 #519 PCA write+read methods are OMITTED on purpose: they are
  // optional on ChainAdapter, so the DKGAgent facade's `typeof guard`
  // returns the documented `null` (feature-unavailable) in no-chain mode
  // instead of throwing. Do NOT re-add them as noChain() stubs.
  isV10Ready(): boolean { return false; }
  isRandomSamplingReady(): boolean { return false; }
}
