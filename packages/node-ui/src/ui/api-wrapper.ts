import * as realApi from './api.js';
import { mockApi } from './mocks/provider.js';

let useMocks: boolean | null = null;
let detectMockModePromise: Promise<boolean> | null = null;
const MOCK_MODE_DETECTION_TIMEOUT_MS = 5000;
const MOCK_MODE_DETECTION_ATTEMPTS = 2;
const MOCK_MODE_DETECTION_RETRY_MS = 250;

// Subscribers (e.g. the MockModeBanner) that want to know when the UI has
// fallen back to fabricated demo data so they can surface a visible indicator
// (GH #904). The previous fallback set only a `console.warn` + a
// `window.__DKG_USING_MOCKS__` flag — nothing the operator could see.
type MockModeListener = (usingMocks: boolean) => void;
const mockModeListeners = new Set<MockModeListener>();

/** Current mock-mode state (true once `/api/status` has failed detection). */
export function isUsingMocks(): boolean {
  return useMocks === true;
}

/**
 * Subscribe to mock-mode changes; returns an unsubscribe fn. The listener is
 * invoked immediately with the current state so a subscriber can't miss a
 * detection that flipped `useMocks` to true between its snapshot read and this
 * call (Codex) — there is no transition gap to lose.
 */
export function subscribeMockMode(listener: MockModeListener): () => void {
  mockModeListeners.add(listener);
  listener(useMocks === true);
  return () => {
    mockModeListeners.delete(listener);
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeMockMode(): Promise<boolean> {
  for (let attempt = 1; attempt <= MOCK_MODE_DETECTION_ATTEMPTS; attempt += 1) {
    try {
      const resp = await realApi.apiFetch('/api/status', {
        cache: 'no-store',
        signal: AbortSignal.timeout(MOCK_MODE_DETECTION_TIMEOUT_MS),
      });
      if (resp.ok || resp.status === 401) {
        return false;
      }
    } catch {
      // Retry below; a single transient timeout/proxy hiccup should not latch demo data.
    }
    if (attempt < MOCK_MODE_DETECTION_ATTEMPTS) {
      await delay(MOCK_MODE_DETECTION_RETRY_MS);
    }
  }
  return true;
}

async function detectMockMode(): Promise<boolean> {
  if (useMocks !== null) return useMocks;
  if (detectMockModePromise) return detectMockModePromise;
  detectMockModePromise = (async () => {
    useMocks = await probeMockMode();
    // Observability: surface the silent demo-data fallback so operators — and
    // the e2e suite's mock-mode guard (fixtures/base.ts) — can tell the UI is
    // NOT showing live node state. Without this flag the swap to fabricated
    // fixtures is completely invisible, which is a false-positive trap for any
    // assertion made against the rendered data.
    if (typeof window !== 'undefined') {
      (window as { __DKG_USING_MOCKS__?: boolean }).__DKG_USING_MOCKS__ = useMocks;
      if (useMocks) {
        console.warn(
          '[dkg-ui] /api/status unreachable (timeout/5xx/network) — falling back to demo (mock) data. The UI is NOT showing live node state.',
        );
      }
    }
    // Notify React subscribers so a visible demo-data indicator can render
    // (GH #904) — the flag/console.warn alone are invisible to the operator.
    mockModeListeners.forEach((listener) => listener(useMocks as boolean));
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
  fetchWalletsBalances: () => withFallback(realApi.fetchWalletsBalances, mockApi.fetchWalletsBalances),
  fetchCurrentAgent: () => withFallback(realApi.fetchCurrentAgent, mockApi.fetchCurrentAgent),
  listParticipants: (id: string) => withFallback(() => realApi.listParticipants(id), () => mockApi.listParticipants(id)),
  fetchSubGraphs: (id: string) => withFallback(() => realApi.fetchSubGraphs(id), () => mockApi.fetchSubGraphs(id)),
  // Scoped notifications pane feed (useNotificationsFeed consumes this).
  fetchNotificationsFeed: () => withFallback(realApi.fetchNotificationsFeed, mockApi.fetchNotificationsFeed),
  fetchNodeLog: (p?: any) => withFallback(() => realApi.fetchNodeLog(p), mockApi.fetchNodeLog),
  fetchMemorySessions: (n?: number) => withFallback(() => realApi.fetchMemorySessions(n), mockApi.fetchMemorySessions),
  markNotificationsRead: realApi.markNotificationsRead,
  executeQuery: realApi.executeQuery,
};
