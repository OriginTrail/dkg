import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { ChangelogStore } from '../src/changelog-store.js';
import { GraphSetIndexStore } from '../src/graph-set-index-store.js';
import { SharedMemoryLiteralBlobStore } from '../src/shared-memory-literal-blob-store.js';

afterEach(() => vi.unstubAllGlobals());
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

  it('does not renew the total deadline or admit writes or escaped callbacks', async () => {
    const { store } = fixture(40);
    let escaped!: () => Promise<unknown>;
    vi.stubGlobal('fetch', vi.fn(async () => response()));
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
  });
});
