import { performance } from 'node:perf_hooks';
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
const stores: TripleStore[] = [];
const agents: DKGAgent[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map(store => store.close()));
});

async function fixture(count: number, noProgress = false, dataDeleted = 0) {
  const agent = await DKGAgent.create({ name: 'expiry-batches', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  const { store, log } = agent as unknown as Internals;
  stores.push(store);
  const operations = new Set(Array.from({ length: count }, (_, i) => `urn:expiry:op:${i}`));
  const stats = { largestBatch: 0, familyLists: 0, selections: 0, active: 0, maxActive: 0 };
  const warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.spyOn(log, 'info').mockImplementation(() => {});
  vi.spyOn(store, 'listGraphsByPrefix').mockImplementation(async prefix => {
    if (prefix === `${WS}/`) {
      stats.familyLists++;
      return Array.from({ length: 100 }, (_, i) => `${WS}/family-${i}`);
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
      return { type: 'bindings', bindings: rows.map(op => ({ op })) };
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
  it.each([0, 1, 250, 251, 2501, 10000])('removes all %i operations in bounded batches with one graph-family discovery', async count => {
    const f = await fixture(count);
    const started = performance.now();
    const cpu = process.cpuUsage();
    const [first, joined] = await Promise.all([f.agent.cleanupExpiredSharedMemory(), f.agent.cleanupExpiredSharedMemory()]);
    if (count === 10000) {
      const used = process.cpuUsage(cpu);
      console.log('SWM_EXPIRY_BENCHMARK ' + JSON.stringify({ operations: count, wallMs: performance.now() - started, cpuMs: (used.user + used.system) / 1000, ...f.stats }));
    }
    expect(f.operations.size).toBe(0);
    expect(first).toBe(count * 3);
    expect(joined).toBe(first);
    expect(f.stats.largestBatch).toBeLessThanOrEqual(250);
    expect(f.stats.familyLists).toBe(count === 0 ? 0 : 1);
    expect(f.stats.maxActive).toBe(1);
    const selections = f.stats.selections;
    expect(await f.agent.cleanupExpiredSharedMemory()).toBe(0);
    expect(f.stats.selections).toBeGreaterThan(selections); // successful flight cleared
  });

  it.each([0, 1])('stops on zero metadata progress when each data deletion returns %i', async dataDeleted => {
    const f = await fixture(1, true, dataDeleted);
    expect(await f.agent.cleanupExpiredSharedMemory()).toBe(dataDeleted * 101);
    expect(f.stats.selections).toBe(1);
    expect(f.warning).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no operation metadata'));
    await f.agent.cleanupExpiredSharedMemory();
    expect(f.stats.selections).toBe(2); // failed/no-progress flight cleared
  });
});

it.each([true, false])('reads distinct bounded real-store batches with prefix listing %s', async prefixListing => {
  const agent = await DKGAgent.create({ name: 'expiry-real-store', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 });
  const { store } = agent as unknown as Internals;
  stores.push(store);
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
    expect((agent as unknown as { swmCleanupTimer: unknown }).swmCleanupTimer).toBeNull();
  } finally {
    release();
    await Promise.all([cleanup, stop]);
  }
  expect(closed).toHaveBeenCalledOnce();
  expect(deleted).not.toHaveBeenCalled();
  expect(await agent.cleanupExpiredSharedMemory()).toBe(0);
});
