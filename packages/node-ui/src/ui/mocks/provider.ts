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
  fetchNotifications: () => delay(mock.MOCK_NOTIFICATIONS),
  fetchNodeLog: () => delay(mock.MOCK_NODE_LOG),
  fetchMemorySessions: () => delay(mock.MOCK_SESSIONS),
};
