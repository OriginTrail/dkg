/**
 * E2E privacy tests: confirm that private paranets and local-only workspace
 * writes do NOT replicate to other nodes via GossipSub.
 *
 * Contrast with e2e-workspace.test.ts which confirms normal workspace writes
 * DO replicate.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { contextGraphDataUri, paranetMetaGraphUri, paranetDataGraphUri, SYSTEM_PARANETS, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import {
  generateKCMetadata,
  computeFlatKCRootV10,
  TripleStoreAsyncLiftPublisher,
  AsyncLiftRunner,
  type KAMetadata,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

/** Insert data quads AND matching meta quads so sync's data/meta guard passes. */
async function insertWithMeta(
  store: { insert(quads: any[]): Promise<void> },
  contextGraphId: string,
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
) {
  await store.insert(quads);
  const ual = `did:dkg:test:evm:31337/${Date.now()}`;
  const kaEntries: KAMetadata[] = quads.map((q, i) => ({
    rootEntity: q.subject,
    kcUal: ual,
    tokenId: BigInt(i + 1),
    publicTripleCount: 1,
    privateTripleCount: 0,
  }));
  const merkleRoot = computeFlatKCRootV10(quads, []);
  const meta = generateKCMetadata(
    { ual, contextGraphId, merkleRoot, kaCount: kaEntries.length, publisherPeerId: 'test', timestamp: new Date() },
    kaEntries,
  );
  await store.insert(meta);
}

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
const GUARDIAN_PARANET = 'GuardianTest';
const GUARDIAN_SWM_ENTITY = 'urn:e2e:guardian:swm:1';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    nodeB = await DKGAgent.create({
      name: 'PrivacyB',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
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
    expect(onB.bindings.length).toBeGreaterThan(0);
    expect(onB.bindings[0]['name']).toBe('"Visible Data"');
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
    walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    walletB = new ethers.Wallet(HARDHAT_KEYS.REC1_OP);
    walletC = new ethers.Wallet(HARDHAT_KEYS.REC2_OP);

    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const chainC = createEVMAdapter(HARDHAT_KEYS.REC2_OP);

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

    const { coreProfileId, receiverIds } = getSharedContext();
    const idA = BigInt(coreProfileId);
    const idB = BigInt(receiverIds[0]);
    const idC = BigInt(receiverIds[1]);

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

    await insertWithMeta((nodeA as any).store, PRIVATE_PARANET, [
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
    expect(await chainA.verifySyncIdentity(recoveredB, idB)).toBe(true);
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
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const chainC = createEVMAdapter(HARDHAT_KEYS.REC2_OP);

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

    const { coreProfileId, receiverIds } = getSharedContext();
    const idA = BigInt(coreProfileId);
    const idB = BigInt(receiverIds[0]);
    const idC = BigInt(receiverIds[1]);

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

    await insertWithMeta((nodeA as any).store, MATRIX_PUBLIC_PARANET, [
      { subject: MATRIX_PUBLIC_DATA_ENTITY, predicate: 'http://schema.org/name', object: '"Public Data"', graph: contextGraphDataUri(MATRIX_PUBLIC_PARANET) },
    ]);
    await insertWithMeta((nodeA as any).store, MATRIX_PRIVATE_PARANET, [
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
    expect(privateDataC).toBe(0);
    expect(privateSwmC).toBe(0);

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

describe('Unscoped query privacy (2 nodes)', () => {
  let nodeA: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
  });

  it('excludes private CG data from unscoped queries', async () => {
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

    nodeA = await DKGAgent.create({ name: 'UnscopedPrivacy', listenPort: 0, chainAdapter: chainA });
    await nodeA.start();
    await sleep(500);

    const idA = await chainA.getIdentityId();

    await nodeA.createContextGraph({ id: 'public-cg', name: 'Public CG' });
    // Create a private CG — createContextGraph auto-adds the creator (identity 1)
    // to participants, so we'll remove it and keep only identity 99.
    await nodeA.createContextGraph({
      id: 'private-cg',
      name: 'Private CG',
      private: true,
      participantIdentityIds: [99n],
    });
    // Override participants to exclude creator (keep only 99) in both store and memory.
    // With agent auto-registration enabled, createContextGraph also adds the creator's
    // wallet address to allowedAgents, so we must remove that too.
    const cgMetaGraph = 'did:dkg:context-graph:private-cg/_meta';
    const privateCgUri = 'did:dkg:context-graph:private-cg';
    await (nodeA as any).store.delete([
      { subject: privateCgUri, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID, object: `"${idA}"`, graph: cgMetaGraph },
    ]);
    await (nodeA as any).store.deleteByPattern({
      graph: cgMetaGraph,
      subject: privateCgUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    });
    const sub = (nodeA as any).subscribedContextGraphs.get('private-cg');
    if (sub) {
      sub.participantIdentityIds = [99n];
      sub.participantAgents = [];
    }

    const publicEntity = 'urn:test:public:entity:1';
    const privateEntity = 'urn:test:private:entity:1';

    await insertWithMeta((nodeA as any).store, 'public-cg', [
      { subject: publicEntity, predicate: 'http://schema.org/name', object: '"Public Data"', graph: contextGraphDataUri('public-cg') },
    ]);
    await insertWithMeta((nodeA as any).store, 'private-cg', [
      { subject: privateEntity, predicate: 'http://schema.org/name', object: '"Secret Data"', graph: contextGraphDataUri('private-cg') },
    ]);

    // Scoped query to public CG works
    const publicResult = await nodeA.query(
      `SELECT ?name WHERE { <${publicEntity}> <http://schema.org/name> ?name }`,
      { contextGraphId: 'public-cg' },
    );
    expect(publicResult.bindings.length).toBe(1);

    // Scoped query to private CG is denied (node A identity not in participants [99])
    const privateResult = await nodeA.query(
      `SELECT ?name WHERE { <${privateEntity}> <http://schema.org/name> ?name }`,
      { contextGraphId: 'private-cg' },
    );
    expect(privateResult.bindings.length).toBe(0);

    // Unscoped query with GRAPH pattern should NOT return private CG data
    const unscopedResult = await nodeA.query(
      `SELECT ?g ?s ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }`,
    );
    const privateBindings = unscopedResult.bindings.filter(
      b => b['name'] === '"Secret Data"'
        || (b['g'] && b['g'].includes('private-cg'))
        || (b['s'] && b['s'].includes('private')),
    );
    expect(privateBindings.length).toBe(0);

    // But unscoped query should still return public data
    const publicBindings = unscopedResult.bindings.filter(
      b => b['name'] === '"Public Data"',
    );
    expect(publicBindings.length).toBeGreaterThan(0);
  }, 30000);
});

describe('Participant IDs stored in meta graph (not ontology)', () => {
  let nodeA: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
  });

  it('stores participant identity IDs in the CG meta graph', async () => {
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

    nodeA = await DKGAgent.create({ name: 'ParticipantMetaGraph', listenPort: 0, chainAdapter: chainA });
    await nodeA.start();
    await sleep(500);

    const idA = await chainA.getIdentityId();

    await nodeA.createContextGraph({
      id: 'private-meta-test',
      name: 'Private Meta Test',
      private: true,
      participantIdentityIds: [idA, 42n],
    });

    // Check ontology graph does NOT contain participant IDs
    const ontologyResult = await (nodeA as any).store.query(
      `SELECT ?id WHERE {
        GRAPH <did:dkg:context-graph:dkg-ontology> {
          ?s <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?id
        }
      }`,
    );
    const ontologyParticipants = ontologyResult.type === 'bindings' ? ontologyResult.bindings : [];
    expect(ontologyParticipants.length).toBe(0);

    // Check CG meta graph DOES contain participant IDs
    const metaResult = await (nodeA as any).store.query(
      `SELECT ?id WHERE {
        GRAPH <did:dkg:context-graph:private-meta-test/_meta> {
          ?s <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?id
        }
      }`,
    );
    const metaParticipants = metaResult.type === 'bindings' ? metaResult.bindings : [];
    expect(metaParticipants.length).toBeGreaterThanOrEqual(2);

    // Verify getPrivateContextGraphParticipants still works (returns string IDs)
    const participants = await (nodeA as any).getPrivateContextGraphParticipants('private-meta-test');
    expect(participants).toContain(String(idA));
    expect(participants).toContain('42');
  }, 30000);
});

describe('Private context graph late join sync (3 nodes)', () => {
  let curator: DKGAgent;
  let syncerA: DKGAgent;
  let syncerB: DKGAgent;

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* */ }
    try { await syncerA?.stop(); } catch { /* */ }
    try { await syncerB?.stop(); } catch { /* */ }
  });

  it('syncs invited private graph data for an early and a late participant via real DKG sync/query flows', async () => {
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const chainC = createEVMAdapter(HARDHAT_KEYS.REC2_OP);

    const { coreProfileId, receiverIds } = getSharedContext();
    const idA = BigInt(coreProfileId);
    const idB = BigInt(receiverIds[0]);
    const idC = BigInt(receiverIds[1]);

    curator = await DKGAgent.create({ name: 'GuardianCurator', listenPort: 0, chainAdapter: chainA });
    syncerA = await DKGAgent.create({ name: 'GuardianSyncerA', listenPort: 0, chainAdapter: chainB });
    syncerB = await DKGAgent.create({ name: 'GuardianSyncerB', listenPort: 0, chainAdapter: chainC });

    await curator.start();
    await syncerA.start();
    await syncerB.start();
    await sleep(800);

    const addrCurator = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await syncerA.connectTo(addrCurator);
    await sleep(500);

    await curator.createContextGraph({
      id: GUARDIAN_PARANET,
      name: 'GuardianTest',
      description: 'Curator plus invited participants',
      private: true,
      participantIdentityIds: [idA, idB, idC],
    });

    await syncerA.syncFromPeer(curator.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    const shareResult = await curator.share(GUARDIAN_PARANET, [
      { subject: GUARDIAN_SWM_ENTITY, predicate: 'http://schema.org/text', object: '"Guardian shared memory"', graph: '' },
      { subject: GUARDIAN_SWM_ENTITY, predicate: 'http://schema.org/author', object: '"curator"', graph: '' },
    ], { localOnly: true });

    const asyncPublisher = new TripleStoreAsyncLiftPublisher((curator as any).store, {
      publishExecutor: async ({ publishOptions }) => (curator as any).publisher.publish(publishOptions),
    });
    const runner = new AsyncLiftRunner({
      publisher: asyncPublisher,
      walletIds: ['guardian-wallet'],
      pollIntervalMs: 100,
      errorBackoffMs: 100,
    });
    await asyncPublisher.lift({
      swmId: shareResult.shareOperationId,
      shareOperationId: shareResult.shareOperationId,
      roots: [GUARDIAN_SWM_ENTITY],
      contextGraphId: GUARDIAN_PARANET,
      namespace: 'guardian',
      scope: 'shared-memory',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:guardian:owner' },
    });
    await runner.start();

    try {
      const waitForJob = async (timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const jobs = await asyncPublisher.list();
          const job = jobs[0];
          if (job?.status === 'finalized' || job?.status === 'included') return job;
          if (job?.status === 'failed') throw new Error(`Async publish job failed: ${job.failure?.message ?? 'unknown failure'}`);
          await sleep(100);
        }
        throw new Error('Timed out waiting for async publish job finalization');
      };

      const finalizedJob = await waitForJob(10_000);
      expect(finalizedJob.status === 'finalized' || finalizedJob.status === 'included').toBe(true);

      const earlyDataSync = await syncerA.syncContextGraphFromConnectedPeers(GUARDIAN_PARANET, {
        includeSharedMemory: true,
      });
      expect(earlyDataSync.dataSynced).toBeGreaterThan(0);
      expect(earlyDataSync.sharedMemorySynced).toBeGreaterThan(0);

      const earlyDurable = await syncerA.query(
        `SELECT ?s ?text WHERE { ?s <http://schema.org/text> ?text }`,
        { contextGraphId: GUARDIAN_PARANET },
      );
      expect(earlyDurable.bindings.length).toBe(1);
      expect(earlyDurable.bindings[0]?.['text']).toBe('"Guardian shared memory"');

      const earlySwm = await syncerA.query(
        `SELECT ?text WHERE { <${GUARDIAN_SWM_ENTITY}> <http://schema.org/text> ?text }`,
        { contextGraphId: GUARDIAN_PARANET, graphSuffix: '_shared_memory' },
      );
      expect(earlySwm.bindings.length).toBe(1);
      expect(earlySwm.bindings[0]?.['text']).toBe('"Guardian shared memory"');

      await syncerB.connectTo(addrCurator);
      await sleep(500);
      await syncerB.syncFromPeer(curator.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

      const lateSync = await syncerB.syncContextGraphFromConnectedPeers(GUARDIAN_PARANET, {
        includeSharedMemory: true,
      });
      expect(lateSync.dataSynced).toBeGreaterThan(0);
      expect(lateSync.sharedMemorySynced).toBeGreaterThan(0);

      const lateDurable = await syncerB.query(
        `SELECT ?s ?text WHERE { ?s <http://schema.org/text> ?text }`,
        { contextGraphId: GUARDIAN_PARANET },
      );
      expect(lateDurable.bindings.length).toBe(1);
      expect(lateDurable.bindings[0]?.['text']).toBe('"Guardian shared memory"');

      const lateSwm = await syncerB.query(
        `SELECT ?text WHERE { <${GUARDIAN_SWM_ENTITY}> <http://schema.org/text> ?text }`,
        { contextGraphId: GUARDIAN_PARANET, graphSuffix: '_shared_memory' },
      );
      expect(lateSwm.bindings.length).toBe(1);
      expect(lateSwm.bindings[0]?.['text']).toBe('"Guardian shared memory"');
    } finally {
      await runner.stop();
    }
  }, 45000);
});

/**
 * Private CG sync chain: A → B → C
 *
 * Tests the critical path where an intermediary node (B) serves data to a
 * third participant (C). After B syncs from curator A, B's store has the
 * participant list from A's meta graph, enabling B to authorize C's request.
 *
 * Also verifies that B can publish new data to the private CG and C receives
 * both A's and B's data, plus that an unauthorized node D is blocked everywhere.
 */
describe('Private CG sync chain propagation (A → B → C)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;
  let nodeD: DKGAgent;
  let walletA: ethers.Wallet;
  let walletB: ethers.Wallet;
  let walletC: ethers.Wallet;
  let walletD: ethers.Wallet;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
    try { await nodeC?.stop(); } catch { /* */ }
    try { await nodeD?.stop(); } catch { /* */ }
  });

  const CHAIN_CG = 'private-chain-test';
  const ENTITY_A = 'urn:e2e:chain:a:data:1';
  const ENTITY_B = 'urn:e2e:chain:b:data:1';
  const SWM_ENTITY_A = 'urn:e2e:chain:a:swm:1';

  it('B serves C after syncing from A, unauthorized D is blocked', async () => {
    walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    walletB = new ethers.Wallet(HARDHAT_KEYS.REC1_OP);
    walletC = new ethers.Wallet(HARDHAT_KEYS.REC2_OP);
    walletD = new ethers.Wallet(HARDHAT_KEYS.REC3_OP);

    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const chainC = createEVMAdapter(HARDHAT_KEYS.REC2_OP);
    const chainD = createEVMAdapter(HARDHAT_KEYS.REC3_OP);

    const { coreProfileId, receiverIds } = getSharedContext();
    const idA = BigInt(coreProfileId);
    const idB = BigInt(receiverIds[0]);
    const idC = BigInt(receiverIds[1]);
    // D has a valid on-chain identity (receiverIds[2]) but is deliberately
    // excluded from the CG's participant list to test unauthorized sync.

    nodeA = await DKGAgent.create({ name: 'ChainA', listenPort: 0, chainAdapter: chainA });
    nodeB = await DKGAgent.create({ name: 'ChainB', listenPort: 0, chainAdapter: chainB });
    nodeC = await DKGAgent.create({ name: 'ChainC', listenPort: 0, chainAdapter: chainC });
    nodeD = await DKGAgent.create({ name: 'ChainD', listenPort: 0, chainAdapter: chainD });

    await nodeA.start();
    await nodeB.start();
    await nodeC.start();
    await nodeD.start();
    await sleep(800);

    // Connect B to A, C to B (NOT directly to A), D to B
    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    const addrB = nodeB.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(300);
    await nodeC.connectTo(addrB);
    await sleep(300);
    await nodeD.connectTo(addrB);
    await sleep(300);

    // --- Step 1: A creates private CG with A, B, C as participants (D excluded) ---
    await nodeA.createContextGraph({
      id: CHAIN_CG,
      name: 'Private Chain Test',
      description: 'Tests A→B→C sync chain',
      private: true,
      participantIdentityIds: [idA, idB, idC],
    });

    // B syncs ontology so it learns about the CG's access policy
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // --- Step 2: A publishes durable data + SWM ---
    await insertWithMeta((nodeA as any).store, CHAIN_CG, [
      {
        subject: ENTITY_A,
        predicate: 'http://schema.org/name',
        object: '"Data from curator A"',
        graph: contextGraphDataUri(CHAIN_CG),
      },
    ]);
    await nodeA.share(CHAIN_CG, [
      { subject: SWM_ENTITY_A, predicate: 'http://schema.org/text', object: '"SWM from A"', graph: '' },
    ], { localOnly: true });

    // --- Step 3: B syncs from A (gets data + meta with participant list) ---
    const bDataFromA = await nodeB.syncFromPeer(nodeA.peerId, [CHAIN_CG]);
    expect(bDataFromA).toBeGreaterThan(0);
    const bSwmFromA = await nodeB.syncSharedMemoryFromPeer(nodeA.peerId, [CHAIN_CG]);

    // Verify B got A's durable data
    const bQueryA = await nodeB.query(
      `SELECT ?name WHERE { <${ENTITY_A}> <http://schema.org/name> ?name }`,
      { contextGraphId: CHAIN_CG },
    );
    expect(bQueryA.bindings.length).toBe(1);
    expect(bQueryA.bindings[0]?.['name']).toBe('"Data from curator A"');

    // --- Step 4: Verify B has participant IDs in its store (meta propagation) ---
    const bParticipants = await (nodeB as any).getPrivateContextGraphParticipants(CHAIN_CG);
    expect(bParticipants).toBeDefined();
    expect(bParticipants).toContain(String(idA));
    expect(bParticipants).toContain(String(idB));
    expect(bParticipants).toContain(String(idC));

    // --- Step 5: B publishes its own durable data ---
    await insertWithMeta((nodeB as any).store, CHAIN_CG, [
      {
        subject: ENTITY_B,
        predicate: 'http://schema.org/name',
        object: '"Data from node B"',
        graph: contextGraphDataUri(CHAIN_CG),
      },
    ]);

    // --- Step 6: C syncs ontology from B (B got it from A) ---
    await nodeC.syncFromPeer(nodeB.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // --- Step 7: C syncs the private CG from B ---
    const cDataFromB = await nodeC.syncFromPeer(nodeB.peerId, [CHAIN_CG]);
    expect(cDataFromB).toBeGreaterThan(0);

    // Verify C has BOTH A's and B's data
    const cQueryA = await nodeC.query(
      `SELECT ?name WHERE { <${ENTITY_A}> <http://schema.org/name> ?name }`,
      { contextGraphId: CHAIN_CG },
    );
    expect(cQueryA.bindings.length).toBe(1);
    expect(cQueryA.bindings[0]?.['name']).toBe('"Data from curator A"');

    const cQueryB = await nodeC.query(
      `SELECT ?name WHERE { <${ENTITY_B}> <http://schema.org/name> ?name }`,
      { contextGraphId: CHAIN_CG },
    );
    expect(cQueryB.bindings.length).toBe(1);
    expect(cQueryB.bindings[0]?.['name']).toBe('"Data from node B"');

    // --- Step 8: D (unauthorized) cannot sync from B ---
    await nodeD.syncFromPeer(nodeB.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    const dDataFromB = await nodeD.syncFromPeer(nodeB.peerId, [CHAIN_CG]);
    expect(dDataFromB).toBe(0);

    const dSwmFromB = await nodeD.syncSharedMemoryFromPeer(nodeB.peerId, [CHAIN_CG]);
    expect(dSwmFromB).toBe(0);

    // D can't get data even from A directly
    await nodeD.connectTo(addrA);
    await sleep(300);
    const dDataFromA = await nodeD.syncFromPeer(nodeA.peerId, [CHAIN_CG]);
    expect(dDataFromA).toBe(0);

    // Verify D has nothing
    const dQuery = await nodeD.query(
      `SELECT ?name WHERE { <${ENTITY_A}> <http://schema.org/name> ?name }`,
      { contextGraphId: CHAIN_CG },
    );
    expect(dQuery.bindings.length).toBe(0);
  }, 60000);
});

/**
 * Tests the sync-on-connect discovery flow: B connects to A for the first time,
 * syncs ontology (discovers the CG), and immediately syncs the CG's durable data
 * in the same connection cycle — no second connection needed.
 */
describe('Private CG auto-discovery on connect (2 nodes)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
  });

  it('B discovers and syncs a private CG in a single connect cycle via trySyncFromPeer', async () => {
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);

    const { coreProfileId, receiverIds } = getSharedContext();
    const idA = BigInt(coreProfileId);
    const idB = BigInt(receiverIds[0]);

    nodeA = await DKGAgent.create({ name: 'DiscoverA', listenPort: 0, chainAdapter: chainA });
    nodeB = await DKGAgent.create({ name: 'DiscoverB', listenPort: 0, chainAdapter: chainB });

    await nodeA.start();
    await nodeB.start();
    await sleep(500);

    // A creates private CG and publishes data BEFORE B connects
    const DISCOVER_CG = 'discover-private-test';
    await nodeA.createContextGraph({
      id: DISCOVER_CG,
      name: 'Discover Private Test',
      private: true,
      participantIdentityIds: [idA, idB],
    });

    await insertWithMeta((nodeA as any).store, DISCOVER_CG, [
      {
        subject: 'urn:e2e:discover:data:1',
        predicate: 'http://schema.org/name',
        object: '"Auto-discovered data"',
        graph: contextGraphDataUri(DISCOVER_CG),
      },
    ]);

    // B connects to A — trySyncFromPeer should discover the CG from ontology
    // and sync its durable data in the same cycle
    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);

    // Wait for trySyncFromPeer to complete (3s delay + sync time)
    await sleep(6000);

    // B should have the private CG data without any manual sync call
    const result = await nodeB.query(
      `SELECT ?name WHERE { <urn:e2e:discover:data:1> <http://schema.org/name> ?name }`,
      { contextGraphId: DISCOVER_CG },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]?.['name']).toBe('"Auto-discovered data"');
  }, 30000);
});

/**
 * Tests the full ABC post-invite flow:
 * A creates CG with [A, B], publishes data. B syncs and publishes.
 * A then adds C to participants (simulating invite). C syncs from B.
 * B doesn't have C in its local meta, triggers meta refresh from A,
 * discovers C is now authorized, and serves the data.
 */
describe('Private CG meta refresh on auth miss (A→B→C post-invite)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
    try { await nodeC?.stop(); } catch { /* */ }
  });

  const META_REFRESH_CG = 'meta-refresh-test';
  const ENTITY_A = 'urn:e2e:metarefresh:a:1';
  const ENTITY_B = 'urn:e2e:metarefresh:b:1';

  it('B refreshes meta from curator when C (late invite) requests sync', async () => {
    const walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const walletB = new ethers.Wallet(HARDHAT_KEYS.REC1_OP);
    const walletC = new ethers.Wallet(HARDHAT_KEYS.REC2_OP);

    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const chainC = createEVMAdapter(HARDHAT_KEYS.REC2_OP);

    nodeA = await DKGAgent.create({
      name: 'MetaRefreshA', listenPort: 0, chainAdapter: chainA,
    });
    nodeB = await DKGAgent.create({
      name: 'MetaRefreshB', listenPort: 0, chainAdapter: chainB,
    });
    nodeC = await DKGAgent.create({
      name: 'MetaRefreshC', listenPort: 0, chainAdapter: chainC,
    });

    await nodeA.start();
    await nodeB.start();
    await nodeC.start();
    await sleep(500);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    const addrB = nodeB.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;

    // Connect B to A
    await nodeB.connectTo(addrA);
    await sleep(300);

    // --- Step 1: A creates private CG with only A and B (C not included yet) ---
    await nodeA.createContextGraph({
      id: META_REFRESH_CG,
      name: 'Meta Refresh Test',
      private: true,
      allowedAgents: [walletA.address, walletB.address],
    });

    // A publishes durable data
    await insertWithMeta((nodeA as any).store, META_REFRESH_CG, [
      {
        subject: ENTITY_A,
        predicate: 'http://schema.org/name',
        object: '"Data from A"',
        graph: contextGraphDataUri(META_REFRESH_CG),
      },
    ]);

    // --- Step 2: B syncs from A (gets data + meta with participants [A, B]) ---
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    const bSynced = await nodeB.syncFromPeer(nodeA.peerId, [META_REFRESH_CG]);
    expect(bSynced).toBeGreaterThan(0);

    // Verify B has A's data
    const bQueryA = await nodeB.query(
      `SELECT ?name WHERE { <${ENTITY_A}> <http://schema.org/name> ?name }`,
      { contextGraphId: META_REFRESH_CG },
    );
    expect(bQueryA.bindings.length).toBe(1);

    // Verify B's participant list does NOT include C
    const bParticipantsBefore = await (nodeB as any).getPrivateContextGraphParticipants(META_REFRESH_CG);
    expect(bParticipantsBefore).toContain(walletA.address);
    expect(bParticipantsBefore).toContain(walletB.address);
    expect(bParticipantsBefore).not.toContain(walletC.address);

    // B publishes its own data
    await insertWithMeta((nodeB as any).store, META_REFRESH_CG, [
      {
        subject: ENTITY_B,
        predicate: 'http://schema.org/name',
        object: '"Data from B"',
        graph: contextGraphDataUri(META_REFRESH_CG),
      },
    ]);

    // --- Step 3: A "invites" C by adding C's agent address to A's allowlist ---
    // This is what inviteAgentToContextGraph does under the hood.
    const cgMetaGraph = paranetMetaGraphUri(META_REFRESH_CG);
    const cgUri = paranetDataGraphUri(META_REFRESH_CG);
    await (nodeA as any).store.insert([{
      subject: cgUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${walletC.address}"`,
      graph: cgMetaGraph,
    }]);

    // --- Step 4: C connects to B (NOT to A directly) and syncs ontology ---
    await nodeC.connectTo(addrB);
    await sleep(300);
    // B must also be connected to A for the meta refresh to work
    await nodeC.syncFromPeer(nodeB.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // --- Step 5: C tries to sync the private CG from B ---
    // B's local meta has [A, B] but not C. authorizeSyncRequest should
    // trigger refreshMetaFromCurator, re-sync meta from A, find C, and allow.
    const cSynced = await nodeC.syncFromPeer(nodeB.peerId, [META_REFRESH_CG]);
    expect(cSynced).toBeGreaterThan(0);

    // --- Step 6: Verify C has both A's and B's data ---
    const cQueryA = await nodeC.query(
      `SELECT ?name WHERE { <${ENTITY_A}> <http://schema.org/name> ?name }`,
      { contextGraphId: META_REFRESH_CG },
    );
    expect(cQueryA.bindings.length).toBe(1);
    expect(cQueryA.bindings[0]?.['name']).toBe('"Data from A"');

    const cQueryB = await nodeC.query(
      `SELECT ?name WHERE { <${ENTITY_B}> <http://schema.org/name> ?name }`,
      { contextGraphId: META_REFRESH_CG },
    );
    expect(cQueryB.bindings.length).toBe(1);
    expect(cQueryB.bindings[0]?.['name']).toBe('"Data from B"');

    // --- Step 7: Verify B now has the updated participant list (after refresh) ---
    const bParticipantsAfter = await (nodeB as any).getPrivateContextGraphParticipants(META_REFRESH_CG);
    expect(bParticipantsAfter).toContain(walletC.address);
  }, 30000);
});

describe('Private CG invite via inviteAgentToContextGraph (V10 flow)', () => {
  let nodeA: DKGAgent;
  let nodeB: DKGAgent;

  afterAll(async () => {
    try { await nodeA?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
  });

  it('B syncs after being invited by A via inviteAgentToContextGraph', async () => {
    const walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const walletB = new ethers.Wallet(HARDHAT_KEYS.REC1_OP);

    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);

    nodeA = await DKGAgent.create({
      name: 'InviteA', listenPort: 0, chainAdapter: chainA,
    });
    nodeB = await DKGAgent.create({
      name: 'InviteB', listenPort: 0, chainAdapter: chainB,
    });

    await nodeA.start();
    await nodeB.start();
    await sleep(500);

    const addrA = nodeA.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(300);

    // A creates private CG with only itself
    await nodeA.createContextGraph({
      id: 'invite-flow-test',
      name: 'Invite Flow Test',
      private: true,
      allowedAgents: [walletA.address],
    });

    await insertWithMeta((nodeA as any).store, 'invite-flow-test', [{
      subject: 'urn:e2e:invite:1',
      predicate: 'http://schema.org/name',
      object: '"Invite test data"',
      graph: contextGraphDataUri('invite-flow-test'),
    }]);

    // A invites B
    await nodeA.inviteAgentToContextGraph('invite-flow-test', walletB.address);

    // B syncs — should succeed because B is now in the allowlist
    await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    const synced = await nodeB.syncFromPeer(nodeA.peerId, ['invite-flow-test']);
    expect(synced).toBeGreaterThan(0);

    const result = await nodeB.query(
      `SELECT ?name WHERE { <urn:e2e:invite:1> <http://schema.org/name> ?name }`,
      { contextGraphId: 'invite-flow-test' },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]?.['name']).toBe('"Invite test data"');
  }, 30000);
});

/**
 * Full end-to-end scenario:
 * 1. Curator (A) creates private CG, invites B and C
 * 2. B joins immediately and syncs
 * 3. A publishes durable data + SWM
 * 4. B receives SWM via sync, queries it
 * 5. C joins later, syncs from B (not A) — gets all data including SWM
 * 6. C queries durable + SWM data successfully
 */
describe('Full e2e scenario (curator + 2 joiners, late joiner via intermediate)', () => {
  let curator: DKGAgent;
  let nodeB: DKGAgent;
  let nodeC: DKGAgent;

  afterAll(async () => {
    try { await curator?.stop(); } catch { /* */ }
    try { await nodeB?.stop(); } catch { /* */ }
    try { await nodeC?.stop(); } catch { /* */ }
  });

  it('late joiner syncs all data (durable + SWM) from intermediate peer', async () => {
    const walletA = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const walletB = new ethers.Wallet(HARDHAT_KEYS.REC1_OP);
    const walletC = new ethers.Wallet(HARDHAT_KEYS.REC2_OP);

    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const chainB = createEVMAdapter(HARDHAT_KEYS.REC1_OP);
    const chainC = createEVMAdapter(HARDHAT_KEYS.REC2_OP);

    curator = await DKGAgent.create({
      name: 'E2ECurator', listenPort: 0, chainAdapter: chainA,
    });
    nodeB = await DKGAgent.create({
      name: 'E2ENodeB', listenPort: 0, chainAdapter: chainB,
    });
    nodeC = await DKGAgent.create({
      name: 'E2ENodeC', listenPort: 0, chainAdapter: chainC,
    });

    await curator.start();
    await nodeB.start();
    await nodeC.start();
    await sleep(500);

    const curatorAddr = curator.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    const addrB = nodeB.multiaddrs.find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;

    // --- Step 1: Curator creates private CG and invites B + C ---
    await curator.createContextGraph({
      id: 'private-sync-e2e',
      name: 'Private Sync E2E',
      allowedAgents: [walletA.address, walletB.address, walletC.address],
    });

    // --- Step 2: B connects and syncs immediately ---
    await nodeB.connectTo(curatorAddr);
    await sleep(300);
    await nodeB.syncFromPeer(curator.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
    await nodeB.syncFromPeer(curator.peerId, ['private-sync-e2e']);

    // --- Step 3: Curator publishes durable data ---
    await insertWithMeta((curator as any).store, 'private-sync-e2e', [{
      subject: 'urn:e2e:mission:1',
      predicate: 'http://schema.org/name',
      object: '"First Mission"',
      graph: contextGraphDataUri('private-sync-e2e'),
    }]);

    // Curator publishes SWM
    await curator.share('private-sync-e2e', [{
      subject: 'urn:e2e:swm:status',
      predicate: 'http://schema.org/text',
      object: '"SWM: mission briefing active"',
      graph: '',
    }], { localOnly: true });

    // --- Step 4: B syncs again to pick up new durable data + SWM ---
    await nodeB.syncFromPeer(curator.peerId, ['private-sync-e2e']);
    await nodeB.syncSharedMemoryFromPeer(curator.peerId, ['private-sync-e2e']);

    // Verify B has durable data
    const bDurableQuery = await nodeB.query(
      `SELECT ?name WHERE { <urn:e2e:mission:1> <http://schema.org/name> ?name }`,
      { contextGraphId: 'private-sync-e2e' },
    );
    expect(bDurableQuery.bindings.length).toBe(1);
    expect(bDurableQuery.bindings[0]?.['name']).toBe('"First Mission"');

    // Verify B has SWM data
    const bSwmQuery = await nodeB.query(
      `SELECT ?text WHERE { <urn:e2e:swm:status> <http://schema.org/text> ?text }`,
      { contextGraphId: 'private-sync-e2e', includeSharedMemory: true },
    );
    expect(bSwmQuery.bindings.length).toBe(1);

    // --- Step 5: C joins LATER, connects to B only (not directly to curator) ---
    await nodeC.connectTo(addrB);
    await sleep(300);

    // C syncs ontology from B
    await nodeC.syncFromPeer(nodeB.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

    // C syncs the private CG from B — B's authorizeSyncRequest triggers
    // refreshMetaFromCurator to verify C is in the allowlist
    const cDurableSync = await nodeC.syncFromPeer(nodeB.peerId, ['private-sync-e2e']);
    expect(cDurableSync).toBeGreaterThan(0);

    // C syncs SWM from B
    await nodeC.syncSharedMemoryFromPeer(nodeB.peerId, ['private-sync-e2e']);

    // --- Step 6: Verify C has ALL data ---
    const cDurableQuery = await nodeC.query(
      `SELECT ?name WHERE { <urn:e2e:mission:1> <http://schema.org/name> ?name }`,
      { contextGraphId: 'private-sync-e2e' },
    );
    expect(cDurableQuery.bindings.length).toBe(1);
    expect(cDurableQuery.bindings[0]?.['name']).toBe('"First Mission"');

    // Verify C has SWM
    const cSwmQuery = await nodeC.query(
      `SELECT ?text WHERE { <urn:e2e:swm:status> <http://schema.org/text> ?text }`,
      { contextGraphId: 'private-sync-e2e', includeSharedMemory: true },
    );
    expect(cSwmQuery.bindings.length).toBe(1);
    expect(cSwmQuery.bindings[0]?.['text']).toBe('"SWM: mission briefing active"');

    // Verify B's participant list was updated to include C after meta refresh
    const bParticipants = await (nodeB as any).getPrivateContextGraphParticipants('private-sync-e2e');
    expect(bParticipants).toContain(walletC.address);
  }, 45000);
});
