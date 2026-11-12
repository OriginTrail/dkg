import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  OxigraphStore,
  READ_GRAPH_PLANNED_METHODS,
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateRowsQuery,
  workingMemoryIdentityRule,
  wrapReadGraphLayer,
  type ReadGraphStoreConfig,
} from '@origintrail-official/dkg-storage';
import { ViewSemanticsDeltaSampler } from '@origintrail-official/dkg-query';
import { DKGAgent, readableViewSemanticsDeltaReport } from '../src/index.js';
import { installReadGraphWorkingMemoryIdentity, viewQueryEngineOptionsOf, viewReadGraphsOf } from '../src/read-graph-view-source.js';
import { ExternallySignedMockChain, payer } from './_helpers/external-signers.js';

const AGENT = `0x${'ab'.repeat(20)}`;
const OTHER = `0x${'cd'.repeat(20)}`;
const THIRD = `0x${'ef'.repeat(20)}`;
const PEER = '12D3KooWPeerOfTheNode';
const vm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.VerifiableMemory });
const swm = (contextGraphId: string): ReadGraphKey => ({ scope: readScope(contextGraphId), layer: MemoryLayer.SharedWorkingMemory });
const wm = (agentAddress: string) => readGraphIri({ scope: readScope('notes'), layer: MemoryLayer.WorkingMemory, agentAddress });
const ready = (readGraph: string) => ({
  readGraph, state: 'ready' as const, generation: 1,
  ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
});

/** A read-graph layer over an in-memory engine that declares every planned method, as a maintaining adapter does. */
function layered(readGraphs: ReadGraphStoreConfig) {
  const adapter = Object.assign(new OxigraphStore(), {
    readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true },
  });
  return wrapReadGraphLayer(adapter, { backend: 'oxigraph', readGraphs });
}
type Layered = ReturnType<typeof layered>;

/** Each read graph ready in the mirror and stored, as the builder leaves a ready read graph. */
async function seedReady(store: Layered, readGraphs: readonly string[]): Promise<void> {
  for (const readGraph of readGraphs) {
    store.runtime.mirror.set(ready(readGraph));
    await store.innerStore.update!(readGraphStateCompareAndSet(undefined, ready(readGraph)));
  }
}
const mirrorStates = (store: Layered, readGraphs: readonly string[]) => readGraphs.map((readGraph) => store.runtime.mirror.get(readGraph)?.state);
async function storedStates(store: Layered, readGraphs: readonly string[]) {
  const result = await store.innerStore.query(readGraphStateRowsQuery());
  const { rows } = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []);
  return readGraphs.map((readGraph) => rows.find((row) => row.readGraph === readGraph)?.state);
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
    const kept = [wm(AGENT), wm(OTHER), wm(THIRD), readGraphIri(vm('notes'))];
    const states = () => mirrorStates(store, kept);

    await installReadGraphWorkingMemoryIdentity(store, { defaultAgentAddress: AGENT, peerId: PEER });
    expect(viewReadGraphsOf(store)!.identity.ownerOf(PEER)).toBe(AGENT);
    // Ready under that rule, as the builder leaves them; the same rule again changes nothing.
    await seedReady(store, kept);
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
    expect(await storedStates(store, kept)).toEqual(['ready', 'ready', 'ready', 'ready']);
    release();
    await held;
    await installing;
    // The marks reach the store under each read graph's lock.
    expect(update).toHaveBeenCalledTimes(2);
    expect(await storedStates(store, kept)).toEqual(['dirty', 'dirty', 'ready', 'ready']);
    expect(states()).toEqual(['dirty', 'dirty', 'ready', 'ready']);
    await expect(installReadGraphWorkingMemoryIdentity(new OxigraphStore(), { peerId: PEER })).resolves.toBeUndefined();
  });

  it('compares the first rule it installs with the one the runtime holds, configured or its own', async () => {
    // Read graphs kept under a rule configured for the layer, which gives the peer ID's drafts to AGENT.
    const configured = layered({ workingMemoryIdentity: workingMemoryIdentityRule({ defaultAgentAddress: AGENT, peerId: PEER }) });
    const kept = [wm(AGENT), wm(OTHER), wm(THIRD), readGraphIri(vm('notes'))];
    await seedReady(configured, kept);
    const installing = installReadGraphWorkingMemoryIdentity(configured, { defaultAgentAddress: OTHER, peerId: PEER });
    // In the call's synchronous step, as for a later change of owner.
    expect(configured.runtime.workingMemoryIdentity.ownerOf(PEER)).toBe(OTHER);
    expect(mirrorStates(configured, kept)).toEqual(['dirty', 'dirty', 'ready', 'ready']);
    await installing;
    expect(await storedStates(configured, kept)).toEqual(['dirty', 'dirty', 'ready', 'ready']);

    // The runtime's own rule gives every address its own drafts: the node's rule moves the peer ID's to the default agent.
    const own = layered({});
    const peerAndAgents = [wm(PEER), wm(AGENT), wm(OTHER)];
    await seedReady(own, peerAndAgents);
    await installReadGraphWorkingMemoryIdentity(own, { defaultAgentAddress: AGENT, peerId: PEER });
    expect(mirrorStates(own, peerAndAgents)).toEqual(['dirty', 'dirty', 'ready']);
    expect(await storedStates(own, peerAndAgents)).toEqual(['dirty', 'dirty', 'ready']);
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

  it('gives its peer ID\'s drafts to a key it adopts as default agent, in the step that changes the default agent', async () => {
    const store = layered({});
    // A: the default agent of a migrated node, whose key the node does not hold. B: the first key it holds, registered below.
    const keyless = ethers.Wallet.createRandom();
    const held = ethers.Wallet.createRandom();
    const [a, b] = [keyless.address.toLowerCase(), held.address.toLowerCase()];
    agent = await DKGAgent.create({
      name: 'ReadGraphAdoption', listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge', store,
      chainAdapter: new ExternallySignedMockChain('mock:31337', payer.address), nodeHeldAuthor: true,
    });
    const node = agent as unknown as { defaultAgentAddress?: string; readonly peerId: string };
    node.defaultAgentAddress = keyless.address;
    await agent.start();
    await agent.registerAgent('custody-author', { publicKey: keyless.signingKey.publicKey });
    expect(agent.getDefaultAgentAddress()).toBe(keyless.address);
    expect(store.runtime.workingMemoryIdentity.ownerOf(node.peerId)).toBe(a);
    const kept = [wm(a), wm(b), wm(THIRD), readGraphIri(vm('notes'))];
    await seedReady(store, kept);

    // What a reader could see when the default agent changes, when the rule is installed, and one microtask after the change.
    const seen: Array<{ step: string; defaultAgent?: string; owner?: string; states: Array<string | undefined> }> = [];
    const observe = (step: string) => seen.push({
      step,
      defaultAgent: node.defaultAgentAddress?.toLowerCase(),
      owner: store.runtime.workingMemoryIdentity.ownerOf(node.peerId),
      states: mirrorStates(store, kept),
    });
    let defaultAgent = node.defaultAgentAddress;
    Object.defineProperty(node, 'defaultAgentAddress', {
      configurable: true,
      get: () => defaultAgent,
      set: (next: string | undefined) => { defaultAgent = next; observe('default agent'); queueMicrotask(() => observe('microtask')); },
    });
    let rule = store.runtime.workingMemoryIdentity;
    Object.defineProperty(store.runtime, 'workingMemoryIdentity', {
      configurable: true,
      get: () => rule,
      set: (next: typeof rule) => { rule = next; observe('rule'); },
    });

    // A maintained write holds the old owner's read graph while the node registers the key it will hold.
    let release: (() => void) | undefined;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => { entered = resolve; });
    const writing = store.runtime.locks.withLocks([wm(a)], () => new Promise<void>((resolve) => { release = resolve; entered(); }));
    await holding;
    const createRandom = vi.spyOn(ethers.Wallet, 'createRandom').mockReturnValueOnce(held);
    try {
      const registering = agent.registerAgent('graph-member');
      await vi.waitFor(() => expect(seen.map(({ step }) => step)).toEqual(['default agent', 'rule', 'microtask']));
      expect(seen).toEqual([
        // One synchronous step changes the default agent, marks both agents' read graphs dirty and installs the new rule.
        { step: 'default agent', defaultAgent: b, owner: a, states: ['ready', 'ready', 'ready', 'ready'] },
        { step: 'rule', defaultAgent: b, owner: b, states: ['dirty', 'dirty', 'ready', 'ready'] },
        // The first moment anything else runs.
        { step: 'microtask', defaultAgent: b, owner: b, states: ['dirty', 'dirty', 'ready', 'ready'] },
      ]);
      // The marks are stored once the old owner's read graph is free, and the registration waits for them.
      expect(await storedStates(store, kept)).toEqual(['ready', 'ready', 'ready', 'ready']);
      const settled = vi.fn();
      void registering.then(settled, settled);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      release!();
      await writing;
      expect((await registering).agentAddress).toBe(held.address);
      expect(agent.getDefaultAgentAddress()).toBe(held.address);
      expect(await storedStates(store, kept)).toEqual(['dirty', 'dirty', 'ready', 'ready']);
    } finally {
      createRandom.mockRestore();
      release?.();
    }
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
      store.runtime.mirror.set(ready(readGraph));
      random.mockReturnValue(0);
      await agent.query('SELECT ?s WHERE { ?s ?p ?o }', { contextGraphId: 'sampled', view: 'verifiable-memory' });
      await vi.waitFor(async () => {
        const report = await readableViewSemanticsDeltaReport(agent!);
        expect(report).toMatchObject([{ contextGraphId: 'sampled' }]);
        // A measured sample: both answers read and classified, none skipped.
        expect(report[0]!.samples).toBeGreaterThan(0);
        expect(report[0]!.skipped).toBe(0);
      });
    } finally {
      random.mockRestore();
    }
  });
});
