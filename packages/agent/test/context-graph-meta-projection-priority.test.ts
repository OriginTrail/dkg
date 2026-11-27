import { expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, StorePriorityScheduler, activeDefaultStoreWorkPriority, withDefaultStoreWorkPriority,
  type QueryOptions, type StoreWorkPriority, type TripleStore } from '@origintrail-official/dkg-storage';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const id = 'projection-priority';
function controlledProjection(blockNormal = false) {
  const background = gate(), normal = gate();
  const calls: { priority: StoreWorkPriority; options: QueryOptions }[] = [];
  let policy = 'public', rejectBackground = false;
  const store = { async query(sparql: string, options: QueryOptions = {}) {
    const priority = options.priority ?? activeDefaultStoreWorkPriority() ?? 'normal';
    calls.push({ priority, options });
    if (sparql.includes('SELECT ?p ?o') && sparql.includes('/_meta>')) {
      const capturedPolicy = policy;
      if (priority === 'background') {
        await background.promise;
        if (rejectBackground) throw new Error('background read failed');
      }
      if (priority === 'normal' && blockNormal) await normal.promise;
      return { type: 'bindings', bindings: [{ p: DKG_ONTOLOGY.DKG_ACCESS_POLICY, o: `"${capturedPolicy}"` }] };
    }
    return { type: 'bindings', bindings: [] };
  } } as unknown as TripleStore;
  const projection = new ContextGraphMetaProjection(store);
  return { projection, calls, background, normal, setPolicy: (p: string) => { policy = p; },
    failBackground: () => { rejectBackground = true; }, release: () => { background.release(); normal.release(); } };
}

it('lets normal metadata reads succeed without inheriting a background queue timeout', async () => {
  vi.useFakeTimers();
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0,
    healthReservedSlots: 0, normalReservedSlots: 1, backgroundReservedSlots: 0, queueWaitTimeoutMs: 50 });
  const store = new OxigraphStore(), blocked = gate();
  const query = store.query.bind(store);
  store.query = (sparql, options) => scheduler.run(options?.priority, options?.source ?? 'projection.read', () => query(sparql, options));
  const projection = new ContextGraphMetaProjection(store);
  const blocker = scheduler.run('background', 'test.blocker', () => blocked.promise);
  try {
    const background = withDefaultStoreWorkPriority('background', () => projection.get(id, { source: 'test.background.meta' }));
    const normal = withDefaultStoreWorkPriority('normal', () => projection.get(id, { source: 'test.normal.meta' }));
    const outcomes = Promise.allSettled([background, normal]);
    await vi.advanceTimersByTimeAsync(51);
    const [b, n] = await outcomes;
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'STORE_SCHEDULER_BUSY', priority: 'background' } });
    expect(n).toMatchObject({ status: 'fulfilled', value: { id } });
  } finally { blocked.release(); await blocker; vi.useRealTimers(); }
});

it('preserves explicit query priority over the ambient background lane for every rebuild read', async () => {
  const optionsSeen: QueryOptions[] = [];
  const projection = new ContextGraphMetaProjection({ async query(_sparql: string, options: QueryOptions = {}) {
    optionsSeen.push(options); return { type: 'bindings', bindings: [] };
  } } as unknown as TripleStore);
  await withDefaultStoreWorkPriority('background', () => projection.get(id, { priority: 'normal', source: 'explicit.normal' }));
  expect(optionsSeen.length).toBeGreaterThan(1);
  expect(optionsSeen.every(options => options.priority === 'normal' && options.source === 'explicit.normal' && !options.signal)).toBe(true);
});

it.each(['failure', 'success'] as const)('does not let an older background %s replace or dirty a newer normal cache', async outcome => {
  const h = controlledProjection();
  const old = withDefaultStoreWorkPriority('background', () => h.projection.get(id));
  const settledOld = old.then(value => ({ value }), error => ({ error }));
  h.setPolicy('private');
  let fresh: Awaited<ReturnType<ContextGraphMetaProjection['get']>> | undefined;
  const newer = withDefaultStoreWorkPriority('normal', () => h.projection.get(id)).then(value => { fresh = value; return value; });
  try {
    await flush();
    expect(fresh?.accessPolicy).toBe('private');
    if (outcome === 'failure') h.failBackground();
    h.background.release();
    await settledOld;
    const count = h.calls.length;
    expect((await h.projection.get(id)).accessPolicy).toBe('private');
    expect(h.calls).toHaveLength(count);
  } finally { h.release(); await Promise.allSettled([settledOld, newer]); }
});

it.each(['markDirty', 'requireFreshRead'] as const)('fences cross-lane completions after %s while preserving the original reader', async invalidate => {
  const h = controlledProjection();
  const old = withDefaultStoreWorkPriority('background', () => h.projection.get(id));
  const before = [h.projection.readAuthorityFactsRevision, h.projection.readContextGraphAuthorityFactsRevision(id)];
  h.setPolicy('private'); h.projection[invalidate](id);
  let fresh: Awaited<ReturnType<ContextGraphMetaProjection['get']>> | undefined;
  const newer = withDefaultStoreWorkPriority('normal', () => h.projection.get(id)).then(value => { fresh = value; return value; });
  try {
    await flush();
    expect(fresh?.accessPolicy).toBe('private');
    h.background.release();
    expect((await old).accessPolicy).toBe('public');
    expect((await h.projection.get(id)).accessPolicy).toBe('private');
    if (invalidate === 'requireFreshRead') expect([h.projection.readAuthorityFactsRevision,
      h.projection.readContextGraphAuthorityFactsRevision(id)]).toEqual(before);
  } finally { h.release(); await Promise.allSettled([old, newer]); }
});

it('coalesces within each lane and isolates initiating and joining caller cancellation', async () => {
  const h = controlledProjection(true);
  const firstAbort = new AbortController(), joinAbort = new AbortController();
  const first = withDefaultStoreWorkPriority('background', () => h.projection.get(id, { signal: firstAbort.signal }));
  const join = withDefaultStoreWorkPriority('background', () => h.projection.get(id, { signal: joinAbort.signal }));
  const survivor = withDefaultStoreWorkPriority('background', () => h.projection.get(id));
  const normal = withDefaultStoreWorkPriority('normal', () => h.projection.get(id));
  const normalJoin = withDefaultStoreWorkPriority('normal', () => h.projection.get(id));
  const aborted = Promise.allSettled([first, join]);
  try {
    firstAbort.abort(new Error('first cancelled')); joinAbort.abort(new Error('join cancelled'));
    expect((await aborted).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(h.calls.map(call => call.priority)).toEqual(['background', 'normal']);
    expect(h.calls.every(call => call.options.signal === undefined)).toBe(true);
    h.release();
    expect((await Promise.all([survivor, normal, normalJoin])).map(record => record.id)).toEqual([id, id, id]);
  } finally { h.release(); await Promise.allSettled([first, join, survivor, normal, normalJoin]); }
});

it('bounds duplicate rebuild work to one active attempt per fixed priority lane', async () => {
  const blocked = gate();
  const firstReads: StoreWorkPriority[] = [];
  const projection = new ContextGraphMetaProjection({ async query(sparql: string, options: QueryOptions = {}) {
    if (sparql.includes('SELECT ?p ?o') && sparql.includes('/_meta>')) {
      firstReads.push(options.priority ?? activeDefaultStoreWorkPriority() ?? 'normal');
      await blocked.promise;
    }
    return { type: 'bindings', bindings: [] };
  } } as unknown as TripleStore);
  const priorities = ['ack', 'health', 'normal', 'background'] as const;
  const pending = priorities.flatMap(priority => Array.from({ length: 3 }, () =>
    withDefaultStoreWorkPriority(priority, () => projection.get(id))));
  try {
    expect(firstReads).toEqual(priorities);
    blocked.release();
    const results = await Promise.all(pending);
    expect(results).toHaveLength(12);
    expect(firstReads).toHaveLength(4);
  } finally { blocked.release(); await Promise.allSettled(pending); }
});

it.each(['markDirty', 'requireFreshRead', 'markAllDirty'] as const)('fences stale successors when both lanes are already rebuilding at %s', async invalidate => {
  const h = controlledProjection(true);
  const background = withDefaultStoreWorkPriority('background', () => h.projection.get(id));
  const normal = withDefaultStoreWorkPriority('normal', () => h.projection.get(id));
  const revision = h.projection.readAuthorityFactsRevision;
  h.setPolicy('private');
  if (invalidate === 'markAllDirty') h.projection.markAllDirty();
  else h.projection[invalidate](id);
  const nextBackground = withDefaultStoreWorkPriority('background', () => h.projection.get(id));
  const nextNormal = withDefaultStoreWorkPriority('normal', () => h.projection.get(id));
  // A second refresh must not allocate another attempt in either occupied lane.
  h.projection.requireFreshRead(id);
  const latestNormal = withDefaultStoreWorkPriority('normal', () => h.projection.get(id));
  try {
    expect(h.calls.map(call => call.priority)).toEqual(['background', 'normal']);
    h.release();
    expect((await Promise.all([background, normal])).map(record => record.accessPolicy)).toEqual(['public', 'public']);
    expect((await Promise.all([nextBackground, nextNormal, latestNormal])).map(record => record.accessPolicy)).toEqual(['private', 'private', 'private']);
    // Six store reads form each rebuild; no lane duplicates its pending successor.
    expect(h.calls.filter(call => call.priority === 'normal')).toHaveLength(12);
    expect(h.calls.filter(call => call.priority === 'background')).toHaveLength(12);
    const count = h.calls.length;
    expect((await h.projection.get(id)).accessPolicy).toBe('private');
    expect(h.calls).toHaveLength(count);
    expect(h.projection.readAuthorityFactsRevision).toBe(revision + (invalidate === 'requireFreshRead' ? 0 : 1));
  } finally { h.release(); await Promise.allSettled([background, normal, nextBackground, nextNormal, latestNormal]); }
});

it('rejects pre-aborted initiating and joining callers before creating or borrowing work', async () => {
  const h = controlledProjection();
  const cancelled = new AbortController();
  const reason = new Error('already cancelled');
  cancelled.abort(reason);
  await expect(h.projection.get(id, { signal: cancelled.signal })).rejects.toBe(reason);
  expect(h.calls).toHaveLength(0);
  expect((h.projection as unknown as { entries: Map<string, unknown> }).entries.has(id)).toBe(false);
  const survivor = withDefaultStoreWorkPriority('background', () => h.projection.get(id));
  try {
    await expect(withDefaultStoreWorkPriority('background', () => h.projection.get(id, { signal: cancelled.signal }))).rejects.toBe(reason);
    expect(h.calls).toHaveLength(1);
    h.release();
    await expect(survivor).resolves.toMatchObject({ id });
  } finally { h.release(); await Promise.allSettled([survivor]); }
});

it('cleans up a synchronous store failure so the next caller can rebuild', async () => {
  const failure = new Error('synchronous query failure');
  let fail = true;
  const projection = new ContextGraphMetaProjection({ query() {
    if (fail) throw failure;
    return Promise.resolve({ type: 'bindings', bindings: [] });
  } } as unknown as TripleStore);
  await expect(projection.get(id)).rejects.toBe(failure);
  fail = false;
  await expect(projection.get(id)).resolves.toMatchObject({ id });
});

it('preserves Error-shaped cancellation for a pre-aborted string reason', async () => {
  const h = controlledProjection();
  const cancelled = new AbortController();
  cancelled.abort('string cancellation');
  await expect(h.projection.get(id, { signal: cancelled.signal })).rejects.toThrow('string cancellation');
  expect(h.calls).toHaveLength(0);
});

it('consumes a shared read failure after its sole caller aborts synchronously during startup', async () => {
  const cancelled = new AbortController(), blocked = gate();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  const projection = new ContextGraphMetaProjection({ query() {
    cancelled.abort('synchronous caller cancellation');
    return blocked.promise.then(() => { throw new Error('later shared read failure'); });
  } } as unknown as TripleStore);
  process.on('unhandledRejection', onUnhandled);
  try {
    await expect(projection.get(id, { signal: cancelled.signal })).rejects.toThrow('synchronous caller cancellation');
    blocked.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally { blocked.release(); process.removeListener('unhandledRejection', onUnhandled); }
});

it.each(['explicit', 'ambient'] as const)('rejects an unsupported %s priority before submitting any read', async origin => {
  const h = controlledProjection();
  const invalid = 'unsupported-lane' as StoreWorkPriority;
  const read = origin === 'explicit'
    ? h.projection.get(id, { priority: invalid })
    : withDefaultStoreWorkPriority(invalid, () => h.projection.get(id));
  await expect(read).rejects.toThrow('Unsupported metadata store priority');
  expect(h.calls).toHaveLength(0);
  // Invalid callers leave no poisoned attempt: a valid lane can rebuild next.
  await expect(h.projection.get(id)).resolves.toMatchObject({ id });
});
