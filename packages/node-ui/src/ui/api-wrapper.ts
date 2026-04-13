import * as realApi from './api.js';
import { mockApi } from './mocks/provider.js';

let useMocks: boolean | null = null;
let detectMockModePromise: Promise<boolean> | null = null;

function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = (window as any).__DKG_TOKEN__;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function detectMockMode(): Promise<boolean> {
  if (useMocks !== null) return useMocks;
  if (detectMockModePromise) return detectMockModePromise;
  detectMockModePromise = (async () => {
    try {
      const resp = await fetch('/api/status', {
        headers: authHeaders(),
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        useMocks = false;
      } else if (resp.status === 401) {
        useMocks = false;
      } else {
        useMocks = true;
      }
    } catch {
      useMocks = true;
    }
    return useMocks;
  })();
  try {
    return await detectMockModePromise;
  } finally {
    detectMockModePromise = null;
  }
}

async function withFallback<T>(realFn: () => Promise<T>, mockFn: () => Promise<T>): Promise<T> {
  const mock = await detectMockMode();
  if (mock) return mockFn();
  return realFn();
}

export const api = {
  fetchStatus: () => withFallback(realApi.fetchStatus, mockApi.fetchStatus),
  fetchMetrics: () => withFallback(realApi.fetchMetrics, mockApi.fetchMetrics),
  fetchAgents: () => withFallback(realApi.fetchAgents, mockApi.fetchAgents),
  fetchContextGraphs: () => withFallback(realApi.fetchContextGraphs, mockApi.fetchContextGraphs),
  fetchOperationsWithPhases: (p?: any) => withFallback(() => realApi.fetchOperationsWithPhases(p), mockApi.fetchOperationsWithPhases),
  fetchEconomics: () => withFallback(realApi.fetchEconomics, mockApi.fetchEconomics),
  fetchNotifications: (p?: any) => withFallback(() => realApi.fetchNotifications(p), mockApi.fetchNotifications),
  fetchNodeLog: (p?: any) => withFallback(() => realApi.fetchNodeLog(p), mockApi.fetchNodeLog),
  fetchMemorySessions: (n?: number) => withFallback(() => realApi.fetchMemorySessions(n), mockApi.fetchMemorySessions),
  markNotificationsRead: realApi.markNotificationsRead,
  executeQuery: realApi.executeQuery,
};
