/**
 * Tests for workspace TTL / expiry: expired workspace operations are cleaned
 * up and not served to peers during sync.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

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

  it('stale workspace data is cleaned up while fresh data survives', async () => {
    node = await DKGAgent.create({
      name: 'TtlNode',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      sharedMemoryTtlMs: 2000,
    });

    await node.start();
    await sleep(500);

    await node.createContextGraph({
      id: PARANET,
      name: 'TTL Test Paranet',
      description: 'For workspace TTL tests',
    });

    await node.share(PARANET, [
      { subject: STALE_ENTITY, predicate: 'http://schema.org/name', object: '"Will Expire"', graph: '' },
    ]);

    const before = await node.query(
      'SELECT ?s WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
    );
    expect(before.bindings.length).toBe(1);

    // Wait for the stale entity's TTL to expire (2s + buffer)
    await sleep(3000);

    // Write a fresh entity (this one should survive cleanup)
    await node.share(PARANET, [
      { subject: FRESH_ENTITY, predicate: 'http://schema.org/name', object: '"Still Fresh"', graph: '' },
    ]);

    const deleted = await node.cleanupExpiredSharedMemory();
    expect(deleted).toBeGreaterThan(0);

    const result = await node.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: PARANET, graphSuffix: '_shared_memory' },
    );

    const subjects = result.bindings.map((b: any) => b['s']);
    expect(subjects).not.toContain(STALE_ENTITY);

    const names = result.bindings.map((b: any) => String(b['name']));
    expect(names.some((n: string) => n === '"Still Fresh"')).toBe(true);
    expect(names.some((n: string) => n === '"Will Expire"')).toBe(false);
  }, 20000);
});

describe('setSharedMemoryTtlMs timer lifecycle', () => {
  let node: DKGAgent;

  afterAll(async () => {
    try { await node?.stop(); } catch {}
  });

  it('starts cleanup timer when TTL transitions from 0 to positive', async () => {
    node = await DKGAgent.create({
      name: 'TtlLifecycleNode',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      sharedMemoryTtlMs: 0, // disabled
    });

    await node.start();
    await sleep(300);

    // Timer should not be running (TTL=0)
    expect((node as any).swmCleanupTimer).toBeNull();

    // Enable TTL at runtime
    node.setSharedMemoryTtlMs(60_000);
    expect((node as any).swmCleanupTimer).not.toBeNull();

    // Disable again
    node.setSharedMemoryTtlMs(0);
    expect((node as any).swmCleanupTimer).toBeNull();
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
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      syncContextGraphs: ['ttl-sync-test'],
      sharedMemoryTtlMs: 2000,
    });

    await nodeA.start();
    await sleep(500);

    await nodeA.createContextGraph({
      id: 'ttl-sync-test',
      name: 'TTL Sync Test',
      description: 'Testing TTL filtering during sync',
    });

    // Write stale entity
    await nodeA.share('ttl-sync-test', [
      { subject: 'urn:ttl-sync:old', predicate: 'http://schema.org/name', object: '"Old Data"', graph: '' },
    ]);

    // Set up nodeB while the stale data expires (saves wall-clock time)
    nodeB = await DKGAgent.create({
      name: 'TtlSyncB',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      syncContextGraphs: ['ttl-sync-test'],
    });
    await nodeB.start();
    await sleep(500);

    nodeB.subscribeToContextGraph('ttl-sync-test');
    await sleep(200);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'));
    if (addrA) await nodeB.connectTo(addrA);
    await sleep(1000);

    // Ensure the old data has expired (TTL is 2s; node setup above took > 2s)
    await sleep(1000);

    // Write fresh entity right before sync so it's within the TTL window
    await nodeA.share('ttl-sync-test', [
      { subject: 'urn:ttl-sync:new', predicate: 'http://schema.org/name', object: '"New Data"', graph: '' },
    ]);

    const synced = await nodeB.syncSharedMemoryFromPeer(nodeA.peerId, ['ttl-sync-test']);
    expect(synced).toBeGreaterThan(0);

    const result = await nodeB.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: 'ttl-sync-test', graphSuffix: '_shared_memory' },
    );

    const subjects = result.bindings.map((b: any) => b['s']);
    expect(subjects).not.toContain('urn:ttl-sync:old');

    const names = result.bindings.map((b: any) => String(b['name']));
    expect(names.some((n: string) => n === '"New Data"')).toBe(true);
    expect(names.some((n: string) => n === '"Old Data"')).toBe(false);
  }, 25000);
});
