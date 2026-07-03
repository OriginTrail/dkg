export type DashboardSessionStatus = {
  authenticated?: boolean;
  authDisabled?: boolean;
  source?: string;
  csrfToken?: string;
  expiresAt?: number;
};

export type DaemonPath = `/${string}`;

let dashboardSession: DashboardSessionStatus = { authenticated: false };
let dashboardSessionPromise: Promise<DashboardSessionStatus> | null = null;

const sessionListeners = new Set<() => void>();

function emitSessionChange(): void {
  for (const listener of sessionListeners) listener();
}

function setDashboardSession(session: DashboardSessionStatus): DashboardSessionStatus {
  dashboardSession = session;
  emitSessionChange();
  return dashboardSession;
}

function invalidateDashboardSession(): void {
  dashboardSessionPromise = null;
  setDashboardSession({ authenticated: false });
}

async function readJson<T>(res: Response): Promise<T | null> {
  return res.json().catch(() => null) as Promise<T | null>;
}

async function requestSessionStatus(): Promise<DashboardSessionStatus | null> {
  return fetch('/api/dashboard/session/status', {
    cache: 'no-store',
    credentials: 'same-origin',
  }).then((res) => res.ok ? readJson<DashboardSessionStatus>(res) : null).catch(() => null);
}

async function requestLoopbackSession(): Promise<DashboardSessionStatus | null> {
  return fetch('/api/dashboard/session/loopback', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
  }).then((res) => res.ok ? readJson<DashboardSessionStatus>(res) : null).catch(() => null);
}

export function getDashboardSession(): DashboardSessionStatus {
  return dashboardSession;
}

export function subscribeDashboardSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function isDashboardSessionReady(session = dashboardSession): boolean {
  return session.authenticated === true || session.authDisabled === true;
}

export function dashboardSessionAuthKey(): string {
  if (!isDashboardSessionReady()) return '';
  return `${dashboardSession.source ?? 'session'}:${dashboardSession.expiresAt ?? 0}`;
}

export function setDashboardSessionForTesting(session: DashboardSessionStatus): void {
  dashboardSessionPromise = null;
  setDashboardSession(session);
}

export async function ensureDashboardSession(): Promise<DashboardSessionStatus> {
  if (typeof window === 'undefined') return dashboardSession;
  if (
    isDashboardSessionReady() &&
    (!dashboardSession.expiresAt || dashboardSession.expiresAt > Date.now() + 5000)
  ) {
    return dashboardSession;
  }
  if (dashboardSessionPromise) return dashboardSessionPromise;

  dashboardSessionPromise = (async () => {
    const status = await requestSessionStatus();
    if (isDashboardSessionReady(status ?? undefined)) {
      return setDashboardSession(status as DashboardSessionStatus);
    }

    const loopback = await requestLoopbackSession();
    if (isDashboardSessionReady(loopback ?? undefined)) {
      return setDashboardSession(loopback as DashboardSessionStatus);
    }

    return setDashboardSession({ authenticated: false });
  })();

  try {
    return await dashboardSessionPromise;
  } finally {
    dashboardSessionPromise = null;
  }
}

export async function exchangeDashboardSession(token: string): Promise<DashboardSessionStatus> {
  dashboardSessionPromise = null;
  const res = await fetch('/api/dashboard/session/exchange', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const body = await readJson<DashboardSessionStatus & { error?: string }>(res);
  if (!res.ok || !isDashboardSessionReady(body ?? undefined)) {
    throw new Error(body?.error ?? `Dashboard unlock failed (${res.status})`);
  }
  return setDashboardSession(body as DashboardSessionStatus);
}

function dashboardSessionHeaders(): Record<string, string> {
  if (dashboardSession.csrfToken) return { 'X-DKG-CSRF': dashboardSession.csrfToken };
  return {};
}

function mergeHeaders(base?: HeadersInit, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (base instanceof Headers) {
    base.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(base)) {
    for (const [key, value] of base) headers[key] = value;
  } else if (base) {
    Object.assign(headers, base);
  }
  return { ...headers, ...extra };
}

function assertDaemonPath(input: string): DaemonPath {
  if (!input.startsWith('/') || input.startsWith('//')) {
    throw new Error('daemonFetch only accepts same-origin daemon paths');
  }
  return input as DaemonPath;
}

export function withDashboardSessionCredentials(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    credentials: init.credentials ?? 'same-origin',
    headers: mergeHeaders(init.headers, dashboardSessionHeaders()),
  };
}

export async function daemonFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const path = assertDaemonPath(input);
  const sessionBeforeRequest = await ensureDashboardSession();
  const withSession = () => fetch(path, withDashboardSessionCredentials(init));

  const res = await withSession();
  if (res.status !== 401 || !isDashboardSessionReady(sessionBeforeRequest)) return res;

  invalidateDashboardSession();
  const refreshed = await ensureDashboardSession();
  if (!isDashboardSessionReady(refreshed)) return res;
  return withSession();
}

export const apiFetch = daemonFetch;
