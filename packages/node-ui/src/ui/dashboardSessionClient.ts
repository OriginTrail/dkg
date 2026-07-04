import {
  clearDashboardSessionPromise,
  getDashboardSession,
  getDashboardSessionPromise,
  isDashboardSessionReady,
  setDashboardSession,
  setDashboardSessionPromise,
  type DashboardSessionStatus,
} from './dashboardSessionState.js';

export {
  dashboardSessionAuthKey,
  getDashboardSession,
  isDashboardSessionReady,
  subscribeDashboardSession,
  type DashboardSessionStatus,
} from './dashboardSessionState.js';

export type DaemonPath = `/${string}`;

const DASHBOARD_CSRF_ERROR_CODE = 'DASHBOARD_CSRF_INVALID';

let dashboardSessionWriteVersion = 0;

function invalidateDashboardSession(): void {
  dashboardSessionWriteVersion += 1;
  clearDashboardSessionPromise();
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

export async function ensureDashboardSession(): Promise<DashboardSessionStatus> {
  const dashboardSession = getDashboardSession();
  if (typeof window === 'undefined') return dashboardSession;
  if (dashboardSession.state === 'auth-disabled') return dashboardSession;
  if (dashboardSession.state === 'authenticated' && dashboardSession.expiresAt > Date.now() + 5000) {
    return dashboardSession;
  }
  const existingPromise = getDashboardSessionPromise();
  if (existingPromise) return existingPromise;

  const refreshVersion = dashboardSessionWriteVersion;
  const nextPromise = (async () => {
    const status = await requestSessionStatus();
    if (refreshVersion !== dashboardSessionWriteVersion) return getDashboardSession();
    if (isDashboardSessionReady(status ?? undefined)) {
      return setDashboardSession(status!);
    }

    return setDashboardSession({ state: 'unauthenticated', authenticated: false });
  })();
  setDashboardSessionPromise(nextPromise);

  try {
    return await nextPromise;
  } finally {
    if (getDashboardSessionPromise() === nextPromise) clearDashboardSessionPromise();
  }
}

export async function exchangeDashboardSession(token: string): Promise<DashboardSessionStatus> {
  dashboardSessionWriteVersion += 1;
  clearDashboardSessionPromise();
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
  const dashboardSession = getDashboardSession();
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

export function daemonPath(input: string): DaemonPath {
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

function isUnsafeMethod(method: string | undefined): boolean {
  const normalized = (method ?? 'GET').toUpperCase();
  return normalized === 'POST' || normalized === 'PUT' || normalized === 'PATCH' || normalized === 'DELETE';
}

async function isDashboardCsrfError(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  let body: { code?: unknown; error?: unknown } | null = null;
  try {
    body = await readJson<{ code?: unknown; error?: unknown }>(res.clone());
  } catch {
    return false;
  }
  return body?.code === DASHBOARD_CSRF_ERROR_CODE ||
    body?.error === 'Invalid or missing dashboard CSRF token';
}

export async function daemonFetch(input: DaemonPath, init: RequestInit = {}): Promise<Response> {
  const path = daemonPath(input);
  const sessionBeforeRequest = getDashboardSession();
  const withSession = () => fetch(path, withDashboardSessionCredentials(init));

  const res = await withSession();
  const shouldRefreshSession =
    isDashboardSessionReady(sessionBeforeRequest) &&
    (res.status === 401 || (isUnsafeMethod(init.method) && await isDashboardCsrfError(res)));
  if (!shouldRefreshSession) return res;

  invalidateDashboardSession();
  const refreshed = await ensureDashboardSession();
  if (!isDashboardSessionReady(refreshed)) return res;
  return withSession();
}

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
