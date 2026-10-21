import { expect, it, vi } from 'vitest';
import { createManagedOxigraphSparqlStoreV1 } from '../src/adapters/sparql-http.js';
import type { QueryOptions } from '../src/triple-store.js';

it.each(['flush', 'commitment'] as const)('owns held %s through close, rejects new work and permits reuse after drain', async method => {
  let release!: () => void, entered!: () => void, seen: QueryOptions | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const setBusy = vi.fn(), dispose = vi.fn();
  const persistence = vi.fn(async (options?: QueryOptions) => { seen = options; entered(); await held; });
  const store = createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:7878/query' }, {
    persistence, registerActivity: () => ({ report: setBusy, dispose }),
  });
  const run = method === 'flush' ? store.flush! : store.commitment!.capture();
  const options = { source: 'held-persistence', priority: 'normal' as const };
  const work = run(options), outcome = work.then(() => 'success', error => error);
  try {
    await started;
    expect(seen).toMatchObject(options);
    expect(setBusy).toHaveBeenCalledWith(true);
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(seen?.signal?.aborted).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    await expect(run(options)).rejects.toThrow('closed');
    expect(persistence).toHaveBeenCalledOnce();
    release();
    expect(await outcome).toBeInstanceOf(Error);
    await closing;
    expect(dispose).toHaveBeenCalledOnce();
    await run(options);
    expect(persistence).toHaveBeenCalledTimes(2);
  } finally { release(); await outcome; await store.close(); }
});

it('preserves persistence errors and caller cancellation and refuses recovery-time admission', async () => {
  const failure = new Error('WAL sync failed');
  const persistence = vi.fn(async (options?: QueryOptions) => { options?.signal?.throwIfAborted(); throw failure; });
  let recovering = false;
  const store = createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:7878/query' }, {
    persistence, getRecoveryState: () => ({ recovering, generation: 0 }),
  });
  try {
    await expect(store.flush!()).rejects.toBe(failure);
    const controller = new AbortController(), reason = new Error('caller stopped'); controller.abort(reason);
    await expect(store.flush!({ signal: controller.signal })).rejects.toBe(reason);
    expect(persistence).toHaveBeenCalledOnce();
    recovering = true;
    await expect(store.commitment!.capture()()).rejects.toMatchObject({ storeOperation: 'flush', outcome: 'not_started' });
    expect(persistence).toHaveBeenCalledOnce();
  } finally { await store.close(); }
});
