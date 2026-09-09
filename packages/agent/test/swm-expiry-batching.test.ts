import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import type { Logger } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { runSwmExpiryCleanup } from '../src/swm-expiry-cleanup.js';
import { withKeyedLocks } from '@origintrail-official/dkg-publisher';
import type { SwmExpiryCleanupWorker } from '../src/swm-expiry-cleanup-worker.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import { captureSyncHandler, workspaceOpQuads } from './_helpers/sync-responder.js';

vi.mock('../src/sync/responder/sync-handler.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/sync/responder/sync-handler.js')>();
  return { ...actual, registerSyncHandler: vi.fn(actual.registerSyncHandler) };
});

const CG = 'expiry-batches';
const WS = `did:dkg:context-graph:${CG}/_shared_memory`;
const META = `${WS}_meta`;
interface Internals {
  swmExpiryCleanupWorker: SwmExpiryCleanupWorker;
  store: TripleStore;
  log: Logger;
  workspaceOwnedEntities: Map<string, Map<string, string>>;
  writeLocks: Map<string, Promise<void>>;
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
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
  agents.push(agent);
  await agent.start();
  const { store } = agent as unknown as Internals;
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

async function fixture(count: number, noProgress = false, dataDeleted = 0) {
  const agent = await DKGAgent.create({ name: 'expiry-batches', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  const { store, log } = agent as unknown as Internals;
  agents.push(agent);
  const operations = new Set(Array.from({ length: count }, (_, i) => `urn:expiry:op:${i}`));
  const stats = { largestBatch: 0, familyLists: 0, selections: 0, active: 0, maxActive: 0 };
  const warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.spyOn(store, 'listGraphsByPrefix').mockImplementation(async prefix => {
    if (prefix === `${WS}/`) {
      stats.familyLists++;
      return Array.from({ length: 2 }, (_, i) => `${WS}/family-${i}`);
    }
    return [META];
  });
  vi.spyOn(store, 'hasGraph').mockResolvedValue(true);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.revalidateOperation') {
      const op = [...operations].find(candidate => sparql.includes(`<${candidate}>`));
      return { type: 'bindings', bindings: op ? [{ op, re: 'urn:expiry:root' }] : [] };
    }
    if (options?.source === 'agent.swmCleanup.expiredOperations') {
      stats.selections++;
      if (stats.selections > count + 4) throw new Error('fixture detected an unbounded no-progress loop');
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      await Promise.resolve();
      const limit = /LIMIT\s+(\d+)/i.exec(sparql);
      const rows = [...operations].slice(0, limit ? Number(limit[1]) : undefined);
      stats.largestBatch = Math.max(stats.largestBatch, rows.length);
      stats.active--;
      return { type: 'bindings', bindings: rows.map(op => ({ op, re: 'urn:expiry:root' })) };
    }
    if (options?.source === 'agent.swmCleanup.operationRoots') {
      return { type: 'bindings', bindings: [{ re: 'urn:expiry:root' }] };
    }
    return { type: 'bindings', bindings: [] };
  });
  vi.spyOn(store, 'deleteByPattern').mockImplementation(async pattern => {
    if (pattern.graph === META && pattern.subject && operations.has(pattern.subject)) {
      if (noProgress) return 0;
      operations.delete(pattern.subject);
      return 3;
    }
    return pattern.graph === META ? 0 : dataDeleted;
  });
  vi.spyOn(store, 'deleteBySubjectPrefix').mockResolvedValue(0);
  return { agent, operations, stats, warning, store };
}

describe('bounded SWM expiry through DKGAgent', () => {
  it.each([0, 1, 250, 251, 501])('removes all %i operations with lock-protected graph-family discovery per operation', async count => {
    const f = await fixture(count);
    const [first, joined] = await Promise.all([f.agent.cleanupExpiredSharedMemory(), f.agent.cleanupExpiredSharedMemory()]);
    expect(f.operations.size).toBe(0);
    expect(first).toBe(count * 3);
    expect(joined).toBe(first);
    expect(f.stats.largestBatch).toBeLessThanOrEqual(250);
    expect(f.stats.familyLists).toBe(count);
    expect(f.stats.maxActive).toBe(1);
    const selections = f.stats.selections;
    expect(await f.agent.cleanupExpiredSharedMemory()).toBe(0);
    expect(f.stats.selections).toBeGreaterThan(selections); // successful flight cleared
  });

  it.each([0, 1])('stops on zero metadata progress when each data deletion returns %i', async dataDeleted => {
    const f = await fixture(1, true, dataDeleted);
    expect(await f.agent.cleanupExpiredSharedMemory()).toBe(dataDeleted * 3);
    expect(f.stats.selections).toBe(1);
    expect(f.warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no operation metadata'));
    await f.agent.cleanupExpiredSharedMemory();
    expect(f.stats.selections).toBe(2); // failed/no-progress flight cleared
  });
});

it.each([true, false])('reads distinct bounded real-store batches with prefix listing %s', async prefixListing => {
  const agent = await DKGAgent.create({ name: 'expiry-real-store', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  const { store } = agent as unknown as Internals;
  agents.push(agent);
  if (!prefixListing) Object.defineProperty(store, 'listGraphsByPrefix', { value: undefined });
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const dkg = 'http://dkg.io/ontology/';
  await store.insert(Array.from({ length: 251 }, (_, i) => [
    { subject: `urn:real-expiry:${i}`, predicate: rdfType, object: `${dkg}WorkspaceOperation`, graph: META },
    { subject: `urn:real-expiry:${i}`, predicate: `${dkg}publishedAt`, object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
    { subject: `urn:real-expiry:${i}`, predicate: `${dkg}publishedAt`, object: '"2020-01-02T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
  ]).flat());
  const query = store.query.bind(store);
  const sizes: number[] = [];
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (options?.source === 'agent.swmCleanup.expiredOperations' && sparql.includes(`GRAPH <${META}>`) && result.type === 'bindings') sizes.push(result.bindings.length);
    return result;
  });
  expect(await agent.cleanupExpiredSharedMemory()).toBe(753);
  expect(sizes).toEqual([250, 1, 0]);
});

it('clears single-flight state after a store failure so the next call can recover', async () => {
  const f = await fixture(1);
  vi.mocked(f.store.query).mockRejectedValueOnce(new Error('store temporarily unavailable'));
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(0);
  expect(f.warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('store temporarily unavailable'));
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(3);
  expect(f.operations.size).toBe(0);
});

it('keeps a disabled cleanup from selecting expired operations', async () => {
  const f = await fixture(1);
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
  agents.push(agent);
  const internals = agent as unknown as Internals;
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
  agents.push(agent);
  const { store } = agent as unknown as Internals;
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
  const f = await fixture(1);
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
  (f.agent as unknown as Internals).swmExpiryCleanupWorker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.stats.selections).toBeLessThanOrEqual(4);
  expect(f.operations.size).toBe(1);
  const previous = next;
  await vi.advanceTimersByTimeAsync(10);
  expect(next).toBeGreaterThan(previous);
  expect(f.stats.selections).toBeLessThanOrEqual(8);
  expect(f.warning).not.toHaveBeenCalled();
});

it('refreshes family graphs for an expired operation arriving between live batches', async () => {
  const agent = await DKGAgent.create({ name: 'expiry-family-arrival', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  const { store } = agent as unknown as Internals;
  agents.push(agent);
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const dkg = 'http://dkg.io/ontology/';
  const timestamp = '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>';
  const metadata = (op: string) => [
    { subject: op, predicate: rdfType, object: `${dkg}WorkspaceOperation`, graph: META },
    { subject: op, predicate: `${dkg}publishedAt`, object: timestamp, graph: META },
  ];
  await store.insert(Array.from({ length: 250 }, (_, i) => metadata(`urn:expiry:initial:${i}`)).flat());
  const newGraph = `${WS}/0x0000000000000000000000000000000000000001/999`;
  const root = 'urn:expiry:late-root';
  const query = store.query.bind(store);
  let selected = 0;
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.expiredOperations' && sparql.includes(`GRAPH <${META}>`) && ++selected === 2) {
      await store.insert([
        { subject: root, predicate: 'urn:value', object: '"expired"', graph: newGraph },
        ...metadata('urn:expiry:late'),
        { subject: 'urn:expiry:late', predicate: `${dkg}rootEntity`, object: root, graph: META },
      ]);
    }
    return query(sparql, options);
  });
  await agent.cleanupExpiredSharedMemory();
  expect(await query(`SELECT ?p WHERE { GRAPH <${newGraph}> { <${root}> ?p ?o } }`)).toMatchObject({ bindings: [] });
  expect(await query(`SELECT ?p WHERE { GRAPH <${META}> { <urn:expiry:late> ?p ?o } }`)).toMatchObject({ bindings: [] });
});

it('revalidates a hydrated batch after a concurrent replacement releases its write lock', async () => {
  const agent = await DKGAgent.create({ name: 'expiry-revalidation', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  agents.push(agent);
  const { store, writeLocks } = agent as unknown as Internals;
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const dkg = 'http://dkg.io/ontology/';
  const expiredAt = '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>';
  const rootA = 'urn:expiry:blocked:a';
  const rootB = 'urn:expiry:blocked:b';
  const opA = 'urn:expiry:blocked:op:a';
  const opB = 'urn:expiry:blocked:op:b';
  const freshOp = 'urn:expiry:fresh:op:b';
  await store.insert(
    [opA, opB].flatMap((op, index) => [
      { subject: op, predicate: rdfType, object: `${dkg}WorkspaceOperation`, graph: META },
      { subject: op, predicate: `${dkg}publishedAt`, object: expiredAt, graph: META },
      { subject: op, predicate: `${dkg}rootEntity`, object: index === 0 ? rootA : rootB, graph: META },
      { subject: index === 0 ? rootA : rootB, predicate: 'urn:value', object: '"expired"', graph: WS },
    ]),
  );
  let releaseWriter!: () => void;
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve; });
  let writerHeld!: () => void;
  const writerHasLock = new Promise<void>(resolve => { writerHeld = resolve; });
  const replacement = withKeyedLocks(writeLocks, [`${CG}\0${rootB}`], async () => {
    writerHeld();
    await writerGate;
    await store.deleteByPattern({ graph: META, subject: opB });
    await store.deleteByPattern({ graph: WS, subject: rootB });
    await store.insert([
      { subject: freshOp, predicate: rdfType, object: `${dkg}WorkspaceOperation`, graph: META },
      { subject: freshOp, predicate: `${dkg}publishedAt`, object: `"${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, graph: META },
      { subject: freshOp, predicate: `${dkg}rootEntity`, object: rootB, graph: META },
      { subject: rootB, predicate: 'urn:value', object: '"fresh"', graph: WS },
    ]);
  });
  await writerHasLock;
  let selected!: () => void;
  const batchSelected = new Promise<void>(resolve => { selected = resolve; });
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (options?.source === 'agent.swmCleanup.expiredOperations' && result.type === 'bindings' && result.bindings.length > 0) selected();
    return result;
  });

  const cleanup = agent.cleanupExpiredSharedMemory();
  await batchSelected;
  releaseWriter();
  await Promise.all([replacement, cleanup]);

  expect(await query(`SELECT ?o WHERE { GRAPH <${WS}> { <${rootB}> <urn:value> ?o } }`))
    .toMatchObject({ bindings: [{ o: '"fresh"' }] });
  expect(await query(`SELECT ?p WHERE { GRAPH <${META}> { <${freshOp}> ?p ?o } }`))
    .toMatchObject({ type: 'bindings' });
});

it('does not let one blocked operation hold an unrelated writer behind the cleanup page', async () => {
  const agent = await DKGAgent.create({
    name: 'expiry-independent-operation-locks',
    chainAdapter: new MockChainAdapter(),
    sharedMemoryTtlMs: 60_000,
  });
  agents.push(agent);
  const { store, writeLocks } = agent as unknown as Internals;
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const dkg = 'http://dkg.io/ontology/';
  const roots = ['urn:expiry:independent:a', 'urn:expiry:independent:b'];
  await store.insert(roots.flatMap((root, index) => [
    { subject: `urn:expiry:independent:op:${index}`, predicate: rdfType, object: `${dkg}WorkspaceOperation`, graph: META },
    { subject: `urn:expiry:independent:op:${index}`, predicate: `${dkg}publishedAt`, object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
    { subject: `urn:expiry:independent:op:${index}`, predicate: `${dkg}rootEntity`, object: root, graph: META },
    { subject: root, predicate: 'urn:value', object: '"expired"', graph: WS },
  ]));

  let releaseBlockedWriter!: () => void;
  const blockedWriterGate = new Promise<void>(resolve => { releaseBlockedWriter = resolve; });
  let blockedWriterEntered!: () => void;
  const blockedWriterHasLock = new Promise<void>(resolve => { blockedWriterEntered = resolve; });
  const blockedWriter = withKeyedLocks(writeLocks, [`${CG}\0${roots[0]}`], async () => {
    blockedWriterEntered();
    await blockedWriterGate;
  });
  await blockedWriterHasLock;

  let pageSelected!: () => void;
  const selected = new Promise<void>(resolve => { pageSelected = resolve; });
  const query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    const result = await query(sparql, options);
    if (options?.source === 'agent.swmCleanup.expiredOperations') pageSelected();
    return result;
  });
  const cleanup = agent.cleanupExpiredSharedMemory();
  await selected;

  let unrelatedWriterCompleted = false;
  const unrelatedWriter = withKeyedLocks(writeLocks, [`${CG}\0${roots[1]}`], async () => {
    unrelatedWriterCompleted = true;
  });
  try {
    await vi.waitFor(() => expect(unrelatedWriterCompleted).toBe(true));
    expect(await query(`SELECT ?p WHERE { GRAPH <${WS}> { <${roots[1]}> ?p ?o } }`))
      .toMatchObject({ bindings: [] });
  } finally {
    releaseBlockedWriter();
    await Promise.all([blockedWriter, unrelatedWriter, cleanup]);
  }
});

it('rotates graph priority so a continuously busy graph cannot starve another CG', async () => {
  const f = await fixture(1);
  const otherMeta = 'did:dkg:context-graph:other-expiry/_shared_memory_meta';
  let otherPending = true;
  const selected: string[] = [];
  vi.mocked(f.store.listGraphsByPrefix!).mockImplementation(async prefix =>
    [META, otherMeta].filter(graph => graph.startsWith(prefix)));
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.revalidateOperation') return { type: 'bindings', bindings: [{ op: 'urn:busy' }] };
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return { type: 'bindings', bindings: [] };
    const graph = sparql.includes(`<${otherMeta}>`) ? otherMeta : META;
    selected.push(graph);
    return { type: 'bindings', bindings: graph === META || otherPending ? [{ op: 'urn:busy' }] : [] };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    if (pattern.graph === otherMeta) otherPending = false;
    return 1;
  });
  vi.useFakeTimers();
  (f.agent as unknown as Internals).swmExpiryCleanupWorker.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(selected).toEqual([META, META, META, META]);
  expect(otherPending).toBe(true);
  selected.length = 0;
  await vi.advanceTimersByTimeAsync(10);
  expect(selected[0]).toBe(otherMeta);
  expect(otherPending).toBe(false);
  expect(f.warning).not.toHaveBeenCalled();
});

it('discovers a newly added graph while an older graph continuously fills its pass budget', async () => {
  const f = await fixture(1);
  const otherMeta = 'did:dkg:context-graph:late-expiry/_shared_memory_meta';
  let added = false;
  let pending = true;
  vi.mocked(f.store.listGraphsByPrefix!).mockImplementation(async prefix =>
    (added ? [META, otherMeta] : [META]).filter(graph => graph.startsWith(prefix)));
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.revalidateOperation') return { type: 'bindings', bindings: [{ op: 'urn:busy' }] };
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return { type: 'bindings', bindings: [] };
    return { type: 'bindings', bindings: !sparql.includes(`<${otherMeta}>`) || pending ? [{ op: 'urn:busy' }] : [] };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    if (pattern.graph === otherMeta) pending = false;
    return 1;
  });
  vi.useFakeTimers();
  (f.agent as unknown as Internals).swmExpiryCleanupWorker.start();
  await vi.advanceTimersByTimeAsync(0);
  added = true;
  await vi.advanceTimersByTimeAsync(10);
  expect(pending).toBe(false);
});

it.each([
  { deletable: true, periodic: false }, { deletable: false, periodic: false },
  { deletable: true, periodic: true }, { deletable: false, periodic: true },
])('finishes a full sweep past four stalled graphs (deletable=$deletable, periodic=$periodic)', async ({ deletable, periodic }) => {
  const f = await fixture(1, true);
  const graphs = [META, ...Array.from({ length: 4 }, (_, index) => `did:dkg:context-graph:expiry-later-${index}/_shared_memory_meta`)];
  const last = graphs[4]!;
  let pending = deletable;
  const selected: string[] = [];
  vi.mocked(f.store.listGraphsByPrefix!).mockImplementation(async prefix => graphs.filter(graph => graph.startsWith(prefix)));
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.swmCleanup.revalidateOperation') {
      const graph = graphs.find(value => sparql.includes(`<${value}>`));
      return { type: 'bindings', bindings: graph ? [{ op: `urn:stalled:${graphs.indexOf(graph)}` }] : [] };
    }
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return { type: 'bindings', bindings: [] };
    const graph = graphs.find(value => sparql.includes(`<${value}>`));
    if (!graph) throw new Error('Unknown cleanup target');
    selected.push(graph);
    if (selected.length > 12) throw new Error('Repeated a permanently stalled sweep');
    return { type: 'bindings', bindings: graph === last && deletable && !pending ? [] : [{ op: `urn:stalled:${graphs.indexOf(graph)}` }] };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    if (pattern.graph === last && pending) { pending = false; return 3; }
    return 0;
  });
  if (periodic) {
    vi.useFakeTimers();
    (f.agent as unknown as Internals).swmExpiryCleanupWorker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(new Set(selected).size).toBe(4);
    await vi.advanceTimersByTimeAsync(100);
  } else {
    expect(await f.agent.cleanupExpiredSharedMemory()).toBe(deletable ? 3 : 0);
  }
  expect(pending).toBe(false);
  expect(new Set(selected)).toEqual(new Set(graphs));
  for (const graph of graphs.slice(0, 4)) expect(selected.filter(value => value === graph)).toHaveLength(1);
  if (!deletable) expect(selected).toHaveLength(5);
});


it('revalidates each operation independently after bounded page discovery', async () => {
  const f = await fixture(501);
  await f.agent.cleanupExpiredSharedMemory();
  const cleanupReads = vi.mocked(f.store.query).mock.calls.filter(([, options]) => options?.source?.startsWith('agent.swmCleanup.'));
  expect(f.operations.size).toBe(0);
  expect(cleanupReads.filter(([, options]) =>
    options?.source === 'agent.swmCleanup.expiredOperations')).toHaveLength(4);
  expect(cleanupReads.filter(([, options]) =>
    options?.source === 'agent.swmCleanup.revalidateOperation')).toHaveLength(501);
});


it('automatically continues periodic cleanup after a bounded 1000-operation pass', async () => {
  const f = await fixture(1001);
  vi.useFakeTimers();
  try {
    (f.agent as unknown as Internals).swmExpiryCleanupWorker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.operations.size).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.operations.size).toBe(0);
    expect(f.stats.maxActive).toBe(1);
    expect(f.stats.largestBatch).toBe(250);
  } finally { vi.useRealTimers(); }
});

it('hydrates every root in a real-store batch without duplicating operation deletion', async () => {
  const agent = await DKGAgent.create({ name: 'expiry-multi-root', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  agents.push(agent);
  const { store } = agent as unknown as Internals;
  const dkg = 'http://dkg.io/ontology/';
  const op = 'urn:expiry:multi-root';
  await store.insert([
    { subject: op, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${dkg}WorkspaceOperation`, graph: META },
    { subject: op, predicate: `${dkg}publishedAt`, object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
    ...['urn:root:a', 'urn:root:b'].flatMap(root => [
      { subject: op, predicate: `${dkg}rootEntity`, object: root, graph: META },
      { subject: root, predicate: 'urn:value', object: '"expired"', graph: WS },
    ]),
  ]);
  const remove = vi.spyOn(store, 'deleteByPattern');
  expect(await agent.cleanupExpiredSharedMemory()).toBe(6);
  expect(remove.mock.calls.filter(([pattern]) => pattern.subject === op)).toHaveLength(1);
  expect(await store.query(`SELECT ?s WHERE { GRAPH <${WS}> { ?s ?p ?o } }`)).toMatchObject({ bindings: [] });
});


it('awaits all 1001 initially expired operations and includes every deletion in the public result', async () => {
  const f = await fixture(1001);
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(3003);
  expect(f.operations.size).toBe(0);
  expect(f.stats.maxActive).toBe(1);
  expect(f.stats.largestBatch).toBe(250);
});

it('rejects Date-out-of-range TTL at creation and before mutating a running configuration', async () => {
  const creation = DKGAgent.create({ name: 'invalid-expiry', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 1e20 })
    .then(agent => { agents.push(agent); return agent; });
  await expect(creation).rejects.toThrow('sharedMemoryTtlMs');
  const f = await fixture(1);
  expect(() => f.agent.setSharedMemoryTtlMs(1e20)).toThrow('sharedMemoryTtlMs');
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(3);
});

it('stops a never-started agent during manual cleanup without admitting a backlog continuation', async () => {
  const f = await fixture(1001);
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


it('logs cutoff conversion failures and resolves through the cleanup error contract', async () => {
  const f = await fixture(1);
  const internals = f.agent as unknown as Internals;
  await expect(runSwmExpiryCleanup({
    store: f.store, log: internals.log, workspaceOwnedEntities: internals.workspaceOwnedEntities,
    writeLocks: new Map(), isClosed: () => false,
  }, 1e20)).resolves.toMatchObject({ triplesDeleted: 0 });
  expect(f.warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Invalid time value'));
});

it.each([undefined, 'research'])('evicts only expired ownership in graph family %s', async subGraph => {
  const agent = await DKGAgent.create({ name: 'expiry-ownership', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  agents.push(agent);
  const { store, workspaceOwnedEntities } = agent as unknown as Internals;
  // Oxigraph ignores empty graph creation; seed the parent CG registration.
  await store.insert([{ subject: `did:dkg:context-graph:${CG}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/ContextGraph', graph: `did:dkg:context-graph:${CG}/_meta` }]);
  const graph = subGraph ? `did:dkg:context-graph:${CG}/${subGraph}/_shared_memory` : WS;
  const key = subGraph ? `${CG}\0${subGraph}` : CG;
  const otherKey = 'unrelated-context';
  workspaceOwnedEntities.set(key, new Map([['urn:expired', 'peer'], ['urn:retained', 'peer']]));
  workspaceOwnedEntities.set(otherKey, new Map([['urn:expired', 'other-peer']]));
  await store.insert([
    { subject: 'urn:op:ownership', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation', graph: `${graph}_meta` },
    { subject: 'urn:op:ownership', predicate: 'http://dkg.io/ontology/publishedAt', object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: `${graph}_meta` },
    { subject: 'urn:op:ownership', predicate: 'http://dkg.io/ontology/rootEntity', object: 'urn:expired', graph: `${graph}_meta` },
    { subject: 'urn:expired', predicate: 'urn:p', object: '"expired"', graph },
    { subject: 'urn:retained', predicate: 'urn:p', object: '"keep"', graph },
  ]);
  await agent.cleanupExpiredSharedMemory();
  expect(workspaceOwnedEntities.get(key)?.has('urn:expired')).toBe(false);
  expect(workspaceOwnedEntities.get(key)?.get('urn:retained')).toBe('peer');
  expect(workspaceOwnedEntities.get(otherKey)?.get('urn:expired')).toBe('other-peer');
});
