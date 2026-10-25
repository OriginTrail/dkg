/**
 * Shared domain types for the OT-RFC-27 marketplace prototype. Everything
 * that crosses the buyer/seller/contract boundary lives here so the agent
 * runtime, the chain adapter, and tests agree on one vocabulary.
 *
 * Unit conventions (see the design doc "Units and precision"):
 *   - TRAC values are wei (1e18) as `bigint` (`uint96` funded / `uint256`
 *     accumulated on-chain).
 *   - Asks are wei per unit (`uint96`).
 *   - Units (tokens / query units) are `bigint` capped to `uint64`.
 *   - Identity ids are `bigint` capped to `uint72`.
 */

export type MarketplaceServiceType = 'inference' | 'query' | 'reasoning' | 'graph-ml';

export type MarketplaceUnit = 'token' | 'query-unit';

/** A seller offering as discovered from the marketplace Context Graph. */
export interface MarketplaceOffer {
  /** UAL of the offer Knowledge Asset. */
  offerId: string;
  /** Seller node identity (uint72). */
  sellerIdentityId: bigint;
  sellerPeerId: string;
  /** Seller operational wallet, when published. */
  sellerAddress?: string;
  /** bytes32 hex — `offeringIdFor(localOfferingName)`. */
  offeringId: string;
  serviceType: MarketplaceServiceType;
  modelId?: string;
  unit: MarketplaceUnit;
  /** Advertised ask in wei per unit (uint96); live quotes supersede it. */
  askPerUnitWei: bigint;
  capacityUnitsPerMin?: bigint;
  /** Unix seconds after which the offer is stale. */
  expiresAt?: number;
  region?: string;
  transports?: string[];
}

/** A live quote returned by a seller over the quote protocol. */
export interface MarketplaceQuote {
  offeringId: string;
  sellerIdentityId: bigint;
  available: boolean;
  askPerUnitWei: bigint;
  capacityUnitsPerMin?: bigint;
}

export interface PolicyBucketMatch {
  serviceType: MarketplaceServiceType;
  /** When set, the bucket only admits calls for this exact model. */
  modelId?: string;
}

/** One budget line of a buyer plan; indexes align with `MeterState.buckets`. */
export interface PolicyBucket {
  match: PolicyBucketMatch;
  budgetWei: bigint;
  priceCapWeiPerUnit: bigint;
  maxUnitsPerCall: bigint;
}

/** Buyer-side plan policy driving the router and the local meter. */
export interface PlanPolicy {
  totalBudgetWei: bigint;
  buckets: PolicyBucket[];
  /** Seller identityIds; when present, only these sellers are eligible. */
  sellerAllow?: bigint[];
  /** Seller identityIds that are never eligible. */
  sellerDeny?: bigint[];
  /** Serve stops once a bucket crosses this share of budget; default 9500. */
  softCeilingBps?: number;
}

/** The exact field set packed into the authorization digest (order matters). */
export interface AuthorizationFields {
  /** uint256 — block.chainid of the target chain. */
  chainId: bigint;
  /** The deployed Marketplace contract address. */
  marketplaceAddress: string;
  /** Funding wallet address — NOT the session key. */
  buyer: string;
  /** uint72 identity id of the authorized seller. */
  sellerIdentityId: bigint;
  /** bytes32 hex. */
  offeringId: string;
  /** bytes32 hex, buyer-generated, single-use. */
  callId: string;
  /** uint256 — Chronos epoch the bucket belongs to. */
  epoch: bigint;
  /** uint64 — implicit max receipt value is `maxUnits * askPerUnitWei`. */
  maxUnits: bigint;
  /** uint96 — the accepted ask, wei per unit. */
  askPerUnitWei: bigint;
  /** uint40 — unix seconds; authorization expiry. */
  expiry: bigint;
}

/** A session-key-signed, seller-specific bounded request authorization. */
export interface BoundedAuthorization extends AuthorizationFields {
  /** bytes32 hex — `computeAuthDigest(fields)`. */
  authDigest: string;
  /** 65-byte EIP-191 signature of `authDigest` by the session key. */
  signature: string;
}

/** Seller-signed usage receipt returned with each served result. */
export interface QueryInferenceReceipt {
  /** bytes32 hex of the authorization this receipt settles against. */
  authDigest: string;
  /** uint64. */
  servedUnits: bigint;
  /** uint256 — `servedUnits * askPerUnitWei`. */
  receiptValueWei: bigint;
  /** bytes32 hex — sha256 of the raw result bytes. */
  resultCommitment: string;
  /** 65-byte EIP-191 signature of the receipt digest (operational wallet). */
  sellerSig: string;
}

/** One claim of `Marketplace.submitReceiptBatch(ReceiptClaim[])`. */
export interface ReceiptClaimInput {
  buyer: string;
  epoch: bigint;
  offeringId: string;
  callId: string;
  maxUnits: bigint;
  askPerUnitWei: bigint;
  expiry: bigint;
  servedUnits: bigint;
  resultCommitment: string;
  /** The buyer authorization signature (65 bytes hex). */
  authSignature: string;
}

/** Per-bucket meter line; wei throughout. */
export interface MeterBucketState {
  budgetWei: bigint;
  settledWei: bigint;
  reservedWei: bigint;
}

/** Snapshot of the buyer meter; bucket indexes align with the plan policy. */
export interface MeterState {
  totalBudgetWei: bigint;
  softCeilingBps: number;
  totalSettledWei: bigint;
  totalReservedWei: bigint;
  buckets: MeterBucketState[];
}

/** Local delivery history used as the router tie-break, keyed by peer id. */
export interface DeliveryStats {
  successes: number;
  failures: number;
}

export interface RouteRequest {
  serviceType: MarketplaceServiceType;
  modelId?: string;
  /** uint64 — worst-case units the authorization will grant. */
  maxUnits: bigint;
  /** Injected clock (unix seconds) for offer-expiry checks. */
  nowSeconds: number;
  /** Optional delivery history by `sellerPeerId` for tie-breaking. */
  deliveryHistory?: ReadonlyMap<string, DeliveryStats>;
}

export type RouteRejectionReason =
  | 'service-mismatch'
  | 'model-mismatch'
  | 'offer-expired'
  | 'deny-list'
  | 'allow-list'
  | 'no-quote'
  | 'unavailable'
  | 'price-cap'
  | 'capacity'
  | 'soft-ceiling';

export interface RouteRejection {
  offerId: string;
  reason: RouteRejectionReason;
}

/**
 * Why no route exists. `no-offers` means discovery returned NOTHING for the
 * router to evaluate (typically the local node has not synced the marketplace
 * context graph yet) — distinct from `no-eligible-offer`, where offers were
 * seen but every one carries a rejection.
 */
export type RouteFailureReason = 'no-bucket' | 'max-units' | 'no-offers' | 'no-eligible-offer';

export type RouteDecision =
  | {
      ok: true;
      offer: MarketplaceOffer;
      /** The live (quoted) ask the authorization should carry. */
      askPerUnitWei: bigint;
      /** `maxUnits * askPerUnitWei` — the exposure the meter must reserve. */
      worstCaseCostWei: bigint;
      /** Index into `policy.buckets` / `meter.buckets`. */
      bucketIndex: number;
      rejections: RouteRejection[];
    }
  | {
      ok: false;
      reason: RouteFailureReason;
      rejections: RouteRejection[];
    };

/** JSON shape a persisted session key is stored under. */
export interface SessionKeyRecord {
  privateKey: string;
  address: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}
