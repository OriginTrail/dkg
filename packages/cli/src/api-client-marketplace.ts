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
  degraded?: string;
  epoch?: string;
  settlementDeadline?: string;
  seller?: {
    offerings: number;
    pendingReceipts: number;
    submittedClaims: number;
    connectors?: { mounted: number; failed: number; mounting: number };
  };
  buyer?: {
    subscribed: boolean;
    epoch?: string;
    sessionKeyAddress?: string;
    meter?: MarketplaceMeterStateWire;
    recount?: { sellers: number; deprioritized: number; denied: number };
  };
  /** The OpenAI-compatible buyer gateway (merged by the daemon). */
  gateway?: { enabled: boolean; basePath: string; keys: number; error?: string };
}

/** A gateway key as the admin routes return it (never the hash; plaintext only at mint). */
export interface MarketplaceGatewayKeyWire {
  keyId: string;
  scopes: {
    label: string;
    budgetWei: string;
    expiresAt: number | null;
    modelAllowlist: string[] | null;
    allowQuery: boolean;
    rps: number;
  };
  mintedAt: number;
  revokedAt: number | null;
  usage: {
    spentWei: string;
    reservedWei: string;
    calls: number;
    inferenceCalls: number;
    queryCalls: number;
    servedUnits: string;
    lastUsedAt: number | null;
  };
}

export interface MarketplaceGatewayKeyMintBody {
  label?: string;
  budgetWei?: string;
  budgetTrac?: string;
  expiresAt?: number;
  expiresInSeconds?: number;
  modelAllowlist?: string[] | null;
  allowQuery?: boolean;
  rps?: number;
}

export interface MarketplaceConnectorStatusWire {
  offeringLocalId: string;
  modelId: string;
  kind: 'openai-compatible' | 'llamacpp' | 'codex-oauth';
  state: 'mounting' | 'mounted' | 'failed';
  detail?: string;
  upstreamOrigin?: string;
  secretConfigured: boolean;
  metering: { basis: 'pinned' | 'provider-reported'; tokenizerKind?: string; tokenizerDigest?: string };
  weightsDigest?: string;
  health?: { ok: boolean; latencyMs: number; detail?: string; checkedAt: number };
}

export interface MarketplaceCodexLoginState {
  status: 'idle' | 'pending' | 'done' | 'error';
  authorizeUrl?: string;
  startedAt?: string;
  detail?: string;
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
  executor?: 'stub-inference' | 'local-query' | 'chat-connector';
  /** Chat connector; secrets are file PATHS (`secretEnvFile`, `authFile`), never values. */
  connector?: Record<string, unknown>;
  metering?: { tokenizer?: { kind: string; path?: string } };
  allowedBuyers?: string[];
  model?: { displayName?: string; family?: string; contextLength?: string; quantization?: string };
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
    meter: () => get<{
      state?: MarketplaceMeterStateWire;
      summary?: string;
      recount?: Array<Record<string, unknown> & { sellerIdentityId: string; standing: string }>;
    }>('/api/marketplace/meter'),
    settle: (body: { action: MarketplaceSettleActionWire; buyer?: string; epoch?: string | number }) =>
      post<MarketplaceSettleResponse>('/api/marketplace/settle', body),
    // Gateway keys (node-admin). The plaintext `key` exists only in the mint response.
    keys: () => get<{ keys: MarketplaceGatewayKeyWire[] }>('/api/marketplace/keys'),
    mintKey: (body: MarketplaceGatewayKeyMintBody) =>
      post<{ key: string; record: MarketplaceGatewayKeyWire }>('/api/marketplace/keys', body),
    revokeKey: (keyId: string) =>
      post<{ keyId: string; revokedAt: number }>(`/api/marketplace/keys/${encodeURIComponent(keyId)}/revoke`, {}),
    connectors: (opts: { probe?: boolean } = {}) =>
      get<{ connectors: MarketplaceConnectorStatusWire[] }>(
        `/api/marketplace/seller/connectors${opts.probe ? '?probe=1' : ''}`,
      ),
    codexLogin: (body: { authFile?: string } = {}) =>
      post<MarketplaceCodexLoginState>('/api/marketplace/seller/connectors/codex-oauth/login', body),
    codexLoginStatus: () => get<MarketplaceCodexLoginState>('/api/marketplace/seller/connectors/codex-oauth/login'),
    resetRecount: (sellerIdentityId: string) =>
      post<{ reset: boolean }>('/api/marketplace/recount/reset', { sellerIdentityId }),
  };
}
