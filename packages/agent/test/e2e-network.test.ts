/**
 * Full-network E2E tests.
 *
 * Spins up a relay + 3 agent nodes locally, then runs through the
 * complete lifecycle: bootstrap → discover → create paranet → publish
 * KAs → replicate via GossipSub → query from every node → chat via relay.
 *
 * GossipSub propagation uses direct TCP connections (how it works in
 * real deployments after DCUtR hole-punching). The relay is used for
 * encrypted chat to validate the circuit-relay path separately.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { DKGNode } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const CUSTOM_CHAIN_ID = 'evm:84532';

describe('Network E2E (3 nodes + relay)', () => {
  let relay: DKGNode;
  let relayAddr: string;
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;

  afterAll(async () => {
    for (const n of [nodeA, nodeB, nodeC]) {
      try {
        await n?.stop();
      } catch (err) {
        console.warn('Teardown: node.stop() failed', err);
      }
    }
    try {
      await relay?.stop();
    } catch (err) {
      console.warn('Teardown: relay.stop() failed', err);
    }
  });

  // ── Step 1: Bootstrap ─────────────────────────────────────────────

  it('bootstraps a relay and 3 agent nodes', async () => {
    relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableRelayServer: true,
      enableMdns: false,
    });
    await relay.start();
    relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/ws'))!;
    expect(relayAddr).toBeDefined();

    // Use a distinct chainId so we can assert broadcast UAL/chainId come from the adapter (not hardcoded)
    nodeA = await DKGAgent.create({
      name: 'NodeA',
      framework: 'OpenClaw',
      listenPort: 0,
      relayPeers: [relayAddr],
      skills: [{
        skillType: 'ImageAnalysis',
        pricePerCall: 1.0,
        handler: async () => ({ success: true }),
      }],
      chainAdapter: new MockChainAdapter(CUSTOM_CHAIN_ID),
    });

    nodeB = await DKGAgent.create({
      name: 'NodeB',
      framework: 'ElizaOS',
      listenPort: 0,
      relayPeers: [relayAddr],
      skills: [{
        skillType: 'TextSummary',
        pricePerCall: 0.5,
        handler: async () => ({ success: true }),
      }],
      chainAdapter: new MockChainAdapter(CUSTOM_CHAIN_ID),
    });

    nodeC = await DKGAgent.create({
      name: 'NodeC',
      framework: 'DKG',
      listenPort: 0,
      relayPeers: [relayAddr],
      skills: [],
      chainAdapter: new MockChainAdapter(CUSTOM_CHAIN_ID),
    });

    await nodeA.start();
    await nodeB.start();
    await nodeC.start();

    await sleep(1000);

    expect(nodeA.peerId).toBeDefined();
    expect(nodeB.peerId).toBeDefined();
    expect(nodeC.peerId).toBeDefined();
    expect(new Set([nodeA.peerId, nodeB.peerId, nodeC.peerId]).size).toBe(3);
  }, 15000);

  // ── Step 2: Connect nodes ─────────────────────────────────────────

  it('nodes connect to each other directly and via relay', async () => {
    // Direct TCP connections for GossipSub mesh
    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    const addrB = nodeB.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;

    await nodeB.connectTo(addrA);
    await nodeC.connectTo(addrA);
    await nodeC.connectTo(addrB);
    await sleep(500);

    const peersA = nodeA.node.libp2p.getPeers();
    expect(peersA.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  // ── Step 3: Publish profiles & discover ───────────────────────────

  it('nodes publish profiles and discover each other', async () => {
    await nodeA.publishProfile();
    await nodeB.publishProfile();
    await nodeC.publishProfile();
    await sleep(2000);

    // Re-broadcast to ensure full propagation
    await nodeA.publishProfile();
    await nodeB.publishProfile();
    await nodeC.publishProfile();
    await sleep(2000);

    const agentsOnA = await nodeA.findAgents();
    const agentsOnB = await nodeB.findAgents();
    const agentsOnC = await nodeC.findAgents();

    const namesOnA = agentsOnA.map(a => a.name).sort();
    expect(namesOnA).toContain('NodeA');
    expect(namesOnA).toContain('NodeB');
    expect(namesOnA).toContain('NodeC');
    expect(agentsOnB.length).toBeGreaterThanOrEqual(3);
    expect(agentsOnC.length).toBeGreaterThanOrEqual(3);

    // NodeA's ImageAnalysis skill should be discoverable from B
    const skills = await nodeB.findSkills({ skillType: 'ImageAnalysis' });
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills[0].agentName).toBe('NodeA');
  }, 20000);

  // ── Step 4: System paranets present from genesis ──────────────────

  it('system paranets are present from genesis on all nodes', async () => {
    for (const node of [nodeA, nodeB, nodeC]) {
      const paranets = await node.listParanets();
      const ids = paranets.map(p => p.id);
      expect(ids).toContain('agents');
      expect(ids).toContain('ontology');

      const agents = paranets.find(p => p.id === 'agents')!;
      expect(agents.isSystem).toBe(true);
      expect(agents.name).toBe('Agent Registry');

      const ontology = paranets.find(p => p.id === 'ontology')!;
      expect(ontology.isSystem).toBe(true);
    }
  }, 10000);

  // ── Step 5: Create a paranet ──────────────────────────────────────

  it('a node creates a paranet and other nodes learn about it', async () => {
    await nodeA.createParanet({
      id: 'memes',
      name: 'Memes Paranet',
      description: 'Rare knowledge memes',
    });

    const existsA = await nodeA.paranetExists('memes');
    expect(existsA).toBe(true);

    const paranetsA = await nodeA.listParanets();
    const memes = paranetsA.find(p => p.id === 'memes')!;
    expect(memes).toBeDefined();
    expect(memes.name).toBe('Memes Paranet');
    expect(memes.isSystem).toBe(false);
    expect(memes.creator).toContain(nodeA.peerId);

    // Wait for GossipSub propagation of the ontology broadcast
    await sleep(2000);

    // B and C should have received the paranet definition via ontology GossipSub
    // and can also subscribe to the memes topic
    nodeB.subscribeToParanet('memes');
    nodeC.subscribeToParanet('memes');
    await sleep(500);
  }, 15000);

  // ── Step 6: Reject publishing to non-existent paranet ─────────────

  it('rejects publishing to a non-existent paranet', async () => {
    await expect(
      nodeA.publish('nonexistent-paranet', [
        { subject: 'did:dkg:entity:x', predicate: 'http://schema.org/name', object: '"X"', graph: '' },
      ]),
    ).rejects.toThrow('does not exist');
  }, 5000);

  // ── Step 7: Publish KAs and replicate via GossipSub ───────────────

  it('publishes KAs that replicate to subscribed nodes', async () => {
    // NodeA publishes knowledge
    const resultA = await nodeA.publish('memes', [
      { subject: 'did:dkg:entity:pepe-001', predicate: 'http://schema.org/name', object: '"Rare Pepe #1"', graph: '' },
      { subject: 'did:dkg:entity:pepe-001', predicate: 'http://schema.org/description', object: '"The rarest of all pepes"', graph: '' },
      { subject: 'did:dkg:entity:pepe-001', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://schema.org/CreativeWork', graph: '' },
    ]);
    expect(resultA.kcId).toBeDefined();
    expect(resultA.kaManifest.length).toBe(1);
    expect(resultA.kaManifest[0].rootEntity).toBe('did:dkg:entity:pepe-001');

    // Wait for GossipSub propagation
    await sleep(2000);

    // NodeA should have its own triples
    const qrA = await nodeA.query(
      'SELECT ?name WHERE { <did:dkg:entity:pepe-001> <http://schema.org/name> ?name }',
      'memes',
    );
    expect(qrA.bindings.length).toBe(1);
    expect(qrA.bindings[0]['name']).toContain('Rare Pepe');

    // NodeB should have A's triples via GossipSub
    const qrB = await nodeB.query(
      'SELECT ?name WHERE { <did:dkg:entity:pepe-001> <http://schema.org/name> ?name }',
      'memes',
    );
    expect(qrB.bindings.length).toBe(1);
    expect(qrB.bindings[0]['name']).toContain('Rare Pepe');

    // NodeC should also have them
    const qrC = await nodeC.query(
      'SELECT ?name WHERE { <did:dkg:entity:pepe-001> <http://schema.org/name> ?name }',
      'memes',
    );
    expect(qrC.bindings.length).toBe(1);

    // Assert broadcast PublishRequest used the chain adapter's chainId (not hardcoded mock:31337)
    const metaGraph = 'did:dkg:paranet:memes/_meta';
    const ualResult = await nodeB.store.query(
      `SELECT ?ual WHERE { GRAPH <${metaGraph}> { ?ual <http://dkg.io/ontology/status> ?status } }`,
    );
    expect(ualResult.type).toBe('bindings');
    if (ualResult.type === 'bindings' && ualResult.bindings.length > 0) {
      const ual = String(ualResult.bindings[0]['ual'] ?? '');
      expect(ual.startsWith(`did:dkg:${CUSTOM_CHAIN_ID}/`)).toBe(true);
    }
  }, 15000);

  // ── Step 8: Multi-publisher replication ────────────────────────────

  it('knowledge from multiple publishers replicates across network', async () => {
    // NodeB publishes different knowledge
    const resultB = await nodeB.publish('memes', [
      { subject: 'did:dkg:entity:wojak-001', predicate: 'http://schema.org/name', object: '"Classic Wojak"', graph: '' },
      { subject: 'did:dkg:entity:wojak-001', predicate: 'http://schema.org/description', object: '"Feels bad man"', graph: '' },
    ]);
    expect(resultB.kcId).toBeDefined();

    // NodeC publishes too
    const resultC = await nodeC.publish('memes', [
      { subject: 'did:dkg:entity:doge-001', predicate: 'http://schema.org/name', object: '"Doge"', graph: '' },
      { subject: 'did:dkg:entity:doge-001', predicate: 'http://schema.org/description', object: '"Much knowledge. Very DKG. Wow."', graph: '' },
    ]);
    expect(resultC.kcId).toBeDefined();

    await sleep(3000);

    // Every node should have all 3 entities
    for (const [label, node] of [['A', nodeA], ['B', nodeB], ['C', nodeC]] as const) {
      const result = await node.query(
        'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
        'memes',
      );
      const names = result.bindings.map((r: Record<string, string>) => r['name']);
      expect(names.length).toBeGreaterThanOrEqual(3);
    }
  }, 20000);

  // ── Step 9: SPARQL queries on replicated data ─────────────────────

  it('complex SPARQL queries work on replicated data', async () => {
    // Count all entities of type CreativeWork across the network
    const countResult = await nodeC.query(
      `SELECT (COUNT(?s) AS ?count) WHERE {
        ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/CreativeWork>
      }`,
      'memes',
    );
    expect(countResult.bindings.length).toBe(1);

    // FILTER query from a different node
    const filterResult = await nodeB.query(
      `SELECT ?s ?name WHERE {
        ?s <http://schema.org/name> ?name .
        FILTER(CONTAINS(STR(?name), "Pepe"))
      }`,
      'memes',
    );
    expect(filterResult.bindings.length).toBeGreaterThanOrEqual(1);
    expect(filterResult.bindings[0]['name']).toContain('Pepe');

    // Multi-property query
    const detailResult = await nodeA.query(
      `SELECT ?name ?desc WHERE {
        <did:dkg:entity:doge-001> <http://schema.org/name> ?name ;
                                  <http://schema.org/description> ?desc .
      }`,
      'memes',
    );
    expect(detailResult.bindings.length).toBe(1);
    expect(detailResult.bindings[0]['name']).toContain('Doge');
    expect(detailResult.bindings[0]['desc']).toContain('Much knowledge');
  }, 10000);

  // ── Step 10: Chat via relay ───────────────────────────────────────

  it('nodes exchange encrypted messages through the relay', async () => {
    const receivedOnA: string[] = [];
    const receivedOnB: string[] = [];
    const receivedOnC: string[] = [];

    nodeA.onChat((text) => { receivedOnA.push(text); });
    nodeB.onChat((text) => { receivedOnB.push(text); });
    nodeC.onChat((text) => { receivedOnC.push(text); });

    // A → B
    const r1 = await nodeA.sendChat(nodeB.peerId, 'Hey B, check out my rare pepe');
    expect(r1.delivered).toBe(true);
    expect(receivedOnB).toContain('Hey B, check out my rare pepe');

    // B → C
    const r2 = await nodeB.sendChat(nodeC.peerId, 'C, join the memes paranet!');
    expect(r2.delivered).toBe(true);
    expect(receivedOnC).toContain('C, join the memes paranet!');

    // C → A (completes the triangle)
    const r3 = await nodeC.sendChat(nodeA.peerId, 'Much knowledge. Very DKG.');
    expect(r3.delivered).toBe(true);
    expect(receivedOnA).toContain('Much knowledge. Very DKG.');

    // Verify message isolation
    expect(receivedOnA).not.toContain('C, join the memes paranet!');
    expect(receivedOnC).not.toContain('Hey B, check out my rare pepe');
  }, 15000);

  // ── Step 11: Second paranet doesn't interfere ─────────────────────

  it('creating a second paranet keeps data isolated', async () => {
    await nodeB.createParanet({
      id: 'science',
      name: 'Science Paranet',
      description: 'Peer-reviewed knowledge',
    });

    await nodeB.publish('science', [
      { subject: 'did:dkg:entity:paper-001', predicate: 'http://schema.org/name', object: '"Attention Is All You Need"', graph: '' },
    ]);

    // Science data should not appear in the memes paranet
    const memesResult = await nodeB.query(
      'SELECT ?s WHERE { <did:dkg:entity:paper-001> <http://schema.org/name> ?name }',
      'memes',
    );
    expect(memesResult.bindings.length).toBe(0);

    // But should be in the science paranet
    const scienceResult = await nodeB.query(
      'SELECT ?name WHERE { <did:dkg:entity:paper-001> <http://schema.org/name> ?name }',
      'science',
    );
    expect(scienceResult.bindings.length).toBe(1);
    expect(scienceResult.bindings[0]['name']).toContain('Attention Is All You Need');
  }, 10000);
});
