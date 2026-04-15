import { describe, it, expect, vi } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { encodeStorageACK, computePublishACKDigest } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 } from '../src/merkle.js';
import { ethers } from 'ethers';

// Test H5 prefix inputs — must match what the collector passes into
// computePublishACKDigest so ecrecover locks onto the same digest bytes.
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test') {
  return { subject: s, predicate: p, object: o, graph: g };
}

async function signACK(
  wallet: ethers.Wallet,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount: number,
  byteSize: bigint,
  epochs: bigint = 1n,
  tokenAmount: bigint = 0n,
) {
  const digest = computePublishACKDigest(
    TEST_CHAIN_ID,
    TEST_KAV10_ADDR,
    contextGraphId,
    merkleRoot,
    BigInt(kaCount),
    byteSize,
    epochs,
    tokenAmount,
  );
  const sig = ethers.Signature.from(await wallet.signMessage(digest));
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

describe('ACKCollector', () => {
  const testCGId = 42n;
  const testCGIdStr = 'test-cg';
  const testQuads = [
    makeQuad('urn:a', 'urn:p', 'urn:o1'),
    makeQuad('urn:a', 'urn:p', 'urn:o2'),
  ];
  const merkleRoot = computeFlatKCRootV10(testQuads, []);

  const coreWallets = [
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
  ];

  it('collects 3 valid ACKs from core peers', async () => {
    const gossipCalls: Uint8Array[] = [];

    const deps: ACKCollectorDeps = {
      gossipPublish: async (_topic, data) => { gossipCalls.push(data); },
      sendP2P: async (peerId, _protocol, _data) => {
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      log: vi.fn(),
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    });

    expect(result.acks).toHaveLength(3);
    expect(gossipCalls).toHaveLength(0);
    expect(result.merkleRoot).toBe(merkleRoot);
    expect(result.contextGraphId).toBe(testCGId);

    for (const ack of result.acks) {
      expect(ack.signatureR).toBeInstanceOf(Uint8Array);
      expect(ack.signatureVS).toBeInstanceOf(Uint8Array);
      expect(ack.signatureR.length).toBe(32);
      expect(ack.signatureVS.length).toBe(32);
      expect(ack.nodeIdentityId).toBeGreaterThan(0n);
    }
  });

  it('deduplicates by peerId and nodeIdentityId', async () => {
    const peerIdentityMap: Record<string, number> = {
      'peer-0': 1,
      'peer-1': 2,
      'peer-2': 3,
      'peer-3': 4,
    };
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (peerId) => {
        const walletIdx = Math.min(Object.keys(peerIdentityMap).indexOf(peerId), coreWallets.length - 1);
        const wallet = coreWallets[walletIdx >= 0 ? walletIdx : 0];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: peerIdentityMap[peerId] ?? 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    });

    expect(result.acks).toHaveLength(3);
    const peerIds = new Set(result.acks.map(a => a.peerId));
    expect(peerIds.size).toBe(3);
    const identityIds = new Set(result.acks.map(a => a.nodeIdentityId));
    expect(identityIds.size).toBe(3);
  });

  it('fails if no connected peers', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async () => new Uint8Array(0),
      getConnectedCorePeers: () => [],
    };

    const collector = new ACKCollector(deps);
    await expect(collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    })).rejects.toThrow('no connected core peers');
  });

  it('fails if only 2 peers respond', async () => {
    let callCount = 0;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (_peerId) => {
        callCount++;
        if (callCount > 2) throw new Error('peer offline');
        const wallet = coreWallets[callCount - 1];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: callCount,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
    };

    const collector = new ACKCollector(deps);
    await expect(collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    })).rejects.toThrow('storage_ack_insufficient');
  });

  it('rejects ACKs with wrong merkle root', async () => {
    const wrongRoot = new Uint8Array(32).fill(0xff);
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (_peerId, _protocol, _data) => {
        const wallet = coreWallets[0];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 1, 100n);
        return encodeStorageACK({
          merkleRoot: wrongRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: vi.fn(),
    };

    const collector = new ACKCollector(deps);
    await expect(collector.collect({
      merkleRoot,
      contextGraphId: testCGId,
      contextGraphIdStr: testCGIdStr,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100n,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    })).rejects.toThrow('storage_ack_insufficient');
  });
});
