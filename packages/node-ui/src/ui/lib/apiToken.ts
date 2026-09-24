// Node API token for the dashboard.
//
// The daemon embeds its token in the page (`window.__DKG_TOKEN__`) only when
// the dashboard is opened on the node host itself (loopback address and
// loopback host name). Opened from anywhere else, the page is served without
// it and the operator enters the token once. The entered token is kept in
// sessionStorage for this tab when the browser allows it, and only in memory
// for this page otherwise. Every API client reads the token through
// `currentApiToken()`, so no module has to run before another.

declare global {
  interface Window { __DKG_TOKEN__?: string; }
}

const STORAGE_KEY = 'dkg.apiToken';

/** Authenticated, non-admin read used to learn whether the page's credentials are accepted. */
const TOKEN_PROBE_PATH = '/api/agent/identity';

/** The token entered on this page; the only copy when tab storage is unavailable. */
let pageToken: string | undefined;

const keptInMemoryListeners = new Set<() => void>();

// Every storage access goes through `window.sessionStorage` inside try/catch:
// it throws when site data is blocked, and a stubbed window may lack it.
function storedToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** The token the daemon served with the page, if any. */
export function servedApiToken(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.__DKG_TOKEN__ || undefined;
}

/** The token entered for this tab, if any. */
export function enteredApiToken(): string | undefined {
  return pageToken ?? storedToken();
}

/** The token API calls use: the served token first, otherwise the entered one. */
export function currentApiToken(): string | undefined {
  return servedApiToken() ?? enteredApiToken();
}

/** True when the page's token was served by the daemon rather than entered here. */
export function hasServedApiToken(): boolean {
  return servedApiToken() !== undefined;
}

/**
 * True when a reload keeps the current token: it was served with the page, or
 * it is the one kept in tab storage.
 */
export function apiTokenSurvivesReload(): boolean {
  const current = currentApiToken();
  return current !== undefined && (current === servedApiToken() || current === storedToken());
}

/**
 * Use `token` for API calls from now on and keep it for the tab when the
 * browser allows. Returns true when it was kept in tab storage, so it survives
 * a reload. Otherwise it lives only in this page, and listeners registered with
 * `onApiTokenKeptInMemory` are told so the dashboard can refetch in place.
 */
export function saveEnteredApiToken(token: string): boolean {
  const value = token.trim();
  if (!value || typeof window === 'undefined') return false;
  pageToken = value;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, value);
    return true;
  } catch {
    // An older stored token must not come back after a reload.
    try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    for (const listener of keptInMemoryListeners) {
      try { listener(); } catch { /* a listener must not block the others */ }
    }
    return false;
  }
}

/** Drop the entered token (for example after the node rejected it). */
export function forgetEnteredApiToken(): void {
  pageToken = undefined;
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
}

/** Called when an entered token could be kept only in memory. Returns an unsubscribe function. */
export function onApiTokenKeptInMemory(listener: () => void): () => void {
  keptInMemoryListeners.add(listener);
  return () => { keptInMemoryListeners.delete(listener); };
}

/**
 * Whether the node rejects the page's current credentials. False when the node
 * accepts them, when authentication is disabled, or when it cannot be reached
 * (the mock-mode banner covers an unreachable node).
 */
export async function apiTokenRequired(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const token = currentApiToken();
  try {
    const res = await fetchImpl(TOKEN_PROBE_PATH, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    });
    return res.status === 401;
  } catch {
    return false;
  }
}
