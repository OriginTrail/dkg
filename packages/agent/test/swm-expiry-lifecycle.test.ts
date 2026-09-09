import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import { captureSyncHandler, workspaceOpQuads } from './_helpers/sync-responder.js';
import { CG, META, WS, createSwmExpiryFixture, stopTrackedSwmExpiryAgents, trackSwmExpiryAgent, type SwmExpiryTestInternals } from './_helpers/swm-expiry-cleanup.js';

vi.mock('../src/sync/responder/sync-handler.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sync/responder/sync-handler.js')>();
  return { ...actual, registerSyncHandler: vi.fn(actual.registerSyncHandler) };
});

afterEach(async () => {
  await stopTrackedSwmExpiryAgents();
  vi.restoreAllMocks();
  vi.mocked(registerSyncHandler).mockReset();
  vi.useRealTimers();
});

it('uses one runtime TTL update for the registered responder cutoff and automatic cleanup', async () => {
  const cap = captureSyncHandler();
  const actual = await vi.importActual<typeof import('../src/sync/responder/sync-handler.js')>('../src/sync/responder/sync-handler.js');
  vi.mocked(registerSyncHandler).mockImplementationOnce(params => {
    // Keep the real lifecycle's settings binding and real responder. Only wire
    // the transport into this test and admit its local fixture peer.
    params.register = cap.register;
    params.authorizeSyncRequest = async () => true;
    actual.registerSyncHandler(params);
  });
  const agent = await DKGAgent.create({ name: 'expiry-runtime-ttl', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 0 });
  trackSwmExpiryAgent(agent);
  await agent.start();
  const { store } = agent as unknown as SwmExpiryTestInternals;
  const stale = workspaceOpQuads(CG, 'stale', 'urn:ttl:stale', META, new Date(Date.now() - 120_000).toISOString());
  await store.insert([
    ...stale,
    ...workspaceOpQuads(CG, 'fresh', 'urn:ttl:fresh', META, new Date().toISOString()),
    { subject: 'urn:ttl:stale', predicate: 'urn:p', object: '"stale"', graph: WS },
    { subject: 'urn:ttl:fresh', predicate: 'urn:p', object: '"fresh"', graph: WS },
  ]);
  const request = { contextGraphId: CG, includeSharedMemory: true, phase: 'meta' as const, offset: 0, limit: 1000 };
  const query = vi.spyOn(store, 'query');
  const cleanupQueries = () => query.mock.calls.filter(([, options]) => options?.source === 'agent.swmCleanup.expiredOperations').length;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    expect(await cap.invoke({ ...request, syncSessionId: 'ttl-disabled' })).toContain(stale[0]!.subject);
    agent.setSharedMemoryTtlMs(60_000);
    // The scheduled cleanup has not run yet; serving must already use the new TTL.
    expect(cleanupQueries()).toBe(0);
    const filtered = await cap.invoke({ ...request, syncSessionId: 'ttl-enabled' });
    expect(filtered).not.toContain(stale[0]!.subject);
    expect(filtered).toContain(`urn:dkg:share:${CG}:fresh`);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanupQueries()).toBeGreaterThan(0);
    expect(await store.query(`SELECT ?p WHERE { GRAPH <${META}> { <${stale[0]!.subject}> ?p ?o } }`)).toMatchObject({ bindings: [] });
    agent.setSharedMemoryTtlMs(0);
    await store.insert(stale);
    const afterDisable = cleanupQueries();
    await vi.advanceTimersByTimeAsync(900_001);
    expect(cleanupQueries()).toBe(afterDisable);
    expect(await cap.invoke({ ...request, syncSessionId: 'ttl-disabled-again' })).toContain(stale[0]!.subject);
  } finally { vi.useRealTimers(); }
});

it('clears single-flight state after a store failure so the next call can recover', async () => {
  const f = await createSwmExpiryFixture(1);
  vi.mocked(f.store.query).mockRejectedValueOnce(new Error('store temporarily unavailable'));
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(0);
  expect(f.warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('store temporarily unavailable'));
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(3);
  expect(f.operations.size).toBe(0);
});

it('keeps a disabled cleanup from selecting expired operations', async () => {
  const f = await createSwmExpiryFixture(1);
  f.agent.setSharedMemoryTtlMs(0);
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(0);
  expect(f.stats.selections).toBe(0);
});

it('stops a real active cleanup before deletion when TTL is disabled mid-selection', async () => {
  const agent = await DKGAgent.create({
    name: 'expiry-disable-active-pass',
    chainAdapter: new MockChainAdapter(),
    sharedMemoryTtlMs: 60_000,
  });
  trackSwmExpiryAgent(agent);
  const internals = agent as unknown as SwmExpiryTestInternals;
  await internals.store.insert(Array.from({ length: 1001 }, (_, index) => [
    { subject: `urn:expiry:disable:${index}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation', graph: META },
    { subject: `urn:expiry:disable:${index}`, predicate: 'http://dkg.io/ontology/publishedAt', object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
  ]).flat());
  let releaseSelection!: () => void;
  const selectionGate = new Promise<void>(resolve => { releaseSelection = resolve; });
  let selectionEntered!: () => void;
  const selected = new Promise<void>(resolve => { selectionEntered = resolve; });
  const query = internals.store.query.bind(internals.store);
  const querySpy = vi.spyOn(internals.store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (options?.source === 'agent.swmCleanup.expiredOperations') {
      selectionEntered();
      await selectionGate;
    }
    return result;
  });
  const deleted = vi.spyOn(internals.store, 'deleteByPattern');
  vi.useFakeTimers();
  internals.swmExpiryCleanupWorker.start();
  const timerTurn = vi.advanceTimersByTimeAsync(0);
  await selected;
  agent.setSharedMemoryTtlMs(0);
  releaseSelection();
  await timerTurn;
  await vi.advanceTimersByTimeAsync(100);

  expect(querySpy.mock.calls.filter(([, options]) =>
    options?.source === 'agent.swmCleanup.expiredOperations')).toHaveLength(1);
  expect(deleted).not.toHaveBeenCalled();
});

it('drains an in-flight expiry selection before closing the real agent store', async () => {
  const agent = await DKGAgent.create({ name: 'expiry-stop', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  trackSwmExpiryAgent(agent);
  const { store } = agent as unknown as SwmExpiryTestInternals;
  await agent.start();
  await agent.cleanupExpiredSharedMemory();
  await store.insert([
    { subject: 'urn:expiry:stop', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation', graph: META },
    { subject: 'urn:expiry:stop', predicate: 'http://dkg.io/ontology/publishedAt', object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
  ]);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const selected = new Promise<void>(resolve => { entered = resolve; });
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (options?.source === 'agent.swmCleanup.expiredOperations') { entered(); await blocked; }
    return result;
  });
  const closed = vi.spyOn(store, 'close');
  const deleted = vi.spyOn(store, 'deleteByPattern');
  const cleanup = agent.cleanupExpiredSharedMemory();
  await selected;
  const stop = agent.stop();
  try {
    const state = await Promise.race([
      stop.then(() => 'closed'),
      new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 100)),
    ]);
    expect(state).toBe('waiting');
    expect(closed).not.toHaveBeenCalled();
    expect((agent as unknown as { swmExpiryCleanupWorker: { running: boolean } }).swmExpiryCleanupWorker.running).toBe(false);
  } finally {
    release();
    await Promise.all([cleanup, stop]);
  }
  expect(closed).toHaveBeenCalledOnce();
  expect(deleted).not.toHaveBeenCalled();
  expect(await agent.cleanupExpiredSharedMemory()).toBe(0);
});

it('bounds periodic ticks under continuous expired arrivals', async () => {
  const f = await createSwmExpiryFixture(1);
  const query = vi.mocked(f.store.query).getMockImplementation()!;
  const remove = vi.mocked(f.store.deleteByPattern).getMockImplementation()!;
  let next = 1;
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return query(sparql, options);
    f.stats.selections++;
    if (f.stats.selections > 8) throw new Error('fixture stopped an endless arrival stream');
    return { type: 'bindings', bindings: [...f.operations].map(op => ({ op, re: 'urn:expiry:root' })) };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    const wasOperation = pattern.graph === META && pattern.subject && f.operations.has(pattern.subject);
    const deleted = await remove(pattern);
    if (wasOperation) f.operations.add(`urn:expiry:arrival:${next++}`);
    return deleted;
  });
  vi.useFakeTimers();
  (f.agent as unknown as SwmExpiryTestInternals).swmExpiryCleanupWorker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stats.selections).toBeLessThanOrEqual(4);
  expect(f.operations.size).toBe(1);
  const previous = next;
  await vi.advanceTimersByTimeAsync(10);
  expect(next).toBeGreaterThan(previous);
  expect(f.stats.selections).toBeLessThanOrEqual(8);
  expect(f.warning).not.toHaveBeenCalled();
});


it('automatically continues periodic cleanup after a bounded 1000-operation pass', async () => {
  const f = await createSwmExpiryFixture(1001);
  vi.useFakeTimers();
  try {
    (f.agent as unknown as SwmExpiryTestInternals).swmExpiryCleanupWorker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.operations.size).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.operations.size).toBe(0);
    expect(f.stats.maxActive).toBe(1);
    expect(f.stats.largestBatch).toBe(250);
  } finally { vi.useRealTimers(); }
});

it.each([-1, NaN, Infinity, 1e20])('rejects invalid TTL %s at creation and before mutating a running configuration', async ttlMs => {
  const creation = DKGAgent.create({ name: 'invalid-expiry', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: ttlMs })
    .then(agent => { trackSwmExpiryAgent(agent); return agent; });
  await expect(creation).rejects.toThrow('sharedMemoryTtlMs');
  const f = await createSwmExpiryFixture(1);
  expect(() => f.agent.setSharedMemoryTtlMs(ttlMs)).toThrow('sharedMemoryTtlMs');
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(3);
});

it('stops a never-started agent during manual cleanup without admitting a backlog continuation', async () => {
  const f = await createSwmExpiryFixture(1001);
  const remove = vi.mocked(f.store.deleteByPattern).getMockImplementation()!;
  let entered!: () => void;
  const atLastOperation = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    const deleted = await remove(pattern);
    if (pattern.graph === META && deleted === 3 && f.operations.size === 1) {
      entered(); await gate;
    }
    return deleted;
  });
  const cleanup = f.agent.cleanupExpiredSharedMemory();
  await atLastOperation;
  let stopped = false;
  const stop = f.agent.stop().then(() => { stopped = true; });
  await Promise.resolve();
  const stoppedBeforeRelease = stopped;
  release();
  await Promise.all([cleanup, stop]);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(stoppedBeforeRelease).toBe(false);
  expect(f.operations.size).toBe(1);
  expect(f.stats.selections).toBe(4);
});


it.each([
  'agent.swmCleanup.expiredOperations',
  'agent.swmCleanup.revalidateOperation',
])('preserves newly retained operations during an active %s query and serves them through sync', async gatedSource => {
  const cap = captureSyncHandler();
  const actual = await vi.importActual<typeof import('../src/sync/responder/sync-handler.js')>('../src/sync/responder/sync-handler.js');
  vi.mocked(registerSyncHandler).mockImplementationOnce(params => {
    params.register = cap.register;
    params.authorizeSyncRequest = async () => true;
    actual.registerSyncHandler(params);
  });
  const hour = 60 * 60 * 1000;
  const agent = trackSwmExpiryAgent(await DKGAgent.create({
    name: 'expiry-extend-active-ttl', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 0,
  }));
  await agent.start();
  const { store } = agent as unknown as SwmExpiryTestInternals;
  const operation = workspaceOpQuads(CG, 'retained', 'urn:ttl:retained', META, new Date(Date.now() - 2 * hour).toISOString());
  const data = { subject: 'urn:ttl:retained', predicate: 'urn:p', object: '"retained"', graph: WS };
  await store.insert([...operation, data]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const selected = new Promise<void>(resolve => { entered = resolve; });
  const query = store.query.bind(store);
  let gated = false;
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (!gated && options?.source === gatedSource) {
      gated = true;
      entered();
      await gate;
    }
    return result;
  });
  const deletes = vi.spyOn(store, 'deleteByPattern');
  agent.setSharedMemoryTtlMs(hour);
  const cleanup = agent.cleanupExpiredSharedMemory();
  try {
    await selected;
    agent.setSharedMemoryTtlMs(48 * hour);
    release();
    expect(await cleanup).toBe(0);
    expect(deletes).not.toHaveBeenCalled();
    expect(await store.query(`SELECT ?p WHERE { GRAPH <${META}> { <${operation[0]!.subject}> ?p ?o } }`))
      .toMatchObject({ type: 'bindings', bindings: expect.arrayContaining([expect.any(Object)]) });
    expect(await store.query(`SELECT ?o WHERE { GRAPH <${WS}> { <urn:ttl:retained> <urn:p> ?o } }`))
      .toMatchObject({ type: 'bindings', bindings: [{ o: '"retained"' }] });
    expect(await cap.invoke({ contextGraphId: CG, includeSharedMemory: true, phase: 'meta', offset: 0,
      limit: 1000, syncSessionId: 'ttl-extended' })).toContain(operation[0]!.subject);
  } finally {
    release();
    await cleanup;
  }
});
