// NSM marketplace API client — same-origin, bearer-authed (the node serves
// the UI; vite dev proxies /marketplace). Every shape mirrors what the plugin
// actually returns; nothing here invents data.
import { authHeaders, HttpError } from '../http.js';

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...authHeaders(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`, body);
  return body as T;
}

// ── operate/status (token/loopback) ──

export interface NsmBuyerSummary {
  tabId: string | null;
  address: string | null;
  transport: string | null;
  keyCount: number;
  totalBudgetMicroTrac: number;
  totalSpentMicroTrac: number;
}

export interface NsmKeyRecord {
  keyId: string;
  scopes: { budgetMicroTrac: number; expiresAt: string | null; modelAllowlist: string[] | null; allowQuery: boolean; rps: number };
  mintedAt: string;
  implicit?: boolean;
  revoked: boolean;
  spentMicroTrac: number;
}

export interface NsmOperateStatus {
  enabled: boolean;
  sellerActive: boolean;
  buyer: NsmBuyerSummary | null;
  offerings: Array<{
    id: string; provenanceClass: string; modelId: string; tokenizerBundleRef: string;
    pricing: { perInputTokenMicroTrac: number; perOutputTokenMicroTrac: number; queryFlatMicroTrac: number; perReturnedQuadMicroTrac: number };
    offeringUal: string | null;
  }>;
  tabs: Array<{ tabId: string; principal: string; depositMicroTrac: number; quantities: { billed: number; released: number; balance: number } }>;
  legs: Array<{ legId: string; legType: string; tabId: string; offeringId: string; provenanceClass: string; cost: number; status: string; at: string }>;
  threshold: { unsettledEarnedMicroTrac: number; maySettle?: boolean; thresholdMicroTrac?: number };
  keys: NsmKeyRecord[];
}

export const fetchOperateStatus = () => req<NsmOperateStatus>('/marketplace/operate/status');

// ── buyer actions (loopback/token) ──

export interface NsmWallet {
  configured: boolean;
  address?: string;
  tracMicro?: number;
  ethWei?: string;
  tabId?: string | null;
  rpcError?: string;
  quoteProvider?: string | null;
  quoteVerified?: boolean;
}

export const fetchBuyerWallet = () => req<NsmWallet>('/marketplace/buyer/wallet');

export const postBuyerFund = (amountMicroTrac: number) =>
  req<{ txHash?: string; error?: string; detail?: unknown }>('/marketplace/buyer/fund', {
    method: 'POST', body: JSON.stringify({ amountMicroTrac }),
  });

export interface NsmFundStatus {
  state: 'none' | 'confirming' | 'funded' | 'error' | 'offline';
  txHash?: string;
  tabId?: string | null;
  error?: string;
  detail?: string;
}

export const fetchFundStatus = () => req<NsmFundStatus>('/marketplace/buyer/fund/status');

// ── gateway keys (loopback) ──

export const mintGatewayKey = (scopes: { label?: string; budgetMicroTrac: number; modelAllowlist?: string[] | null; allowQuery?: boolean; rps?: number; expiresAt?: string | null }) =>
  req<{ key: string; record: { keyId: string } }>('/marketplace/gateway/v1/keys', {
    method: 'POST', body: JSON.stringify(scopes),
  });

export const revokeGatewayKey = (keyId: string) =>
  req<{ revoked: string }>(`/marketplace/gateway/v1/keys/${keyId}/revoke`, { method: 'POST' });

/** The gateway base agents paste — same origin the UI is served from. */
export function gatewayBaseUrl(): string {
  return `${window.location.origin}/marketplace/gateway/v1`;
}

// ── KPI clock (spec 01: first_run_started → first_verified) ──

const KPI_START = 'nsm.kpi.firstRunStarted';
const KPI_DONE = 'nsm.kpi.firstVerified';

export function kpiMarkStart(): void {
  if (!localStorage.getItem(KPI_START)) localStorage.setItem(KPI_START, String(Date.now()));
}
export function kpiMarkVerified(): void {
  if (localStorage.getItem(KPI_START) && !localStorage.getItem(KPI_DONE)) {
    localStorage.setItem(KPI_DONE, String(Date.now()));
  }
}
export function kpiElapsedMmss(): string | null {
  const a = Number(localStorage.getItem(KPI_START));
  const b = Number(localStorage.getItem(KPI_DONE));
  if (!a || !b || b < a) return null;
  const s = Math.floor((b - a) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
