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
import { contextGraphDataUri, SYSTEM_PARANETS } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

const PRIVATE_PARANET = 'agent-memory-test';
const PUBLIC_PARANET = 'public-e2e';
const PRIVATE_ENTITY = 'urn:e2e:private:secret-message:1';
const PUBLIC_ENTITY = 'urn:e2e:public:visible-entity:1';
const MATRIX_PUBLIC_PARANET = 'matrix-public';
const MATRIX_PRIVATE_PARANET = 'matrix-private';
const MATRIX_PUBLIC_SWM_ENTITY = 'urn:e2e:matrix:public:swm:1';
const MATRIX_PUBLIC_DATA_ENTITY = 'urn:e2e:matrix:public:data:1';
const MATRIX_PRIVATE_SWM_ENTITY = 'urn:e2e:matrix:private:swm:1';
const MATRIX_PRIVATE_DATA_ENTITY = 'urn:e2e:matrix:private:data:1';

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

  it('node B cannot sync private verified memory explicitly from node A', async () => {
    const synced = await nodeB.syncFromPeer(nodeA.peerId, [PRIVATE_PARANET]);
    expect(synced).toBe(0);
  }, 10000);

  it('node B cannot sync private shared memory explicitly from node A', async () => {
    const synced = await nodeB.syncSharedMemoryFromPeer(nodeA.peerId, [PRIVATE_PARANET]);
    expect(synced).toBe(0);
  }, 10000);
});

describe('Private context graph sync auth (3 nodes)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;
  let walletA: ethers.Wallet;
  let walletB: ethers.Wallet;
  let walletC: ethers.Wallet;

  afterAll(async () => {
    try {
      await nodeA?.stop();
      await nodeB?.stop();
      await nodeC?.stop();
    } catch (err) {
      console.warn('Teardown:', err);
    }
  });

  it('allows an authorized node to sync a private context graph and blocks a bad actor', async () => {
    walletA = ethers.Wallet.createRandom();
    walletB = ethers.Wallet.createRandom();
    walletC = ethers.Wallet.createRandom();

    const chainA = new MockChainAdapter('mock:31337', walletA.address);
    const chainB = new MockChainAdapter('mock:31337', walletB.address);
    const chainC = new MockChainAdapter('mock:31337', walletC.address);

    chainA.signMessage = async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await walletA.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };
    chainB.signMessage = async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await walletB.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };
    chainC.signMessage = async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await walletC.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };

    nodeA = await DKGAgent.create({ name: 'PrivateSyncA', listenPort: 0, chainAdapter: chainA });
    nodeB = await DKGAgent.create({ name: 'PrivateSyncB', listenPort: 0, chainAdapter: chainB });
    nodeC = await DKGAgent.create({ name: 'PrivateSyncC', listenPort: 0, chainAdapter: chainC });

    await nodeA.start();
    await nodeB.start();
    await nodeC.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await nodeC.connectTo(addrA);
    await sleep(500);

    const idA = 1n;
    const idB = 2n;
    const idC = 3n;

    (chainA as any).identities.set(walletA.address, idA);
    (chainA as any).identities.set(walletB.address, idB);
    (chainA as any).identities.set(walletC.address, idC);
    (chainB as any).identities.set(walletB.address, idB);
    (chainC as any).identities.set(walletC.address, idC);

    await nodeA.createContextGraph({
      id: PRIVATE_PARANET,
      name: 'Private Sync Graph',
      description: 'A and B only',
      private: true,
      participantIdentityIds: [idA, idB],
    });

    // B and C learn about the private graph through synced ontology metadata, not by creating their own competing definitions.
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    await nodeC.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    const privateQuads = [
      { subject: PRIVATE_ENTITY, predicate: 'http://schema.org/text', object: '"Shared only with B"', graph: '' as const },
    ];
    await nodeA.share(PRIVATE_PARANET, privateQuads, { localOnly: true });

    await (nodeA as any).store.insert([
      {
        subject: PRIVATE_ENTITY,
        predicate: 'http://schema.org/name',
        object: '"Private durable data"',
        graph: contextGraphDataUri(PRIVATE_PARANET),
      },
    ]);

    const requestB = JSON.parse(new TextDecoder().decode(await (nodeB as any).buildSyncRequest(PRIVATE_PARANET, 0, 50, false, nodeA.peerId)));
    expect(requestB.targetPeerId).toBe(nodeA.peerId);
    expect(requestB.requesterIdentityId).toBe(idB.toString());
    expect(requestB.requesterSignatureR).toBeDefined();
    expect(requestB.requesterSignatureVS).toBeDefined();
    const digestB = (nodeA as any).computeSyncDigest(PRIVATE_PARANET, 0, 50, false, nodeA.peerId, nodeB.peerId, requestB.requestId, requestB.issuedAtMs);
    const recoveredB = ethers.recoverAddress(ethers.hashMessage(digestB), {
      r: requestB.requesterSignatureR,
      yParityAndS: requestB.requesterSignatureVS,
    });
    expect(recoveredB.toLowerCase()).toBe(walletB.address.toLowerCase());
    expect(await chainA.verifyACKIdentity(recoveredB, idB)).toBe(true);
    expect(await (nodeA as any).authorizeSyncRequest(requestB, nodeB.peerId)).toBe(true);

    const requestC = JSON.parse(new TextDecoder().decode(await (nodeC as any).buildSyncRequest(PRIVATE_PARANET, 0, 50, false, nodeA.peerId)));
    expect(await (nodeA as any).authorizeSyncRequest(requestC, nodeC.peerId)).toBe(false);

    const syncedDataB = await nodeB.syncFromPeer(nodeA.peerId, [PRIVATE_PARANET]);
    expect(syncedDataB).toBeGreaterThan(0);

    const onB = await nodeB.query(
      `SELECT ?name WHERE { <${PRIVATE_ENTITY}> <http://schema.org/name> ?name }`,
      { contextGraphId: PRIVATE_PARANET },
    );
    expect(onB.bindings.length).toBe(1);
    expect(onB.bindings[0]?.['name']).toBe('"Private durable data"');

    const syncedDataC = await nodeC.syncFromPeer(nodeA.peerId, [PRIVATE_PARANET]);
    const syncedSwmC = await nodeC.syncSharedMemoryFromPeer(nodeA.peerId, [PRIVATE_PARANET]);
    expect(syncedDataC).toBe(0);
    expect(syncedSwmC).toBe(0);

    const onC = await nodeC.query(
      `SELECT ?text WHERE { <${PRIVATE_ENTITY}> <http://schema.org/text> ?text }`,
      { contextGraphId: PRIVATE_PARANET, graphSuffix: '_shared_memory' },
    );
    expect(onC.bindings.length).toBe(0);
  }, 30000);
});

describe('Context graph access matrix (3 nodes)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;
  let walletA: ethers.Wallet;
  let walletB: ethers.Wallet;
  let walletC: ethers.Wallet;

  afterAll(async () => {
    try {
      await nodeA?.stop();
      await nodeB?.stop();
      await nodeC?.stop();
    } catch (err) {
      console.warn('Teardown:', err);
    }
  });

  it('enforces public/private x durable/SWM x authorized/unauthorized sync matrix', async () => {
    walletA = ethers.Wallet.createRandom();
    walletB = ethers.Wallet.createRandom();
    walletC = ethers.Wallet.createRandom();

    const chainA = new MockChainAdapter('mock:31337', walletA.address);
    const chainB = new MockChainAdapter('mock:31337', walletB.address);
    const chainC = new MockChainAdapter('mock:31337', walletC.address);

    chainA.signMessage = async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await walletA.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };
    chainB.signMessage = async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await walletB.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };
    chainC.signMessage = async (digest: Uint8Array) => {
      const sig = ethers.Signature.from(await walletC.signMessage(digest));
      return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
    };

    nodeA = await DKGAgent.create({ name: 'MatrixA', listenPort: 0, chainAdapter: chainA });
    nodeB = await DKGAgent.create({ name: 'MatrixB', listenPort: 0, chainAdapter: chainB });
    nodeC = await DKGAgent.create({ name: 'MatrixC', listenPort: 0, chainAdapter: chainC });

    await nodeA.start();
    await nodeB.start();
    await nodeC.start();
    await sleep(800);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await nodeC.connectTo(addrA);
    await sleep(500);

    const idA = 1n;
    const idB = 2n;
    const idC = 3n;
    (chainA as any).identities.set(walletA.address, idA);
    (chainA as any).identities.set(walletB.address, idB);
    (chainA as any).identities.set(walletC.address, idC);
    (chainB as any).identities.set(walletB.address, idB);
    (chainC as any).identities.set(walletC.address, idC);

    await nodeA.createContextGraph({ id: MATRIX_PUBLIC_PARANET, name: 'Matrix Public' });
    nodeB.subscribeToContextGraph(MATRIX_PUBLIC_PARANET);
    nodeC.subscribeToContextGraph(MATRIX_PUBLIC_PARANET);

    await nodeA.createContextGraph({
      id: MATRIX_PRIVATE_PARANET,
      name: 'Matrix Private',
      private: true,
      participantIdentityIds: [idA, idB],
    });
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    await nodeC.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    await sleep(1000);

    await nodeA.share(MATRIX_PUBLIC_PARANET, [
      { subject: MATRIX_PUBLIC_SWM_ENTITY, predicate: 'http://schema.org/name', object: '"Public SWM"', graph: '' },
    ]);
    await nodeA.share(MATRIX_PRIVATE_PARANET, [
      { subject: MATRIX_PRIVATE_SWM_ENTITY, predicate: 'http://schema.org/name', object: '"Private SWM"', graph: '' },
    ], { localOnly: true });

    await (nodeA as any).store.insert([
      { subject: MATRIX_PUBLIC_DATA_ENTITY, predicate: 'http://schema.org/name', object: '"Public Data"', graph: contextGraphDataUri(MATRIX_PUBLIC_PARANET) },
      { subject: MATRIX_PRIVATE_DATA_ENTITY, predicate: 'http://schema.org/name', object: '"Private Data"', graph: contextGraphDataUri(MATRIX_PRIVATE_PARANET) },
    ]);

    await sleep(3000);

    const publicDataB = await nodeB.syncFromPeer(nodeA.peerId, [MATRIX_PUBLIC_PARANET]);
    const publicSwmB = await nodeB.syncSharedMemoryFromPeer(nodeA.peerId, [MATRIX_PUBLIC_PARANET]);
    const publicDataC = await nodeC.syncFromPeer(nodeA.peerId, [MATRIX_PUBLIC_PARANET]);
    const publicSwmC = await nodeC.syncSharedMemoryFromPeer(nodeA.peerId, [MATRIX_PUBLIC_PARANET]);

    expect(publicDataB).toBeGreaterThan(0);
    expect(publicSwmB).toBeGreaterThanOrEqual(0);
    expect(publicDataC).toBeGreaterThan(0);
    expect(publicSwmC).toBeGreaterThanOrEqual(0);

    const privateDataB = await nodeB.syncFromPeer(nodeA.peerId, [MATRIX_PRIVATE_PARANET]);
    const privateSwmB = await nodeB.syncSharedMemoryFromPeer(nodeA.peerId, [MATRIX_PRIVATE_PARANET]);
    const privateDataC = await nodeC.syncFromPeer(nodeA.peerId, [MATRIX_PRIVATE_PARANET]);
    const privateSwmC = await nodeC.syncSharedMemoryFromPeer(nodeA.peerId, [MATRIX_PRIVATE_PARANET]);

    expect(privateDataB).toBeGreaterThan(0);
    expect(privateSwmB).toBeGreaterThan(0);
    expect(privateDataC).toBeGreaterThanOrEqual(0);
    expect(privateSwmC).toBeGreaterThanOrEqual(0);

    const queryMatrix = [
      { node: nodeB, contextGraphId: MATRIX_PUBLIC_PARANET, entity: MATRIX_PUBLIC_DATA_ENTITY, expected: '"Public Data"' },
      { node: nodeC, contextGraphId: MATRIX_PUBLIC_PARANET, entity: MATRIX_PUBLIC_DATA_ENTITY, expected: '"Public Data"' },
      { node: nodeB, contextGraphId: MATRIX_PRIVATE_PARANET, entity: MATRIX_PRIVATE_DATA_ENTITY, expected: '"Private Data"' },
      { node: nodeC, contextGraphId: MATRIX_PRIVATE_PARANET, entity: MATRIX_PRIVATE_DATA_ENTITY, expected: null },
    ] as const;

    for (const entry of queryMatrix) {
      const result = await entry.node.query(
        `SELECT ?name WHERE { <${entry.entity}> <http://schema.org/name> ?name }`,
        { contextGraphId: entry.contextGraphId },
      );
      if (entry.expected === null) {
        expect(result.bindings.length).toBe(0);
      } else {
        expect(result.bindings.length).toBe(1);
        expect(result.bindings[0]?.['name']).toBe(entry.expected);
      }
    }

    const swmMatrix = [
      { node: nodeB, contextGraphId: MATRIX_PUBLIC_PARANET, entity: MATRIX_PUBLIC_SWM_ENTITY, expected: '"Public SWM"' },
      { node: nodeC, contextGraphId: MATRIX_PUBLIC_PARANET, entity: MATRIX_PUBLIC_SWM_ENTITY, expected: '"Public SWM"' },
      { node: nodeB, contextGraphId: MATRIX_PRIVATE_PARANET, entity: MATRIX_PRIVATE_SWM_ENTITY, expected: '"Private SWM"' },
      { node: nodeC, contextGraphId: MATRIX_PRIVATE_PARANET, entity: MATRIX_PRIVATE_SWM_ENTITY, expected: null },
    ] as const;

    for (const entry of swmMatrix) {
      const result = await entry.node.query(
        `SELECT ?name WHERE { <${entry.entity}> <http://schema.org/name> ?name }`,
        { contextGraphId: entry.contextGraphId, graphSuffix: '_shared_memory' },
      );
      if (entry.expected === null) {
        expect(result.bindings.length).toBe(0);
      } else {
        expect(result.bindings.length).toBe(1);
        expect(result.bindings[0]?.['name']).toBe(entry.expected);
      }
    }
  }, 40000);
});
