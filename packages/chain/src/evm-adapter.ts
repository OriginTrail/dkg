import { ethers, JsonRpcProvider, Wallet, Contract } from 'ethers';
import { createRequire } from 'node:module';
import type {
  ChainAdapter,
  IdentityProof,
  ReservedRange,
  BatchMintParams,
  BatchMintResult,
  UpdateKAParams,
  ExtendStorageParams,
  TxResult,
  ChainEvent,
  EventFilter,
  CreateParanetParams,
  PublishParams,
  OnChainPublishResult,
} from './chain-adapter.js';

const require = createRequire(import.meta.url);

function loadAbi(contractName: string): ethers.InterfaceAbi {
  return require(`@dkg/evm-module/abi/${contractName}.json`);
}

export interface EVMAdapterConfig {
  rpcUrl: string;
  /** Primary operational wallet key (used for identity registration, staking, etc.) */
  privateKey: string;
  /** Additional operational wallet keys for parallel transaction submission. */
  additionalKeys?: string[];
  hubAddress: string;
  chainId?: string;
}

interface ContractCache {
  hub: Contract;
  identity?: Contract;
  profile?: Contract;
  knowledgeAssets?: Contract;
  knowledgeAssetsStorage?: Contract;
  knowledgeCollection?: Contract;
  knowledgeCollectionStorage?: Contract;
  staking?: Contract;
  paranet?: Contract;
  token?: Contract;
  parametersStorage?: Contract;
  askStorage?: Contract;
}

/**
 * EVM chain adapter implementing the V9 ChainAdapter interface.
 * Resolves contract addresses dynamically from the Hub.
 */
export class EVMChainAdapter implements ChainAdapter {
  readonly chainType = 'evm' as const;
  readonly chainId: string;

  private readonly provider: JsonRpcProvider;
  /** Primary signer — used for identity/profile/staking operations. */
  private readonly signer: Wallet;
  /** All operational signers (includes primary). Used round-robin for publish TXs. */
  private readonly signerPool: Wallet[];
  private signerIndex = 0;
  private readonly hubAddress: string;
  private contracts: ContractCache;
  private initialized = false;

  constructor(config: EVMAdapterConfig) {
    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.signer = new Wallet(config.privateKey, this.provider);
    this.signerPool = [this.signer];
    for (const key of config.additionalKeys ?? []) {
      this.signerPool.push(new Wallet(key, this.provider));
    }
    this.hubAddress = config.hubAddress;
    this.chainId = config.chainId ?? 'evm:31337';

    this.contracts = {
      hub: new Contract(config.hubAddress, loadAbi('Hub'), this.signer),
    };
  }

  /** Pick the next signer from the pool (round-robin). */
  private nextSigner(): Wallet {
    const s = this.signerPool[this.signerIndex % this.signerPool.length];
    this.signerIndex++;
    return s;
  }

  /** All operational wallet addresses (for display / funding). */
  getSignerAddresses(): string[] {
    return this.signerPool.map((s) => s.address);
  }

  private async resolveContract(name: string, abiName?: string): Promise<Contract> {
    const address: string = await this.contracts.hub.getContractAddress(name);
    if (address === ethers.ZeroAddress) {
      throw new Error(`Contract "${name}" not found in Hub at ${this.hubAddress}`);
    }
    return new Contract(address, loadAbi(abiName ?? name), this.signer);
  }

  private async resolveAssetStorage(name: string, abiName?: string): Promise<Contract> {
    const address: string = await this.contracts.hub.getAssetStorageAddress(name);
    if (address === ethers.ZeroAddress) {
      throw new Error(`Asset storage "${name}" not found in Hub at ${this.hubAddress}`);
    }
    return new Contract(address, loadAbi(abiName ?? name), this.signer);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;

    this.contracts.identity = await this.resolveContract('Identity');
    this.contracts.profile = await this.resolveContract('Profile');
    this.contracts.staking = await this.resolveContract('Staking');
    this.contracts.paranet = await this.resolveContract('Paranet');
    this.contracts.parametersStorage = await this.resolveContract('ParametersStorage');

    // V8 legacy contracts
    this.contracts.knowledgeCollection = await this.resolveContract('KnowledgeCollection');
    this.contracts.knowledgeCollectionStorage = await this.resolveAssetStorage('KnowledgeCollectionStorage');

    // V9 contracts (may not be deployed yet on older nodes)
    try {
      this.contracts.knowledgeAssets = await this.resolveContract('KnowledgeAssets');
      this.contracts.knowledgeAssetsStorage = await this.resolveAssetStorage('KnowledgeAssetsStorage');
      this.contracts.askStorage = await this.resolveContract('AskStorage');
    } catch {
      // V9 contracts not deployed — adapter works in V8-only mode
    }

    const tokenAddress: string = await this.contracts.hub.getContractAddress('Token');
    if (tokenAddress !== ethers.ZeroAddress) {
      this.contracts.token = new Contract(
        tokenAddress,
        ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
        this.signer,
      );
    }

    this.initialized = true;
  }

  private requireV9(): void {
    if (!this.contracts.knowledgeAssets || !this.contracts.knowledgeAssetsStorage) {
      throw new Error(
        'V9 contracts (KnowledgeAssets, KnowledgeAssetsStorage) not deployed. ' +
        'Deploy them first using the deploy scripts.',
      );
    }
  }

  private async getBlockTimestamp(blockNumber: number): Promise<number> {
    const block = await this.provider.getBlock(blockNumber);
    return block?.timestamp ?? 0;
  }

  // =====================================================================
  // Identity
  // =====================================================================

  async getIdentityId(): Promise<bigint> {
    await this.init();
    const identityStorage = await this.resolveContract('IdentityStorage');
    const id: bigint = await identityStorage.getIdentityId(this.signer.address);
    return id;
  }

  async ensureProfile(options?: { nodeName?: string; stakeAmount?: bigint }): Promise<bigint> {
    await this.init();

    let identityId = await this.getIdentityId();

    // Step 1: Create profile if none exists
    if (identityId === 0n) {
      const nodeName = options?.nodeName ?? `node-${Date.now()}`;
      const adminWallet = ethers.Wallet.createRandom();
      const nodeId = ethers.hexlify(ethers.randomBytes(32));

      const tx = await this.contracts.profile!.createProfile(
        adminWallet.address,
        [],
        nodeName,
        nodeId,
        0,
      );
      const receipt = await tx.wait();

      for (const log of receipt.logs) {
        try {
          const parsed = this.contracts.identity!.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed?.name === 'IdentityCreated') {
            identityId = BigInt(parsed.args.identityId);
            break;
          }
        } catch { /* not this contract */ }
      }

      if (identityId === 0n) {
        throw new Error('Profile created but no IdentityCreated event found');
      }
    }

    // Step 2: Stake if token is available (separate try/catch so profile isn't lost)
    const stakeAmount = options?.stakeAmount ?? ethers.parseEther('50000');
    if (stakeAmount > 0n && this.contracts.token) {
      try {
        const stakingAddr = await this.contracts.staking!.getAddress();
        const approveTx = await this.contracts.token.approve(stakingAddr, stakeAmount);
        await approveTx.wait();
        // Wait an extra block for state propagation on public RPCs
        await new Promise(r => setTimeout(r, 2000));

        const stakeTx = await this.contracts.staking!.stake(identityId, stakeAmount);
        await stakeTx.wait();
      } catch (err) {
        console.warn(
          `[ensureProfile] Staking failed for identity ${identityId} (profile exists, stake manually): ` +
          (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return identityId;
  }

  async registerIdentity(proof: IdentityProof): Promise<bigint> {
    await this.init();

    const tx = await this.contracts.profile!.createProfile(
      this.signer.address,
      [this.signer.address],
      '',
      proof.publicKey,
      0,
    );
    const receipt = await tx.wait();

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.identity!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'IdentityCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.profile!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'ProfileCreated') {
          return BigInt(parsed.args.identityId);
        }
      } catch { /* not this contract */ }
    }

    throw new Error('Identity registration succeeded but no identity ID found in events');
  }

  // =====================================================================
  // V9: UAL Reservation
  // =====================================================================

  async reserveUALRange(count: number): Promise<ReservedRange> {
    await this.init();
    this.requireV9();

    const tx = await this.contracts.knowledgeAssets!.reserveUALRange(count);
    const receipt = await tx.wait();

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'UALRangeReserved') {
          return {
            startId: BigInt(parsed.args.startId),
            endId: BigInt(parsed.args.endId),
          };
        }
      } catch { /* not this contract */ }
    }

    throw new Error('reserveUALRange succeeded but no UALRangeReserved event found');
  }

  // =====================================================================
  // V9: Batch Minting
  // =====================================================================

  async batchMintKnowledgeAssets(params: BatchMintParams): Promise<BatchMintResult> {
    await this.init();
    this.requireV9();

    const ka = this.contracts.knowledgeAssets!;
    const kaAddress = await ka.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const approveTx = await this.contracts.token.approve(kaAddress, params.tokenAmount);
      await approveTx.wait();
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const vsValues = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));

    const tx = await ka.batchMintKnowledgeAssets(
      params.publisherNodeIdentityId,
      ethers.hexlify(params.merkleRoot),
      params.startKAId,
      params.endKAId,
      params.publicByteSize,
      params.epochs,
      params.tokenAmount,
      ethers.ZeroAddress, // paymaster
      ethers.hexlify(params.publisherSignature.r),
      ethers.hexlify(params.publisherSignature.vs),
      identityIds,
      rValues,
      vsValues,
    );

    const receipt = await tx.wait();

    let batchId = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
          break;
        }
      } catch { /* not this contract */ }
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
      batchId,
    };
  }

  // =====================================================================
  // V9: Single-tx Publish (reserve + mint)
  // =====================================================================

  async publishKnowledgeAssets(params: PublishParams): Promise<OnChainPublishResult> {
    await this.init();
    this.requireV9();

    const txSigner = this.nextSigner();
    const ka = this.contracts.knowledgeAssets!.connect(txSigner) as Contract;
    const kaAddress = await this.contracts.knowledgeAssets!.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const token = this.contracts.token.connect(txSigner) as Contract;
      const approveTx = await token.approve(kaAddress, params.tokenAmount);
      await approveTx.wait();
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const vsValues = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));

    const tx = await ka.publishKnowledgeAssets(
      params.kaCount,
      params.publisherNodeIdentityId,
      ethers.hexlify(params.merkleRoot),
      params.publicByteSize,
      params.epochs,
      params.tokenAmount,
      ethers.ZeroAddress, // paymaster
      ethers.hexlify(params.publisherSignature.r),
      ethers.hexlify(params.publisherSignature.vs),
      identityIds,
      rValues,
      vsValues,
    );

    const receipt = await tx.wait();

    let batchId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = txSigner.address;

    for (const log of receipt.logs) {
      try {
        const parsed = this.contracts.knowledgeAssetsStorage!.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
        }
      } catch { /* not this contract */ }
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp,
      publisherAddress,
    };
  }

  // =====================================================================
  // V9: Knowledge Updates
  // =====================================================================

  async updateKnowledgeAssets(params: UpdateKAParams): Promise<TxResult> {
    await this.init();
    this.requireV9();

    const ka = this.contracts.knowledgeAssets!;

    const tx = await ka.updateKnowledgeAssets(
      params.batchId,
      ethers.hexlify(params.newMerkleRoot),
      params.newPublicByteSize,
    );

    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  // =====================================================================
  // V9: Storage Extension
  // =====================================================================

  async extendStorage(params: ExtendStorageParams): Promise<TxResult> {
    await this.init();
    this.requireV9();

    const ka = this.contracts.knowledgeAssets!;

    if (this.contracts.token && params.tokenAmount > 0n) {
      const kaAddress = await ka.getAddress();
      const approveTx = await this.contracts.token.approve(kaAddress, params.tokenAmount);
      await approveTx.wait();
    }

    const tx = await ka.extendStorage(
      params.batchId,
      params.additionalEpochs,
      params.tokenAmount,
      ethers.ZeroAddress,
    );

    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  // =====================================================================
  // V9: Namespace Transfer
  // =====================================================================

  async transferNamespace(newOwner: string): Promise<TxResult> {
    await this.init();
    this.requireV9();

    const tx = await this.contracts.knowledgeAssets!.transferNamespace(newOwner);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      success: receipt.status === 1,
    };
  }

  async getRequiredPublishTokenAmount(publicByteSize: bigint, epochs: number): Promise<bigint> {
    await this.init();
    if (!this.contracts.askStorage) {
      throw new Error('AskStorage not available');
    }
    const ask = await this.contracts.askStorage.getStakeWeightedAverageAsk();
    return (BigInt(ask) * publicByteSize * BigInt(epochs)) / 1024n;
  }

  // =====================================================================
  // Events
  // =====================================================================

  async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
    await this.init();

    const storage = this.contracts.knowledgeAssetsStorage ?? this.contracts.knowledgeCollectionStorage!;

    for (const eventType of filter.eventTypes) {
      if (eventType === 'KnowledgeBatchCreated') {
        const eventFilter = storage.filters.KnowledgeBatchCreated();
        const logs = await storage.queryFilter(eventFilter, filter.fromBlock ?? 0);

        for (const log of logs) {
          const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
          if (parsed) {
            yield {
              type: 'KnowledgeBatchCreated',
              blockNumber: log.blockNumber,
              data: {
                batchId: parsed.args.batchId.toString(),
                publisherAddress: parsed.args.publisher?.toString(),
                merkleRoot: parsed.args.merkleRoot,
                startKAId: parsed.args.startKAId.toString(),
                endKAId: parsed.args.endKAId.toString(),
              },
            };
          }
        }
      }

      // V8 backward compat
      if (eventType === 'KCCreated' || eventType === 'KnowledgeCollectionCreated') {
        const kcStorage = this.contracts.knowledgeCollectionStorage;
        if (kcStorage) {
          const eventFilter = kcStorage.filters.KnowledgeCollectionCreated();
          const logs = await kcStorage.queryFilter(eventFilter, filter.fromBlock ?? 0);

          for (const log of logs) {
            const parsed = kcStorage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed) {
              yield {
                type: 'KCCreated',
                blockNumber: log.blockNumber,
                data: {
                  kcId: parsed.args.id.toString(),
                  merkleRoot: parsed.args.merkleRoot,
                  byteSize: parsed.args.byteSize.toString(),
                },
              };
            }
          }
        }
      }
    }
  }

  // =====================================================================
  // V9: Publisher range verification (for PublishHandler)
  // =====================================================================

  async verifyPublisherOwnsRange(
    publisherAddress: string,
    startKAId: bigint,
    endKAId: bigint,
  ): Promise<boolean> {
    await this.init();
    if (!this.contracts.knowledgeAssetsStorage) return false;

    const storage = this.contracts.knowledgeAssetsStorage;
    const count = await storage.getPublisherRangesCount(publisherAddress);
    for (let i = 0; i < Number(count); i++) {
      const [startId, endId] = await storage.getPublisherRange(publisherAddress, i);
      if (startId <= startKAId && endId >= endKAId) return true;
    }
    return false;
  }

  // =====================================================================
  // Paranets (placeholder — full implementation in Milestone 5)
  // =====================================================================

  async createParanet(_params: CreateParanetParams): Promise<TxResult> {
    throw new Error('createParanet: not yet implemented on EVM adapter (Milestone 5)');
  }

  async submitToParanet(_kcId: string, _paranetId: string): Promise<TxResult> {
    throw new Error('submitToParanet: not yet implemented on EVM adapter (Milestone 5)');
  }

  // =====================================================================
  // Utilities
  // =====================================================================

  getSignerAddress(): string {
    return this.signer.address;
  }

  getProvider(): JsonRpcProvider {
    return this.provider;
  }

  async getContract(name: string): Promise<Contract> {
    await this.init();
    return this.resolveContract(name);
  }
}
