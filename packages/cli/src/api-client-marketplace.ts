// OT-RFC-27 marketplace API-client methods, factored out of `api-client.ts`
// (which sits at its ratcheted file-size budget) the same way the entity
// search client is. Wire types mirror `daemon/routes/marketplace.ts`: every
// bigint crosses as a decimal string (the daemon serializer stringifies
// bigints; request wei/unit fields are parsed by `parseMarketplaceUint`).

type Get = <T>(path: string) => Promise<T>;
type Post = <T>(path: string, body: unknown) => Promise<T>;

export type MarketplaceServiceTypeWire = 'inference' | 'query' | 'reasoning' | 'graph-ml';
export type MarketplaceSettleActionWire = 'flush-receipts' | 'finalize' | 'claim' | 'roll';

export interface MarketplaceMeterStateWire {
  totalBudgetWei: string;
  softCeilingBps: number;
  totalSettledWei: string;
  totalReservedWei: string;
  buckets: Array<{ budgetWei: string; settledWei: string; reservedWei: string }>;
}

export interface MarketplaceStatusResponse {
  enabled: boolean;
  sellerReady: boolean;
  buyerReady: boolean;
  epoch?: string;
  settlementDeadline?: string;
  seller?: { offerings: number; pendingReceipts: number; submittedClaims: number };
  buyer?: { subscribed: boolean; epoch?: string; sessionKeyAddress?: string; meter?: MarketplaceMeterStateWire };
}

export interface MarketplaceOfferWire {
  offerId: string;
  sellerIdentityId: string;
  sellerPeerId: string;
  sellerAddress?: string;
  offeringId: string;
  serviceType: MarketplaceServiceTypeWire;
  modelId?: string;
  unit: 'token' | 'query-unit';
  askPerUnitWei: string;
  capacityUnitsPerMin?: string;
  expiresAt?: number;
}

/** JSON offering shape (config-file shape); wei fields are decimal strings. */
export interface MarketplaceOfferingWire {
  offeringLocalId: string;
  serviceType: MarketplaceServiceTypeWire;
  modelId?: string;
  unit: 'token' | 'query-unit';
  askPerUnitWei: string | number;
  capacityUnitsPerMin?: string | number;
  expiresAt?: number;
  executor?: 'stub-inference' | 'local-query';
}

export interface MarketplacePlanPolicyWire {
  totalBudgetWei: string | number;
  buckets: Array<{
    match: { serviceType: MarketplaceServiceTypeWire; modelId?: string };
    budgetWei: string | number;
    priceCapWeiPerUnit: string | number;
    maxUnitsPerCall: string | number;
  }>;
  sellerAllow?: Array<string | number>;
  sellerDeny?: Array<string | number>;
  softCeilingBps?: number;
}

interface MarketplaceReceiptWire {
  authDigest: string;
  servedUnits: string;
  receiptValueWei: string;
  resultCommitment: string;
  sellerSig: string;
}

export interface MarketplaceInvokeResponse {
  result: unknown;
  servedUnits: string;
  costWei: string;
  seller: { peerId: string; identityId: string; address: string };
  receipt: MarketplaceReceiptWire;
  authorization: Record<string, string>;
}

export interface MarketplaceSettleResponse {
  action: MarketplaceSettleActionWire;
  // flush-receipts: local submission counters.
  batches?: number;
  claims?: number;
  failedClaims?: number;
  /** Claims put back in the batcher after a transient submission failure. */
  requeuedClaims?: number;
  errors?: string[];
  // finalize / claim / roll: the mined transaction (+ claim's parsed reward).
  txHash?: string;
  blockNumber?: number;
  rewardWei?: string;
}

export function createMarketplaceClient(get: Get, post: Post) {
  return {
    status: () => get<MarketplaceStatusResponse>('/api/marketplace/status'),
    offers: () => get<{ offers: MarketplaceOfferWire[]; count: number }>('/api/marketplace/offers'),
    setOfferings: (body: { offerings: MarketplaceOfferingWire[]; publish?: boolean }) =>
      post<{ offerings: number; published: string[] }>('/api/marketplace/seller/offerings', body),
    subscribe: (body: {
      amountWei?: string;
      amountTrac?: string;
      epoch?: string | number;
      policy: MarketplacePlanPolicyWire;
    }) =>
      post<{
        epoch: string;
        sessionKeyAddress: string;
        amountWei: string;
        txHash: string;
        blockNumber: number;
      }>('/api/marketplace/subscribe', body),
    invoke: (body: {
      serviceType: MarketplaceServiceTypeWire;
      modelId?: string;
      payload: Record<string, unknown>;
      maxUnits?: string | number;
    }) => post<MarketplaceInvokeResponse>('/api/marketplace/invoke', body),
    meter: () => get<{ state?: MarketplaceMeterStateWire; summary?: string }>('/api/marketplace/meter'),
    settle: (body: { action: MarketplaceSettleActionWire; buyer?: string; epoch?: string | number }) =>
      post<MarketplaceSettleResponse>('/api/marketplace/settle', body),
  };
}
