import type { ManagedOxigraphRecoveryPhaseV1, ManagedOxigraphRuntimeHooksV1 } from '../src/managed-oxigraph-runtime-store.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedOxigraphSparqlStoreV1, SparqlHttpStore } from '../src/adapters/sparql-http.js';

const originalFetch = globalThis.fetch;
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function harness(managed = true, extraHooks: ManagedOxigraphRuntimeHooksV1 = {}) {
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
  const activity: boolean[] = [];
  const options = {
    queryEndpoint: 'http://127.0.0.1:7878/query',
    timeout: 1_000,
    now: () => performance.now(),
  };
  const hooks = {
    getRecoveryState: () => ({ ...recovery }),
    onClientTimeout: recover,
    registerActivity: () => ({ report: (activeOperations: boolean) => activity.push(activeOperations), dispose() {} }),
  };
  // The generic store is handed the full legacy capability shape on purpose:
  // the 'external' case only proves the "generic stores cannot gain managed
  // authority" boundary if the adapter had something to ignore.
  const store = managed
    ? createManagedOxigraphSparqlStoreV1(options, { ...hooks, ...extraHooks })
    : new SparqlHttpStore({
      ...options,
      managedRecovery: { readState: hooks.getRecoveryState, recover },
    });
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
  async function abandonMutation() {
    started = new Promise<void>((resolve) => { dispatched = resolve; });
    const caller = new AbortController();
    const update = store.update(
      'INSERT DATA { <urn:subject> <urn:predicate> "value" }',
      { signal: caller.signal },
    );
    await started;
    await vi.advanceTimersByTimeAsync(100);
    const reason = new Error('caller cancelled mutation');
    const rejected = expect(update).rejects.toBe(reason);
    caller.abort(reason);
    await rejected;
  }
  return { store, recovery, recover, activity, abandon, abandonMutation };
}

describe('managed abandoned read recovery', () => {
  it.each(['legacy', 'modern'] as const)('normalizes %s timeout, cancellation retry and reusable close at the store boundary', async protocol => {
    const observers: Array<(phase: ManagedOxigraphRecoveryPhaseV1) => void> = [];
    const dispose = vi.fn();
    const requestRecovery = vi.fn((generation: number) => ({ generation, subscribe(observe: (phase: ManagedOxigraphRecoveryPhaseV1) => void) {
      observers.push(observe); observe('verifying'); return dispose;
    } }));
    const { store, recovery, recover, activity, abandonMutation } = harness(true,
      protocol === 'modern' ? { requestRecovery } : {});
    const notify = protocol === 'modern' ? requestRecovery : recover;
    try {
      await abandonMutation();
      await vi.advanceTimersByTimeAsync(899);
      expect(notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(notify).toHaveBeenCalledOnce();
      expect(activity.at(-1)).toBe(true);
      if (protocol === 'modern') observers[0]!('cancelled');
      await vi.advanceTimersByTimeAsync(999);
      expect(notify).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(activity.at(-1)).toBe(true);
      recovery.generation += 1;
      if (protocol === 'modern') {
        observers[1]!('signalled');
        expect(activity.at(-1)).toBe(true);
        observers[1]!('terminated');
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(recover).not.toHaveBeenCalled();
      } else await vi.advanceTimersByTimeAsync(1_000);
      expect(activity.at(-1)).toBe(false);
      await store.close();

      await abandonMutation();
      observers[0]?.('terminated'); // The previous lifecycle cannot release new retained work.
      await vi.advanceTimersByTimeAsync(899);
      expect(notify).toHaveBeenCalledTimes(2);
      expect(activity.at(-1)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(notify).toHaveBeenCalledTimes(3);
      await store.close();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(notify).toHaveBeenCalledTimes(3);
      expect(activity.at(-1)).toBe(false);
      if (protocol === 'modern') expect(dispose).toHaveBeenCalledTimes(3);
    } finally { await store.close(); }
  });

  it('consumes the runtime progress capability without a legacy timeout notifier', async () => {
    let observe!: (phase: ManagedOxigraphRecoveryPhaseV1) => void;
    const requestRecovery = vi.fn((generation: number) => ({ generation, subscribe(callback: (phase: ManagedOxigraphRecoveryPhaseV1) => void) {
      observe = callback; callback('verifying'); return () => {};
    } }));
    const { store, activity, abandonMutation, recovery } = harness(true, { onClientTimeout: undefined, requestRecovery });
    try {
      await abandonMutation();
      await vi.advanceTimersByTimeAsync(900);
      expect(requestRecovery).toHaveBeenCalledExactlyOnceWith(0, 'update');
      recovery.generation = 1;
      observe('signalled');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(activity.at(-1)).toBe(true);
      expect(requestRecovery).toHaveBeenCalledTimes(1);
      observe('terminated');
      expect(activity.at(-1)).toBe(false);
    } finally { await store.close(); }
  });

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
    const { store, recovery, recover, abandon } = harness();
    recover.mockImplementation(() => { recovery.generation += 1; });
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

  it('keeps physical work active after recovery is requested until that task settles', async () => {
    const { store, recover, activity, abandon } = harness();
    try {
      await abandon();
      expect(activity.at(-1)).toBe(true);
      await vi.advanceTimersByTimeAsync(899);
      expect(activity.at(-1)).toBe(true);
      expect(recover).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledOnce();
      // The supervisor notification does not itself settle HTTP work. This
      // fixture has no server to kill; close must still abort and drain it.
      expect(activity.at(-1)).toBe(true);
      await store.close();
      expect(activity.at(-1)).toBe(false);
    } finally { await store.close(); }
  });

  it('keeps a caller-cancelled mutation fenced until supervised recovery can abandon it', async () => {
    const { store, recovery, recover, activity, abandonMutation } = harness();
    try {
      await abandonMutation();
      expect(recover).not.toHaveBeenCalled();
      expect(activity.at(-1)).toBe(true);

      await vi.advanceTimersByTimeAsync(899);
      expect(recover).not.toHaveBeenCalled();
      expect(activity.at(-1)).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('update');
      expect(activity.at(-1)).toBe(true);
      recovery.generation += 1;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(activity.at(-1)).toBe(false);
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

  it('starts a clean retained-deadline generation after reusable close', async () => {
    const { store, recover, abandon } = harness();
    try {
      await abandon();
      await store.close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(recover).not.toHaveBeenCalled();

      await abandon();
      await vi.advanceTimersByTimeAsync(899);
      expect(recover).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(recover).toHaveBeenCalledExactlyOnceWith('query');
    } finally { await store.close(); }
  });
});
