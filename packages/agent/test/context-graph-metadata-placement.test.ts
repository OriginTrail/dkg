// SPDX-License-Identifier: Apache-2.0

/**
 * Where Context Graph metadata is stored.
 *
 * `ontology` catalogues public graphs; a curated or `private: true` graph's
 * metadata lives in its own `_meta` graph. Curated definitions already did.
 * These tests pin the same placement for the on-chain id binding written at
 * registration, for `private: true` definitions and for renames, plus the
 * relocation of rows earlier builds left in ontology.
 */

import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  contextGraphOnChainIdBindingQuery,
  contextGraphPublishTopic,
  decodePublishRequest,
  encodePublishRequest,
} from '@origintrail-official/dkg-core';
import { deleteByPatternWithoutCount, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { relocatePrivateContextGraphMetadata } from '../src/context-graph-metadata-relocation.js';
import { replaceContextGraphMetadataFact } from '../src/context-graph-metadata-fact.js';
import {
  ONTOLOGY_BINDING_SLOT_RECHECK_MS,
  ONTOLOGY_BINDING_SLOTS_MAX,
  OntologyBindingSlotClassifier,
} from '../src/ontology-binding-slot-classifier.js';

const ONTOLOGY_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
const ON_CHAIN_ID = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
const ONTOLOGY_TOPIC = contextGraphPublishTopic(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

type TestAgent = DKGAgent & { store: TripleStore };

class RecordingGossip {
  readonly published: Array<{ topic: string; data: Uint8Array }> = [];
  subscribe = vi.fn();
  unsubscribe = vi.fn();
  onMessage = vi.fn();
  getSubscribers = vi.fn(() => [] as string[]);
  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.published.push({ topic, data });
  }
}

async function createAgent(name: string, options: { nodeRole?: 'core' | 'edge' } = {}): Promise<{
  agent: TestAgent;
  chain: MockChainAdapter;
  gossip: RecordingGossip;
  ownerAddress: string;
}> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name: `metadata-placement-${name}`,
    chainAdapter: chain,
    ...(options.nodeRole ? { nodeRole: options.nodeRole } : {}),
  }) as TestAgent;
  (agent as unknown as { node: unknown }).node = {
    peerId: `12D3KooWMetadataPlacement${name}`,
    multiaddrs: [],
    libp2p: { getPeers: () => [] },
  };
  const gossip = new RecordingGossip();
  (agent as unknown as { gossip: RecordingGossip }).gossip = gossip;
  return { agent, chain, gossip, ownerAddress: chain.signerAddress };
}

async function ontologyRowsAbout(agent: TestAgent, contextGraphId: string): Promise<string[]> {
  const result = await agent.store.query(`
    SELECT ?p ?o WHERE {
      GRAPH <${ONTOLOGY_GRAPH}> { <did:dkg:context-graph:${contextGraphId}> ?p ?o }
    }
  `);
  return result.type === 'bindings'
    ? result.bindings.map((row) => `${row['p']} ${row['o']}`)
    : [];
}

async function metaOnChainId(agent: TestAgent, contextGraphId: string): Promise<string | undefined> {
  const result = await agent.store.query(`
    SELECT ?id WHERE {
      GRAPH <${contextGraphMetaGraphUri(contextGraphId)}> {
        <did:dkg:context-graph:${contextGraphId}> <${ON_CHAIN_ID}> ?id
      }
    } LIMIT 1
  `);
  return result.type === 'bindings'
    ? result.bindings[0]?.['id']?.replace(/^"|"$/g, '')
    : undefined;
}

function ontologyBroadcastsMentioning(gossip: RecordingGossip, contextGraphId: string): string[] {
  return gossip.published
    .filter(({ topic }) => topic === ONTOLOGY_TOPIC)
    .map(({ data }) => {
      const request = decodePublishRequest(data);
      return `${request.ual}\n${new TextDecoder().decode(request.nquads)}`;
    })
    .filter((text) => text.includes(contextGraphId));
}

describe('curated and private graph metadata stays in the graph’s own _meta', () => {
  it('registers a curated graph with its on-chain id only in the graph’s own _meta', async () => {
    const id = 'curated-registration';
    const { agent, gossip, ownerAddress } = await createAgent('curated');
    await agent.createContextGraph({
      id,
      name: 'Research',
      accessPolicy: 1,
      allowedAgents: [ownerAddress],
      callerAgentAddress: ownerAddress,
    });

    const { onChainId } = await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });

    expect(await ontologyRowsAbout(agent, id)).toEqual([]);
    expect(await metaOnChainId(agent, id)).toBe(onChainId);
    expect(ontologyBroadcastsMentioning(gossip, id)).toEqual([]);
    expect(agent.subscribedContextGraphs.get(id)?.onChainId).toBe(onChainId);
    await expect(agent.getContextGraphOnChainId(id)).resolves.toBe(onChainId);
  });

  it('treats a private:true graph as curated at registration', async () => {
    const id = 'private-registration';
    const { agent, gossip, ownerAddress } = await createAgent('private');
    await agent.createContextGraph({
      id,
      name: 'Local notes',
      private: true,
      callerAgentAddress: ownerAddress,
    });

    const { onChainId } = await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });

    expect(await ontologyRowsAbout(agent, id)).toEqual([]);
    expect(await metaOnChainId(agent, id)).toBe(onChainId);
    expect(ontologyBroadcastsMentioning(gossip, id)).toEqual([]);
  });

  it('still publishes a public graph’s on-chain id in ontology and announces it', async () => {
    const id = 'public-registration-open';
    const { agent, gossip, ownerAddress } = await createAgent('public');
    await agent.createContextGraph({
      id,
      name: 'Open data',
      callerAgentAddress: ownerAddress,
    });

    const { onChainId } = await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });

    expect(await ontologyRowsAbout(agent, id)).toContain(`${ON_CHAIN_ID} "${onChainId}"`);
    expect(await metaOnChainId(agent, id)).toBe(onChainId);
    expect(ontologyBroadcastsMentioning(gossip, id).join('\n')).toContain(ON_CHAIN_ID);
  });

  it('keeps a private:true graph’s definition out of ontology', async () => {
    const id = 'private-definition';
    const { agent, ownerAddress } = await createAgent('private-definition');
    await agent.createContextGraph({
      id,
      name: 'Local notes',
      description: 'never leaves this node',
      private: true,
      callerAgentAddress: ownerAddress,
    });

    expect(await ontologyRowsAbout(agent, id)).toEqual([]);
    await expect(agent.contextGraphExists(id)).resolves.toBe(true);
    await expect(agent.isPrivateContextGraph(id)).resolves.toBe(true);
    const listed = (await agent.listContextGraphs({ callerAgentAddress: ownerAddress }))
      .find((row) => row.id === id);
    expect(listed?.name).toBe('Local notes');
  });

  it('renames a curated graph without writing its name into ontology', async () => {
    const id = 'curated-rename';
    const { agent, ownerAddress } = await createAgent('rename');
    await agent.createContextGraph({
      id,
      name: 'Before',
      accessPolicy: 1,
      allowedAgents: [ownerAddress],
      callerAgentAddress: ownerAddress,
    });

    await agent.renameContextGraph(id, 'After', ownerAddress);

    expect(await ontologyRowsAbout(agent, id)).toEqual([]);
    const listed = (await agent.listContextGraphs({ callerAgentAddress: ownerAddress }))
      .find((row) => row.id === id);
    expect(listed?.name).toBe('After');
  });

  it('renames a public graph in ontology as before', async () => {
    const id = 'public-rename-open';
    const { agent, ownerAddress } = await createAgent('public-rename');
    await agent.createContextGraph({ id, name: 'Before', callerAgentAddress: ownerAddress });

    await agent.renameContextGraph(id, 'After', ownerAddress);

    expect(await ontologyRowsAbout(agent, id)).toContain(`${DKG_ONTOLOGY.SCHEMA_NAME} "After"`);
  });
});

function ontologyQuad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: ONTOLOGY_GRAPH };
}

function bindingQuad(contextGraphId: string, onChainId: string, graph = ONTOLOGY_GRAPH): Quad {
  return {
    subject: contextGraphDataGraphUri(contextGraphId),
    predicate: ON_CHAIN_ID,
    object: `"${onChainId}"`,
    graph,
  };
}

async function createOnChain(chain: MockChainAdapter, accessPolicy: 0 | 1): Promise<string> {
  const created = await chain.createOnChainContextGraph({
    accessPolicy,
    publishPolicy: 1,
    participantAgents: [],
  });
  return created.contextGraphId.toString();
}

async function lookupBinding(store: TripleStore, contextGraphId: string): Promise<string | undefined> {
  const result = await store.query(contextGraphOnChainIdBindingQuery(contextGraphId));
  return result.type === 'bindings'
    ? result.bindings[0]?.['id']?.replace(/^"|"$/g, '')
    : undefined;
}

function registrationGossip(bindings: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const nquads = bindings
    .map(([contextGraphId, onChainId]) => (
      `<${contextGraphDataGraphUri(contextGraphId)}> <${ON_CHAIN_ID}> "${onChainId}" <${ONTOLOGY_GRAPH}> .`
    ))
    .join('\n');
  return encodePublishRequest({
    ual: `did:dkg:context-graph:${bindings[0]![0]}`,
    nquads: new TextEncoder().encode(nquads),
    contextGraphId: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
    kas: [],
    publisherIdentity: new Uint8Array(32),
    publisherAddress: '',
    startKAId: 0,
    endKAId: 0,
    chainId: '',
    publisherSignatureR: new Uint8Array(0),
    publisherSignatureVs: new Uint8Array(0),
  });
}

describe('each metadata writer follows the same placement', () => {
  it('replaces a fact in the graphs it writes and clears it from ontology', async () => {
    const id = '0xabc/replaced-fact';
    const store = (await createAgent('replace-fact')).agent.store;
    const metaGraph = contextGraphMetaGraphUri(id);
    await store.insert([bindingQuad(id, '1'), bindingQuad(id, '2', metaGraph)]);
    const extra: Quad = {
      subject: contextGraphDataGraphUri(id),
      predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`,
      object: '"0xhash"',
      graph: metaGraph,
    };

    await replaceContextGraphMetadataFact(store, id, {
      predicate: ON_CHAIN_ID,
      object: '"3"',
      graphs: [metaGraph],
      alsoInsert: [extra],
    });

    const rows = await store.query(`
      SELECT ?g ?p ?o WHERE { GRAPH ?g { <${contextGraphDataGraphUri(id)}> ?p ?o } }
    `);
    expect(rows.type === 'bindings' ? rows.bindings.map((row) => `${row['g']} ${row['p']} ${row['o']}`).sort() : [])
      .toEqual([
        `${metaGraph} ${ON_CHAIN_ID} "3"`,
        `${metaGraph} ${extra.predicate} "0xhash"`,
      ].sort());
  });

  it('reconciles a late registration into _meta only for a curated graph, and into both for a public one', async () => {
    const { agent, chain, ownerAddress } = await createAgent('reconcile-placement');
    const createOnChain = chain.createOnChainContextGraph.bind(chain);
    const ambiguous = new Error('receipt lookup failed after broadcast');
    (agent as unknown as { registerContextGraphOnChain: unknown }).registerContextGraphOnChain =
      vi.fn(async (params: Parameters<MockChainAdapter['createOnChainContextGraph']>[0]) => {
        await createOnChain(params);
        throw ambiguous;
      });
    await agent.createContextGraph({
      id: 'reconciled-curated',
      name: 'Late',
      accessPolicy: 1,
      allowedAgents: [ownerAddress],
      callerAgentAddress: ownerAddress,
    });
    await agent.createContextGraph({ id: 'reconciled-public', name: 'Late open', callerAgentAddress: ownerAddress });

    for (const id of ['reconciled-curated', 'reconciled-public']) {
      await expect(agent.registerContextGraph(id, { callerAgentAddress: ownerAddress })).rejects.toBe(ambiguous);
    }
    const curated = await agent.registerContextGraph('reconciled-curated', { callerAgentAddress: ownerAddress });
    const open = await agent.registerContextGraph('reconciled-public', { callerAgentAddress: ownerAddress });

    expect(await ontologyRowsAbout(agent, 'reconciled-curated')).toEqual([]);
    expect(await metaOnChainId(agent, 'reconciled-curated')).toBe(curated.onChainId);
    expect(await ontologyRowsAbout(agent, 'reconciled-public')).toContain(`${ON_CHAIN_ID} "${open.onChainId}"`);
    expect(await metaOnChainId(agent, 'reconciled-public')).toBe(open.onChainId);
  });

  it('chain discovery writes only the home graph: _meta for a curator’s curated graph, ontology for a public one', async () => {
    const { agent, chain } = await createAgent('chain-placement');
    const curator = '0x2222222222222222222222222222222222222222';
    (agent as unknown as { defaultAgentAddress: string }).defaultAgentAddress = curator;
    (chain as unknown as { listContextGraphsFromChain: unknown }).listContextGraphsFromChain = async () => ([
      { contextGraphId: '601', name: 'chain-curated', creator: curator, accessPolicy: 1, blockNumber: 1, metadataRevealed: true },
      { contextGraphId: '602', name: 'chain-public', creator: curator, accessPolicy: 0, blockNumber: 2, metadataRevealed: true },
    ]);

    await agent.discoverContextGraphsFromChain();

    expect(await ontologyRowsAbout(agent, 'chain-curated')).toEqual([]);
    expect(await metaOnChainId(agent, 'chain-curated')).toBe('601');
    expect(await ontologyRowsAbout(agent, 'chain-public')).toEqual([`${ON_CHAIN_ID} "602"`]);
    expect(await metaOnChainId(agent, 'chain-public')).toBeUndefined();
  });
});

describe('durable on-chain id binding lookup', () => {
  it('reads the ontology copy, falls back to _meta, and prefers ontology when both exist', async () => {
    const { agent } = await createAgent('binding-lookup');
    await agent.store.insert([
      bindingQuad('only-ontology', '11'),
      bindingQuad('only-meta', '12', contextGraphMetaGraphUri('only-meta')),
      bindingQuad('both', '13'),
      bindingQuad('both', '14', contextGraphMetaGraphUri('both')),
    ]);

    await expect(lookupBinding(agent.store, 'only-ontology')).resolves.toBe('11');
    await expect(lookupBinding(agent.store, 'only-meta')).resolves.toBe('12');
    await expect(lookupBinding(agent.store, 'both')).resolves.toBe('13');
    await expect(lookupBinding(agent.store, 'neither')).resolves.toBeUndefined();
  });

  it('resolves a curated graph’s id from _meta once nothing is bound in memory', async () => {
    const id = 'curated-binding-restart';
    const { agent, ownerAddress } = await createAgent('binding-restart');
    await agent.createContextGraph({
      id,
      name: 'Restarted',
      accessPolicy: 1,
      allowedAgents: [ownerAddress],
      callerAgentAddress: ownerAddress,
    });
    const { onChainId } = await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });
    agent.subscribedContextGraphs.delete(id);

    await expect(agent.resolveContextGraphOnChainIdBinding(id))
      .resolves.toEqual({ onChainId, provenance: 'ontology' });
  });
});

describe('relocating curated and private metadata that earlier builds left in ontology', () => {
  it('moves a held curated graph’s legacy ontology binding and name into its _meta', async () => {
    const id = 'legacy-curated-held';
    const { agent, ownerAddress } = await createAgent('relocate-held');
    await agent.createContextGraph({
      id,
      name: 'Held',
      accessPolicy: 1,
      allowedAgents: [ownerAddress],
      callerAgentAddress: ownerAddress,
    });
    const { onChainId } = await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });
    // What a 10.0.18 curator left behind: the binding and a rename in ontology.
    await agent.store.insert([
      bindingQuad(id, onChainId),
      ontologyQuad(contextGraphDataGraphUri(id), DKG_ONTOLOGY.SCHEMA_NAME, '"Held"'),
    ]);

    const result = await agent.relocatePrivateContextGraphMetadata({ classifyOnChain: false });

    expect(result.movedToMeta).toEqual([id]);
    expect(await ontologyRowsAbout(agent, id)).toEqual([]);
    expect(await metaOnChainId(agent, id)).toBe(onChainId);
    const listed = (await agent.listContextGraphs({ callerAgentAddress: ownerAddress }))
      .find((row) => row.id === id);
    expect(listed?.name).toBe('Held');
  });

  it('moves a legacy private:true definition, with its provenance, into _meta', async () => {
    const id = 'legacy-private-definition';
    const { agent, ownerAddress } = await createAgent('relocate-private');
    await agent.createContextGraph({
      id,
      name: 'Local notes',
      private: true,
      callerAgentAddress: ownerAddress,
    });
    // Rebuild the 10.0.18 layout: the whole definition in ontology.
    const metaGraph = contextGraphMetaGraphUri(id);
    const subject = contextGraphDataGraphUri(id);
    const definition = await agent.store.query(`
      SELECT ?s ?p ?o WHERE {
        GRAPH <${metaGraph}> {
          { <${subject}> ?p ?o . BIND(<${subject}> AS ?s) }
          UNION
          { <${subject}> <${DKG_ONTOLOGY.PROV_GENERATED_BY}> ?s . ?s ?p ?o }
        }
      }
    `);
    const moved = definition.type === 'bindings'
      ? definition.bindings
        .filter((row) => row['p'] !== DKG_ONTOLOGY.DKG_REGISTRATION_STATUS && row['p'] !== DKG_ONTOLOGY.DKG_CURATOR)
        .map((row) => ontologyQuad(row['s']!, row['p']!, row['o']!))
      : [];
    expect(moved.length).toBeGreaterThan(5);
    await agent.store.insert(moved);
    for (const quad of moved) {
      await deleteByPatternWithoutCount(agent.store, {
        graph: metaGraph,
        subject: quad.subject,
        predicate: quad.predicate,
      });
    }
    const activity = moved.find((quad) => quad.predicate === DKG_ONTOLOGY.PROV_GENERATED_BY)!.object;
    const leftInMeta = await agent.store.query(`
      SELECT ?p WHERE { GRAPH <${metaGraph}> { <${subject}> ?p ?o } }
    `);
    expect(leftInMeta.type === 'bindings' && leftInMeta.bindings.map((row) => row['p']).sort())
      .toEqual([DKG_ONTOLOGY.DKG_CURATOR, DKG_ONTOLOGY.DKG_REGISTRATION_STATUS].sort());
    await expect(agent.isPrivateContextGraph(id)).resolves.toBe(true);

    const result = await agent.relocatePrivateContextGraphMetadata({ classifyOnChain: false });

    expect(result.movedToMeta).toEqual([id]);
    expect(await ontologyRowsAbout(agent, id)).toEqual([]);
    const activityRows = await agent.store.query(`
      SELECT ?g WHERE { GRAPH ?g { <${activity}> ?p ?o } }
    `);
    expect(activityRows.type === 'bindings' && activityRows.bindings.map((row) => row['g']))
      .toEqual(expect.arrayContaining([metaGraph]));
    expect(activityRows.type === 'bindings' && activityRows.bindings.map((row) => row['g']))
      .not.toContain(ONTOLOGY_GRAPH);
    await expect(agent.isPrivateContextGraph(id)).resolves.toBe(true);
    const listed = (await agent.listContextGraphs({ callerAgentAddress: ownerAddress }))
      .find((row) => row.id === id);
    expect(listed?.name).toBe('Local notes');
  });

  it('deletes foreign curated bindings and private definitions, keeps public ones', async () => {
    const { agent, chain } = await createAgent('relocate-foreign');
    const curatedSlot = await createOnChain(chain, 1);
    const publicSlot = await createOnChain(chain, 0);
    const policyReads = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    await agent.store.insert([
      bindingQuad('0xabc/foreign-curated', curatedSlot),
      bindingQuad('0xabc/foreign-public-bare', publicSlot),
      ontologyQuad(contextGraphDataGraphUri('0xabc/foreign-renamed'), DKG_ONTOLOGY.SCHEMA_NAME, '"Renamed"'),
      ontologyQuad(contextGraphDataGraphUri('0xabc/foreign-private'), DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
      ontologyQuad(contextGraphDataGraphUri('0xabc/foreign-private'), DKG_ONTOLOGY.SCHEMA_NAME, '"Notes"'),
      ontologyQuad(contextGraphDataGraphUri('0xabc/foreign-private'), DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"private"'),
      ontologyQuad(contextGraphDataGraphUri('0xabc/foreign-open'), DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
      ontologyQuad(contextGraphDataGraphUri('0xabc/foreign-open'), DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
      bindingQuad('0xabc/foreign-open', '999'),
    ]);

    const result = await agent.relocatePrivateContextGraphMetadata();

    expect(result).toEqual({ movedToMeta: [], deletedForeign: 3, unclassified: 0 });
    expect(await ontologyRowsAbout(agent, '0xabc/foreign-curated')).toEqual([]);
    expect(await ontologyRowsAbout(agent, '0xabc/foreign-renamed')).toEqual([]);
    expect(await ontologyRowsAbout(agent, '0xabc/foreign-private')).toEqual([]);
    expect(await ontologyRowsAbout(agent, '0xabc/foreign-public-bare'))
      .toEqual([`${ON_CHAIN_ID} "${publicSlot}"`]);
    expect(await ontologyRowsAbout(agent, '0xabc/foreign-open')).toHaveLength(3);
    // Only the two bare bindings needed the chain; a public definition never does.
    expect(policyReads.mock.calls.map(([slot]) => slot.toString()).sort())
      .toEqual([curatedSlot, publicSlot].sort());
  });

  it('keeps a bare binding whose policy is unknown, and leaves it to the next pass', async () => {
    const store = (await createAgent('relocate-unknown')).agent.store;
    await store.insert([bindingQuad('0xabc/unknown-policy', '5')]);

    const unknown = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: async () => { throw new Error('rpc down'); },
    });
    expect(unknown).toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 1 });
    await expect(lookupBinding(store, '0xabc/unknown-policy')).resolves.toBe('5');

    const withoutChain = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
    });
    expect(withoutChain).toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 0 });

    const later = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: async () => 'curated',
    });
    expect(later.deletedForeign).toBe(1);
    await expect(lookupBinding(store, '0xabc/unknown-policy')).resolves.toBeUndefined();
  });

  it('keeps a bare binding to a slot that doesn’t read live until the slot is proven curated', async () => {
    const store = (await createAgent('relocate-inactive')).agent.store;
    await store.insert([bindingQuad('0xabc/not-live', '77')]);

    const notLive = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: async () => 'inactive',
    });
    expect(notLive).toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 1 });
    await expect(lookupBinding(store, '0xabc/not-live')).resolves.toBe('77');

    const curated = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: async () => 'curated',
    });
    expect(curated).toEqual({ movedToMeta: [], deletedForeign: 1, unclassified: 0 });
    await expect(lookupBinding(store, '0xabc/not-live')).resolves.toBeUndefined();
  });

  it('spends the per-pass chain budget only on slots the classifier doesn’t know yet', async () => {
    const store = (await createAgent('relocate-known')).agent.store;
    await store.insert([
      ...Array.from({ length: 3 }, (_, index) => bindingQuad(`0xabc/known-public-${index}`, String(300 + index))),
      bindingQuad('0xabc/known-not-live', '310'),
      bindingQuad('0xabc/new-curated', '320'),
    ]);
    const known = new Map([['300', 'public'], ['301', 'public'], ['302', 'public'], ['310', 'inactive']] as const);
    const classify = vi.fn(async (_slot: string) => 'curated' as const);

    const result = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: classify,
      knownSlotClass: (slot) => known.get(slot as '300'),
      maxChainClassifications: 1,
    });

    expect(classify.mock.calls).toEqual([['320']]);
    expect(result).toEqual({ movedToMeta: [], deletedForeign: 1, unclassified: 1 });
    await expect(lookupBinding(store, '0xabc/new-curated')).resolves.toBeUndefined();
    await expect(lookupBinding(store, '0xabc/known-not-live')).resolves.toBe('310');
    await expect(lookupBinding(store, '0xabc/known-public-0')).resolves.toBe('300');
  });

  it('keeps a public graph’s binding through a read that says its slot isn’t live', async () => {
    const id = '0xabc/public-behind-rpc';
    const { agent, chain } = await createAgent('relocate-lagging-rpc');
    const slot = await createOnChain(chain, 0);
    await agent.store.insert([bindingQuad(id, slot)]);
    const liveness = vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValueOnce(false);

    await expect(agent.relocatePrivateContextGraphMetadata())
      .resolves.toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 1 });
    await expect(lookupBinding(agent.store, id)).resolves.toBe(slot);

    // The not-live answer is reused for a while rather than read every pass...
    await agent.relocatePrivateContextGraphMetadata();
    expect(liveness).toHaveBeenCalledTimes(1);

    // ...then the slot is read again and proven public.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + ONTOLOGY_BINDING_SLOT_RECHECK_MS + 1);
      await expect(agent.relocatePrivateContextGraphMetadata())
        .resolves.toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 0 });
    } finally {
      vi.useRealTimers();
    }
    expect(liveness).toHaveBeenCalledTimes(2);
    await expect(lookupBinding(agent.store, id)).resolves.toBe(slot);
    expect(agent.knownOntologyBindingSlotClass(slot)).toBe('public');
  });

  it('removes a binding to a curated slot that no longer reads live', async () => {
    const id = '0xabc/deactivated-curated';
    const { agent, chain } = await createAgent('relocate-deactivated');
    const slot = await createOnChain(chain, 1);
    await agent.store.insert([bindingQuad(id, slot)]);
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValue(false);

    await expect(agent.relocatePrivateContextGraphMetadata())
      .resolves.toEqual({ movedToMeta: [], deletedForeign: 1, unclassified: 0 });
    await expect(lookupBinding(agent.store, id)).resolves.toBeUndefined();
  });

  it('forgets the oldest not-live slot once it holds the most it keeps', async () => {
    const { agent } = await createAgent('slot-memory-bound');
    const max = ONTOLOGY_BINDING_SLOTS_MAX;
    // None of these slots exists on the mock chain, so each reads not live.
    for (let slot = 1; slot <= max + 1; slot += 1) {
      await expect(agent.classifyOntologyBindingSlot(String(slot))).resolves.toBe('inactive');
    }

    expect(agent.knownOntologyBindingSlotClass('1')).toBeUndefined();
    expect(agent.knownOntologyBindingSlotClass('2')).toBe('inactive');
    expect(agent.knownOntologyBindingSlotClass(String(max + 1))).toBe('inactive');
  });

  it('bounds chain classification per pass and reads a shared slot once', async () => {
    const store = (await createAgent('relocate-bounded')).agent.store;
    await store.insert([
      ...Array.from({ length: 40 }, (_, index) => bindingQuad(`0xabc/bogus-${index}`, String(1000 + index))),
      bindingQuad('0xabc/shared-a', '2000'),
      bindingQuad('0xabc/shared-b', '2000'),
    ]);
    const classify = vi.fn(async (_slot: string) => 'unknown' as const);

    const bounded = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: classify,
      maxChainClassifications: 16,
    });
    expect(classify).toHaveBeenCalledTimes(16);
    expect(bounded.unclassified).toBe(42);

    classify.mockClear();
    const unbounded = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: classify,
      maxChainClassifications: 100,
    });
    expect(classify.mock.calls.filter(([slot]) => slot === '2000')).toHaveLength(1);
    expect(classify).toHaveBeenCalledTimes(41);
    expect(unbounded.unclassified).toBe(42);
  });

  it('keeps a bare binding of a held graph whose own _meta says public', async () => {
    const id = '0xabc/held-public-bare';
    const { agent, chain } = await createAgent('relocate-held-public');
    const policyReads = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    // A chain-discovered public graph: bare ontology binding, public `_meta` proof.
    await agent.store.insert([
      bindingQuad(id, '21'),
      {
        subject: contextGraphDataGraphUri(id),
        predicate: DKG_ONTOLOGY.RDF_TYPE,
        object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH,
        graph: contextGraphMetaGraphUri(id),
      },
      {
        subject: contextGraphDataGraphUri(id),
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"public"',
        graph: contextGraphMetaGraphUri(id),
      },
    ]);

    const result = await agent.relocatePrivateContextGraphMetadata();

    expect(result).toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 0 });
    await expect(lookupBinding(agent.store, id)).resolves.toBe('21');
    expect(await ontologyRowsAbout(agent, id)).toEqual([`${ON_CHAIN_ID} "21"`]);
    expect(policyReads).not.toHaveBeenCalled();
  });

  it('never touches the system graphs or a held public graph', async () => {
    const id = 'held-public';
    const { agent, ownerAddress } = await createAgent('relocate-public');
    await agent.createContextGraph({ id, name: 'Open', callerAgentAddress: ownerAddress });
    await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });
    const before = await ontologyRowsAbout(agent, id);
    const systemBefore = await ontologyRowsAbout(agent, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);

    const result = await agent.relocatePrivateContextGraphMetadata();

    expect(result).toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 0 });
    expect(await ontologyRowsAbout(agent, id)).toEqual(before);
    expect(await ontologyRowsAbout(agent, SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)).toEqual(systemBefore);
  });
});

describe('store discovery on a Core with a bare on-chain binding', () => {
  it('relocates a curated binding before discovery, so the graph is neither activated nor advertised', async () => {
    const id = '0x1111111111111111111111111111111111111111/curated-binding';
    const { agent, chain } = await createAgent('core-relocated', { nodeRole: 'core' });
    const slot = await createOnChain(chain, 1);
    await agent.store.insert([bindingQuad(id, slot)]);

    await agent.discoverContextGraphsFromStore();

    expect(await ontologyRowsAbout(agent, id)).toEqual([]);
    expect(agent.subscribedContextGraphs.get(id)).toBeUndefined();
  });

  it('does not activate or advertise a bare binding it cannot classify yet', async () => {
    const id = '0x1111111111111111111111111111111111111111/unclassified';
    const { agent, chain } = await createAgent('core-unclassified', { nodeRole: 'core' });
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockRejectedValue(new Error('rpc down'));
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockRejectedValue(new Error('rpc down'));
    await agent.store.insert([bindingQuad(id, '7')]);

    await agent.discoverContextGraphsFromStore();

    await expect(lookupBinding(agent.store, id)).resolves.toBe('7');
    expect(agent.subscribedContextGraphs.get(id)?.subscribed).not.toBe(true);
    let capturedProfile: Record<string, unknown> | undefined;
    (agent as unknown as { profileManager: { publishProfile: unknown } }).profileManager.publishProfile =
      async (profile: Record<string, unknown>) => {
        capturedProfile = profile;
        return { status: 'confirmed', kaId: 1, kaManifest: [] };
      };
    (agent as unknown as { broadcastPublish: unknown }).broadcastPublish = async () => undefined;
    await agent.publishProfile();
    expect(capturedProfile?.contextGraphsServed ?? []).not.toContain(id);
  });

  it('activates a public graph whose bare binding arrived before its definition', async () => {
    const id = '0x1111111111111111111111111111111111111111/binding-first';
    const { agent, chain } = await createAgent('core-binding-first', { nodeRole: 'core' });
    const slot = await createOnChain(chain, 0);
    await agent.store.insert([bindingQuad(id, slot)]);

    await agent.discoverContextGraphsFromStore();
    expect(agent.subscribedContextGraphs.get(id)?.subscribed).not.toBe(true);

    await agent.store.insert([
      ontologyQuad(contextGraphDataGraphUri(id), DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
      ontologyQuad(contextGraphDataGraphUri(id), DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
    ]);
    await agent.discoverContextGraphsFromStore();

    expect(agent.subscribedContextGraphs.get(id)?.subscribed).toBe(true);
  });

  it('still activates a public graph whose definition arrived', async () => {
    const id = '0x1111111111111111111111111111111111111111/open';
    const { agent } = await createAgent('core-public', { nodeRole: 'core' });
    await agent.store.insert([
      ontologyQuad(contextGraphDataGraphUri(id), DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
      ontologyQuad(contextGraphDataGraphUri(id), DKG_ONTOLOGY.DKG_ACCESS_POLICY, '"public"'),
      bindingQuad(id, '8'),
    ]);

    await agent.discoverContextGraphsFromStore();

    expect(agent.subscribedContextGraphs.get(id)?.subscribed).toBe(true);
  });
});

describe('store discovery of an on-chain id binding kept in _meta', () => {
  it('restores a curated graph’s on-chain id from its own _meta', async () => {
    const id = 'curated-discovery-restart';
    const { agent, ownerAddress } = await createAgent('discovery-meta-binding');
    await agent.createContextGraph({
      id,
      name: 'Restored',
      accessPolicy: 1,
      allowedAgents: [ownerAddress],
      callerAgentAddress: ownerAddress,
    });
    const { onChainId } = await agent.registerContextGraph(id, { callerAgentAddress: ownerAddress });
    agent.subscribedContextGraphs.delete(id);

    await agent.discoverContextGraphsFromStore();

    expect(agent.subscribedContextGraphs.get(id)?.onChainId).toBe(onChainId);
  });

  it('catalogues a bare binding that chain discovery left in a graph’s _meta', async () => {
    const id = '0x1111111111111111111111111111111111111111/curator-restored';
    const { agent } = await createAgent('discovery-meta-bare');
    await agent.store.insert([
      bindingQuad(id, '904', contextGraphMetaGraphUri(id)),
      // A binding about the graph in some other graph's `_meta` is not its own.
      bindingQuad('0x1111111111111111111111111111111111111111/elsewhere', '905', contextGraphMetaGraphUri(id)),
    ]);

    await agent.discoverContextGraphsFromStore();

    expect(agent.subscribedContextGraphs.get(id)?.onChainId).toBe('904');
    expect(agent.subscribedContextGraphs.get('0x1111111111111111111111111111111111111111/elsewhere'))
      .toBeUndefined();
  });

  it('prefers the ontology copy when both graphs hold a binding', async () => {
    const id = '0x1111111111111111111111111111111111111111/both-copies';
    const { agent } = await createAgent('discovery-both-copies');
    await agent.store.insert([
      ontologyQuad(contextGraphDataGraphUri(id), DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_CONTEXT_GRAPH),
      bindingQuad(id, '31'),
      bindingQuad(id, '32', contextGraphMetaGraphUri(id)),
    ]);

    await agent.discoverContextGraphsFromStore();

    expect(agent.subscribedContextGraphs.get(id)?.onChainId).toBe('31');
  });
});

describe('agent profile contextGraphsServed', () => {
  it('leaves out a subscribed graph that has no definition yet', async () => {
    const { agent, ownerAddress } = await createAgent('profile');
    await agent.createContextGraph({ id: 'profile-public', name: 'Open', callerAgentAddress: ownerAddress });
    // A joiner waiting for its curator's `_meta`: subscribed, no policy known.
    agent.subscribeToContextGraph('profile-pending-curated', { syncMode: 'always-on' });
    let capturedProfile: Record<string, unknown> | undefined;
    (agent as unknown as { profileManager: { publishProfile: unknown } }).profileManager.publishProfile =
      async (profile: Record<string, unknown>) => {
        capturedProfile = profile;
        return { status: 'confirmed', kaId: 1, kaManifest: [] };
      };
    (agent as unknown as { broadcastPublish: unknown }).broadcastPublish = async () => undefined;

    await agent.publishProfile();

    expect(capturedProfile?.contextGraphsServed).toEqual(['profile-public']);
  });
});

describe('ontology gossip bindings', () => {
  it('drops a curated binding and stores a public one', async () => {
    const { agent, chain } = await createAgent('gossip-ingest');
    const curatedSlot = await createOnChain(chain, 1);
    const publicSlot = await createOnChain(chain, 0);
    const handler = agent.getOrCreateGossipPublishHandler();

    await handler.handlePublishMessage(
      registrationGossip([['0xabc/gossiped-curated', curatedSlot]]),
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      undefined,
      '12D3KooWRegistrar',
    );
    await handler.handlePublishMessage(
      registrationGossip([['0xabc/gossiped-public', publicSlot]]),
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      undefined,
      '12D3KooWRegistrar',
    );

    await expect(lookupBinding(agent.store, '0xabc/gossiped-curated')).resolves.toBeUndefined();
    await expect(lookupBinding(agent.store, '0xabc/gossiped-public')).resolves.toBe(publicSlot);
  });

  it('stores a binding to a slot this node can’t see yet, and removes it once the slot proves curated', async () => {
    const id = '0xabc/fresh-curated';
    const { agent, chain } = await createAgent('gossip-fresh-slot');
    const handler = agent.getOrCreateGossipPublishHandler();

    // The registration announcement arrives before this node's RPC sees the slot.
    await handler.handlePublishMessage(
      registrationGossip([[id, '1']]),
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      undefined,
      '12D3KooWRegistrar',
    );
    await expect(lookupBinding(agent.store, id)).resolves.toBe('1');
    await expect(agent.relocatePrivateContextGraphMetadata())
      .resolves.toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 1 });

    // Neither read may leave a default "public" answer behind for StorageACK
    // curation checks once the curated slot becomes visible...
    await expect(createOnChain(chain, 1)).resolves.toBe('1');
    await expect(agent.resolveCgCurationForAck('1')).resolves.toBe(true);

    // ...and the binding goes once the slot is known to be curated.
    await expect(agent.relocatePrivateContextGraphMetadata())
      .resolves.toEqual({ movedToMeta: [], deletedForeign: 1, unclassified: 0 });
    await expect(lookupBinding(agent.store, id)).resolves.toBeUndefined();
  });

  it('stores a public binding whose slot first reads not live', async () => {
    const id = '0xabc/public-behind-rpc';
    const { agent, chain } = await createAgent('gossip-lagging-rpc');
    const slot = await createOnChain(chain, 0);
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValueOnce(false);

    await agent.getOrCreateGossipPublishHandler().handlePublishMessage(
      registrationGossip([[id, slot]]),
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      undefined,
      '12D3KooWRegistrar',
    );

    await expect(lookupBinding(agent.store, id)).resolves.toBe(slot);
  });

  it('stores bindings on a node that can’t read slots on chain', async () => {
    const id = '0xabc/no-chain-public';
    const agent = await DKGAgent.create({
      name: 'metadata-placement-no-chain',
      chainAdapter: new NoChainAdapter(),
    }) as TestAgent;
    (agent as unknown as { gossip: RecordingGossip }).gossip = new RecordingGossip();

    await agent.getOrCreateGossipPublishHandler().handlePublishMessage(
      registrationGossip([[id, '42']]),
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      undefined,
      '12D3KooWRegistrar',
    );

    await expect(lookupBinding(agent.store, id)).resolves.toBe('42');
  });

  it('finishes a message and a relocation pass when slot reads hang', async () => {
    const id = '0xabc/hung-rpc';
    const { agent, chain } = await createAgent('gossip-hung-rpc');
    Object.defineProperty(agent, 'chainAuthorityReadBudgets', {
      value: { ...agent.chainAuthorityReadBudgets, requestTimeoutMs: 20 },
    });
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockImplementation(() => new Promise<boolean>(() => {}));

    await agent.getOrCreateGossipPublishHandler().handlePublishMessage(
      registrationGossip([[id, '7']]),
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      undefined,
      '12D3KooWRegistrar',
    );
    await expect(lookupBinding(agent.store, id)).resolves.toBe('7');
    await expect(agent.relocatePrivateContextGraphMetadata())
      .resolves.toEqual({ movedToMeta: [], deletedForeign: 0, unclassified: 1 });
  });

  it('classifies at most a few bindings per message and drops the rest', async () => {
    const { agent, chain } = await createAgent('gossip-bounded');
    const slots: string[] = [];
    for (let index = 0; index < 6; index += 1) slots.push(await createOnChain(chain, 0));
    const policyReads = vi.spyOn(chain, 'getContextGraphAccessPolicy');
    const handler = agent.getOrCreateGossipPublishHandler();

    await handler.handlePublishMessage(
      registrationGossip(slots.map((slot, index) => [`0xabc/many-${index}`, slot] as const)),
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      undefined,
      '12D3KooWRegistrar',
    );

    expect(policyReads.mock.calls.length).toBeLessThanOrEqual(4);
    const stored = await Promise.all(slots.map((_, index) => lookupBinding(agent.store, `0xabc/many-${index}`)));
    expect(stored.filter((value) => value !== undefined).length).toBeLessThanOrEqual(4);
  });
});

describe('ontology binding slot classifier', () => {
  it('answers unknown when a read runs out of time, and reads the slot again next time', async () => {
    const isActive = vi.fn(() => new Promise<boolean>(() => {}));
    const accessPolicy = vi.fn(async () => 0);
    const classifier = new OntologyBindingSlotClassifier({
      reads: () => ({ isActive, accessPolicy }),
      knownCurated: () => false,
      readTimeoutMs: () => 10,
    });

    await expect(classifier.classify('5')).resolves.toBe('unknown');
    expect(classifier.known('5')).toBeUndefined();
    await expect(classifier.classify('5')).resolves.toBe('unknown');
    expect(isActive).toHaveBeenCalledTimes(2);
    expect(accessPolicy).not.toHaveBeenCalled();
  });

  it('answers unknown without reads for a chain that has none, or an id that isn’t a slot', async () => {
    const accessPolicy = vi.fn(async () => 1);
    const noReads = new OntologyBindingSlotClassifier({
      reads: () => ({}),
      knownCurated: () => false,
      readTimeoutMs: () => 10,
    });
    const withReads = new OntologyBindingSlotClassifier({
      reads: () => ({ isActive: async () => true, accessPolicy }),
      knownCurated: () => false,
      readTimeoutMs: () => 10,
    });

    await expect(noReads.classify('5')).resolves.toBe('unknown');
    await expect(withReads.classify('05')).resolves.toBe('unknown');
    await expect(withReads.classify('1'.repeat(79))).resolves.toBe('unknown');
    expect(accessPolicy).not.toHaveBeenCalled();
  });
});

describe('relocation at startup', () => {
  it('moves a held curated graph’s legacy ontology rows into its _meta, without chain reads, as the node starts', async () => {
    const id = '0xabc/legacy-at-start';
    const chain = new MockChainAdapter();
    const agent = await DKGAgent.create({
      name: 'metadata-placement-startup',
      listenHost: '127.0.0.1',
      chainAdapter: chain,
    }) as TestAgent;
    const subject = contextGraphDataGraphUri(id);
    const metaGraph = contextGraphMetaGraphUri(id);
    // What an upgraded node finds: its curated graph's `_meta`, plus the
    // binding and name earlier builds also wrote to ontology.
    await agent.store.insert([
      { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph: metaGraph },
      { subject, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: '"private"', graph: metaGraph },
      bindingQuad(id, '31'),
      ontologyQuad(subject, DKG_ONTOLOGY.SCHEMA_NAME, '"Legacy"'),
    ]);
    const relocate = vi.spyOn(agent, 'relocatePrivateContextGraphMetadata');

    try {
      await agent.start();

      expect(relocate).toHaveBeenCalledWith({ classifyOnChain: false });
      expect(await ontologyRowsAbout(agent, id)).toEqual([]);
      expect(await metaOnChainId(agent, id)).toBe('31');
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);
});
