import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import type { Logger } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

const CG = 'expiry-batches';
const WS = `did:dkg:context-graph:${CG}/_shared_memory`;
const META = `${WS}_meta`;
interface Internals {
  store: TripleStore;
  log: Logger;
  workspaceOwnedEntities: Map<string, Map<string, string>>;
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
  vi.restoreAllMocks();
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
  it.each([0, 1, 250, 251, 501])('removes all %i operations with a fresh graph-family discovery for every batch', async count => {
    const f = await fixture(count);
    const [first, joined] = await Promise.all([f.agent.cleanupExpiredSharedMemory(), f.agent.cleanupExpiredSharedMemory()]);
    expect(f.operations.size).toBe(0);
    expect(first).toBe(count * 3);
    expect(joined).toBe(first);
    expect(f.stats.largestBatch).toBeLessThanOrEqual(250);
    expect(f.stats.familyLists).toBe(Math.ceil(count / 250));
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

it('ends an invocation under continuous expired arrivals and resumes on the next invocation', async () => {
  const f = await fixture(1);
  const query = vi.mocked(f.store.query).getMockImplementation()!;
  const remove = vi.mocked(f.store.deleteByPattern).getMockImplementation()!;
  let next = 1;
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return query(sparql, options);
    f.stats.selections++;
    if (f.stats.selections > 8) throw new Error('fixture stopped an endless arrival stream');
    return { type: 'bindings', bindings: [...f.operations].map(op => ({ op })) };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    const wasOperation = pattern.graph === META && pattern.subject && f.operations.has(pattern.subject);
    const deleted = await remove(pattern);
    if (wasOperation) f.operations.add(`urn:expiry:arrival:${next++}`);
    return deleted;
  });
  await f.agent.cleanupExpiredSharedMemory();
  expect(f.stats.selections).toBeLessThanOrEqual(4);
  expect(f.operations.size).toBe(1);
  const previous = next;
  await f.agent.cleanupExpiredSharedMemory();
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

it('rotates graph priority so a continuously busy graph cannot starve another CG', async () => {
  const f = await fixture(1);
  const otherMeta = 'did:dkg:context-graph:other-expiry/_shared_memory_meta';
  let otherPending = true;
  const selected: string[] = [];
  vi.mocked(f.store.listGraphsByPrefix!).mockImplementation(async prefix =>
    [META, otherMeta].filter(graph => graph.startsWith(prefix)));
  vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
    if (options?.source !== 'agent.swmCleanup.expiredOperations') return { type: 'bindings', bindings: [] };
    const graph = sparql.includes(`<${otherMeta}>`) ? otherMeta : META;
    selected.push(graph);
    return { type: 'bindings', bindings: graph === META || otherPending ? [{ op: 'urn:busy' }] : [] };
  });
  vi.mocked(f.store.deleteByPattern).mockImplementation(async pattern => {
    if (pattern.graph === otherMeta) otherPending = false;
    return 1;
  });
  await f.agent.cleanupExpiredSharedMemory();
  expect(selected).toEqual([META, META, META, META]);
  expect(otherPending).toBe(true);
  selected.length = 0;
  await f.agent.cleanupExpiredSharedMemory();
  expect(selected[0]).toBe(otherMeta);
  expect(otherPending).toBe(false);
  expect(f.warning).not.toHaveBeenCalled();
});


it('hydrates operation metadata with query count proportional to pages', async () => {
  const f = await fixture(501);
  await f.agent.cleanupExpiredSharedMemory();
  const metadataReads = vi.mocked(f.store.query).mock.calls.filter(([, options]) => options?.source?.startsWith('agent.swmCleanup.'));
  expect(f.operations.size).toBe(0);
  expect(metadataReads.length).toBeLessThanOrEqual(4);
});


it('automatically continues a real cleanup pass after a manual 1000-operation result', async () => {
  const f = await fixture(1001);
  vi.useFakeTimers();
  try {
    expect(await f.agent.cleanupExpiredSharedMemory()).toBe(3000);
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
