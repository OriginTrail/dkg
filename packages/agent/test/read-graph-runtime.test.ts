import { describe, expect, it, vi } from 'vitest';
import { MemoryLayer, createOperationContext, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  OxigraphStore,
  READ_GRAPH_PLANNED_METHODS,
  ReadGraphBuilder,
  readGraphRuntimeOf,
  readGraphLayerOf,
  readGraphStateCompareAndSet,
  withReadGraphBackgroundSlot,
  wrapReadGraphLayer,
} from '@origintrail-official/dkg-storage';
import { READ_GRAPHS_OFF, ReadGraphWorkloadOwnerV1, readGraphWorkloadOf, type ReadGraphModesV1 } from '../src/read-graph-runtime.js';

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

async function agentView(options: { readonly subscribed?: readonly string[] } = {}) {
  const store = wrapReadGraphLayer(new InsertOnlyOxigraph(), { backend: 'oxigraph' });
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
const modes = (on: (key: ReadGraphKey) => boolean): ReadGraphModesV1 => ({ modeOf: (key) => (on(key) ? 'build' : 'off'), keepsAny: () => true });

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
    const { view, store } = await agentView();
    const query = vi.spyOn(store, 'query');
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), modes: modes((key) => key.layer !== MemoryLayer.SharedWorkingMemory) });
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
    query.mockClear();
    const none = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), modes: modes(() => false) });
    expect(await none.wanted()).toEqual([]);
    expect(query.mock.calls.filter(([sparql]) => sparql.includes('SubGraph'))).toHaveLength(0);
  });

  it('sets the identity rule, and marks working-memory read graphs dirty when it changes', async () => {
    const { view, store, setDefaultAgent } = await agentView();
    const runtime = readGraphRuntimeOf(store)!;
    const owner = new ReadGraphWorkloadOwnerV1(view, { logger: logger(), modes: modes(() => true) });
    const wm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT });
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    const ready = (readGraph: string) => ({ readGraph, state: 'ready' as const, generation: 5, ...CURRENT_READ_GRAPH_VERSIONS });
    const below = readGraphLayerOf(store)!.innerStore;
    for (const readGraph of [wm, vm]) {
      await below.update!(readGraphStateCompareAndSet(undefined, ready(readGraph)));
      runtime.mirror.set(ready(readGraph));
    }
    await owner.syncIdentity();
    // The default agent also owns the drafts written under the node's peer ID.
    expect(runtime.workingMemoryIdentity.addressesOf(AGENT)).toHaveLength(2);
    expect(runtime.mirror.get(wm)?.state).toBe('ready');
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
    const { view } = await agentView();
    const log = logger();
    const failing = { ...view, getSubscribedContextGraphs: (): ReadonlyMap<string, unknown> => { throw new Error('not started'); } };
    const owner = new ReadGraphWorkloadOwnerV1(failing, { logger: log, intervalMs: 60_000, modes: modes(() => true) });
    owner.start(ctx);
    await owner.whenIdle();
    expect(log.warn).toHaveBeenCalledWith(ctx, 'Read-graph build pass failed: not started');
    await owner.close();
  });

  it('builds the read graphs it wants once started, and stops on close', async () => {
    const { view, store } = await agentView({ subscribed: [CG] });
    const log = logger();
    const owner = new ReadGraphWorkloadOwnerV1(view, {
      logger: log, intervalMs: 60_000, modes: modes((key) => key.layer === MemoryLayer.VerifiableMemory && key.scope.kind === 'context-graph'),
    });
    owner.start(ctx);
    owner.start(ctx);
    await owner.whenIdle();
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    expect(readGraphRuntimeOf(store)!.mirror.get(vm)?.state).toBe('ready');
    expect(owner.status()).toMatchObject({ lastJob: { readGraph: vm, outcome: 'done' } });
    expect(log.info).toHaveBeenCalledWith(ctx, expect.stringContaining(`Built read graph ${vm}`));
    await owner.close();
    expect(owner.status()).toBeUndefined();
    await owner.close();
  });

  it('asks its builder for a pass on request once started, and nothing before start or after close', async () => {
    const { view } = await agentView({ subscribed: [CG] });
    const requested = vi.spyOn(ReadGraphBuilder.prototype, 'request');
    try {
      const owner = new ReadGraphWorkloadOwnerV1(view, {
        logger: logger(), intervalMs: 60_000, modes: modes((key) => key.layer === MemoryLayer.VerifiableMemory),
      });
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
    const { view } = await agentView({ subscribed: [CG] });
    const owner = new ReadGraphWorkloadOwnerV1(view, {
      logger: logger(), intervalMs: 60_000, modes: modes((key) => key.layer === MemoryLayer.VerifiableMemory && key.scope.kind === 'context-graph'),
    });
    // The agent reaches its workload for requests from outside.
    expect(readGraphWorkloadOf(view)).toBe(owner);
    owner.start(ctx);
    await owner.whenIdle();
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    expect(owner.readGraphStatus()).toMatchObject({ checking: true, lastCheck: undefined, readGraphs: [{ readGraph: vm, state: 'ready' }] });
    const report = await owner.checkNow();
    expect(report).toMatchObject({ mode: 'full', results: [{ readGraph: vm, mode: 'full', outcome: 'consistent' }] });
    expect(owner.readGraphStatus().lastCheck).toBe(report);
    await owner.close();
    expect(owner.readGraphStatus()).toMatchObject({ checking: false, builder: undefined });
  });

  it('ends a check run on request when it stops, and refuses one asked for while it stops', async () => {
    const { view } = await agentView({ subscribed: [CG] });
    const owner = new ReadGraphWorkloadOwnerV1(view, {
      logger: logger(), intervalMs: 60_000, modes: modes((key) => key.layer === MemoryLayer.VerifiableMemory && key.scope.kind === 'context-graph'),
    });
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
});
