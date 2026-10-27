/**
 * Shared upstream HTTP plumbing for the chat connectors: base-URL rules,
 * bounded body reads, failure classification and secret redaction.
 *
 * Every request uses `redirect: 'error'` (a redirect is `UPSTREAM_ERROR`) and
 * an `AbortSignal.timeout`, and every body is read with an 8 MiB cap. Failure
 * details are secret-redacted on the WHOLE text first and only then cut, so a
 * truncation can never leave a partial secret at the cut.
 */
import { MarketplaceConnectorMountError } from './types.js';
import type { ConnectorChatOutcome, ConnectorFailureCode } from './types.js';

export const UPSTREAM_BODY_CAP_BYTES = 8 * 1024 * 1024;
/** Upstream error-body excerpt length inside a failure detail. */
export const UPSTREAM_SNIPPET_CHARS = 160;
const DETAIL_MAX_CHARS = 240;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type ConnectorFailure = Extract<ConnectorChatOutcome, { ok: false }>;

/** Replace every secret occurrence in the WHOLE text, then collapse whitespace, then cut. */
export function redactThenTruncate(text: string, secrets: ReadonlyArray<string | undefined>, max = UPSTREAM_SNIPPET_CHARS): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? out.slice(0, max) : out;
}

export function failure(code: ConnectorFailureCode, status: number, detail: string): ConnectorFailure {
  return { ok: false, code, status, detail: detail.length > DETAIL_MAX_CHARS ? detail.slice(0, DETAIL_MAX_CHARS) : detail };
}

/** 429 → rate limited, 401/403 → auth, anything else non-2xx → error. */
export function classifyStatus(status: number): ConnectorFailureCode {
  if (status === 429) return 'UPSTREAM_RATE_LIMITED';
  if (status === 401 || status === 403) return 'UPSTREAM_AUTH';
  return 'UPSTREAM_ERROR';
}

/** A thrown fetch/body-read fault: abort or timeout → `UPSTREAM_TIMEOUT`, else `UPSTREAM_ERROR` (status 0). */
export function classifyTransportError(error: unknown): ConnectorFailure {
  const err = error as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } } | undefined;
  const name = typeof err?.name === 'string' ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return failure('UPSTREAM_TIMEOUT', 0, 'upstream request timed out');
  if (error instanceof UpstreamBodyTooLargeError) return failure('UPSTREAM_ERROR', 0, error.message);
  const cause = typeof err?.cause?.message === 'string' ? err.cause.message : '';
  const message = typeof err?.message === 'string' ? err.message : String(error);
  if (/redirect/i.test(cause) || /redirect/i.test(message)) {
    return failure('UPSTREAM_ERROR', 0, 'upstream answered with a redirect, which connectors refuse');
  }
  const code = typeof err?.cause?.code === 'string' ? ` (${err.cause.code})` : '';
  return failure('UPSTREAM_ERROR', 0, `upstream transport failed${code}`);
}

export class UpstreamBodyTooLargeError extends Error {
  constructor(cap: number) {
    super(`upstream response body exceeds ${cap} bytes`);
    this.name = 'UpstreamBodyTooLargeError';
  }
}

/** Read a response body as UTF-8 text, refusing more than `cap` bytes. */
export async function readCappedText(res: Response, cap = UPSTREAM_BODY_CAP_BYTES): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamBodyTooLargeError(cap);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new UpstreamBodyTooLargeError(cap);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface UpstreamRequestInit {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** A caller-wide deadline (one budget across several requests); the earlier of the two aborts. */
  signal?: AbortSignal;
}

/** One upstream call with the connector-wide fetch options. Throws transport faults (classify them). */
export async function upstreamFetch(fetchImpl: typeof fetch, url: string, init: UpstreamRequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(init.timeoutMs);
  return fetchImpl(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: 'error',
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
}

/** Await `promise`, or reject with the signal's reason once it aborts (the promise itself runs on). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export type BaseUrlRule = 'http-or-https' | 'loopback-http' | 'https-or-loopback-http';

/**
 * Validate an admin-configured upstream base URL. No userinfo, query or
 * fragment; the trailing slash is stripped. `loopback-http` additionally
 * requires `http://127.0.0.1|localhost|[::1][:port]` with no path.
 */
export function parseUpstreamBaseUrl(raw: unknown, rule: BaseUrlRule, label: string): { base: string; origin: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.baseUrl must be a non-empty URL string`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.baseUrl is not a valid URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.baseUrl must not carry credentials, a query or a fragment`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (rule === 'loopback-http') {
    if (url.protocol !== 'http:' || !loopback || (url.pathname !== '/' && url.pathname !== '')) {
      throw new MarketplaceConnectorMountError(
        'CONNECTOR_NOT_LOOPBACK',
        `${label}.baseUrl must be http://127.0.0.1|localhost|[::1][:port] (llama.cpp is served from loopback only)`,
      );
    }
  } else if (rule === 'https-or-loopback-http') {
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.baseUrl must be https (or http to a loopback host)`);
    }
  } else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.baseUrl must be http or https`);
  }
  return { base: url.href.replace(/\/+$/, ''), origin: url.origin };
}

/** Non-negative safe integer or undefined. */
export function usageCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function resolveTimeoutMs(raw: number | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  if (!Number.isSafeInteger(raw) || raw < 1_000 || raw > 600_000) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.timeoutMs must be an integer 1000..600000`);
  }
  return raw;
}
