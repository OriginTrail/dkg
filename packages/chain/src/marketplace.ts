// SPDX-License-Identifier: Apache-2.0

/**
 * The NeuroSymbolic Marketplace (OT-RFC-27) on the chain: its types, its three
 * EIP-712 messages, and the optional `ChainAdapter` methods.
 *
 * A buyer funds a subscription of one epoch, from its wallet
 * (`ServiceSubscriptionsWallet`) or from a Conviction Account that granted it
 * (`ServiceSubscriptions`), and its session key signs a `ServiceRequest` for
 * each call. A seller, a Core Node, answers each call with a signed
 * `QueryInferenceReceipt` and lands the receipts in batches
 * (`QueryInferenceSettlement.submitReceiptBatch`). An account's owner and the
 * buyer both consent to the buyer's `BuyerGrant`.
 *
 * `evm-adapter-marketplace.ts` implements the methods against the contracts and
 * `mock-adapter-marketplace.ts` in memory. A method that calls one contract
 * function is named after it and takes its arguments in the same order.
 * Amounts are TRAC wei, times are chain seconds, and ids, digests and
 * signatures are 0x-prefixed hex.
 */
import { ethers } from 'ethers';
import type { ChainAdapter, TxResult } from './chain-adapter.js';
import type { PreBroadcastSignal, ReplacementBroadcastSignal } from './transaction-broadcast-types.js';
import { enrichEvmError } from './evm-adapter-errors.js';

/** `ServiceSubscriptionsStorage.CLASS_INFERENCE`: units are tokens. */
export const SERVICE_CLASS_INFERENCE = 1;
/** `ServiceSubscriptionsStorage.CLASS_QUERY`: units are query units. */
export const SERVICE_CLASS_QUERY = 2;

// ---------------------------------------------------------------------------
// Subscriptions and grants
// ---------------------------------------------------------------------------

/** One service budget of a subscription (`ServiceSubscriptionsStorage.ServiceBudget`). */
export interface ServiceBudget {
  serviceId: string;
  serviceClass: number;
  /** The funded value, before an account's discount. */
  value: bigint;
  /** The buyer's price cap per unit. */
  maxPricePerUnit: bigint;
}

/** A funded subscription (`ServiceSubscriptionsStorage.Subscription`) and its id. */
export interface Subscription {
  subscriptionId: string;
  /** 0n for a subscription funded from a wallet. */
  accountId: bigint;
  buyer: string;
  /** The nonce of the grant it was funded under; 0n for a wallet subscription. */
  grantNonce: bigint;
  sessionKey: string;
  epoch: number;
  planDigest: string;
  /** The later of the funding's block time and the epoch's start. */
  startsAt: number;
  /** The start of the next epoch. */
  endsAt: number;
  fundedEpoch: number;
  fundedWindow: number;
  discountBps: number;
  budgetCount: number;
  value: bigint;
  /** What was paid: the value for a wallet subscription, the discounted value for an account's. */
  cost: bigint;
  spentFromWindow: bigint;
  spentFromTopUp: bigint;
}

/** A buyer's grant on an account (`ServiceSubscriptionsStorage.BuyerGrant`). */
export interface BuyerGrant {
  /** The most one subscription may cost, its top-ups included. */
  maxCostPerEpoch: bigint;
  grantedAt: number;
  expiresAt: number;
  /** 0 = not revoked. */
  revokedAt: number;
  /** The account's grant nonce this grant consumed. */
  nonce: bigint;
  /** The owner who consented; the grant funds only while that owner holds the account. */
  owner: string;
}

/** The terms both parties consent to: `ServiceSubscriptions.BuyerTerms`, the EIP-712 `BuyerGrant`. */
export interface BuyerGrantTerms {
  accountId: bigint;
  buyer: string;
  maxCostPerEpoch: bigint;
  expiresAt: number;
  /** The account's current grant nonce (`grantNonce`). */
  nonce: bigint;
}

/** What `setBuyerLimits` replaces (`ServiceSubscriptionsStorage.BuyerLimits`). */
export interface BuyerLimits {
  maxCostPerEpoch: bigint;
  expiresAt: number;
}

/** An account's opt-in to service spending: `enabledAt` 0 is off. It counts only while `owner` holds the account. */
export interface ServiceSpending {
  enabledAt: number;
  owner: string;
}

/** `ServiceSubscriptionsWallet.WalletFundingRequest`. */
export interface WalletFundingRequest {
  /** The current epoch or the next. */
  epoch: number;
  /** Never the zero address. */
  sessionKey: string;
  planDigest: string;
  /** 1 to `maxBudgetsPerSubscription`, in strictly increasing `serviceId`. */
  budgets: ServiceBudget[];
}

/** `ServiceSubscriptions.FundingRequest`: a wallet's request, paid from an account. */
export interface AccountFundingRequest extends WalletFundingRequest {
  accountId: bigint;
}

/** A funding: the `SubscriptionFunded` event. */
export interface SubscriptionFunding extends TxResult {
  subscriptionId: string;
  value: bigint;
  cost: bigint;
}

/** A top-up: the `SubscriptionToppedUp` event. */
export interface SubscriptionTopUp extends TxResult {
  value: bigint;
  cost: bigint;
}

/** A Knowledge Asset's lifetime extension: its transaction, the TRAC it paid, and the asset's new end epoch. */
export interface KnowledgeAssetExtension extends TxResult {
  tokenAmount: bigint;
  endEpoch: number;
}

/** `ServiceSubscriptions.currentWindowAllowance`. */
export interface WindowAllowance {
  window: number;
  baseRemaining: bigint;
  topUpBuffer: bigint;
  expired: boolean;
}

// ---------------------------------------------------------------------------
// Requests, receipts and batches
// ---------------------------------------------------------------------------

/** One call's authorization, signed by the session key (`QueryInferenceSettlement.ServiceRequest`). */
export interface ServiceRequest {
  subscriptionId: string;
  serviceId: string;
  /** The seller's identity id. */
  seller: bigint;
  /** Unique per subscription and seller. */
  nonce: bigint;
  pricePerUnit: bigint;
  maxUnits: bigint;
  maxValueWei: bigint;
  issuedAt: number;
  expiry: number;
}

/** The seller's statement of what it delivered (`QueryInferenceSettlement.QueryInferenceReceipt`). */
export interface QueryInferenceReceipt {
  requestDigest: string;
  resultCommitment: string;
  units: bigint;
  valueWei: bigint;
  completedAt: number;
}

/** One receipt of a batch (`QueryInferenceSettlement.ReceiptItem`). */
export interface ReceiptItem {
  nonce: bigint;
  pricePerUnit: bigint;
  maxUnits: bigint;
  maxValueWei: bigint;
  issuedAt: number;
  expiry: number;
  units: bigint;
  valueWei: bigint;
  resultCommitment: string;
  completedAt: number;
  /** The session key's EIP-2098 signature over the request: r, and v with s. */
  sigR: string;
  sigVS: string;
}

/** The receipts of one budget of one subscription (`QueryInferenceSettlement.ReceiptGroup`). */
export interface ReceiptGroup {
  subscriptionId: string;
  /** The budget's index in the subscription: its funding order. */
  budgetIndex: number;
  /** The least face value the group lands for; 0n always lands. */
  minCounted: bigint;
  items: ReceiptItem[];
}

/** One group that landed: the `ReceiptsLanded` event. */
export interface ReceiptsLanded {
  subscriptionId: string;
  budgetIndex: number;
  seller: bigint;
  itemCount: number;
  /** The group's value on the budget. */
  value: bigint;
  /** What of it fit what the budget had left. */
  counted: bigint;
  stakeFactor18: bigint;
  /** `receiptsDigest` of the group's receipt digests, in order. */
  groupDigest: string;
}

/** A group that landed, with the transaction that landed it. */
export interface LandedGroup extends ReceiptsLanded {
  txHash: string;
  blockNumber: number;
}

/**
 * A receipt batch's send: the durable record before it is broadcast, and the
 * hash of each speed-up before that is broadcast.
 */
export interface ReceiptBatchSendOptions {
  /**
   * Awaited once the batch is signed, before it is broadcast, with the wallet and nonce it took and the signed
   * transaction, which `rebroadcastReceiptBatch` can send again; a throw sends nothing.
   */
  onBroadcast?: (signal: PreBroadcastSignal & { wallet: string; signedTx: string }) => Promise<void> | void;
  /** Awaited before each same-nonce replacement of a stuck batch is broadcast; a throw sends no replacement. */
  onBeforeReplacementBroadcast?: (signal: ReplacementBroadcastSignal) => Promise<void> | void;
}

/** What became of a batch's transaction: it landed, with its groups; it reverted; or `null` while it is not mined. */
export type ReceiptBatchOutcome = { landed: ReceiptBatch } | { reverted: true } | null;

/** A batch that landed: its `ReceiptBatchAccepted` event and its groups. */
export interface ReceiptBatch extends TxResult {
  gasUsed: bigint;
  seller: bigint;
  /** `receiptsDigest` of all its receipt digests, in order. */
  batchDigest: string;
  itemCount: number;
  value: bigint;
  counted: bigint;
  stakeFactor18: bigint;
  groups: ReceiptsLanded[];
}

/** `QueryInferenceStorage.batchState`: the activation epoch (0 = unset), the pause, and the batch bounds. */
export interface BatchState {
  activationEpoch: number;
  paused: boolean;
  maxGroups: number;
  maxItems: number;
}

/** `QueryInferenceStorage.fundingIn`: the money funded for an epoch. */
export interface EpochFunding {
  wallet: bigint;
  account: bigint;
}

/** `QueryInferenceStorage.getEpochTotals`. */
export interface EpochTotals {
  totalServed: bigint;
  totalWeighted: bigint;
  lambdaBps: number;
}

/** `QueryInferenceStorage.getNodeEpoch`. */
export interface NodeEpoch {
  servedValue: bigint;
  weightedValue: bigint;
}

/** The current epoch's times at the latest block, from `Chronos`. */
export interface EpochTimes {
  epoch: number;
  startsAt: number;
  /** The next epoch's start. */
  endsAt: number;
  /** The latest block's time. */
  now: number;
}

/** An EIP-712 domain of the marketplace. */
export interface MarketplaceDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** The marketplace contracts, from the Hub, and the two signing domains. */
export interface MarketplaceContracts {
  chainId: number;
  serviceSubscriptions: string;
  serviceSubscriptionsWallet: string;
  serviceSubscriptionsStorage: string;
  queryInferenceSettlement: string;
  queryInferenceStorage: string;
  /** `DKGQueryInference` v1, over `QueryInferenceStorage`: requests and receipts. */
  requestDomain: MarketplaceDomain;
  /** `DKGServiceSubscriptions` v1, over `ServiceSubscriptions`: grants. */
  grantDomain: MarketplaceDomain;
}

/** `from`: the operational wallet that sends the transaction; the primary one by default. */
export interface MarketplaceWriteOptions {
  from?: string;
}

/**
 * The marketplace methods of `ChainAdapter`. All are optional: an adapter
 * without them has no marketplace. A contract's revert is thrown with its
 * custom error decoded (`err.revert.name`, `err.revert.args`), and a Hub
 * without the contracts throws `HubContractNotFoundError`.
 */
export interface MarketplaceChain {
  getMarketplaceContracts?(): Promise<MarketplaceContracts>;
  getEpochTimes?(): Promise<EpochTimes>;

  // ServiceSubscriptions: an account's owner.
  setServiceSpending?(accountId: bigint, enabled: boolean, opts?: MarketplaceWriteOptions): Promise<TxResult>;
  /** A party that sends the transaction consents by sending it, with an empty signature (`'0x'`). */
  addBuyer?(terms: BuyerGrantTerms, ownerSignature: string, buyerSignature: string, opts?: MarketplaceWriteOptions): Promise<TxResult>;
  removeBuyer?(accountId: bigint, buyer: string, opts?: MarketplaceWriteOptions): Promise<TxResult>;
  setBuyerLimits?(accountId: bigint, buyer: string, limits: BuyerLimits, opts?: MarketplaceWriteOptions): Promise<TxResult>;
  advanceGrantNonce?(accountId: bigint, opts?: MarketplaceWriteOptions): Promise<TxResult>;
  // ServiceSubscriptions: the buyer.
  /** The buyer's consent to `terms`, by the wallet `terms.buyer`: a 64-byte signature. Sends nothing. */
  signBuyerGrant?(terms: BuyerGrantTerms): Promise<{ digest: string; signature: string }>;
  fundFromAccount?(request: AccountFundingRequest, opts?: MarketplaceWriteOptions): Promise<SubscriptionFunding>;
  topUpFromAccount?(subscriptionId: string, additions: ServiceBudget[], planDigest: string, opts?: MarketplaceWriteOptions): Promise<SubscriptionTopUp>;
  previewCost?(accountId: bigint, value: bigint): Promise<{ cost: bigint; discountBps: number }>;
  currentWindowAllowance?(accountId: bigint): Promise<WindowAllowance>;
  // ServiceSubscriptionsWallet, and the Token allowance it pulls payments under.
  fundFromWallet?(request: WalletFundingRequest, opts?: MarketplaceWriteOptions): Promise<SubscriptionFunding>;
  topUpFromWallet?(subscriptionId: string, additions: ServiceBudget[], planDigest: string, opts?: MarketplaceWriteOptions): Promise<SubscriptionTopUp>;
  /** `Token.approve(ServiceSubscriptionsWallet, amount)`. */
  approveServiceSubscriptionsWallet?(amount: bigint, opts?: MarketplaceWriteOptions): Promise<TxResult>;
  /** `Token.allowance(owner, ServiceSubscriptionsWallet)`. */
  getServiceSubscriptionsWalletAllowance?(owner: string): Promise<bigint>;
  // ServiceSubscriptionsStorage.
  /** `null` when no subscription is recorded under the id. */
  getSubscription?(subscriptionId: string): Promise<Subscription | null>;
  getBudgets?(subscriptionId: string): Promise<ServiceBudget[]>;
  subscriptionExists?(subscriptionId: string): Promise<boolean>;
  /** `null` when the buyer was never granted on the account. */
  getGrant?(accountId: bigint, buyer: string): Promise<BuyerGrant | null>;
  grantEnd?(accountId: bigint, buyer: string, nonce: bigint): Promise<number>;
  grantNonce?(accountId: bigint): Promise<bigint>;
  getServiceSpending?(accountId: bigint): Promise<ServiceSpending>;
  maxBudgetsPerSubscription?(): Promise<number>;
  /** Every buyer ever granted on the account (`buyerCount`, `buyerAt`), in grant order. */
  getAccountBuyers?(accountId: bigint): Promise<string[]>;
  /** The accounts whose `BuyerAdded` events name `buyer`, ascending: those that granted it, revoked or not. */
  listBuyerAccounts?(buyer: string): Promise<bigint[]>;
  // QueryInferenceSettlement.
  /**
   * Sent from a registered operational wallet, as a random-sampling proof is.
   * Simulated first: a fault rejects with the revert and sends nothing. A
   * batch that is mined and reverts rejects with `receipt.status` 0.
   */
  submitReceiptBatch?(groups: ReceiptGroup[], opts?: ReceiptBatchSendOptions): Promise<ReceiptBatch>;
  /**
   * Send a batch's signed transaction again, as `onBroadcast` was given it: the same hash and nonce, so it lands
   * at most once. One the network already holds is no error; its outcome is read with `getReceiptBatchOutcome`.
   */
  rebroadcastReceiptBatch?(signedTx: string): Promise<void>;
  getReceiptBatchOutcome?(txHash: string): Promise<ReceiptBatchOutcome>;
  /**
   * The groups landed for the subscription (`ReceiptsLanded`, its id indexed),
   * oldest first, from `fromBlock` (the settlement's deployment by default) to
   * the head; `toBlock` is the head read, where the next read can start after.
   */
  listReceiptsLanded?(subscriptionId: string, fromBlock?: number): Promise<{ groups: LandedGroup[]; toBlock: number }>;
  budgetLeft?(subscriptionId: string, budgetIndex: number): Promise<bigint>;
  stakeFactor?(identityId: bigint): Promise<bigint>;
  epochPool?(epoch: number): Promise<bigint>;
  queryInferenceGross?(epoch: number, identityId: bigint): Promise<bigint>;
  // QueryInferenceStorage.
  batchState?(): Promise<BatchState>;
  nonceWord?(subscriptionId: string, identityId: bigint, word: bigint): Promise<bigint>;
  budgetUsed?(subscriptionId: string, budgetIndex: number): Promise<bigint>;
  fundingIn?(epoch: number): Promise<EpochFunding>;
  getEpochTotals?(epoch: number): Promise<EpochTotals>;
  getNodeEpoch?(identityId: bigint, epoch: number): Promise<NodeEpoch>;
  // ShardingTableStorage and RandomSamplingStorage.
  /**
   * `ShardingTableStorage.getNode(identityId).nodeId`, as hex; `null` when the
   * node is not in the table. A node whose profile `ensureProfile` created
   * registered 32 random bytes there, not its peer id.
   */
  getShardingTableNodeId?(identityId: bigint): Promise<string | null>;
  getNodeEpochScore?(epoch: number, identityId: bigint): Promise<bigint>;
  // A node's Core Node gate: ProfileStorage, ConvictionStakingStorage and ParametersStorage.
  profileExists?(identityId: bigint): Promise<boolean>;
  /** The node's V10 stake, the one the sharding table admits it by. */
  getNodeStake?(identityId: bigint): Promise<bigint>;
  /** The stake a node needs for a place in the sharding table. */
  getMinimumStake?(): Promise<bigint>;
  // ParametersStorage and the Token.
  /** `ParametersStorage.protocolTreasury()`: while it is wired, accounts cannot pay for services. */
  getProtocolTreasury?(): Promise<string>;
  /** A wallet's ETH and TRAC. */
  getWalletBalances?(address: string): Promise<{ eth: bigint; trac: bigint }>;
  /** How many of a wallet's transactions are mined: its next nonce at the latest block. */
  getMinedNonce?(address: string): Promise<number>;
  /** The latest block's base fee in wei; `null` on a chain without one. */
  getBaseFee?(): Promise<bigint | null>;
  // KnowledgeAssetsLifecycle: a seller's offer is a Knowledge Asset, kept by extending its lifetime.
  /**
   * `extendKnowledgeAssetLifetime(kaId, epochs, tokenAmount)`, from `opts.from` or else the wallet a publish
   * would pay from (gas, and the TRAC it costs), which pays the ask for the asset's bytes over `epochs` more
   * epochs (at least 1 wei), approved first. Anyone may extend any asset; no ACKs, no Conviction discount.
   */
  extendKnowledgeAssetLifetime?(kaId: bigint, epochs: number, opts?: MarketplaceWriteOptions): Promise<KnowledgeAssetExtension>;
}

/**
 * A chain adapter with the whole marketplace, the Conviction Account reads it
 * uses, and the node's identity: its id, the sharding table, which keys are an
 * identity's operational keys, the identity a wallet is an operational key of
 * (`IdentityStorage.getIdentityId`, the settlement's read of a batch's
 * sender), typed-data signing with its wallets, and a Knowledge Asset's
 * update context, whose end epoch an offer is valid through.
 */
export type MarketplaceChainAdapter = Required<MarketplaceChain> & Required<Pick<ChainAdapter,
  | 'getPublishingConvictionAccountInfo'
  | 'getConvictionAccountLockDurationEpochs'
  | 'getPublishingConvictionAgents'
  | 'listNodePublishingConvictionAccounts'
  | 'getPublishingConvictionContracts'
  | 'getIdentityId'
  | 'getIdentityIdForAddress'
  | 'isShardingTableMember'
  | 'verifyACKIdentityDetailed'
  | 'signTypedDataAs'
  | 'getKnowledgeAssetUpdateContext'
>>;

/** `chain` as a `MarketplaceChainAdapter`, or `null` when it has no marketplace (no chain). */
export function marketplaceChainOf(chain: ChainAdapter): MarketplaceChainAdapter | null {
  return typeof chain.getMarketplaceContracts === 'function'
    && typeof chain.getPublishingConvictionAccountInfo === 'function'
    ? chain as MarketplaceChainAdapter
    : null;
}

// ---------------------------------------------------------------------------
// EIP-712
// ---------------------------------------------------------------------------

export const REQUEST_DOMAIN_NAME = 'DKGQueryInference';
export const GRANT_DOMAIN_NAME = 'DKGServiceSubscriptions';

/** The domain of requests and receipts: its verifying contract is `QueryInferenceStorage`. */
export function requestDomain(chainId: number | bigint, queryInferenceStorage: string): MarketplaceDomain {
  return { name: REQUEST_DOMAIN_NAME, version: '1', chainId: Number(chainId), verifyingContract: ethers.getAddress(queryInferenceStorage) };
}

/** The domain of grants: its verifying contract is `ServiceSubscriptions`. */
export function grantDomain(chainId: number | bigint, serviceSubscriptions: string): MarketplaceDomain {
  return { name: GRANT_DOMAIN_NAME, version: '1', chainId: Number(chainId), verifyingContract: ethers.getAddress(serviceSubscriptions) };
}

/** `QueryInferenceSettlement.SERVICE_REQUEST_TYPEHASH`, field for field. */
export const SERVICE_REQUEST_TYPES = {
  ServiceRequest: [
    { name: 'subscriptionId', type: 'bytes32' },
    { name: 'serviceId', type: 'bytes32' },
    { name: 'seller', type: 'uint72' },
    { name: 'nonce', type: 'uint64' },
    { name: 'pricePerUnit', type: 'uint96' },
    { name: 'maxUnits', type: 'uint64' },
    { name: 'maxValueWei', type: 'uint96' },
    { name: 'issuedAt', type: 'uint40' },
    { name: 'expiry', type: 'uint40' },
  ],
};

/** `QueryInferenceSettlement.QUERY_INFERENCE_RECEIPT_TYPEHASH`, field for field. */
export const QUERY_INFERENCE_RECEIPT_TYPES = {
  QueryInferenceReceipt: [
    { name: 'requestDigest', type: 'bytes32' },
    { name: 'resultCommitment', type: 'bytes32' },
    { name: 'units', type: 'uint64' },
    { name: 'valueWei', type: 'uint96' },
    { name: 'completedAt', type: 'uint40' },
  ],
};

/** `ServiceSubscriptions.BUYER_GRANT_TYPEHASH`, field for field. */
export const BUYER_GRANT_TYPES = {
  BuyerGrant: [
    { name: 'accountId', type: 'uint256' },
    { name: 'buyer', type: 'address' },
    { name: 'maxCostPerEpoch', type: 'uint96' },
    { name: 'expiresAt', type: 'uint40' },
    { name: 'nonce', type: 'uint64' },
  ],
};

/** `QueryInferenceSettlement.hashRequest`: the digest the session key signs. */
export function hashServiceRequest(domain: MarketplaceDomain, request: ServiceRequest): string {
  return ethers.TypedDataEncoder.hash(domain, SERVICE_REQUEST_TYPES, request);
}

/** `QueryInferenceSettlement.hashReceipt`: the digest the seller signs, and batch digests are built from. */
export function hashQueryInferenceReceipt(domain: MarketplaceDomain, receipt: QueryInferenceReceipt): string {
  return ethers.TypedDataEncoder.hash(domain, QUERY_INFERENCE_RECEIPT_TYPES, receipt);
}

/** `ServiceSubscriptions.hashGrant`: the digest the owner and the buyer consent to. */
export function hashBuyerGrant(domain: MarketplaceDomain, terms: BuyerGrantTerms): string {
  return ethers.TypedDataEncoder.hash(domain, BUYER_GRANT_TYPES, terms);
}

/** `ServiceSubscriptions.subscriptionIdOf`: `keccak256(abi.encode(buyer, epoch))`, for a wallet or an account funding alike. */
export function subscriptionIdOf(buyer: string, epoch: number | bigint): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [buyer, epoch]));
}

/** keccak256 of receipt digests, concatenated in order: a group's `groupDigest` or a batch's `batchDigest`. */
export function receiptsDigest(receiptDigests: readonly string[]): string {
  return ethers.keccak256(ethers.concat(receiptDigests));
}

// ---------------------------------------------------------------------------
// Signatures: 64-byte EIP-2098, with a low s
// ---------------------------------------------------------------------------

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const S_MASK = (1n << 255n) - 1n;

/** The session key's signature over `request`: 64-byte EIP-2098, with a low s, as the settlement checks it. */
export function signServiceRequest(
  sessionKey: ethers.SigningKey | string,
  domain: MarketplaceDomain,
  request: ServiceRequest,
): string {
  const key = typeof sessionKey === 'string' ? new ethers.SigningKey(sessionKey) : sessionKey;
  return key.sign(hashServiceRequest(domain, request)).compactSerialized;
}

/** A 65-byte or 64-byte signature as 64-byte EIP-2098. Refuses a high s. */
export function compactSignature(signature: string): string {
  return ethers.Signature.from(signature).compactSerialized;
}

/**
 * The address a signature over `digest` recovers to, or `null` for one the
 * contracts refuse: neither 64 bytes (EIP-2098) nor 65, or with a high s.
 */
export function recoverSigner(digest: string, signature: string): string | null {
  if (!ethers.isHexString(signature, true)) return null;
  const bytes = ethers.getBytes(signature);
  if (bytes.length !== 64 && bytes.length !== 65) return null;
  const sWord = BigInt(ethers.hexlify(bytes.slice(32, 64)));
  if ((bytes.length === 64 ? sWord & S_MASK : sWord) > SECP256K1_HALF_N) return null;
  try {
    return ethers.recoverAddress(digest, signature);
  } catch {
    return null;
  }
}

/** A batch item: the request's own fields, the receipt's but its request digest, and the request's 64-byte signature. */
export function receiptItemOf(request: ServiceRequest, receipt: QueryInferenceReceipt, signature: string): ReceiptItem {
  const sig = ethers.getBytes(compactSignature(signature));
  return {
    nonce: request.nonce,
    pricePerUnit: request.pricePerUnit,
    maxUnits: request.maxUnits,
    maxValueWei: request.maxValueWei,
    issuedAt: request.issuedAt,
    expiry: request.expiry,
    units: receipt.units,
    valueWei: receipt.valueWei,
    resultCommitment: receipt.resultCommitment,
    completedAt: receipt.completedAt,
    sigR: ethers.hexlify(sig.slice(0, 32)),
    sigVS: ethers.hexlify(sig.slice(32, 64)),
  };
}

// ---------------------------------------------------------------------------
// Refused batches
// ---------------------------------------------------------------------------

/** `QueryInferenceSettlement.Fault`, in declaration order. */
export const RECEIPT_BATCH_FAULTS = [
  'None',
  'UnknownSubscription',
  'UnknownBudget',
  'OutsideEpoch',
  'EmptyGroup',
  'BelowMinCounted',
  'BadSignature',
  'InactiveGrant',
  'DuplicateNonce',
  'OutsideTime',
  'PriceOutOfRange',
  'BadArithmetic',
  'ZeroResultCommitment',
] as const;

export type ReceiptBatchFault = (typeof RECEIPT_BATCH_FAULTS)[number];

/**
 * The group or item a refused batch names: `GroupFault(groupIndex, fault)`
 * or `ReceiptFault(groupIndex, itemIndex, fault)`, with `itemIndex` `null`
 * for a group's fault. `null` for any other error.
 */
export function receiptBatchFaultOf(
  err: unknown,
): { groupIndex: number; itemIndex: number | null; fault: ReceiptBatchFault } | null {
  const name = enrichEvmError(err);
  if (name !== 'GroupFault' && name !== 'ReceiptFault') return null;
  const args = Array.from((err as { revert: { args: ArrayLike<unknown> } }).revert.args, Number);
  const fault = RECEIPT_BATCH_FAULTS[args[args.length - 1]!] ?? 'None';
  return { groupIndex: args[0]!, itemIndex: name === 'ReceiptFault' ? args[1]! : null, fault };
}
