import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY, MemoryLayer, readGraphIri, readScope, type ViewQuerySemantics,
} from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS, OxigraphStore, workingMemoryIdentityRule, type ReadGraphState,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine, ViewNotReadyError, ViewSemanticsDeltaSampler, type ViewReadGraphs } from '@origintrail-official/dkg-query';
import { DKGAgent, readableViewSemanticsDeltaReport } from '../src/index.js';

const OWNER = '0x0000000000000000000000000000000000000001';
const OUTSIDER = '0x00000000000000000000000000000000000000ff';
const PEER_ID = 'peer-view-semantics-order';
const PRIVATE_CG = `${OWNER}/semantics-order-private`;
const MISSING_CG = `${OWNER}/semantics-order-never-created`;
// Asset graphs and a read graph, without a declaration, subscription or local create.
const UNDECLARED_CG = `${OWNER}/semantics-order-undeclared`;
// A parent the node holds nothing of, beside a private child context graph `<parent>/context/7`.
const CHILD_ONLY_PARENT = `${OWNER}/semantics-order-parent`;
const READ_GRAPH = readGraphIri({ scope: readScope(PRIVATE_CG), layer: MemoryLayer.VerifiableMemory });
const UNDECLARED_READ_GRAPH = readGraphIri({ scope: readScope(UNDECLARED_CG), layer: MemoryLayer.VerifiableMemory });
const MARKER = 'urn:semantics-order:marker';
const MARKER_CLASS = 'urn:semantics-order:Class';
const SPARQL = `SELECT ?s WHERE { ?s a <${MARKER_CLASS}> }`;
const ON_CHAIN_ID = 7n;

type Outcome = { answer: unknown } | { error: { name: unknown; code: unknown; message: unknown } };

describe('view semantics for a caller who may not read the context graph', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) {
      await agent.stop();
      await agent.store.close();
    }
    agent = undefined;
  });

  async function fixture(state: ReadGraphState, defaultSemantics: ViewQuerySemantics, viewSemanticsDelta?: ViewSemanticsDeltaSampler) {
    const chain = new MockChainAdapter();
    const created = await DKGAgent.create({ name: 'ViewSemanticsAuthorityOrder', chainAdapter: chain, store: new OxigraphStore() });
    agent = created;
    // A host identity is enough for local create and query; no peer runs.
    vi.spyOn(created, 'peerId', 'get').mockReturnValue(PEER_ID);
    created.gossip = {
      subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), publish: vi.fn(async () => undefined),
    } as unknown as DKGAgent['gossip'];
    const runtime = created as unknown as { rfc64PublicCatalogServiceV1: unknown };
    vi.spyOn(runtime, 'rfc64PublicCatalogServiceV1', 'get').mockReturnValue({ acceptedPolicySnapshot: () => null });

    // Only the chain registration is replaced. Read authority and query execution stay real.
    let registered = false;
    const resolveRegistration = created.resolveContextGraphRegistrationBinding.bind(created);
    vi.spyOn(created, 'resolveContextGraphRegistrationBinding').mockImplementation(async (id) => (
      registered && id === PRIVATE_CG
        ? { kind: 'registered' as const, onChainId: ON_CHAIN_ID, provenance: 'numeric-id' as const }
        : resolveRegistration(id)));
    vi.spyOn(chain, 'resolveContextGraphIdsByNameHashes').mockImplementation(async (names) => new Map(names.map((name) => [
      name, registered && name === created.contextGraphNameCommitment(PRIVATE_CG) ? ON_CHAIN_ID : null,
    ])));
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockImplementation(async (id) => registered && id === ON_CHAIN_ID);
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([OWNER]);
    await created.createContextGraph({ id: PRIVATE_CG, name: 'Private graph', accessPolicy: 1, callerAgentAddress: OWNER });
    registered = true;
    const marker = (graph: string) => ({ subject: MARKER, predicate: DKG_ONTOLOGY.RDF_TYPE, object: MARKER_CLASS, graph });
    await created.store.insert([READ_GRAPH, UNDECLARED_READ_GRAPH, `did:dkg:context-graph:${UNDECLARED_CG}/_verifiable_memory/${OWNER}/1`,
      `did:dkg:context-graph:${CHILD_ONLY_PARENT}/context/7`, `did:dkg:context-graph:${CHILD_ONLY_PARENT}/context/7/_meta`].map(marker));

    // The node keeps read graphs for every context graph; this one's is in the given state.
    const readGraphs = {
      keeps: vi.fn(() => true),
      state: vi.fn((readGraph: string) => (readGraph === READ_GRAPH || readGraph === UNDECLARED_READ_GRAPH ? {
        readGraph, state: readGraph === READ_GRAPH ? state : 'ready', generation: 3,
        ruleVersion: CURRENT_READ_GRAPH_VERSIONS.ruleVersion, builderVersion: CURRENT_READ_GRAPH_VERSIONS.builderVersion,
      } : undefined)),
      identity: workingMemoryIdentityRule({ defaultAgentAddress: OWNER, peerId: PEER_ID }),
      defaultSemantics: vi.fn((): ViewQuerySemantics => defaultSemantics),
    } satisfies ViewReadGraphs;
    const engine = new DKGQueryEngine(created.store, { readGraphs, viewSemanticsDelta });
    Object.defineProperty(created, 'queryEngine', { value: engine, configurable: true });
    return { agent: created, execution: vi.spyOn(engine, 'query'), readGraphs };
  }

  const outcome = (query: Promise<unknown>): Promise<Outcome> => query.then(
    (answer) => ({ answer }),
    (error: { name?: unknown; code?: unknown; message?: unknown }) => (
      { error: { name: error.name, code: error.code, message: error.message } }),
  );
  const ask = (target: DKGAgent, contextGraphId: string, semantics: ViewQuerySemantics | undefined, callerAgentAddress = OUTSIDER) =>
    target.query(SPARQL, { contextGraphId, view: 'verifiable-memory', semantics, callerAgentAddress });

  describe.each([
    ['a ready read graph', 'ready'],
    ['a read graph that is not ready', 'dirty'],
  ] as const)('with %s', (_label, state) => {
    it.each([
      ['per-asset', undefined], ['per-asset', 'merged'], ['per-asset', 'per-asset'],
      ['merged', undefined], ['merged', 'merged'], ['merged', 'per-asset'],
    ] as const)('answers as for a context graph that does not exist (default %s, request %s)', async (defaultSemantics, semantics) => {
      const { agent: target, execution, readGraphs } = await fixture(state, defaultSemantics);
      const denied = await outcome(ask(target, PRIVATE_CG, semantics));
      expect(denied).toEqual({ answer: { bindings: [] } });
      // Authority decides before the query runs or anything about read graphs is consulted.
      expect(execution).not.toHaveBeenCalled();
      for (const consulted of [readGraphs.keeps, readGraphs.state, readGraphs.defaultSemantics]) expect(consulted).not.toHaveBeenCalled();
      expect(await outcome(ask(target, MISSING_CG, semantics))).toEqual(denied);
    });
  });

  it('answers merged without a view, and an ASK, as for a context graph that does not exist', async () => {
    const { agent: target, execution } = await fixture('ready', 'per-asset');
    const requests = [
      [SPARQL, { semantics: 'merged' }],
      [`ASK { ?s a <${MARKER_CLASS}> }`, { view: 'verifiable-memory', semantics: 'merged' }],
    ] as const;
    for (const [sparql, options] of requests) {
      const denied = await outcome(target.query(sparql, { ...options, contextGraphId: PRIVATE_CG, callerAgentAddress: OUTSIDER }));
      expect(await outcome(target.query(sparql, { ...options, contextGraphId: MISSING_CG, callerAgentAddress: OUTSIDER }))).toEqual(denied);
    }
    expect(execution).not.toHaveBeenCalled();
  });

  it('reports merged answers sampled on the agent query path, only to a caller who may read the context graph', async () => {
    // The engine gets a read-graph source and a sampler here; the node wires both together with its read-graph settings.
    const sampler = new ViewSemanticsDeltaSampler({ sampleRate: 1 });
    const { agent: target } = await fixture('ready', 'per-asset', sampler);
    // Per asset the marker is in no asset; merged, the read graph holds it.
    await expect(ask(target, PRIVATE_CG, undefined, OWNER)).resolves.toEqual({ bindings: [] });
    await sampler.idle();
    await expect(readableViewSemanticsDeltaReport(target, { callerAgentAddress: OWNER })).resolves.toMatchObject([{
      contextGraphId: PRIVATE_CG, samples: 1, skipped: 0, kinds: { 'rows-added': 1 },
    }]);
    await expect(readableViewSemanticsDeltaReport(target, { callerAgentAddress: OUTSIDER })).resolves.toEqual([]);
    await expect(readableViewSemanticsDeltaReport(target, { contextGraphId: MISSING_CG, callerAgentAddress: OWNER })).resolves.toEqual([]);
  });

  it('answers merged from a context graph the node holds only asset graphs of', async () => {
    const { agent: target } = await fixture('ready', 'per-asset');
    // Readable without a local policy; its asset graphs count as held, so its read graph is read.
    await expect(ask(target, UNDECLARED_CG, 'merged')).resolves.toEqual({ bindings: [{ s: MARKER }], semantics: 'merged' });
    // A child context graph's graphs under the parent's root do not change the parent's answer.
    await expect(ask(target, CHILD_ONLY_PARENT, 'merged')).resolves.toEqual({ bindings: [] });
    // An id that only begins like it holds nothing.
    await expect(ask(target, UNDECLARED_CG.slice(0, -1), 'merged')).resolves.toEqual({ bindings: [] });
    // So does a parent that is not itself a context graph here, whatever its children hold.
    await expect(ask(target, OWNER, 'merged')).resolves.toEqual({ bindings: [] });
  });

  it('consults the read graph for a caller who may read the context graph (control)', async () => {
    const ready = await fixture('ready', 'per-asset');
    await expect(ask(ready.agent, PRIVATE_CG, 'merged', OWNER))
      .resolves.toEqual({ bindings: [{ s: MARKER }], semantics: 'merged' });
    expect(ready.execution).toHaveBeenCalledTimes(1);
    await ready.agent.stop();
    await ready.agent.store.close();
    agent = undefined;
    vi.restoreAllMocks();

    const dirty = await fixture('dirty', 'per-asset');
    await expect(ask(dirty.agent, PRIVATE_CG, 'merged', OWNER)).rejects.toBeInstanceOf(ViewNotReadyError);
  });
});
