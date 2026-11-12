import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY, MemoryLayer, contextGraphAssertionUri, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  OxigraphStore, READ_GRAPH_PLANNED_METHODS, buildReadGraph, checkReadGraph, markReadGraphDirty, wrapReadGraphLayer,
  type ReadGraphMode,
} from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { installReadGraphWorkingMemoryIdentity } from '../src/read-graph-view-source.js';

// Qualification of merged view queries through the agent: the read-graph source it builds from its
// store's layer, over read graphs the builder built from the stored member graphs.

const OWNER = '0x0000000000000000000000000000000000000001';
const OUTSIDER = '0x00000000000000000000000000000000000000ff';
const PEER_ID = 'peer-read-graph-qualification';
const PRIVATE_CG = `${OWNER}/qualification-private`;
const MISSING_CG = `${OWNER}/qualification-never-created`;
const ROOT = `did:dkg:context-graph:${PRIVATE_CG}`;
const VM: ReadGraphKey = { scope: readScope(PRIVATE_CG), layer: MemoryLayer.VerifiableMemory };
const SWM: ReadGraphKey = { scope: readScope(PRIVATE_CG), layer: MemoryLayer.SharedWorkingMemory };
const PRODUCT = 'urn:qualification:product';
const PRODUCT_CLASS = 'urn:qualification:Product';
const PRICE = 'urn:qualification:price';
// A join across two assets: a merged answer has it, no single asset does.
const JOIN = `SELECT ?price WHERE { ?product a <${PRODUCT_CLASS}> ; <${PRICE}> ?price }`;
const VIEWS = ['verifiable-memory', 'shared-working-memory', 'working-memory'] as const;
const SEMANTICS = [undefined, 'merged', 'per-asset'] as const;

type Outcome = { answer: unknown } | { error: { name: unknown; code: unknown; message: unknown } };
const outcome = (query: Promise<unknown>): Promise<Outcome> => query.then(
  (answer) => ({ answer }),
  (error: { name?: unknown; code?: unknown; message?: unknown }) => ({ error: { name: error.name, code: error.code, message: error.message } }),
);

/** An embedded store under the read-graph layer, declaring every planned method as a maintaining adapter does. */
function layered(modes: Record<string, ReadGraphMode>) {
  const adapter = Object.assign(new OxigraphStore(), { readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true } });
  const contextGraphs = Object.fromEntries(Object.entries(modes).map(([id, mode]) => [id, { default: mode }]));
  return wrapReadGraphLayer(adapter, { backend: 'oxigraph', readGraphs: { modes: { contextGraphs } } });
}

/** A host identity for an agent that is not started: enough for local create and query, with no peer running. */
function hostIdentity(created: DKGAgent, peerId: string): void {
  vi.spyOn(created, 'peerId', 'get').mockReturnValue(peerId);
  created.gossip = {
    subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), publish: vi.fn(async () => undefined),
  } as unknown as DKGAgent['gossip'];
  const runtime = created as unknown as { rfc64PublicCatalogServiceV1: unknown };
  vi.spyOn(runtime, 'rfc64PublicCatalogServiceV1', 'get').mockReturnValue({ acceptedPolicySnapshot: () => null });
}

describe('merged view queries on a private context graph, over built read graphs', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) {
      await agent.stop();
      await agent.store.close();
    }
    agent = undefined;
  });

  /**
   * A node that holds one private context graph, whose only participant is OWNER, with its read
   * graphs in `mode`. Its verifiable memory holds a product's type and price in two assets; its
   * shared memory holds them in one graph.
   */
  async function privateGraph(mode: ReadGraphMode) {
    const store = layered({ [PRIVATE_CG]: mode });
    const chain = new MockChainAdapter();
    const created = await DKGAgent.create({ name: 'ReadGraphQualificationPrivate', chainAdapter: chain, store });
    agent = created;
    hostIdentity(created, PEER_ID);

    // Created here, then registered on the mock chain: private, with OWNER its only participant.
    await created.createContextGraph({ id: PRIVATE_CG, name: 'Private graph', accessPolicy: 1, callerAgentAddress: OWNER });
    await chain.createOnChainContextGraph({
      accessPolicy: 1, publishPolicy: 1, participantAgents: [OWNER], nameHash: created.contextGraphNameCommitment(PRIVATE_CG),
    });

    await created.store.insert([
      { subject: PRODUCT, predicate: DKG_ONTOLOGY.RDF_TYPE, object: PRODUCT_CLASS, graph: `${ROOT}/_verifiable_memory/${OWNER}/1` },
      { subject: PRODUCT, predicate: PRICE, object: '"5"', graph: `${ROOT}/_verifiable_memory/${OWNER}/2` },
      { subject: PRODUCT, predicate: DKG_ONTOLOGY.RDF_TYPE, object: PRODUCT_CLASS, graph: `${ROOT}/_shared_memory` },
      { subject: PRODUCT, predicate: PRICE, object: '"7"', graph: `${ROOT}/_shared_memory` },
    ]);
    for (const key of [VM, SWM]) {
      expect(await buildReadGraph({ store: created.store }, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
      expect(await checkReadGraph(created.store, readGraphIri(key), 'full')).toMatchObject({ outcome: 'consistent' });
    }
    return { agent: created, store, engine: created.queryEngine };
  }

  const ask = (node: DKGAgent, contextGraphId: string, view: (typeof VIEWS)[number], semantics: (typeof SEMANTICS)[number], callerAgentAddress: string) =>
    node.query(JOIN, { contextGraphId, view, semantics, callerAgentAddress });

  it('answers a member from the built read graphs: the join across assets merged, and nothing per asset', async () => {
    const { agent: node } = await privateGraph('serve');
    expect(await ask(node, PRIVATE_CG, 'verifiable-memory', 'merged', OWNER)).toEqual({ bindings: [{ price: '"5"' }], semantics: 'merged' });
    expect(await ask(node, PRIVATE_CG, 'verifiable-memory', 'per-asset', OWNER)).toEqual({ bindings: [] });
    expect(await ask(node, PRIVATE_CG, 'shared-working-memory', 'merged', OWNER)).toEqual({ bindings: [{ price: '"7"' }], semantics: 'merged' });
  });

  describe.each([
    ['served and ready', 'serve', false, { answer: { bindings: [{ price: '"5"' }], semantics: 'merged' } }],
    ['served but not ready', 'serve', true, { error: { code: 'VIEW_NOT_READY' } }],
    ['built but not served', 'build', false, { error: { code: 'SEMANTICS_UNSUPPORTED' } }],
  ] as const)('with read graphs %s', (_label, mode, dirty, memberGets) => {
    it('answers a non-member exactly as for a context graph that does not exist, for every view and semantics', async () => {
      const { agent: node, store, engine } = await privateGraph(mode);
      if (dirty) for (const key of [VM, SWM]) await markReadGraphDirty({ store: node.store }, readGraphIri(key));
      const execution = vi.spyOn(engine, 'query');
      const states = vi.spyOn(store.runtime.mirror, 'get');
      // What a member gets here is what a non-member must not learn. The member's request reaches the
      // engine, and on a served context graph the read graph's state, so the spies see both.
      expect(await outcome(ask(node, PRIVATE_CG, 'verifiable-memory', 'merged', OWNER))).toMatchObject(memberGets);
      expect(execution).toHaveBeenCalled();
      if (mode === 'serve') expect(states).toHaveBeenCalled();
      execution.mockClear();
      states.mockClear();

      for (const view of VIEWS) {
        for (const semantics of SEMANTICS) {
          const denied = await outcome(ask(node, PRIVATE_CG, view, semantics, OUTSIDER));
          expect(denied, `${view}, semantics ${semantics}`).toEqual({ answer: { bindings: [] } });
          // Authority decides before the query runs or any read-graph state is read.
          expect(execution).not.toHaveBeenCalled();
          expect(states).not.toHaveBeenCalled();
          expect(await outcome(ask(node, MISSING_CG, view, semantics, OUTSIDER)), `${view}, semantics ${semantics}`).toEqual(denied);
          execution.mockClear();
          states.mockClear();
        }
      }
    });
  });
});

describe('merged working-memory queries through the agent, over built read graphs', () => {
  const NOTES = 'qualification-notes';
  const ROOT_NOTES = `did:dkg:context-graph:${NOTES}`;
  const DEFAULT_AGENT = '0x00000000000000000000000000000000000000aa';
  const OTHER_AGENT = '0x00000000000000000000000000000000000000bb';
  const NODE_PEER = 'peer-qualification-notes';
  const TEXT = 'urn:qualification:text';
  const NOTES_QUERY = `SELECT ?note ?text WHERE { ?note <${TEXT}> ?text }`;
  const TWICE = `SELECT (COUNT(*) AS ?n) WHERE { <urn:qualification:twice> <${TEXT}> ?text }`;
  const workingMemory = (agentAddress: string): ReadGraphKey => ({ scope: readScope(NOTES), layer: MemoryLayer.WorkingMemory, agentAddress });
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (agent) {
      await agent.stop();
      await agent.store.close();
    }
    agent = undefined;
  });

  /**
   * A node whose default agent owns the drafts written under the node's peer ID, as the agent's
   * start installs it. The default agent holds a product's type and price in two drafts of the two
   * layouts drafts are written in, and a note; the peer ID holds a note; both hold one triple; the
   * other agent holds its own note.
   */
  async function notes() {
    const store = layered({ [NOTES]: 'serve' });
    const created = await DKGAgent.create({ name: 'ReadGraphQualificationWorkingMemory', chainAdapter: new MockChainAdapter(), store });
    agent = created;
    hostIdentity(created, NODE_PEER);
    (created as unknown as { defaultAgentAddress?: string }).defaultAgentAddress = DEFAULT_AGENT;
    await installReadGraphWorkingMemoryIdentity(created.store, { defaultAgentAddress: DEFAULT_AGENT, peerId: NODE_PEER });
    await created.createContextGraph({ id: NOTES, name: 'Notes' });

    const note = (subject: string, text: string, graph: string) => ({ subject, predicate: TEXT, object: `"${text}"`, graph });
    await created.store.insert([
      { subject: PRODUCT, predicate: DKG_ONTOLOGY.RDF_TYPE, object: PRODUCT_CLASS, graph: `${ROOT_NOTES}/_working_memory/${DEFAULT_AGENT}/1` },
      { subject: PRODUCT, predicate: PRICE, object: '"5"', graph: contextGraphAssertionUri(NOTES, DEFAULT_AGENT, 'prices') },
      note('urn:qualification:note-default', 'from the default agent', contextGraphAssertionUri(NOTES, DEFAULT_AGENT, 'notes')),
      note('urn:qualification:note-peer', 'from the peer ID', contextGraphAssertionUri(NOTES, NODE_PEER, 'notes')),
      note('urn:qualification:twice', 'held twice', contextGraphAssertionUri(NOTES, DEFAULT_AGENT, 'notes')),
      note('urn:qualification:twice', 'held twice', contextGraphAssertionUri(NOTES, NODE_PEER, 'notes')),
      note('urn:qualification:note-other', 'from the other agent', contextGraphAssertionUri(NOTES, OTHER_AGENT, 'notes')),
    ]);
    for (const key of [workingMemory(DEFAULT_AGENT), workingMemory(OTHER_AGENT)]) {
      expect(await buildReadGraph({ store: created.store }, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
      expect(await checkReadGraph(created.store, readGraphIri(key), 'full')).toMatchObject({ outcome: 'consistent' });
    }
    return { agent: created, engine: created.queryEngine };
  }

  const drafts = (node: DKGAgent, sparql: string, options: { agentAddress?: string; callerAgentAddress?: string; semantics?: 'merged' | 'per-asset' }) =>
    node.query(sparql, { contextGraphId: NOTES, view: 'working-memory', ...options });
  const sorted = (answer: { bindings: Array<Record<string, string>> }) => [...answer.bindings].sort((a, b) => (a.note ?? '').localeCompare(b.note ?? ''));

  it('joins one agent\'s drafts merged, and not per asset; another agent\'s read graph has none of them', async () => {
    const { agent: node } = await notes();
    expect(await drafts(node, JOIN, { agentAddress: DEFAULT_AGENT, semantics: 'merged' })).toEqual({ bindings: [{ price: '"5"' }], semantics: 'merged' });
    expect(await drafts(node, JOIN, { agentAddress: DEFAULT_AGENT, semantics: 'per-asset' })).toEqual({ bindings: [] });
    expect(await drafts(node, JOIN, { agentAddress: OTHER_AGENT, semantics: 'merged' })).toEqual({ bindings: [], semantics: 'merged' });
  });

  it('reads the peer ID\'s drafts with the default agent\'s, under any spelling of either, and a triple both hold once', async () => {
    const { agent: node } = await notes();
    const expected = [
      { note: 'urn:qualification:note-default', text: '"from the default agent"' },
      { note: 'urn:qualification:note-peer', text: '"from the peer ID"' },
      { note: 'urn:qualification:twice', text: '"held twice"' },
    ];
    for (const agentAddress of [DEFAULT_AGENT, NODE_PEER, `0x${DEFAULT_AGENT.slice(2).toUpperCase()}`]) {
      const answer = await drafts(node, NOTES_QUERY, { agentAddress, semantics: 'merged' }) as { bindings: Array<Record<string, string>>; semantics?: string };
      expect(sorted(answer), agentAddress).toEqual(expected);
      expect(answer.semantics).toBe('merged');
      expect(await drafts(node, TWICE, { agentAddress, semantics: 'merged' }), agentAddress).toEqual({
        bindings: [{ n: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' }], semantics: 'merged',
      });
    }
    const other = await drafts(node, NOTES_QUERY, { agentAddress: OTHER_AGENT, semantics: 'merged' }) as { bindings: Array<Record<string, string>> };
    expect(sorted(other)).toEqual([{ note: 'urn:qualification:note-other', text: '"from the other agent"' }]);
  });

  it('moves the peer ID\'s drafts to a new default agent: neither read graph answers until rebuilt, then each has its owner\'s drafts', async () => {
    const { agent: node } = await notes();
    // The node adopts the other agent as its default, and installs the rule that gives it the peer ID's drafts.
    (node as unknown as { defaultAgentAddress?: string }).defaultAgentAddress = OTHER_AGENT;
    await installReadGraphWorkingMemoryIdentity(node.store, { defaultAgentAddress: OTHER_AGENT, peerId: NODE_PEER });
    for (const agentAddress of [DEFAULT_AGENT, NODE_PEER, OTHER_AGENT]) {
      await expect(drafts(node, NOTES_QUERY, { agentAddress, semantics: 'merged' }), agentAddress).rejects.toMatchObject({ code: 'VIEW_NOT_READY' });
    }
    for (const key of [workingMemory(DEFAULT_AGENT), workingMemory(OTHER_AGENT)]) {
      expect(await buildReadGraph({ store: node.store }, key)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
      expect(await checkReadGraph(node.store, readGraphIri(key), 'full')).toMatchObject({ outcome: 'consistent' });
    }
    const newOwner = [
      { note: 'urn:qualification:note-other', text: '"from the other agent"' },
      { note: 'urn:qualification:note-peer', text: '"from the peer ID"' },
      { note: 'urn:qualification:twice', text: '"held twice"' },
    ];
    for (const agentAddress of [NODE_PEER, OTHER_AGENT]) {
      const answer = await drafts(node, NOTES_QUERY, { agentAddress, semantics: 'merged' }) as { bindings: Array<Record<string, string>> };
      expect(sorted(answer), agentAddress).toEqual(newOwner);
    }
    const formerOwner = await drafts(node, NOTES_QUERY, { agentAddress: DEFAULT_AGENT, semantics: 'merged' }) as { bindings: Array<Record<string, string>> };
    expect(sorted(formerOwner)).toEqual([
      { note: 'urn:qualification:note-default', text: '"from the default agent"' },
      { note: 'urn:qualification:twice', text: '"held twice"' },
    ]);
  });

  it('gives a caller its own drafts, and another agent\'s drafts never, before the engine runs', async () => {
    const { agent: node, engine } = await notes();
    // A caller's own drafts, by default.
    const own = await drafts(node, NOTES_QUERY, { callerAgentAddress: OTHER_AGENT, semantics: 'merged' }) as { bindings: Array<Record<string, string>> };
    expect(sorted(own)).toEqual([{ note: 'urn:qualification:note-other', text: '"from the other agent"' }]);
    const execution = vi.spyOn(engine, 'query');
    for (const agentAddress of [DEFAULT_AGENT, NODE_PEER]) {
      for (const semantics of ['merged', 'per-asset'] as const) {
        expect(await drafts(node, NOTES_QUERY, { callerAgentAddress: OTHER_AGENT, agentAddress, semantics }), `${agentAddress} ${semantics}`)
          .toEqual({ bindings: [] });
      }
    }
    expect(execution).not.toHaveBeenCalled();
  });
});
