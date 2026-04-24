import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  UpdateKAParams,
  ExtendStorageParams,
  CreateKCParams,
  UpdateKCParams,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateContextGraphParams,
  PublishParams,
  OnChainPublishResult,
  ConvictionAccountInfo,
  PermanentPublishParams,
  KAUpdateVerification,
  CreateOnChainContextGraphParams,
  CreateOnChainContextGraphResult,
  VerifyParams,
  PublishToContextGraphParams,
  V10PublishDirectParams,
  V10UpdateKCParams,
} from './chain-adapter.js';

export const MOCK_DEFAULT_SIGNER = '0x' + '1'.repeat(40);

/**
 * In-memory mock chain adapter for off-chain development.
 * Implements both V9 (UAL-based) and V8 (legacy KC) interfaces.
 */
export class MockChainAdapter implements ChainAdapter {
  readonly chainType = 'evm' as const;
  readonly chainId: string;
  readonly signerAddress: string;

  private nextIdentityId = 1n;
  private nextBatchId = 1n;
  private nextBlock = 1;
  private txIndexInBlock = 0;
  private identities = new Map<string, bigint>();
  private namespaceNextId = new Map<string, bigint>();
  private namespaceOwner = new Map<string, string>();
  private batches = new Map<bigint, { merkleRoot: Uint8Array; kaCount: number }>();
  private collections = new Map<bigint, { merkleRoot: Uint8Array; kaCount: number }>();
  private contextGraphRegistry = new Map<string, Record<string, string>>();
  private events: ChainEvent[] = [];
  /** Reserved UAL ranges per publisher address for verifyPublisherOwnsRange */
  private reservedRangesByPublisher = new Map<string, Array<{ startId: bigint; endId: bigint }>>();

  /** Configurable minimum receiver signatures. When > 0, publishKnowledgeAssets will check the count. Default: 1. */
  minimumRequiredSignatures = 1;

  constructor(chainId = 'mock:31337', signerAddress = MOCK_DEFAULT_SIGNER) {
    this.chainId = chainId;
    this.signerAddress = signerAddress;
  }

  async getIdentityId(): Promise<bigint> {
    const existing = this.identities.get(this.signerAddress);
    return existing ?? 0n;
  }

  async ensureProfile(_options?: { nodeName?: string; stakeAmount?: bigint }): Promise<bigint> {
    const existing = await this.getIdentityId();
    if (existing > 0n) return existing;
    const id = this.nextIdentityId++;
    this.identities.set(this.signerAddress, id);
    return id;
  }

  async registerIdentity(proof: IdentityProof): Promise<bigint> {
    const key = toHex(proof.publicKey);
    const existing = this.identities.get(key);
    if (existing) return existing;

    const id = this.nextIdentityId++;
    this.identities.set(key, id);
    this.pushEvent('IdentityRegistered', { identityId: id.toString() });
    return id;
  }

  /**
   * Test helper: seed a deterministic identity for an address in this in-memory adapter.
   * Used by black-box daemon tests that need stable participant IDs across processes.
   */
  seedIdentity(address: string, identityId: bigint): void {
    this.identities.set(address, identityId);
    if (identityId >= this.nextIdentityId) {
      this.nextIdentityId = identityId + 1n;
    }
  }

  // --- V9 UAL-based methods ---

  async reserveUALRange(count: number): Promise<ReservedRange> {
    const publisher = this.signerAddress;
    let nextId = this.namespaceNextId.get(publisher) ?? 1n;
    const startId = nextId;
    const endId = nextId + BigInt(count) - 1n;
    this.namespaceNextId.set(publisher, endId + 1n);

    const ranges = this.reservedRangesByPublisher.get(publisher) ?? [];
    ranges.push({ startId, endId });
    this.reservedRangesByPublisher.set(publisher, ranges);

    if (!this.namespaceOwner.has(publisher)) {
      this.namespaceOwner.set(publisher, publisher);
    }

    this.pushEvent('UALRangeReserved', {
      publisher,
      startId: startId.toString(),
      endId: endId.toString(),
    });

    return { startId, endId };
  }

  async batchMintKnowledgeAssets(params: BatchMintParams): Promise<BatchMintResult> {
    const batchId = this.nextBatchId++;
    const kaCount = Number(params.endKAId - params.startKAId) + 1;

    this.batches.set(batchId, {
      merkleRoot: params.merkleRoot,
      kaCount,
    });

    this.pushEvent('KnowledgeBatchCreated', {
      batchId: batchId.toString(),
      publisherNodeIdentityId: params.publisherNodeIdentityId.toString(),
      publisherAddress: this.signerAddress,
      merkleRoot: toHex(params.merkleRoot),
      startKAId: params.startKAId.toString(),
      endKAId: params.endKAId.toString(),
      kaCount,
      txHash: this.peekTxHash(),
    });

    return {
      ...this.txResult(true),
      batchId,
    };
  }

  async publishKnowledgeAssets(params: PublishParams): Promise<OnChainPublishResult> {
    if (params.receiverSignatures.length < this.minimumRequiredSignatures) {
      throw new Error('MinSignaturesRequirementNotMet');
    }
    const { startId, endId } = await this.reserveUALRange(params.kaCount);

    const batchId = this.nextBatchId++;
    this.batches.set(batchId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.kaCount,
    });

    const txHash = this.peekTxHash();
    this.pushEvent('KnowledgeBatchCreated', {
      batchId: batchId.toString(),
      publisherNodeIdentityId: params.publisherNodeIdentityId.toString(),
      publisherAddress: this.signerAddress,
      merkleRoot: toHex(params.merkleRoot),
      startKAId: startId.toString(),
      endKAId: endId.toString(),
      kaCount: params.kaCount,
      txHash,
    });

    // Also emit V10-style KCCreated so ChainEventPoller detects events
    // regardless of isV10Ready() gating (mirrors real-world transition behaviour).
    this.pushEvent('KCCreated', {
      kcId: batchId.toString(),
      merkleRoot: toHex(params.merkleRoot),
      publisherAddress: this.signerAddress,
      startKAId: startId.toString(),
      endKAId: endId.toString(),
      kaCount: params.kaCount,
      txHash,
    });

    const result = this.txResult(true);
    return {
      batchId,
      startKAId: startId,
      endKAId: endId,
      txHash: result.hash,
      blockNumber: result.blockNumber,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.signerAddress,
    };
  }

  async resolvePublishByTxHash(txHash: string): Promise<OnChainPublishResult | null> {
    const created = this.events.find((event) =>
      (event.type === 'KCCreated' || event.type === 'KnowledgeBatchCreated') && event.data.txHash === txHash,
    );
    if (!created) return null;

    return {
      batchId: BigInt(String(created.data.kcId ?? created.data.batchId ?? '0')),
      startKAId: created.data.startKAId != null ? BigInt(String(created.data.startKAId)) : undefined,
      endKAId: created.data.endKAId != null ? BigInt(String(created.data.endKAId)) : undefined,
      txHash,
      blockNumber: created.blockNumber,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: String(created.data.publisherAddress ?? this.signerAddress),
      tokenAmount: created.data.tokenAmount != null ? BigInt(String(created.data.tokenAmount)) : undefined,
    };
  }

  async getRequiredPublishTokenAmount(_publicByteSize: bigint, _epochs: number): Promise<bigint> {
    return 1n;
  }

  async publishKnowledgeAssetsPermanent(params: PermanentPublishParams): Promise<OnChainPublishResult> {
    const { startId, endId } = await this.reserveUALRange(params.kaCount);

    const batchId = this.nextBatchId++;
    this.batches.set(batchId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.kaCount,
    });

    const txHash = this.peekTxHash();
    this.pushEvent('KnowledgeBatchCreated', {
      batchId: batchId.toString(),
      publisherAddress: this.signerAddress,
      merkleRoot: toHex(params.merkleRoot),
      startKAId: startId.toString(),
      endKAId: endId.toString(),
      kaCount: params.kaCount,
      isPermanent: true,
      txHash,
    });

    const result = this.txResult(true);
    return {
      batchId,
      startKAId: startId,
      endKAId: endId,
      txHash: result.hash,
      blockNumber: result.blockNumber,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.signerAddress,
    };
  }

  async verifyPublisherOwnsRange(
    publisherAddress: string,
    startKAId: bigint,
    endKAId: bigint,
  ): Promise<boolean> {
    const ranges = this.reservedRangesByPublisher.get(publisherAddress);
    if (!ranges?.length) return false;
    for (const r of ranges) {
      if (r.startId <= startKAId && r.endId >= endKAId) return true;
    }
    return false;
  }

  async transferNamespace(newOwner: string): Promise<TxResult> {
    const publisher = this.signerAddress;
    const ranges = this.reservedRangesByPublisher.get(publisher);
    if (ranges?.length) {
      this.reservedRangesByPublisher.set(newOwner, [...ranges]);
      this.reservedRangesByPublisher.delete(publisher);
    }
    const nextId = this.namespaceNextId.get(publisher);
    if (nextId !== undefined) this.namespaceNextId.set(newOwner, nextId);
    this.namespaceNextId.delete(publisher);
    this.namespaceOwner.set(publisher, newOwner);

    this.pushEvent('NamespaceTransferred', {
      from: publisher,
      to: newOwner,
    });

    return this.txResult(true);
  }

  async updateKnowledgeAssets(params: UpdateKAParams): Promise<TxResult> {
    const existing = this.batches.get(params.batchId);
    if (!existing) {
      return this.txResult(false);
    }

    existing.merkleRoot = params.newMerkleRoot;
    const txIndex = this.txIndexInBlock;
    const blockNumber = this.nextBlock;
    const txHash = `0x${blockNumber.toString(16).padStart(64, '0')}${txIndex.toString(16).padStart(4, '0')}`;
    this.pushEvent('KnowledgeBatchUpdated', {
      batchId: params.batchId.toString(),
      newMerkleRoot: toHex(params.newMerkleRoot),
      publisherAddress: this.signerAddress,
      txHash,
      txIndex,
    });

    return this.txResult(true);
  }

  async updateKnowledgeCollectionV10(params: V10UpdateKCParams): Promise<TxResult> {
    const existing = this.batches.get(params.kcId);
    if (!existing) {
      return this.txResult(false);
    }

    existing.merkleRoot = params.newMerkleRoot;
    const txIndex = this.txIndexInBlock;
    const blockNumber = this.nextBlock;
    const txHash = `0x${blockNumber.toString(16).padStart(64, '0')}${txIndex.toString(16).padStart(4, '0')}`;
    this.pushEvent('KnowledgeBatchUpdated', {
      batchId: params.kcId.toString(),
      newMerkleRoot: toHex(params.newMerkleRoot),
      publisherAddress: this.signerAddress,
      txHash,
      txIndex,
    });

    return this.txResult(true);
  }

  async verifyKAUpdate(txHash: string, batchId: bigint, publisherAddress: string): Promise<KAUpdateVerification> {
    const match = this.events.find(
      (e) =>
        e.type === 'KnowledgeBatchUpdated' &&
        e.data.txHash === txHash &&
        e.data.batchId === batchId.toString() &&
        String(e.data.publisherAddress).toLowerCase() === publisherAddress.toLowerCase(),
    );
    if (!match) return { verified: false };
    return {
      verified: true,
      onChainMerkleRoot: fromHex(match.data.newMerkleRoot as string),
      blockNumber: match.blockNumber,
      txIndex: typeof match.data.txIndex === 'number' ? match.data.txIndex : 0,
    };
  }

  async extendStorage(params: ExtendStorageParams): Promise<TxResult> {
    const existing = this.batches.get(params.batchId);
    if (!existing) {
      return this.txResult(false);
    }

    this.pushEvent('StorageExtended', {
      batchId: params.batchId.toString(),
      additionalEpochs: params.additionalEpochs,
    });

    return this.txResult(true);
  }

  // --- V8 backward compatibility ---

  async createKnowledgeCollection(params: CreateKCParams): Promise<TxResult> {
    const kcId = this.nextBatchId++;
    this.collections.set(kcId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.knowledgeAssetsCount,
    });

    this.pushEvent('KCCreated', {
      kcId: kcId.toString(),
      merkleRoot: toHex(params.merkleRoot),
      kaCount: params.knowledgeAssetsCount,
    });

    return this.txResult(true);
  }

  async updateKnowledgeCollection(params: UpdateKCParams): Promise<TxResult> {
    const existing = this.collections.get(params.kcId);
    if (!existing) {
      return this.txResult(false);
    }

    existing.merkleRoot = params.newMerkleRoot;
    this.pushEvent('KCUpdated', {
      kcId: params.kcId.toString(),
      newMerkleRoot: toHex(params.newMerkleRoot),
    });

    return this.txResult(true);
  }

  // --- Events ---

  async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
    const from = filter.fromBlock ?? 0;
    const to = filter.toBlock ?? Infinity;
    for (const evt of this.events) {
      if (evt.blockNumber > to) break;
      if (
        evt.blockNumber >= from &&
        filter.eventTypes.includes(evt.type)
      ) {
        yield evt;
      }
    }
  }

  // --- Context Graphs (name-hash commitment via ContextGraphNameRegistry) ---

  async createContextGraph(params: CreateContextGraphParams): Promise<TxResult> {
    const name = params.name ?? 'mock-context-graph';
    const id = params.contextGraphId ?? `0x${Buffer.from(name).toString('hex').padEnd(64, '0')}`;
    const meta = params.metadata ?? {
      ...(params.name && { name: params.name }),
      ...(params.description && { description: params.description }),
    };
    if (this.contextGraphRegistry.has(id)) {
      throw new Error(`Context graph "${id}" already exists on chain`);
    }
    this.contextGraphRegistry.set(id, meta);
    this.pushEvent('NameClaimed', { contextGraphId: id, creator: 'mock-creator', accessPolicy: params.accessPolicy ?? 0 });
    const result = this.txResult(true);
    return { ...result, contextGraphId: id };
  }

  async submitToContextGraph(kcId: string, contextGraphId: string): Promise<TxResult> {
    this.pushEvent('KCSubmittedToContextGraph', { kcId, contextGraphId });
    return this.txResult(true);
  }

  async revealContextGraphMetadata(contextGraphId: string, name: string, description: string): Promise<TxResult> {
    const meta = this.contextGraphRegistry.get(contextGraphId);
    if (!meta) throw new Error(`Context graph "${contextGraphId}" not found`);
    this.contextGraphRegistry.set(contextGraphId, { ...meta, name, description, revealed: 'true' });
    this.pushEvent('NameMetadataRevealed', { contextGraphId, name, description });
    return this.txResult(true);
  }

  async listContextGraphsFromChain(): Promise<import('./chain-adapter.js').ContextGraphOnChain[]> {
    return [];
  }

  // --- Publishing Conviction Accounts ---

  private convictionAccounts = new Map<bigint, {
    admin: string;
    balance: bigint;
    initialDeposit: bigint;
    lockEpochs: number;
    conviction: bigint;
    authorizedKeys: Set<string>;
  }>();
  private nextConvictionAccountId = 1n;

  async createConvictionAccount(amount: bigint, lockEpochs: number): Promise<{ accountId: bigint } & TxResult> {
    const accountId = this.nextConvictionAccountId++;
    const conviction = amount * BigInt(lockEpochs);
    this.convictionAccounts.set(accountId, {
      admin: this.signerAddress,
      balance: amount,
      initialDeposit: amount,
      lockEpochs,
      conviction,
      authorizedKeys: new Set([this.signerAddress]),
    });
    this.pushEvent('ConvictionAccountCreated', { accountId: accountId.toString(), admin: this.signerAddress });
    return { ...this.txResult(true), accountId };
  }

  async addConvictionFunds(accountId: bigint, amount: bigint): Promise<TxResult> {
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) return this.txResult(false);
    acct.balance += amount;
    return this.txResult(true);
  }

  async extendConvictionLock(accountId: bigint, additionalEpochs: number): Promise<TxResult> {
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) return this.txResult(false);
    acct.lockEpochs += additionalEpochs;
    acct.conviction = acct.initialDeposit * BigInt(acct.lockEpochs);
    return this.txResult(true);
  }

  async getConvictionDiscount(accountId: bigint): Promise<{ discountBps: number; conviction: bigint }> {
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) return { discountBps: 0, conviction: 0n };
    const cHalf = 3_000_000n * 10n ** 18n;
    const discountBps = Number((5000n * acct.conviction) / (acct.conviction + cHalf));
    return { discountBps, conviction: acct.conviction };
  }

  async getConvictionAccountInfo(accountId: bigint): Promise<ConvictionAccountInfo | null> {
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) return null;
    const { discountBps } = await this.getConvictionDiscount(accountId);
    return {
      accountId,
      admin: acct.admin,
      balance: acct.balance,
      initialDeposit: acct.initialDeposit,
      lockEpochs: acct.lockEpochs,
      conviction: acct.conviction,
      discountBps,
    };
  }

  // --- Staking Conviction ---

  private delegatorLocks = new Map<string, { lockEpochs: number; startEpoch: number }>();

  async stakeWithLock(identityId: bigint, amount: bigint, lockEpochs: number): Promise<TxResult> {
    const key = `${identityId}-${this.signerAddress}`;
    const existing = this.delegatorLocks.get(key);
    if (!existing || lockEpochs > existing.lockEpochs) {
      this.delegatorLocks.set(key, { lockEpochs, startEpoch: 0 });
    }
    return this.txResult(true);
  }

  async getDelegatorConvictionMultiplier(identityId: bigint, delegator: string): Promise<{ multiplier: number }> {
    const key = `${identityId}-${delegator}`;
    const lock = this.delegatorLocks.get(key);
    const lockEpochs = lock?.lockEpochs ?? 1;
    return { multiplier: computeConvictionMultiplier(lockEpochs) };
  }

  // --- On-Chain Context Graphs (ContextGraphs contract) ---

  private contextGraphs = new Map<bigint, {
    manager: string;
    participantIdentityIds: bigint[];
    requiredSignatures: number;
    metadataBatchId: bigint;
    active: boolean;
    batches: bigint[];
  }>();
  private nextContextGraphId = 1n;

  async createOnChainContextGraph(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    if (params.requiredSignatures < 1) {
      throw new Error('Mock: requiredSignatures must be >= 1');
    }
    if (params.requiredSignatures > params.participantIdentityIds.length) {
      throw new Error(`Mock: requiredSignatures (${params.requiredSignatures}) exceeds participant count (${params.participantIdentityIds.length})`);
    }
    for (let i = 1; i < params.participantIdentityIds.length; i++) {
      if (params.participantIdentityIds[i] <= params.participantIdentityIds[i - 1]) {
        throw new Error('Mock: participantIdentityIds must be strictly increasing (sorted, unique)');
      }
    }

    const contextGraphId = this.nextContextGraphId++;
    this.contextGraphs.set(contextGraphId, {
      manager: this.signerAddress,
      participantIdentityIds: [...params.participantIdentityIds],
      requiredSignatures: params.requiredSignatures,
      metadataBatchId: params.metadataBatchId ?? 0n,
      active: true,
      batches: [],
    });

    this.pushEvent('ContextGraphCreated', {
      contextGraphId: contextGraphId.toString(),
      manager: this.signerAddress,
      participantIdentityIds: params.participantIdentityIds.map((id) => id.toString()),
      requiredSignatures: params.requiredSignatures,
    });

    return {
      ...this.txResult(true),
      contextGraphId,
    };
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    return { r: new Uint8Array(32), vs: new Uint8Array(32) };
  }

  async getMinimumRequiredSignatures(): Promise<number> {
    return this.minimumRequiredSignatures;
  }

  async verifyACKIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    // Strict binding: recovered address must match the identity's registered address
    const normalizedAddress = recoveredAddress.toLowerCase();
    for (const [addr, id] of this.identities) {
      if (id === claimedIdentityId && addr.toLowerCase() === normalizedAddress) {
        return true;
      }
    }
    return false;
  }

  async verifySyncIdentity(recoveredAddress: string, claimedIdentityId: bigint): Promise<boolean> {
    return this.verifyACKIdentity(recoveredAddress, claimedIdentityId);
  }

  private mockACKSigner?: import('ethers').Wallet;

  setMockACKSigner(wallet: import('ethers').Wallet) {
    this.mockACKSigner = wallet;
  }

  async signACKDigest(digest: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array } | undefined> {
    if (!this.mockACKSigner) return undefined;
    const { ethers: eth } = await import('ethers');
    const sig = eth.Signature.from(await this.mockACKSigner.signMessage(digest));
    return {
      r: eth.getBytes(sig.r),
      vs: eth.getBytes(sig.yParityAndS),
    };
  }

  getACKSignerKey(): string | undefined {
    return this.mockACKSigner?.privateKey;
  }

  isV10Ready(): boolean {
    return true;
  }

  async verify(params: VerifyParams): Promise<TxResult> {
    const cg = this.contextGraphs.get(params.contextGraphId);
    if (!cg || !cg.active) {
      return this.txResult(false);
    }

    const batch = this.batches.get(params.batchId);
    if (!batch) {
      throw new Error(`Mock: batch ${params.batchId} does not exist`);
    }
    if (params.merkleRoot != null) {
      const providedHex = typeof params.merkleRoot === 'string'
        ? params.merkleRoot
        : toHex(params.merkleRoot);
      const storedHex = typeof batch.merkleRoot === 'string'
        ? batch.merkleRoot
        : toHex(batch.merkleRoot);
      if (providedHex !== storedHex) {
        throw new Error(`Mock: merkleRoot mismatch for batch ${params.batchId}`);
      }
    }

    if (params.signerSignatures.length < cg.requiredSignatures) {
      throw new Error(`Not enough signatures: need ${cg.requiredSignatures}, got ${params.signerSignatures.length}`);
    }

    cg.batches.push(params.batchId);

    this.pushEvent('ContextGraphExpanded', {
      contextGraphId: params.contextGraphId.toString(),
      batchId: params.batchId.toString(),
    });

    return this.txResult(true);
  }

  async publishToContextGraph(params: PublishToContextGraphParams): Promise<OnChainPublishResult> {
    const cg = this.contextGraphs.get(params.contextGraphId);
    if (!cg || !cg.active) {
      throw new Error(`Context graph ${params.contextGraphId} not found or inactive`);
    }

    if (params.participantSignatures.length < cg.requiredSignatures) {
      throw new Error(
        `Not enough participant signatures: need ${cg.requiredSignatures}, got ${params.participantSignatures.length}`,
      );
    }

    const result = await this.publishKnowledgeAssets(params);

    cg.batches.push(result.batchId);
    this.pushEvent('ContextGraphExpanded', {
      contextGraphId: params.contextGraphId.toString(),
      batchId: result.batchId.toString(),
    });

    return result;
  }

  getContextGraph(contextGraphId: bigint) {
    return this.contextGraphs.get(contextGraphId);
  }

  async getContextGraphParticipants(contextGraphId: bigint): Promise<bigint[] | null> {
    const cg = this.contextGraphs.get(contextGraphId);
    return cg ? [...cg.participantIdentityIds] : null;
  }

  // --- V10 Publish (KnowledgeAssetsV10 → KnowledgeCollectionStorage) ---

  async getKnowledgeAssetsV10Address(): Promise<string> {
    // 20 valid hex bytes — callers use this solely to build publish digests,
    // never to send a real transaction, so any stable address works. Picked
    // to be visually distinct from `0x0...0` so log-diffing is easier.
    return '0x000000000000000000000000000000000000c10a';
  }

  async getEvmChainId(): Promise<bigint> {
    return 31337n;
  }

  async createKnowledgeAssetsV10(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    // Deliberately tolerant of `contextGraphId === 0n`. The real EVM
    // adapter rejects that at `evm-adapter.ts:createKnowledgeAssetsV10`
    // pre-tx, which is the authoritative fail-loud boundary. The mock is
    // used by ~680 unit tests that publish with descriptive CG-name
    // strings and rely on the silent `0n` fallback to exercise the data
    // flow without migrating every fixture to on-chain numeric ids.
    if (params.ackSignatures.length < this.minimumRequiredSignatures) {
      throw new Error('MinSignaturesRequirementNotMet');
    }

    const kcId = this.nextBatchId++;
    this.collections.set(kcId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.knowledgeAssetsAmount,
    });
    // Also store in batches so verify() can find this publish
    this.batches.set(kcId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.knowledgeAssetsAmount,
    });

    const txHash = this.peekTxHash();
    const startKAId = kcId * 100n + 1n;
    const endKAId = startKAId + BigInt(params.knowledgeAssetsAmount) - 1n;

    this.pushEvent('KCCreated', {
      kcId: kcId.toString(),
      publishOperationId: params.publishOperationId,
      merkleRoot: toHex(params.merkleRoot),
      byteSize: params.byteSize.toString(),
      txHash,
      publisherAddress: this.signerAddress,
      startKAId: startKAId.toString(),
      endKAId: endKAId.toString(),
      isImmutable: params.isImmutable,
      contextGraphId: params.contextGraphId.toString(),
      paymaster: params.paymaster,
    });

    const result = this.txResult(true);
    return {
      batchId: kcId,
      startKAId,
      endKAId,
      txHash: result.hash,
      blockNumber: result.blockNumber,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.signerAddress,
      tokenAmount: params.tokenAmount,
    };
  }

  // --- Test helpers ---

  getBatch(batchId: bigint) {
    return this.batches.get(batchId);
  }

  getCollection(kcId: bigint) {
    return this.collections.get(kcId);
  }

  getIdentityIdByKey(publicKey: Uint8Array): bigint | undefined {
    return this.identities.get(toHex(publicKey));
  }

  getNamespaceOwner(address: string): string | undefined {
    return this.namespaceOwner.get(address);
  }

  /**
   * Record an event in the current block. Block advancement happens in
   * advanceBlock() (called by txResult). When autoMine is true (default),
   * each txResult call advances the block. When false, multiple events
   * share a block until advanceBlock() is called explicitly.
   */
  /** Preview the txHash that the next txResult() call will produce (read-only). */
  private peekTxHash(): string {
    return `0x${this.nextBlock.toString(16).padStart(64, '0')}${this.txIndexInBlock.toString(16).padStart(4, '0')}`;
  }

  private pushEvent(type: string, data: Record<string, unknown>): void {
    this.events.push({ type, blockNumber: this.nextBlock, data });
  }

  private txResult(success: boolean): TxResult {
    const blockNumber = this.nextBlock;
    const txIndex = this.txIndexInBlock++;
    const hash = `0x${blockNumber.toString(16).padStart(64, '0')}${txIndex.toString(16).padStart(4, '0')}`;

    if (this.autoMine) this.advanceBlock();
    return { hash, blockNumber, success };
  }

  /** Advance to next block, resetting the tx index counter. */
  advanceBlock(): void {
    this.nextBlock++;
    this.txIndexInBlock = 0;
  }

  /**
   * When true (default), each txResult automatically advances the block.
   * Set to false to group multiple transactions in the same block for testing.
   */
  autoMine = true;
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * V10 conviction multiplier — discrete tiers matching Solidity.
 * 0 → 0, 1 → 1.0x, 2 → 1.5x, 3-5 → 2.0x, 6-11 → 3.5x, 12+ → 6.0x
 */
export function computeConvictionMultiplier(lockEpochs: number): number {
  if (lockEpochs <= 0) return 0;
  if (lockEpochs >= 12) return 6.0;
  if (lockEpochs >= 6) return 3.5;
  if (lockEpochs >= 3) return 2.0;
  if (lockEpochs >= 2) return 1.5;
  return 1.0;
}
