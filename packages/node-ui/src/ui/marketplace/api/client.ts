// The section's one data source: the node's marketplace routes under
// /api/marketplace, sent with the token the node UI already uses for /api, and
// the gateway under /api/marketplace/v1, sent with an access key and nothing
// else. The gateway refuses a node or agent token, so this module never puts
// one on a gateway call.
import { authHeaders } from '../../http.js';
import type {
  AccountsAnswer, ActivityAnswer, BuyerLimits, CatalogAnswer, ChatCompletion, Consent, Contracts, FundedAnswer,
  Funding, FundingRequest, GatewayModels, GatewayRefusalBody, Key, KeyRequest, KeysAnswer, LandNowAnswer, MadeKey,
  Offering, Plan, PlanRequest, Preview, ReconciliationAnswer, SellerStatus, ServiceDetail, ServiceRequest,
  Storefront, SubscriptionsAnswer, Tx,
} from './types.js';

const MARKETPLACE_BASE = '/api/marketplace';
export const GATEWAY_BASE = `${MARKETPLACE_BASE}/v1`;

/** An access key's secret, as `POST /keys` makes it. */
export const ACCESS_KEY_RE = /^dkgmk_[0-9a-f]{48}$/;

type GatewayExtra = Omit<GatewayRefusalBody, 'error'>;

/** A refusal, in either of the node's shapes, or no answer at all (status 0). */
export class MarketplaceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly args: string[];
  readonly retryable: boolean;
  /** Seconds to wait before trying again, from `Retry-After`. */
  readonly retryAfter: number | null;
  /** The gateway's fields beside its error: the service, what is left, the fork, the seller's code. */
  readonly extra: GatewayExtra;
  readonly body: unknown;
  constructor(init: { status: number; code: string; message: string; args?: string[]; retryable: boolean; retryAfter?: number | null; extra?: GatewayExtra; body?: unknown }) {
    super(init.message);
    this.name = 'MarketplaceError';
    this.status = init.status;
    this.code = init.code;
    this.args = init.args ?? [];
    this.retryable = init.retryable;
    this.retryAfter = init.retryAfter ?? null;
    this.extra = init.extra ?? {};
    this.body = init.body;
  }
}

export const isMarketplaceError = (e: unknown): e is MarketplaceError => e instanceof MarketplaceError;

/** Whether a refusal says the marketplace (or selling) is off on this node. */
export const isMarketplaceOff = (e: unknown): boolean => isMarketplaceError(e) && e.code === 'MarketplaceOff';

/** Whether a refusal needs the node-admin token. */
export const needsNodeAdmin = (e: unknown): boolean => isMarketplaceError(e) && e.code === 'NodeAdminRequired';

function retryAfterOf(header: string | null): number | null {
  if (!header) return null;
  const s = Number(header);
  return Number.isFinite(s) && s >= 0 ? Math.ceil(s) : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The error a refused answer carries: `{ error: { code, message } , …}` from the gateway, `{ error, code, args, retryable }` from the rest. */
export function errorOf(status: number, body: unknown, retryAfterHeader: string | null = null): MarketplaceError {
  const retryAfter = retryAfterOf(retryAfterHeader);
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') {
    const { error, ...extra } = body as unknown as GatewayRefusalBody;
    return new MarketplaceError({
      status, code: error.code, message: error.message ?? error.code, retryAfter, extra: extra as GatewayExtra, body,
      retryable: extra.retry ?? (status === 503 || status === 0),
    });
  }
  if (isRecord(body) && typeof body.error === 'string') {
    const code = typeof body.code === 'string' ? body.code : status === 404 ? 'NotFound' : status === 401 ? 'Unauthorized' : `HTTP_${status}`;
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    return new MarketplaceError({
      status, code, message: body.error, args, retryAfter, body,
      retryable: typeof body.retryable === 'boolean' ? body.retryable : status >= 500,
    });
  }
  return new MarketplaceError({ status, code: `HTTP_${status}`, message: `HTTP ${status}`, retryable: status >= 500, retryAfter, body });
}

function offline(err: unknown): MarketplaceError {
  return new MarketplaceError({ status: 0, code: 'Offline', message: err instanceof Error ? err.message : String(err), retryable: true });
}

async function answerOf<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw errorOf(res.status, body, res.headers.get('Retry-After'));
  return body as T;
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${MARKETPLACE_BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (err) {
    throw offline(err);
  }
  return answerOf<T>(res);
}

const queryOf = (q: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** The node's marketplace routes. Reads take any valid token; the rest need the node-admin token. */
export const marketplaceApi = {
  catalog: () => call<CatalogAnswer>('GET', '/catalog'),
  service: (serviceId: string) => call<ServiceDetail>('GET', `/services/${serviceId}`),
  seller: (identityId: number) => call<Storefront>('GET', `/sellers/${identityId}`),
  /** This and the next epoch's subscriptions, or one epoch's. */
  subscriptions: (epoch?: number) => call<SubscriptionsAnswer>('GET', `/subscriptions${queryOf({ epoch })}`),
  preview: (request: FundingRequest) => call<Preview>('POST', '/subscriptions/preview', request),
  fund: (request: FundingRequest) => call<FundedAnswer>('POST', '/subscriptions', request),
  topUp: (subscriptionId: string, services: ServiceRequest[]) => call<FundedAnswer>('POST', `/subscriptions/${subscriptionId}/top-up`, { services }),
  /** The standing plan; null while there is none. */
  plan: async (): Promise<Plan | null> => {
    try {
      return await call<Plan>('GET', '/plan');
    } catch (err) {
      if (isMarketplaceError(err) && err.code === 'PlanNotFound') return null;
      throw err;
    }
  },
  savePlan: (plan: PlanRequest) => call<Plan>('PUT', '/plan', plan),
  funding: () => call<Funding>('GET', '/funding'),
  accounts: () => call<AccountsAnswer>('GET', '/accounts'),
  contracts: () => call<Contracts>('GET', '/accounts/contracts'),
  buyerConsent: (accountId: string, limits: BuyerLimits) => call<Consent>('POST', `/accounts/${accountId}/buyer-consent`, limits),
  serviceSpending: (accountId: string, enabled: boolean) => call<Tx>('POST', `/accounts/${accountId}/service-spending`, { enabled }),
  addBuyer: (accountId: string, body: BuyerLimits & { buyer?: string; buyerSignature?: string }) => call<Tx>('POST', `/accounts/${accountId}/buyers`, body),
  setBuyerLimits: (accountId: string, buyer: string, limits: BuyerLimits) => call<Tx>('POST', `/accounts/${accountId}/buyers/${buyer}/limits`, limits),
  removeBuyer: (accountId: string, buyer: string) => call<Tx>('DELETE', `/accounts/${accountId}/buyers/${buyer}`),
  /** The gateway's calls in an epoch (this one by default), for one key or all. */
  activity: (q: { epoch?: number; key?: string } = {}) => call<ActivityAnswer>('GET', `/activity${queryOf(q)}`),
  reconciliation: (epoch?: number) => call<ReconciliationAnswer>('GET', `/reconciliation${queryOf({ epoch })}`),
  keys: () => call<KeysAnswer>('GET', '/keys'),
  makeKey: (request: KeyRequest) => call<MadeKey>('POST', '/keys', request),
  revokeKey: (keyId: string) => call<Key>('POST', `/keys/${encodeURIComponent(keyId)}/revoke`, {}),
  sellerStatus: () => call<SellerStatus>('GET', '/seller'),
  landNow: () => call<LandNowAnswer>('POST', '/seller/land', {}),
  setNextPrice: (serviceId: string, price: string) => call<Offering>('PUT', `/seller/offerings/${serviceId}/price`, { price }),
};

export interface ChatRequest { model: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; max_tokens?: number }

async function gatewayCall<T>(method: 'GET' | 'POST', path: string, secret: string, body?: unknown): Promise<T> {
  // Only an access key goes to the gateway: never the node's token, which it would refuse.
  if (!ACCESS_KEY_RE.test(secret)) throw new MarketplaceError({ status: 0, code: 'missing_key', message: 'an access key is needed', retryable: false });
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_BASE}${path}`, { method, headers, credentials: 'omit', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (err) {
    throw offline(err);
  }
  return answerOf<T>(res);
}

/** The gateway, OpenAI-compatible: the services this epoch's subscription funds, and a chat call. */
export const marketplaceGateway = {
  models: (secret: string) => gatewayCall<GatewayModels>('GET', '/models', secret),
  chat: (secret: string, request: ChatRequest) => gatewayCall<ChatCompletion>('POST', '/chat/completions', secret, request),
};
