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
  CreateParanetParams,
  PublishParams,
  OnChainPublishResult,
  ConvictionAccountInfo,
  PermanentPublishParams,
  FairSwapPurchaseInfo,
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
  private identities = new Map<string, bigint>();
  private namespaceNextId = new Map<string, bigint>();
  private namespaceOwner = new Map<string, string>();
  private batches = new Map<bigint, { merkleRoot: Uint8Array; kaCount: number }>();
  private collections = new Map<bigint, { merkleRoot: Uint8Array; kaCount: number }>();
  private paranets = new Map<string, Record<string, string>>();
  private events: ChainEvent[] = [];
  /** Reserved UAL ranges per publisher address for verifyPublisherOwnsRange */
  private reservedRangesByPublisher = new Map<string, Array<{ startId: bigint; endId: bigint }>>();

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
    });

    return {
      ...this.txResult(true),
      batchId,
    };
  }

  async publishKnowledgeAssets(params: PublishParams): Promise<OnChainPublishResult> {
    const { startId, endId } = await this.reserveUALRange(params.kaCount);

    const batchId = this.nextBatchId++;
    this.batches.set(batchId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.kaCount,
    });

    const blockNumber = this.nextBlock++;
    const blockTimestamp = Math.floor(Date.now() / 1000);
    const txHash = `0x${blockNumber.toString(16).padStart(64, '0')}`;

    this.events.push({
      type: 'KnowledgeBatchCreated',
      blockNumber,
      data: {
        batchId: batchId.toString(),
        publisherNodeIdentityId: params.publisherNodeIdentityId.toString(),
        publisherAddress: this.signerAddress,
        merkleRoot: toHex(params.merkleRoot),
        startKAId: startId.toString(),
        endKAId: endId.toString(),
        kaCount: params.kaCount,
        txHash,
      },
    });

    return {
      batchId,
      startKAId: startId,
      endKAId: endId,
      txHash,
      blockNumber,
      blockTimestamp,
      publisherAddress: this.signerAddress,
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

    const blockNumber = this.nextBlock++;
    const blockTimestamp = Math.floor(Date.now() / 1000);
    const txHash = `0x${blockNumber.toString(16).padStart(64, '0')}`;

    this.events.push({
      type: 'KnowledgeBatchCreated',
      blockNumber,
      data: {
        batchId: batchId.toString(),
        publisherAddress: this.signerAddress,
        merkleRoot: toHex(params.merkleRoot),
        startKAId: startId.toString(),
        endKAId: endId.toString(),
        kaCount: params.kaCount,
        isPermanent: true,
        txHash,
      },
    });

    return {
      batchId,
      startKAId: startId,
      endKAId: endId,
      txHash,
      blockNumber,
      blockTimestamp,
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
    this.pushEvent('KnowledgeBatchUpdated', {
      batchId: params.batchId.toString(),
      newMerkleRoot: toHex(params.newMerkleRoot),
    });

    return this.txResult(true);
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

  // --- Paranets ---

  async createParanet(params: CreateParanetParams): Promise<TxResult> {
    const name = params.name ?? 'mock-paranet';
    const id = params.paranetId ?? `0x${Buffer.from(name).toString('hex').padEnd(64, '0')}`;
    const meta = params.metadata ?? {
      ...(params.name && { name: params.name }),
      ...(params.description && { description: params.description }),
    };
    if (this.paranets.has(id)) {
      throw new Error(`Paranet "${id}" already exists on chain`);
    }
    this.paranets.set(id, meta);
    this.pushEvent('ParanetCreated', { paranetId: id, creator: 'mock-creator', accessPolicy: params.accessPolicy ?? 0 });
    const result = this.txResult(true);
    return { ...result, paranetId: id };
  }

  async submitToParanet(kcId: string, paranetId: string): Promise<TxResult> {
    this.pushEvent('KCSubmittedToParanet', { kcId, paranetId });
    return this.txResult(true);
  }

  async revealParanetMetadata(paranetId: string, name: string, description: string): Promise<TxResult> {
    const meta = this.paranets.get(paranetId);
    if (!meta) throw new Error(`Paranet "${paranetId}" not found`);
    this.paranets.set(paranetId, { ...meta, name, description, revealed: 'true' });
    this.pushEvent('ParanetMetadataRevealed', { paranetId, name, description });
    return this.txResult(true);
  }

  async listParanetsFromChain(): Promise<import('./chain-adapter.js').ParanetOnChain[]> {
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

  // --- FairSwap Judge ---

  private fairSwapPurchases = new Map<bigint, {
    buyer: string;
    seller: string;
    kcId: bigint;
    kaId: bigint;
    price: bigint;
    state: number;
    encryptedDataRoot: Uint8Array;
    keyCommitment: Uint8Array;
    revealedKey: Uint8Array;
  }>();
  private nextFairSwapPurchaseId = 1n;

  async initiatePurchase(seller: string, kcId: bigint, kaId: bigint, price: bigint): Promise<{ purchaseId: bigint } & TxResult> {
    const purchaseId = this.nextFairSwapPurchaseId++;
    this.fairSwapPurchases.set(purchaseId, {
      buyer: this.signerAddress,
      seller,
      kcId,
      kaId,
      price,
      state: 1, // Initiated
      encryptedDataRoot: new Uint8Array(32),
      keyCommitment: new Uint8Array(32),
      revealedKey: new Uint8Array(32),
    });
    this.pushEvent('PurchaseInitiated', { purchaseId: purchaseId.toString(), buyer: this.signerAddress, seller });
    return { ...this.txResult(true), purchaseId };
  }

  async fulfillPurchase(purchaseId: bigint, encryptedDataRoot: Uint8Array, keyCommitment: Uint8Array): Promise<TxResult> {
    const p = this.fairSwapPurchases.get(purchaseId);
    if (!p || p.state !== 1) return this.txResult(false);
    p.encryptedDataRoot = encryptedDataRoot;
    p.keyCommitment = keyCommitment;
    p.state = 2; // Fulfilled
    return this.txResult(true);
  }

  async revealKey(purchaseId: bigint, key: Uint8Array): Promise<TxResult> {
    const p = this.fairSwapPurchases.get(purchaseId);
    if (!p || p.state !== 2) return this.txResult(false);
    p.revealedKey = key;
    p.state = 3; // KeyRevealed
    return this.txResult(true);
  }

  async disputeDelivery(purchaseId: bigint, _proof: Uint8Array): Promise<TxResult> {
    const p = this.fairSwapPurchases.get(purchaseId);
    if (!p || p.state !== 3) return this.txResult(false);
    p.state = 5; // Disputed
    return this.txResult(true);
  }

  async claimPayment(purchaseId: bigint): Promise<TxResult> {
    const p = this.fairSwapPurchases.get(purchaseId);
    if (!p || p.state !== 3) return this.txResult(false);
    p.state = 4; // Completed
    return this.txResult(true);
  }

  async claimRefund(purchaseId: bigint): Promise<TxResult> {
    const p = this.fairSwapPurchases.get(purchaseId);
    if (!p || (p.state !== 1 && p.state !== 2)) return this.txResult(false);
    p.state = 7; // Expired
    return this.txResult(true);
  }

  async getFairSwapPurchase(purchaseId: bigint): Promise<FairSwapPurchaseInfo | null> {
    const p = this.fairSwapPurchases.get(purchaseId);
    if (!p) return null;
    return {
      purchaseId,
      buyer: p.buyer,
      seller: p.seller,
      kcId: p.kcId,
      kaId: p.kaId,
      price: p.price,
      state: p.state,
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

  private pushEvent(type: string, data: Record<string, unknown>): void {
    this.events.push({ type, blockNumber: this.nextBlock++, data });
  }

  private txResult(success: boolean): TxResult {
    return {
      hash: `0x${(this.nextBlock - 1).toString(16).padStart(64, '0')}`,
      blockNumber: this.nextBlock - 1,
      success,
    };
  }
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Conviction multiplier matching the Solidity formula.
 * lockEpochs=0 → 0, lockEpochs=1 → 1.0, lockEpochs=3 → 2.0, lockEpochs>=12 → 3.0
 */
export function computeConvictionMultiplier(lockEpochs: number): number {
  if (lockEpochs <= 0) return 0;
  if (lockEpochs === 1) return 1.0;
  const x = lockEpochs - 1;
  const result = 1 + (18 * x) / (7 * x + 22);
  return Math.min(3.0, result);
}
