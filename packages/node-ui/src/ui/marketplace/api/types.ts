// The node's marketplace API (OT-RFC-27), under /api/marketplace: the shapes
// it answers with. Amounts are decimal strings of wei, each with a `…Trac`
// sibling in whole tokens (`…Ether` for ETH); times are chain seconds.

// ── catalog ─────────────────────────────────────────────────────────────────

/** The reference rate the catalog shows USD by; a null rate hides USD. */
export interface Fx { tracUsd: number | null; source: string; asOf: number | null }

/** This node's own measurements of a seller; null is "no data yet". */
export interface Measured { latencyMs: number | null; tokensPerSecond: number | null }

export type Provenance = 'weights-pinned' | 'upstream-claimed';

/** One seller's offer of a service in an epoch. */
export interface Offer {
  serviceId: string;
  /** The seller's identity id. */
  seller: number;
  epoch: number;
  unit: 'token';
  pricePerUnit: string;
  pricePerUnitTrac: string;
  /** The same seller's price for the next epoch, once it has one. */
  nextPricePerUnit?: string;
  nextPricePerUnitTrac?: string;
  provenance: Provenance;
  /** Its last quote's availability; null before any quote. */
  available: boolean | null;
  quotedAt?: number;
  measured: Measured;
}

/** A service's card: its offers, cheapest first, and what this epoch's subscription has left for it. */
export interface Service {
  serviceId: string;
  serviceClass: 'inference' | 'query';
  /** The model's URN: the node has no other name for it yet. */
  label: string;
  offers: Offer[];
  priceMin: string;
  priceMinTrac: string;
  priceMax: string;
  priceMaxTrac: string;
  /** Present when this epoch's subscription funds the service: its budget's value left, less what the node holds. */
  covered?: { left: string; leftTrac: string };
}

export interface CatalogAnswer { epoch: number; fx: Fx; services: Service[] }

/** A node's Core Node gate. */
export interface Gate {
  profile: boolean;
  shardingTable: boolean;
  stake: string;
  stakeTrac: string;
  minimumStake: string;
  minimumStakeTrac: string;
}

export interface SellerEpoch {
  epoch: number;
  servedValue: string;
  servedValueTrac: string;
  weightedValue: string;
  weightedValueTrac: string;
}

/** One seller's storefront. */
export interface Storefront {
  identityId: number;
  gate: Gate;
  stakeFactor18: string;
  available: boolean | null;
  offers: Offer[];
  /** Served value in recent epochs, newest first. */
  recent: SellerEpoch[];
}

export interface ServiceDetail extends Service { fx: Fx; sellers: Storefront[] }

// ── subscriptions, plan, funding ────────────────────────────────────────────

export type Source = { kind: 'wallet' } | { kind: 'account'; accountId: string; discountBps: number };

/** One service's budget in a subscription. */
export interface Budget {
  budgetIndex: number;
  serviceId: string;
  /**
   * As the chain stored it, where the node names it: a top-up repeats it
   * exactly, whatever the catalog says of the service now. A node that does
   * not name it leaves the catalog to say.
   */
  serviceClass?: 'inference' | 'query';
  value: string;
  valueTrac: string;
  maxPricePerUnit: string;
  maxPricePerUnitTrac: string;
  /** Landed on chain. */
  used: string;
  usedTrac: string;
  /** Receipts this node holds that have not landed. */
  held: string;
  heldTrac: string;
  left: string;
  leftTrac: string;
  /** Calls stop here: 95% of the value. */
  softCeiling: string;
  softCeilingTrac: string;
}

export interface Subscription {
  subscriptionId: string;
  epoch: number;
  startsAt: number;
  endsAt: number;
  source: Source;
  value: string;
  valueTrac: string;
  cost: string;
  costTrac: string;
  sessionKey: string;
  budgets: Budget[];
}

export interface SubscriptionsAnswer { subscriptions: Subscription[] }

/** A dry run of a funding: its cost and discount, and the refusal it would meet. */
export interface Preview {
  epoch: number;
  source: Source;
  value: string;
  valueTrac: string;
  cost: string;
  costTrac: string;
  discountBps: number;
  refusal?: { code: string; args: string[] };
}

export interface Tx { txHash: string; blockNumber: number }

/** A funding or top-up that was sent; `subscription` is null while the read lags the send. */
export interface FundedAnswer extends Tx { subscription: Subscription | null }

/**
 * A top-up that went through. A repeat of its key gets the first answer; one
 * whose first answer was lost, once the budgets show the top-up, names no
 * transaction (`txHash` and `blockNumber` null).
 */
export interface TopUpAnswer { txHash: string | null; blockNumber: number | null; subscription: Subscription | null }

export interface PlanService {
  serviceId: string;
  serviceClass: 'inference' | 'query';
  value: string;
  valueTrac: string;
  maxPricePerUnit: string;
  maxPricePerUnitTrac: string;
  pinnedSeller?: number;
}

/** The standing plan and its next renewal. */
export interface Plan {
  services: PlanService[];
  source: Source;
  renew: boolean;
  renewUntilEpoch?: number;
  next?: { epoch: number; at: number; cost: string; costTrac: string; refusal?: string };
}

export interface Grant {
  buyer: string;
  maxCostPerEpoch: string;
  maxCostPerEpochTrac: string;
  expiresAt: number;
  revokedAt: number;
  live: boolean;
}

export interface Account {
  accountId: string;
  ownedByNode: boolean;
  serviceCapable: boolean;
  refusal?: string;
  discountBps: number;
  window: {
    index: number;
    baseRemaining: string;
    baseRemainingTrac: string;
    topUpBuffer: string;
    topUpBufferTrac: string;
    expired: boolean;
  };
  /** The grant to this node's buyer wallet. */
  grant?: Grant;
  buyerWallets: Grant[];
  publisherWallets: string[];
}

/**
 * `accountsPending`: the node was still reading the account list, and `accounts` is the list it read last.
 * `accountsError`: why the last read that finished failed, when it did and none has succeeded since.
 */
export interface AccountsAnswer { accounts: Account[]; accountsPending?: boolean; accountsError?: string }

export interface Funding {
  buyerWallet: {
    address: string;
    eth: string;
    ethEther: string;
    trac: string;
    tracTrac: string;
    walletContractAllowance: string;
    walletContractAllowanceTrac: string;
  };
  accounts: Account[];
  /** The node was still reading the account list: `accounts` is the list it read last, and may be empty. */
  accountsPending?: boolean;
  /** Why the node's last account-list read that finished failed, when it did and none has succeeded since. */
  accountsError?: string;
  epoch: number;
  epochEndsAt: number;
}

export interface Contracts {
  chainId: number;
  buyerWallet: string;
  addresses: Record<
    'ServiceSubscriptions' | 'ServiceSubscriptionsWallet' | 'ServiceSubscriptionsStorage'
    | 'QueryInferenceSettlement' | 'QueryInferenceStorage' | 'DKGPublishingConvictionNFT' | 'Token',
    string
  >;
  grantDomain: { name: string; version: string; chainId: number; verifyingContract: string };
  grantTypes: { BuyerGrant: Array<{ name: string; type: string }> };
}

export interface Consent {
  terms: { accountId: string; buyer: string; maxCostPerEpoch: string; expiresAt: number; nonce: string };
  digest: string;
  buyerSignature: string;
}

// ── activity, reconciliation, keys ──────────────────────────────────────────

/** A call through the gateway. */
export interface Call {
  callId: string;
  /** When the seller completed it. */
  at: number;
  serviceId: string;
  seller: number;
  keyId: string;
  units: number;
  value: string;
  valueTrac: string;
  state: 'held' | 'landed' | 'missed';
}

export interface ActivityAnswer { calls: Call[] }

/** A seller on a budget: the receipts this node holds against those landed and counted. */
export interface Reconciled {
  subscriptionId: string;
  budgetIndex: number;
  serviceId: string;
  seller: number;
  held: { count: number; value: string; valueTrac: string };
  landed: { count: number; matched: number; value: string; valueTrac: string; counted: string; countedTrac: string; txs: string[] };
}

export interface ReconciliationAnswer { epoch: number; final: boolean; rows: Reconciled[] }

/** An access key, never with its secret. Budget, spent and reserved are wei. */
export interface Key {
  keyId: string;
  label: string;
  budget: string;
  spent: string;
  /**
   * Held for calls whose receipts have not settled: an unanswered call at its
   * most, until its epoch is final. The gateway takes a call only while spent,
   * reserved and the call's most value stay within the budget.
   */
  reserved: string;
  /** The services it may call; null for every service the subscription funds. */
  services: string[] | null;
  rps: number;
  expiresAt: number | null;
  revoked: boolean;
  lastUsedAt: number | null;
}

export interface KeysAnswer { keys: Key[] }

/** A key just made: its secret, shown this once. */
export interface MadeKey extends Key { secret: string }

// ── seller ──────────────────────────────────────────────────────────────────

/** Why a seller's offer is not listed, or why its last publish or extension failed. */
export type ListingProblem =
  | 'not-core-node' | 'not-admitted' | 'no-trac' | 'no-ack-quorum' | 'graph-not-registered' | 'catalog-pending' | 'expired' | 'error';

/**
 * Whether a service's offer is in the catalog: published to Verifiable
 * Memory, valid this epoch, not withdrawn, its catalog record kept, and this
 * node a Core Node.
 */
export interface Listing {
  listed: boolean;
  kaId?: string;
  validUntilEpoch?: number;
  withdrawn?: boolean;
  problem?: ListingProblem;
  /** The node's own words for the problem. */
  message?: string;
  /** When a failed run is tried again, in chain seconds. */
  retryAt?: number;
}

/** One of the seller's services: its backend's state, this and the next epoch's price, and whether its offer is listed. */
export interface Offering {
  serviceId: string;
  connector: 'up' | 'down';
  price: string;
  priceTrac: string;
  nextPrice: string;
  nextPriceTrac: string;
  /** Null when the node runs without the module that publishes offers. */
  listing: Listing | null;
}

export interface Batch {
  tx: string;
  at: number;
  items: number;
  value: string;
  valueTrac: string;
  counted: string;
  countedTrac: string;
  gasUsed: number;
}

export type LandingStop = 'not-serving' | 'end-margin' | 'not-due' | 'no-node-score' | 'base-fee' | 'nothing-ready' | 'not-active';

export type LandingReport =
  | { stopped: LandingStop }
  | {
      sent: Array<{ txHash: string; items: number; value: string; valueTrac: string; counted: string; countedTrac: string }>;
      refused: number;
      waiting: boolean;
    };

/** Operate. */
export interface SellerStatus {
  /** The epoch the status is for, and its start and end in chain seconds. */
  epoch: number;
  startsAt: number;
  endsAt: number;
  identityId: number;
  gate: Gate;
  scoredThisEpoch: boolean;
  wallets: Array<{ address: string; eth: string; ethEther: string }>;
  offerings: Offering[];
  ledger: {
    served: number;
    sent: number;
    landed: number;
    refused: number;
    missed: number;
    heldValue: string;
    heldValueTrac: string;
    landedValue: string;
    landedValueTrac: string;
    counted: string;
    countedTrac: string;
  };
  nextLandingAt: number;
  batches: Batch[];
  thisEpoch: {
    servedValue: string;
    servedValueTrac: string;
    weightedValue: string;
    weightedValueTrac: string;
    poolSoFar: string;
    poolSoFarTrac: string;
  };
  ended: Array<{ epoch: number; pool: string; poolTrac: string; gross: string; grossTrac: string }>;
  lastLanding: LandingReport | null;
}

export type LandNowAnswer =
  | { batches: Batch[]; stopped: LandingStop }
  | { batches: Batch[]; refused: number; waiting: boolean };

// ── the gateway ─────────────────────────────────────────────────────────────

export interface GatewayModels {
  object: 'list';
  data: Array<{ id: string; object: 'model'; owned_by: string; service_id: string }>;
}

/** What a call cost and who served it, beside the OpenAI answer. */
export interface Served {
  callId: string;
  serviceId: string;
  seller: number;
  units: number;
  value: string;
  valueTrac: string;
  budgetLeft: string;
  budgetLeftTrac: string;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
  usage: { total_tokens: number };
  marketplace: Served;
}

/** The gateway's refusal body. */
export interface GatewayRefusalBody {
  error: { code: string; message: string; type: 'marketplace' };
  serviceId?: string;
  left?: string;
  leftTrac?: string;
  nextEpochAt?: number;
  fork?: { topUp?: true; fund?: true; nextEpochAt?: number };
  sellerCode?: string;
  retry?: boolean;
  problem?: string;
}

/** Every other route's refusal body; a route that does not exist answers `{ error }` alone. */
export interface RefusalBody { error: string; code?: string; args?: string[]; retryable?: boolean }

// ── requests ────────────────────────────────────────────────────────────────

export type SourceRequest = { kind: 'wallet' } | { kind: 'account'; accountId: string };

export interface ServiceRequest {
  serviceId: string;
  serviceClass: 'inference' | 'query';
  /** Wei. */
  value: string;
  /** Wei per unit. */
  maxPricePerUnit: string;
  pinnedSeller?: number;
}

export interface FundingRequest { epoch: 'current' | 'next' | number; source: SourceRequest; services: ServiceRequest[] }

/**
 * A top-up of a subscription: what to add, and its key, a UUID v4 made once
 * per confirmed top-up. The node carries a key out once: a repeat of the
 * request gets the first answer, and the key with another body is refused
 * with IdempotencyKeyReused (409).
 */
export interface TopUpRequest { services: ServiceRequest[]; idempotencyKey: string }

export interface PlanRequest { services: ServiceRequest[]; source: SourceRequest; renew: boolean; renewUntilEpoch?: number }

export interface KeyRequest { label: string; budget: string; services?: string[] | null; rps?: number; expiresAt?: number | null }

export interface BuyerLimits { maxCostPerEpoch: string; expiresAt: number }
