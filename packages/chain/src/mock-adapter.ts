import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  CreateKCParams,
  UpdateKCParams,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateContextGraphParams,
  OnChainPublishResult,
  KAUpdateVerification,
  CreateOnChainContextGraphParams,
  CreateOnChainContextGraphResult,
  VerifyParams,
  PublishToContextGraphParams,
  V10PublishParams,
  V10UpdateKCParams,
  NodeChallenge,
  ProofPeriodStatus,
  CreateChallengeResult,
  OperationalWalletRegistrationResult,
  V10PublishingConvictionAccountInfo,
} from './chain-adapter.js';
import {
  NoEligibleContextGraphError,
  NoEligibleKnowledgeCollectionError,
  MerkleRootMismatchError,
  ChallengeNoLongerActiveError,
} from './chain-adapter.js';
import { ethers } from 'ethers';

export const MOCK_DEFAULT_SIGNER = '0x' + '1'.repeat(40);

interface MockBatch {
  merkleRoot: Uint8Array;
  kaCount: number;
  publisherAddress: string;
}

/**
 * In-memory mock chain adapter for off-chain development.
 * Implements both V9 (UAL-based) and V8 (legacy KC) interfaces.
 */
export class MockChainAdapter implements ChainAdapter {
  readonly chainType = 'evm' as const;
  readonly chainId: string;
  readonly signerAddress: string;

  /** See `ChainAdapter.deploymentId`. Single in-memory deployment per process — chainId is enough. */
  get deploymentId(): string {
    return this.chainId;
  }

  private nextIdentityId = 1n;
  private nextBatchId = 1n;
  private nextBlock = 1;
  private txIndexInBlock = 0;
  private identities = new Map<string, bigint>();
  private namespaceNextId = new Map<string, bigint>();
  private namespaceOwner = new Map<string, string>();
  private batches = new Map<bigint, MockBatch>();
  private collections = new Map<bigint, {
    merkleRoot: Uint8Array;
    kaCount: number;
    /** V10 flat-KC merkle leaf count (sorted + deduped). 0 for legacy V8 entries. */
    merkleLeafCount: number;
    /** Publisher EOA from `createKnowledgeAssetsV10`; default to mock signer for V8 paths. */
    publisherAddress: string;
    /**
     * Verified author identity from the V10.1 author attestation, mirrored
     * from the EIP-712 EOA-recovered (or EIP-1271-verified) address. Empty
     * string for legacy V8 / V9 publishes that pre-date author attestation
     * — `getLatestMerkleRootAuthor` returns the zero address in that case
     * to match on-chain behaviour for un-attested writes.
     */
    authorAddress: string;
    /** On-chain context graph id (0n when the mock V8 path didn't carry one). */
    cgId: bigint;
  }>();
  private contextGraphRegistry = new Map<string, Record<string, string>>();
  private events: ChainEvent[] = [];
  /** Reserved UAL ranges per publisher address for verifyPublisherOwnsRange */
  private reservedRangesByPublisher = new Map<string, Array<{ startId: bigint; endId: bigint }>>();
  /** Publisher addresses this mock is explicitly allowed to attribute V10 publishes to. */
  private allowedPublisherAddresses: Set<string>;

  /** Configurable minimum receiver signatures. When > 0, the V9 publish-shim path will check the count. Default: 1. */
  minimumRequiredSignatures = 1;

  // RFC 04 v0.3 / Issue #461 — in-memory mirror of ProfileStorage's
  // relay-capability flag. Keyed by identityId (bigint) to match the
  // on-chain shape. Multiaddrs are not stored on Profile (RFC 04 §5.2).
  private relayCapableByIdentity = new Map<bigint, boolean>();

  constructor(chainId = 'mock:31337', signerAddress = MOCK_DEFAULT_SIGNER) {
    this.chainId = chainId;
    this.signerAddress = signerAddress;
    this.allowedPublisherAddresses = new Set([ethers.getAddress(signerAddress).toLowerCase()]);
  }

  async getIdentityId(): Promise<bigint> {
    const existing = this.identities.get(this.signerAddress);
    return existing ?? 0n;
  }

  async ensureProfile(_options?: { nodeName?: string; stakeAmount?: bigint; lockTier?: number }): Promise<bigint> {
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
    if (ethers.isAddress(address)) {
      this.allowPublisherAddress(address);
    }
    if (identityId >= this.nextIdentityId) {
      this.nextIdentityId = identityId + 1n;
    }
  }

  /**
   * Test helper: allow delegated V10 publishes to be attributed to an address
   * without also pretending that address owns a node identity.
   */
  allowPublisherAddress(address: string): void {
    this.allowedPublisherAddresses.add(ethers.getAddress(address).toLowerCase());
  }

  // --- RFC 04 v0.3 / Issue #461 — Network State Registry surface ---
  //
  // Reads return false for unknown identities, matching Solidity's
  // zero-init mapping behaviour.

  async getRelayCapable(identityId: bigint): Promise<boolean> {
    return this.relayCapableByIdentity.get(identityId) ?? false;
  }

  async setRelayCapable(relayCapable: boolean): Promise<TxResult> {
    const identityId = await this.getIdentityId();
    if (identityId === 0n) {
      throw new Error('setRelayCapable: signer has no profile (call ensureProfile first).');
    }
    const oldValue = this.relayCapableByIdentity.get(identityId) ?? false;
    this.relayCapableByIdentity.set(identityId, relayCapable);
    this.pushEvent('RelayCapabilityUpdated', {
      identityId: identityId.toString(),
      oldValue,
      newValue: relayCapable,
    });
    return this.txResult(true);
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
      publisherAddress: this.signerAddress,
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

  async updateKnowledgeCollectionV10(params: V10UpdateKCParams): Promise<TxResult> {
    const existing = this.batches.get(params.kcId);
    if (!existing) {
      return this.txResult(false);
    }

    // P-1 review (Codex iter-5/iter-6): match the real EVM adapter's
    // "fail closed on hook error" contract — listeners are the durable
    // WAL and must be able to abort broadcast by throwing.
    //
    // Codex iter-6: the breadcrumb MUST equal the tx hash the adapter
    // eventually returns, otherwise recovery tests cannot reconcile
    // "persisted before send" with "confirmed after send". Using
    // `peekTxHash()` (same deterministic generator that feeds `txResult`
    // below) guarantees the pre-broadcast hash === the post-broadcast
    // hash, and naturally varies across repeated updates of the same
    // `kcId` because `txIndexInBlock` advances per-tx.
    const mockUpdateTxHash = this.peekTxHash();
    try {
      // Codex PR #241 iter-7: `await` an async WAL hook.
      await params.onBroadcast?.({ txHash: mockUpdateTxHash });
    } catch (hookErr) {
      throw new Error(
        `chain:writeahead hook failed before updateKnowledgeCollectionV10 broadcast (mock): ` +
        `${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }

    existing.merkleRoot = params.newMerkleRoot;
    const collection = this.collections.get(params.kcId);
    if (collection) {
      collection.merkleRoot = params.newMerkleRoot;
      collection.merkleLeafCount = params.newMerkleLeafCount;
    }
    const hintedPublisherAddress = params.publisherAddress
      ? ethers.getAddress(params.publisherAddress)
      : undefined;
    const publisherAddress = collection?.publisherAddress ?? existing.publisherAddress ?? hintedPublisherAddress;
    if (collection) collection.publisherAddress = publisherAddress;
    existing.publisherAddress = publisherAddress;
    const txIndex = this.txIndexInBlock;
    const blockNumber = this.nextBlock;
    const txHash = `0x${blockNumber.toString(16).padStart(64, '0')}${txIndex.toString(16).padStart(4, '0')}`;
    this.pushEvent('KnowledgeBatchUpdated', {
      batchId: params.kcId.toString(),
      newMerkleRoot: toHex(params.newMerkleRoot),
      publisherAddress,
      txHash,
      txIndex,
    });

    return {
      ...this.txResult(true),
      publisherAddress,
    };
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

  // --- V8 backward compatibility ---

  async createKnowledgeCollection(params: CreateKCParams): Promise<TxResult> {
    const kcId = this.nextBatchId++;
    this.collections.set(kcId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.knowledgeAssetsCount,
      merkleLeafCount: 0,
      publisherAddress: this.signerAddress,
      // Legacy V8 path — no attestation, mirror the on-chain `address(0)`.
      authorAddress: ethers.ZeroAddress,
      cgId: 0n,
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

  // --- V10 Publishing Conviction NFT (DKGPublishingConvictionNFT) ---
  // In-memory parity: account map + agent reverse map + owner-gating.

  private convictionAccounts = new Map<bigint, {
    owner: string;
    committedTRAC: bigint;
    topUpBuffer: bigint;
    lockDurationEpochs: number;
    /** Discount tier (bps) fixed at creation, mirrors the contract. */
    discountBps: number;
    /** Monotonic mock epoch captured at creation (no chronos in mock). */
    createdAtEpoch: number;
    agents: Set<string>;
  }>();
  private agentToConvictionAccount = new Map<string, bigint>();
  private nextConvictionAccountId = 1n;
  // Mock has no chronos; a monotonic (boundary-aligned) counter stands in
  // for the creation epoch — a mock-internal model, not contract parity.
  private mockConvictionEpoch = 0;

  // Mirrors chain `ParametersStorage.publishingConvictionEpochs` (12).
  private static readonly MOCK_LOCK_DURATION_EPOCHS = 12;

  // Mirrors DKGPublishingConvictionNFT default maxAgentsPerAccount
  // (DKGPublishingConvictionNFT.sol:208 — defaults to 100 when unset).
  private static readonly MOCK_MAX_AGENTS_PER_ACCOUNT = 100;

  /**
   * Mirrors `DKGPublishingConvictionNFT.getDiscountBps` exactly
   * (DKGPublishingConvictionNFT.sol L767-775): discrete 6-tier ladder,
   * `ether` == 1e18, evaluated highest-first. Fixed at creation.
   */
  private static convictionDiscountBps(committedTRAC: bigint): number {
    const ETHER = 10n ** 18n;
    if (committedTRAC >= 1_000_000n * ETHER) return 7500; // 75%
    if (committedTRAC >= 500_000n * ETHER) return 5000; // 50%
    if (committedTRAC >= 250_000n * ETHER) return 4000; // 40%
    if (committedTRAC >= 100_000n * ETHER) return 3000; // 30%
    if (committedTRAC >= 50_000n * ETHER) return 2000; // 20%
    if (committedTRAC >= 25_000n * ETHER) return 1000; // 10%
    return 0;
  }

  /** Test helper (not in `ChainAdapter`): seed a PCA owned by `admin`
   *  for publish-policy branches that need a known PCA owner. */
  seedConvictionAccount(admin: string): bigint {
    const accountId = this.nextConvictionAccountId++;
    this.convictionAccounts.set(accountId, {
      owner: ethers.getAddress(admin),
      committedTRAC: 0n,
      topUpBuffer: 0n,
      lockDurationEpochs: MockChainAdapter.MOCK_LOCK_DURATION_EPOCHS,
      discountBps: MockChainAdapter.convictionDiscountBps(0n),
      createdAtEpoch: this.mockConvictionEpoch++,
      agents: new Set<string>(),
    });
    return accountId;
  }

  // Contract parity: createAccount/topUp revert `InvalidAmount` for
  // amount==0 or out-of-uint96-range, before any state write.
  private static readonly MAX_UINT96 = (1n << 96n) - 1n;
  private requireValidConvictionAmount(amount: bigint): void {
    if (amount <= 0n || amount > MockChainAdapter.MAX_UINT96) {
      throw new Error(`Mock: InvalidAmount(${amount})`);
    }
  }

  async createPublishingConvictionAccount(committedTRAC: bigint): Promise<{ accountId: bigint } & TxResult> {
    this.requireValidConvictionAmount(committedTRAC);
    const accountId = this.nextConvictionAccountId++;
    this.convictionAccounts.set(accountId, {
      owner: ethers.getAddress(this.signerAddress),
      committedTRAC,
      topUpBuffer: 0n,
      lockDurationEpochs: MockChainAdapter.MOCK_LOCK_DURATION_EPOCHS,
      // Tier fixed at creation, identical formula to the contract.
      discountBps: MockChainAdapter.convictionDiscountBps(committedTRAC),
      createdAtEpoch: this.mockConvictionEpoch++,
      agents: new Set<string>(),
    });
    return { accountId, ...this.txResult(true) };
  }

  async getPublishingConvictionAccountInfo(accountId: bigint): Promise<V10PublishingConvictionAccountInfo | null> {
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) return null;
    return {
      owner: acct.owner,
      committedTRAC: acct.committedTRAC,
      baseEpochAllowance: acct.committedTRAC / BigInt(acct.lockDurationEpochs),
      createdAtEpoch: acct.createdAtEpoch,
      // Mock models boundary-aligned creation only; the contract's mid-epoch
      // round-up (epochAtTimestamp(expiresAtTimestamp-1)+1) is not modeled.
      expiresAtEpoch: acct.createdAtEpoch + acct.lockDurationEpochs,
      // Mock has no wall clock; timestamps stay 0 (epochs are modeled).
      createdAtTimestamp: 0,
      expiresAtTimestamp: 0,
      discountBps: acct.discountBps,
      topUpBuffer: acct.topUpBuffer,
      agentCount: acct.agents.size,
      // STATIC STUBS — settlement is intentionally out of mock-parity scope.
      // Fidelity verified on-chain (evm-module hardhat + devnet smoke).
      lastSettledWindow: 0,
      fullySwept: false,
    };
  }

  private requireConvictionAccount(accountId: bigint) {
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) {
      throw new Error(`Mock: PCA account ${accountId} does not exist`);
    }
    return acct;
  }

  // Owner-gating parity with `_requireOwner` — the SDK must surface the
  // on-chain owner revert, never swallow it (the daemon maps it to 403).
  private requireConvictionOwner(accountId: bigint) {
    const acct = this.requireConvictionAccount(accountId);
    if (acct.owner.toLowerCase() !== ethers.getAddress(this.signerAddress).toLowerCase()) {
      throw new Error(`Mock: NotAccountOwner(${accountId}, ${this.signerAddress})`);
    }
    return acct;
  }

  async topUpPublishingConvictionAccount(accountId: bigint, amount: bigint): Promise<TxResult> {
    const acct = this.requireConvictionOwner(accountId);
    this.requireValidConvictionAmount(amount);
    acct.topUpBuffer += amount;
    return this.txResult(true);
  }

  // DELIBERATE NO-OP — the lazy-settlement cursor is contract accounting,
  // out of mock-parity scope; verified on-chain (hardhat + devnet smoke).
  async settlePublishingConvictionAccount(accountId: bigint): Promise<TxResult> {
    this.requireConvictionAccount(accountId);
    return this.txResult(true);
  }

  async registerPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    const acct = this.requireConvictionOwner(accountId);
    if (agent === ethers.ZeroAddress) {
      throw new Error('Mock: ZeroAgentAddress()');
    }
    const key = ethers.getAddress(agent).toLowerCase();
    if (this.agentToConvictionAccount.has(key)) {
      throw new Error(`Mock: AgentAlreadyRegistered(${agent}, ${this.agentToConvictionAccount.get(key)})`);
    }
    // Contract parity: revert after the already-registered check, before
    // any state write (DKGPublishingConvictionNFT.sol:711-712).
    if (acct.agents.size >= MockChainAdapter.MOCK_MAX_AGENTS_PER_ACCOUNT) {
      throw new Error(`Mock: AgentCapReached(${accountId}, ${MockChainAdapter.MOCK_MAX_AGENTS_PER_ACCOUNT})`);
    }
    acct.agents.add(key);
    this.agentToConvictionAccount.set(key, accountId);
    return this.txResult(true);
  }

  async deregisterPublishingConvictionAgent(accountId: bigint, agent: string): Promise<TxResult> {
    const acct = this.requireConvictionOwner(accountId);
    const key = ethers.getAddress(agent).toLowerCase();
    if (!acct.agents.has(key)) {
      throw new Error(`Mock: AgentNotRegistered(${accountId}, ${agent})`);
    }
    acct.agents.delete(key);
    this.agentToConvictionAccount.delete(key);
    return this.txResult(true);
  }

  async isPublishingConvictionAgent(accountId: bigint, agent: string): Promise<boolean> {
    if (!ethers.isAddress(agent)) return false;
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) return false;
    return acct.agents.has(ethers.getAddress(agent).toLowerCase());
  }

  /** Mirrors `agentToAccountId`; `0n` for unregistered → publisher SDK
   *  stays on direct-spend until an agent is registered. */
  async getConvictionAgentAccountId(agent: string): Promise<bigint> {
    if (!ethers.isAddress(agent)) return 0n;
    return this.agentToConvictionAccount.get(ethers.getAddress(agent).toLowerCase()) ?? 0n;
  }

  async getConvictionAccountLockDurationEpochs(accountId: bigint): Promise<number> {
    return this.convictionAccounts.get(accountId)?.lockDurationEpochs ?? 0;
  }

  /**
   * Mock owner-lookup for the daemon's curated-CG registration
   * preflight (`local curator == ownerOf(pcaAccountId)`).
   */
  async getPublishingConvictionAccountOwner(accountId: bigint): Promise<string> {
    const acct = this.convictionAccounts.get(accountId);
    if (!acct) {
      throw new Error(`Mock: PCA account ${accountId} does not exist`);
    }
    return acct.owner;
  }

  // --- On-Chain Context Graphs (ContextGraphs contract) ---

  private contextGraphs = new Map<bigint, {
    manager: string;
    participantAgents: string[];
    metadataBatchId: bigint;
    accessPolicy: number;
    publishPolicy: number;
    publishAuthority?: string;
    publishAuthorityAccountId: bigint;
    active: boolean;
    batches: bigint[];
    // OT-RFC-38 / LU-6 Phase B — curator-committed wire id.
    // `null` indicates the curator opted out at create time.
    nameHash?: string | null;
  }>();
  private nextContextGraphId = 1n;

  async createOnChainContextGraph(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    if (params.accessPolicy === undefined || params.publishPolicy === undefined) {
      throw new Error(
        'Mock createOnChainContextGraph: `accessPolicy` and `publishPolicy` are required (SPEC_CG_MEMORY_MODEL).',
      );
    }
    const { accessPolicy, publishPolicy } = params;
    if (accessPolicy !== 0 && accessPolicy !== 1) {
      throw new Error('Mock: invalid accessPolicy');
    }
    if (publishPolicy !== 0 && publishPolicy !== 1) {
      throw new Error('Mock: invalid publishPolicy');
    }
    let publishAuthority = params.publishAuthority ?? ethers.ZeroAddress;
    let publishAuthorityAccountId = params.publishAuthorityAccountId ?? 0n;
    if (!ethers.isAddress(publishAuthority)) {
      throw new Error(`Mock: invalid publishAuthority ${publishAuthority}`);
    }
    publishAuthority = ethers.getAddress(publishAuthority);
    if (publishPolicy === 0) {
      if (publishAuthority === ethers.ZeroAddress) {
        publishAuthority = ethers.getAddress(this.signerAddress);
      }
      if (publishAuthorityAccountId !== 0n) {
        const pcaOwner = await this.getPublishingConvictionAccountOwner(publishAuthorityAccountId);
        if (publishAuthority.toLowerCase() !== pcaOwner.toLowerCase()) {
          throw new Error('Mock: PCA publishAuthority must match account owner');
        }
      }
    } else {
      if (publishAuthority !== ethers.ZeroAddress) {
        throw new Error('Mock: open policy requires zero publishAuthority');
      }
      if (publishAuthorityAccountId !== 0n) {
        throw new Error('Mock: open policy requires zero publishAuthorityAccountId');
      }
      publishAuthority = ethers.ZeroAddress;
      publishAuthorityAccountId = 0n;
    }
    const participantAgents = params.participantAgents ?? [];
    if (participantAgents.length > 256) {
      throw new Error('Mock: participantAgents cap');
    }
    const seenParticipantAgents = new Set<string>();
    for (const agent of participantAgents) {
      if (!ethers.isAddress(agent)) {
        throw new Error(`Mock: invalid participant agent ${agent}`);
      }
      const normalized = ethers.getAddress(agent);
      if (normalized === ethers.ZeroAddress) {
        throw new Error('Mock: zero participant agent');
      }
      const key = normalized.toLowerCase();
      if (seenParticipantAgents.has(key)) {
        throw new Error(`Mock: duplicate participant agent ${normalized}`);
      }
      seenParticipantAgents.add(key);
    }

    // OT-RFC-38 / LU-6 Phase B — accept the curator's wire-id commitment
    // verbatim. Validation is intentionally permissive: the contract
    // accepts ANY non-zero 32-byte value, including ones that aren't
    // derivable from a known cleartext (forward compatibility). Mock
    // stores `null` for the opt-out path so the event surface matches
    // the EVM adapter's `nameHashRaw === '0x' ? null : ...` shape.
    let nameHash: string | null = null;
    if (params.nameHash !== undefined && params.nameHash !== ethers.ZeroHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(params.nameHash)) {
        throw new Error(`Mock: invalid nameHash ${params.nameHash}`);
      }
      nameHash = params.nameHash.toLowerCase();
    }

    const contextGraphId = this.nextContextGraphId++;
    this.contextGraphs.set(contextGraphId, {
      manager: this.signerAddress,
      participantAgents: participantAgents.map((agent) => ethers.getAddress(agent)),
      metadataBatchId: params.metadataBatchId ?? 0n,
      accessPolicy,
      publishPolicy,
      publishAuthority,
      publishAuthorityAccountId,
      active: true,
      batches: [],
      nameHash,
    });

    this.pushEvent('ContextGraphCreated', {
      contextGraphId: contextGraphId.toString(),
      creator: this.signerAddress,
      owner: this.signerAddress,
      manager: this.signerAddress,
      participantAgents: participantAgents.map((agent) => ethers.getAddress(agent)),
      accessPolicy,
      publishPolicy,
      nameHash,
    });

    return {
      ...this.txResult(true),
      contextGraphId,
    };
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    return { r: new Uint8Array(32), vs: new Uint8Array(32) };
  }

  /**
   * Mock EIP-712 typed-data signer. If a `mockACKSigner` wallet has been
   * configured (test setups that exercise the full author-attestation
   * flow on hardhat-style fixtures), sign with it so the recovered author
   * matches the wallet address. Otherwise return a deterministic 65-byte
   * zero signature — sufficient for unit tests that only check publish
   * plumbing and never round-trip through real KAv10 verification.
   */
  async signTypedData(
    domain: import('ethers').TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    if (this.mockACKSigner) {
      return this.mockACKSigner.signTypedData(domain, types, value);
    }
    return `0x${'00'.repeat(65)}`;
  }

  async signTypedDataAs(
    address: string,
    domain: import('ethers').TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    if (this.mockACKSigner && this.mockACKSigner.address.toLowerCase() === address.toLowerCase()) {
      return this.mockACKSigner.signTypedData(domain, types, value);
    }
    throw new Error(`Mock: cannot sign typed data as ${address}: address is not the mock ACK signer.`);
  }

  async getMinimumRequiredSignatures(): Promise<number> {
    return this.minimumRequiredSignatures;
  }

  // Codex PR #595 round-4: mock environments don't model the sharding
  // table, so any registered (non-zero) identity counts as a member.
  // Tests that need to exercise non-membership rejection should
  // override this with a vi.spyOn / monkey-patch.
  async isShardingTableMember(identityId: bigint): Promise<boolean> {
    return identityId > 0n;
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

  async isOperationalWalletRegistered(identityId: bigint, address: string): Promise<boolean> {
    return this.verifyACKIdentity(address, identityId);
  }

  async ensureOperationalWalletsRegistered(options?: {
    identityId?: bigint;
    additionalAddresses?: string[];
  }): Promise<OperationalWalletRegistrationResult> {
    const identityId = options?.identityId ?? (await this.getIdentityId());
    const result: OperationalWalletRegistrationResult = {
      identityId,
      registered: [],
      alreadyRegistered: [],
      taken: [],
    };
    if (identityId === 0n) return result;

    const candidates = [this.signerAddress, ...(options?.additionalAddresses ?? [])];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const address = ethers.getAddress(candidate);
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = [...this.identities.entries()].find(
        ([addr]) => addr.toLowerCase() === key,
      );
      if (existing?.[1] === identityId) {
        result.alreadyRegistered.push(address);
      } else if (existing) {
        result.taken.push({ address, identityId: existing[1] });
      } else {
        this.identities.set(address, identityId);
        result.registered.push(address);
      }
    }

    return result;
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
    const identityId = await this.getIdentityId();
    if (identityId === 0n || !(await this.isOperationalWalletRegistered(identityId, this.mockACKSigner.address))) {
      return undefined;
    }
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

  isRandomSamplingReady(): boolean {
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

    if (params.signerSignatures.length < this.minimumRequiredSignatures) {
      throw new Error(`Not enough signatures: need ${this.minimumRequiredSignatures}, got ${params.signerSignatures.length}`);
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

    if (params.participantSignatures.length < this.minimumRequiredSignatures) {
      throw new Error(
        `Not enough participant signatures: need ${this.minimumRequiredSignatures}, got ${params.participantSignatures.length}`,
      );
    }

    // Mock publish: emits KnowledgeBatchCreated + KCCreated so
    // resolvePublishByTxHash and ChainEventPoller / WAL consumers can
    // walk events by txHash.
    if (params.receiverSignatures.length < this.minimumRequiredSignatures) {
      throw new Error('MinSignaturesRequirementNotMet');
    }
    const { startId, endId } = await this.reserveUALRange(params.kaCount);
    const batchId = this.nextBatchId++;
    this.batches.set(batchId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.kaCount,
      publisherAddress: this.signerAddress,
    });

    // peek BEFORE txResult() so the event-borne txHash matches the one
    // txResult() advances onto the wire — same pattern as the publish-
    // event emitters above.
    const publishTxHash = this.peekTxHash();
    this.pushEvent('KnowledgeBatchCreated', {
      batchId: batchId.toString(),
      publisherNodeIdentityId: params.publisherNodeIdentityId.toString(),
      publisherAddress: this.signerAddress,
      merkleRoot: toHex(params.merkleRoot),
      startKAId: startId.toString(),
      endKAId: endId.toString(),
      kaCount: params.kaCount,
      txHash: publishTxHash,
    });
    this.pushEvent('KCCreated', {
      kcId: batchId.toString(),
      merkleRoot: toHex(params.merkleRoot),
      publisherAddress: this.signerAddress,
      startKAId: startId.toString(),
      endKAId: endId.toString(),
      kaCount: params.kaCount,
      txHash: publishTxHash,
    });

    const tx = this.txResult(true);
    const result: OnChainPublishResult = {
      batchId,
      startKAId: startId,
      endKAId: endId,
      txHash: tx.hash,
      blockNumber: tx.blockNumber,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.signerAddress,
    };

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

  /**
   * OT-RFC-38 / LU-5: chain-backed access-policy oracle parity for the
   * mock chain. Returns the same uint8 enum the EVM adapter does
   * (`0`=public, `1`=curated). Unknown ids yield `0` to match the
   * Solidity default-zero mapping.
   */
  async getContextGraphAccessPolicy(contextGraphId: bigint): Promise<number> {
    const cg = this.contextGraphs.get(contextGraphId);
    if (!cg) return 0;
    const ap = (cg as { accessPolicy?: number }).accessPolicy;
    return typeof ap === 'number' ? ap : 0;
  }

  /**
   * OT-RFC-38 / LU-6 Phase B: chain-backed participant-agent allowlist
   * parity for the mock. Mirrors {@link getContextGraphAccessPolicy}
   * shape. Returns an empty array when the CG is unknown or has no
   * `participantAgents` field set on the mock state — matching the
   * Solidity getter's behavior on unregistered ids.
   */
  async getContextGraphParticipantAgents(contextGraphId: bigint): Promise<string[]> {
    const cg = this.contextGraphs.get(contextGraphId);
    if (!cg) return [];
    const agents = (cg as { participantAgents?: string[] }).participantAgents;
    if (!Array.isArray(agents)) return [];
    return agents.map((a) => ethers.getAddress(a));
  }

  /**
   * OT-RFC-38 / LU-6 Phase B — mock mirror of
   * `ContextGraphStorage.getNameHash(uint256)`. Returns `null` for
   * unregistered ids OR for ids the curator opted out of committing
   * to a name hash (matches the EVM adapter's `'0x' → null` mapping
   * on the event surface for symmetry).
   */
  async getContextGraphNameHash(contextGraphId: bigint): Promise<string | null> {
    const cg = this.contextGraphs.get(contextGraphId);
    if (!cg) return null;
    return cg.nameHash ?? null;
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

  /**
   * Mock has no real chain to query; treat every author as an EOA so
   * the off-chain ECDSA recover-and-compare preflight stays in effect
   * for unit tests. Production code that needs to test the EIP-1271
   * branch overrides this to `true` (see the publisher's
   * `agent-provenance-e2e.test.ts` "skips ECDSA recover for
   * smart-contract authors" test for the pattern).
   */
  async hasContractCode(_address: string): Promise<boolean> {
    return false;
  }

  async createKnowledgeAssetsV10(params: V10PublishParams): Promise<OnChainPublishResult> {
    // Deliberately tolerant of `contextGraphId === 0n`. The real EVM
    // adapter rejects that at `evm-adapter.ts:createKnowledgeAssetsV10`
    // pre-tx, which is the authoritative fail-loud boundary. The mock is
    // used by ~680 unit tests that publish with descriptive CG-name
    // strings and rely on the silent `0n` fallback to exercise the data
    // flow without migrating every fixture to on-chain numeric ids.
    if (params.ackSignatures.length < this.minimumRequiredSignatures) {
      throw new Error('MinSignaturesRequirementNotMet');
    }

    // P-1 review (follow-up): mirror the EVM adapter's write-ahead
    // hook so mock-backed publisher tests observe the same phase
    // boundary contract (`chain:writeahead:start` fires only when a
    // concrete broadcast is imminent).
    //
    // Codex iter-5/iter-6: fail closed on hook error — matching the
    // real EVM adapter's refactored send path. WAL persistence
    // failures MUST abort the broadcast.
    //
    // Codex iter-6: make the pre-broadcast hash equal the hash the
    // adapter will eventually return in the result (via `txResult`)
    // by deriving both from `peekTxHash()`. This lets recovery tests
    // match "persisted before send" against "confirmed after send"
    // without two separate hash namespaces, and gives each publish
    // a unique breadcrumb (previously keyed only on `nextBatchId`).
    const mockPublishTxHash = this.peekTxHash();
    try {
      // Codex PR #241 iter-7: `await` so async WAL writes run to
      // completion before the mock "broadcasts".
      await params.onBroadcast?.({ txHash: mockPublishTxHash });
    } catch (hookErr) {
      throw new Error(
        `chain:writeahead hook failed before createKnowledgeAssetsV10 broadcast (mock): ` +
        `${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
      );
    }

    const publisherAddress = params.publisherAddress
      ? ethers.getAddress(params.publisherAddress)
      : ethers.getAddress(this.signerAddress);
    if (!this.allowedPublisherAddresses.has(publisherAddress.toLowerCase())) {
      throw new Error(
        `Mock publisherAddress ${publisherAddress} is not allowed with this adapter. ` +
        'Allow the address first to model explicit mock support for address-specific publishing.',
      );
    }
    const kcId = this.nextBatchId++;
    this.collections.set(kcId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.knowledgeAssetsAmount,
      merkleLeafCount: params.merkleLeafCount,
      publisherAddress,
      authorAddress: ethers.getAddress(params.author.address),
      cgId: params.contextGraphId,
    });
    // Also store in batches so verify() can find this publish
    this.batches.set(kcId, {
      merkleRoot: params.merkleRoot,
      kaCount: params.knowledgeAssetsAmount,
      publisherAddress,
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
      publisherAddress,
      startKAId: startKAId.toString(),
      endKAId: endKAId.toString(),
      isImmutable: params.isImmutable,
      contextGraphId: params.contextGraphId.toString(),
      authorAddress: params.author.address,
      authorSchemeVersion: params.author.schemeVersion,
    });

    const result = this.txResult(true);
    return {
      batchId: kcId,
      startKAId,
      endKAId,
      txHash: result.hash,
      blockNumber: result.blockNumber,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress,
      // Mirror evm-adapter: surface the chain-confirmed author from the
      // V10.1 publish path so downstream callers (publisher metadata
      // writers) see the same shape under MockChainAdapter.
      authorAddress: params.author.address,
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

  // =====================================================================
  // Random Sampling — in-memory implementation for off-chain tests.
  //
  // The contract is the source of truth in production; here we maintain
  // just enough state for the proofing service unit tests to exercise
  // every branch (rollover detection, NoEligible* skip, success path,
  // MerkleRootMismatch non-retry, reentrancy guard).
  //
  // Test helpers (`__advanceProofPeriod`, `__registerKC`, `__forceNoEligible`)
  // are NOT on the public ChainAdapter interface — they're documented
  // double-underscore conventions so production code that compiles
  // against the interface can't accidentally call them, while tests
  // can reach them via concrete-typed instance access.
  // =====================================================================

  /**
   * Mock proof period length in blocks. Single source of truth for:
   *   - `__advanceProofPeriod()` cursor step
   *   - `createChallenge()` `NodeChallenge.proofingPeriodDurationInBlocks`
   *   - `getActiveProofPeriodStatus()` `proofingPeriodDurationInBlocks`
   *
   * Codex round 3 on PR #369 — these were three separate `100n` literals.
   * If one drifted the mock would report a self-inconsistent
   * (status, challenge, cursor) tuple and the prover's wall-clock
   * staleness logic could be tested against behaviour the mock never
   * actually simulates. Centralising removes that footgun.
   */
  private static readonly RS_MOCK_PERIOD_DURATION_IN_BLOCKS = 100n;

  private rsPeriodCursor = 1n;            // activeProofPeriodStartBlock
  private rsEpoch = 1n;
  private rsPeriodIsValid = true;
  /** kcId -> {root: bytes32 hex, leaves: leafIndex -> expected bytes32 leaf (hex), kcsAddr } */
  private rsKCs = new Map<bigint, {
    merkleRootHex: string;
    chunks: Map<bigint, string>;
    kcsContract: string;
    cgId: bigint;
  }>();
  /** identityId -> NodeChallenge */
  private rsChallenges = new Map<bigint, NodeChallenge>();
  /** key `${identityId}|${epoch}|${periodStart}` -> score */
  private rsScores = new Map<string, bigint>();
  /** When set, the next createChallenge() call throws this typed error. */
  private rsForcedRevert: 'none' | 'no-cg' | 'no-kc' = 'none';
  /** Round-robin pointer over registered KCs for createChallenge picks. */
  private rsKCPickIndex = 0;

  /** Test helper: advance to a fresh proof period (mirrors a chain rollover). */
  __advanceProofPeriod(): bigint {
    this.rsPeriodCursor += MockChainAdapter.RS_MOCK_PERIOD_DURATION_IN_BLOCKS;
    this.rsPeriodIsValid = true;
    return this.rsPeriodCursor;
  }

  /** Test helper: switch to a new epoch (clears period state for cleanliness). */
  __advanceEpoch(): bigint {
    this.rsEpoch += 1n;
    return this.rsEpoch;
  }

  /**
   * Test helper: pre-seed a KC so createChallenge can land on it.
   *
   * Also mirrors the entry into `collections` so the `getLatestMerkleRoot`
   * / `getMerkleLeafCount` / `getLatestMerkleRootPublisher` /
   * `getKCContextGraphId` view methods stay coherent with the random
   * sampling mock without forcing tests to publish through
   * `createKnowledgeAssetsV10` first. `merkleLeafCount` defaults to the
   * number of chunks supplied (one leaf per chunk), and `publisherAddress`
   * defaults to the mock signer; both can be overridden per call.
   */
  __registerKC(input: {
    kcId: bigint;
    contextGraphId: bigint;
    merkleRootHex: string;
    knowledgeCollectionStorageContract?: string;
    chunks: Array<{ chunkId: bigint; chunk: string }>;
    merkleLeafCount?: number;
    publisherAddress?: string;
  }): void {
    const chunks = new Map<bigint, string>();
    for (const c of input.chunks) chunks.set(c.chunkId, c.chunk);
    this.rsKCs.set(input.kcId, {
      merkleRootHex: input.merkleRootHex,
      chunks,
      kcsContract: input.knowledgeCollectionStorageContract ?? '0x' + 'aa'.repeat(20),
      cgId: input.contextGraphId,
    });
    this.collections.set(input.kcId, {
      merkleRoot: fromHex(input.merkleRootHex),
      kaCount: input.chunks.length,
      merkleLeafCount: input.merkleLeafCount ?? input.chunks.length,
      publisherAddress: input.publisherAddress ?? this.signerAddress,
      // `__registerKC` is a Random-Sampling test bridge that bypasses the
      // V10 publish path entirely; no attestation is signed, so mirror
      // the on-chain `address(0)` semantics for un-attested writes.
      authorAddress: ethers.ZeroAddress,
      cgId: input.contextGraphId,
    });
  }

  /** Test helper: force the next createChallenge to revert with a typed retry-next-period error. */
  __forceNoEligible(kind: 'cg' | 'kc' | 'none'): void {
    this.rsForcedRevert = kind === 'cg' ? 'no-cg' : kind === 'kc' ? 'no-kc' : 'none';
  }

  /** Test helper: read the score the contract would return — bypasses the public adapter surface. */
  __getScoreDirect(identityId: bigint, epoch: bigint, periodStart: bigint): bigint {
    return this.rsScores.get(`${identityId}|${epoch}|${periodStart}`) ?? 0n;
  }

  /** Test helper: simulate the period rolling closed (between rollovers). */
  __setPeriodIsValid(value: boolean): void {
    this.rsPeriodIsValid = value;
  }

  async createChallenge(): Promise<CreateChallengeResult> {
    if (this.rsForcedRevert === 'no-cg') {
      this.rsForcedRevert = 'none';
      throw new NoEligibleContextGraphError();
    }
    if (this.rsForcedRevert === 'no-kc') {
      this.rsForcedRevert = 'none';
      throw new NoEligibleKnowledgeCollectionError();
    }
    if (this.rsKCs.size === 0) {
      throw new NoEligibleContextGraphError();
    }

    const identityId = await this.getIdentityId();
    if (identityId === 0n) {
      throw new Error('Mock: cannot createChallenge without an identity (call ensureProfile first)');
    }

    const existing = this.rsChallenges.get(identityId);
    if (existing && existing.activeProofPeriodStartBlock === this.rsPeriodCursor) {
      if (existing.solved) throw new Error('The challenge for this proof period has already been solved');
      throw new Error('An unsolved challenge already exists for this node in the current proof period');
    }

    // Round-robin pick over registered KCs (deterministic across runs).
    const kcEntries = Array.from(this.rsKCs.entries());
    const [kcId, kcEntry] = kcEntries[this.rsKCPickIndex % kcEntries.length];
    this.rsKCPickIndex++;

    const chunkIds = Array.from(kcEntry.chunks.keys());
    if (chunkIds.length === 0) {
      throw new NoEligibleKnowledgeCollectionError();
    }
    const chunkId = chunkIds[0];

    const challenge: NodeChallenge = {
      knowledgeCollectionId: kcId,
      chunkId,
      knowledgeCollectionStorageContract: kcEntry.kcsContract,
      epoch: this.rsEpoch,
      activeProofPeriodStartBlock: this.rsPeriodCursor,
      proofingPeriodDurationInBlocks: MockChainAdapter.RS_MOCK_PERIOD_DURATION_IN_BLOCKS,
      solved: false,
    };
    this.rsChallenges.set(identityId, challenge);

    this.pushEvent('ChallengeGenerated', {
      identityId: identityId.toString(),
      contextGraphId: kcEntry.cgId.toString(),
      knowledgeCollectionId: kcId.toString(),
      chunkId: chunkId.toString(),
      epoch: this.rsEpoch.toString(),
      activeProofPeriodStartBlock: this.rsPeriodCursor.toString(),
    });

    const tx = this.txResult(true);
    return {
      ...tx,
      challenge,
      contextGraphId: kcEntry.cgId,
    };
  }

  async submitProof(leaf: Uint8Array | `0x${string}`, _merkleProof: Uint8Array[]): Promise<TxResult> {
    const identityId = await this.getIdentityId();
    if (identityId === 0n) {
      throw new Error('Mock: cannot submitProof without an identity (call ensureProfile first)');
    }

    const challenge = this.rsChallenges.get(identityId);
    if (!challenge) {
      throw new Error('Mock: no active challenge for identity ' + identityId);
    }
    if (challenge.solved) {
      throw new Error('This challenge has already been solved');
    }
    if (challenge.activeProofPeriodStartBlock !== this.rsPeriodCursor) {
      throw new ChallengeNoLongerActiveError();
    }

    const kcEntry = this.rsKCs.get(challenge.knowledgeCollectionId);
    if (!kcEntry) {
      throw new Error(`Mock: KC ${challenge.knowledgeCollectionId} no longer registered`);
    }
    const expectedLeaf = kcEntry.chunks.get(challenge.chunkId);
    if (expectedLeaf === undefined) {
      throw new Error(`Mock: KC ${challenge.knowledgeCollectionId} has no leaf at index ${challenge.chunkId}`);
    }
    const leafHex = (typeof leaf === 'string' ? leaf : ethers.hexlify(leaf)).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(leafHex)) {
      throw new Error('Mock: submitProof leaf must be a 32-byte hex string (bytes32)');
    }
    if (expectedLeaf.toLowerCase() !== leafHex) {
      const computed = '0x' + 'cc'.repeat(32);
      throw new MerkleRootMismatchError(computed, kcEntry.merkleRootHex);
    }

    challenge.solved = true;
    this.rsChallenges.set(identityId, challenge);
    const score = 1_000_000_000_000_000_000n; // 1.0 in 18-decimals
    this.rsScores.set(
      `${identityId}|${challenge.epoch}|${challenge.activeProofPeriodStartBlock}`,
      score,
    );

    this.pushEvent('ProofSubmitted', {
      identityId: identityId.toString(),
      epoch: challenge.epoch.toString(),
      score: score.toString(),
    });

    return this.txResult(true);
  }

  async getActiveProofPeriodStatus(): Promise<ProofPeriodStatus> {
    return {
      activeProofPeriodStartBlock: this.rsPeriodCursor,
      isValid: this.rsPeriodIsValid,
      proofingPeriodDurationInBlocks: MockChainAdapter.RS_MOCK_PERIOD_DURATION_IN_BLOCKS,
    };
  }

  async getNodeChallenge(identityId: bigint): Promise<NodeChallenge | null> {
    return this.rsChallenges.get(identityId) ?? null;
  }

  async getNodeEpochProofPeriodScore(
    identityId: bigint,
    epoch: bigint,
    periodStartBlock: bigint,
  ): Promise<bigint> {
    return this.rsScores.get(`${identityId}|${epoch}|${periodStartBlock}`) ?? 0n;
  }

  // =====================================================================
  // KC views — read from the in-memory `collections` map populated by
  // `createKnowledgeAssetsV10` and `__registerKC`.
  // =====================================================================

  async getLatestMerkleRoot(kcId: bigint): Promise<Uint8Array> {
    const entry = this.collections.get(kcId);
    if (!entry) throw new Error(`Mock: unknown kcId ${kcId}`);
    return entry.merkleRoot;
  }

  async getMerkleLeafCount(kcId: bigint): Promise<number> {
    const entry = this.collections.get(kcId);
    if (!entry) throw new Error(`Mock: unknown kcId ${kcId}`);
    return entry.merkleLeafCount;
  }

  async getLatestMerkleRootPublisher(kcId: bigint): Promise<string> {
    const entry = this.collections.get(kcId);
    if (!entry) throw new Error(`Mock: unknown kcId ${kcId}`);
    return entry.publisherAddress;
  }

  async getLatestMerkleRootAuthor(kcId: bigint): Promise<string> {
    const entry = this.collections.get(kcId);
    if (!entry) throw new Error(`Mock: unknown kcId ${kcId}`);
    return entry.authorAddress;
  }

  async getKCContextGraphId(kcId: bigint): Promise<bigint> {
    const entry = this.collections.get(kcId);
    return entry?.cgId ?? 0n;
  }
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
