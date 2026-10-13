import { QueryReadAdmission } from '../src/query-read-admission.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const options = { priority: 'background' as const, source: 'api.query.bounded' };
function fixture(timeout = 2000) {
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0,
    healthReservedSlots: 0, normalReservedSlots: 0, backgroundReservedSlots: 0 });
  const store = new BlazegraphStore('http://fixture.invalid/sparql', { scheduler, timeout });
  return { store, scheduler };
}
function response() { return new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } })); }

describe('query read admission', () => {
  it('keeps fresh authority and caller reads together behind the original lane, through decorators', async () => {
    const { store: adapter, scheduler } = fixture();
    const store = new ChangelogStore(new GraphSetIndexStore(new SharedMemoryLiteralBlobStore(adapter,
      { blobDir: '/unused-query-fixture', thresholdBytes: 65536 })));
    const order: string[] = [];
    let queued!: Promise<void>;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      order.push(String(init.body));
      if (order.length === 1) queued = scheduler.run('background', 'import', async () => { order.push('import'); });
      return response();
    }));
    await store.withQueryReadAdmission!(async () => {
      await store.query('SELECT ?authority WHERE {}', options);
      await store.query('SELECT ?data WHERE {}', options);
    }, options);
    await queued;
    expect(order).toEqual(['SELECT ?authority WHERE {}', 'SELECT ?data WHERE {}', 'import']);
    expect(store.graphEnumerationVisibility).toBeTypeOf('function');
  });

  it('serializes sibling reads and retains the slot until aborted transport settles', async () => {
    const { store, scheduler } = fixture();
    const controller = new AbortController();
    let entered!: () => void, settle!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      entered(); init.signal.addEventListener('abort', () => { settle = () => reject(init.signal.reason); });
    }));
    vi.stubGlobal('fetch', fetcher);
    const failure = new Error('caller deadline');
    const work = store.withQueryReadAdmission(() => Promise.all([
      store.query('SELECT ?authority WHERE {}', options), store.query('SELECT ?data WHERE {}', options),
    ]), { ...options, signal: controller.signal });
    const rejected = expect(work).rejects.toBe(failure);
    await started; controller.abort(failure);
    let nextStarted = false;
    const next = scheduler.run('background', 'next', async () => { nextStarted = true; });
    await Promise.resolve(); expect(nextStarted).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1);
    settle(); await rejected; await next;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(nextStarted).toBe(true);
  });

  it('preserves callback error identity and still drains an otherwise successful callback', async () => {
    const admission = new QueryReadAdmission<null>();
    const raw = new Error('read failed'), wrapped = new Error('classified caller failure', { cause: raw });
    await expect(admission.run(null, async () => {
      try { await admission.read(async () => { throw raw; }); }
      catch { throw wrapped; }
    })).rejects.toBe(wrapped);
    await expect(admission.run(null, async () => {
      void admission.read(async () => { throw raw; });
    })).rejects.toBe(raw);
  });

  it('gives successive reads only the remaining deadline and retains cancellation ownership', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { store, scheduler } = fixture(100);
    const signals: AbortSignal[] = [];
    let settle!: () => void;
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      signals.push(init.signal);
      if (signals.length === 1) return response();
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { settle = () => reject(init.signal.reason); });
      });
    }));
    let nextStarted = false;
    const work = store.withQueryReadAdmission(async () => {
      await store.query('SELECT ?authority WHERE {}', options);
      await new Promise(resolve => setTimeout(resolve, 60));
      await store.query('SELECT ?data WHERE {}', options);
    }, options);
    const rejected = expect(work).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(60);
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBe(signals[0]);
    await vi.advanceTimersByTimeAsync(39);
    expect(signals[1]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[1]!.aborted).toBe(true);
    const next = scheduler.run('background', 'next', async () => { nextStarted = true; });
    await Promise.resolve(); expect(nextStarted).toBe(false);
    settle(); await rejected; await next;
    expect(nextStarted).toBe(true);
  });

  it('allows canonical read operations inside the owned slot while rejecting disguised writes', async () => {
    const { store, scheduler } = fixture();
    const run = vi.spyOn(scheduler, 'run');
    const fetcher = vi.fn(async (_url, init) => String(init.body).includes('ASK')
      ? new Response(JSON.stringify({ head: {}, boolean: false })) : response());
    vi.stubGlobal('fetch', fetcher);
    await store.withQueryReadAdmission(async () => {
      await store.hasGraph('urn:g', options);
      await store.listGraphs(options);
      await store.countQuads('urn:g', options);
      await expect(store.query('INSERT DATA { <urn:s> <urn:p> <urn:o> }', options)).rejects.toThrow('Mutations');
    }, options);
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not renew the total deadline or admit writes or escaped callbacks', async () => {
    const { store } = fixture(40);
    let escaped!: () => Promise<unknown>;
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetcher);
    await store.withQueryReadAdmission(async () => {
      escaped = () => store.query('SELECT * WHERE {}', options);
      await expect(store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' }])).rejects.toThrow('Mutations');
    }, options);
    // A function alone does not retain AsyncLocalStorage. An async child does.
    let release!: () => void;
    let child!: Promise<unknown>;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await store.withQueryReadAdmission(async () => { child = gate.then(escaped); }, options);
    release(); await expect(child).rejects.toThrow('closed');
    await expect(store.withQueryReadAdmission(async () => {
      await new Promise(resolve => setTimeout(resolve, 55));
      await store.query('SELECT * WHERE {}', options);
    }, options)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
