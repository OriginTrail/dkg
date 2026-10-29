import { decodeV9UpdateReceiptLog, decodeV10UpdateReceiptLog, type UpdateReceiptFacts } from './update-receipt-facts.js';
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge-collection publish / update / mint pipeline methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase, decodeConvictionCostCovered, type EvmSigner } from './evm-adapter-base.js';
import { readPinnedMintState } from './evm-mint-state-proof.js';
import { ethers, Contract } from 'ethers';
import type {
  BatchMintParams,
  BatchMintResult,
  CanonicalFinalizationReceipt,
  CanonicalFinalizationReceiptReadOptions,
  CanonicalFinalizationReceiptResolution,
  ChainReadOptions,
  PublishReceiptReadOptions,
  FinalizedChainProofSnapshot,
  KAUpdateVerification,
  OnChainPublishResult,
  PublisherPublishPlan,
  PublisherPublishPlanRequest,
  PublishTransactionResolution,
  ReservedRange,
  TxResult,
  V10UpdateKAParams,
} from './chain-adapter.js';
import { publisherPublishPlanByteSize } from './chain-adapter.js';
import { floorPublishTokenAmount, computeUpdateACKDigest, AUTHOR_SCHEME_VERSION_V1 } from '@origintrail-official/dkg-core';
import { resolveQuotedPublisherCandidatePricing } from './publisher-plan.js';
import { reconcilePublisherCandidateFunding, type PublisherPcaPricingEvidence } from './evm-publisher-funding.js';
import { errorCode, errorMessage } from './evm-adapter-errors.js';
import { isRetryableRpcError } from './evm-adapter-rpc.js';
import { isChainRpcTransportError } from './chain-rpc-transport-error.js';

type PublisherCandidatePlan = PublisherPublishPlan & {
  signer: EvmSigner;
  address: string;
  pcaPricing: PublisherPcaPricingEvidence;
};

export class PublishMethods extends EVMChainAdapterBase {
  async resolvePublisherPublishPlan(
    request: PublisherPublishPlanRequest,
  ): Promise<PublisherPublishPlan> {
    await this.init();
    return this.resolveFundedPublisherPublishPlan(request);
  }

  /** AskStorage quote owned by the publish feature boundary. */
  protected async quoteRequiredPublishTokenAmount(
    publicByteSize: bigint,
    epochs: number,
  ): Promise<bigint> {
    if (!this.contracts.askStorage) {
      throw new Error('AskStorage not available');
    }
    const ask = await this.readContract(
      this.contracts.askStorage,
      'askStorage.getStakeWeightedAverageAsk',
      'getStakeWeightedAverageAsk',
    );
    return (BigInt(ask) * publicByteSize * BigInt(epochs)) / 1024n;
  }

  private async _publisherCandidatePlan(
    signer: EvmSigner,
    request: PublisherPublishPlanRequest,
    quote: (epochs: number, purpose: 'pca' | 'direct') => Promise<bigint>,
  ): Promise<PublisherCandidatePlan> {
    const pricing = await resolveQuotedPublisherCandidatePricing({
      publisherAddress: signer.address,
      explicitPublishEpochs: request.explicitPublishEpochs,
      defaultPublishEpochs: request.defaultPublishEpochs,
      quote,
      conviction: this.contracts.dkgPublishingConvictionNFT
        ? this.publisherConvictionPlanReader()
        : undefined,
    });
    const diagnostics = pricing.source === 'direct' ? pricing.diagnostics : undefined;
    if (diagnostics?.pcaProbeError !== undefined) {
      console.warn(
        `[chain] PCA publish-plan probe failed for signer=${signer.address}; ` +
        `using directly quoted lifetime=${pricing.publishEpochs}: ` +
        `${errorMessage(diagnostics.pcaProbeError)}`,
      );
    }

    return {
      signer,
      address: signer.address,
      publisherAddress: signer.address,
      publishEpochs: pricing.publishEpochs,
      tokenAmount: pricing.tokenAmount,
      pcaPricing: diagnostics?.pcaProbeError !== undefined && (
        isRetryableRpcError(diagnostics.pcaProbeError)
        || errorCode(diagnostics.pcaProbeError) === 'CALL_EXCEPTION'
      )
        ? { kind: 'unavailable', error: diagnostics.pcaProbeError }
        : { kind: 'available' },
    };
  }

  /** Reconcile an earlier pricing probe with fresh, candidate-specific evidence.
   * A failed planning read is not itself proof that the final funding read is
   * unknown: the wallet may have no gas, no PCA, or a recovered PCA read. */
  private async _selectFundedPublisherPlanOrThrow(
    plans: PublisherCandidatePlan[],
    request: PublisherPublishPlanRequest,
    quote: (epochs: number, purpose: 'pca' | 'direct') => Promise<bigint>,
  ): Promise<PublisherCandidatePlan> {
    return reconcilePublisherCandidateFunding({
      candidates: plans,
      assess: (currentPlans) => this._assessFundedCandidates(currentPlans, (plan) => ({
        kind: 'native+trac',
        nativeFloorWei: this.minPublisherNativeWei,
        tracFloorWei: this.minPublisherTracWei,
        requiredTracWei: plan.tokenAmount,
        pca: { kind: 'publish', epochs: plan.publishEpochs },
      }), { preferIdle: false }),
      reprice: (plan) => this._publisherCandidatePlan(plan.signer, request, quote),
      conviction: () => this.publisherConvictionPlanReader(),
    });
  }

  /**
   * Publish-owned planning state machine. It composes generic base primitives
   * for authorization, serialized cursor advancement, and strict fundability
   * with AskStorage/PCA policy local to this feature module.
   */
  protected async resolveFundedPublisherPublishPlan(
    request: PublisherPublishPlanRequest,
  ): Promise<PublisherPublishPlan> {
    const quoteCache = new Map<string, Promise<bigint>>();
    const quote = (epochs: number, purpose: 'pca' | 'direct'): Promise<bigint> => {
      const cacheKey = `${purpose}:${epochs}`;
      const cached = quoteCache.get(cacheKey);
      if (cached) return cached;
      const pending = this.quoteRequiredPublishTokenAmount(
        publisherPublishPlanByteSize(request),
        epochs,
      )
        .catch((error) => {
          // A transient PCA-lock quote failure must not poison the fallback
          // direct-spend quote for the same numeric lifetime.
          quoteCache.delete(cacheKey);
          throw error;
        });
      quoteCache.set(cacheKey, pending);
      return pending;
    };

    if (request.publisherAddress) {
      const signer = await this.resolvePinnedPublisherSigner(
        request.contextGraphId,
        request.publisherAddress,
      );
      const plan = await this._publisherCandidatePlan(signer, request, quote);
      const selected = await this._selectFundedPublisherPlanOrThrow([plan], request, quote);
      return {
        publisherAddress: selected.publisherAddress,
        publishEpochs: selected.publishEpochs,
        tokenAmount: selected.tokenAmount,
      };
    }

    const selectedPlan = await this._withSignerSelection(async (ordered) => {
      const authorized = await this._authorizedPublisherSigners(ordered, request.contextGraphId);
      // Resolve in cursor order so one candidate's transient PCA quote can be
      // retried through its direct-spend phase before another candidate consumes
      // the same lifetime. The shared quote cache still avoids duplicate reads
      // after the first successful quote.
      const plans: PublisherCandidatePlan[] = [];
      for (const signer of authorized) {
        plans.push(await this._publisherCandidatePlan(signer, request, quote));
      }
      return this._selectFundedPublisherPlanOrThrow(plans, request, quote);
    });
    // Do not expose the internal signer carried only for cursor advancement.
    return {
      publisherAddress: selectedPlan.publisherAddress,
      publishEpochs: selectedPlan.publishEpochs,
      tokenAmount: selectedPlan.tokenAmount,
    };
  }

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

  async verifyKAUpdate(
    txHash: string,
    batchId: bigint,
    publisherAddress: string,
    options: ChainReadOptions = {},
  ): Promise<KAUpdateVerification> {
    await this.init();
    if (!this.contracts.knowledgeAssetsStorage && !this.contracts.knowledgeAssetStorage) {
      return { verified: false };
    }
    try {
      const receipt = await this.getTransactionReceiptWithFailover(txHash, { signal: options.signal });
      if (!receipt || receipt.status !== 1) return { verified: false };
      const facts = await this.firstMatchingUpdateReceiptFacts(receipt, batchId);
      return facts ? await this.authenticateUpdateReceipt(receipt, facts, publisherAddress, options) : { verified: false };
    } catch (error) {
      if (isChainRpcTransportError(error)) throw error;
      return { verified: false };
    }
  }

  /** The legacy verifier preserves V9-first matching for the requested asset. */
  private async firstMatchingUpdateReceiptFacts(receipt: ethers.TransactionReceipt, kaId: bigint): Promise<UpdateReceiptFacts | null> {
    const v9 = this.contracts.knowledgeAssetsStorage;
    if (v9) {
      const address = await v9.getAddress();
      for (const log of receipt.logs) {
        const facts = decodeV9UpdateReceiptLog(log, v9, address);
        if (facts?.kaId === kaId) return facts;
      }
    }
    const v10 = this.contracts.knowledgeAssetStorage;
    if (v10) {
      const address = await v10.getAddress();
      for (const log of receipt.logs) {
        const facts = decodeV10UpdateReceiptLog(log, v10, address);
        if (facts?.kaId === kaId) return facts;
      }
    }
    return null;
  }

  /** Authenticate already-decoded facts against this receipt's history without refetching it. */
  private async authenticateUpdateReceipt(
    receipt: ethers.TransactionReceipt,
    facts: UpdateReceiptFacts,
    publisherAddress: string,
    options: ChainReadOptions,
  ): Promise<KAUpdateVerification> {
    const batchId = facts.kaId;
    const onChainMerkleRoot = facts.merkleRoot;
    // Read the V10 root history at the receipt block, not latest. Besides
    // producing the post-update assertion index, this prevents a later
    // update by another publisher from making verification of this older,
    // otherwise-valid transaction fail. The block tag excludes future
    // blocks; matching the event root selects this update when the block
    // contains multiple updates for the same KA.
    let onChainPublisher: string | undefined;
    let merkleRootCount: bigint | undefined;
    if (this.contracts.knowledgeAssetStorage) {
      try {
        const roots = await this.readContractWithOptions(
          this.contracts.knowledgeAssetStorage,
          'kas.getMerkleRootsAtUpdateBlock',
          'getMerkleRoots',
          [batchId, { blockTag: receipt.blockNumber }],
          { signal: options.signal },
        ) as Array<{ publisher?: string; merkleRoot?: string } | readonly unknown[]>;
        // r17 (3814893084) / r28 (🔴 3821721213) — the register entries carry no transaction
        // hash, so a (publisher, root) match is the only link back to this receipt. r17 counted
        // those matches across the WHOLE register, which is the asset's entire history as of
        // this block — not this block's writes. An A -> B -> A history by one publisher in three
        // SEPARATE blocks therefore produced two matches for A, dropped the position, and left
        // the third update permanently held: the exact case this PR exists to settle, made
        // unrecoverable by its own ambiguity guard.
        //
        // Ambiguity is a property of the RECEIPT'S BLOCK. Entries written before it cannot be
        // this transaction's, so the pre-block count marks where its candidates begin, and only
        // matches at or after that boundary compete. A genuinely ambiguous same-block pair still
        // drops the position; a historical repeat no longer can.
        let preBlockCount = 0;
        if (receipt.blockNumber > 0) {
          const before = await this.readContractWithOptions(
            this.contracts.knowledgeAssetStorage,
            'kas.getMerkleRootsBeforeUpdateBlock',
            'getMerkleRoots',
            [batchId, { blockTag: receipt.blockNumber - 1 }],
            { signal: options.signal },
          ) as ReadonlyArray<unknown>;
          preBlockCount = before.length;
        }
        const entryAt = (i: number) => {
          const root = roots[i] as { publisher?: string; merkleRoot?: string };
          return {
            publisher: root.publisher ?? String((root as readonly unknown[])[0] ?? ''),
            merkleRoot: root.merkleRoot ?? String((root as readonly unknown[])[1] ?? ''),
          };
        };
        const isOurs = (i: number) => {
          const e = entryAt(i);
          return e.publisher.toLowerCase() === publisherAddress.toLowerCase()
            && e.merkleRoot.toLowerCase() === ethers.hexlify(onChainMerkleRoot).toLowerCase();
        };
        // `verified` still asks the whole register: the root IS ours somewhere in this asset's
        // history, which is what authenticates the receipt. Only the POSITION is restricted to
        // this block's candidates.
        let matchedIndex = -1;
        for (let i = roots.length - 1; i >= 0; i--) {
          if (isOurs(i)) { matchedIndex = i; onChainPublisher = entryAt(i).publisher; break; }
        }
        if (matchedIndex < 0) {
          return { verified: false };
        }
        let blockMatchIndex = -1;
        let blockMatchCount = 0;
        for (let i = preBlockCount; i < roots.length; i += 1) {
          if (!isOurs(i)) continue;
          if (blockMatchCount === 0) blockMatchIndex = i;
          blockMatchCount += 1;
        }
        merkleRootCount = blockMatchCount === 1 ? BigInt(blockMatchIndex + 1) : undefined;
      } catch (error) {
        if (isChainRpcTransportError(error)) throw error;
        // A latest-state fallback can authenticate a historical receipt with
        // a different publisher/root after a later update. V10 verification
        // therefore fails closed when the receipt-block view is unavailable.
        return { verified: false };
      }
    }
    if (
      !this.contracts.knowledgeAssetStorage
      && (!onChainPublisher || onChainPublisher === ethers.ZeroAddress)
      && this.contracts.knowledgeAssetsStorage
    ) {
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
      blockHash: receipt.blockHash,
      txIndex: receipt.index,
      merkleRootCount,
    };
  }

  async getRequiredPublishTokenAmount(publicByteSize: bigint, epochs: number): Promise<bigint> {
    await this.init();
    return this.quoteRequiredPublishTokenAmount(publicByteSize, epochs);
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

  async resolvePublishByTxHash(
    txHash: string,
    options: PublishReceiptReadOptions = {},
  ): Promise<OnChainPublishResult | null> {
    await this.init();

    try {
      // Projection: receipt-only, one RPC round trip. Every non-confirmed state is discarded
      // here anyway, so this surface never pays for the transaction-presence lookup.
      const { receipt, publish } = await this.readPublishReceipt(txHash, options);
      return receipt && receipt.status === 1 ? publish : null;
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (msg.includes('could not find') || msg.includes('not found') || msg.includes('unknown transaction')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * GH#2270 — the un-collapsed form of {@link resolvePublishByTxHash}.
   *
   * The extra `eth_getTransaction` round trip fires ONLY when there is no
   * receipt, and it is what makes `not-found` mean something: without it a
   * missing receipt is indistinguishable from a transaction sitting in the
   * mempool, and recovery would resend a publish that is about to be mined.
   * `resolvePublishByTxHash` keeps its cheaper receipt-only path (it discards
   * every non-confirmed state anyway).
   *
   * A lookup failure throws rather than resolving to a status: an RPC error is
   * an absence of information, never information about an absence.
   *
   * A MINED receipt is only evidence about the block it sits in, and every mined
   * verdict this surface emits authorises a real action somewhere downstream: `reverted` releases
   * the job's lifecycle hold as proven-ineffective, `confirmed` finalizes it as published, and
   * `unrecognized` feeds update recognition. The operator-selected
   * `chain.finalityConfirmations` threshold controls when that verdict may be emitted (default 1,
   * with the receipt block itself counting as confirmation 1). Canonicality is always checked by
   * requiring the receipt's block hash to still occupy its height. Until both depth and hash match,
   * the answer is `pending`. The finality read itself failing propagates as a rejection.
   */
  async resolvePublishTransaction(
    txHash: string,
    options: ChainReadOptions = {},
  ): Promise<PublishTransactionResolution> {
    await this.init();

    const { receipt, publish } = await this.readPublishReceipt(txHash, options);
    if (receipt) {
      if (!(await this.isReceiptBlockFinalAndCanonical(receipt, options))) {
        // Mined but not yet at the operator-selected confirmation depth: a pending shape of
        // its own, SCHEDULING-ONLY (it tightens the caller's re-ask cadence, never evidence).
        return { status: 'pending-awaiting-confirmation' };
      }
      if (receipt.status !== 1) return { status: 'reverted' };
      if (!publish) return { status: 'unrecognized' };
      const canonicalReceipt = this.projectCanonicalFinalizationReceipt(receipt, publish);
      return {
        status: 'confirmed',
        publish,
        ...(canonicalReceipt ? { canonicalReceipt } : {}),
      };
    }
    // The SECOND step, paid only on this surface and only when there is no receipt — it is what
    // separates a transaction the node is holding from one it has never seen.
    const transaction = await this.getTransactionWithFailover(txHash, options);
    return transaction ? { status: 'pending-mempool' } : { status: 'not-found' };
  }

  /**
   * GH#2270 PR-3 r4 — see {@link ChainAdapter.readFinalizedChainProofSnapshot}.
   *
   * The legacy method name says "finalized", but the snapshot now uses the same
   * operator-selected `chain.finalityConfirmations` threshold as receipt proof.
   * With the default value `1`, the latest block is the pinned proof block. A
   * larger value pins `latest - confirmations + 1`. This keeps found-transaction
   * proof and missing-transaction proof on one explicit finality policy.
   *
   * Everything happens inside ONE `readProvider` callback, so all three reads — the finalized
   * block identity, the account nonce and the minted state — are served by the SAME endpoint, and
   * the two state reads are pinned to that block's NUMBER rather than re-evaluating `finalized`
   * (which can advance between calls). A transport failure inside the callback fails over to the
   * next endpoint as a whole, so a snapshot is never spliced across two providers; if no endpoint
   * can produce the pinned pair the answer is `null`, and the caller holds.
   *
   * The minted classification (PR #2300 r1 — private to the adapter now; the public
   * `isKnowledgeAssetMinted` it came from is deleted): ERC-721 `ownerOf` REVERTS for an unminted
   * token, so "not published" arrives as a thrown CALL_EXCEPTION. Only the exact
   * nonexistent-token shape is read as `false`; every other CHAIN answer (a paused contract, a
   * decode failure, an undeployed storage contract) is `null`, and the caller holds. A TRANSPORT
   * failure on the minted read is neither: it says nothing about the token, so it RETHROWS and
   * the whole pinned snapshot fails over to the next endpoint — swallowing it as `null` would let
   * one flaky read on an otherwise healthy endpoint block a provable release.
   */
  async readFinalizedChainProofSnapshot(
    params: { address: string; kaId: bigint },
    options: ChainReadOptions = {},
  ): Promise<FinalizedChainProofSnapshot | null> {
    await this.init();
    try {
      const storage = this.contracts.knowledgeAssetStorage;
      return await this.readProviderRetryingNull('confirmation-depth chain-proof snapshot', provider =>
        readPinnedMintState(provider, {
          chainId: this.chainId, finalityConfirmations: this.finalityConfirmations, kaId: params.kaId,
          readOwner: storage ? (kaId, blockTag) => this.rebindContract(storage, provider).ownerOf(kaId, { blockTag }) : undefined,
        }, async blockNumber => ({ accountNonce: await provider.getTransactionCount(params.address, blockNumber) })),
      { signal: options.signal });
    } catch { return null; }
  }

  /**
   * GH#2270 PR-3 r2 — the ONE receipt read the three publish-resolution surfaces project from.
   *
   * They had drifted into three separate walks of the same data: two shared a helper, the canonical
   * one re-implemented the receipt fetch, the status check and the V10/V9 parse fallthrough
   * inline. Three copies of "what does this receipt say about a publish" is three places for the
   * V9 fallback, or the meaning of `status !== 1`, to be updated in two.
   *
   * What it returns is deliberately RAW: the receipt as fetched, plus the parsed publish when one
   * could be read. Every judgement — is a missing receipt an absence, does a mismatched block hash
   * mean reorg, is an unparseable publish a rejection or merely unrecognized — belongs to the
   * projection, because the three surfaces genuinely answer differently and only one of them has
   * the caller's expected block identity to compare against.
   *
   * `receipt: null` means the node had no receipt. It is NOT a verdict: only a caller that follows
   * it with a transaction lookup may turn it into `pending` or `not-found`.
   */
  private async readPublishReceipt(
    txHash: string,
    options: PublishReceiptReadOptions,
    logLabel?: string,
  ): Promise<{
    receipt: ethers.TransactionReceipt | null;
    publish: OnChainPublishResult | null;
  }> {
    const receipt = await this.getTransactionReceiptWithFailover(txHash, {
      signal: options.signal,
      ...(logLabel ? { logLabel } : {}),
    });
    if (!receipt || receipt.status !== 1) return { receipt, publish: null };

    const facts = (this.contracts.knowledgeAssetStorage
      ? this.decodeV10PublishReceipt(receipt) : null)
      ?? (this.contracts.knowledgeAssetsStorage
        ? this.decodeV9PublishReceipt(receipt) : null);
    return { receipt, publish: facts ? await this.enrichPublishReceipt(receipt, facts, options) : null };
  }

  /**
   * Project the strict recovery receipt from the exact receipt/publish pair a
   * caller already read. This is deliberately pure: the caller owns the live
   * canonicality/finality gate, and an incomplete projection simply leaves
   * the existing canonical-receipt fallback in place.
   */
  private projectCanonicalFinalizationReceipt(
    receipt: ethers.TransactionReceipt,
    parsedPublish: Pick<OnChainPublishResult, 'merkleRoot' | 'publisherAddress' | 'authorAddress'
      | 'batchId' | 'kaId' | 'startKAId' | 'endKAId' | 'knowledgeAssetsContract'>,
  ): CanonicalFinalizationReceipt | null {
    if (
      !parsedPublish.merkleRoot
      || !parsedPublish.publisherAddress
      || !Number.isSafeInteger(receipt.index)
      || receipt.index < 0
      || !receipt.blockHash
    ) {
      return null;
    }
    const kaId = parsedPublish.kaId ?? parsedPublish.batchId;
    const startKAId = parsedPublish.startKAId ?? kaId;
    const endKAId = parsedPublish.endKAId ?? kaId;
    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      txIndex: receipt.index,
      merkleRoot: parsedPublish.merkleRoot,
      publisherAddress: parsedPublish.publisherAddress,
      ...(parsedPublish.authorAddress
        ? { authorAddress: parsedPublish.authorAddress }
        : {}),
      batchId: parsedPublish.batchId,
      kaId,
      startKAId,
      endKAId,
      ...(parsedPublish.knowledgeAssetsContract
        ? { knowledgeAssetsContract: parsedPublish.knowledgeAssetsContract }
        : {}),
    };
  }

  async resolveCanonicalFinalizationReceipt(
    txHash: string,
    options: CanonicalFinalizationReceiptReadOptions = {},
  ): Promise<CanonicalFinalizationReceiptResolution> {
    await this.init();
    const { receipt, publish: parsedPublish } = await this.readPublishReceipt(
      txHash,
      options,
      'canonical finalization receipt',
    );
    if (!receipt) {
      const transaction = await this.getTransactionWithFailover(txHash, options);
      return transaction ? { status: 'pending' } : { status: 'not-found' };
    }
    if (receipt.status !== 1) return { status: 'rejected' };
    if (
      (options.expectedBlockHash !== undefined
        && receipt.blockHash.toLowerCase() !== options.expectedBlockHash.toLowerCase())
      || (options.expectedBlockNumber !== undefined
        && receipt.blockNumber !== options.expectedBlockNumber)
    ) {
      return { status: 'reorged' };
    }

    const storage = this.contracts.knowledgeAssetStorage;
    const updates = !parsedPublish && options.includeKnowledgeAssetUpdates === true && storage
      ? receipt.logs.flatMap(log => { const facts = decodeV10UpdateReceiptLog(log, storage, String(storage.target)); return facts ? [facts] : []; }) : [];
    const updateFacts = updates.length === 1 ? updates[0] : null;
    const confirmation = parsedPublish ?? (updateFacts ? { batchId: updateFacts.kaId, kaId: updateFacts.kaId,
      startKAId: updateFacts.kaId, endKAId: updateFacts.kaId,
      merkleRoot: updateFacts.merkleRoot, authorAddress: updateFacts.authorAddress,
      publisherAddress: receipt.from, knowledgeAssetsContract: updateFacts.knowledgeAssetsContract } : null);
    if (!confirmation) return { status: 'rejected' };
    const canonicalReceipt = this.projectCanonicalFinalizationReceipt(receipt, confirmation);
    if (canonicalReceipt && updateFacts) {
      const update = await this.authenticateUpdateReceipt(receipt, updateFacts, canonicalReceipt.publisherAddress, options);
      if (!update.verified || update.merkleRootCount === undefined || update.merkleRootCount <= 1n
        || this.contracts.knowledgeAssetStorage !== storage) return { status: 'rejected' };
      // The existing verifier excludes prior blocks and refuses same-block duplicate matches.
      // A latest count or repeated author signature cannot bind this receipt to its version.
      canonicalReceipt.assertionVersion = update.merkleRootCount;
      await this.getFinalizedBlockTimestamp(receipt.blockNumber, receipt.blockHash, options);
    }
    return canonicalReceipt
      ? { status: 'confirmed', receipt: canonicalReceipt }
      : { status: 'rejected' };
  }

  /** Apply header-read policy once, outside either event-format decoder. */
  private async enrichPublishReceipt(
    receipt: Pick<ethers.TransactionReceipt, 'blockNumber' | 'blockHash'>,
    facts: Omit<OnChainPublishResult, 'blockTimestamp'>,
    options: PublishReceiptReadOptions,
  ): Promise<OnChainPublishResult> {
    const blockTimestamp = options.skipBlockTimestamp === true ? 0
      : await this.getFinalizedBlockTimestamp(receipt.blockNumber, receipt.blockHash, options);
    return { ...facts, blockTimestamp };
  }

  async parseV10PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
    options: PublishReceiptReadOptions = {},
  ): Promise<OnChainPublishResult | null> {
    const facts = this.decodeV10PublishReceipt(receipt);
    return facts ? this.enrichPublishReceipt(receipt, facts, options) : null;
  }

  private decodeV10PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Omit<OnChainPublishResult, 'blockTimestamp'> | null {
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) return null;

    let kaId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let merkleRoot: Uint8Array | undefined;
    let publisherAddress = '';
    let authorAddress: string | undefined;
    let foundCreated = false;
    const storageAddress = String(kas.target).toLowerCase();

    for (const log of receipt.logs) {
      const logAddr = typeof log.address === 'string' ? log.address.toLowerCase() : '';
      if (logAddr !== storageAddress) continue;
      try {
        const parsed = kas.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'KnowledgeAssetCreated') {
          kaId = BigInt(parsed.args.id);
          authorAddress = String(parsed.args.author);
          if (parsed.args.merkleRoot != null) {
            merkleRoot = ethers.getBytes(parsed.args.merkleRoot);
          }
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

    const convictionCostCovered = decodeConvictionCostCovered(receipt.logs);

    return {
      batchId: kaId,
      kaId: kaId,
      knowledgeAssetsContract: String(kas.target),
      merkleRoot,
      startKAId,
      endKAId,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
      publisherAddress,
      authorAddress,
      ...(convictionCostCovered ? { convictionCostCovered } : {}),
    };
  }

  async parseV9PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
    options: PublishReceiptReadOptions = {},
  ): Promise<OnChainPublishResult | null> {
    const facts = this.decodeV9PublishReceipt(receipt);
    return facts ? this.enrichPublishReceipt(receipt, facts, options) : null;
  }

  private decodeV9PublishReceipt(
    receipt: NonNullable<Awaited<ReturnType<typeof this.provider.getTransactionReceipt>>>,
  ): Omit<OnChainPublishResult, 'blockTimestamp'> | null {
    const storage = this.contracts.knowledgeAssetsStorage;
    if (!storage) return null;

    let batchId = 0n;
    let startKAId = 0n;
    let endKAId = 0n;
    let merkleRoot: Uint8Array | undefined;
    let publisherAddress = '';
    let foundBatchCreated = false;
    const storageAddress = String(storage.target).toLowerCase();

    for (const log of receipt.logs) {
      const logAddress = typeof log.address === 'string' ? log.address.toLowerCase() : '';
      if (logAddress !== storageAddress) continue;
      try {
        const parsed = storage.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'UALRangeReserved') {
          publisherAddress = parsed.args.publisher;
          startKAId = BigInt(parsed.args.startId);
          endKAId = BigInt(parsed.args.endId);
        }
        if (parsed?.name === 'KnowledgeBatchCreated') {
          batchId = BigInt(parsed.args.batchId);
          publisherAddress = String(parsed.args.publisher);
          merkleRoot = ethers.getBytes(parsed.args.merkleRoot);
          startKAId = BigInt(parsed.args.startKAId);
          endKAId = BigInt(parsed.args.endKAId);
          foundBatchCreated = true;
        }
      } catch {
        // ignore unrelated logs
      }
    }

    if (!foundBatchCreated) return null;


    return {
      batchId,
      startKAId,
      endKAId,
      merkleRoot,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      txIndex: receipt.index,
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
        const context = await this.readKnowledgeAssetUpdateContext(kas, params.kaId);
        currentByteSize = context.byteSize;
        endEpoch = context.endEpoch;
      } catch (err) {
        throw new Error(
          `Failed to read KA update context for kaId ${params.kaId}: ${(err as Error).message}`,
        );
      }
    }

    let currentEpoch = 0n;
    const needsGrowthSizing = params.newByteSize > currentByteSize;
    if (needsGrowthSizing) {
      try {
        // Growth sizing is the only path that needs the epoch. The shared
        // helper owns lazy Chronos resolution when init has not bound it yet.
        currentEpoch = await this.getCurrentEpoch();
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

    let signer: EvmSigner | undefined;

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
    // (it sends its own tx on `signer`), not here — see the buildSignedTx
    // closure passed to `dispatchSerializedV10Write`.

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
      async (ctx) => {
        // #953: approve INSIDE the per-wallet lock (it sends its own tx on
        // `signer`) so a concurrent same-wallet update/publish can't race on
        // the approve nonce.
        await this.ensureV10ApproveTrac(
          signer,
          kav10Address,
          newTokenAmount,
          'approve V10 update TRAC',
          false,
          ctx.sendContractTransaction,
        );
        return this.signPreparedTransaction(await this.prepareV10WithAllowanceRecovery(
          signer,
          ka as Contract,
          'update',
          updateParams,
          kav10Address,
          newTokenAmount,
          'approve V10 update TRAC (forced re-approve, #888)',
          ctx.sendContractTransaction,
        ));
      },
      (preBroadcastTxHash) => {
        throw new Error(
          `update broadcast succeeded (txHash=${preBroadcastTxHash}) but receipt was null ` +
          `— the tx was likely replaced or dropped before confirmation`,
        );
      },
      params.onBroadcastAccepted,
      params.onBeforeReplacementBroadcast,
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
