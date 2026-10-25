// SPDX-License-Identifier: Apache-2.0

/**
 * OT-RFC-27 marketplace settlement methods (`Marketplace.sol`).
 *
 * Mixin holder following the evm-adapter.ts split: `extends EVMChainAdapterBase`
 * for shared state (contracts, signer, read/write facades) reached via `this`,
 * mixed into the concrete EVMChainAdapter via applyMixins(). The contract is an
 * OPTIONAL Hub binding (resolved in `initContracts`); `supportsMarketplace()`
 * is the runtime gate and every method here throws a clear capability error
 * when the deployment has no `Marketplace` registered.
 *
 * Wire shapes come from `chain-adapter-marketplace.ts`; the shared
 * `ReceiptClaimInput` (domain package `@origintrail-official/dkg-marketplace`)
 * maps 1:1 onto `MarketplaceLib.ReceiptClaim` — only `askPerUnitWei` renames
 * to the ABI's `askPerUnit` here.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { ethers } from 'ethers';
import type { TxResult } from './chain-adapter.js';
import type {
  MarketplaceBucket,
  MarketplaceClaimEpochRewardResult,
  MarketplaceEpochRewardDistribution,
  MarketplaceFundSubscriptionParams,
  MarketplaceNodeEpochAccounting,
  MarketplaceParams,
  MarketplaceSellerClaim,
  ReceiptClaimInput,
} from './chain-adapter-marketplace.js';

function marketplaceTxResult(receipt: ethers.TransactionReceipt): TxResult {
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    txIndex: receipt.index,
    success: true,
  };
}

export class MarketplaceMethods extends EVMChainAdapterBase {
  /**
   * True once `initContracts` resolved the `Marketplace` Hub binding. Like
   * `isV10Ready()`, this reads the binding synchronously, so it reports false
   * until the first `init()` has run on this adapter.
   */
  supportsMarketplace(): boolean {
    return !!this.contracts.marketplace;
  }

  protected requireMarketplace(): ethers.Contract {
    const marketplace = this.contracts.marketplace;
    if (!marketplace) {
      throw new Error(
        'Marketplace contract is not registered in the Hub on this deployment. ' +
        'The OT-RFC-27 marketplace surface is unavailable — gate calls on supportsMarketplace().',
      );
    }
    return marketplace;
  }

  async marketplaceGetAddress(): Promise<string> {
    await this.init();
    return this.requireMarketplace().getAddress();
  }

  async marketplaceFundSubscription(params: MarketplaceFundSubscriptionParams): Promise<TxResult> {
    await this.init();
    const marketplace = this.requireMarketplace();
    const marketplaceAddress = await marketplace.getAddress();

    // `fundSubscription` pulls the TRAC via `safeTransferFrom` in the same
    // call, so an exact-amount approve leaves no standing allowance behind
    // (minimal blast radius; each funding re-approves what it moves).
    if (this.contracts.token && params.amountWei > 0n) {
      const currentAllowance: bigint = await this.readContract(
        this.contracts.token, 'token.allowance', 'allowance', this.signer.address, marketplaceAddress,
      );
      if (currentAllowance < params.amountWei) {
        await this.sendContractTransaction(
          this.contracts.token,
          'approve',
          [marketplaceAddress, params.amountWei],
          this.signer,
          'approve marketplace TRAC',
        );
      }
    }

    const receipt = await this.sendContractTransaction(
      marketplace,
      'fundSubscription',
      [params.amountWei, params.sessionKey ?? ethers.ZeroAddress, params.epoch],
      this.signer,
      'marketplace fundSubscription',
    );
    return marketplaceTxResult(receipt);
  }

  async marketplaceSubmitReceiptBatch(claims: ReceiptClaimInput[]): Promise<TxResult> {
    await this.init();
    const marketplace = this.requireMarketplace();

    // Rename at the ABI boundary only: the domain shape keeps the explicit
    // `...Wei` suffix, the contract tuple field is `askPerUnit`.
    const tuples = claims.map((claim) => ({
      buyer: claim.buyer,
      epoch: claim.epoch,
      offeringId: claim.offeringId,
      callId: claim.callId,
      maxUnits: claim.maxUnits,
      askPerUnit: claim.askPerUnitWei,
      expiry: claim.expiry,
      servedUnits: claim.servedUnits,
      resultCommitment: claim.resultCommitment,
      authSignature: claim.authSignature,
    }));

    const receipt = await this.sendContractTransaction(
      marketplace,
      'submitReceiptBatch',
      [tuples],
      this.signer,
      'marketplace submitReceiptBatch',
    );
    return marketplaceTxResult(receipt);
  }

  async marketplaceFinalizeBucket(buyer: string, epoch: bigint, maxSellers?: bigint): Promise<TxResult> {
    await this.init();
    const receipt = await this.sendContractTransaction(
      this.requireMarketplace(),
      'finalizeBucket',
      // 0n = all remaining claimants; a bound makes the call paginated.
      [buyer, epoch, maxSellers ?? 0n],
      this.signer,
      'marketplace finalizeBucket',
    );
    return marketplaceTxResult(receipt);
  }

  async marketplaceClaimEpochReward(identityId: bigint, epoch: bigint): Promise<MarketplaceClaimEpochRewardResult> {
    await this.init();
    const marketplace = this.requireMarketplace();
    const receipt = await this.sendContractTransaction(
      marketplace,
      'claimEpochReward',
      [identityId, epoch],
      this.signer,
      'marketplace claimEpochReward',
    );

    // `EpochRewardClaimed(epoch, identityId, operational, reward)` is emitted
    // on every successful claim; the parse is best-effort observability, so a
    // decode miss reports 0n rather than failing a mined transaction.
    let rewardWei = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = marketplace.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'EpochRewardClaimed') {
          rewardWei = BigInt(parsed.args.reward ?? parsed.args[3]);
          break;
        }
      } catch { /* not this contract */ }
    }
    return { ...marketplaceTxResult(receipt), rewardWei };
  }

  async marketplaceRollEpochPool(epoch: bigint): Promise<TxResult> {
    await this.init();
    const receipt = await this.sendContractTransaction(
      this.requireMarketplace(),
      'rollEpochPool',
      [epoch],
      this.signer,
      'marketplace rollEpochPool',
    );
    return marketplaceTxResult(receipt);
  }

  async marketplaceGetBucket(buyer: string, epoch: bigint): Promise<MarketplaceBucket> {
    await this.init();
    const raw = await this.readContract(
      this.requireMarketplace(), 'marketplace.getBucket', 'getBucket', buyer, epoch,
    );
    return {
      funded: BigInt(raw.funded ?? raw[0]),
      totalClaimed: BigInt(raw.totalClaimed ?? raw[1]),
      totalFinalized: BigInt(raw.totalFinalized ?? raw[2]),
      finalized: Boolean(raw.finalized ?? raw[3]),
    };
  }

  async marketplaceGetSellerClaim(buyer: string, epoch: bigint, identityId: bigint): Promise<MarketplaceSellerClaim> {
    await this.init();
    const raw = await this.readContract(
      this.requireMarketplace(), 'marketplace.getSellerClaim', 'getSellerClaim', buyer, epoch, identityId,
    );
    return {
      claimed: BigInt(raw.claimed ?? raw[0]),
      qiRaw: BigInt(raw.qiRaw ?? raw[1]),
      enrolled: Boolean(raw.enrolled ?? raw[2]),
    };
  }

  async marketplaceGetNodeEpochAccounting(epoch: bigint, identityId: bigint): Promise<MarketplaceNodeEpochAccounting> {
    await this.init();
    const raw = await this.readContract(
      this.requireMarketplace(), 'marketplace.getNodeEpochAccounting', 'getNodeEpochAccounting', epoch, identityId,
    );
    return {
      finalizedValue: BigInt(raw.finalizedValue ?? raw[0]),
      qiScore: BigInt(raw.qiScore ?? raw[1]),
      totalFinalizedValue: BigInt(raw.totalFinalizedValue ?? raw[2]),
      totalQiScore: BigInt(raw.totalQiScore ?? raw[3]),
      pool: BigInt(raw.pool ?? raw[4]),
      claimed: Boolean(raw.claimed ?? raw[5]),
    };
  }

  async marketplaceGetActiveSessionKey(buyer: string): Promise<string> {
    await this.init();
    return String(await this.readContract(
      this.requireMarketplace(), 'marketplace.activeSessionKey', 'activeSessionKey', buyer,
    ));
  }

  async marketplaceGetParams(): Promise<MarketplaceParams> {
    await this.init();
    const raw = await this.readContract(
      this.requireMarketplace(), 'marketplace.getParams', 'getParams',
    );
    return {
      lambdaQif18: BigInt(raw.lambdaQif18 ?? raw[0]),
      settlementGraceSeconds: BigInt(raw.settlementGraceSeconds ?? raw[1]),
      softCeilingBps: Number(raw.softCeilingBps ?? raw[2]),
      rewardCapMultiple: Number(raw.rewardCapMultiple ?? raw[3]),
    };
  }

  async marketplaceGetEpochRewardDistribution(epoch: bigint): Promise<MarketplaceEpochRewardDistribution> {
    await this.init();
    const raw = await this.readContract(
      this.requireMarketplace(), 'marketplace.getEpochRewardDistribution', 'getEpochRewardDistribution', epoch,
    );
    return {
      pool: BigInt(raw.pool ?? raw[0]),
      distributed: BigInt(raw.distributed ?? raw[1]),
      undistributed: BigInt(raw.undistributed ?? raw[2]),
    };
  }

  async marketplaceSettlementDeadline(epoch: bigint): Promise<bigint> {
    await this.init();
    return BigInt(await this.readContract(
      this.requireMarketplace(), 'marketplace.settlementDeadline', 'settlementDeadline', epoch,
    ));
  }
}
