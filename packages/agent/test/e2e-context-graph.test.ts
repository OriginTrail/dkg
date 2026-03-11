/**
 * E2E tests for the context graph publishing flow (2 nodes, shared mock chain):
 *
 * 1. Create a context graph on-chain (mock)
 * 2. Write data to workspace → replicate via GossipSub
 * 3. Enshrine from workspace with contextGraphId
 * 4. Finalization message propagates → peer verifies on-chain → promotes to context graph URIs
 * 5. Verify data lives in context graph data/meta graphs (not paranet data graph)
 *
 * Uses a shared MockChainAdapter so both nodes see the same on-chain events,
 * allowing B to verify A's publish transaction during finalization.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@dkg/chain';

const PARANET = 'context-graph-e2e';
const ENTITY_CTX_1 = 'urn:ctxgraph:entity:1';
const ENTITY_CTX_2 = 'urn:ctxgraph:entity:2';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('E2E: context graph publish + finalization (shared mock chain)', () => {
  const sharedChain = new MockChainAdapter('mock:31337');
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let contextGraphId: string;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch {}
    try { await nodeB?.stop(); } catch {}
  });

  it('bootstraps two agents with shared chain, connects, subscribes', async () => {
    nodeA = await DKGAgent.create({
      name: 'CtxA',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
    });
    nodeB = await DKGAgent.create({
      name: 'CtxB',
      listenPort: 0,
      skills: [],
      chainAdapter: sharedChain,
    });

    await nodeA.start();
    await nodeB.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(2000);

    expect(nodeA.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);
    expect(nodeB.node.libp2p.getPeers().length).toBeGreaterThanOrEqual(1);

    await nodeA.createParanet({ id: PARANET, name: 'Context Graph E2E', description: '' });
    nodeA.subscribeToParanet(PARANET);
    nodeB.subscribeToParanet(PARANET);
    await sleep(1500);
  }, 15_000);

  it('creates a context graph on the shared chain', async () => {
    const result = await nodeA.createContextGraph({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 0,
    });

    contextGraphId = result.contextGraphId;
    expect(contextGraphId).toBeDefined();
    expect(Number(contextGraphId)).toBeGreaterThan(0);
  }, 10_000);

  it('A writes to workspace; B receives via GossipSub', async () => {
    const quads = [
      { subject: ENTITY_CTX_1, predicate: 'http://schema.org/name', object: '"Context Graph Entity"', graph: '' },
      { subject: ENTITY_CTX_1, predicate: 'http://schema.org/version', object: '"1"', graph: '' },
    ];

    const wsResult = await nodeA.writeToWorkspace(PARANET, quads);
    expect(wsResult.workspaceOperationId).toBeDefined();

    const deadline = Date.now() + 15_000;
    let bWorkspace: any;
    while (Date.now() < deadline) {
      bWorkspace = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
        { paranetId: PARANET, graphSuffix: '_workspace' },
      );
      if (bWorkspace.bindings.length > 0) break;
      await sleep(500);
    }
    expect(bWorkspace.bindings.length).toBe(1);
    expect(String(bWorkspace.bindings[0]['name'])).toContain('Context Graph Entity');
  }, 25_000);

  it('A enshrines to context graph; A has data in context graph URI', async () => {
    const result = await nodeA.enshrineFromWorkspace(
      PARANET,
      { rootEntities: [ENTITY_CTX_1] },
      { contextGraphId },
    );

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBeDefined();

    const ctxDataGraph = `did:dkg:paranet:${PARANET}/context/${contextGraphId}`;

    const aData = await nodeA.query(
      `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_CTX_1}> <http://schema.org/name> ?name } }`,
    );
    expect(aData.bindings.length).toBe(1);
    expect(String(aData.bindings[0]['name'])).toContain('Context Graph Entity');

    // NOT in paranet data graph
    const aParanetData = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
      PARANET,
    );
    expect(aParanetData.bindings.length).toBe(0);
  }, 30_000);

  it('B receives finalization and promotes to context graph', async () => {
    const ctxDataGraph = `did:dkg:paranet:${PARANET}/context/${contextGraphId}`;

    const deadline = Date.now() + 20_000;
    let bData: any;
    while (Date.now() < deadline) {
      bData = await nodeB.query(
        `SELECT ?name WHERE { GRAPH <${ctxDataGraph}> { <${ENTITY_CTX_1}> <http://schema.org/name> ?name } }`,
      );
      if (bData.bindings.length > 0) break;
      await sleep(500);
    }

    expect(bData.bindings.length).toBe(1);
    expect(String(bData.bindings[0]['name'])).toContain('Context Graph Entity');
  }, 30_000);

  it('B has confirmed metadata in context graph meta', async () => {
    const ctxMetaGraph = `did:dkg:paranet:${PARANET}/context/${contextGraphId}/_meta`;

    const metaResult = await nodeB.query(
      `SELECT ?status WHERE { GRAPH <${ctxMetaGraph}> { ?kc <http://dkg.io/ontology/status> ?status } }`,
    );

    const statuses = metaResult.bindings.map((b: any) => String(b['status']));
    expect(statuses.some(s => s.includes('confirmed'))).toBe(true);
  }, 10_000);

  it('B paranet data graph does NOT contain context graph data', async () => {
    const paranetData = await nodeB.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
      PARANET,
    );
    expect(paranetData.bindings.length).toBe(0);
  }, 5_000);

  it('B workspace is cleaned up after promotion', async () => {
    const wsResult = await nodeB.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_1}> <http://schema.org/name> ?name }`,
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    expect(wsResult.bindings.length).toBe(0);
  }, 5_000);

  it('second enshrine to same context graph accumulates data', async () => {
    await nodeA.writeToWorkspace(PARANET, [
      { subject: ENTITY_CTX_2, predicate: 'http://schema.org/name', object: '"Second Context Entity"', graph: '' },
    ]);

    // Wait for workspace replication
    const wsDeadline = Date.now() + 10_000;
    while (Date.now() < wsDeadline) {
      const ws = await nodeB.query(
        `SELECT ?name WHERE { <${ENTITY_CTX_2}> <http://schema.org/name> ?name }`,
        { paranetId: PARANET, graphSuffix: '_workspace' },
      );
      if (ws.bindings.length > 0) break;
      await sleep(500);
    }

    const result = await nodeA.enshrineFromWorkspace(
      PARANET,
      { rootEntities: [ENTITY_CTX_2] },
      { contextGraphId, clearWorkspaceAfter: true },
    );
    expect(result.status).toBe('confirmed');

    const ctxDataGraph = `did:dkg:paranet:${PARANET}/context/${contextGraphId}`;

    // Both entities in context graph on A
    const data = await nodeA.query(
      `SELECT ?s ?name WHERE { GRAPH <${ctxDataGraph}> { ?s <http://schema.org/name> ?name } }`,
    );
    const names = data.bindings.map((b: any) => String(b['name']));
    expect(names.some((n: string) => n.includes('Context Graph Entity'))).toBe(true);
    expect(names.some((n: string) => n.includes('Second Context Entity'))).toBe(true);

    // A's workspace cleaned
    const ws = await nodeA.query(
      `SELECT ?name WHERE { <${ENTITY_CTX_2}> <http://schema.org/name> ?name }`,
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    expect(ws.bindings.length).toBe(0);

    // Poll until B promotes
    const deadline = Date.now() + 20_000;
    let bData: any;
    while (Date.now() < deadline) {
      bData = await nodeB.query(
        `SELECT ?s ?name WHERE { GRAPH <${ctxDataGraph}> { ?s <http://schema.org/name> ?name } }`,
      );
      if (bData.bindings.length >= 2) break;
      await sleep(500);
    }
    const bNames = bData.bindings.map((b: any) => String(b['name']));
    expect(bNames.some((n: string) => n.includes('Context Graph Entity'))).toBe(true);
    expect(bNames.some((n: string) => n.includes('Second Context Entity'))).toBe(true);
  }, 60_000);
});
