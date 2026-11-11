// SPDX-License-Identifier: Apache-2.0

/**
 * The NeuroSymbolic Marketplace (OT-RFC-27) on the EVM adapter: the methods of
 * `MarketplaceChain` (marketplace.ts) against `ServiceSubscriptions`,
 * `ServiceSubscriptionsWallet`, `ServiceSubscriptionsStorage`,
 * `QueryInferenceSettlement` and `QueryInferenceStorage`, and the lifetime
 * extension of a seller's offer asset (`KnowledgeAssetsLifecycle`).
 *
 * Mixin holder in the pattern of `evm-adapter-conviction.ts`, mixed into
 * `EVMChainAdapter` with `applyMixins` (evm-adapter.ts). A receipt batch is
 * sent as a random-sampling proof is, from any registered operational wallet,
 * preferring an idle one, and again from the primary wallet on
 * `ProfileDoesntExist` (`sendFromRegisteredSigner`), with a hook of the
 * caller's before its broadcast.
 *
 * - Every address comes from the Hub by name on each call, through
 *   `resolveContract`'s address memo, which a Hub rotation clears.
 * - Every other write is sent by the wallet `opts.from`, one of this node's
 *   operational wallets, or else the primary one, under the Hub self-heal
 *   retry, as the Publishing Conviction writes are (`pcaWrite`).
 * - A revert is thrown with its custom error decoded (`err.revert`).
 */

import { ethers, type Contract, type JsonRpcProvider } from 'ethers';
import type { TxResult } from './chain-adapter.js';
import { loadAbi } from './evm-adapter-abi.js';
import { enrichEvmError } from './evm-adapter-errors.js';
import { EVMChainAdapterBase, type ScanProvider } from './evm-adapter-base.js';
import { BUYER_SCAN_PAGE_BLOCKS } from './evm-adapter-constants.js';
import type { EvmSigner } from './evm-signer.js';
import type { EVMChainAdapter } from './evm-adapter.js';
import type { ScannedEvent } from './incremental-event-scan.js';
import {
  BUYER_GRANT_TYPES,
  compactSignature,
  grantDomain,
  hashBuyerGrant,
  requestDomain,
  type AccountFundingRequest,
  type BatchState,
  type BuyerGrant,
  type BuyerGrantTerms,
  type BuyerLimits,
  type EpochFunding,
  type EpochTimes,
  type EpochTotals,
  type KnowledgeAssetExtension,
  type MarketplaceChainAdapter,
  type MarketplaceContracts,
  type MarketplaceWriteOptions,
  type NodeEpoch,
  type LandedGroup,
  type ReceiptBatch,
  type ReceiptBatchOutcome,
  type ReceiptBatchSendOptions,
  type ReceiptGroup,
  type ReceiptsLanded,
  type ServiceBudget,
  type ServiceSpending,
  type Subscription,
  type SubscriptionFunding,
  type SubscriptionTopUp,
  type WalletFundingRequest,
  type WindowAllowance,
} from './marketplace.js';

type Log = { address: string; topics: ReadonlyArray<string>; data: string };

const interfaces = new Map<string, ethers.Interface>();

/** The events `name` of `abiName` that `emitter` logged, decoded. */
function eventsOf(logs: ReadonlyArray<Log>, abiName: string, emitter: string, name: string): ethers.Result[] {
  let iface = interfaces.get(abiName);
  if (!iface) interfaces.set(abiName, iface = new ethers.Interface(loadAbi(abiName)));
  const topic = iface.getEvent(name)!.topicHash;
  return logs
    .filter((log) => log.topics[0] === topic && log.address.toLowerCase() === emitter.toLowerCase())
    .map((log) => iface.parseLog({ topics: [...log.topics], data: log.data })!.args);
}

function txResultOf(receipt: ethers.TransactionReceipt): TxResult {
  return { hash: receipt.hash, blockNumber: receipt.blockNumber, txIndex: receipt.index, success: receipt.status === 1 };
}

/** A funding's `SubscriptionFunded` event. Both funding contracts log it, under one signature. */
function subscriptionFundingOf(receipt: ethers.TransactionReceipt): SubscriptionFunding {
  const [funded] = eventsOf(receipt.logs, 'ServiceSubscriptions', receipt.to ?? '', 'SubscriptionFunded');
  if (!funded) throw new Error(`Funding ${receipt.hash} succeeded but logged no SubscriptionFunded`);
  return { ...txResultOf(receipt), subscriptionId: String(funded.subscriptionId), value: BigInt(funded.value), cost: BigInt(funded.cost) };
}

/** A top-up's `SubscriptionToppedUp` event. */
function subscriptionTopUpOf(receipt: ethers.TransactionReceipt): SubscriptionTopUp {
  const [toppedUp] = eventsOf(receipt.logs, 'ServiceSubscriptions', receipt.to ?? '', 'SubscriptionToppedUp');
  if (!toppedUp) throw new Error(`Top-up ${receipt.hash} succeeded but logged no SubscriptionToppedUp`);
  return { ...txResultOf(receipt), value: BigInt(toppedUp.value), cost: BigInt(toppedUp.cost) };
}

/**
 * The batch a `submitReceiptBatch` receipt records: the `ReceiptBatchAccepted`
 * and `ReceiptsLanded` events that `settlement` logged. `null` when no batch
 * was accepted.
 */
export function decodeReceiptBatch(logs: ReadonlyArray<Log>, settlement: string): Omit<ReceiptBatch, keyof TxResult | 'gasUsed'> | null {
  const [accepted] = eventsOf(logs, 'QueryInferenceSettlement', settlement, 'ReceiptBatchAccepted');
  if (!accepted) return null;
  return {
    seller: BigInt(accepted.seller),
    batchDigest: String(accepted.batchDigest),
    itemCount: Number(accepted.itemCount),
    value: BigInt(accepted.value),
    counted: BigInt(accepted.counted),
    stakeFactor18: BigInt(accepted.stakeFactor18),
    groups: eventsOf(logs, 'QueryInferenceSettlement', settlement, 'ReceiptsLanded').map(landedOf),
  };
}

function landedOf(g: ethers.Result): ReceiptsLanded {
  return {
    subscriptionId: String(g.subscriptionId),
    budgetIndex: Number(g.budgetIndex),
    seller: BigInt(g.seller),
    itemCount: Number(g.itemCount),
    value: BigInt(g.value),
    counted: BigInt(g.counted),
    stakeFactor18: BigInt(g.stakeFactor18),
    groupDigest: String(g.groupDigest),
  };
}

/** The batch a successful receipt of `QueryInferenceSettlement` records; `null` when it logged none. */
function landedBatchOf(receipt: ethers.TransactionReceipt): ReceiptBatch | null {
  const batch = decodeReceiptBatch(receipt.logs, receipt.to ?? '');
  return batch ? { ...txResultOf(receipt), gasUsed: receipt.gasUsed, ...batch } : null;
}

function budgetArgs(budgets: readonly ServiceBudget[]): ServiceBudget[] {
  return budgets.map(({ serviceId, serviceClass, value, maxPricePerUnit }) => ({ serviceId, serviceClass, value, maxPricePerUnit }));
}

function requireToken(token: Contract | undefined): Contract {
  if (!token) throw new Error('Token contract not available on this chain');
  return token;
}

export class MarketplaceMethods extends EVMChainAdapterBase {
  /** The marketplace: the adapter itself, whose mixins implement all of it (evm-adapter.ts). */
  marketplaceChain(this: EVMChainAdapter): MarketplaceChainAdapter {
    return this;
  }

  async getMarketplaceContracts(): Promise<MarketplaceContracts> {
    await this.init();
    const contracts = await Promise.all([
      this.resolveContract('ServiceSubscriptions'),
      this.resolveContract('ServiceSubscriptionsWallet'),
      this.resolveContract('ServiceSubscriptionsStorage'),
      this.resolveContract('QueryInferenceSettlement'),
      this.resolveContract('QueryInferenceStorage'),
    ]);
    const [ss, ssw, sss, qs, qis] = await Promise.all(contracts.map(async (c) => ethers.getAddress(await c.getAddress())));
    const chainId = await this.getEvmChainId();
    return {
      chainId: Number(chainId),
      serviceSubscriptions: ss!,
      serviceSubscriptionsWallet: ssw!,
      serviceSubscriptionsStorage: sss!,
      queryInferenceSettlement: qs!,
      queryInferenceStorage: qis!,
      requestDomain: requestDomain(chainId, qis!),
      grantDomain: grantDomain(chainId, ss!),
    };
  }

  async getEpochTimes(): Promise<EpochTimes> {
    await this.init();
    const chronos = await this.resolveContract('Chronos');
    const block = await this.readTipProvider('marketplace epoch times', (p) => p.getBlock('latest'));
    if (!block) throw new Error('No latest block from any RPC endpoint');
    const now = Number(block.timestamp);
    const epoch = Number(await this.readContract(chronos, 'chronos.epochAtTimestamp', 'epochAtTimestamp', now));
    const [startsAt, endsAt] = await Promise.all([
      this.readContract(chronos, 'chronos.timestampForEpoch', 'timestampForEpoch', epoch),
      this.readContract(chronos, 'chronos.timestampForEpoch', 'timestampForEpoch', epoch + 1),
    ]);
    return { epoch, startsAt: Number(startsAt), endsAt: Number(endsAt), now };
  }

  // ------------------------------------------------- ServiceSubscriptions

  async setServiceSpending(accountId: bigint, enabled: boolean, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    return txResultOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptions'), 'setServiceSpending', [accountId, enabled], opts,
    ));
  }

  async addBuyer(
    terms: BuyerGrantTerms,
    ownerSignature: string,
    buyerSignature: string,
    opts?: MarketplaceWriteOptions,
  ): Promise<TxResult> {
    const t = { accountId: terms.accountId, buyer: terms.buyer, maxCostPerEpoch: terms.maxCostPerEpoch, expiresAt: terms.expiresAt, nonce: terms.nonce };
    return txResultOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptions'), 'addBuyer', [t, ownerSignature, buyerSignature], opts,
    ));
  }

  async removeBuyer(accountId: bigint, buyer: string, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    return txResultOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptions'), 'removeBuyer', [accountId, buyer], opts,
    ));
  }

  async setBuyerLimits(accountId: bigint, buyer: string, limits: BuyerLimits, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    const l = { maxCostPerEpoch: limits.maxCostPerEpoch, expiresAt: limits.expiresAt };
    return txResultOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptions'), 'setBuyerLimits', [accountId, buyer, l], opts,
    ));
  }

  async advanceGrantNonce(accountId: bigint, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    return txResultOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptions'), 'advanceGrantNonce', [accountId], opts,
    ));
  }

  async signBuyerGrant(terms: BuyerGrantTerms): Promise<{ digest: string; signature: string }> {
    const signer = this.findSignerByAddress(terms.buyer);
    if (!signer) throw new Error(`Cannot consent as ${terms.buyer}: it is not one of this node's operational wallets`);
    await this.init();
    const ss = await this.resolveContract('ServiceSubscriptions');
    const domain = grantDomain(await this.getEvmChainId(), await ss.getAddress());
    const t = { accountId: terms.accountId, buyer: terms.buyer, maxCostPerEpoch: terms.maxCostPerEpoch, expiresAt: terms.expiresAt, nonce: terms.nonce };
    const signature = compactSignature(await signer.signTypedData(domain, BUYER_GRANT_TYPES, t));
    return { digest: hashBuyerGrant(domain, t), signature };
  }

  async fundFromAccount(request: AccountFundingRequest, opts?: MarketplaceWriteOptions): Promise<SubscriptionFunding> {
    const r = {
      accountId: request.accountId,
      epoch: request.epoch,
      sessionKey: request.sessionKey,
      planDigest: request.planDigest,
      budgets: budgetArgs(request.budgets),
    };
    return subscriptionFundingOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptions'), 'fundFromAccount', [r], opts,
    ));
  }

  async topUpFromAccount(
    subscriptionId: string,
    additions: ServiceBudget[],
    planDigest: string,
    opts?: MarketplaceWriteOptions,
  ): Promise<SubscriptionTopUp> {
    return subscriptionTopUpOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptions'), 'topUpFromAccount', [subscriptionId, budgetArgs(additions), planDigest], opts,
    ));
  }

  async previewCost(accountId: bigint, value: bigint): Promise<{ cost: bigint; discountBps: number }> {
    await this.init();
    const ss = await this.resolveContract('ServiceSubscriptions');
    const raw = await this.readContract(ss, 'serviceSubscriptions.previewCost', 'previewCost', accountId, value);
    return { cost: BigInt(raw.cost), discountBps: Number(raw.discountBps) };
  }

  async currentWindowAllowance(accountId: bigint): Promise<WindowAllowance> {
    await this.init();
    const ss = await this.resolveContract('ServiceSubscriptions');
    const raw = await this.readContract(ss, 'serviceSubscriptions.currentWindowAllowance', 'currentWindowAllowance', accountId);
    return {
      window: Number(raw.window),
      baseRemaining: BigInt(raw.baseRemaining),
      topUpBuffer: BigInt(raw.topUpBuffer),
      expired: Boolean(raw.expired),
    };
  }

  // ------------------------------------------- ServiceSubscriptionsWallet

  async fundFromWallet(request: WalletFundingRequest, opts?: MarketplaceWriteOptions): Promise<SubscriptionFunding> {
    const r = {
      epoch: request.epoch,
      sessionKey: request.sessionKey,
      planDigest: request.planDigest,
      budgets: budgetArgs(request.budgets),
    };
    return subscriptionFundingOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptionsWallet'), 'fundFromWallet', [r], opts,
    ));
  }

  async topUpFromWallet(
    subscriptionId: string,
    additions: ServiceBudget[],
    planDigest: string,
    opts?: MarketplaceWriteOptions,
  ): Promise<SubscriptionTopUp> {
    return subscriptionTopUpOf(await this.marketplaceSend(
      () => this.resolveContract('ServiceSubscriptionsWallet'), 'topUpFromWallet', [subscriptionId, budgetArgs(additions), planDigest], opts,
    ));
  }

  async approveServiceSubscriptionsWallet(amount: bigint, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    await this.init();
    const spender = await (await this.resolveContract('ServiceSubscriptionsWallet')).getAddress();
    return txResultOf(await this.marketplaceSend(
      async () => requireToken(this.contracts.token), 'approve', [spender, amount], opts,
    ));
  }

  async getServiceSubscriptionsWalletAllowance(owner: string): Promise<bigint> {
    await this.init();
    const spender = await (await this.resolveContract('ServiceSubscriptionsWallet')).getAddress();
    return BigInt(await this.readContract(requireToken(this.contracts.token), 'token.allowance', 'allowance', owner, spender));
  }

  // ------------------------------------------ ServiceSubscriptionsStorage

  async getSubscription(subscriptionId: string): Promise<Subscription | null> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    const s = await this.readContract(sss, 'serviceSubscriptionsStorage.getSubscription', 'getSubscription', subscriptionId);
    if (Number(s.startsAt) === 0) return null;
    return {
      subscriptionId,
      accountId: BigInt(s.accountId),
      buyer: ethers.getAddress(s.buyer),
      grantNonce: BigInt(s.grantNonce),
      sessionKey: ethers.getAddress(s.sessionKey),
      epoch: Number(s.epoch),
      planDigest: String(s.planDigest),
      startsAt: Number(s.startsAt),
      endsAt: Number(s.endsAt),
      fundedEpoch: Number(s.fundedEpoch),
      fundedWindow: Number(s.fundedWindow),
      discountBps: Number(s.discountBps),
      budgetCount: Number(s.budgetCount),
      value: BigInt(s.value),
      cost: BigInt(s.cost),
      spentFromWindow: BigInt(s.spentFromWindow),
      spentFromTopUp: BigInt(s.spentFromTopUp),
    };
  }

  async getBudgets(subscriptionId: string): Promise<ServiceBudget[]> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    const raw = await this.readContract(sss, 'serviceSubscriptionsStorage.getBudgets', 'getBudgets', subscriptionId);
    return Array.from(raw as ArrayLike<ethers.Result>, (b) => ({
      serviceId: String(b.serviceId),
      serviceClass: Number(b.serviceClass),
      value: BigInt(b.value),
      maxPricePerUnit: BigInt(b.maxPricePerUnit),
    }));
  }

  async subscriptionExists(subscriptionId: string): Promise<boolean> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    return Boolean(await this.readContract(sss, 'serviceSubscriptionsStorage.subscriptionExists', 'subscriptionExists', subscriptionId));
  }

  async getGrant(accountId: bigint, buyer: string): Promise<BuyerGrant | null> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    const g = await this.readContract(sss, 'serviceSubscriptionsStorage.getGrant', 'getGrant', accountId, buyer);
    if (Number(g.grantedAt) === 0) return null;
    return {
      maxCostPerEpoch: BigInt(g.maxCostPerEpoch),
      grantedAt: Number(g.grantedAt),
      expiresAt: Number(g.expiresAt),
      revokedAt: Number(g.revokedAt),
      nonce: BigInt(g.nonce),
      owner: ethers.getAddress(g.owner),
    };
  }

  async grantEnd(accountId: bigint, buyer: string, nonce: bigint): Promise<number> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    return Number(await this.readContract(sss, 'serviceSubscriptionsStorage.grantEnd', 'grantEnd', accountId, buyer, nonce));
  }

  async grantNonce(accountId: bigint): Promise<bigint> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    return BigInt(await this.readContract(sss, 'serviceSubscriptionsStorage.grantNonce', 'grantNonce', accountId));
  }

  async getServiceSpending(accountId: bigint): Promise<ServiceSpending> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    const s = await this.readContract(sss, 'serviceSubscriptionsStorage.getServiceSpending', 'getServiceSpending', accountId);
    return { enabledAt: Number(s.enabledAt), owner: ethers.getAddress(s.owner) };
  }

  async maxBudgetsPerSubscription(): Promise<number> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    return Number(await this.readContract(sss, 'serviceSubscriptionsStorage.maxBudgetsPerSubscription', 'maxBudgetsPerSubscription'));
  }

  async getAccountBuyers(accountId: bigint): Promise<string[]> {
    await this.init();
    const sss = await this.resolveContract('ServiceSubscriptionsStorage');
    const count = Number(await this.readContract(sss, 'serviceSubscriptionsStorage.buyerCount', 'buyerCount', accountId));
    const buyers: string[] = [];
    for (let i = 0; i < count; i++) {
      buyers.push(ethers.getAddress(await this.readContract(sss, 'serviceSubscriptionsStorage.buyerAt', 'buyerAt', accountId, i)));
    }
    return buyers;
  }

  /**
   * Read in pages from the deployment of the Hub's `ServiceSubscriptions` to the head. The first read
   * for a buyer covers the whole range; later reads cover only the blocks since the last one (and a
   * reorg tail), and overlapping reads share one scan.
   */
  async listBuyerAccounts(buyer: string): Promise<bigint[]> {
    await this.init();
    const ss = await this.resolveContract('ServiceSubscriptions');
    const address = await ss.getAddress();
    const label = 'listBuyerAccounts';
    const filter = ss.filters.BuyerAdded(null, buyer);
    const accounts = await this.buyerAccountScan.read(
      `${address.toLowerCase()}:${buyer.toLowerCase()}`,
      async (progress) => {
        // Once the scan has read from its anchor, a later read only needs the head. That also keeps a deploy-block
        // search that fell back to genesis (which is not cached) from running again on every read.
        let anchor: number;
        let head: number;
        let scanProviders: ReadonlyArray<ScanProvider>;
        if (progress) {
          ({ head, scanProviders } = await this.resolveLogScanHead(label));
          anchor = progress.anchor;
        } else {
          const resolved = await this.resolveContractDeployBlock(address, label, 'ServiceSubscriptions');
          ({ head, scanProviders } = resolved);
          anchor = resolved.fromBlock;
        }
        // The page reader of this read, on the backends it resolved, keeping to the one that last answered.
        const connected = new Map<JsonRpcProvider, Contract>();
        let preferred: JsonRpcProvider | undefined;
        const readPage = async (lo: number, hi: number): Promise<ScannedEvent<bigint>[]> => {
          const page = await this.queryEventLogsPage(ss, filter, lo, hi, scanProviders, connected, `${label} BuyerAdded`, preferred);
          preferred = page.provider;
          // topics: the event, the indexed accountId, the indexed buyer.
          return page.logs.map((log) => ({ item: BigInt(log.topics[1]!), block: log.blockNumber }));
        };
        return { anchor, head, readPage };
      },
      (accountId) => accountId.toString(),
    );
    return [...accounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // --------------------------------------------- QueryInferenceSettlement

  /**
   * Sent as a random-sampling proof is: from a registered operational wallet,
   * preferring an idle one, and from the primary when that wallet turns out
   * unregistered. Prepared (simulated) and signed first, so a fault rejects
   * before anything is sent; then `opts.onBroadcast`, then the broadcast. A
   * stuck batch is sped up at its nonce, each replacement after
   * `opts.onBeforeReplacementBroadcast`.
   */
  async submitReceiptBatch(groups: ReceiptGroup[], opts: ReceiptBatchSendOptions = {}): Promise<ReceiptBatch> {
    await this.init();
    const arg = groups.map(({ subscriptionId, budgetIndex, minCounted, items }) => ({ subscriptionId, budgetIndex, minCounted, items }));
    const sendFrom = async (signer: EvmSigner) => {
      const qs = await this.resolveContract('QueryInferenceSettlement');
      let signedTx = '';
      return this.dispatchSerializedV10Write(
        signer,
        'receipt batch',
        opts.onBroadcast ? (signal) => opts.onBroadcast!({ ...signal, wallet: signer.address, signedTx }) : undefined,
        async () => {
          const signed = await this.signPreparedTransaction(
            await this.prepareAcrossProviders(qs, 'submitReceiptBatch', [arg], signer, 'marketplace submitReceiptBatch'),
          );
          signedTx = signed.signedTx;
          return signed;
        },
        (hash) => { throw new Error(`Receipt batch ${hash} was sent but has no receipt`); },
        undefined,
        opts.onBeforeReplacementBroadcast,
      );
    };
    const receipt = await this.withHubStaleRetryAny(async () => {
      try {
        return await this.sendFromRegisteredSigner(sendFrom);
      } catch (err) {
        enrichEvmError(err);
        throw err;
      }
    });
    const batch = landedBatchOf(receipt);
    if (!batch) throw new Error(`Receipt batch ${receipt.hash} succeeded but logged no ReceiptBatchAccepted`);
    return batch;
  }

  /**
   * The exact signed bytes, through the write endpoints: one already known is no error. Sent in the lane of the
   * wallet that signed them, as its other writes are, so never between one of those reading its nonce and sending,
   * and only while that wallet's pending nonce, read where its writes read theirs, has not passed the batch's.
   */
  async rebroadcastReceiptBatch(signedTx: string): Promise<void> {
    await this.init();
    const tx = ethers.Transaction.from(signedTx);
    const from = tx.from;
    const send = async () => {
      // A pending nonce past the batch's: another transaction holds its nonce, or the batch is out already. Sent now,
      // it could only be refused, or replace that transaction; its receipts resolve by its nonce either way.
      if (from && (await this.rpcFailover.pendingNonce(from, 'marketplace wallet pending nonce')) > tx.nonce) return;
      await this.broadcastSignedTransactionWithFailover(signedTx, tx.hash!, 'marketplace receipt batch rebroadcast');
    };
    // A wallet that is not one of this node's has no lane here to share.
    const signer = from ? this.findSignerByAddress(from) : undefined;
    await (signer ? this.withSerializedSignerWrite(signer, send, 'receipt batch rebroadcast') : send());
  }

  async getReceiptBatchOutcome(txHash: string): Promise<ReceiptBatchOutcome> {
    await this.init();
    const receipt = await this.getTransactionReceiptWithFailover(txHash);
    if (!receipt) return null;
    const batch = receipt.status === 1 ? landedBatchOf(receipt) : null;
    return batch ? { landed: batch } : { reverted: true };
  }

  /** Read in pages; nothing is cached. */
  async listReceiptsLanded(subscriptionId: string, fromBlock = 0): Promise<{ groups: LandedGroup[]; toBlock: number }> {
    await this.init();
    const qs = await this.resolveContract('QueryInferenceSettlement');
    const address = await qs.getAddress();
    const label = 'listReceiptsLanded';
    const deployed = await this.resolveContractDeployBlock(address, label, 'QueryInferenceSettlement');
    const filter = qs.filters.ReceiptsLanded(subscriptionId);
    const connected = new Map<JsonRpcProvider, Contract>();
    const groups: LandedGroup[] = [];
    let preferred: JsonRpcProvider | undefined;
    for (let lo = Math.max(fromBlock, deployed.fromBlock); lo <= deployed.head; lo += BUYER_SCAN_PAGE_BLOCKS) {
      const page = await this.queryEventLogsPage(
        qs, filter, lo, Math.min(lo + BUYER_SCAN_PAGE_BLOCKS - 1, deployed.head), deployed.scanProviders, connected, `${label} ReceiptsLanded`, preferred,
      );
      preferred = page.provider;
      for (const log of page.logs) {
        for (const g of eventsOf([log], 'QueryInferenceSettlement', address, 'ReceiptsLanded')) {
          groups.push({ ...landedOf(g), txHash: log.transactionHash, blockNumber: log.blockNumber });
        }
      }
    }
    return { groups, toBlock: deployed.head };
  }

  async getMinedNonce(address: string): Promise<number> {
    await this.init();
    return this.readTipProvider('marketplace wallet nonce', (p) => p.getTransactionCount(address, 'latest'));
  }

  async getBaseFee(): Promise<bigint | null> {
    await this.init();
    const block = await this.readTipProvider('marketplace base fee', (p) => p.getBlock('latest'));
    return block?.baseFeePerGas ?? null;
  }

  // --------------------------------------------- KnowledgeAssetsLifecycle

  /**
   * Paid at `_validateTokenAmount`'s rate for an extension: ask × bytes × epochs / 1024, and never 0. Sent
   * from `opts.from`, or else from the wallet a publish would pay from, chosen as a publish's is: among the
   * operational wallets, one with gas and the TRAC the extension costs, the best-funded when none has.
   */
  async extendKnowledgeAssetLifetime(kaId: bigint, epochs: number, opts?: MarketplaceWriteOptions): Promise<KnowledgeAssetExtension> {
    await this.init();
    const asked = opts?.from === undefined ? undefined : this.findSignerByAddress(opts.from);
    if (opts?.from !== undefined && !asked) throw new Error(`Cannot send from ${opts.from}: it is not one of this node's operational wallets`);
    const { knowledgeAssetStorage: kas, askStorage } = this.contracts;
    if (!kas || !askStorage) throw new Error('DKGKnowledgeAssets or AskStorage not available: cannot extend a Knowledge Asset');
    const { byteSize } = await this.readKnowledgeAssetUpdateContext(kas, kaId);
    const ask = BigInt(await this.readContract(askStorage, 'askStorage.getStakeWeightedAverageAsk', 'getStakeWeightedAverageAsk'));
    const quoted = (ask * byteSize * BigInt(epochs)) / 1024n;
    const tokenAmount = quoted > 0n ? quoted : 1n;
    // Any wallet may extend any asset, and pays from its own TRAC: no Conviction Account covers an extension.
    const signer = asked ?? await this.selectSigner({
      txClass: 'rotatable-funded',
      funding: {
        kind: 'native+trac',
        nativeFloorWei: this.minPublisherNativeWei,
        tracFloorWei: this.minPublisherTracWei,
        requiredTracWei: tokenAmount,
        pca: { kind: 'none' },
      },
    });
    const lifecycle = () => this.resolveContract('KnowledgeAssetsLifecycle');
    await this.ensureV10ApproveTrac(signer, await (await lifecycle()).getAddress(), tokenAmount, 'extend knowledge asset');
    const receipt = await this.marketplaceSend(lifecycle, 'extendKnowledgeAssetLifetime', [kaId, epochs, tokenAmount], { from: signer.address });
    const { endEpoch } = await this.readKnowledgeAssetUpdateContext(kas, kaId);
    return { ...txResultOf(receipt), tokenAmount, endEpoch: Number(endEpoch) };
  }


  async budgetLeft(subscriptionId: string, budgetIndex: number): Promise<bigint> {
    await this.init();
    const qs = await this.resolveContract('QueryInferenceSettlement');
    return BigInt(await this.readContract(qs, 'queryInferenceSettlement.budgetLeft', 'budgetLeft', subscriptionId, budgetIndex));
  }

  async stakeFactor(identityId: bigint): Promise<bigint> {
    await this.init();
    const qs = await this.resolveContract('QueryInferenceSettlement');
    return BigInt(await this.readContract(qs, 'queryInferenceSettlement.stakeFactor', 'stakeFactor', identityId));
  }

  async epochPool(epoch: number): Promise<bigint> {
    await this.init();
    const qs = await this.resolveContract('QueryInferenceSettlement');
    return BigInt(await this.readContract(qs, 'queryInferenceSettlement.epochPool', 'epochPool', epoch));
  }

  async queryInferenceGross(epoch: number, identityId: bigint): Promise<bigint> {
    await this.init();
    const qs = await this.resolveContract('QueryInferenceSettlement');
    return BigInt(await this.readContract(qs, 'queryInferenceSettlement.queryInferenceGross', 'queryInferenceGross', epoch, identityId));
  }

  // ------------------------------------------------ QueryInferenceStorage

  async batchState(): Promise<BatchState> {
    await this.init();
    const qis = await this.resolveContract('QueryInferenceStorage');
    const s = await this.readContract(qis, 'queryInferenceStorage.batchState', 'batchState');
    return { activationEpoch: Number(s.activation), paused: Boolean(s.isPaused), maxGroups: Number(s.maxGroups), maxItems: Number(s.maxItems) };
  }

  async nonceWord(subscriptionId: string, identityId: bigint, word: bigint): Promise<bigint> {
    await this.init();
    const qis = await this.resolveContract('QueryInferenceStorage');
    return BigInt(await this.readContract(qis, 'queryInferenceStorage.nonceWord', 'nonceWord', subscriptionId, identityId, word));
  }

  async budgetUsed(subscriptionId: string, budgetIndex: number): Promise<bigint> {
    await this.init();
    const qis = await this.resolveContract('QueryInferenceStorage');
    return BigInt(await this.readContract(qis, 'queryInferenceStorage.budgetUsed', 'budgetUsed', subscriptionId, budgetIndex));
  }

  async fundingIn(epoch: number): Promise<EpochFunding> {
    await this.init();
    const qis = await this.resolveContract('QueryInferenceStorage');
    const f = await this.readContract(qis, 'queryInferenceStorage.fundingIn', 'fundingIn', epoch);
    return { wallet: BigInt(f.wallet), account: BigInt(f.account) };
  }

  async getEpochTotals(epoch: number): Promise<EpochTotals> {
    await this.init();
    const qis = await this.resolveContract('QueryInferenceStorage');
    const t = await this.readContract(qis, 'queryInferenceStorage.getEpochTotals', 'getEpochTotals', epoch);
    return { totalServed: BigInt(t.totalServed), totalWeighted: BigInt(t.totalWeighted), lambdaBps: Number(t.lambdaBps) };
  }

  async getNodeEpoch(identityId: bigint, epoch: number): Promise<NodeEpoch> {
    await this.init();
    const qis = await this.resolveContract('QueryInferenceStorage');
    const n = await this.readContract(qis, 'queryInferenceStorage.getNodeEpoch', 'getNodeEpoch', identityId, epoch);
    return { servedValue: BigInt(n.servedValue), weightedValue: BigInt(n.weightedValue) };
  }

  // ------------------------- ShardingTableStorage, RandomSamplingStorage

  async getShardingTableNodeId(identityId: bigint): Promise<string | null> {
    await this.init();
    const sts = await this.resolveContract('ShardingTableStorage');
    const node = await this.readContract(sts, 'shardingTableStorage.getNode', 'getNode', identityId);
    return BigInt(node.identityId) === 0n ? null : ethers.hexlify(node.nodeId);
  }

  async getNodeEpochScore(epoch: number, identityId: bigint): Promise<bigint> {
    await this.init();
    const rss = await this.resolveContract('RandomSamplingStorage');
    return BigInt(await this.readContract(rss, 'randomSamplingStorage.getNodeEpochScore', 'getNodeEpochScore', epoch, identityId));
  }

  async profileExists(identityId: bigint): Promise<boolean> {
    await this.init();
    const profiles = await this.resolveContract('ProfileStorage');
    return Boolean(await this.readContract(profiles, 'profileStorage.profileExists', 'profileExists', identityId));
  }

  async getNodeStake(identityId: bigint): Promise<bigint> {
    await this.init();
    const stakes = await this.resolveContract('ConvictionStakingStorage');
    return BigInt(await this.readContract(stakes, 'convictionStakingStorage.getNodeStakeV10', 'getNodeStakeV10', identityId));
  }

  async getMinimumStake(): Promise<bigint> {
    await this.init();
    const parameters = await this.resolveContract('ParametersStorage');
    return BigInt(await this.readContract(parameters, 'parametersStorage.minimumStake', 'minimumStake'));
  }

  // ------------------------------------------ ParametersStorage, the Token

  async getProtocolTreasury(): Promise<string> {
    await this.init();
    const parameters = await this.resolveContract('ParametersStorage');
    return ethers.getAddress(await this.readContract(parameters, 'parametersStorage.protocolTreasury', 'protocolTreasury'));
  }

  async getWalletBalances(address: string): Promise<{ eth: bigint; trac: bigint }> {
    await this.init();
    const [eth, trac] = await Promise.all([
      this.readProvider('marketplace wallet balance', (p) => p.getBalance(address)),
      this.readContract(requireToken(this.contracts.token), 'token.balanceOf', 'balanceOf', address),
    ]);
    return { eth: BigInt(eth), trac: BigInt(trac) };
  }

  /**
   * Send `method` from `opts.from`, or the primary wallet, under the Hub
   * self-heal retry; `contract` resolves the contract again for the retry.
   */
  protected async marketplaceSend(
    contract: () => Promise<Contract>,
    method: string,
    args: readonly unknown[],
    opts: MarketplaceWriteOptions | undefined,
  ): Promise<ethers.TransactionReceipt> {
    await this.init();
    const signer = opts?.from === undefined ? this.signer : this.findSignerByAddress(opts.from);
    if (!signer) throw new Error(`Cannot send from ${opts?.from}: it is not one of this node's operational wallets`);
    return this.withHubStaleRetryAny(async () => {
      try {
        return await this.sendContractTransaction(await contract(), method, args, signer, `marketplace ${method}`);
      } catch (err) {
        enrichEvmError(err);
        throw err;
      }
    });
  }
}
