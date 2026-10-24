// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchBoundedJson, getBoundedJson, HttpError } from '../src/ui/http.js';

beforeEach(() => { vi.useFakeTimers(); window.__DKG_TOKEN__ = 'bounded-get-token'; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete window.__DKG_TOKEN__; });

it('bounded GET preserves authentication, typed data and timer cleanup', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ name: 'agent' })));
  vi.stubGlobal('fetch', fetch);
  expect(await getBoundedJson<{ name: string }>('/api/agent/identity')).toEqual({ name: 'agent' });
  expect(fetch).toHaveBeenCalledWith('/api/agent/identity', expect.objectContaining({
    headers: { Authorization: 'Bearer bounded-get-token' }, signal: expect.any(AbortSignal),
  }));
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  [JSON.stringify({ error: 'Unavailable identity', code: 'IDENTITY_UNAVAILABLE' }), 'Unavailable identity', { error: 'Unavailable identity', code: 'IDENTITY_UNAVAILABLE' }],
  ['not JSON', 'HTTP 503', {}],
])('bounded GET preserves HttpError status, message and decoded body: %s', async (body, message, expected) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body as string, { status: 503 })));
  const error = await getBoundedJson('/api/agent/identity').catch(value => value);
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ status: 503, message, body: expected });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['headers', 'body'])('external cancellation bounds non-cooperative %s and releases its timer', async stage => {
  const external = new AbortController();
  const reason = new Error('caller cancelled');
  const cancel = vi.fn();
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    if (stage === 'headers') return new Promise(() => {});
    return Promise.resolve(new Response(new ReadableStream({ cancel })));
  }));
  const pending = fetchBoundedJson('/api/read', { signal: external.signal }, {
    timeoutMs: 10_000, maxResponseBytes: null,
  }).catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  external.abort(reason);
  expect(await pending).toBe(reason);
  expect(signal?.aborted).toBe(true);
  if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
