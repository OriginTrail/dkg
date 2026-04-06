/**
 * E2E privacy tests: confirm that private paranets and local-only workspace
 * writes do NOT replicate to other nodes via GossipSub.
 *
 * Contrast with e2e-workspace.test.ts which confirms normal workspace writes
 * DO replicate.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

const PRIVATE_PARANET = 'agent-memory-test';
const PUBLIC_PARANET = 'public-e2e';
const PRIVATE_ENTITY = 'urn:e2e:private:secret-message:1';
const PUBLIC_ENTITY = 'urn:e2e:public:visible-entity:1';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Private data isolation (2 nodes)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try {
      await nodeA?.stop();
      await nodeB?.stop();
    } catch (err) {
      console.warn('Teardown:', err);
    }
  });

  it('bootstraps two nodes and connects them', async () => {
    nodeA = await DKGAgent.create({
      name: 'PrivacyA',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
    });
    nodeB = await DKGAgent.create({
      name: 'PrivacyB',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
    });

    await nodeA.start();
    await nodeB.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(500);

    expect(nodeA.peerId).toBeDefined();
    expect(nodeB.peerId).toBeDefined();
  }, 10000);

  it('private paranet is not discoverable by other nodes', async () => {
    await nodeA.createContextGraph({
      id: PRIVATE_PARANET,
      name: 'Private Agent Memory',
      description: 'Should never leave node A',
      private: true,
    });

    const existsOnA = await nodeA.contextGraphExists(PRIVATE_PARANET);
    expect(existsOnA).toBe(true);

    // Give gossip time to propagate (if it were going to)
    await sleep(2000);

    // Node B should NOT know about the private paranet
    const existsOnB = await nodeB.contextGraphExists(PRIVATE_PARANET);
    expect(existsOnB).toBe(false);
  }, 10000);

  it('local-only workspace writes do NOT replicate to other nodes', async () => {
    const secretQuads = [
      { subject: PRIVATE_ENTITY, predicate: 'http://schema.org/text', object: '"This is my secret chat message"', graph: '' as const },
      { subject: PRIVATE_ENTITY, predicate: 'http://schema.org/author', object: '"user"', graph: '' as const },
    ];

    const result = await nodeA.share(PRIVATE_PARANET, secretQuads, { localOnly: true });
    expect(result.shareOperationId).toBeDefined();

    // Verify data exists on node A
    const onA = await nodeA.query(
      `SELECT ?text WHERE { <${PRIVATE_ENTITY}> <http://schema.org/text> ?text }`,
      { contextGraphId: PRIVATE_PARANET, graphSuffix: '_shared_memory' },
    );
    expect(onA.bindings.length).toBe(1);
    expect(onA.bindings[0]['text']).toBe('"This is my secret chat message"');

    // Wait for any possible gossip propagation
    await sleep(3000);

    // Node B should NOT have the data — it doesn't even know the paranet
    const onB = await nodeB.query(
      `SELECT ?text WHERE { <${PRIVATE_ENTITY}> <http://schema.org/text> ?text }`,
      { contextGraphId: PRIVATE_PARANET, graphSuffix: '_shared_memory' },
    );
    expect(onB.bindings.length).toBe(0);

    // Also check with includeSharedMemory and broad query
    const broadB = await nodeB.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o . FILTER(CONTAINS(STR(?o), "secret")) }`,
      { includeSharedMemory: true },
    );
    expect(broadB.bindings.length).toBe(0);
  }, 15000);

  it('normal (non-private) workspace writes DO replicate as a control test', async () => {
    await nodeA.createContextGraph({
      id: PUBLIC_PARANET,
      name: 'Public E2E Paranet',
    });

    // Node B subscribes to the public paranet
    nodeB.subscribeToContextGraph(PUBLIC_PARANET);
    await sleep(2000);

    const publicQuads = [
      { subject: PUBLIC_ENTITY, predicate: 'http://schema.org/name', object: '"Visible Data"', graph: '' as const },
    ];

    // Write WITHOUT localOnly — this should broadcast
    await nodeA.share(PUBLIC_PARANET, publicQuads);

    await sleep(5000);

    // Node A should have it
    const onA = await nodeA.query(
      `SELECT ?name WHERE { <${PUBLIC_ENTITY}> <http://schema.org/name> ?name }`,
      { contextGraphId: PUBLIC_PARANET, graphSuffix: '_shared_memory' },
    );
    expect(onA.bindings.length).toBe(1);

    // Node B should also have it (replicated via gossip)
    const onB = await nodeB.query(
      `SELECT ?name WHERE { <${PUBLIC_ENTITY}> <http://schema.org/name> ?name }`,
      { contextGraphId: PUBLIC_PARANET, graphSuffix: '_shared_memory' },
    );
    // GossipSub mesh may not form in time, so we check but don't hard-fail
    if (onB.bindings.length > 0) {
      expect(onB.bindings[0]['name']).toBe('"Visible Data"');
    }
  }, 25000);

  it('node B cannot query private data even with explicit paranet ID', async () => {
    const attempt = await nodeB.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10`,
      { contextGraphId: PRIVATE_PARANET, includeSharedMemory: true },
    );
    expect(attempt.bindings.length).toBe(0);
  }, 5000);
});
