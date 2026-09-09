import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { runSwmExpiryCleanup } from '../src/swm-expiry-cleanup.js';
import { CG, META, WS, createSwmExpiryFixture, stopTrackedSwmExpiryAgents, swmExpiryCleanupContext, trackSwmExpiryAgent, type SwmExpiryTestInternals } from './_helpers/swm-expiry-cleanup.js';

afterEach(async () => {
  await stopTrackedSwmExpiryAgents();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('bounded SWM expiry through DKGAgent', () => {
  it.each([0, 1, 250, 251, 501])('removes all %i operations with lock-protected graph-family discovery per operation', async count => {
    const f = await createSwmExpiryFixture(count);
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
    const f = await createSwmExpiryFixture(1, true, dataDeleted);
    expect(await f.agent.cleanupExpiredSharedMemory()).toBe(dataDeleted * 3);
    expect(f.stats.selections).toBe(1);
    expect(f.warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no operation metadata'));
    await f.agent.cleanupExpiredSharedMemory();
    expect(f.stats.selections).toBe(2); // failed/no-progress flight cleared
  });
});

it.each([true, false])('reads distinct bounded real-store batches with prefix listing %s', async prefixListing => {
  const agent = await DKGAgent.create({ name: 'expiry-real-store', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  const { store } = agent as unknown as SwmExpiryTestInternals;
  trackSwmExpiryAgent(agent);
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


it('refreshes family graphs for an expired operation arriving between live batches', async () => {
  const agent = await DKGAgent.create({ name: 'expiry-family-arrival', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  const { store } = agent as unknown as SwmExpiryTestInternals;
  trackSwmExpiryAgent(agent);
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


it.each([
  { deletable: true, periodic: false }, { deletable: false, periodic: false },
  { deletable: true, periodic: true }, { deletable: false, periodic: true },
])('finishes a full sweep past four stalled graphs (deletable=$deletable, periodic=$periodic)', async ({ deletable, periodic }) => {
  const f = await createSwmExpiryFixture(1, true);
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
    (f.agent as unknown as SwmExpiryTestInternals).swmExpiryCleanupWorker.start();
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
  const f = await createSwmExpiryFixture(501);
  await f.agent.cleanupExpiredSharedMemory();
  const cleanupReads = vi.mocked(f.store.query).mock.calls.filter(([, options]) => options?.source?.startsWith('agent.swmCleanup.'));
  expect(f.operations.size).toBe(0);
  expect(cleanupReads.filter(([, options]) =>
    options?.source === 'agent.swmCleanup.expiredOperations')).toHaveLength(4);
  expect(cleanupReads.filter(([, options]) =>
    options?.source === 'agent.swmCleanup.revalidateOperation')).toHaveLength(501);
});

it('hydrates every root in a real-store batch without duplicating operation deletion', async () => {
  const agent = await DKGAgent.create({ name: 'expiry-multi-root', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  trackSwmExpiryAgent(agent);
  const { store } = agent as unknown as SwmExpiryTestInternals;
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
  const f = await createSwmExpiryFixture(1001);
  expect(await f.agent.cleanupExpiredSharedMemory()).toBe(3003);
  expect(f.operations.size).toBe(0);
  expect(f.stats.maxActive).toBe(1);
  expect(f.stats.largestBatch).toBe(250);
});

it('logs cutoff conversion failures and resolves through the cleanup error contract', async () => {
  const f = await createSwmExpiryFixture(1);
  await expect(runSwmExpiryCleanup(
    swmExpiryCleanupContext(f.agent, { writeLocks: new Map() }),
    1e20,
  )).resolves.toMatchObject({ triplesDeleted: 0 });
  expect(f.warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Invalid time value'));
});

it.each([undefined, 'research'])('evicts only expired ownership in graph family %s', async subGraph => {
  const agent = await DKGAgent.create({ name: 'expiry-ownership', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  trackSwmExpiryAgent(agent);
  const { store, workspaceOwnedEntities } = agent as unknown as SwmExpiryTestInternals;
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


it.each([false, true])('waits for successful parallel deletions after a sibling fails (shutdown=%s)', async shutdown => {
  const agent = await DKGAgent.create({ name: 'expiry-parallel-failure', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  trackSwmExpiryAgent(agent);
  await agent.start();
  await agent.cleanupExpiredSharedMemory();
  const { store, log } = agent as unknown as SwmExpiryTestInternals;
  const failedOp = 'urn:expiry:parallel-failure';
  const slowOp = 'urn:expiry:parallel-slow';
  await store.insert([failedOp, slowOp].flatMap(subject => [
    { subject, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation', graph: META },
    { subject, predicate: 'http://dkg.io/ontology/publishedAt', object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
  ]));
  let entered!: () => void, failed!: () => void, release!: () => void;
  const slowEntered = new Promise<void>(resolve => { entered = resolve; });
  const failureObserved = new Promise<void>(resolve => { failed = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const remove = store.deleteByPattern.bind(store);
  let failOnce = true;
  let siblingFinished = false;
  vi.spyOn(store, 'deleteByPattern').mockImplementation(async pattern => {
    if (pattern.subject === failedOp && failOnce) {
      failOnce = false; failed(); throw new Error('injected parallel deletion failure');
    }
    if (pattern.subject === slowOp) { entered(); await gate; }
    const deleted = await remove(pattern);
    if (pattern.subject === slowOp) siblingFinished = true;
    return deleted;
  });
  const query = vi.spyOn(store, 'query');
  const warning = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const close = store.close.bind(store);
  let closedBeforeSibling = false;
  const closed = vi.spyOn(store, 'close').mockImplementation(async () => {
    closedBeforeSibling = !siblingFinished;
    await close();
  });
  // Keep the same cutoff for the joining call: it must join this physical pass.
  vi.useFakeTimers({ toFake: ['Date'] });
  let completed = false;
  const cleanup = agent.cleanupExpiredSharedMemory().then(value => { completed = true; return value; });
  await Promise.all([slowEntered, failureObserved]);
  await new Promise(resolve => setImmediate(resolve));
  const joined = agent.cleanupExpiredSharedMemory();
  let stopped = false;
  const stop = shutdown ? agent.stop().then(() => { stopped = true; }) : undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(completed).toBe(false);
    expect(stopped).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    expect(query.mock.calls.filter(([sparql, options]) => options?.source === 'agent.swmCleanup.expiredOperations' && sparql.includes(`GRAPH <${META}>`))).toHaveLength(1);
  } finally {
    release();
    await Promise.allSettled([cleanup, joined, stop]);
  }
  expect(await cleanup).toBe(2);
  expect(await joined).toBe(2);
  expect(warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('injected parallel deletion failure'));
  if (shutdown) {
    expect(closed).toHaveBeenCalledOnce();
    expect(closedBeforeSibling).toBe(false);
  } else {
    expect(await agent.cleanupExpiredSharedMemory()).toBe(2);
    expect(await store.query(`SELECT ?op WHERE { GRAPH <${META}> { ?op ?p ?o } }`)).toMatchObject({ bindings: [] });
  }
});
