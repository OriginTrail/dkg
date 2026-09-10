import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { isStoreSchedulerBusyError, StorePriorityScheduler, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { CG, META, WS, stopTrackedSwmExpiryAgents, trackSwmExpiryAgent, type SwmExpiryTestInternals } from './_helpers/swm-expiry-cleanup.js';

afterEach(async () => {
  await stopTrackedSwmExpiryAgents();
  vi.restoreAllMocks();
});

/** Model the real HTTP adapters: each RPC is scheduled, while a counted delete
 * spans separate graph-wide before/delete/after requests. Back it with Oxigraph. */
function externalStore(inner: TripleStore) {
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 4, ackReservedSlots: 1,
    healthReservedSlots: 1, queueLimits: 64, queueWaitTimeoutMs: 10_000 });
  const stats = { busy: 0, activeDeletes: 0, maxActiveDeletes: 0 };
  const request = async <T>(operation: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await scheduler.run('normal', operation, async () => {
        await setImmediate();
        return work();
      });
    } catch (error) {
      if (isStoreSchedulerBusyError(error)) stats.busy++;
      throw error;
    }
  };
  const countedDelete = async (graph: string | undefined, remove: () => Promise<unknown>) => {
    stats.activeDeletes++;
    stats.maxActiveDeletes = Math.max(stats.maxActiveDeletes, stats.activeDeletes);
    try {
      const before = await request('countQuads', () => inner.countQuads(graph));
      await request('delete', remove);
      const after = await request('countQuads', () => inner.countQuads(graph));
      return Math.max(0, before - after);
    } finally { stats.activeDeletes--; }
  };
  const scheduled = new Set(['query', 'listGraphs', 'listGraphsByPrefix', 'hasGraph', 'dropGraph']);
  const store = new Proxy(inner, {
    get(target, property) {
      if (property === 'getPressureSnapshot') return () => scheduler.snapshot;
      if (property === 'deleteByPattern') return (pattern: Partial<Quad>) =>
        countedDelete(pattern.graph, () => inner.deleteByPattern(pattern));
      if (property === 'deleteBySubjectPrefix') return (graph: string, prefix: string) =>
        countedDelete(graph, () => inner.deleteBySubjectPrefix(graph, prefix));
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && scheduled.has(property)) {
        return (...args: unknown[]) => request(property, async () => Reflect.apply(value, target, args));
      }
      return value.bind(target);
    },
  });
  return { store, stats, scheduler };
}

it.each([8, 250])('drains %i distinct entity locks with a four-slot/64-queue remote store and exact deletion totals', async count => {
  const agent = trackSwmExpiryAgent(await DKGAgent.create({ name: 'expiry-external-store',
    chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: 60_000 }));
  const internals = agent as unknown as SwmExpiryTestInternals;
  const inner = internals.store;
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const dkg = 'http://dkg.io/ontology/';
  await inner.insert([{ subject: `did:dkg:context-graph:${CG}`, predicate: rdfType,
    object: dkg + 'ContextGraph', graph: `did:dkg:context-graph:${CG}/_meta` }]);
  await inner.insert(Array.from({ length: count }, (_, index) => {
    const op = `urn:expiry:external:op:${index}`;
    const root = `urn:expiry:external:root:${index}`;
    return [
      { subject: op, predicate: rdfType, object: dkg + 'WorkspaceOperation', graph: META },
      { subject: op, predicate: dkg + 'publishedAt', object: '"2020-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META },
      { subject: op, predicate: dkg + 'rootEntity', object: root, graph: META },
      { subject: root, predicate: dkg + 'workspaceOwner', object: '"peer"', graph: META },
      { subject: root, predicate: 'urn:value', object: '"expired"', graph: WS },
      { subject: `${root}/.well-known/genid/child`, predicate: 'urn:value', object: '"child"', graph: WS },
    ];
  }).flat());
  const { store, stats, scheduler } = externalStore(inner);
  internals.store = store;
  const warning = vi.spyOn(internals.log, 'warn').mockImplementation(() => {});
  try {
    const total = await agent.cleanupExpiredSharedMemory();
    expect(stats.busy).toBe(0);
    expect(await inner.countQuads(META)).toBe(0);
    expect(await inner.countQuads(WS)).toBe(0);
    expect(total).toBe(count * 6);
    expect(stats.maxActiveDeletes).toBe(1);
    expect(warning).not.toHaveBeenCalled();
    expect(scheduler.snapshot.normalInflight).toBe(0);
    expect(scheduler.snapshot.normalQueued).toBe(0);
  } finally { internals.store = inner; }
});
