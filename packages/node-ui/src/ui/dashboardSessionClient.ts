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

export type DaemonPath = `/${string}`;

let dashboardSession: DashboardSessionStatus = { state: 'unauthenticated', authenticated: false };
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
  setDashboardSession({ state: 'unauthenticated', authenticated: false });
}

async function readJson<T>(res: Response): Promise<T | null> {
  return res.json().catch(() => null) as Promise<T | null>;
}

async function requestSessionStatus(): Promise<DashboardSessionStatus | null> {
  return fetch('/api/dashboard/session/status', {
    cache: 'no-store',
    credentials: 'same-origin',
  }).then(async (res) => res.ok ? parseDashboardSessionStatus(await readJson<unknown>(res)) : null).catch(() => null);
}

async function requestLoopbackSession(): Promise<DashboardSessionStatus | null> {
  return fetch('/api/dashboard/session/loopback', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'same-origin',
  }).then(async (res) => res.ok ? parseDashboardSessionStatus(await readJson<unknown>(res)) : null).catch(() => null);
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
  return session.state === 'authenticated' || session.state === 'auth-disabled';
}

export function dashboardSessionAuthKey(): string {
  if (!isDashboardSessionReady()) return '';
  if (dashboardSession.state === 'auth-disabled') return 'auth-disabled';
  return `${dashboardSession.source}:${dashboardSession.expiresAt}`;
}

export function setDashboardSessionForTesting(session: DashboardSessionStatus): void {
  dashboardSessionPromise = null;
  setDashboardSession(session);
}

export async function ensureDashboardSession(): Promise<DashboardSessionStatus> {
  if (typeof window === 'undefined') return dashboardSession;
    if (dashboardSession.state === 'auth-disabled') return dashboardSession;
    if (dashboardSession.state === 'authenticated' && dashboardSession.expiresAt > Date.now() + 5000) {
      return dashboardSession;
    }
  if (dashboardSessionPromise) return dashboardSessionPromise;

  dashboardSessionPromise = (async () => {
    const status = await requestSessionStatus();
    if (isDashboardSessionReady(status ?? undefined)) {
      return setDashboardSession(status!);
    }

    const loopback = await requestLoopbackSession();
    if (isDashboardSessionReady(loopback ?? undefined)) {
      return setDashboardSession(loopback!);
    }

    return setDashboardSession({ state: 'unauthenticated', authenticated: false });
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
  const body = await readJson<unknown>(res);
  const session = parseDashboardSessionStatus(body);
  if (!res.ok || !isDashboardSessionReady(session ?? undefined)) {
    throw new Error(readDashboardSessionError(body) ?? `Dashboard unlock failed (${res.status})`);
  }
  return setDashboardSession(session!);
}

function dashboardSessionHeaders(): Record<string, string> {
  if (dashboardSession.state === 'authenticated') return { 'X-DKG-CSRF': dashboardSession.csrfToken };
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
  const sessionBeforeRequest = dashboardSession;
  const withSession = () => fetch(path, withDashboardSessionCredentials(init));

  const res = await withSession();
  if (res.status !== 401 || !isDashboardSessionReady(sessionBeforeRequest)) return res;

  invalidateDashboardSession();
  const refreshed = await ensureDashboardSession();
  if (!isDashboardSessionReady(refreshed)) return res;
  return withSession();
}

export const apiFetch = daemonFetch;

function parseDashboardSessionStatus(value: unknown): DashboardSessionStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as {
    authenticated?: unknown;
    authDisabled?: unknown;
    source?: unknown;
    csrfToken?: unknown;
    expiresAt?: unknown;
  };
  if (raw.authDisabled === true) {
    return { state: 'auth-disabled', authenticated: true, authDisabled: true };
  }
  if (raw.authenticated === true) {
    if (
      typeof raw.source === 'string' &&
      raw.source.length > 0 &&
      typeof raw.csrfToken === 'string' &&
      raw.csrfToken.length > 0 &&
      typeof raw.expiresAt === 'number' &&
      Number.isFinite(raw.expiresAt)
    ) {
      return {
        state: 'authenticated',
        authenticated: true,
        source: raw.source,
        csrfToken: raw.csrfToken,
        expiresAt: raw.expiresAt,
      };
    }
    return null;
  }
  return { state: 'unauthenticated', authenticated: false };
}

function readDashboardSessionError(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' && error.length > 0 ? error : undefined;
}
