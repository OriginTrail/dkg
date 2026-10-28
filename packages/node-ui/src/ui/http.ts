// Shared HTTP transport for the node-UI API client.
//
// Lifted out of api.ts (#1345) so the PCA client (./pca-api.ts) and the rest of
// api.ts share one same-origin, bearer-authed, HttpError-shaped fetch layer
// instead of re-declaring it. Pure relocation — no behavior change.

import { resolveWithinAbort } from '@origintrail-official/dkg-core/dist/abort-boundary.js';
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

/** Authenticated GET whose deadline also bounds body decoding and non-cooperative IO. */
export async function getBoundedJson<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const { response, body } = await fetchBoundedJson(`${BASE}${path}`, { headers: authHeaders() }, {
    timeoutMs, maxResponseBytes: null,
  });
  if (!response.ok) {
    throw new HttpError(response.status, (body as { error?: string })?.error ?? `HTTP ${response.status}`, body);
  }
  return body as T;
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

/** Read JSON within one deadline covering headers and the complete body. */
export async function fetchBoundedJson(
  url: string,
  init: RequestInit,
  limits: {
    timeoutMs: number | null;
    maxResponseBytes: number | null;
    onResponse?: (response: Response) => void;
    limitError?: (maxBytes: number) => Error;
  },
): Promise<{ response: Response; body: unknown }> {
  for (const limit of [limits.timeoutMs, limits.maxResponseBytes]) {
    if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) throw new RangeError('Read budgets must be positive and finite, or explicitly null.');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener('abort', cancel, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timer = limits.timeoutMs === null ? undefined : setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${Math.round(limits.timeoutMs! / 1000)}s`));
  }, limits.timeoutMs);
  const guard = async <T,>(work: () => Promise<T>): Promise<T> => {
    const result = await resolveWithinAbort(async () => ({ value: await work() }), controller.signal);
    if (result === null) throw controller.signal.reason;
    return result.value;
  };
  const checkBytes = (bytes: number) => {
    if (limits.maxResponseBytes !== null && bytes > limits.maxResponseBytes) {
      const error = (limits.limitError?.(limits.maxResponseBytes) ?? new Error(`Response exceeded ${limits.maxResponseBytes} bytes`));
      controller.abort(error); throw error;
    }
  };
  try {
    const response = await guard(() => fetch(url, { ...init, signal: controller.signal }));
    limits.onResponse?.(response);
    const declared = response.headers?.get('Content-Length');
    if (declared && Number.isFinite(Number(declared))) checkBytes(Number(declared));
    if (!response.body?.getReader) {
      const body: unknown = await guard(() => response.json());
      checkBytes(new TextEncoder().encode(JSON.stringify(body)).byteLength);
      return { response, body };
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const activeReader = reader;
      const { value, done } = await guard(() => activeReader.read());
      if (done) break;
      size += value.byteLength; checkBytes(size); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    try { return { response, body: JSON.parse(text) }; }
    catch (error) { if (!response.ok && error instanceof SyntaxError) return { response, body: {} }; throw error; }
  } finally {
    init.signal?.removeEventListener('abort', cancel);
    if (timer !== undefined) clearTimeout(timer);
    if (controller.signal.aborted) void reader?.cancel(controller.signal.reason).catch(() => {});
    try { reader?.releaseLock(); } catch { /* A canceled read may still be settling. */ }
  }
}
