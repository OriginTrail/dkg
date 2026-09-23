// Node API token for the dashboard.
//
// The daemon embeds its token in the page (`window.__DKG_TOKEN__`) only when
// the dashboard is opened on the node host itself (loopback address and
// loopback host name). Opened from anywhere else, the page is served without
// it and the operator enters the token once; it is kept in sessionStorage, so
// it lasts for this browser tab only and never outlives it.

import { authHeaders } from '../http.js';

const STORAGE_KEY = 'dkg.apiToken';

/** Authenticated, non-admin read used to learn whether the page's credentials are accepted. */
const TOKEN_PROBE_PATH = '/api/agent/identity';

function tabStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The token entered in this tab, if any. */
export function enteredApiToken(): string | undefined {
  try {
    return tabStorage()?.getItem(STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make a token entered earlier in this tab available to the API clients. A
 * token the daemon served with the page always wins. Runs before the app
 * renders (see `restoreApiToken.ts`).
 */
export function restoreEnteredApiToken(): void {
  if (typeof window === 'undefined' || window.__DKG_TOKEN__) return;
  const entered = enteredApiToken();
  if (entered) window.__DKG_TOKEN__ = entered;
}

/** Keep `token` for this tab and use it for API calls from now on. */
export function saveEnteredApiToken(token: string): void {
  const value = token.trim();
  if (!value || typeof window === 'undefined') return;
  try {
    tabStorage()?.setItem(STORAGE_KEY, value);
  } catch {
    // Storage unavailable: the token still applies until the page reloads.
  }
  window.__DKG_TOKEN__ = value;
}

/** Drop the token entered in this tab (for example after the node rejected it). */
export function forgetEnteredApiToken(): void {
  const entered = enteredApiToken();
  try {
    tabStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
  if (typeof window !== 'undefined' && entered && window.__DKG_TOKEN__ === entered) {
    delete window.__DKG_TOKEN__;
  }
}

/** True when the page's token was served by the daemon rather than entered here. */
export function hasServedApiToken(): boolean {
  if (typeof window === 'undefined' || !window.__DKG_TOKEN__) return false;
  return window.__DKG_TOKEN__ !== enteredApiToken();
}

/**
 * Whether the node rejects the page's current credentials. False when the node
 * accepts them, when authentication is disabled, or when it cannot be reached
 * (the mock-mode banner covers an unreachable node).
 */
export async function apiTokenRequired(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(TOKEN_PROBE_PATH, { headers: authHeaders(), cache: 'no-store' });
    return res.status === 401;
  } catch {
    return false;
  }
}
