/**
 * Provider-timeout path for the shared-model client (PR #1157 B2).
 *
 * Pins the curator-side deadline added in B2: when `providerTimeoutMs` is set,
 * the upstream provider `fetch` is given `AbortSignal.timeout(...)`, and an
 * abort is mapped to a deterministic `provider timeout after <n>ms` Error (so
 * `handleSharedModelInvoke` returns a structured `{ok:false, denied:...}`
 * instead of hanging the member's P2P round trip). Also pins that the abort
 * signal is attached ONLY when a timeout is configured.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SharedModelClient } from '../../src/shared-model/client.js';
import type { SharedModelProviderConfig } from '../../src/shared-model/types.js';

const CFG: SharedModelProviderConfig = {
  provider: 'openai-compatible',
  model: 'gpt-test',
  baseUrl: 'https://example.test/v1',
  apiKey: 'sk-test',
};
const MSGS = [{ role: 'user' as const, content: 'hi' }];

function okResponse(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'pong' } }], model: 'gpt-test' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('shared-model provider timeout (B2)', () => {
  it('throws "provider timeout after <n>ms" when the provider fetch is aborted by the deadline', async () => {
    // A fetch that honours the AbortSignal: it never resolves on its own and
    // rejects with the signal's reason (a DOMException 'TimeoutError') on abort,
    // exactly as the platform fetch does. AbortSignal.timeout(10) fires the abort.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      ),
    );
    const client = new SharedModelClient();
    await expect(client.complete(CFG, MSGS, { providerTimeoutMs: 10 })).rejects.toThrow(
      'provider timeout after 10ms',
    );
  });

  it('attaches an AbortSignal to fetch only when providerTimeoutMs is set', async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const client = new SharedModelClient();

    const withTimeout = await client.complete(CFG, MSGS, { providerTimeoutMs: 1000 });
    expect(withTimeout.content).toBe('pong');
    expect((fetchMock.mock.calls[0][1] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);

    fetchMock.mockClear();
    const noTimeout = await client.complete(CFG, MSGS, {});
    expect(noTimeout.content).toBe('pong');
    expect((fetchMock.mock.calls[0][1] as { signal?: unknown }).signal).toBeUndefined();
  });
});
