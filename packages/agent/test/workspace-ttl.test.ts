/**
 * Tests for workspace TTL / expiry: expired workspace operations are cleaned
 * up and not served to peers during sync.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@dkg/chain';

const PARANET = 'ws-ttl-test';
const FRESH_ENTITY = 'urn:ws-ttl:fresh:1';
const STALE_ENTITY = 'urn:ws-ttl:stale:1';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Workspace TTL', () => {
  let node: DKGAgent;

  afterAll(async () => {
    try { await node?.stop(); } catch {}
  });

  it('sets up a node with a very short TTL and writes workspace data', async () => {
    node = await DKGAgent.create({
      name: 'TtlNode',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      workspaceTtlMs: 2000, // 2 seconds for testing
    });

    await node.start();
    await sleep(500);

    await node.createParanet({
      id: PARANET,
      name: 'TTL Test Paranet',
      description: 'For workspace TTL tests',
    });

    // Write the "stale" entity first
    await node.writeToWorkspace(PARANET, [
      { subject: STALE_ENTITY, predicate: 'http://schema.org/name', object: '"Will Expire"', graph: '' },
    ]);

    const before = await node.query(
      'SELECT ?s WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    expect(before.bindings.length).toBe(1);
  }, 10000);

  it('waits for TTL to expire, writes fresh entity, runs cleanup', async () => {
    // Wait for the stale entity's TTL to expire (2s + buffer)
    await sleep(3000);

    // Write a fresh entity (this one should survive cleanup)
    await node.writeToWorkspace(PARANET, [
      { subject: FRESH_ENTITY, predicate: 'http://schema.org/name', object: '"Still Fresh"', graph: '' },
    ]);

    // Run cleanup explicitly
    const deleted = await node.cleanupExpiredWorkspace();
    expect(deleted).toBeGreaterThan(0);
  }, 10000);

  it('stale entity is gone, fresh entity remains', async () => {
    const result = await node.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );

    const subjects = result.bindings.map((b: any) => b['s']);
    expect(subjects).not.toContain(STALE_ENTITY);

    const names = result.bindings.map((b: any) => String(b['name']));
    expect(names.some((n: string) => n.includes('Still Fresh'))).toBe(true);
    expect(names.some((n: string) => n.includes('Will Expire'))).toBe(false);
  }, 5000);
});

describe('setWorkspaceTtlMs timer lifecycle', () => {
  let node: DKGAgent;

  afterAll(async () => {
    try { await node?.stop(); } catch {}
  });

  it('starts cleanup timer when TTL transitions from 0 to positive', async () => {
    node = await DKGAgent.create({
      name: 'TtlLifecycleNode',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      workspaceTtlMs: 0, // disabled
    });

    await node.start();
    await sleep(300);

    // Timer should not be running (TTL=0)
    expect((node as any).workspaceCleanupTimer).toBeNull();

    // Enable TTL at runtime
    node.setWorkspaceTtlMs(60_000);
    expect((node as any).workspaceCleanupTimer).not.toBeNull();

    // Disable again
    node.setWorkspaceTtlMs(0);
    expect((node as any).workspaceCleanupTimer).toBeNull();
  }, 10000);
});

describe('Workspace TTL sync filtering', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try {
      await nodeA?.stop();
      await nodeB?.stop();
    } catch {}
  });

  it('node A has expired + fresh data; node B only syncs fresh data', async () => {
    nodeA = await DKGAgent.create({
      name: 'TtlSyncA',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      syncParanets: ['ttl-sync-test'],
      workspaceTtlMs: 2000,
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createParanet({
      id: 'ttl-sync-test',
      name: 'TTL Sync Test',
      description: 'Testing TTL filtering during sync',
    });

    // Write stale entity
    await nodeA.writeToWorkspace('ttl-sync-test', [
      { subject: 'urn:ttl-sync:old', predicate: 'http://schema.org/name', object: '"Old Data"', graph: '' },
    ]);

    // Wait for it to expire
    await sleep(3000);

    // Write fresh entity
    await nodeA.writeToWorkspace('ttl-sync-test', [
      { subject: 'urn:ttl-sync:new', predicate: 'http://schema.org/name', object: '"New Data"', graph: '' },
    ]);

    // Node B connects and syncs
    nodeB = await DKGAgent.create({
      name: 'TtlSyncB',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
      syncParanets: ['ttl-sync-test'],
    });
    await nodeB.start();
    await sleep(500);

    nodeB.subscribeToParanet('ttl-sync-test');
    await sleep(200);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'));
    if (addrA) await nodeB.connectTo(addrA);
    await sleep(1000);

    const synced = await nodeB.syncWorkspaceFromPeer(nodeA.peerId, ['ttl-sync-test']);
    expect(synced).toBeGreaterThan(0);

    const result = await nodeB.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: 'ttl-sync-test', graphSuffix: '_workspace' },
    );

    const subjects = result.bindings.map((b: any) => b['s']);
    expect(subjects).not.toContain('urn:ttl-sync:old');

    const names = result.bindings.map((b: any) => String(b['name']));
    expect(names.some((n: string) => n.includes('New Data'))).toBe(true);
    expect(names.some((n: string) => n.includes('Old Data'))).toBe(false);
  }, 25000);
});
