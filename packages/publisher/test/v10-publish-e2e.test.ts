import { describe, it, expect, vi } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { computeFlatKCRootV10 as computeFlatKCRoot, computeFlatKCRootV10, computeTripleHashV10 } from '../src/merkle.js';
import {
  encodePublishIntent, decodePublishIntent,
  encodeStorageACK, decodeStorageACK,
  computeACKDigest,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('V10 Publish E2E', () => {
  const contextGraphId = 'my-research-project';
  const cgIdBigInt = 0n;
  const swmGraphUri = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;

  const publishQuads: Quad[] = [
    makeQuad('urn:experiment:wsd', 'http://schema.org/name', '"Word Sense Disambiguation"'),
    makeQuad('urn:experiment:wsd', 'urn:exp:val_bpb', '"1.36"'),
    makeQuad('urn:experiment:wsd', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'urn:exp:Experiment'),
  ];

  const coreWallets = [
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
    ethers.Wallet.createRandom(),
  ];

  const publisherWallet = ethers.Wallet.createRandom();

  it('full V10 publish flow: merkle → ACK collection → verification', async () => {
    // Phase 1: Publisher computes V10 merkle root
    const merkleRoot = computeFlatKCRoot(publishQuads, []);
    expect(merkleRoot).toBeInstanceOf(Uint8Array);
    expect(merkleRoot.length).toBe(32);

    // Phase 2: Each core node independently verifies and signs
    const coreNodeResponses = await Promise.all(
      coreWallets.map(async (wallet, idx) => {
        // Core node recomputes merkle root from its SWM copy
        const localRoot = computeFlatKCRoot(publishQuads, []);
        expect(Buffer.from(localRoot).equals(Buffer.from(merkleRoot))).toBe(true);

        // Core node signs ACK: digest uses 0n for non-numeric context graph id strings.
        const digest = computeACKDigest(cgIdBigInt, merkleRoot);
        const sig = ethers.Signature.from(await wallet.signMessage(digest));

        return {
          peerId: `core-node-${idx}`,
          signatureR: ethers.getBytes(sig.r),
          signatureVS: ethers.getBytes(sig.yParityAndS),
          nodeIdentityId: BigInt(idx + 1),
          address: wallet.address,
        };
      }),
    );

    expect(coreNodeResponses).toHaveLength(3);

    // Phase 3: Publisher verifies each ACK via ecrecover
    for (const ack of coreNodeResponses) {
      const digest = computeACKDigest(cgIdBigInt, merkleRoot);
      const prefixedHash = ethers.hashMessage(digest);
      const recovered = ethers.recoverAddress(prefixedHash, {
        r: ethers.hexlify(ack.signatureR),
        yParityAndS: ethers.hexlify(ack.signatureVS),
      });
      expect(recovered.toLowerCase()).toBe(ack.address.toLowerCase());
    }

    // All 3 ACKs are on the same merkle root — ready for chain TX
    const ackRs = coreNodeResponses.map(a => ethers.hexlify(a.signatureR));
    const ackVSs = coreNodeResponses.map(a => ethers.hexlify(a.signatureVS));
    expect(ackRs).toHaveLength(3);
    expect(ackVSs).toHaveLength(3);
  });

  it('StorageACKHandler + ACKCollector round-trip', async () => {
    const merkleRoot = computeFlatKCRoot(publishQuads, []);
    const rootEntities = ['urn:experiment:wsd'];

    const mockStore = {
      insert: vi.fn(),
      delete: vi.fn(),
      deleteByPattern: vi.fn(),
      hasGraph: vi.fn().mockResolvedValue(true),
      createGraph: vi.fn(),
      dropGraph: vi.fn(),
      query: vi.fn().mockImplementation((sparql: string) => {
        const entityMatch = sparql.match(/FILTER\(\?s = <([^>]+)>/);
        if (entityMatch) {
          const entity = entityMatch[1];
          const genidPrefix = `${entity}/.well-known/genid/`;
          const filtered = publishQuads.filter(q =>
            q.subject === entity || q.subject.startsWith(genidPrefix),
          );
          return Promise.resolve({ type: 'quads' as const, quads: filtered });
        }
        return Promise.resolve({ type: 'quads' as const, quads: publishQuads });
      }),
      close: vi.fn(),
    };

    // Create 3 StorageACK handlers (one per core node)
    const handlers = coreWallets.map((wallet, idx) => {
      const config: StorageACKHandlerConfig = {
        nodeRole: 'core',
        nodeIdentityId: BigInt(idx + 1),
        signerWallet: wallet,
        contextGraphSharedMemoryUri: (cgId: string) =>
          `did:dkg:context-graph:${cgId}/_shared_memory`,
      };
      const eventBus = {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
      };
      return new StorageACKHandler(mockStore as any, config, eventBus as any);
    });

    // Create ACKCollector that calls handlers directly (simulating P2P)
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn().mockResolvedValue(undefined),
      sendP2P: async (peerId, _protocol, data) => {
        const idx = parseInt(peerId.replace('core-', ''), 10);
        const handler = handlers[idx];
        const fakePeerId = { toString: () => peerId };
        return handler.handler(data, fakePeerId);
      },
      getConnectedCorePeers: () => ['core-0', 'core-1', 'core-2'],
      log: vi.fn(),
    };

    const collector = new ACKCollector(deps);
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: cgIdBigInt,
      contextGraphIdStr: contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: BigInt(publishQuads.length * 100),
      isPrivate: false,
      kaCount: 1,
      rootEntities,
    });

    expect(result.acks).toHaveLength(3);

    // Verify each collected ACK can be recovered to the core node's address
    const digest = computeACKDigest(cgIdBigInt, merkleRoot, 1, BigInt(publishQuads.length * 100));
    const prefixedHash = ethers.hashMessage(digest);

    for (let i = 0; i < 3; i++) {
      const ack = result.acks[i];
      const recovered = ethers.recoverAddress(prefixedHash, {
        r: ethers.hexlify(ack.signatureR),
        yParityAndS: ethers.hexlify(ack.signatureVS),
      });
      // The recovered address should match one of the core wallets
      const coreAddresses = coreWallets.map(w => w.address.toLowerCase());
      expect(coreAddresses).toContain(recovered.toLowerCase());
    }
  });

  it('V10 merkle root is deterministic across all nodes', () => {
    const root1 = computeFlatKCRootV10(publishQuads, []);
    const root2 = computeFlatKCRootV10(publishQuads, []);

    // Same quads in same order → same root
    expect(Buffer.from(root1).equals(Buffer.from(root2))).toBe(true);

    // Different quad order → still same root (V10MerkleTree sorts internally)
    const reversed = [...publishQuads].reverse();
    const root3 = computeFlatKCRootV10(reversed, []);
    expect(Buffer.from(root1).equals(Buffer.from(root3))).toBe(true);
  });

  it('V10 merkle root differs from V9 SHA-256 root', async () => {
    // Import V9 functions
    const { computeFlatKCRoot } = await import('../src/merkle.js');

    const v9Root = computeFlatKCRoot(publishQuads, []);
    const v10Root = computeFlatKCRootV10(publishQuads, []);

    // V9 uses SHA-256, V10 uses keccak256 — roots MUST differ
    expect(Buffer.from(v9Root).equals(Buffer.from(v10Root))).toBe(false);
    expect(v9Root.length).toBe(32);
    expect(v10Root.length).toBe(32);
  });

  it('PublishIntent encodes and decodes correctly', () => {
    const merkleRoot = computeFlatKCRootV10(publishQuads, []);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'Qm_publisher_123',
      publicByteSize: 1024,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:experiment:wsd'],
    });

    const decoded = decodePublishIntent(intent);
    expect(decoded.contextGraphId).toBe(contextGraphId);
    expect(decoded.publisherPeerId).toBe('Qm_publisher_123');
    expect(decoded.isPrivate).toBe(false);
    expect(decoded.kaCount).toBe(1);
    expect(decoded.rootEntities).toEqual(['urn:experiment:wsd']);

    const decodedRoot = decoded.merkleRoot instanceof Uint8Array
      ? decoded.merkleRoot
      : new Uint8Array(decoded.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(merkleRoot))).toBe(true);
  });

  it('StorageACK encodes and decodes correctly', async () => {
    const merkleRoot = computeFlatKCRootV10(publishQuads, []);
    const wallet = coreWallets[0];
    const digest = computeACKDigest(cgIdBigInt, merkleRoot);
    const sig = ethers.Signature.from(await wallet.signMessage(digest));

    const encoded = encodeStorageACK({
      merkleRoot,
      coreNodeSignatureR: ethers.getBytes(sig.r),
      coreNodeSignatureVS: ethers.getBytes(sig.yParityAndS),
      contextGraphId,
      nodeIdentityId: 1,
    });

    const decoded = decodeStorageACK(encoded);
    expect(decoded.contextGraphId).toBe(contextGraphId);

    const decodedRoot = decoded.merkleRoot instanceof Uint8Array
      ? decoded.merkleRoot
      : new Uint8Array(decoded.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(merkleRoot))).toBe(true);

    const decodedR = decoded.coreNodeSignatureR instanceof Uint8Array
      ? decoded.coreNodeSignatureR
      : new Uint8Array(decoded.coreNodeSignatureR);
    expect(decodedR.length).toBe(32);
  });

  it('V10 mock adapter round-trip: ACK collection → createKnowledgeAssetsV10', async () => {
    const { MockChainAdapter } = await import('@origintrail-official/dkg-chain');
    const adapter = new MockChainAdapter('mock:31337');
    adapter.minimumRequiredSignatures = 3;

    const merkleRoot = computeFlatKCRootV10(publishQuads, []);

    const ackSignatures = await Promise.all(
      coreWallets.map(async (wallet, idx) => {
        const digest = computeACKDigest(cgIdBigInt, merkleRoot);
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        return {
          identityId: BigInt(idx + 1),
          r: ethers.getBytes(sig.r),
          vs: ethers.getBytes(sig.yParityAndS),
        };
      }),
    );

    expect(ackSignatures).toHaveLength(3);

    const pubSig = ethers.Signature.from(
      await publisherWallet.signMessage(
        ethers.getBytes(ethers.solidityPackedKeccak256(
          ['uint72', 'bytes32'],
          [1, ethers.hexlify(merkleRoot)],
        )),
      ),
    );

    const result = await adapter.createKnowledgeAssetsV10!({
      publishOperationId: 'v10-e2e-test',
      contextGraphId: cgIdBigInt,
      merkleRoot,
      knowledgeAssetsAmount: publishQuads.length,
      byteSize: BigInt(publishQuads.length * 100),
      epochs: 2,
      tokenAmount: 50n,
      isImmutable: false,
      paymaster: ethers.ZeroAddress,
      convictionAccountId: 0n,
      publisherNodeIdentityId: 1n,
      publisherSignature: {
        r: ethers.getBytes(pubSig.r),
        vs: ethers.getBytes(pubSig.yParityAndS),
      },
      ackSignatures,
    });

    expect(result.batchId).toBeGreaterThan(0n);
    expect(result.txHash).toBeDefined();
    expect(result.tokenAmount).toBe(50n);
    expect(result.publisherAddress).toBeDefined();
  });
});
