// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge-collection publish / update / mint pipeline methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase, decodeConvictionCostCovered } from './evm-adapter-base.js';
import { ethers, Wallet, Contract } from 'ethers';
import type { ReservedRange, BatchMintParams, BatchMintResult, KAUpdateVerification, OnChainPublishResult, V10UpdateKAParams, TxResult } from './chain-adapter.js';
import { floorPublishTokenAmount, computeUpdateACKDigest, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';

export class PublishMethods extends EVMChainAdapterBase {
  // =====================================================================
  // V9: UAL Reservation
  // =====================================================================

  async reserveUALRange(count: number): Promise<ReservedRange> {
    await this.init();
    this.requireV9();

    const receipt = await this.sendContractTransaction(
      this.contracts.knowledgeAssets!,
      'reserveUALRange',
      [count],
      this.signer,
      'reserveUALRange',
    );

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
      const currentAllowance: bigint = await this.readContract(
        this.contracts.token, 'token.allowance', 'allowance', this.signer.address, kaAddress,
      );
      if (currentAllowance < params.tokenAmount) {
        await this.sendContractTransaction(
          this.contracts.token,
          'approve',
          [kaAddress, ethers.MaxUint256],
          this.signer,
          'approve KA TRAC',
        );
      }
    }

    const identityIds = params.receiverSignatures.map((s) => s.identityId);
    const rValues = params.receiverSignatures.map((s) => ethers.hexlify(s.r));
    const vsValues = params.receiverSignatures.map((s) => ethers.hexlify(s.vs));

    const receipt = await this.sendContractTransaction(
      ka,
      'batchMintKnowledgeAssets',
      [
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
      ],
      this.signer,
      'batchMintKnowledgeAssets',
    );

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
      txIndex: receipt.index,
      success: receipt.status === 1,
      batchId,
    };
  }

  // =====================================================================
  // V9: Update Verification (for gossip receivers)
  // =====================================================================

  async verifyKAUpdate(txHash: string, batchId: bigint, publisherAddress: string): Promise<KAUpdateVerification> {
    await this.init();
    if (!this.contracts.knowledgeAssetsStorage && !this.contracts.knowledgeAssetStorage) {
      return { verified: false };
    }

    try {
      const receipt = await this.getTransactionReceiptWithFailover(txHash);
      if (!receipt || receipt.status !== 1) return { verified: false };

      let onChainMerkleRoot: Uint8Array | undefined;

      // V9: KnowledgeBatchUpdated on KnowledgeAssetsStorage
      if (!onChainMerkleRoot && this.contracts.knowledgeAssetsStorage) {
        const storage = this.contracts.knowledgeAssetsStorage;
        const storageAddress = (await storage.getAddress()).toLowerCase();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== storageAddress) continue;
          try {
            const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed?.name === 'KnowledgeBatchUpdated' && BigInt(parsed.args.batchId) === batchId) {
              onChainMerkleRoot = ethers.getBytes(parsed.args.newMerkleRoot);
              break;
            }
          } catch { /* parse failure — skip */ }
        }
      }

      // V10: KnowledgeAssetUpdated on DKGKnowledgeAssets
      if (!onChainMerkleRoot && this.contracts.knowledgeAssetStorage) {
        const kas = this.contracts.knowledgeAssetStorage;
        const kcsAddress = (await kas.getAddress()).toLowerCase();
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== kcsAddress) continue;
          try {
            const parsed = kas.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (
              (parsed?.name === 'KnowledgeAssetUpdated' ||
                parsed?.name === 'KnowledgeAssetUpdated') &&
              BigInt(parsed.args.id) === batchId
            ) {
              onChainMerkleRoot = ethers.getBytes(parsed.args.merkleRoot);
              break;
            }
          } catch { /* parse failure — skip */ }
        }
      }

      if (!onChainMerkleRoot) return { verified: false };

      // Check publisher address: try V10 storage first, then V9
      let onChainPublisher: string | undefined;
      if (this.contracts.knowledgeAssetStorage) {
        try {
          onChainPublisher = await this.readContract(
            this.contracts.knowledgeAssetStorage, 'kas.getLatestMerkleRootPublisher',
            'getLatestMerkleRootPublisher', batchId,
          );
        } catch { /* not found in V10 storage */ }
      }
      if ((!onChainPublisher || onChainPublisher === ethers.ZeroAddress) && this.contracts.knowledgeAssetsStorage) {
        try {
          onChainPublisher = await this.readContract(
            this.contracts.knowledgeAssetsStorage, 'kasV9.getBatchPublisher',
            'getBatchPublisher', batchId,
          );
        } catch { /* not found in V9 storage */ }
      }
      if (!onChainPublisher || onChainPublisher.toLowerCase() !== publisherAddress.toLowerCase()) {
        return { verified: false };
      }

      return {
        verified: true,
        onChainMerkleRoot,
        blockNumber: receipt.blockNumber,
        txIndex: receipt.index,
      };
    } catch {
      return { verified: false };
    }
  }

  async getRequiredPublishTokenAmount(publicByteSize: bigint, epochs: number): Promise<bigint> {
    await this.init();
    if (!this.contracts.askStorage) {
      throw new Error('AskStorage not available');
    }
    const ask = await this.readContract(
      this.contracts.askStorage, 'askStorage.getStakeWeightedAverageAsk', 'getStakeWeightedAverageAsk',
    );
    return (BigInt(ask) * publicByteSize * BigInt(epochs)) / 1024n;
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
    const count = await this.readContract(
      storage, 'kasV9.getPublisherRangesCount', 'getPublisherRangesCount', publisherAddress,
    );
    for (let i = 0; i < Number(count); i++) {
      const [startId, endId] = await this.readContract(
        storage, 'kasV9.getPublisherRange', 'getPublisherRange', publisherAddress, i,
      );
      if (startId <= startKAId && endId >= endKAId) return true;
    }
    return false;
  }

  async resolvePublishByTxHash(txHash: string): Promise<OnChainPublishResult | null> {
    await this.init();

    try {
      const receipt = await this.getTransactionReceiptWithFailover(txHash);
      if (!receipt || receipt.status !== 1) return null;

      const v10 = this.contracts.knowledgeAssetStorage
        ? await this.parseV10PublishReceipt(receipt)
        : null;
      if (v10) return v10;

      const v9 = this.contracts.knowledgeAssetsStorage
        ? await this.parseV9PublishReceipt(receipt)
        : null;
      return v9;
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('could not find') || msg.includes('not found') || msg.includes('unknown transaction')) {
        return null;
      }
      throw err;
    }
  }

  async parseV10PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Promise<OnChainPublishResult | null> {
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) return null;

    let kaId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = '';
    let authorAddress: string | undefined;
    let foundCreated = false;
    const storageAddress = String(kas.target).toLowerCase();

    for (const log of receipt.logs) {
      const logAddr = typeof log.address === 'string' ? log.address.toLowerCase() : '';
      if (logAddr !== storageAddress) continue;
      try {
        const parsed = kas.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'KnowledgeAssetCreated' || parsed?.name === 'KnowledgeAssetCreated') {
          kaId = BigInt(parsed.args.id);
          authorAddress = String(parsed.args.author);
          startKAId = kaId;
          endKAId = kaId;
          foundCreated = true;
        }
        if (parsed?.name === 'KnowledgeAssetsMinted') {
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId) - 1n;
          publisherAddress = parsed.args.to;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!foundCreated) return null;

    if (!publisherAddress) {
      publisherAddress = receipt.from ?? authorAddress ?? '';
    }

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);
    const convictionCostCovered = decodeConvictionCostCovered(receipt.logs);

    return {
      batchId: kaId,
      kaId: kaId,
      knowledgeAssetsContract: String(kas.target),
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      blockTimestamp,
      publisherAddress,
      authorAddress,
      ...(convictionCostCovered ? { convictionCostCovered } : {}),
    };
  }

  async parseV9PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Promise<OnChainPublishResult | null> {
    const storage = this.contracts.knowledgeAssetsStorage;
    if (!storage) return null;

    let batchId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let publisherAddress = '';
    let foundBatchCreated = false;

    for (const log of receipt.logs) {
      try {
        const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
          foundBatchCreated = true;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!foundBatchCreated) return null;

    const blockTimestamp = await this.getBlockTimestamp(receipt.blockNumber);

    return {
      batchId,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      blockTimestamp,
      publisherAddress,
    };
  }

  // =====================================================================
  // V10 Update (KnowledgeAssetsLifecycle → DKGKnowledgeAssets)
  // =====================================================================

  /**
   * Compute the `newTokenAmount` to submit (and bind into the ACK digest)
   * for a V10 update, matching the contract's growth-cost validator.
   *
   * The contract gate (`KnowledgeAssetsLifecycle._executeUpdateCore` §"Byte-size
   * growth cost check") only fires when `newByteSize > currentByteSize`, and
   * then requires `deltaTokenAmount = newTokenAmount - currentTokenAmount`
   * to be:
   *   1) strictly positive (`tokenAmount == 0` floors `_validateTokenAmount`),
   *   2) at least `(ask * byteSizeGrowth * remainingEpochs) / 1024`.
   *
   * Pre-#831 the daemon carried `newTokenAmount = currentTokenAmount`, so any
   * growth update produced `deltaTokenAmount = 0` and reverted with
   * `InvalidTokenAmount(1, 0)`. We now pay the exact marginal growth cost so
   * the contract's expected-cost branch is satisfied without overshooting.
   *
   * Pure metadata updates (`newByteSize <= currentByteSize`) skip the
   * validator entirely — the carry-forward `currentTokenAmount` is returned
   * unchanged and `deltaTokenAmount == 0` is accepted.
   *
   * MUST be called from BOTH `computeV10UpdateAckDigest` and
   * `updateKnowledgeCollectionV10` so the off-chain signed ACK and the
   * on-chain submission see the same `newTokenAmount`.
   */
  async resolveCurrentTokenAmount(kaId: bigint): Promise<bigint> {
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) return 0n;
    try {
      return BigInt(await this.readContract(
        kas, 'kas.getTokenAmount', 'getTokenAmount', kaId,
      ));
    } catch {
      // KA not yet in storage (would fail later on-chain anyway) — return 0.
      return 0n;
    }
  }

  async computeUpdateNewTokenAmount(params: {
    kaId: bigint;
    newByteSize: bigint;
    currentTokenAmount: bigint;
    userProvidedNewTokenAmount?: bigint;
  }): Promise<bigint> {
    const kas = this.contracts.knowledgeAssetStorage;
    let currentByteSize = 0n;
    let endEpoch = 0n;
    if (kas) {
      try {
        const ctx = await this.readContract(
          kas, 'kas.getKnowledgeAssetUpdateContext', 'getKnowledgeAssetUpdateContext', params.kaId,
        );
        // Tuple shape from `DKGKnowledgeAssets.getKnowledgeAssetUpdateContext`:
        // (preUpdateMerkleRootCount, minted, byteSize, endEpoch, tokenAmount, isImmutable, preUpdateMerkleLeafCount)
        currentByteSize = BigInt(ctx[2]);
        endEpoch = BigInt(ctx[3]);
      } catch (err) {
        throw new Error(
          `Failed to read KA update context for kaId ${params.kaId}: ${(err as Error).message}`,
        );
      }
    }

    let currentEpoch = 0n;
    const needsGrowthSizing = params.newByteSize > currentByteSize;
    if (needsGrowthSizing && !this.contracts.chronos) {
      throw new Error(
        'Chronos contract binding required for byte-size growth update tokenAmount sizing',
      );
    }
    if (this.contracts.chronos) {
      try {
        currentEpoch = BigInt(await this.readContract(
          this.contracts.chronos, 'chronos.getCurrentEpoch', 'getCurrentEpoch',
        ));
      } catch (err) {
        throw new Error(
          `Failed to read Chronos currentEpoch for update tokenAmount sizing: ${(err as Error).message}`,
        );
      }
    }
    const remainingEpochs = endEpoch > currentEpoch ? endEpoch - currentEpoch : 0n;

    let growthCost = 0n;
    if (params.newByteSize > currentByteSize && this.contracts.askStorage) {
      try {
        const ask = BigInt(await this.readContract(
          this.contracts.askStorage, 'askStorage.getStakeWeightedAverageAsk', 'getStakeWeightedAverageAsk',
        ));
        const byteSizeGrowth = params.newByteSize - currentByteSize;
        if (remainingEpochs > 0n) {
          growthCost = (ask * byteSizeGrowth * remainingEpochs) / 1024n;
        } else {
          // Final epoch: remainingEpochs==0 but byte-size growth still needs a
          // strict-positive delta (contract rejects deltaTokenAmount==0).
          growthCost = 1n;
        }
        if (growthCost === 0n) growthCost = 1n;
      } catch (err) {
        throw new Error(
          `Failed to read askStorage for byte-size growth costing: ${(err as Error).message}`,
        );
      }
    }

    const minimumTokenAmount = params.currentTokenAmount + growthCost;
    const baseTokenAmount = params.userProvidedNewTokenAmount ?? minimumTokenAmount;
    const raw = baseTokenAmount > minimumTokenAmount ? baseTokenAmount : minimumTokenAmount;
    // Match computeUpdateACKDigest()'s floorPublishTokenAmount so ACK signatures
    // and the on-chain submission bind the same newTokenAmount wire value.
    return floorPublishTokenAmount(raw);
  }

  /**
   * Canonical V10 update ACK digest — mirrors `KnowledgeAssetsLifecycle`
   * `_executeUpdateCore` and the values `updateKnowledgeCollectionV10`
   * submits on-chain. Test helpers and ACK collectors should call this
   * instead of re-deriving inputs so signatures recover to the expected
   * operational keys.
   */
  async computeV10UpdateAckDigest(params: {
    kaId: bigint;
    newMerkleRoot: Uint8Array;
    newByteSize: bigint;
    newMerkleLeafCount: number;
    mintAmount?: bigint;
    burnTokenIds?: bigint[];
    newTokenAmount?: bigint;
    /** When set, skip live re-derivation (binds ACK digest to tx submission). */
    boundNewTokenAmount?: bigint;
    newCatalogRoot?: Uint8Array;
    newCatalogLeafCount?: number;
  }): Promise<Uint8Array> {
    await this.init();
    if (!this.contracts.knowledgeAssetsLifecycle) {
      throw new Error('KnowledgeAssetsLifecycle contract not deployed');
    }

    const kas = this.contracts.knowledgeAssetStorage;
    const kav10Address = await this.contracts.knowledgeAssetsLifecycle.getAddress();
    const evmChainId = await this.getEvmChainId();

    const currentTokenAmount = await this.resolveCurrentTokenAmount(params.kaId);

    // #831: size `newTokenAmount` against the contract's growth-cost validator
    // (matches `KnowledgeAssetsLifecycle._validateTokenAmount` exactly). The
    // floor that lived here is now redundant — `computeUpdateNewTokenAmount`
    // returns `currentTokenAmount + growthCost` (with growthCost == 0 for
    // pure metadata updates), which is always >= 1 on a V10 chain.
    const newTokenAmount = params.boundNewTokenAmount ?? await this.computeUpdateNewTokenAmount({
      kaId: params.kaId,
      newByteSize: params.newByteSize,
      currentTokenAmount,
      userProvidedNewTokenAmount: params.newTokenAmount,
    });

    let contextGraphId = 0n;
    if (this.contracts.contextGraphStorage) {
      try {
        contextGraphId = BigInt(
          await this.readContract(
            this.contracts.contextGraphStorage, 'cgStorage.kaToContextGraph',
            'kaToContextGraph', params.kaId,
          ),
        );
      } catch { /* use 0 */ }
    }

    let preUpdateMerkleRootCount = 0n;
    if (kas) {
      try {
        const roots: unknown[] = await this.readContract(
          kas, 'kas.getMerkleRoots', 'getMerkleRoots', params.kaId,
        );
        preUpdateMerkleRootCount = BigInt(roots.length);
      } catch { /* use 0 */ }
    }

    const burnIds = params.burnTokenIds ?? [];
    const catalogRoot = params.newCatalogRoot ?? new Uint8Array(32);
    const catalogCount = BigInt(params.newCatalogLeafCount ?? 0);

    return computeUpdateACKDigest(
      evmChainId,
      kav10Address,
      contextGraphId,
      params.kaId,
      preUpdateMerkleRootCount,
      params.newMerkleRoot,
      params.newByteSize,
      newTokenAmount,
      params.mintAmount ?? 0n,
      burnIds,
      BigInt(params.newMerkleLeafCount),
      catalogRoot,
      catalogCount,
    );
  }

  /**
   * Resolve the on-chain-derived fields the V10 UPDATE ACK digest binds.
   *
   * Reads `contextGraphId`, `preUpdateMerkleRootCount`, and the floored
   * `newTokenAmount` EXACTLY as `updateKnowledgeCollectionV10` does, so the
   * off-chain ACK collector signs a digest byte-identical to the on-chain
   * verify. The returned `newTokenAmount` MUST be passed back into
   * `updateKnowledgeCollectionV10` as `boundNewTokenAmount` to pin the tx
   * to the signed value (no recompute drift). `mintAmount`/`burnTokenIds`
   * are echoed back (greenfield defaults 0 / []) so the caller threads the
   * SAME values into both the signed digest and the tx.
   */
  async getUpdateAckDigestFields(params: {
    kaId: bigint;
    newByteSize: bigint;
    userProvidedNewTokenAmount?: bigint;
    mintAmount?: bigint;
    burnTokenIds?: bigint[];
  }): Promise<{
    contextGraphId: bigint;
    preUpdateMerkleRootCount: bigint;
    newTokenAmount: bigint;
    mintAmount: bigint;
    burnTokenIds: bigint[];
  }> {
    await this.init();

    const kas = this.contracts.knowledgeAssetStorage;

    let contextGraphId = 0n;
    if (this.contracts.contextGraphStorage) {
      try {
        contextGraphId = BigInt(
          await this.readContract(
            this.contracts.contextGraphStorage, 'cgStorage.kaToContextGraph',
            'kaToContextGraph', params.kaId,
          ),
        );
      } catch { /* use 0 */ }
    }

    let preUpdateMerkleRootCount = 0n;
    if (kas) {
      try {
        const roots: unknown[] = await this.readContract(
          kas, 'kas.getMerkleRoots', 'getMerkleRoots', params.kaId,
        );
        preUpdateMerkleRootCount = BigInt(roots.length);
      } catch { /* use 0 */ }
    }

    const currentTokenAmount = await this.resolveCurrentTokenAmount(params.kaId);
    const newTokenAmount = await this.computeUpdateNewTokenAmount({
      kaId: params.kaId,
      newByteSize: params.newByteSize,
      currentTokenAmount,
      userProvidedNewTokenAmount: params.userProvidedNewTokenAmount,
    });

    return {
      contextGraphId,
      preUpdateMerkleRootCount,
      newTokenAmount,
      mintAmount: params.mintAmount ?? 0n,
      burnTokenIds: params.burnTokenIds ?? [],
    };
  }

  async updateKnowledgeCollectionV10(params: V10UpdateKAParams): Promise<TxResult> {
    await this.init();

    if (!this.contracts.knowledgeAssetsLifecycle) {
      throw new Error('KnowledgeAssetsLifecycle contract not deployed — cannot update via V10 path.');
    }

    let signer: Wallet | undefined;

    // Look up the on-chain publisher to select the correct signer.
    const kas = this.contracts.knowledgeAssetStorage;
    if (kas) {
      try {
        const onChainPublisher: string = await this.readContract(
          kas, 'kas.getLatestMerkleRootPublisher', 'getLatestMerkleRootPublisher', params.kaId,
        );
        if (onChainPublisher && onChainPublisher !== ethers.ZeroAddress) {
          signer = this.signerPool.find(
            (s) => s.address.toLowerCase() === onChainPublisher.toLowerCase(),
          );
        }
      } catch {
        // Fall through to hint-based or round-robin
      }
    }

    if (!signer && params.publisherAddress) {
      signer = this.signerPool.find(
        (s) => s.address.toLowerCase() === params.publisherAddress!.toLowerCase(),
      );
    }
    if (!signer) signer = this.nextSigner();

    const ka = this.contracts.knowledgeAssetsLifecycle.connect(signer) as Contract;

    const kav10Address = await this.contracts.knowledgeAssetsLifecycle.getAddress();
    const evmChainId = await this.getEvmChainId();

    const identityId = params.publisherNodeIdentityId ?? await this.getIdentityId();

    const currentTokenAmount = await this.resolveCurrentTokenAmount(params.kaId);

    // #831: size `newTokenAmount` against the contract's growth-cost validator
    // (matches `KnowledgeAssetsLifecycle._validateTokenAmount` exactly).
    //
    // The contract gate (`_executeUpdateCore` §"Byte-size growth cost check")
    // only fires when `newByteSize > currentByteSize` and then requires
    // `deltaTokenAmount = newTokenAmount - currentTokenAmount` to satisfy
    // `(ask * byteSizeGrowth * remainingEpochs) / 1024` with a strict-positive
    // floor. Pre-#831 the daemon carried `newTokenAmount = max(currentTokenAmount,
    // ask * newByteSize / 1024)`, which on a healthy V10 KA always equals
    // `currentTokenAmount` (carry-forward already covers the new total cost),
    // making `deltaTokenAmount == 0` and reverting every byteSize-growth
    // update with `InvalidTokenAmount(1, 0)`. The shared helper now pays the
    // exact marginal growth cost so the validator's expected-cost branch is
    // satisfied without overshooting.
    //
    // The old `floorPublishTokenAmount` clamp is applied INSIDE
    // `computeUpdateNewTokenAmount` (see r5 in #833) so the ACK digest and the
    // tx submission below bind the same wire value. Any caller passing a
    // `boundNewTokenAmount` for an ACK already-signed digest is honoured here
    // to keep digest-bound updates byte-identical to what the signer saw —
    // this is the path the publisher uses (it pre-resolves the digest fields
    // via `getUpdateAckDigestFields`, has peers sign that floored value, then
    // pins the tx to it here so the collected ACK signatures verify on-chain).
    const newTokenAmount = params.boundNewTokenAmount ?? await this.computeUpdateNewTokenAmount({
      kaId: params.kaId,
      newByteSize: params.newByteSize,
      currentTokenAmount,
      userProvidedNewTokenAmount: params.newTokenAmount,
    });

    // Look up the contextGraphId for this KC
    const contextGraphStorage = this.contracts.contextGraphStorage;
    let contextGraphId = 0n;
    if (contextGraphStorage) {
      try {
        contextGraphId = BigInt(await this.readContract(
          contextGraphStorage, 'cgStorage.kaToContextGraph', 'kaToContextGraph', params.kaId,
        ));
      } catch { /* use 0 */ }
    }

    // Compute pre-update merkle root count (array length)
    let preUpdateMerkleRootCount = 0n;
    if (kas) {
      try {
        const roots: unknown[] = await this.readContract(
          kas, 'kas.getMerkleRoots', 'getMerkleRoots', params.kaId,
        );
        preUpdateMerkleRootCount = BigInt(roots.length);
      } catch { /* use 0 */ }
    }

    const opId = params.updateOperationId ?? `update-${Date.now()}`;
    const burnIds = params.burnTokenIds ?? [];

    // RFC-001: per-publish publisher signature is removed from the
    // contract surface. The update entrypoint no longer takes
    // `publisherNodeR`/`publisherNodeVS` — `publisherNodeIdentityId`
    // remains as a self-claimed attribution target only.

    let ackSigs = params.ackSignatures ?? [];
    if (ackSigs.length === 0) {
      const ackDigest = await this.computeV10UpdateAckDigest({
        kaId: params.kaId,
        newMerkleRoot: params.newMerkleRoot,
        newByteSize: params.newByteSize,
        newMerkleLeafCount: params.newMerkleLeafCount ?? 0,
        mintAmount: params.mintAmount !== undefined ? BigInt(params.mintAmount) : undefined,
        burnTokenIds: burnIds,
        newTokenAmount: params.newTokenAmount,
        boundNewTokenAmount: newTokenAmount,
        newCatalogRoot: params.newCatalogRoot,
        newCatalogLeafCount: params.newCatalogLeafCount,
      });
      const raw = ethers.Signature.from(await signer.signMessage(ackDigest));
      ackSigs = [{ identityId, r: ethers.getBytes(raw.r), vs: ethers.getBytes(raw.yParityAndS) }];
    }

    if (!params.authorAddress || !params.authorR?.length || !params.authorVS?.length) {
      throw new Error(
        'updateKnowledgeAssets requires authorAddress, authorR, and authorVS from precomputedUpdateAttestation',
      );
    }

    const updateParams = {
      id: params.kaId,
      updateOperationId: opId,
      newMerkleRoot: ethers.hexlify(params.newMerkleRoot),
      newByteSize: params.newByteSize,
      newTokenAmount,
      newMerkleLeafCount: params.newMerkleLeafCount,
      mintKnowledgeAssetsAmount: params.mintAmount ?? 0,
      knowledgeAssetsToBurn: burnIds,
      // OT-RFC-49 — curated `_catalog` commitment refresh (REPLACED the
      // ciphertext-chunks pair). Defaults to `bytes32(0)` / 0 (metadata-only
      // update or public-CG path; the KC's existing commitment stays in
      // place). Callers rotating a curated catalog set BOTH non-zero.
      newCatalogRoot: params.newCatalogRoot
        ? ethers.hexlify(params.newCatalogRoot)
        : ethers.ZeroHash,
      newCatalogLeafCount: params.newCatalogLeafCount ?? 0,
      publisherNodeIdentityId: identityId,
      identityIds: ackSigs.map(s => s.identityId),
      r: ackSigs.map(s => ethers.hexlify(s.r)),
      vs: ackSigs.map(s => ethers.hexlify(s.vs)),
      authorAddress: params.authorAddress,
      authorR: ethers.hexlify(params.authorR),
      authorVS: ethers.hexlify(params.authorVS),
      authorSchemeVersion: params.authorSchemeVersion ?? AUTHOR_SCHEME_VERSION_V1,
    };

    // Approve TRAC for the V10 update — the contract may transferFrom
    // for the newTokenAmount (same direct-spend policy as publish).
    // Shares the `ensureV10ApproveTrac` helper with the publish path so a
    // single config knob (`chain.approvalPolicy`) controls allowance
    // sizing for both V10 surfaces. The default `per-publish` policy
    // floors at 1n so metadata-only updates with `newTokenAmount === 0n`
    // still satisfy the contract's `transferFrom(..., 1n)` minimum.
    // #953: the approve runs INSIDE the per-wallet serialized window below
    // (it sends its own tx on `signer`), not here — it is an executable
    // first step of the direct serialized V10 write sequence.

    // P-1 review (Codex iter-5): same pattern as the publish path —
    // break the single contract call into populate / sign / hook /
    // broadcast so the `onBroadcast` checkpoint fires at the actual
    // eth_sendRawTransaction boundary, and so a hook failure (e.g.
    // WAL persistence error) aborts broadcast instead of leaving an
    // unmatched WAL record. RFC-001 unified `update`/`updateDirect`
    // into a single entrypoint: the contract auto-detects PCA discount
    // via `agentToAccountId(msg.sender)` for any positive
    // `deltaTokenAmount`.
    // #888: same stale-allowance recovery as the publish path. Metadata-only
    // updates (`newTokenAmount === 0n`, floored to a 1-wei approve) are just
    // as exposed to a stale `TooLowAllowance` read on a load-balanced RPC, so
    // route both V10 write paths through the shared helper. Strictly
    // pre-broadcast — no on-chain side effect from the forced re-approve.
    // #888 + #953: same shared dispatch as the publish path — populate+sign
    // with one-shot allowance recovery, WAL checkpoint, broadcast, all
    // serialized per operational wallet so concurrent same-wallet writes
    // can't collide on the `pending` nonce.
    const receipt = await this.dispatchSerializedV10Write(
      signer,
      'update',
      params.onBroadcast,
      {
        kaContract: ka as Contract,
        methodParams: updateParams,
        kav10Address,
        tokenAmount: newTokenAmount,
        approvalLabel: 'approve V10 update TRAC',
        reapproveLabel: 'approve V10 update TRAC (forced re-approve, #888)',
      },
      (preBroadcastTxHash) => {
        throw new Error(
          `update broadcast succeeded (txHash=${preBroadcastTxHash}) but receipt was null ` +
          `— the tx was likely replaced or dropped before confirmation`,
        );
      },
    );

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      success: receipt.status === 1,
      publisherAddress: signer.address,
    };
  }
}
