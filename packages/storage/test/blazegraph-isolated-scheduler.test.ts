import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { setStoreControlPathForTesting } from '../src/store-control-path.js';

const query = 'SELECT ?predicate ?object WHERE { <urn:asset> ?predicate ?object }';
const response = () => new Response(JSON.stringify({ head: { vars: ['predicate', 'object'] },
  results: { bindings: [{ predicate: { type: 'uri', value: 'urn:p' }, object: { type: 'literal', value: 'v' } }] } }));
const scheduler = () => new StorePriorityScheduler({ maxConcurrent: 1, queueWaitTimeoutMs: 1000 });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { setStoreControlPathForTesting(undefined); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps normal reads, control reads and writes behind the same physical request', async () => {
  setStoreControlPathForTesting({ share: scheduler(), publisher: scheduler() });
  const entered = gate(), release = gate(); let calls = 0, active = 0, peak = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++; peak = Math.max(peak, ++active);
    if (calls === 1) { entered.resolve(); await release.promise; }
    active--; return response();
  }));
  const store = new BlazegraphStore('http://fixture/sparql', { isolatedScheduler: scheduler() });
  const first = store.query(query); await entered.promise;
  const remaining = [store.query(query), store.query(query, { controlQueue: 'share' }),
    store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:g' }], { controlQueue: 'publisher' })];
  try { await setImmediate(); expect(calls).toBe(1); } finally { release.resolve(); await Promise.all([first, ...remaining]); }
  expect(calls).toBe(4); expect(peak).toBe(1);
});

it('retains read-admission ownership across nested reads without deadlocking', async () => {
  const entered = gate(), release = gate(); const order: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { order.push(String(init.body)); return response(); }));
  const store = new BlazegraphStore('http://fixture/sparql', { isolatedScheduler: scheduler() });
  const owned = store.withQueryReadAdmission(async () => {
    await store.query(query); entered.resolve(); await release.promise;
    await store.query(query); await expect(store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:g' }]))
      .rejects.toThrow('Mutations are not allowed');
  });
  await entered.promise;
  const outside = store.query('SELECT ?s WHERE { ?s ?p ?o }');
  try { await setImmediate(); expect(order).toHaveLength(1); } finally { release.resolve(); await Promise.all([owned, outside]); }
  expect(order).toEqual([query, query, 'SELECT ?s WHERE { ?s ?p ?o }']);
});

it('keeps a cancelled request owned until its transport settles and expires queued work without sending it', async () => {
  vi.useFakeTimers();
  const entered = gate(), release = gate(); let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => { calls++; entered.resolve(); await release.promise; return response(); }));
  const store = new BlazegraphStore('http://fixture/sparql', { isolatedScheduler: scheduler(), timeout: 40 });
  const first = store.query(query).then(() => null, error => error); await entered.promise;
  const queued = store.query(query, { controlQueue: 'share' }).then(() => null, error => error);
  await vi.advanceTimersByTimeAsync(41);
  try {
    expect(calls).toBe(1);
    expect(await queued).toMatchObject({ name: 'TimeoutError', outcome: 'not_started' });
    expect(store.getPressureSnapshot().normalInflight).toBe(1);
  } finally { release.resolve(); }
  expect(await first).toMatchObject({ name: 'TimeoutError', outcome: 'indeterminate' });
  expect(calls).toBe(1); expect(store.getPressureSnapshot().normalInflight).toBe(0);
});

it('preserves independent control capacity on ordinary external stores', async () => {
  setStoreControlPathForTesting({ share: scheduler() });
  const entered = gate(), release = gate(); let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => { calls++; if (calls === 1) { entered.resolve(); await release.promise; } return response(); }));
  const store = new BlazegraphStore('http://fixture/sparql', { scheduler: scheduler() });
  const first = store.query(query); await entered.promise;
  try { await store.query(query, { controlQueue: 'share' }); expect(calls).toBe(2); } finally { release.resolve(); await first; }
});

it('rejects ambiguous scheduler ownership', () => {
  expect(() => new BlazegraphStore('http://fixture/sparql', { scheduler: scheduler(), isolatedScheduler: scheduler() }))
    .toThrow('one scheduler');
});
