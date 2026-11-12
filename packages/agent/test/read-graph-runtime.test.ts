import { describe, expect, it, vi } from 'vitest';
import { MemoryLayer, createOperationContext, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  OxigraphStore,
  readGraphDropRequests,
  readStoredReadGraphRow,
  startReadGraphs,
  READ_GRAPH_PLANNED_METHODS,
  ReadGraphBuilder,
  readGraphRuntimeOf,
  readGraphLayerOf,
  readGraphStateCompareAndSet,
  withReadGraphBackgroundSlot,
  wrapReadGraphLayer,
  type ReadGraphModes,
} from '@origintrail-official/dkg-storage';
import { ContextGraphPartitionQueryMethods } from '../src/internal/context-graph-partition-query.js';
import { READ_GRAPHS_OFF, ReadGraphWorkloadOwnerV1, readGraphWorkloadOf } from '../src/read-graph-runtime.js';

const CG = 'read-graph-runtime';
const ROOT = `did:dkg:context-graph:${CG}`;
const AGENT = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;
const ctx = createOperationContext('system');

/** Embedded Oxigraph that offers no write the read-graph layer would have to plan, so its read graphs are maintained. */
class InsertOnlyOxigraph extends OxigraphStore {
  readonly readGraphCapabilities = Object.freeze({ methods: Object.freeze(['update'] as const), serialUpdates: true });
  constructor() {
    super();
    for (const method of READ_GRAPH_PLANNED_METHODS.filter((name) => name !== 'update')) {
      Object.defineProperty(this, method, { value: undefined, configurable: true, writable: true });
    }
  }
}

/** An agent over a store of its own, its read graphs at `modes` (all off without them), as the node's settings set them. */
async function agentView(options: { readonly subscribed?: readonly string[]; readonly modes?: ReadGraphModes } = {}) {
  const store = wrapReadGraphLayer(new InsertOnlyOxigraph(), { backend: 'oxigraph', ...(options.modes ? { readGraphs: { modes: options.modes } } : {}) });
  await store.insert([
    { subject: `${ROOT}/code`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
    { subject: `${ROOT}/code`, predicate: 'http://schema.org/name', object: '"code"', graph: `${ROOT}/_meta` },
    { subject: 'urn:s:1', predicate: 'urn:p', object: '"v1"', graph: `${ROOT}/_verifiable_memory/${AGENT}/1` },
  ]);
  let defaultAgent: string | undefined = AGENT;
  const view = {
    store,
    peerId: '12D3KooWReadGraphRuntimeTestPeer',
    getDefaultAgentAddress: () => defaultAgent,
    getSubscribedContextGraphs: () => new Map((options.subscribed ?? [CG, 'not eligible/_x']).map((id) => [id, {}])),
    listLocalAgents: () => [{ agentAddress: AGENT }, { agentAddress: OTHER }, { agentAddress: AGENT }],
  };
  return { store, view, setDefaultAgent: (address: string | undefined) => { defaultAgent = address; } };
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const VM_BUILT: ReadGraphModes = { layers: { [MemoryLayer.VerifiableMemory]: 'build' } };

describe('the agent read-graph workload', () => {
  it('does not start while every read graph is off', async () => {
    const { view } = await agentView();
    expect(READ_GRAPHS_OFF.modeOf({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory })).toBe('off');
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger() });
    owner.start(ctx);
    expect(owner.status()).toBeUndefined();
    await owner.whenIdle();
    await owner.close();
  });

  it('wants each kept layer of each subscribed context graph, whole and per registered sub-graph, and working memory per agent', async () => {
    const { view, store } = await agentView({ modes: { layers: { [MemoryLayer.VerifiableMemory]: 'build', [MemoryLayer.WorkingMemory]: 'build' } } });
    const query = vi.spyOn(store, 'query');
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger() });
    const keys = await owner.wanted();
    expect(keys.map((key) => readGraphIri(key)).sort()).toEqual([
      { scope: readScope(CG), layer: MemoryLayer.VerifiableMemory },
      { scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT },
      { scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: OTHER },
      { scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory },
      { scope: readScope(CG, 'code'), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT },
      { scope: readScope(CG, 'code'), layer: MemoryLayer.WorkingMemory, agentAddress: OTHER },
    ].map((key) => readGraphIri(key as ReadGraphKey)).sort());
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('SubGraph'))).toHaveLength(1);
    // A context graph that keeps nothing needs no registry read.
    const off = await agentView();
    const offQuery = vi.spyOn(off.store, 'query');
    const none = new ReadGraphWorkloadOwnerV1(off.view, { logger: logger() });
    expect(await none.wanted()).toEqual([]);
    expect(offQuery.mock.calls.filter(([sparql]) => sparql.includes('SubGraph'))).toHaveLength(0);
  });

  it('sets the identity rule, and marks working-memory read graphs dirty when it changes', async () => {
    const { view, store, setDefaultAgent } = await agentView({ modes: { default: 'build' } });
    const runtime = readGraphRuntimeOf(store)!;
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger() });
    const wm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT });
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    const ready = (readGraph: string) => ({ readGraph, state: 'ready' as const, generation: 5, ...CURRENT_READ_GRAPH_VERSIONS });
    const below = readGraphLayerOf(store)!.innerStore;
    await owner.syncIdentity();
    // The default agent also owns the drafts written under the node's peer ID.
    expect(runtime.workingMemoryIdentity.addressesOf(AGENT)).toHaveLength(2);
    // Ready under that rule, as the builder leaves them; the same identity again changes nothing.
    for (const readGraph of [wm, vm]) {
      await below.update!(readGraphStateCompareAndSet(undefined, ready(readGraph)));
      runtime.mirror.set(ready(readGraph));
    }
    await owner.syncIdentity();
    expect(runtime.mirror.get(wm)?.state).toBe('ready');
    setDefaultAgent(OTHER);
    await owner.syncIdentity();
    expect(runtime.mirror.get(wm)).toMatchObject({ state: 'dirty', generation: 6 });
    expect(runtime.mirror.get(vm)?.state).toBe('ready');
    expect(runtime.workingMemoryIdentity.addressesOf(AGENT)).toEqual([AGENT]);
    expect(runtime.workingMemoryIdentity.addressesOf(OTHER)).toHaveLength(2);
  });

  it('logs a pass that fails', async () => {
    const { view } = await agentView({ modes: { default: 'build' } });
    const log = logger();
    const failing = { ...view, getSubscribedContextGraphs: (): ReadonlyMap<string, unknown> => { throw new Error('not started'); } };
    const owner = new ReadGraphWorkloadOwnerV1(failing, { logger: log, intervalMs: 60_000 });
    owner.start(ctx);
    await owner.whenIdle();
    expect(log.warn).toHaveBeenCalledWith(ctx, 'Read-graph build pass failed: not started');
    await owner.close();
  });

  it('builds the read graphs it wants once started, and stops on close', async () => {
    const { view, store } = await agentView({ subscribed: [CG], modes: VM_BUILT });
    const log = logger();
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: log, intervalMs: 60_000 });
    owner.start(ctx);
    owner.start(ctx);
    await owner.whenIdle();
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    expect(readGraphRuntimeOf(store)!.mirror.get(vm)?.state).toBe('ready');
    expect(owner.status()).toMatchObject({ lastJob: { outcome: 'done' } });
    expect(log.info).toHaveBeenCalledWith(ctx, expect.stringContaining(`Built read graph ${vm}`));
    await owner.close();
    expect(owner.status()).toBeUndefined();
    await owner.close();
  });

  it('asks its builder for a pass on request once started, and nothing before start or after close', async () => {
    const { view } = await agentView({ subscribed: [CG], modes: VM_BUILT });
    const requested = vi.spyOn(ReadGraphBuilder.prototype, 'request');
    try {
      const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), intervalMs: 60_000 });
      owner.request();
      expect(requested).not.toHaveBeenCalled();
      owner.start(ctx);
      owner.request();
      expect(requested).toHaveBeenCalledTimes(1);
      await owner.whenIdle();
      await owner.close();
      owner.request();
      expect(requested).toHaveBeenCalledTimes(1);
    } finally {
      requested.mockRestore();
    }
  });

  it('runs the checks beside the builder, checks every ready read graph on request, and reports both in its status', async () => {
    const { view } = await agentView({ subscribed: [CG], modes: VM_BUILT });
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), intervalMs: 60_000 });
    // The agent reaches its workload for requests from outside.
    expect(readGraphWorkloadOf(view)).toBe(owner);
    owner.start(ctx);
    await owner.whenIdle();
    // The whole graph's and the registered sub-graph's, which follows its context graph.
    const kept = [readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory }), readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory })].sort();
    expect(owner.readGraphStatus()).toMatchObject({ checking: true, lastCheck: undefined, readGraphs: kept.map((readGraph) => ({ readGraph, state: 'ready' })) });
    const report = await owner.checkNow();
    expect(report).toMatchObject({ mode: 'full', results: kept.map((readGraph) => ({ readGraph, mode: 'full', outcome: 'consistent' })) });
    expect(owner.readGraphStatus().lastCheck).toBe(report);
    await owner.close();
    expect(owner.readGraphStatus()).toMatchObject({ checking: false, builder: undefined });
  });

  it('ends a check run on request when it stops, and refuses one asked for while it stops', async () => {
    const { view } = await agentView({ subscribed: [CG], modes: VM_BUILT });
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), intervalMs: 60_000 });
    owner.start(ctx);
    await owner.whenIdle();
    let release: (() => void) | undefined;
    // A build holds the backend's background slot, so the requested check waits for it.
    const build = withReadGraphBackgroundSlot(readGraphLayerOf(view.store)!.runtime, () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeDefined());
    const requested = owner.checkNow();
    const closed = owner.close();
    let closedDone = false;
    void closed.then(() => { closedDone = true; });
    await expect(owner.checkNow()).rejects.toThrow('The read-graph checks are stopping');
    // The requested check still waits for the slot, so the workload has not stopped.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(closedDone).toBe(false);
    release!();
    await build;
    await expect(requested).rejects.toThrow('The read-graph checks are stopping');
    await closed;
    expect(owner.readGraphStatus().lastCheck).toBeUndefined();
  });

  it('starts its builder when a live switch turns a layer on, and removes the layer once it is switched off', async () => {
    const { view, store } = await agentView({ subscribed: [CG] });
    const runtime = readGraphRuntimeOf(store)!;
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), intervalMs: 60_000 });
    owner.start(ctx);
    expect(owner.status()).toBeUndefined();
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    const code = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory });
    const on = await owner.applyReadGraphModes({ contextGraphs: { [CG]: { layers: { [MemoryLayer.VerifiableMemory]: 'serve' } } } });
    expect(on.find((change) => change.layer === 'verifiable-memory')).toMatchObject({ contextGraphId: CG, from: 'off', to: 'serve', outcome: 'applied' });
    // The subscribed context graph's read graphs have rows at once, and the builder runs.
    expect(runtime.mirror.get(vm)?.state).toBe('dirty');
    expect(runtime.mirror.get(code)?.state).toBe('dirty');
    expect(owner.status()).toBeDefined();
    await owner.whenIdle();
    expect(runtime.mirror.get(vm)?.state).toBe('ready');
    expect(runtime.mirror.get(code)?.state).toBe('ready');
    expect(owner.readGraphStatus().checking).toBe(true);
    // Each read graph built carries its size at the build: one asset graph with one triple in the whole graph, none in the sub-graph.
    expect(owner.readGraphStatus().readGraphs).toEqual([
      { readGraph: code, state: 'ready', generation: expect.any(Number), triples: 0, members: 0 },
      { readGraph: vm, state: 'ready', generation: expect.any(Number), triples: 1, members: 1 },
    ].sort((left, right) => (left.readGraph < right.readGraph ? -1 : 1)));

    const off = await owner.applyReadGraphModes({ contextGraphs: { [CG]: { layers: { [MemoryLayer.VerifiableMemory]: 'off' } } } });
    expect(off.find((change) => change.layer === 'verifiable-memory')).toMatchObject({ from: 'serve', to: 'off', outcome: 'applied' });
    expect(runtime.mirror.size).toBe(0);
    await owner.whenIdle();
    expect(readGraphDropRequests(runtime)).toEqual([]);
    expect(owner.readGraphStatus().readGraphs).toEqual([]);
    const below = readGraphLayerOf(store)!.innerStore;
    const left = await below.query(`ASK { GRAPH <${vm}> { ?s ?p ?o } }`);
    expect(left).toMatchObject({ type: 'boolean', value: false });
    await owner.close();
  });

  it('switches nothing on before it starts, and the agent reaches the switch through its workload or, without one, through storage', async () => {
    const { view, store } = await agentView({ subscribed: [CG] });
    const runtime = readGraphRuntimeOf(store)!;
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), intervalMs: 60_000 });
    const next = { contextGraphs: { [CG]: { layers: { [MemoryLayer.VerifiableMemory]: 'build' as const } } } };
    const apply = ContextGraphPartitionQueryMethods.prototype.applyReadGraphModesV1;
    const changes = await apply.call(view as never, next, { viewSemantics: { contextGraphs: { [CG]: 'merged' } } });
    expect(runtime.viewSemantics).toEqual({ contextGraphs: { [CG]: 'merged' } });
    expect(changes.find((change) => change.layer === 'verifiable-memory')?.outcome).toBe('applied');
    // Not started: the rows are there, and no builder runs until the workload starts.
    expect(runtime.mirror.get(readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory }))?.state).toBe('dirty');
    expect(owner.status()).toBeUndefined();
    owner.start(ctx);
    await owner.whenIdle();
    expect(runtime.mirror.get(readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory }))?.state).toBe('ready');
    await owner.close();
    // An agent without the workload switches through storage alone.
    const bare = await agentView({ subscribed: [CG] });
    const plain = await apply.call({ store: bare.store, config: {} } as never, next);
    expect(plain.find((change) => change.layer === 'verifiable-memory')?.outcome).toBe('applied');
    expect(readGraphRuntimeOf(bare.store)!.modes).toEqual(next);
  });

  it('starts its builder on a switch that lists no context graph, so a node default switched on before any subscription is built later', async () => {
    const subscribed: string[] = [];
    const { view, store } = await agentView({ subscribed });
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), intervalMs: 60_000 });
    owner.start(ctx);
    expect(owner.status()).toBeUndefined();
    expect(await owner.applyReadGraphModes({ layers: { [MemoryLayer.VerifiableMemory]: 'serve' } })).toEqual([]);
    expect(owner.status()).toBeDefined();
    await owner.whenIdle();
    // The first subscription comes later; the builder's next pass builds it.
    subscribed.push(CG);
    owner.request();
    await owner.whenIdle();
    expect(readGraphRuntimeOf(store)!.mirror.get(readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory }))?.state).toBe('ready');
    await owner.close();
  });

  it('starts its builder for the removals alone after a start with every mode off, and removes what a switch to off left', async () => {
    const adapter = new InsertOnlyOxigraph();
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    // What an earlier process left when it ended during a drop: the read graph's dirty row and part of its contents.
    const below = readGraphLayerOf(wrapReadGraphLayer(adapter, { backend: 'oxigraph' }))!.innerStore;
    await below.update!(readGraphStateCompareAndSet(undefined, { readGraph: vm, state: 'dirty', generation: 3, ...CURRENT_READ_GRAPH_VERSIONS }));
    await adapter.insert([{ subject: 'urn:s:left', predicate: 'urn:p', object: '"x"', graph: vm }]);
    // The next process: every mode off, and no subscription.
    const store = wrapReadGraphLayer(adapter, { backend: 'oxigraph' });
    await startReadGraphs(store);
    const view = {
      store,
      peerId: '12D3KooWReadGraphRuntimeTestPeer',
      getDefaultAgentAddress: () => AGENT,
      getSubscribedContextGraphs: () => new Map<string, unknown>(),
      listLocalAgents: () => [{ agentAddress: AGENT }],
    };
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), intervalMs: 60_000 });
    owner.start(ctx);
    expect(owner.status()).toBeDefined();
    await owner.whenIdle();
    expect(readGraphDropRequests(readGraphRuntimeOf(store)!)).toEqual([]);
    expect(await below.query(`ASK { GRAPH <${vm}> { ?s ?p ?o } }`)).toMatchObject({ type: 'boolean', value: false });
    expect(await readStoredReadGraphRow(below, vm)).toEqual({ row: undefined, damaged: false });
    await owner.close();
  });
});
