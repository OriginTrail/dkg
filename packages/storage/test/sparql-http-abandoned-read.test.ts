import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedOxigraphSparqlStoreV1, SparqlHttpStore } from '../src/adapters/sparql-http.js';

const originalFetch = globalThis.fetch;
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function harness(managed = true) {
  let dispatched!: () => void;
  let started = new Promise<void>((resolve) => { dispatched = resolve; });
  globalThis.fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    dispatched();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  const recovery = { recovering: false, generation: 0 };
  const recover = vi.fn();
  const options = {
    queryEndpoint: 'http://127.0.0.1:7878/query',
    timeout: 1_000,
    now: () => performance.now(),
    getRecoveryState: () => ({ ...recovery }),
    onClientTimeout: recover,
  };
  const store = managed ? createManagedOxigraphSparqlStoreV1(options) : new SparqlHttpStore(options);
  async function abandon(sparql = 'SELECT ?s WHERE { ?s ?p ?o }') {
    started = new Promise<void>((resolve) => { dispatched = resolve; });
    const caller = new AbortController();
    const query = store.query(sparql, { signal: caller.signal });
    await started;
    await vi.advanceTimersByTimeAsync(100);
    const reason = new Error('caller cancelled');
    const rejected = expect(query).rejects.toBe(reason);
    caller.abort(reason);
    await rejected;
  }
  return { store, recovery, recover, abandon };
}

describe('managed abandoned read recovery', () => {
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', 'query'],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'construct'],
  ])('retains the original deadline after cancellation of %s', async (sparql, operation) => {
    const { store, recover, abandon } = harness();
    try {
      await abandon(sparql);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(899);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith(operation);
    } finally { await store.close(); }
  });

  it('coalesces abandoned reads without extending the earliest deadline', async () => {
    const { store, recover, abandon } = harness();
    try {
      await abandon();
      await abandon();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(800);
      expect(recover).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recover).toHaveBeenCalledTimes(1);
    } finally { await store.close(); }
  });

  it.each(['restarted', 'recovering', 'closed', 'external'] as const)('does not restart a %s store for an abandoned read', async (mode) => {
    const { store, recovery, recover, abandon } = harness(mode !== 'external');
    try {
      await abandon();
      if (mode === 'restarted') recovery.generation += 1;
      if (mode === 'recovering') recovery.recovering = true;
      if (mode === 'closed') await store.close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('does not schedule recovery for cancellation before dispatch', async () => {
    const { store, recover } = harness();
    try {
      const caller = new AbortController();
      caller.abort(new Error('already cancelled'));
      await expect(store.query('ASK {}', { signal: caller.signal })).rejects.toThrow('already cancelled');
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });

  it('does not schedule recovery for a completed read', async () => {
    const { store, recover } = harness();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ head: {}, boolean: true }), {
      headers: { 'Content-Type': 'application/sparql-results+json' },
    })) as typeof fetch;
    try {
      await store.query('ASK {}');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recover).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
