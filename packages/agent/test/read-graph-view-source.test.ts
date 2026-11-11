import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  OxigraphStore,
  READ_GRAPH_PLANNED_METHODS,
  workingMemoryIdentityRule,
  wrapReadGraphLayer,
  type ReadGraphStoreConfig,
} from '@origintrail-official/dkg-storage';
import { ViewSemanticsDeltaSampler } from '@origintrail-official/dkg-query';
import { DKGAgent, readableViewSemanticsDeltaReport } from '../src/index.js';
import { installReadGraphWorkingMemoryIdentity, viewQueryEngineOptionsOf, viewReadGraphsOf } from '../src/read-graph-view-source.js';

const AGENT = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;
const THIRD = `0x${'ef'.repeat(20)}`;
const PEER = '12D3KooWPeerOfTheNode';
const vm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
const swm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.SharedWorkingMemory });

/** A read-graph layer over an in-memory engine that declares every planned method, as a maintaining adapter does. */
function layered(readGraphs: ReadGraphStoreConfig) {
  const adapter = Object.assign(new OxigraphStore(), {
    readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true },
  });
  return wrapReadGraphLayer(adapter, { backend: 'oxigraph', readGraphs });
}

describe('the read-graph source of merged view queries', () => {
  it('keeps what the node builds or serves, serves only what it serves, and reads the rest from the runtime', async () => {
    const store = layered({
      modes: {
        default: 'off',
        contextGraphs: { served: { default: 'build', layers: { [MemoryLayer.VerifiableMemory]: 'serve' } } },
      },
      viewSemantics: { contextGraphs: { served: 'merged' } },
    });
    const source = viewReadGraphsOf(store)!;
    expect([source.keeps(vm('served')), source.serves?.(vm('served'))]).toEqual([true, true]);
    // Built but not served: kept for the semantic-delta sampler, never for a request.
    expect([source.keeps(swm('served')), source.serves?.(swm('served'))]).toEqual([true, false]);
    expect([source.keeps(vm('other')), source.serves?.(vm('other'))]).toEqual([false, false]);
    const readGraphOfVm = readGraphIri(vm('served'));
    await source.withWriteLock?.(readGraphOfVm, async () => {
      // The layer's own lock, which every maintained write of that read graph takes.
      expect(store.runtime.locks.isLocked(readGraphOfVm)).toBe(true);
    });
    expect(store.runtime.locks.isLocked(readGraphOfVm)).toBe(false);
    expect(source.defaultSemantics?.('served')).toBe('merged');
    expect(source.defaultSemantics?.('other')).toBe('per-asset');

    const readGraph = readGraphIri(vm('served'));
    expect(source.state(readGraph)).toBeUndefined();
    const row = { readGraph, state: 'ready' as const, generation: 1, ruleVersion: 1, builderVersion: 1 };
    store.runtime.mirror.set(row);
    expect(source.state(readGraph)).toEqual(row);

    const rule = workingMemoryIdentityRule({ defaultAgentAddress: AGENT });
    store.runtime.workingMemoryIdentity = rule;
    expect(source.identity).toBe(rule);
  });

  it('installs the node\'s working-memory rule, marking dirty the read graphs whose drafts change owner in the same step', async () => {
    const store = layered({});
    const wm = (agentAddress: string, contextGraphId = 'notes') =>
      readGraphIri({ scope: readScope(contextGraphId), layer: MemoryLayer.WorkingMemory, agentAddress });
    const ready = (readGraph: string) => ({ readGraph, state: 'ready' as const, generation: 1, ruleVersion: 1, builderVersion: 1 });
    const kept = [wm(AGENT), wm(OTHER), wm(THIRD), readGraphIri(vm('notes'))];
    for (const readGraph of kept) store.runtime.mirror.set(ready(readGraph));
    const states = () => kept.map((readGraph) => store.runtime.mirror.get(readGraph)?.state);

    await installReadGraphWorkingMemoryIdentity(store, { defaultAgentAddress: AGENT, peerId: PEER });
    expect(viewReadGraphsOf(store)!.identity.ownerOf(PEER)).toBe(AGENT);
    expect(states()).toEqual(['ready', 'ready', 'ready', 'ready']);
    await installReadGraphWorkingMemoryIdentity(store, { defaultAgentAddress: AGENT, peerId: PEER });
    expect(states()).toEqual(['ready', 'ready', 'ready', 'ready']);

    // A maintained write holds the old owner's read graph while the node adopts a new default agent.
    const update = vi.spyOn(store.innerStore, 'update');
    let release!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    const held = store.runtime.locks.withLocks([wm(AGENT)], () => new Promise<void>((resolve) => { release = resolve; entered(); }));
    await holding;
    const installing = installReadGraphWorkingMemoryIdentity(store, { defaultAgentAddress: OTHER, peerId: PEER });
    // In the call's synchronous step: the new owner, and both agents' read graphs no longer served. A query that maps
    // the peer ID to the new owner finds its read graph dirty, and the old owner's read graph is dirty too.
    expect(store.runtime.workingMemoryIdentity.ownerOf(PEER)).toBe(OTHER);
    expect(states()).toEqual(['dirty', 'dirty', 'ready', 'ready']);
    expect(update).not.toHaveBeenCalled();
    release();
    await held;
    await installing;
    // The marks reach the store under each read graph's lock.
    expect(update).toHaveBeenCalledTimes(2);
    expect(states()).toEqual(['dirty', 'dirty', 'ready', 'ready']);
    await expect(installReadGraphWorkingMemoryIdentity(new OxigraphStore(), { peerId: PEER })).resolves.toBeUndefined();
  });

  it('is absent for a store without a read-graph layer, and so is the sampler', () => {
    expect(viewReadGraphsOf(new OxigraphStore())).toBeUndefined();
    expect(viewReadGraphsOf(undefined)).toBeUndefined();
    expect(viewQueryEngineOptionsOf(new OxigraphStore())).toEqual({});
    const options = viewQueryEngineOptionsOf(layered({}));
    expect(options.readGraphs).toBeDefined();
    expect(options.viewSemanticsDelta).toBeInstanceOf(ViewSemanticsDeltaSampler);
  });
});

describe('the agent', () => {
  let agent: DKGAgent | undefined;
  afterEach(async () => {
    await agent?.stop().catch(() => undefined);
    agent = undefined;
  });

  it('plans merged view queries from its store\'s read graphs', async () => {
    const store = layered({ modes: { contextGraphs: { served: { default: 'serve' }, built: { default: 'build' } } } });
    agent = await DKGAgent.create({
      name: 'ReadGraphSource', listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter(), nodeRole: 'edge', store,
    });
    (agent as unknown as { defaultAgentAddress?: string }).defaultAgentAddress = AGENT;
    await agent.start();
    // Started, the node maps the drafts under its peer ID to the default agent it settled on.
    const defaultAgent = (agent as unknown as { defaultAgentAddress?: string }).defaultAgentAddress;
    expect(defaultAgent).toBeDefined();
    expect(store.runtime.workingMemoryIdentity.ownerOf(agent.peerId)).toBe(defaultAgent!.toLowerCase());
    // Context graphs the node holds: on one it holds nothing of, merged gets an empty answer before any read-graph state.
    for (const id of ['served', 'built']) await agent.createContextGraph({ id, name: id, description: 'read-graph source test' });
    const merged = (contextGraphId: string) => agent!.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId, view: 'verifiable-memory', semantics: 'merged',
    });
    // Served, but not built yet: the answer is "not ready", which only the node's read graphs can give.
    await expect(merged('served')).rejects.toMatchObject({ code: 'VIEW_NOT_READY' });
    // Built but not served, as with no read graphs at all: merged does not apply.
    await expect(merged('built')).rejects.toMatchObject({ code: 'SEMANTICS_UNSUPPORTED' });
  });

  it('samples a view query on a served read graph through its own engine, and reports it', async () => {
    const store = layered({ modes: { contextGraphs: { sampled: { default: 'serve' } } } });
    // The node's sampler draws from Math.random; the spy is the function it keeps, so it can be made to always sample.
    const random = vi.spyOn(Math, 'random');
    try {
      agent = await DKGAgent.create({
        name: 'ReadGraphSampling', listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter(), nodeRole: 'edge', store,
      });
      await agent.start();
      await agent.createContextGraph({ id: 'sampled', name: 'sampled', description: 'read-graph sampling test' });
      // A ready read graph holding one triple, after the context graph's own writes.
      const readGraph = readGraphIri(vm('sampled'));
      await store.innerStore.insert([{ subject: 'urn:sampled:s', predicate: 'urn:sampled:p', object: '"o"', graph: readGraph }]);
      store.runtime.mirror.set({
        readGraph, state: 'ready', generation: 1,
        ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
      });
      random.mockReturnValue(0);
      await agent.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId: 'sampled', view: 'verifiable-memory' });
      await vi.waitFor(async () => {
        const report = await readableViewSemanticsDeltaReport(agent!);
        expect(report).toMatchObject([{ contextGraphId: 'sampled' }]);
        expect(report[0]!.samples + report[0]!.skipped).toBeGreaterThan(0);
      });
    } finally {
      random.mockRestore();
    }
  });
});
