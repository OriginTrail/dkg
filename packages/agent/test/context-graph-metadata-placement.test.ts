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
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
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

  it('deletes a bare binding to a slot the chain proves inactive', async () => {
    const store = (await createAgent('relocate-inactive')).agent.store;
    await store.insert([bindingQuad('0xabc/not-minted', '77')]);

    const result = await relocatePrivateContextGraphMetadata({
      store,
      localAccessPolicy: async () => null,
      classifyOnChainSlot: async () => 'inactive',
    });

    expect(result).toEqual({ movedToMeta: [], deletedForeign: 1, unclassified: 0 });
    await expect(lookupBinding(store, '0xabc/not-minted')).resolves.toBeUndefined();
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

  it('drops a binding to a slot this node cannot see yet, without caching a public answer', async () => {
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
    await expect(lookupBinding(agent.store, id)).resolves.toBeUndefined();

    // A copy that arrives by ontology sync is removed for the same reason.
    await agent.store.insert([bindingQuad(id, '1')]);
    await agent.relocatePrivateContextGraphMetadata();
    await expect(lookupBinding(agent.store, id)).resolves.toBeUndefined();

    // Neither read may leave a default "public" answer behind for StorageACK
    // curation checks once the curated slot becomes visible.
    await expect(createOnChain(chain, 1)).resolves.toBe('1');
    await expect(agent.resolveCgCurationForAck('1')).resolves.toBe(true);
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
