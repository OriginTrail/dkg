export type DashboardSessionStatus =
  | { state: 'unauthenticated'; authenticated: false }
  | { state: 'auth-disabled'; authenticated: true; authDisabled: true }
  | {
      state: 'authenticated';
      authenticated: true;
      authDisabled?: false;
      source: string;
      csrfToken: string;
      expiresAt: number;
    };

let dashboardSession: DashboardSessionStatus = { state: 'unauthenticated', authenticated: false };
let dashboardSessionPromise: Promise<DashboardSessionStatus> | null = null;

const sessionListeners = new Set<() => void>();

function emitSessionChange(): void {
  for (const listener of sessionListeners) listener();
}

export function getDashboardSession(): DashboardSessionStatus {
  return dashboardSession;
}

export function setDashboardSession(session: DashboardSessionStatus): DashboardSessionStatus {
  dashboardSession = session;
  emitSessionChange();
  return dashboardSession;
}

export function getDashboardSessionPromise(): Promise<DashboardSessionStatus> | null {
  return dashboardSessionPromise;
}

export function setDashboardSessionPromise(promise: Promise<DashboardSessionStatus> | null): void {
  dashboardSessionPromise = promise;
}

export function clearDashboardSessionPromise(): void {
  dashboardSessionPromise = null;
}

export function subscribeDashboardSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function isDashboardSessionReady(session = dashboardSession): boolean {
  return session.state === 'authenticated' || session.state === 'auth-disabled';
}

export function dashboardSessionAuthKey(): string {
  if (!isDashboardSessionReady()) return '';
  if (dashboardSession.state === 'auth-disabled') return 'auth-disabled';
  return `${dashboardSession.source}:${dashboardSession.expiresAt}`;
}
