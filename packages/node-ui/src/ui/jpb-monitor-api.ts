import { authHeaders, BASE, fetchWithTimeout, HttpError } from './http.js';

export interface JpbMonitorStatus {
  enabled: boolean;
  ownerAddress: string;
  minIntervalMs: number;
  maxOrders: number;
  maxBatchSize: number;
  mode: string;
}

type MonitorTime = string | number;
export interface JpbMonitorBatch {
  id: string;
  orderNos: string[];
  status: string;
  recordCount?: number;
  mappedSourceCount?: number;
  dataKaCount?: number;
  snapshotRevision?: string;
  graphId?: string;
  fetchedAt?: MonitorTime;
  verifiedAt?: MonitorTime;
  lastSuccessAt?: MonitorTime;
  missingOrderNos?: string[];
  matchedOrderCount?: number;
  error?: { code: string };
}

export interface JpbMonitorFetch {
  status: 'accepted' | 'completed';
  requestId: string;
  contextGraphId: string;
  executionIri: string;
  requestAssetName: string;
  resultAssetName?: string;
}

export interface JpbMonitorJob {
  id: string;
  revision: number;
  orderNos: string[];
  intervalMs: number;
  batchSize: number;
  status: 'active' | 'paused';
  running: boolean;
  lastAttemptAt?: MonitorTime;
  lastFetchAt?: MonitorTime;
  lastSuccessAt?: MonitorTime;
  lastCompletedAt?: MonitorTime;
  lastRefreshStatus?: string;
  coverage?: { selectedOrders: number; returnedOrders?: number; notReturnedOrders: number; notReturnedOrderNos: string[]; checkedAt?: MonitorTime; complete: boolean };
  nextDueAt?: MonitorTime;
  lastError?: { code: string };
  freshness?: 'never' | 'fresh' | 'partial' | 'stale';
  programsMode?: 'data-only';
  fetchProgramKaCount?: number;
  fetch?: JpbMonitorFetch;
  contextGraphId?: string;
  graphLayout?: 'jpb-data-v1';
  batches: JpbMonitorBatch[];
}

export interface JpbMonitorConfig {
  orderNos: string[];
  intervalMs: number;
  batchSize: number;
}

// Same-origin daemon auth only. The daemon plugin holds the SQL-sidecar
// credential; neither that secret nor a caller-selected upstream reaches UI.
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchWithTimeout(`${BASE}/api/jpb-monitor${path}`, {
    method,
    headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => undefined);
    throw new HttpError(response.status, `HTTP ${response.status}`, error);
  }
  return response.json() as Promise<T>;
}

export const fetchJpbMonitorStatus = () => request<JpbMonitorStatus>('/status');
export const fetchJpbMonitorJobs = () => request<{ jobs: JpbMonitorJob[] }>('/jobs');
export const createJpbMonitorJob = (config: JpbMonitorConfig) => request<{ job: JpbMonitorJob }>('/jobs', 'POST', config);
export const updateJpbMonitorJob = (id: string, config: Pick<JpbMonitorConfig, 'orderNos' | 'intervalMs'>, expectedRevision: number) =>
  request<{ job: JpbMonitorJob }>(`/jobs/${encodeURIComponent(id)}`, 'PATCH', { ...config, expectedRevision });
export const actOnJpbMonitorJob = (id: string, action: 'pause' | 'resume' | 'refresh', expectedRevision: number) =>
  request<{ job: JpbMonitorJob }>(`/jobs/${encodeURIComponent(id)}/${action}`, 'POST', { expectedRevision });

export function parseJpbMonitorConfig(
  orders: string, minutes: string, batchSize: string, limits: JpbMonitorStatus,
): JpbMonitorConfig {
  const orderNos = orders.trim().split(/[\s,]+/).filter(Boolean);
  const maxOrders = Math.min(1000, limits.maxOrders);
  if (orderNos.length === 0) throw new Error('Enter at least one JPB order number (NAF).');
  if (orderNos.length > maxOrders) throw new Error(`Choose at most ${maxOrders} orders per job.`);
  if (new Set(orderNos).size !== orderNos.length) throw new Error('Each order number must appear only once.');
  const intervalMs = Number(minutes) * 60_000;
  const minIntervalMs = Math.max(30 * 60_000, limits.minIntervalMs);
  if (!/^\d+$/.test(minutes) || !Number.isSafeInteger(intervalMs) || intervalMs < minIntervalMs) {
    throw new Error(`Use a whole number of minutes, at least ${Math.ceil(minIntervalMs / 60_000)}.`);
  }
  const parsedBatchSize = Number(batchSize);
  const maxBatchSize = Math.min(10, limits.maxBatchSize);
  if (!/^\d+$/.test(batchSize) || !Number.isSafeInteger(parsedBatchSize) || parsedBatchSize < 1 || parsedBatchSize > maxBatchSize) {
    throw new Error(`Use a batch size from 1 to ${maxBatchSize}.`);
  }
  if (Math.ceil(orderNos.length / parsedBatchSize) > 100) {
    throw new Error(`Use a batch size of at least ${Math.ceil(orderNos.length / 100)} for this order selection (at most 100 SQL batches).`);
  }
  return { orderNos, intervalMs, batchSize: parsedBatchSize };
}

export function monitorErrorCode(error: { code?: unknown } | undefined): string | undefined {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : undefined;
}

export function describeJpbMonitorError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 404) return 'JPB monitoring is not configured on this node.';
    if (error.status === 401 || error.status === 403) return 'Only the configured JPB owner or a node operator can manage these jobs.';
    if (error.status === 409) return 'This job changed. Refresh the list and choose Edit again before saving.';
    const code = monitorErrorCode(error.body as { code?: unknown } | undefined);
    return `The monitoring request failed (HTTP ${error.status}${code ? `, ${code}` : ''}). Try refreshing the list.`;
  }
  return 'The monitoring service could not be reached. Try refreshing the list.';
}
