import {
  setDashboardSessionForTesting,
  type DashboardSessionStatus,
} from '../../src/ui/dashboardSessionTestSupport.js';

type AuthenticatedDashboardSession = Extract<DashboardSessionStatus, { state: 'authenticated' }>;

export function useAuthenticatedDashboardSession(overrides: Partial<AuthenticatedDashboardSession> = {}): void {
  setDashboardSessionForTesting({
    state: 'authenticated',
    authenticated: true,
    source: 'test',
    csrfToken: 'csrf-test',
    expiresAt: Number.MAX_SAFE_INTEGER,
    ...overrides,
  });
}

export function resetDashboardSession(
  session: DashboardSessionStatus = { state: 'unauthenticated', authenticated: false },
): void {
  setDashboardSessionForTesting(session);
}
