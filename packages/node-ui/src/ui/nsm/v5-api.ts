// P5 subscription-rail API — mirrors packages/marketplace plugin routes.
// Same-origin (`/marketplace/*`; vite dev proxies to the node under
// DKG_UI_HOME). Every shape mirrors what the plugin actually returns.
import { authHeaders } from '../http.js';

async function req<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export interface V5Allowance {
  planId: string; offeringId: string; seller: string;
  unit: 'tokens' | 'query-units';
  guaranteedUnits: number; consumedUnits: number;
  state: 'active' | 'exhausted' | 'expired';
}

export interface V5Plan {
  planId: string; buyer: string; periodId: string; periodMs: number;
  startedAt: string; expiresAt: string; cycle: number;
  allocations: Array<{ offeringId: string; seller: string; unit: string;
    allocationMicroTrac: number; frozenAskMicroPerUnit: number }>;
}

export interface V5Activity {
  kind: string; at: string; planId: string;
  offeringId?: string; seller?: string; units?: number; keyId?: string; callId?: string;
  phase?: 'admission' | 'delivery';
}

export interface V5Statement {
  pair: string; periodId: string;
  items: Array<{ offeringId: string; unit: string; buyerCount: number; sellerCount: number }>;
  resolution: 'agreed' | 'disputed' | 'resolved';
  resolutionDetail?: string;
}

export interface V5SubsStatus {
  plan: V5Plan | null;
  meters: V5Allowance[];
  summaryPct: number | null;
  activity: V5Activity[];
  freshness: Array<{ pair: string; agree: boolean; checkedAgoMs: number | null }>;
  statements: V5Statement[];
  keys: Array<{ keyId: string; scopes: { label?: string; budgetMicroTrac: number }; spentMicroTrac: number }>;
}

export const fetchSubsStatus = () => req<V5SubsStatus>('/marketplace/subs/status');

export const postTopUp = (b: { offeringId: string; seller: string; microTrac: number; tx: string }) =>
  req<{ addedUnits: number }>('/marketplace/subs/topup', { method: 'POST', body: JSON.stringify(b) });

export const postSwitch = (b: { offeringId: string; toSeller: string }) =>
  req<{ offeringId: string }>('/marketplace/subs/switch', { method: 'POST', body: JSON.stringify(b) });
