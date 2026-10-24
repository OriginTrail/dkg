// Shared HTTP transport for the node-UI API client.
//
// Lifted out of api.ts (#1345) so the PCA client (./pca-api.ts) and the rest of
// api.ts share one same-origin, bearer-authed, HttpError-shaped fetch layer
// instead of re-declaring it. Pure relocation — no behavior change.

import { currentApiToken } from './lib/apiToken.js';

export const BASE = '';

export function authHeaders(): Record<string, string> {
  const token = currentApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export class HttpError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message?: string, body?: unknown) {
    super(message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function fetchWithTimeout(input: string, init: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  }
}

/**
 * Deadline for the long synchronous Knowledge Asset mutations (`vm/publish`,
 * `swm/share`, `wm/import-file`). `vm/publish` holds the request open for the
 * publisher's storage-ACK window (`ACK_TIMEOUT_MS`, 120 s, in
 * packages/publisher/src/ack-collector.ts) plus chain confirmation. It matches
 * the other daemon clients and stays under five minutes, where some browsers
 * stop waiting for a response on their own.
 */
export const LONG_MUTATION_TIMEOUT_MS = 240_000;

/**
 * A long mutation got no response before its deadline. The node keeps working
 * after the page stops waiting, so the operation may still complete: show the
 * outcome as unknown, not as a failure.
 */
export class OutcomeUnknownError extends Error {
  readonly outcomeUnknown = true;
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeUnknownError';
  }
}

/**
 * Run a long mutation's request under {@link LONG_MUTATION_TIMEOUT_MS}. The
 * deadline covers the response body; a daemon error answer maps to `HttpError`
 * like `post`, and the deadline's own expiry to {@link OutcomeUnknownError}. A
 * plain timer (not `AbortSignal.timeout`) keeps it drivable by fake timers.
 */
export async function requestLongMutation<T>(
  path: string,
  init: RequestInit,
  outcomeUnknownMessage: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LONG_MUTATION_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new HttpError(res.status, msg, errBody);
    }
    return (await res.json()) as T;
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof HttpError)) {
      throw new OutcomeUnknownError(outcomeUnknownMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function postLongMutation<T>(path: string, body: unknown, outcomeUnknownMessage: string): Promise<T> {
  return requestLongMutation<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  }, outcomeUnknownMessage);
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

// GET that parses the daemon's `{ error, code }` body into the HttpError (like
// `post`/`delJson`). The legacy `get` above throws a bodyless HttpError, but PCA
// reads need the body to tell a CAPABILITY 503 (feature unavailable) from a
// TRANSPORT 503/504 (transient RPC outage, `code: 'RPC_*'`) — see
// `isPcaFeatureUnavailable` / `describePcaError`.
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

export async function getWithTimeout<T>(path: string, timeoutMs: number): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, { headers: authHeaders() }, timeoutMs);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}

// DELETE variant that parses the daemon's `{ error }` body into an `HttpError`
// (status + body), mirroring `post`. The legacy `del` above predates the
// HttpError-aware error path and throws a bare `Error`, so callers that need to
// branch on the status/code (e.g. the PCA deregister flow mapping 403/409 via
// `describePcaError`) route through this instead. Both are kept so existing
// `del` callers keep their current contract.
export async function delJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const msg = (errBody as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new HttpError(res.status, msg, errBody);
  }
  return res.json() as Promise<T>;
}
