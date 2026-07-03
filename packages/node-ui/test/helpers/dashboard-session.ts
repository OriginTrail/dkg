import {
  setDashboardSessionForTesting,
  type DashboardSessionStatus,
} from '../../src/ui/dashboardSessionClient.js';

export function useAuthenticatedDashboardSession(overrides: DashboardSessionStatus = {}): void {
  setDashboardSessionForTesting({
    authenticated: true,
    source: 'test',
    csrfToken: 'csrf-test',
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  });
}

export function resetDashboardSession(session: DashboardSessionStatus = { authenticated: false }): void {
  setDashboardSessionForTesting(session);
}
