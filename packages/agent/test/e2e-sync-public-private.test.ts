import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { SYSTEM_PARANETS, contextGraphDataUri } from '@origintrail-official/dkg-core';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { computeFlatKCRootV10, generateKCMetadata, type KAMetadata } from '@origintrail-official/dkg-publisher';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertWithMeta(
  store: { insert(quads: any[]): Promise<void> },
  contextGraphId: string,
  quads: Array<{ subject: string; predicate: string; object: string; graph: string }>,
) {
  await store.insert(quads);
  const ual = `did:dkg:test:evm:31337/${Date.now()}`;
  const kaEntries: KAMetadata[] = quads.map((quad, index) => ({
    rootEntity: quad.subject,
    kcUal: ual,
    tokenId: BigInt(index + 1),
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

let fileSnapshot: string;

beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});

afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

describe('E2E sync verification for public and private graphs', () => {
  it('syncs a public graph to multiple peers via real sync/query flows', async () => {
    const nodeA = await DKGAgent.create({
      name: 'PublicSyncA',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    const nodeB = await DKGAgent.create({
      name: 'PublicSyncB',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
    });
    const nodeC = await DKGAgent.create({
      name: 'PublicSyncC',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC2_OP),
    });

    try {
      await nodeA.start();
      await nodeB.start();
      await nodeC.start();
      await sleep(800);

      const addrA = nodeA.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'))!;
      await nodeB.connectTo(addrA);
      await nodeC.connectTo(addrA);
      await sleep(500);

      const contextGraphId = 'public-sync-e2e';
      const entity = 'urn:e2e:public-sync:1';
      await nodeA.createContextGraph({
        id: contextGraphId,
        name: 'Public Sync E2E',
        description: 'Public graph should sync to all peers',
      });

      await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
      await nodeC.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

      await insertWithMeta((nodeA as any).store, contextGraphId, [
        {
          subject: entity,
          predicate: 'http://schema.org/name',
          object: '"Public Graph Data"',
          graph: contextGraphDataUri(contextGraphId),
        },
      ]);

      const syncedB = await nodeB.syncFromPeer(nodeA.peerId, [contextGraphId]);
      const syncedC = await nodeC.syncFromPeer(nodeA.peerId, [contextGraphId]);

      expect(syncedB).toBeGreaterThan(0);
      expect(syncedC).toBeGreaterThan(0);

      const queryB = await nodeB.query(
        `SELECT ?name WHERE { <${entity}> <http://schema.org/name> ?name }`,
        { contextGraphId },
      );
      const queryC = await nodeC.query(
        `SELECT ?name WHERE { <${entity}> <http://schema.org/name> ?name }`,
        { contextGraphId },
      );

      expect(queryB.bindings.length).toBe(1);
      expect(queryB.bindings[0]?.['name']).toBe('"Public Graph Data"');
      expect(queryC.bindings.length).toBe(1);
      expect(queryC.bindings[0]?.['name']).toBe('"Public Graph Data"');
    } finally {
      await nodeA.stop().catch(() => {});
      await nodeB.stop().catch(() => {});
      await nodeC.stop().catch(() => {});
    }
  }, 30000);

  it('syncs a private graph only to invited peers and denies others', async () => {
    const nodeA = await DKGAgent.create({
      name: 'PrivateSyncA',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    const nodeB = await DKGAgent.create({
      name: 'PrivateSyncB',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
    });
    const nodeC = await DKGAgent.create({
      name: 'PrivateSyncC',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC2_OP),
    });

    try {
      await nodeA.start();
      await nodeB.start();
      await nodeC.start();
      await sleep(800);

      const addrA = nodeA.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'))!;
      await nodeB.connectTo(addrA);
      await nodeC.connectTo(addrA);
      await sleep(500);

      const { coreProfileId, receiverIds } = getSharedContext();
      const contextGraphId = 'private-sync-e2e-focused';
      const entity = 'urn:e2e:private-sync:1';
      await nodeA.createContextGraph({
        id: contextGraphId,
        name: 'Private Sync E2E',
        description: 'Only invited peers should sync',
        private: true,
        participantIdentityIds: [BigInt(coreProfileId), BigInt(receiverIds[0])],
      });

      await nodeB.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);
      await nodeC.syncFromPeer(nodeA.peerId, [SYSTEM_PARANETS.ONTOLOGY]);

      await insertWithMeta((nodeA as any).store, contextGraphId, [
        {
          subject: entity,
          predicate: 'http://schema.org/name',
          object: '"Private Graph Data"',
          graph: contextGraphDataUri(contextGraphId),
        },
      ]);

      const syncedB = await nodeB.syncFromPeer(nodeA.peerId, [contextGraphId]);
      const syncedC = await nodeC.syncFromPeer(nodeA.peerId, [contextGraphId]);

      expect(syncedB).toBeGreaterThan(0);
      expect(syncedC).toBe(0);

      const queryB = await nodeB.query(
        `SELECT ?name WHERE { <${entity}> <http://schema.org/name> ?name }`,
        { contextGraphId },
      );
      const queryC = await nodeC.query(
        `SELECT ?name WHERE { <${entity}> <http://schema.org/name> ?name }`,
        { contextGraphId },
      );

      expect(queryB.bindings.length).toBe(1);
      expect(queryB.bindings[0]?.['name']).toBe('"Private Graph Data"');
      expect(queryC.bindings.length).toBe(0);
    } finally {
      await nodeA.stop().catch(() => {});
      await nodeB.stop().catch(() => {});
      await nodeC.stop().catch(() => {});
    }
  }, 30000);
});
