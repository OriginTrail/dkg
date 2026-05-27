import * as mock from './data.js';

function delay<T>(data: T, ms = 50): Promise<T> {
  return new Promise((r) => setTimeout(() => r(data), ms));
}

export const mockApi = {
  fetchStatus: () => delay(mock.MOCK_STATUS),
  fetchMetrics: () => delay(mock.MOCK_METRICS),
  fetchAgents: () => delay(mock.MOCK_AGENTS),
  fetchContextGraphs: () => delay(mock.MOCK_CONTEXT_GRAPHS),
  fetchOperationsWithPhases: () => delay(mock.MOCK_OPERATIONS),
  fetchEconomics: () => delay(mock.MOCK_ECONOMICS),
  fetchWalletsBalances: () => delay(mock.MOCK_WALLETS),
  fetchCurrentAgent: () => delay(mock.MOCK_AGENT_IDENTITY),
  listParticipants: (id: string) =>
    delay(mock.MOCK_PARTICIPANTS[id] ?? { contextGraphId: id, allowedAgents: [] }),
  // Codex review bug F — Overview's Subgraphs stat consumes the
  // wrapped `fetchSubGraphs` so it resolves in mock mode instead of
  // sitting at "..." after a real /sub-graph/list 404. Default to an
  // empty list; per-CG mocks can override via MOCK_SUBGRAPHS.
  fetchSubGraphs: (id: string) =>
    delay((mock as any).MOCK_SUBGRAPHS?.[id] ?? { contextGraphId: id, subGraphs: [] }),
  fetchNotifications: () => delay(mock.MOCK_NOTIFICATIONS),
  fetchNodeLog: () => delay(mock.MOCK_NODE_LOG),
  fetchMemorySessions: () => delay(mock.MOCK_SESSIONS),
};
