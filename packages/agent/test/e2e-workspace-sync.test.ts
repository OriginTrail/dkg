/**
 * E2E tests for workspace sync: late-joining nodes pull workspace data from
 * peers via the sync protocol, and workspaceOwnedEntities stays consistent.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

const PARANET = 'ws-sync-e2e';
const ENTITY_1 = 'urn:ws-sync:entity:1';
const ENTITY_2 = 'urn:ws-sync:entity:2';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Workspace Sync E2E (2 nodes)', () => {
  let nodeA: DKGAgent;
  let nodeC: DKGAgent;

  afterAll(async () => {
    try {
      await nodeA?.stop();
      await nodeC?.stop();
    } catch (err) {
      console.warn('Teardown:', err);
    }
  });

  it('node A starts, creates paranet, writes workspace data', async () => {
    nodeA = await DKGAgent.create({
      name: 'WsSyncA',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      syncParanets: [PARANET],
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createParanet({
      id: PARANET,
      name: 'Workspace Sync Test',
      description: 'Testing workspace sync on connect',
    });

    await nodeA.writeToWorkspace(PARANET, [
      { subject: ENTITY_1, predicate: 'http://schema.org/name', object: '"Entity One"', graph: '' },
      { subject: ENTITY_1, predicate: 'http://schema.org/description', object: '"First entity"', graph: '' },
    ]);

    await nodeA.writeToWorkspace(PARANET, [
      { subject: ENTITY_2, predicate: 'http://schema.org/name', object: '"Entity Two"', graph: '' },
    ]);

    const result = await nodeA.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    expect(result.bindings.length).toBe(2);
  }, 15000);

  it('node C starts later and syncs workspace from A on connect', async () => {
    nodeC = await DKGAgent.create({
      name: 'WsSyncC',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      syncParanets: [PARANET],
    });

    await nodeC.start();
    await sleep(500);

    nodeC.subscribeToParanet(PARANET);
    await sleep(200);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeC.connectTo(addrA);

    // Poll until sync-on-connect has populated workspace (avoids flaky fixed sleep on slow CI)
    const deadline = Date.now() + 15000;
    let result: { bindings: Array<Record<string, string>> } | undefined;
    while (Date.now() < deadline) {
      result = await nodeC.query(
        'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
        { paranetId: PARANET, graphSuffix: '_workspace' },
      );
      if (result.bindings.length >= 2) break;
      await sleep(500);
    }
    expect(result).toBeDefined();
    expect(result!.bindings.length).toBe(2);

    const names = result!.bindings.map((b: any) => String(b['name']));
    expect(names).toContain('"Entity One"');
    expect(names).toContain('"Entity Two"');
  }, 20000);

  it('explicit syncWorkspaceFromPeer returns synced triple count', async () => {
    const synced = await nodeC.syncWorkspaceFromPeer(
      nodeA.peerId,
      [PARANET],
    );
    expect(synced).toBeGreaterThan(0);
    const result = await nodeC.query(
      'SELECT ?s WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    expect(result.bindings.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it('synced workspace data is queryable via includeWorkspace', async () => {
    const result = await nodeC.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, includeWorkspace: true },
    );
    expect(result.bindings.length).toBeGreaterThanOrEqual(2);
  }, 5000);
});

describe('Workspace Sync E2E (3 nodes, chained)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;

  const PARANET_3 = 'ws-sync-3node';
  const ENTITY_A = 'urn:ws-3node:fromA';
  const ENTITY_B = 'urn:ws-3node:fromB';

  afterAll(async () => {
    try {
      await nodeA?.stop();
      await nodeB?.stop();
      await nodeC?.stop();
    } catch {}
  });

  it('A writes, B syncs from A, B writes, C syncs from B and gets both', async () => {
    nodeA = await DKGAgent.create({
      name: '3NodeA', listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      syncParanets: [PARANET_3],
    });
    await nodeA.start();
    await sleep(500);

    await nodeA.createParanet({
      id: PARANET_3, name: '3-Node Sync', description: 'Chained workspace sync',
    });

    await nodeA.writeToWorkspace(PARANET_3, [
      { subject: ENTITY_A, predicate: 'http://schema.org/name', object: '"From A"', graph: '' },
    ]);

    // B connects to A and syncs workspace
    nodeB = await DKGAgent.create({
      name: '3NodeB', listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      syncParanets: [PARANET_3],
    });
    await nodeB.start();
    await sleep(500);
    nodeB.subscribeToParanet(PARANET_3);
    await sleep(200);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(6000);

    // B should have A's data
    const onB = await nodeB.query(
      'SELECT ?name WHERE { <urn:ws-3node:fromA> <http://schema.org/name> ?name }',
      { paranetId: PARANET_3, graphSuffix: '_workspace' },
    );
    expect(onB.bindings.length).toBe(1);

    // B writes its own entity
    await nodeB.writeToWorkspace(PARANET_3, [
      { subject: ENTITY_B, predicate: 'http://schema.org/name', object: '"From B"', graph: '' },
    ]);

    // C connects to B and syncs — should get both A's and B's data
    nodeC = await DKGAgent.create({
      name: '3NodeC', listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      syncParanets: [PARANET_3],
    });
    await nodeC.start();
    await sleep(500);
    nodeC.subscribeToParanet(PARANET_3);
    await sleep(200);

    const addrB = nodeB.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeC.connectTo(addrB);
    await sleep(6000);

    const onC = await nodeC.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET_3, graphSuffix: '_workspace' },
    );
    expect(onC.bindings.length).toBe(2);

    const names = onC.bindings.map((b: any) => String(b['name']));
    expect(names).toContain('"From A"');
    expect(names).toContain('"From B"');
  }, 40000);
});
