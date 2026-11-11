import { describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  InMemoryReadGraphStateMirror,
  OxigraphStore,
  ReadGraphLocks,
  ReadGraphRegistryCache,
  ReadGraphStore,
  ReadGraphWriteTracker,
  createTripleStore,
  readGraphBackendIdentity,
  readGraphBackendRuntime,
  readGraphLayerOf,
  readGraphRuntimeOf,
  wrapReadGraphLayer,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import {
  ReadGraphPartitionStore,
  guardReadGraphPartition,
  noteStoreMayHoldReadGraphPartitions,
  readGraphPartitionMaintenanceStore,
  storeMayHoldReadGraphPartitions,
} from '../src/read-graph-partition-store.js';
import { markReadGraphsDirtyAtStart } from '../src/read-graph-partition-startup.js';
import { workingMemoryIdentityRule } from '../src/read-graph/membership.js';
import { CURRENT_READ_GRAPH_VERSIONS, readGraphStateCompareAndSet } from '../src/read-graph/state.js';

const R1 = readGraphIri({ scope: readScope('a'), layer: MemoryLayer.VerifiableMemory });
const R2 = readGraphIri({ scope: readScope('b'), layer: MemoryLayer.VerifiableMemory });

describe('read-graph locks', () => {
  it('serialize work on a shared read graph and take the locks in code-point order', async () => {
    const locks = new ReadGraphLocks();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = locks.withLocks([R2, R1], async () => {
      events.push('first:start');
      await firstHolds;
      events.push('first:end');
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(locks.isLocked(R1) && locks.isLocked(R2)).toBe(true);
    const second = locks.withLocks([R1], async () => { events.push('second'); });
    const unrelated = locks.withLocks(['urn:other'], async () => { events.push('unrelated'); });
    await unrelated;
    expect(events).toEqual(['first:start', 'unrelated']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'unrelated', 'first:end', 'second']);
    expect(locks.isLocked(R1) || locks.isLocked(R2)).toBe(false);
  });

  it('never deadlocks on two callers that name the same read graphs in opposite orders, and releases on failure', async () => {
    const locks = new ReadGraphLocks();
    const done: string[] = [];
    await Promise.all(Array.from({ length: 20 }, (_, i) => locks.withLocks(i % 2 ? [R1, R2] : [R2, R1], async () => {
      await new Promise((resolve) => setImmediate(resolve));
      done.push(String(i));
    })));
    expect(done).toHaveLength(20);
    await expect(locks.withLocks([R1], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(locks.isLocked(R1)).toBe(false);
    await expect(locks.withLocks([R1, R1], async () => 'once')).resolves.toBe('once');
  });
});

describe('read-graph state mirror and registry cache', () => {
  it('keeps frozen copies of rows and snapshots', () => {
    const mirror = new InMemoryReadGraphStateMirror();
    const row = { readGraph: R1, state: 'ready' as const, generation: 4, ruleVersion: 1, builderVersion: 1 };
    mirror.set(row);
    row.generation = 5;
    expect(mirror.get(R1)?.generation).toBe(4);
    expect(Object.isFrozen(mirror.get(R1))).toBe(true);
    expect(mirror.size).toBe(1);
    expect(mirror.rows()).toEqual([{ ...row, generation: 4 }]);
    mirror.remove(R1);
    expect(mirror.get(R1)).toBeUndefined();
    expect(mirror.size).toBe(0);

    const registries = new ReadGraphRegistryCache();
    const names = ['code'];
    registries.set({ contextGraphId: 'a', subGraphNames: names, childContextGraphRoots: [] });
    names.push('docs');
    expect(registries.get('a')?.subGraphNames).toEqual(['code']);
    registries.invalidate('a');
    expect(registries.get('a')).toBeUndefined();
    registries.set({ contextGraphId: 'b', subGraphNames: [], childContextGraphRoots: [] });
    registries.clear();
    expect(registries.get('b')).toBeUndefined();
  });
});

describe('read-graph backend runtime', () => {
  it('names a backend by its endpoint or its path, and gives an engine in memory none', () => {
    expect(readGraphBackendIdentity({ backend: 'blazegraph', options: { url: 'http://127.0.0.1:9/bigdata/namespace/kb/sparql' } }))
      .toBe('endpoint:http://127.0.0.1:9/bigdata/namespace/kb/sparql');
    expect(readGraphBackendIdentity({ backend: 'sparql-http', options: { queryEndpoint: 'http://h:7/query', updateEndpoint: 'http://h:7/update' } }))
      .toBe('endpoint:http://h:7/update');
    expect(readGraphBackendIdentity({ backend: 'sparql-http', options: { queryEndpoint: 'HTTP://H:7/query' } })).toBe('endpoint:http://h:7/query');
    expect(readGraphBackendIdentity({ backend: 'oxigraph-persistent', options: { path: '/tmp/x/../store' } })).toBe('path:/tmp/store');
    expect(readGraphBackendIdentity({ backend: 'oxigraph-worker', options: { path: '/tmp/store' } })).toBe('path:/tmp/store');
    expect(readGraphBackendIdentity({ backend: 'oxigraph-worker' })).toBeUndefined();
    expect(readGraphBackendIdentity({ backend: 'oxigraph', options: { path: '/tmp/store' } })).toBeUndefined();
    // A built-in backend's own location option only: a stray option changes nothing.
    expect(readGraphBackendIdentity({ backend: 'oxigraph-persistent', options: { path: '/tmp/store', url: 'http://h:7/sparql' } })).toBe('path:/tmp/store');
    expect(readGraphBackendIdentity({ backend: 'blazegraph', options: { url: 'http://h:7/sparql', path: '/tmp/store' } })).toBe('endpoint:http://h:7/sparql');
    expect(readGraphBackendIdentity({ backend: 'sparql-http', options: { url: 'http://h:7/other', queryEndpoint: 'http://h:7/query' } }))
      .toBe('endpoint:http://h:7/query');
    // An adapter registered under another name keeps the first location option it carries, so its store objects share a runtime.
    expect(readGraphBackendIdentity({ backend: 'custom', options: { url: 'http://h:7/sparql' } })).toBe('endpoint:http://h:7/sparql');
    expect(readGraphBackendIdentity({ backend: 'custom', options: { path: '/tmp/x/../custom' } })).toBe('path:/tmp/custom');
    expect(readGraphBackendIdentity({ backend: 'custom' })).toBeUndefined();
  });

  it('records that a backend may hold partitions for every store object over it, and only over it', () => {
    const config = { backend: 'blazegraph', options: { url: `http://127.0.0.1:1/${Math.random()}` } };
    const one = guardReadGraphPartition(wrapReadGraphLayer(new OxigraphStore(), config));
    const two = guardReadGraphPartition(wrapReadGraphLayer(new OxigraphStore(), { ...config }));
    const elsewhere = guardReadGraphPartition(wrapReadGraphLayer(new OxigraphStore(), { backend: 'oxigraph' }));
    expect(storeMayHoldReadGraphPartitions(two)).toBe(false);
    noteStoreMayHoldReadGraphPartitions(one);
    expect(storeMayHoldReadGraphPartitions(two)).toBe(true);
    expect(storeMayHoldReadGraphPartitions(elsewhere)).toBe(false);
    // A store without the layer keeps the record on its own adapter object.
    const bare = new OxigraphStore();
    noteStoreMayHoldReadGraphPartitions(bare);
    expect(storeMayHoldReadGraphPartitions(bare)).toBe(true);
    expect(storeMayHoldReadGraphPartitions(new OxigraphStore())).toBe(false);
  });

  it('records partitions that start-up finds below the layer for every store object over the backend', async () => {
    const config = { backend: 'blazegraph', options: { url: `http://127.0.0.1:1/${Math.random()}` } };
    const one = guardReadGraphPartition(wrapReadGraphLayer(new OxigraphStore(), config));
    const two = guardReadGraphPartition(wrapReadGraphLayer(new OxigraphStore(), { ...config }));
    const below = readGraphPartitionMaintenanceStore(one);
    expect(readGraphRuntimeOf(below)).toBe(readGraphLayerOf(one)!.runtime);
    expect(readGraphRuntimeOf(new OxigraphStore())).toBeUndefined();
    const { ruleVersion, builderVersion } = CURRENT_READ_GRAPH_VERSIONS;
    await below.update!(readGraphStateCompareAndSet(undefined, { readGraph: R1, state: 'ready', generation: 3, ruleVersion, builderVersion }));
    expect(storeMayHoldReadGraphPartitions(two)).toBe(false);
    expect(await markReadGraphsDirtyAtStart(one)).toBe(1);
    expect(storeMayHoldReadGraphPartitions(two)).toBe(true);
  });

  it('shares one runtime among the store objects of one backend, and none for an engine in memory', () => {
    const backend = `endpoint:urn:test:${Math.random()}`;
    expect(readGraphBackendRuntime(backend)).toBe(readGraphBackendRuntime(backend));
    expect(readGraphBackendRuntime(undefined)).not.toBe(readGraphBackendRuntime(undefined));
    const config = { backend: 'blazegraph', options: { url: `http://127.0.0.1:1/${Math.random()}` } };
    const one = wrapReadGraphLayer(new OxigraphStore(), config);
    const two = wrapReadGraphLayer(new OxigraphStore(), { ...config });
    expect(one.runtime).toBe(two.runtime);
    expect(wrapReadGraphLayer(new OxigraphStore(), { backend: 'oxigraph' }).runtime)
      .not.toBe(wrapReadGraphLayer(new OxigraphStore(), { backend: 'oxigraph' }).runtime);
    const rule = workingMemoryIdentityRule({ defaultAgentAddress: '0x' + 'ab'.repeat(20) });
    wrapReadGraphLayer(new OxigraphStore(), { ...config, readGraphs: { workingMemoryIdentity: rule } });
    expect(one.runtime.workingMemoryIdentity).toBe(rule);
  });

  it('waits for the writes in flight when asked, failed ones included, but not for later ones, and stops waiting on abort', async () => {
    const tracker = new ReadGraphWriteTracker();
    const first = gate();
    const failing = gate();
    const later = gate();
    const tracked = tracker.track(first.promise);
    const failed = tracker.track(failing.promise).catch((error: unknown) => error);
    let settled = false;
    const waiting = tracker.settled().then(() => { settled = true; });
    const afterwards = tracker.track(later.promise);
    expect(tracker.size).toBe(3);
    first.open();
    await tracked;
    await turns();
    expect(settled).toBe(false);
    failing.fail(new Error('connection reset'));
    expect(await failed).toBeInstanceOf(Error);
    await waiting;
    expect(tracker.size).toBe(1);
    const controller = new AbortController();
    const aborted = tracker.settled(controller.signal);
    controller.abort(new Error('closing'));
    await expect(aborted).rejects.toThrow('closing');
    await expect(tracker.settled(controller.signal)).rejects.toThrow('closing');
    later.open();
    await afterwards;
    expect(tracker.size).toBe(0);
    await tracker.settled();
  });
});

describe('read-graph layer in the store chain', () => {
  it('sits directly above the adapter and under the partition guard, with storage-owned work below both', async () => {
    const store = await createTripleStore({ backend: 'oxigraph' });
    const layer = readGraphLayerOf(store);
    expect(layer).toBeInstanceOf(ReadGraphStore);
    expect(layer!.innerStore).toBeInstanceOf(OxigraphStore);
    expect(readGraphLayerOf(layer!.innerStore)).toBeNull();
    let guard: unknown = store;
    while (guard && !(guard instanceof ReadGraphPartitionStore)) guard = (guard as { innerStore?: unknown }).innerStore;
    expect((guard as ReadGraphPartitionStore).innerStore).toBe(layer);
    expect(readGraphPartitionMaintenanceStore(store)).toBe(layer!.innerStore);
    expect(readGraphPartitionMaintenanceStore(layer!.innerStore)).toBe(layer!.innerStore);
    await store.close();
  });

  it('has each optional capability exactly when the adapter has it, and declares what the adapter declares', () => {
    const adapter = new OxigraphStore();
    const layer = wrapReadGraphLayer(adapter, { backend: 'oxigraph' });
    const optional = ['deleteByPatternWithoutCount', 'replaceGraph', 'replaceAssetGroup', 'replaceGraphAndSubject', 'replaceSubject',
      'replaceSubjectAndInsert', 'rfc64AuthorCommitCasV1', 'update', 'readGraphInventory', 'listGraphsByPrefix', 'flush', 'graphEnumerationVisibility'] as const;
    const methods = adapter as unknown as Record<string, unknown>;
    for (const name of optional) expect(typeof layer[name], name).toBe(typeof methods[name]);
    const bare = wrapReadGraphLayer(minimalStore([]), { backend: 'oxigraph' });
    for (const name of optional) expect(bare[name], name).toBeUndefined();
    expect(bare.adapterCapabilities).toBeUndefined();
    const declared = { methods: ['delete'] as const, serialUpdates: true };
    expect(wrapReadGraphLayer(Object.assign(minimalStore([]), { readGraphCapabilities: declared }), { backend: 'oxigraph' }).adapterCapabilities)
      .toBe(declared);
  });

  it('passes every call to the adapter unchanged while its backend has no read graphs', async () => {
    const calls: unknown[][] = [];
    const layer = wrapReadGraphLayer(minimalStore(calls), { backend: 'oxigraph' });
    const quad: Quad = { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' };
    const options = { source: 'test' };
    await layer.insert([quad], options);
    await layer.delete([quad], options);
    await layer.deleteByPattern({ graph: 'urn:g' }, options);
    await layer.deleteBySubjectPrefix('urn:g', 'urn:', options);
    await layer.dropGraph('urn:g', options);
    await layer.createGraph('urn:g');
    await layer.query('ASK {}', options);
    await layer.hasGraph('urn:g', options);
    await layer.listGraphs(options);
    await layer.countQuads('urn:g', options);
    expect(calls.map(([name]) => name)).toEqual(['insert', 'delete', 'deleteByPattern', 'deleteBySubjectPrefix', 'dropGraph', 'createGraph',
      'query', 'hasGraph', 'listGraphs', 'countQuads']);
    for (const call of calls) if (call.length > 2) expect(call.at(-1)).toBe(options);
    expect(calls[0]![1]).toEqual([quad]);
  });

  it('tracks every write from its call until it settles, one it sends unmaintained included', async () => {
    const calls: unknown[][] = [];
    const inner = minimalStore(calls);
    const held = gate();
    const layer = wrapReadGraphLayer({ ...inner, insert: async (quads, options) => { await held.promise; return inner.insert(quads, options); } },
      { backend: 'oxigraph' });
    const quad: Quad = { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' };
    const insert = layer.insert([quad]);
    const update = layer.query('INSERT DATA { <urn:s> <urn:p> <urn:o> }');
    void layer.query('ASK {}');
    expect(layer.runtime.writes.size).toBe(2);
    await update;
    let settled = false;
    const waiting = layer.runtime.writes.settled().then(() => { settled = true; });
    await turns();
    expect(settled).toBe(false);
    held.open();
    await Promise.all([insert, waiting]);
    expect(layer.runtime.writes.size).toBe(0);
    expect(calls.map(([name]) => name)).toEqual(['query', 'query', 'insert']);
  });
});

function gate(): { promise: Promise<void>; open: () => void; fail: (error: Error) => void } {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

async function turns(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function minimalStore(calls: unknown[][]): TripleStore {
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push([name, ...args]);
    if (name === 'query') return { type: 'boolean', value: true };
    if (name === 'listGraphs') return [];
    if (name === 'hasGraph') return false;
    if (name === 'deleteByPattern' || name === 'deleteBySubjectPrefix' || name === 'countQuads') return 0;
    return undefined;
  };
  return {
    insert: record('insert'), delete: record('delete'), deleteByPattern: record('deleteByPattern'), query: record('query'),
    hasGraph: record('hasGraph'), createGraph: record('createGraph'), dropGraph: record('dropGraph'), listGraphs: record('listGraphs'),
    deleteBySubjectPrefix: record('deleteBySubjectPrefix'), countQuads: record('countQuads'), close: record('close'),
  } as unknown as TripleStore;
}
