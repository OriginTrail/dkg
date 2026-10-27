/**
 * Helpers for the OT-RFC-27 buyer-gateway arc of the marketplace devnet suite
 * (automated.test.ts, `describe('… buyer gateway (devnet e2e)')`): raw HTTP
 * with a caller-chosen `Authorization` header, an SSE parser for the
 * gateway's buffered `stream: true` replies, and OpenAI-style error
 * assertions (spec agent-docs/plans/2026-10-27-rfc27-sellers-gateway.md
 * §9.2–§9.6, §13.3).
 *
 * Gateway POSTs spend from a key and a plan, so `httpRequest` makes exactly
 * ONE attempt: the harness's `fetchRetry` would replay a call whose first
 * attempt may already have been served and charged.
 */
import { expect } from 'vitest';
import type { DevnetNode } from '../_bootstrap/harness.js';

export const GATEWAY_BASE_PATH = '/api/marketplace/gateway/v1';

/** `dkg_gw_<8 lowercase hex>_<43 base64url>` (spec §3.1); group 1 → keyId `gw_<hex>`. */
export const GATEWAY_KEY_PATTERN = /^dkg_gw_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

export interface HttpReply {
  status: number;
  headers: Headers;
  text: string;
  /** Parsed JSON body, or null for an empty / non-JSON body (e.g. SSE). */
  json: any;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  /** The raw `Authorization` header value; omitted → no header at all. */
  authorization?: string;
  /** JSON-serialized when present. */
  body?: unknown;
  timeoutMs?: number;
}

/** One HTTP request to a node's API (no retry). Never throws on an HTTP status. */
export async function httpRequest(
  node: DevnetNode,
  path: string,
  { method = 'GET', authorization, body, timeoutMs = 240_000 }: HttpRequestOptions = {},
): Promise<HttpReply> {
  const headers: Record<string, string> = { Accept: 'application/json, text/event-stream' };
  if (authorization !== undefined) headers.Authorization = authorization;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${node.apiPort}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* SSE or another non-JSON body */
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** A request under the gateway base, authenticated by `key` (null → no Authorization header). */
export function gatewayRequest(
  node: DevnetNode,
  subPath: string,
  key: string | null,
  opts: Omit<HttpRequestOptions, 'authorization'> = {},
): Promise<HttpReply> {
  return httpRequest(node, `${GATEWAY_BASE_PATH}${subPath}`, {
    ...opts,
    ...(key !== null ? { authorization: `Bearer ${key}` } : {}),
  });
}

/** A node-admin request (the node's bearer token), no retry. */
export function adminRequest(node: DevnetNode, path: string, opts: Omit<HttpRequestOptions, 'authorization'> = {}): Promise<HttpReply> {
  return httpRequest(node, path, { ...opts, authorization: `Bearer ${node.authToken}` });
}

export interface SseStream {
  /** The JSON events, in order, without the terminal `[DONE]`. */
  events: any[];
  /** True when the stream ended with `data: [DONE]` as its LAST event. */
  done: boolean;
}

/**
 * Parse an SSE body made only of `data: <payload>\n\n` events (the gateway's
 * framing, spec §9.4). Throws on any other line, on a JSON event after
 * `[DONE]`, or on a body that does not end on an event boundary.
 */
export function parseSse(text: string): SseStream {
  if (!text.endsWith('\n\n')) throw new Error(`SSE body does not end on an event boundary: ${JSON.stringify(text.slice(-40))}`);
  const blocks = text.slice(0, -2).split('\n\n');
  const events: any[] = [];
  let done = false;
  for (const block of blocks) {
    if (!block.startsWith('data: ') || block.includes('\n')) {
      throw new Error(`unexpected SSE block (want one "data: " line): ${JSON.stringify(block.slice(0, 120))}`);
    }
    const payload = block.slice('data: '.length);
    if (done) throw new Error('SSE event after [DONE]');
    if (payload === '[DONE]') {
      done = true;
      continue;
    }
    events.push(JSON.parse(payload));
  }
  return { events, done };
}

/**
 * Assert a gateway error body (spec §9.6): HTTP status, `error.{message,
 * type, param, code}` and the `error.dkg` block (`charged_wei` decimal,
 * `retryable` boolean). Returns `error` for further checks.
 */
export function expectGatewayError(
  reply: HttpReply,
  label: string,
  expected: { status: number; code: string; type: string; param?: string | null; chargedWei?: bigint },
): any {
  const dump = `${label}: HTTP ${reply.status} ${reply.text.slice(0, 600)}`;
  expect(reply.status, dump).toBe(expected.status);
  const error = reply.json?.error;
  expect(error, `${dump} — want an OpenAI-style { error } body`).toBeTruthy();
  expect(typeof error.message, dump).toBe('string');
  expect(error.message.length, dump).toBeGreaterThan(0);
  expect(error.type, dump).toBe(expected.type);
  expect(error.code, dump).toBe(expected.code);
  if (expected.param !== undefined) expect(error.param, dump).toBe(expected.param);
  else expect(error.param === null || typeof error.param === 'string', dump).toBe(true);
  expect(String(error.dkg?.charged_wei), dump).toMatch(/^\d+$/);
  expect(typeof error.dkg?.retryable, dump).toBe('boolean');
  if (expected.chargedWei !== undefined) expect(BigInt(error.dkg.charged_wei), dump).toBe(expected.chargedWei);
  return error;
}

/** 401 from the gateway: `authentication_error` + the realm challenge + `Connection: close` (pre-body). */
export function expectGatewayUnauthorized(reply: HttpReply, label: string, code: 'invalid_api_key' | 'key_revoked' | 'key_expired'): void {
  expectGatewayError(reply, label, { status: 401, code, type: 'authentication_error', chargedWei: 0n });
  expect(reply.headers.get('www-authenticate'), `${label}: WWW-Authenticate`).toBe('Bearer realm="dkg-marketplace-gateway"');
  expect(String(reply.headers.get('connection')).toLowerCase(), `${label}: a pre-body rejection closes the connection`).toBe('close');
}

/** Coerce a decimal string / number / bigint to bigint with a labeled failure. */
export function asBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if ((typeof value === 'number' && Number.isSafeInteger(value)) || (typeof value === 'string' && /^\d+$/.test(value))) {
    return BigInt(value);
  }
  throw new Error(`${label}: expected a decimal integer, got ${JSON.stringify(value)}`);
}
