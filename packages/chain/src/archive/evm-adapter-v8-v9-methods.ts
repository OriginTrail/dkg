// @ts-nocheck
/* eslint-disable */
//
// V8/V9 EVMChainAdapter method snapshots (issue 0004,
// `archive-non-v10-contracts`). NOT imported anywhere; preserved on disk
// so the V8/V9 surface that was removed during TB-0004 stays diff-able
// without spelunking git history.
//
// The method bodies below are byte-identical to the implementations
// extracted from
//   git show orch/archive-non-v10-contracts/0003:packages/chain/src/evm-adapter.ts
// (the parent of the first archive commit on this branch). Only the
// surrounding class shell, top file comment, and the trailing
// `__V8_V9_ARCHIVE_MARKER__` export differ from the live source — the
// logic, allowance handling, event parsing, `ethers.MaxUint256` /
// `ethers.ZeroAddress` constants, error wording, etc. are preserved
// verbatim per PRD §4.3.
//
// See `src/archive/README.md` for policy. This file is excluded from
// `pnpm -r build` via `tsconfig.json`, and `// @ts-nocheck` plus the
// `eslint-disable` directive are defensive belts in case the exclude
// is ever forgotten.

// Type aliases mirror the names the live `evm-adapter.ts` consumes;
// repeating them here keeps the snapshot self-contained.
type PublishParams = any;
type UpdateKAParams = any;
type ExtendStorageParams = any;
type PermanentPublishParams = any;
type OnChainPublishResult = any;
type TxResult = any;
type ConvictionAccountInfo = any;
type Wallet = any;
type Contract = any;
declare const ethers: any;

// Shell class that hosts the archived methods. The shape mirrors the
// `EVMChainAdapter` class in `src/evm-adapter.ts` closely enough that
// `this.contracts.knowledgeAssets`, `this.nextSigner()`, etc. type-check
// under `// @ts-nocheck`. No instance of this class is ever constructed
// at runtime — the file exists only as a diff reference.
class EVMChainAdapter_V8_V9_Archive {
  private contracts: any;
  private signer: any;
  private signerPool: any[];
  private provider: any;

  private async init(): Promise<void> { /* see live adapter */ }
  private requireV9(): void { /* see live adapter */ }
  private nextSigner(): any { /* see live adapter */ }
  private async resolveContract(_name: string): Promise<any> { /* see live adapter */ }
  private async getBlockTimestamp(_block: number): Promise<number> { return 0; }

  // =====================================================================
  // V9: publishKnowledgeAssets (KnowledgeAssets.publishKnowledgeAssets)
  // =====================================================================

  async publishKnowledgeAssets(params: PublishParams): Promise<OnChainPublishResult> {
    await this.init();
    this.requireV9();

    const txSigner = this.nextSigner();
    const ka = this.contracts.knowledgeAssets!.connect(txSigner) as Contract;
    const kaAddress = await this.contracts.knowledgeAssets!.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const token = this.contracts.token.connect(txSigner) as Contract;
      const currentAllowance: bigint = await token.allowance(txSigner.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        const approveTx = await token.approve(kaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
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

    const gasUsed = BigInt(receipt.gasUsed);
    const effectiveGasPrice = BigInt(receipt.gasPrice);
    const gasCostWei = gasUsed * effectiveGasPrice;

    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      blockTimestamp,
      publisherAddress,
      gasUsed,
      effectiveGasPrice,
      gasCostWei,
    };
  }

  // =====================================================================
  // V9: Knowledge Updates
  // =====================================================================

  async updateKnowledgeAssets(params: UpdateKAParams): Promise<TxResult> {
    await this.init();
    this.requireV9();

    let signer: Wallet | undefined;

    // The contract requires the original publisher to call update.
    // Query the on-chain batch publisher and select the matching signer.
    const storage = this.contracts.knowledgeAssetsStorage;
    if (storage) {
      try {
        const onChainPublisher: string = await storage.getBatchPublisher(params.batchId);
        if (onChainPublisher && onChainPublisher !== ethers.ZeroAddress) {
          signer = this.signerPool.find(
            (s) => s.address.toLowerCase() === onChainPublisher.toLowerCase(),
          );
        }
      } catch {
        // Fall through to hint-based or round-robin
      }
    }

    // Fallback: use the hint from the publisher if chain lookup failed
    if (!signer && params.publisherAddress) {
      signer = this.signerPool.find(
        (s) => s.address.toLowerCase() === params.publisherAddress!.toLowerCase(),
      );
    }
    if (!signer) signer = this.nextSigner();

    const ka = this.contracts.knowledgeAssets!.connect(signer) as Contract;

    const tx = await ka.updateKnowledgeAssets(
      params.batchId,
      ethers.hexlify(params.newMerkleRoot),
      params.newPublicByteSize,
    );

    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
      publisherAddress: signer.address,
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
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, kaAddress);
      if (currentAllowance < params.tokenAmount) {
        const approveTx = await this.contracts.token.approve(kaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
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
      txIndex: receipt.index,
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
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  // =====================================================================
  // Staking Conviction
  // =====================================================================

  // V10 baseline tier ladder seeded by `ConvictionStakingStorage._seedBaselineTiers()`
  // (rest, 30d, 90d, 180d, 366d). Passing a tier outside this set reverts on-chain with
  // `InvalidLockTier()` from `DKGStakingConvictionNFT._convictionMultiplier`. Validating
  // off-chain saves a round-trip and surfaces a clearer error to the caller.
  private static readonly V10_BASELINE_LOCK_TIERS = [0, 1, 3, 6, 12] as const;

  private snapToBaselineLockTier(lockEpochs: number): number {
    // Snap DOWN to the largest baseline tier ≤ lockEpochs. Conservative: never lock
    // the user up for longer than the legacy `lockEpochs` they asked for. Examples:
    //   lockEpochs=2 → 1, lockEpochs=4 → 3, lockEpochs=11 → 6, lockEpochs=30 → 12.
    let snapped = 0;
    for (const tier of EVMChainAdapter_V8_V9_Archive.V10_BASELINE_LOCK_TIERS) {
      if (tier <= lockEpochs) snapped = tier;
      else break;
    }
    return snapped;
  }

  private normalizeLegacyLockEpochs(lockEpochs: number): number {
    if (!Number.isInteger(lockEpochs)) {
      throw new Error(`stakeWithLock: lockEpochs must be an integer, got ${lockEpochs}`);
    }
    if (lockEpochs < 0) {
      throw new Error(`stakeWithLock: lockEpochs must be non-negative, got ${lockEpochs}`);
    }
    return this.snapToBaselineLockTier(lockEpochs);
  }

  async stakeWithLock(identityId: bigint, amount: bigint, lockEpochs: number): Promise<TxResult> {
    return this.stakeWithLockTier(identityId, amount, this.normalizeLegacyLockEpochs(lockEpochs));
  }

  async stakeWithLockTier(identityId: bigint, amount: bigint, lockTier: number): Promise<TxResult> {
    if (!Number.isInteger(lockTier) || !(EVMChainAdapter_V8_V9_Archive.V10_BASELINE_LOCK_TIERS as readonly number[]).includes(lockTier)) {
      throw new Error(
        `stakeWithLockTier: lockTier must be one of {${EVMChainAdapter_V8_V9_Archive.V10_BASELINE_LOCK_TIERS.join(', ')}} (V10 baseline tier ladder), got ${lockTier}`,
      );
    }
    await this.init();

    let nft: Contract;
    try {
      nft = await this.resolveContract('DKGStakingConvictionNFT');
    } catch {
      throw new Error('DKGStakingConvictionNFT contract not deployed.');
    }

    // V10 consolidation (v4.0.0): TRAC is pulled by `StakingV10`, not by
    // the NFT — the NFT is only the entry point and never custodies TRAC.
    // Approving the NFT here would still leave the inner `stakingV10.stake`
    // call short on allowance and revert. Mirror the pattern used in
    // `ensureProfile` / `scripts/devnet.sh`.
    if (this.contracts.token && amount > 0n) {
      const stakingV10Addr: string = await this.contracts.hub.getContractAddress('StakingV10');
      if (stakingV10Addr === ethers.ZeroAddress) {
        throw new Error('StakingV10 not registered in Hub — V10 staking unavailable');
      }
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, stakingV10Addr);
      if (currentAllowance < amount) {
        await (await this.contracts.token.approve(stakingV10Addr, ethers.MaxUint256)).wait();
      }
    }

    const tx = await nft.createConviction(identityId, amount, lockTier);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  async getDelegatorConvictionMultiplier(_identityId: bigint, _delegator: string): Promise<{ multiplier: number }> {
    // V8 address-keyed stakers have no conviction multiplier (always 1x).
    // V10 per-position multipliers are queried by tokenId via
    // ConvictionStakingStorage.getPosition(), not this address-keyed function.
    return { multiplier: 1 };
  }

  // =====================================================================
  // Publishing Conviction Accounts
  // =====================================================================

  async createConvictionAccount(amount: bigint, lockEpochs: number): Promise<{ accountId: bigint } & TxResult> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      throw new Error('PublishingConvictionAccount contract not deployed.');
    }

    const pca = this.contracts.publishingConvictionAccount;
    const pcaAddress = await pca.getAddress();

    if (this.contracts.token && amount > 0n) {
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, pcaAddress);
      if (currentAllowance < amount) {
        const approveTx = await this.contracts.token.approve(pcaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const tx = await pca.createAccount(amount, lockEpochs);
    const receipt = await tx.wait();

    let accountId = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = pca.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'AccountCreated') {
          accountId = BigInt(parsed.args.accountId);
          break;
        }
      } catch { /* not this contract */ }
    }

    if (accountId === 0n) {
      throw new Error('createConvictionAccount succeeded but no AccountCreated event found');
    }

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
      accountId,
    };
  }

  async addConvictionFunds(accountId: bigint, amount: bigint): Promise<TxResult> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      throw new Error('PublishingConvictionAccount contract not deployed.');
    }

    const pca = this.contracts.publishingConvictionAccount;
    const pcaAddress = await pca.getAddress();

    if (this.contracts.token && amount > 0n) {
      const currentAllowance: bigint = await this.contracts.token.allowance(this.signer.address, pcaAddress);
      if (currentAllowance < amount) {
        const approveTx = await this.contracts.token.approve(pcaAddress, ethers.MaxUint256);
        await approveTx.wait();
      }
    }

    const tx = await pca.addFunds(accountId, amount);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  async extendConvictionLock(accountId: bigint, additionalEpochs: number): Promise<TxResult> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      throw new Error('PublishingConvictionAccount contract not deployed.');
    }

    const tx = await this.contracts.publishingConvictionAccount.extendLock(accountId, additionalEpochs);
    const receipt = await tx.wait();

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  async addPCAAuthorizedKey(accountId: bigint, key: string): Promise<TxResult> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      throw new Error('PublishingConvictionAccount contract not deployed.');
    }
    if (!ethers.isAddress(key)) {
      throw new Error(`addPCAAuthorizedKey: ${key} is not a valid EVM address`);
    }
    const tx = await this.contracts.publishingConvictionAccount.addAuthorizedKey(accountId, key);
    const receipt = await tx.wait();
    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
    };
  }

  async isPCAAuthorizedKey(accountId: bigint, key: string): Promise<boolean> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) return false;
    if (!ethers.isAddress(key)) return false;
    return await this.contracts.publishingConvictionAccount.authorizedKeys(accountId, key);
  }

  async getConvictionAccountInfo(accountId: bigint): Promise<ConvictionAccountInfo | null> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) return null;

    try {
      const [admin, balance, initialDeposit, lockEpochs, conviction, discountBps] =
        await this.contracts.publishingConvictionAccount.getAccountInfo(accountId);

      if (admin === ethers.ZeroAddress) return null;

      return {
        accountId,
        admin,
        balance: BigInt(balance),
        initialDeposit: BigInt(initialDeposit),
        lockEpochs: Number(lockEpochs),
        conviction: BigInt(conviction),
        discountBps: Number(discountBps),
      };
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return null;
      throw err;
    }
  }

  async getConvictionDiscount(accountId: bigint): Promise<{ discountBps: number; conviction: bigint }> {
    await this.init();
    if (!this.contracts.publishingConvictionAccount) {
      return { discountBps: 0, conviction: 0n };
    }

    try {
      const [admin, , , , conviction, discountBps] =
        await this.contracts.publishingConvictionAccount.getAccountInfo(accountId);

      if (admin === ethers.ZeroAddress) return { discountBps: 0, conviction: 0n };

      return {
        discountBps: Number(discountBps),
        conviction: BigInt(conviction),
      };
    } catch (err: any) {
      if (err?.code === 'CALL_EXCEPTION') return { discountBps: 0, conviction: 0n };
      throw err;
    }
  }

  // =====================================================================
  // V9: Permanent Publish (batchMintKnowledgeAssetsPermanent)
  // =====================================================================

  async publishKnowledgeAssetsPermanent(params: PermanentPublishParams): Promise<OnChainPublishResult> {
    await this.init();
    if (!this.contracts.knowledgeAssets) throw new Error('KnowledgeAssets contract not deployed.');

    const publishSigner = this.nextSigner();
    const kaAddr = await this.contracts.knowledgeAssets.getAddress();

    if (this.contracts.token && params.tokenAmount > 0n) {
      const allowance: bigint = await this.contracts.token.allowance(publishSigner.address, kaAddr);
      if (allowance < params.tokenAmount) {
        await (await (this.contracts.token.connect(publishSigner) as Contract).approve(kaAddr, ethers.MaxUint256)).wait();
      }
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => s.r);
    const vsValues = params.receiverSignatures.map((s) => s.vs);

    const ka = this.contracts.knowledgeAssets.connect(publishSigner) as Contract;
    const tx = await ka.batchMintKnowledgeAssetsPermanent(
      params.kaCount,
      params.publisherNodeIdentityId,
      params.merkleRoot,
      params.publicByteSize,
      params.tokenAmount,
      params.publisherSignature.r,
      params.publisherSignature.vs,
      identityIds,
      rValues,
      vsValues,
    );

    const receipt = await tx.wait();
    const storageIface = this.contracts.knowledgeAssetsStorage!.interface;

    let batchId = 0n;
    let startKAId: bigint | undefined;
    let endKAId: bigint | undefined;
    let publisherAddress = publishSigner.address;
    for (const log of receipt.logs) {
      try {
        const parsed = storageIface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
        }
      } catch { /* different contract log */ }
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);
    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      blockTimestamp,
      publisherAddress: publishSigner.address,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined,
      effectiveGasPrice: receipt.gasPrice ? BigInt(receipt.gasPrice) : undefined,
      tokenAmount: params.tokenAmount,
    };
  }
}

// Marker export so linters that require "module has at least one export"
// don't complain about this archive file even though no live code
// imports from it.
export const __V8_V9_ARCHIVE_MARKER__ = true;
export { EVMChainAdapter_V8_V9_Archive };
