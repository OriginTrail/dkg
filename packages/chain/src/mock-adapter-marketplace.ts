// SPDX-License-Identifier: Apache-2.0

/**
 * The NeuroSymbolic Marketplace (OT-RFC-27) on the mock adapter: an in-memory
 * model of the marketplace contracts, the base class of `MockChainAdapter`,
 * which provides its accounts, epochs, identity and signer. A refusal is
 * thrown as the contract's revert, so `err.revert` names the same custom error
 * with the same arguments on either adapter.
 *
 * The model:
 *   - Time. Epochs are `getCurrentEpoch()`'s, 30 days each, the first one
 *     starting when the adapter is made; the chain's time is the wall clock,
 *     and never before the current epoch's start.
 *   - Accounts are the mock's Publishing Conviction accounts. They never
 *     expire, are never scheduled in full, and each has one billing window:
 *     its base allowance and then its top-up buffer pay for its subscriptions.
 *   - Wallet fundings move no TRAC: the mock checks and spends only the
 *     allowance granted to `ServiceSubscriptionsWallet`.
 *   - Receipt batches are checked as `QueryInferenceSettlement` checks them,
 *     signatures included, but every registered node is a Core Node with a
 *     node score, and every stake factor is 1.
 *   - Every wallet holds a million TRAC and a hundred ETH, and no protocol
 *     treasury is wired.
 */
import { ethers } from 'ethers';
import type { IdentityReadOptions, TxResult, V10PublishingConvictionAccountInfo } from './chain-adapter.js';
import { enrichEvmError, getErrorInterface } from './evm-adapter-errors.js';
import {
  BUYER_GRANT_TYPES,
  SERVICE_CLASS_INFERENCE,
  SERVICE_CLASS_QUERY,
  compactSignature,
  grantDomain,
  hashBuyerGrant,
  hashQueryInferenceReceipt,
  hashServiceRequest,
  receiptsDigest,
  recoverSigner,
  requestDomain,
  subscriptionIdOf,
  type AccountFundingRequest,
  type BatchState,
  type BuyerGrant,
  type BuyerGrantTerms,
  type BuyerLimits,
  type EpochFunding,
  type EpochTimes,
  type EpochTotals,
  type MarketplaceChain,
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

const MOCK_EPOCH_SECONDS = 30 * 86_400;
const MAX_BUDGETS = 16;
const BATCH_STATE: BatchState = { activationEpoch: 1, paused: false, maxGroups: 32, maxItems: 256 };
const LAMBDA_BPS = 5_000;
/** The stake the mock gives every node with an identity, and the minimum it asks: the same. */
const MOCK_NODE_STAKE = 50_000n * 10n ** 18n;
const WALLET_BALANCES = { eth: 100n * 10n ** 18n, trac: 1_000_000n * 10n ** 18n };
const BPS = 10_000n;
const SCALE18 = 10n ** 18n;
const UINT96_MAX = (1n << 96n) - 1n;

const ADDRESSES = {
  serviceSubscriptions: ethers.getAddress('0x' + '51'.repeat(20)),
  serviceSubscriptionsWallet: ethers.getAddress('0x' + '52'.repeat(20)),
  serviceSubscriptionsStorage: ethers.getAddress('0x' + '53'.repeat(20)),
  queryInferenceSettlement: ethers.getAddress('0x' + '54'.repeat(20)),
  queryInferenceStorage: ethers.getAddress('0x' + '55'.repeat(20)),
};

/** `QueryInferenceSettlement.Fault` codes the mock refuses with. */
const FAULT = {
  UnknownSubscription: 1, UnknownBudget: 2, OutsideEpoch: 3, EmptyGroup: 4, BelowMinCounted: 5, BadSignature: 6,
  InactiveGrant: 7, DuplicateNonce: 8, OutsideTime: 9, PriceOutOfRange: 10, BadArithmetic: 11, ZeroResultCommitment: 12,
} as const;

/** Throw the contracts' custom error `name(args)`, as the EVM adapter throws a revert. */
function revert(name: string, ...args: unknown[]): never {
  const data = getErrorInterface().encodeErrorResult(name, args);
  const err = Object.assign(new Error(`Mock: execution reverted (unknown custom error) (data="${data}")`), { data });
  enrichEvmError(err);
  throw err;
}

const key = (...parts: unknown[]): string => parts.map((p) => String(p).toLowerCase()).join('/');

function discounted(value: bigint, discountBps: number): bigint {
  const cost = (value * (BPS - BigInt(discountBps))) / BPS;
  return cost === 0n && value > 0n ? 1n : cost;
}

function endOf(grant: BuyerGrant): number {
  return grant.revokedAt !== 0 && grant.revokedAt < grant.expiresAt ? grant.revokedAt : grant.expiresAt;
}

/** A new budget's terms: a known class, a non-zero value and a non-zero price cap. */
function requireNewBudgetTerms(b: ServiceBudget): void {
  if (b.serviceClass !== SERVICE_CLASS_INFERENCE && b.serviceClass !== SERVICE_CLASS_QUERY) revert('InvalidFundingRequest', 'serviceClass');
  if (b.value === 0n) revert('InvalidFundingRequest', 'budgetValue');
  if (b.maxPricePerUnit === 0n) revert('InvalidFundingRequest', 'maxPricePerUnit');
}

/** Budget `i` comes after budget `i - 1`: the ids strictly increase. */
function requireInOrder(budgets: readonly ServiceBudget[], i: number): void {
  if (i > 0 && BigInt(budgets[i]!.serviceId) <= BigInt(budgets[i - 1]!.serviceId)) revert('InvalidFundingRequest', 'budgetOrder');
}

export abstract class MockMarketplaceMethods implements MarketplaceChain {
  abstract readonly signerAddress: string;
  abstract getCurrentEpoch(): Promise<bigint>;
  abstract getIdentityId(options?: IdentityReadOptions): Promise<bigint>;
  abstract getEvmChainId(): Promise<bigint>;
  abstract getPublishingConvictionAccountInfo(accountId: bigint): Promise<V10PublishingConvictionAccountInfo | null>;
  abstract signTypedDataAs(
    address: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string>;
  protected abstract txResult(success: boolean): TxResult;

  private readonly marketplaceGenesis = Math.floor(Date.now() / 1000);
  private readonly marketplace = {
    spending: new Map<bigint, ServiceSpending>(),
    grantNonces: new Map<bigint, bigint>(),
    grants: new Map<string, BuyerGrant>(),
    /** accountId => every buyer ever granted on it, in grant order, each once. */
    buyers: new Map<bigint, string[]>(),
    replacedGrantEnds: new Map<string, number>(),
    subscriptions: new Map<string, Subscription>(),
    budgets: new Map<string, ServiceBudget[]>(),
    budgetUsed: new Map<string, bigint>(),
    usedNonces: new Map<string, Set<bigint>>(),
    funding: new Map<number, EpochFunding>(),
    totals: new Map<number, EpochTotals>(),
    nodeEpochs: new Map<string, NodeEpoch>(),
    allowances: new Map<string, bigint>(),
    /** accountId => what services spent of its base allowance and of its top-up buffer. */
    spent: new Map<bigint, { window: bigint; topUp: bigint }>(),
    /** transaction hash => the batch it landed. */
    batches: new Map<string, ReceiptBatch>(),
    /** signed transaction => the batch, hash and nonce it was signed with; and the hashes mined as reverted. */
    signed: new Map<string, { groups: ReceiptGroup[]; hash: string; nonce: number }>(),
    reverted: new Set<string>(),
    /** wallet => how many of its batches were sent: its next nonce. */
    sent: new Map<string, number>(),
  };
  /** The base fee the mock's latest block reports, in wei. */
  mockBaseFee: bigint | null = 10n ** 6n;

  async getMarketplaceContracts(): Promise<MarketplaceContracts> {
    const chainId = await this.getEvmChainId();
    return {
      chainId: Number(chainId),
      ...ADDRESSES,
      requestDomain: requestDomain(chainId, ADDRESSES.queryInferenceStorage),
      grantDomain: grantDomain(chainId, ADDRESSES.serviceSubscriptions),
    };
  }

  async getEpochTimes(): Promise<EpochTimes> {
    const epoch = Number(await this.getCurrentEpoch());
    const startsAt = this.epochStart(epoch);
    return { epoch, startsAt, endsAt: startsAt + MOCK_EPOCH_SECONDS, now: Math.max(Math.floor(Date.now() / 1000), startsAt) };
  }

  // ------------------------------------------------- ServiceSubscriptions

  async setServiceSpending(accountId: bigint, enabled: boolean, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    const sender = this.senderOf(opts);
    await this.requireOwner(accountId, sender);
    const current = this.marketplace.spending.get(accountId);
    const isOn = current !== undefined && current.owner === sender;
    if (isOn === enabled) revert('ServiceSpendingUnchanged', accountId, enabled);
    if (enabled) this.marketplace.spending.set(accountId, { enabledAt: (await this.getEpochTimes()).now, owner: sender });
    else this.marketplace.spending.delete(accountId);
    return this.txResult(true);
  }

  async addBuyer(terms: BuyerGrantTerms, ownerSignature: string, buyerSignature: string, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    const sender = this.senderOf(opts);
    const owner = await this.requireSpendingOn(terms.accountId);
    if (terms.buyer === ethers.ZeroAddress) revert('InvalidBuyerTerms', 'buyer');
    const now = (await this.getEpochTimes()).now;
    this.requireValidLimits(terms, now);
    const expected = this.marketplace.grantNonces.get(terms.accountId) ?? 0n;
    if (terms.nonce !== expected) revert('InvalidGrantNonce', terms.accountId, expected, terms.nonce);
    const domain = grantDomain(await this.getEvmChainId(), ADDRESSES.serviceSubscriptions);
    const digest = hashBuyerGrant(domain, terms);
    const buyer = ethers.getAddress(terms.buyer);
    requireConsent(sender, owner, digest, ownerSignature);
    requireConsent(sender, buyer, digest, buyerSignature);
    const replaced = this.marketplace.grants.get(key(terms.accountId, buyer));
    if (replaced) this.marketplace.replacedGrantEnds.set(key(terms.accountId, buyer, replaced.nonce), endOf(replaced));
    else this.marketplace.buyers.set(terms.accountId, [...(this.marketplace.buyers.get(terms.accountId) ?? []), buyer]);
    this.marketplace.grants.set(key(terms.accountId, buyer), {
      maxCostPerEpoch: terms.maxCostPerEpoch, grantedAt: now, expiresAt: terms.expiresAt, revokedAt: 0, nonce: expected, owner,
    });
    this.marketplace.grantNonces.set(terms.accountId, expected + 1n);
    return this.txResult(true);
  }

  async removeBuyer(accountId: bigint, buyer: string, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    await this.requireOwner(accountId, this.senderOf(opts));
    const grant = this.marketplace.grants.get(key(accountId, buyer));
    if (!grant) revert('NotABuyer', accountId, buyer);
    if (grant.revokedAt !== 0) revert('GrantRevoked', accountId, buyer);
    grant.revokedAt = (await this.getEpochTimes()).now;
    this.marketplace.grantNonces.set(accountId, (this.marketplace.grantNonces.get(accountId) ?? 0n) + 1n);
    return this.txResult(true);
  }

  async setBuyerLimits(accountId: bigint, buyer: string, limits: BuyerLimits, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    const sender = this.senderOf(opts);
    await this.requireOwner(accountId, sender);
    const now = (await this.getEpochTimes()).now;
    const grant = this.liveGrant(accountId, buyer, sender, now);
    this.requireValidLimits(limits, now);
    if (limits.maxCostPerEpoch === grant.maxCostPerEpoch && limits.expiresAt === grant.expiresAt) {
      revert('BuyerLimitsUnchanged', accountId, buyer);
    }
    grant.maxCostPerEpoch = limits.maxCostPerEpoch;
    grant.expiresAt = limits.expiresAt;
    return this.txResult(true);
  }

  async advanceGrantNonce(accountId: bigint, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    await this.requireOwner(accountId, this.senderOf(opts));
    this.marketplace.grantNonces.set(accountId, (this.marketplace.grantNonces.get(accountId) ?? 0n) + 1n);
    return this.txResult(true);
  }

  async signBuyerGrant(terms: BuyerGrantTerms): Promise<{ digest: string; signature: string }> {
    const domain = grantDomain(await this.getEvmChainId(), ADDRESSES.serviceSubscriptions);
    const t = { accountId: terms.accountId, buyer: terms.buyer, maxCostPerEpoch: terms.maxCostPerEpoch, expiresAt: terms.expiresAt, nonce: terms.nonce };
    const signature = compactSignature(await this.signTypedDataAs(terms.buyer, domain, BUYER_GRANT_TYPES, t));
    return { digest: hashBuyerGrant(domain, t), signature };
  }

  async fundFromAccount(request: AccountFundingRequest, opts?: MarketplaceWriteOptions): Promise<SubscriptionFunding> {
    return this.fund(request, request.accountId, this.senderOf(opts));
  }

  async topUpFromAccount(subscriptionId: string, additions: ServiceBudget[], planDigest: string, opts?: MarketplaceWriteOptions): Promise<SubscriptionTopUp> {
    return this.topUp(subscriptionId, additions, planDigest, true, this.senderOf(opts));
  }

  async previewCost(accountId: bigint, value: bigint): Promise<{ cost: bigint; discountBps: number }> {
    const discountBps = (await this.getPublishingConvictionAccountInfo(accountId))?.discountBps ?? 0;
    return { cost: discounted(value, discountBps), discountBps };
  }

  async currentWindowAllowance(accountId: bigint): Promise<WindowAllowance> {
    const info = await this.getPublishingConvictionAccountInfo(accountId);
    const spent = this.marketplace.spent.get(accountId) ?? { window: 0n, topUp: 0n };
    const base = info?.baseEpochAllowance ?? 0n;
    return {
      window: 0,
      baseRemaining: spent.window < base ? base - spent.window : 0n,
      topUpBuffer: (info?.topUpBuffer ?? 0n) - spent.topUp,
      // As the contract reads an account that does not exist.
      expired: info === null,
    };
  }

  // ------------------------------------------- ServiceSubscriptionsWallet

  async fundFromWallet(request: WalletFundingRequest, opts?: MarketplaceWriteOptions): Promise<SubscriptionFunding> {
    return this.fund(request, 0n, this.senderOf(opts));
  }

  async topUpFromWallet(subscriptionId: string, additions: ServiceBudget[], planDigest: string, opts?: MarketplaceWriteOptions): Promise<SubscriptionTopUp> {
    return this.topUp(subscriptionId, additions, planDigest, false, this.senderOf(opts));
  }

  async approveServiceSubscriptionsWallet(amount: bigint, opts?: MarketplaceWriteOptions): Promise<TxResult> {
    this.marketplace.allowances.set(key(this.senderOf(opts)), amount);
    return this.txResult(true);
  }

  async getServiceSubscriptionsWalletAllowance(owner: string): Promise<bigint> {
    return this.marketplace.allowances.get(key(owner)) ?? 0n;
  }

  // ------------------------------------------ ServiceSubscriptionsStorage

  async getSubscription(subscriptionId: string): Promise<Subscription | null> {
    const s = this.marketplace.subscriptions.get(key(subscriptionId));
    return s ? { ...s } : null;
  }

  async getBudgets(subscriptionId: string): Promise<ServiceBudget[]> {
    return (this.marketplace.budgets.get(key(subscriptionId)) ?? []).map((b) => ({ ...b }));
  }

  async subscriptionExists(subscriptionId: string): Promise<boolean> {
    return this.marketplace.subscriptions.has(key(subscriptionId));
  }

  async getGrant(accountId: bigint, buyer: string): Promise<BuyerGrant | null> {
    const grant = this.marketplace.grants.get(key(accountId, buyer));
    return grant ? { ...grant } : null;
  }

  async grantEnd(accountId: bigint, buyer: string, nonce: bigint): Promise<number> {
    return this.grantEndOf(accountId, buyer, nonce);
  }

  async grantNonce(accountId: bigint): Promise<bigint> {
    return this.marketplace.grantNonces.get(accountId) ?? 0n;
  }

  async getServiceSpending(accountId: bigint): Promise<ServiceSpending> {
    return { ...(this.marketplace.spending.get(accountId) ?? { enabledAt: 0, owner: ethers.ZeroAddress }) };
  }

  async maxBudgetsPerSubscription(): Promise<number> {
    return MAX_BUDGETS;
  }

  async getAccountBuyers(accountId: bigint): Promise<string[]> {
    return [...(this.marketplace.buyers.get(accountId) ?? [])];
  }

  async listBuyerAccounts(buyer: string): Promise<bigint[]> {
    const accounts = [...this.marketplace.buyers]
      .filter(([, buyers]) => buyers.some((b) => b.toLowerCase() === buyer.toLowerCase()))
      .map(([accountId]) => accountId);
    return accounts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // --------------------------------------------- QueryInferenceSettlement

  async submitReceiptBatch(groups: ReceiptGroup[], opts: ReceiptBatchSendOptions = {}): Promise<ReceiptBatch> {
    return this.landBatch(groups, this.txResult(true).hash, this.marketplace.sent.get(ethers.getAddress(this.signerAddress)) ?? 0, opts);
  }

  async rebroadcastReceiptBatch(signedTx: string): Promise<void> {
    const signed = this.marketplace.signed.get(signedTx);
    if (!signed) throw new Error('not a receipt batch this chain signed');
    // At most once: refused, as a node refuses it, once its nonce is used. One that would revert is mined reverted.
    if ((this.marketplace.sent.get(ethers.getAddress(this.signerAddress)) ?? 0) !== signed.nonce) throw new Error('nonce too low');
    await this.landBatch(signed.groups, signed.hash, signed.nonce).catch(() => {
      this.marketplace.sent.set(ethers.getAddress(this.signerAddress), signed.nonce + 1);
      this.marketplace.reverted.add(signed.hash);
    });
  }

  private async landBatch(groups: ReceiptGroup[], hash: string, nonce: number, opts: ReceiptBatchSendOptions = {}): Promise<ReceiptBatch> {
    const seller = await this.getIdentityId();
    if (seller === 0n) revert('ProfileDoesntExist', 0n);
    const { epoch, now } = await this.getEpochTimes();
    if ((await this.getNodeEpochScore(epoch, seller)) === 0n) revert('NoNodeScore', seller, epoch);
    const itemCount = groups.reduce((n, g) => n + g.items.length, 0);
    if (groups.length === 0 || groups.length > BATCH_STATE.maxGroups || itemCount === 0 || itemCount > BATCH_STATE.maxItems) {
      revert('BatchOutOfBounds', groups.length, itemCount);
    }
    const domain = requestDomain(await this.getEvmChainId(), ADDRESSES.queryInferenceStorage);
    // Checked in full before anything is written: a fault refuses the whole batch.
    const nonces = new Map<string, Set<bigint>>();
    const used = new Map<string, bigint>();
    const landed: ReceiptsLanded[] = [];
    const digests: string[] = [];
    groups.forEach((group, g) => {
      if (group.items.length === 0) revert('GroupFault', g, FAULT.EmptyGroup);
      const id = key(group.subscriptionId);
      const s = this.marketplace.subscriptions.get(id);
      if (!s) revert('GroupFault', g, FAULT.UnknownSubscription);
      if (group.budgetIndex >= s.budgetCount) revert('GroupFault', g, FAULT.UnknownBudget);
      if (s.epoch !== epoch) revert('GroupFault', g, FAULT.OutsideEpoch);
      const budget = this.marketplace.budgets.get(id)![group.budgetIndex]!;
      const grantEnd = s.accountId === 0n ? Infinity : this.grantEndOf(s.accountId, s.buyer, s.grantNonce);
      const nonceKey = key(id, seller);
      const batchNonces = nonces.get(nonceKey) ?? new Set<bigint>();
      nonces.set(nonceKey, batchNonces);
      const groupDigests: string[] = [];
      let value = 0n;
      group.items.forEach((it, j) => {
        const requestDigest = hashServiceRequest(domain, {
          subscriptionId: group.subscriptionId, serviceId: budget.serviceId, seller, nonce: it.nonce, pricePerUnit: it.pricePerUnit,
          maxUnits: it.maxUnits, maxValueWei: it.maxValueWei, issuedAt: it.issuedAt, expiry: it.expiry,
        });
        if (recoverSigner(requestDigest, ethers.concat([it.sigR, it.sigVS])) !== s.sessionKey) revert('ReceiptFault', g, j, FAULT.BadSignature);
        if (it.issuedAt >= grantEnd) revert('ReceiptFault', g, j, FAULT.InactiveGrant);
        if (this.marketplace.usedNonces.get(nonceKey)?.has(it.nonce) || batchNonces.has(it.nonce)) revert('ReceiptFault', g, j, FAULT.DuplicateNonce);
        batchNonces.add(it.nonce);
        if (it.issuedAt < s.startsAt || it.completedAt < it.issuedAt || it.completedAt > it.expiry || it.completedAt > now) {
          revert('ReceiptFault', g, j, FAULT.OutsideTime);
        }
        if (it.pricePerUnit === 0n || it.pricePerUnit > budget.maxPricePerUnit) revert('ReceiptFault', g, j, FAULT.PriceOutOfRange);
        if (it.units === 0n || it.units > it.maxUnits || it.units * it.pricePerUnit !== it.valueWei || it.valueWei > it.maxValueWei) {
          revert('ReceiptFault', g, j, FAULT.BadArithmetic);
        }
        if (BigInt(it.resultCommitment) === 0n) revert('ReceiptFault', g, j, FAULT.ZeroResultCommitment);
        value += it.valueWei;
        groupDigests.push(hashQueryInferenceReceipt(domain, {
          requestDigest, resultCommitment: it.resultCommitment, units: it.units, valueWei: it.valueWei, completedAt: it.completedAt,
        }));
      });
      const budgetKey = key(id, group.budgetIndex);
      const usedSoFar = used.get(budgetKey) ?? this.marketplace.budgetUsed.get(budgetKey) ?? 0n;
      const left = budget.value - usedSoFar;
      const counted = value < left ? value : left;
      if (counted < group.minCounted) revert('GroupFault', g, FAULT.BelowMinCounted);
      used.set(budgetKey, usedSoFar + counted);
      digests.push(...groupDigests);
      landed.push({
        subscriptionId: group.subscriptionId, budgetIndex: group.budgetIndex, seller, itemCount: group.items.length,
        value, counted, stakeFactor18: SCALE18, groupDigest: receiptsDigest(groupDigests),
      });
    });
    // Checked in full, as a simulation: now signed, the hook, then the broadcast.
    const wallet = ethers.getAddress(this.signerAddress);
    const tx = { ...this.txResult(true), hash };
    const signedTx = ethers.hexlify(ethers.toUtf8Bytes(`mock receipt batch ${hash}`));
    this.marketplace.signed.set(signedTx, { groups, hash, nonce });
    await opts.onBroadcast?.({ txHash: hash, nonce, wallet, signedTx });
    this.marketplace.sent.set(wallet, nonce + 1);
    for (const [nonceKey, batchNonces] of nonces) {
      const stored = this.marketplace.usedNonces.get(nonceKey) ?? new Set<bigint>();
      for (const nonce of batchNonces) stored.add(nonce);
      this.marketplace.usedNonces.set(nonceKey, stored);
    }
    for (const [budgetKey, value] of used) this.marketplace.budgetUsed.set(budgetKey, value);
    for (const group of landed) this.countServed(seller, epoch, group.subscriptionId, group.counted);
    const batch: ReceiptBatch = {
      ...tx,
      gasUsed: BigInt(60_000 + 15_000 * itemCount),
      seller,
      batchDigest: receiptsDigest(digests),
      itemCount,
      value: landed.reduce((v, l) => v + l.value, 0n),
      counted: landed.reduce((v, l) => v + l.counted, 0n),
      stakeFactor18: SCALE18,
      groups: landed,
    };
    this.marketplace.batches.set(tx.hash, batch);
    return batch;
  }

  async getReceiptBatchOutcome(txHash: string): Promise<ReceiptBatchOutcome> {
    if (this.marketplace.reverted.has(txHash)) return { reverted: true };
    const batch = this.marketplace.batches.get(txHash);
    return batch ? { landed: { ...batch, groups: batch.groups.map((g) => ({ ...g })) } } : null;
  }

  async listReceiptsLanded(subscriptionId: string, fromBlock = 0): Promise<{ groups: LandedGroup[]; toBlock: number }> {
    const batches = [...this.marketplace.batches.values()];
    const groups = batches.filter((b) => b.blockNumber >= fromBlock).flatMap((b) => b.groups
      .filter((g) => key(g.subscriptionId) === key(subscriptionId))
      .map((g) => ({ ...g, txHash: b.hash, blockNumber: b.blockNumber })));
    return { groups, toBlock: Math.max(fromBlock - 1, ...batches.map((b) => b.blockNumber)) };
  }

  async getMinedNonce(address: string): Promise<number> {
    return this.marketplace.sent.get(ethers.getAddress(address)) ?? 0;
  }

  async getBaseFee(): Promise<bigint | null> {
    return this.mockBaseFee;
  }

  async budgetLeft(subscriptionId: string, budgetIndex: number): Promise<bigint> {
    const budget = this.marketplace.budgets.get(key(subscriptionId))?.[budgetIndex];
    return budget ? budget.value - (this.marketplace.budgetUsed.get(key(subscriptionId, budgetIndex)) ?? 0n) : 0n;
  }

  async stakeFactor(_identityId: bigint): Promise<bigint> {
    return SCALE18;
  }

  async epochPool(epoch: number): Promise<bigint> {
    return this.totalsOf(epoch).totalServed === 0n ? 0n : this.poolWithValue(epoch);
  }

  async queryInferenceGross(epoch: number, identityId: bigint): Promise<bigint> {
    const n = this.marketplace.nodeEpochs.get(key(identityId, epoch));
    if (!n || n.servedValue === 0n) return 0n;
    const t = this.totalsOf(epoch);
    const pool = this.poolWithValue(epoch);
    const lambda = BigInt(t.lambdaBps);
    let gross = (pool * (BPS - lambda) * n.servedValue) / (BPS * t.totalServed);
    if (lambda !== 0n) {
      gross += t.totalWeighted === 0n
        ? (pool * lambda * n.servedValue) / (BPS * t.totalServed)
        : (pool * lambda * n.weightedValue) / (BPS * t.totalWeighted);
    }
    return gross;
  }

  // ------------------------------------------------ QueryInferenceStorage

  async batchState(): Promise<BatchState> {
    return { ...BATCH_STATE };
  }

  async nonceWord(subscriptionId: string, identityId: bigint, word: bigint): Promise<bigint> {
    let bits = 0n;
    for (const nonce of this.marketplace.usedNonces.get(key(subscriptionId, identityId)) ?? []) {
      if (nonce >> 8n === word) bits |= 1n << (nonce & 0xffn);
    }
    return bits;
  }

  async budgetUsed(subscriptionId: string, budgetIndex: number): Promise<bigint> {
    return this.marketplace.budgetUsed.get(key(subscriptionId, budgetIndex)) ?? 0n;
  }

  async fundingIn(epoch: number): Promise<EpochFunding> {
    return { ...(this.marketplace.funding.get(epoch) ?? { wallet: 0n, account: 0n }) };
  }

  async getEpochTotals(epoch: number): Promise<EpochTotals> {
    return { ...this.totalsOf(epoch) };
  }

  async getNodeEpoch(identityId: bigint, epoch: number): Promise<NodeEpoch> {
    return { ...(this.marketplace.nodeEpochs.get(key(identityId, epoch)) ?? { servedValue: 0n, weightedValue: 0n }) };
  }

  // ------------------------- ShardingTableStorage, RandomSamplingStorage

  /** The mock's node id of an identity is the identity id, as 32 bytes. */
  async getShardingTableNodeId(identityId: bigint): Promise<string | null> {
    return identityId > 0n ? ethers.toBeHex(identityId, 32) : null;
  }

  async getNodeEpochScore(_epoch: number, identityId: bigint): Promise<bigint> {
    return identityId > 0n ? SCALE18 : 0n;
  }

  async profileExists(identityId: bigint): Promise<boolean> {
    return identityId > 0n;
  }

  async getNodeStake(identityId: bigint): Promise<bigint> {
    return identityId > 0n ? MOCK_NODE_STAKE : 0n;
  }

  async getMinimumStake(): Promise<bigint> {
    return MOCK_NODE_STAKE;
  }

  // ------------------------------------------ ParametersStorage, the Token

  async getProtocolTreasury(): Promise<string> {
    return ethers.ZeroAddress;
  }

  async getWalletBalances(_address: string): Promise<{ eth: bigint; trac: bigint }> {
    return { ...WALLET_BALANCES };
  }

  // -------------------------------------------------------------- the model

  private epochStart(epoch: number): number {
    return this.marketplaceGenesis + (epoch - 1) * MOCK_EPOCH_SECONDS;
  }

  private senderOf(opts: MarketplaceWriteOptions | undefined): string {
    return ethers.getAddress(opts?.from ?? this.signerAddress);
  }

  private async requireOwner(accountId: bigint, sender: string): Promise<void> {
    const info = await this.getPublishingConvictionAccountInfo(accountId);
    if (!info) revert('ERC721NonexistentToken', accountId);
    if (ethers.getAddress(info.owner) !== sender) revert('NotAccountOwner', accountId, sender);
  }

  /** Service spending is on, switched on by the account's current owner, which it returns. */
  private async requireSpendingOn(accountId: bigint): Promise<string> {
    const spending = this.marketplace.spending.get(accountId);
    const owner = spending ? (await this.getPublishingConvictionAccountInfo(accountId))?.owner : undefined;
    if (!spending || !owner || ethers.getAddress(owner) !== spending.owner) revert('ServiceSpendingDisabled', accountId);
    return spending.owner;
  }

  private requireValidLimits(limits: BuyerLimits, now: number): void {
    if (limits.maxCostPerEpoch === 0n) revert('InvalidBuyerTerms', 'maxCostPerEpoch');
    if (limits.expiresAt <= now) revert('InvalidBuyerTerms', 'expiresAt');
  }

  private liveGrant(accountId: bigint, buyer: string, owner: string, now: number): BuyerGrant {
    const grant = this.marketplace.grants.get(key(accountId, buyer));
    if (!grant) revert('NotABuyer', accountId, buyer);
    if (grant.owner !== owner) revert('GrantedByFormerOwner', accountId, buyer);
    if (grant.revokedAt !== 0) revert('GrantRevoked', accountId, buyer);
    if (now >= grant.expiresAt) revert('GrantExpired', accountId, buyer);
    return grant;
  }

  private grantEndOf(accountId: bigint, buyer: string, nonce: bigint): number {
    const grant = this.marketplace.grants.get(key(accountId, buyer));
    if (grant && grant.nonce === nonce) return endOf(grant);
    return this.marketplace.replacedGrantEnds.get(key(accountId, buyer, nonce)) ?? 0;
  }

  /** Spend `cost` from the account's base allowance, then from its top-up buffer. */
  private async spend(accountId: bigint, cost: bigint, epoch: number): Promise<{ fromWindow: bigint; fromTopUp: bigint }> {
    const allowance = await this.currentWindowAllowance(accountId);
    const fromWindow = cost < allowance.baseRemaining ? cost : allowance.baseRemaining;
    const fromTopUp = cost - fromWindow;
    if (fromTopUp > allowance.topUpBuffer) revert('InsufficientAllowance', accountId, epoch, cost, allowance.baseRemaining + allowance.topUpBuffer);
    const spent = this.marketplace.spent.get(accountId) ?? { window: 0n, topUp: 0n };
    this.marketplace.spent.set(accountId, { window: spent.window + fromWindow, topUp: spent.topUp + fromTopUp });
    return { fromWindow, fromTopUp };
  }

  /** Take `value` of the allowance `buyer` granted `ServiceSubscriptionsWallet`, as its `transferFrom` does. */
  private pull(buyer: string, value: bigint): void {
    const allowance = this.marketplace.allowances.get(key(buyer)) ?? 0n;
    if (allowance < value) revert('ERC20InsufficientAllowance', ADDRESSES.serviceSubscriptionsWallet, allowance, value);
    this.marketplace.allowances.set(key(buyer), allowance - value);
  }

  private book(epoch: number, fromAccount: boolean, amount: bigint): void {
    const funding = this.marketplace.funding.get(epoch) ?? { wallet: 0n, account: 0n };
    if (fromAccount) funding.account += amount;
    else funding.wallet += amount;
    this.marketplace.funding.set(epoch, funding);
  }

  private async fund(request: WalletFundingRequest, accountId: bigint, buyer: string): Promise<SubscriptionFunding> {
    const { epoch: current, now } = await this.getEpochTimes();
    if (request.sessionKey === ethers.ZeroAddress) revert('ZeroSessionKey');
    if (request.epoch !== current && request.epoch !== current + 1) revert('InvalidFundingRequest', 'epoch');
    const startsAt = Math.max(now, this.epochStart(request.epoch));
    const endsAt = this.epochStart(request.epoch + 1);
    let grant: BuyerGrant | undefined;
    if (accountId !== 0n) {
      grant = this.liveGrant(accountId, buyer, await this.requireSpendingOn(accountId), now);
      if (grant.expiresAt <= startsAt) revert('GrantEndsBeforeSubscription', accountId, buyer, grant.expiresAt, startsAt);
    }
    if (request.budgets.length === 0 || request.budgets.length > MAX_BUDGETS) revert('InvalidFundingRequest', 'budgetCount');
    request.budgets.forEach((b, i) => {
      requireInOrder(request.budgets, i);
      requireNewBudgetTerms(b);
    });
    const value = request.budgets.reduce((v, b) => v + b.value, 0n);
    if (value > UINT96_MAX) revert('InvalidFundingRequest', 'value');
    const subscriptionId = subscriptionIdOf(buyer, request.epoch);
    if (this.marketplace.subscriptions.has(key(subscriptionId))) revert('SubscriptionAlreadyFunded', subscriptionId);

    let cost = value;
    let discountBps = 0;
    let spent = { fromWindow: 0n, fromTopUp: 0n };
    if (grant) {
      ({ cost, discountBps } = await this.previewCost(accountId, value));
      if (cost > grant.maxCostPerEpoch) revert('LimitExceeded', 'maxCostPerEpoch', grant.maxCostPerEpoch, cost);
      spent = await this.spend(accountId, cost, current);
    } else {
      this.pull(buyer, value);
    }
    this.book(request.epoch, accountId !== 0n, cost);
    this.marketplace.subscriptions.set(key(subscriptionId), {
      subscriptionId, accountId, buyer, grantNonce: grant?.nonce ?? 0n, sessionKey: ethers.getAddress(request.sessionKey),
      epoch: request.epoch, planDigest: request.planDigest, startsAt, endsAt, fundedEpoch: current, fundedWindow: 0, discountBps,
      budgetCount: request.budgets.length, value, cost, spentFromWindow: spent.fromWindow, spentFromTopUp: spent.fromTopUp,
    });
    this.marketplace.budgets.set(key(subscriptionId), request.budgets.map((b) => ({ ...b })));
    return { ...this.txResult(true), subscriptionId, value, cost };
  }

  private async topUp(
    subscriptionId: string,
    additions: ServiceBudget[],
    planDigest: string,
    fromAccount: boolean,
    buyer: string,
  ): Promise<SubscriptionTopUp> {
    const { epoch: current, now } = await this.getEpochTimes();
    const s = this.marketplace.subscriptions.get(key(subscriptionId));
    if (!s) revert('SubscriptionNotFound', subscriptionId);
    if (s.buyer !== buyer) revert('NotSubscriptionBuyer', subscriptionId, buyer);
    if ((s.accountId !== 0n) !== fromAccount) revert('WrongFundingSource', subscriptionId, s.accountId);
    if (now >= s.endsAt) revert('SubscriptionEnded', subscriptionId, s.endsAt);
    let grant: BuyerGrant | undefined;
    if (fromAccount) {
      grant = this.liveGrant(s.accountId, buyer, await this.requireSpendingOn(s.accountId), now);
      if (grant.expiresAt <= s.startsAt) revert('GrantEndsBeforeSubscription', s.accountId, buyer, grant.expiresAt, s.startsAt);
      const fundedUnder = this.grantEndOf(s.accountId, buyer, s.grantNonce);
      if (now >= fundedUnder) revert('GrantExpired', s.accountId, buyer);
      if (fundedUnder <= s.startsAt) revert('GrantEndsBeforeSubscription', s.accountId, buyer, fundedUnder, s.startsAt);
    }

    const stored = this.marketplace.budgets.get(key(subscriptionId))!;
    if (additions.length === 0) revert('InvalidFundingRequest', 'budgetCount');
    const added = new Map<number, bigint>();
    const appended: ServiceBudget[] = [];
    for (const [j, b] of additions.entries()) {
      requireInOrder(additions, j);
      const i = stored.findIndex((x) => BigInt(x.serviceId) === BigInt(b.serviceId));
      if (i < 0) {
        requireNewBudgetTerms(b);
        appended.push({ ...b });
        continue;
      }
      if (b.value === 0n) revert('InvalidFundingRequest', 'budgetValue');
      if (b.serviceClass !== stored[i]!.serviceClass || b.maxPricePerUnit !== stored[i]!.maxPricePerUnit) revert('BudgetTermsChanged', b.serviceId);
      added.set(i, b.value);
    }
    if (stored.length + appended.length > MAX_BUDGETS) revert('InvalidFundingRequest', 'budgetCount');
    const value = additions.reduce((v, b) => v + b.value, 0n);
    if (value > UINT96_MAX || s.value + value > UINT96_MAX) revert('InvalidFundingRequest', 'value');

    let cost = value;
    let spent = { fromWindow: 0n, fromTopUp: 0n };
    if (grant) {
      cost = (await this.previewCost(s.accountId, value)).cost;
      if (s.cost + cost > grant.maxCostPerEpoch) revert('LimitExceeded', 'maxCostPerEpoch', grant.maxCostPerEpoch, s.cost + cost);
      spent = await this.spend(s.accountId, cost, current);
    } else {
      this.pull(buyer, value);
    }
    this.book(s.epoch, fromAccount, cost);
    for (const [i, v] of added) stored[i]!.value += v;
    stored.push(...appended);
    Object.assign(s, {
      budgetCount: stored.length, value: s.value + value, cost: s.cost + cost, planDigest,
      spentFromWindow: s.spentFromWindow + spent.fromWindow, spentFromTopUp: s.spentFromTopUp + spent.fromTopUp,
    });
    return { ...this.txResult(true), value, cost };
  }

  /** Add a counted group's served value, at its subscription's discount, to the node's and the epoch's totals. */
  private countServed(seller: bigint, epoch: number, subscriptionId: string, counted: bigint): void {
    const s = this.marketplace.subscriptions.get(key(subscriptionId))!;
    const served = (counted * (BPS - BigInt(s.discountBps))) / BPS;
    const node = this.marketplace.nodeEpochs.get(key(seller, epoch)) ?? { servedValue: 0n, weightedValue: 0n };
    this.marketplace.nodeEpochs.set(key(seller, epoch), { servedValue: node.servedValue + served, weightedValue: node.weightedValue + served });
    const t = this.totalsOf(epoch);
    this.marketplace.totals.set(epoch, {
      totalServed: t.totalServed + served,
      totalWeighted: t.totalWeighted + served,
      lambdaBps: t.totalServed === 0n ? LAMBDA_BPS : t.lambdaBps,
    });
  }

  private totalsOf(epoch: number): EpochTotals {
    return this.marketplace.totals.get(epoch) ?? { totalServed: 0n, totalWeighted: 0n, lambdaBps: 0 };
  }

  /** The pool of an epoch with served value: its money and that of the run of epochs before it with none. */
  private poolWithValue(epoch: number): bigint {
    const moneyOf = (e: number) => {
      const f = this.marketplace.funding.get(e);
      return f ? f.wallet + f.account : 0n;
    };
    let pool = moneyOf(epoch);
    for (let e = epoch - 1; e >= BATCH_STATE.activationEpoch && this.totalsOf(e).totalServed === 0n; e--) pool += moneyOf(e);
    return pool;
  }
}

/** A party's consent: by sending, with an empty signature, or by a signature that recovers to it with a low s. */
function requireConsent(sender: string, party: string, digest: string, signature: string): void {
  const empty = signature === '' || signature === '0x';
  if (sender === party) {
    if (!empty) revert('InvalidConsentSignature', party);
    return;
  }
  if (empty) revert('ConsentMissing', party);
  if (recoverSigner(digest, signature) !== party) revert('InvalidConsentSignature', party);
}
