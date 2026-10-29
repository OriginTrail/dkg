/**
 * E2E: subscribing to a public Context Graph by its on-chain name hash, against
 * the real ContextGraphStorage contract on Hardhat and real libp2p between the
 * agents.
 *
 * The other name-hash suites (context-graph-name-hash-subscription.integration,
 * context-graph-ontology-claim-binding, discovery-subscription-boundary) run on
 * MockChainAdapter and stage the hash-keyed row by hand. Nothing else proved
 * that an edge which learns a graph only from the real chain can subscribe by
 * `keccak256(utf8(id))`, find the cleartext id and sync. This file does, and it
 * checks the trust rules at the same seam:
 *
 *  1. discovery: the edge's only knowledge of the graph is what the real
 *     ContextGraphStorage enumeration (`getContextGraph` + `getNameHash`) and the
 *     live `ContextGraphCreated` tail report: a hash-keyed row, no cleartext.
 *  2. adoption: a peer reveals the cleartext id, the edge verifies
 *     `keccak256(utf8(id)) === nameHash`, moves the subscription to the
 *     cleartext id and backfills the shared working memory published before it
 *     subscribed.
 *  3. keccak gate: a peer that answers the name protocol with an id that hashes
 *     to something else, and a peer whose ontology graph defines a forged id, are
 *     both ignored; the honest peer is still found afterwards.
 *  4. no fabrication: a graph whose cleartext no peer knows stays hash-only.
 *  5. chain-proven claims: an ontology `dkg:ContextGraphOnChainId` claim binds
 *     only when this chain's slot commits the claimed id's name hash.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
} from '@origintrail-official/dkg-core';
import {
  RealChainAgents,
  connectWithIdentify as connect,
  pollUntil,
} from './_helpers/real-chain-agent.js';
import { subscribeByNameHash } from './_helpers/subscribe-by-name-hash.js';
import type { DKGAgent } from '../src/index.js';
import {
  PROTOCOL_CONTEXT_GRAPH_NAME,
  encodeContextGraphNameResponse,
} from '../src/context-graph-name-protocol.js';
import {
  HARDHAT_KEYS,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const NAME = 'http://schema.org/name';
const keccak = (id: string): string => ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
let assertionCounter = 0;

/** Same on every node: a run of this file never collides with another run's graphs. */
const RUN = Date.now().toString(36);

// Real agents on the real chain come from the shared fixture (indexed adapter,
// startup, connect with identify, polling); this file keeps the scenario. Agents
// are stopped after every test, newest first.
const pool = new RealChainAgents();
afterEach(async () => {
  vi.restoreAllMocks();
  await pool.stopAll();
});
const startNode = (name: string, operationalKey: string) => pool.startNode(name, operationalKey);
type Node = Awaited<ReturnType<typeof startNode>>;

/** Create the graph locally and register it, public and open, on the real chain. */
async function createRegisteredPublicGraph(holder: Node, label: string): Promise<{ id: string; onChainId: string; nameHash: string }> {
  const id = `${holder.address}/${label}-${RUN}`;
  await holder.agent.createContextGraph({
    id,
    name: `Name-hash E2E ${label}`,
    description: '',
    accessPolicy: 0,
    callerAgentAddress: holder.address,
  });
  const registered = await holder.agent.registerContextGraph(id, {
    accessPolicy: 0,
    publishPolicy: 1,
    callerAgentAddress: holder.address,
  });
  const onChainId = String(registered.onChainId);
  expect(Number(onChainId)).toBeGreaterThan(0);
  return { id, onChainId, nameHash: keccak(id) };
}

/** Stage an assertion and promote it into the graph's shared working memory. */
async function shareToSwm(holder: DKGAgent, contextGraphId: string, subject: string, label: string): Promise<void> {
  const assertionName = `name-hash-${RUN}-${++assertionCounter}`;
  await holder.assertion.create(contextGraphId, assertionName);
  await holder.assertion.write(contextGraphId, assertionName, [{ subject, predicate: NAME, object: `"${label}"` }]);
  const promoted = await holder.assertion.promote(contextGraphId, assertionName);
  expect(promoted.promotedCount).toBeGreaterThan(0);
}

/**
 * Names of `subject` as the agent's query API returns them. For polling until
 * synced content arrives only: a rejected query counts as "not there yet", so an
 * empty result here does not show that nothing is stored. Assert absence with
 * {@link storedGraphsAbout}.
 */
async function swmNames(agent: DKGAgent, contextGraphId: string, subject: string): Promise<string[]> {
  const result = await agent.query(
    `SELECT ?name WHERE { <${subject}> <${NAME}> ?name }`,
    { contextGraphId, includeSharedMemory: true },
  ).catch(() => ({ bindings: [] as Array<Record<string, unknown>> }));
  return result.bindings.map((row) => String(row['name']));
}

/**
 * Every graph of `contextGraphId` in the agent's own store that holds a triple
 * about `subject`. A direct store read with no view or authority check in
 * between, and it rejects when the read fails, so an empty result means the
 * store was read and holds nothing about the subject under that id.
 */
async function storedGraphsAbout(
  agent: Pick<DKGAgent, 'store'>,
  contextGraphId: string,
  subject: string,
): Promise<string[]> {
  const partition = contextGraphDataGraphUri(contextGraphId);
  const result = await agent.store.query(`SELECT DISTINCT ?g WHERE { GRAPH ?g { <${subject}> ?p ?o } }`);
  if (result.type !== 'bindings') throw new Error(`expected bindings from the store, got ${result.type}`);
  return result.bindings
    .map((row) => String(row['g']).replace(/^<(.*)>$/, '$1'))
    .filter((graph) => graph === partition || graph.startsWith(`${partition}/`));
}

function row(agent: DKGAgent, id: string) {
  return agent.getSubscribedContextGraphs().get(id);
}

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  // Registering a Context Graph pulls the registration deposit when one is set.
  const { hubAddress } = getSharedContext();
  const registrar = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, registrar.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

describe('E2E: subscribe by on-chain name hash on a real ContextGraphStorage', () => {
  it('an edge that knows the graph only from the chain finds its cleartext id through a peer, verifies it and backfills SWM', async () => {
    const holder = await startNode('HashSubHolder', HARDHAT_KEYS.CORE_OP);
    const edge = await startNode('HashSubEdge', HARDHAT_KEYS.EXTRA1);
    const graph = await createRegisteredPublicGraph(holder, 'chain-only');
    const subject = `urn:e2e:name-hash:${RUN}:backfill`;
    // Shared before the edge knows the graph exists: the edge must backfill it.
    await shareToSwm(holder.agent, graph.id, subject, 'published before the edge subscribed');

    // The real contract commits exactly the preimage's keccak, and the real
    // registry lookup (the ambiguity fence included) maps it back to the slot.
    await expect(edge.chain.getContextGraphNameHash(BigInt(graph.onChainId))).resolves.toBe(graph.nameHash);
    await expect(edge.chain.resolveContextGraphIdByNameHash(graph.nameHash)).resolves.toBe(BigInt(graph.onChainId));

    // Historical discovery: the edge reads the slot from ContextGraphStorage.
    expect(await edge.agent.discoverContextGraphsFromStorage()).toBeGreaterThan(0);
    const placeholder = edge.agent.contextGraphNamePlaceholder(graph.nameHash);
    expect(placeholder, 'hash-keyed row from chain discovery').not.toBeNull();
    expect(placeholder!.subscription).toMatchObject({ onChainId: graph.onChainId, onChainHash: graph.nameHash });
    // ...and knows nothing else about it.
    expect(row(edge.agent, graph.id)).toBeUndefined();
    expect(edge.agent.resolveContextGraphIdAlias(graph.nameHash)).toBeNull();
    expect(await storedGraphsAbout(edge.agent, graph.id, subject)).toEqual([]);

    // `dkg subscribe <hash>` with no peer connected: subscribed under the hash,
    // reported as name-hash-only, nothing invented.
    const first = await subscribeByNameHash(edge.agent, graph.nameHash);
    expect(first.contextGraphId).toBe(graph.nameHash);
    expect(edge.agent.describeContextGraphIdentity(graph.nameHash)).toMatchObject({
      state: 'name-hash-only',
      nameHash: graph.nameHash,
      onChainId: graph.onChainId,
    });

    // A peer that holds the graph connects: the background resolver asks it,
    // verifies the answer against the chain's hash and adopts the cleartext id.
    await connect(edge.agent, holder.agent);
    const adopted = await pollUntil(
      () => edge.agent.resolveContextGraphIdAlias(graph.nameHash),
      (alias) => alias === graph.id,
      60_000,
      250,
    );
    expect(adopted).toBe(graph.id);
    expect(keccak(adopted!)).toBe(graph.nameHash);
    expect(row(edge.agent, graph.nameHash)).toBeUndefined();
    expect(row(edge.agent, graph.id)).toMatchObject({
      subscribed: true,
      syncMode: 'always-on',
      onChainId: graph.onChainId,
      onChainHash: graph.nameHash,
    });
    expect(edge.agent.describeContextGraphIdentity(graph.nameHash)).toMatchObject({
      state: 'resolved',
      nameHash: graph.nameHash,
      contextGraphId: graph.id,
    });
    expect(edge.agent.getContextGraphNameResolutionStatus()).toContainEqual(expect.objectContaining({
      state: 'resolved',
      nameHash: graph.nameHash,
      contextGraphId: graph.id,
      source: 'peer-protocol',
    }));

    // The sync the hash could never reach now runs under the cleartext id.
    const names = await pollUntil(
      () => swmNames(edge.agent, graph.id, subject),
      (values) => values.length > 0,
      90_000,
      500,
    );
    expect(names.some((value) => value.includes('published before the edge subscribed'))).toBe(true);
    // The same direct read that found nothing before the subscription now finds
    // the synced content under the cleartext id, and still nothing under the hash.
    expect(await storedGraphsAbout(edge.agent, graph.id, subject)).not.toEqual([]);
    expect(await storedGraphsAbout(edge.agent, graph.nameHash, subject)).toEqual([]);
  }, 300_000);

  it('ignores a wrong name-protocol answer and a forged ontology definition, then adopts what the honest peer proves', async () => {
    const holder = await startNode('HashSubHonest', HARDHAT_KEYS.CORE_OP);
    const liar = await startNode('HashSubLiar', HARDHAT_KEYS.EXTRA2);
    const forger = await startNode('HashSubForger', HARDHAT_KEYS.EXTRA3);
    const edge = await startNode('HashSubEdgeLiars', HARDHAT_KEYS.EXTRA1);
    const graph = await createRegisteredPublicGraph(holder, 'liars');
    const subject = `urn:e2e:name-hash:${RUN}:liars`;
    await shareToSwm(holder.agent, graph.id, subject, 'shared by the honest holder');

    // A syntactically valid id whose commitment is not the on-chain name hash.
    const WRONG_ANSWER = `attacker/wrong-answer-${RUN}`;
    const FORGED_CLAIM = `attacker/forged-claim-${RUN}`;
    expect(keccak(WRONG_ANSWER)).not.toBe(graph.nameHash);
    expect(keccak(FORGED_CLAIM)).not.toBe(graph.nameHash);

    // Liar one speaks the name protocol and answers every request with a wrong id.
    let wrongAnswers = 0;
    liar.agent.router.unregister(PROTOCOL_CONTEXT_GRAPH_NAME);
    liar.agent.router.register(
      PROTOCOL_CONTEXT_GRAPH_NAME,
      async () => {
        wrongAnswers += 1;
        return encodeContextGraphNameResponse({ version: 1, status: 'found', contextGraphId: WRONG_ANSWER });
      },
      { maxReadBytes: 256 },
    );
    // Liar two predates the protocol and its ontology graph claims the real
    // slot for an id that is not the graph's name.
    forger.agent.router.unregister(PROTOCOL_CONTEXT_GRAPH_NAME);
    const ontology = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    await forger.agent.store.insert([
      { subject: contextGraphDataGraphUri(FORGED_CLAIM), predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontology },
      { subject: contextGraphDataGraphUri(FORGED_CLAIM), predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: `"${graph.onChainId}"`, graph: ontology },
    ]);

    await edge.agent.discoverContextGraphsFromStorage();
    expect(edge.agent.contextGraphNamePlaceholder(graph.nameHash)).not.toBeNull();
    await subscribeByNameHash(edge.agent, graph.nameHash);
    const asked = vi.spyOn(edge.agent, 'askPeerForContextGraphName');
    const pulled = vi.spyOn(edge.agent, 'pullPeerOntologyForContextGraphNames');
    // The raw sync fetch sits below the function that filters the pulled
    // ontology, so what it returns is what actually crossed the network.
    const fetched = vi.spyOn(edge.agent, 'fetchSyncPages');

    await connect(edge.agent, liar.agent);
    await connect(edge.agent, forger.agent);
    const resolvedByLiars = await edge.agent.resolveContextGraphNameHashNow(graph.nameHash, {
      signal: AbortSignal.timeout(30_000),
    });

    // Both lies actually reached the edge, and neither was adopted.
    expect(wrongAnswers, 'the lying peer was asked').toBeGreaterThan(0);
    await expect(Promise.all(asked.mock.results.map((result) => result.value)))
      .resolves.toContain(WRONG_ANSWER);
    expect(pulled, 'the forging peer\'s ontology was pulled').toHaveBeenCalled();
    // ...and the forged claim really arrived: a fetch of the forger's ontology
    // graph over the sync protocol returned the forged definition's own rows.
    // Without this, an empty page from a broken transport or fixture would pass
    // every assertion below as "rejected".
    const forgerOntologyFetches = fetched.mock.calls
      .map((call, index) => ({ call, result: fetched.mock.results[index]!.value as Promise<{ quads: Array<{ subject: string; predicate: string; object: string }> }> }))
      .filter(({ call }) => String(call[1]) === String(forger.agent.peerId) && call[2] === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    expect(forgerOntologyFetches.length, 'the forger\'s ontology graph was fetched over the sync protocol').toBeGreaterThan(0);
    const received = (await Promise.all(forgerOntologyFetches.map(({ result }) => result))).flatMap((page) => page.quads);
    const forgedRows = received.filter((quad) => quad.subject === contextGraphDataGraphUri(FORGED_CLAIM));
    expect(
      forgedRows.some((quad) => quad.predicate === CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE && quad.object.includes(graph.onChainId)),
      `the forged claim for slot ${graph.onChainId} reached the edge (received ${received.length} ontology rows, ${forgedRows.length} of them the forged definition)`,
    ).toBe(true);
    expect(resolvedByLiars).toBeNull();
    expect(edge.agent.resolveContextGraphIdAlias(graph.nameHash)).toBeNull();
    expect(edge.agent.describeContextGraphIdentity(graph.nameHash)).toMatchObject({ state: 'name-hash-only' });
    expect(row(edge.agent, graph.nameHash)).toMatchObject({ subscribed: true, onChainId: graph.onChainId });
    for (const forged of [WRONG_ANSWER, FORGED_CLAIM, graph.id]) {
      expect(row(edge.agent, forged), `no row for ${forged}`).toBeUndefined();
    }

    // The honest holder joins: its answer verifies, so this one is adopted and syncs.
    await connect(edge.agent, holder.agent);
    const resolved = await edge.agent.resolveContextGraphNameHashNow(graph.nameHash, {
      signal: AbortSignal.timeout(30_000),
    });
    expect(resolved).toBe(graph.id);
    expect(row(edge.agent, graph.nameHash)).toBeUndefined();
    expect(row(edge.agent, graph.id)).toMatchObject({ subscribed: true, onChainId: graph.onChainId, onChainHash: graph.nameHash });
    for (const forged of [WRONG_ANSWER, FORGED_CLAIM]) {
      expect(row(edge.agent, forged), `still no row for ${forged}`).toBeUndefined();
    }
    const names = await pollUntil(
      () => swmNames(edge.agent, graph.id, subject),
      (values) => values.length > 0,
      90_000,
      500,
    );
    expect(names.some((value) => value.includes('shared by the honest holder'))).toBe(true);
  }, 300_000);

  it('keeps a registered graph whose cleartext no peer knows hash-only, and invents nothing', async () => {
    // The edge is running before the graph exists: the live ContextGraphCreated
    // tail is the only way it can learn the slot.
    const edge = await startNode('HashSubUnknownEdge', HARDHAT_KEYS.EXTRA1);
    const holder = await startNode('HashSubUnknownHolder', HARDHAT_KEYS.CORE_OP);
    // Registered on the real chain with a name commitment whose preimage nobody holds.
    const nameHash = keccak(`nobody-holds-this-name/${RUN}`);
    const created = await holder.chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash,
    });
    expect(created.success).toBe(true);
    const onChainId = created.contextGraphId.toString(10);
    // A graph the holder does know, so its silence about the other one is not an accident.
    const known = await createRegisteredPublicGraph(holder, 'known-neighbour');
    await connect(edge.agent, holder.agent);

    // The poller's next tick reads the real event: slot, policy and name hash.
    const placeholder = await pollUntil(
      () => edge.agent.contextGraphNamePlaceholder(nameHash),
      (found) => found !== null,
      60_000,
      500,
    );
    expect(placeholder?.subscription).toMatchObject({ onChainId, onChainHash: nameHash });

    const first = await subscribeByNameHash(edge.agent, nameHash);
    expect(first.contextGraphId).toBe(nameHash);
    // The connected, protocol-speaking holder is asked and has nothing to reveal.
    await expect(edge.agent.askPeerForContextGraphName(
      holder.agent.peerId,
      { nameHash, onChainId },
      AbortSignal.timeout(15_000),
    )).resolves.toBeNull();
    const resolved = await edge.agent.resolveContextGraphNameHashNow(nameHash, { signal: AbortSignal.timeout(15_000) });

    expect(resolved).toBeNull();
    expect(edge.agent.resolveContextGraphIdAlias(nameHash)).toBeNull();
    expect(edge.agent.describeContextGraphIdentity(nameHash)).toMatchObject({
      state: 'name-hash-only',
      nameHash,
      onChainId,
    });
    expect(edge.agent.getContextGraphNameResolutionStatus()).toContainEqual(
      expect.objectContaining({ state: 'pending', nameHash, onChainId }),
    );
    expect(row(edge.agent, nameHash)).toMatchObject({ subscribed: true, onChainId, onChainHash: nameHash });
    // The neighbour the holder does hold is not mistaken for it.
    expect(row(edge.agent, known.id)).toBeUndefined();
  }, 300_000);

  it('binds an ontology claim only when the real slot commits the claimed id, whatever the ontology says', async () => {
    const holder = await startNode('HashSubClaimsHolder', HARDHAT_KEYS.CORE_OP);
    const edge = await startNode('HashSubClaimsEdge', HARDHAT_KEYS.EXTRA1);
    const graph = await createRegisteredPublicGraph(holder, 'claims');
    const STOLEN_SLOT = `attacker/claims-the-slot-${RUN}`;
    const MISSING_SLOT = `attacker/claims-a-missing-slot-${RUN}`;
    expect(keccak(STOLEN_SLOT)).not.toBe(graph.nameHash);

    // The edge enumerated the slot first: it holds only the name hash.
    await edge.agent.discoverContextGraphsFromStorage();
    expect(row(edge.agent, graph.nameHash)).toMatchObject({ onChainId: graph.onChainId, onChainHash: graph.nameHash });

    // A synced ontology graph: the real definition, and two claims the chain refutes.
    const ontology = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const claim = (id: string, onChainId: string) => {
      const subject = contextGraphDataGraphUri(id);
      return [
        { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: ontology },
        { subject, predicate: CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE, object: `"${onChainId}"`, graph: ontology },
      ];
    };
    await edge.agent.store.insert([
      ...claim(graph.id, graph.onChainId),
      ...claim(STOLEN_SLOT, graph.onChainId),
      ...claim(MISSING_SLOT, '99999999'),
    ]);
    await edge.agent.discoverContextGraphsFromStore();

    // The proven claim adopted the hash-only row; the refuted ones bound nothing.
    expect(row(edge.agent, graph.nameHash)).toBeUndefined();
    expect(row(edge.agent, graph.id)).toMatchObject({ onChainId: graph.onChainId, onChainHash: graph.nameHash });
    for (const refuted of [STOLEN_SLOT, MISSING_SLOT]) {
      expect(row(edge.agent, refuted)?.onChainId, refuted).toBeUndefined();
      await expect(edge.agent.getContextGraphOnChainId(refuted), refuted).resolves.toBeNull();
    }
    await expect(edge.agent.getContextGraphOnChainId(graph.id)).resolves.toBe(graph.onChainId);

    const rows = await edge.agent.listContextGraphs({ callerAgentAddress: null });
    expect(rows.filter((listed) => listed.onChainId === graph.onChainId)).toEqual([
      expect.objectContaining({ id: graph.id, nameKnown: true }),
    ]);
    for (const refuted of [STOLEN_SLOT, MISSING_SLOT]) {
      expect(rows.find((listed) => listed.id === refuted)?.onChainId, refuted).toBeUndefined();
    }
  }, 300_000);
});

describe('the direct store read behind the absence assertions', () => {
  it('rejects when the store cannot be read, so a failed read never counts as nothing stored', async () => {
    const unreadable = {
      store: { query: async () => { throw new Error('store unavailable'); } },
    } as unknown as Pick<DKGAgent, 'store'>;
    await expect(storedGraphsAbout(unreadable, 'any-graph', 'urn:test:subject')).rejects.toThrow('store unavailable');
  });

  it('rejects an answer that is not a bindings result', async () => {
    const wrongShape = {
      store: { query: async () => ({ type: 'boolean', value: false }) },
    } as unknown as Pick<DKGAgent, 'store'>;
    await expect(storedGraphsAbout(wrongShape, 'any-graph', 'urn:test:subject'))
      .rejects.toThrow('expected bindings from the store, got boolean');
  });
});
