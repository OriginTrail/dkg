import {
  clearDashboardSessionPromise,
  setDashboardSession,
  type DashboardSessionStatus,
} from './dashboardSessionState.js';

export function setDashboardSessionForTesting(session: DashboardSessionStatus): void {
  clearDashboardSessionPromise();
  setDashboardSession(session);
}
