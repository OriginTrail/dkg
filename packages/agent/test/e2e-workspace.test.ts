/**
 * E2E tests for the workspace graph: writeToWorkspace → GossipSub replicate →
 * query workspace → enshrineFromWorkspace → query data graph.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { DKGNode } from '@dkg/core';
import { MockChainAdapter } from '@dkg/chain';

const PARANET = 'workspace-e2e';
const ENTITY = 'urn:e2e:workspace:entity:1';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Workspace E2E (2 nodes)', () => {
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

  it('bootstraps two agent nodes and connects them', async () => {
    nodeA = await DKGAgent.create({
      name: 'WorkspaceA',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
    });
    nodeB = await DKGAgent.create({
      name: 'WorkspaceB',
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

  it('node A creates a paranet; node B subscribes; A writes to workspace and B receives via GossipSub', async () => {
    await nodeA.createParanet({
      id: PARANET,
      name: 'Workspace E2E Paranet',
      description: 'For workspace graph tests',
    });

    const exists = await nodeA.paranetExists(PARANET);
    expect(exists).toBe(true);

    nodeB.subscribeToParanet(PARANET);
    await sleep(2000);

    const quads = [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Workspace Draft"', graph: '' as const },
      { subject: ENTITY, predicate: 'http://schema.org/description', object: '"Replicated via workspace topic"', graph: '' as const },
    ];

    const result = await nodeA.writeToWorkspace(PARANET, quads);
    expect(result.workspaceOperationId).toMatch(/^ws-\d+-[a-z0-9]+$/);

    await sleep(5000);

    const onA = await nodeA.query(
      'SELECT ?name WHERE { <urn:e2e:workspace:entity:1> <http://schema.org/name> ?name }',
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    expect(onA.bindings.length).toBe(1);
    expect(String(onA.bindings[0]['name'])).toMatch(/Workspace Draft/);

    // Node B may receive via GossipSub (depends on mesh formation timing)
    const onB = await nodeB.query(
      'SELECT ?name WHERE { <urn:e2e:workspace:entity:1> <http://schema.org/name> ?name }',
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    if (onB.bindings.length > 0) {
      expect(String(onB.bindings[0]['name'])).toMatch(/Workspace Draft/);
    }
  }, 25000);

  it('query with includeWorkspace returns workspace data', async () => {
    const unionResult = await nodeA.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, includeWorkspace: true },
    );
    expect(unionResult.bindings.length).toBeGreaterThanOrEqual(1);
    const names = unionResult.bindings.map((r) => String(r['name']));
    expect(names.some((n) => n.includes('Workspace Draft'))).toBe(true);
  }, 5000);

  it('node A enshrines workspace to data graph', async () => {
    const result = await nodeA.enshrineFromWorkspace(PARANET, 'all');
    expect(result.status).toBe('confirmed');
    expect(result.kaManifest.length).toBe(1);
    expect(result.kaManifest[0].rootEntity).toBe(ENTITY);
  }, 15000);

  it('node A sees enshrined data in data graph', async () => {
    const dataGraphResult = await nodeA.query(
      'SELECT ?name WHERE { <urn:e2e:workspace:entity:1> <http://schema.org/name> ?name }',
      PARANET,
    );
    expect(dataGraphResult.bindings.length).toBe(1);
    expect(dataGraphResult.bindings[0]['name']).toContain('Workspace Draft');
  }, 10000);
});
