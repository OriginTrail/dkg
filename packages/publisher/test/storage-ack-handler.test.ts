import { describe, it, expect } from 'vitest';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { computeFlatKCRootV10 as computeFlatKCRoot } from '../src/merkle.js';
import {
  encodePublishIntent, decodeStorageACK, computeACKDigest,
} from '@origintrail-official/dkg-core';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('StorageACKHandler', () => {
  const contextGraphId = 'test-project';
  const cgIdBigInt = 0n;

  const swmQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
    makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
    makeQuad('urn:entity:2', 'urn:p', 'urn:o3'),
  ];
  const merkleRoot = computeFlatKCRoot(swmQuads, []);

  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 42n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  async function createHandler(storeQuads: Quad[]) {
    const store = new OxigraphStore();

    const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
    if (storeQuads.length > 0) {
      await store.insert(
        storeQuads.map(q => ({ ...q, graph: swmGraph })),
      );
    }

    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
    };

    return new StorageACKHandler(store as any, config, new TypedEventBus() as any);
  }

  it('returns valid StorageACK for matching data', async () => {
    const handler = await createHandler(swmQuads);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(contextGraphId);

    const decodedRoot = ack.merkleRoot instanceof Uint8Array
      ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(merkleRoot))).toBe(true);

    const digest = computeACKDigest(cgIdBigInt, merkleRoot, 2, 300n, 1, 1000n);
    const prefixedHash = ethers.hashMessage(digest);
    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array
        ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array
        ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
  });

  it('rejects when SWM has no data', async () => {
    const handler = await createHandler([]);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1'],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('No data found in SWM');
  });

  it('rejects when merkle root does not match', async () => {
    const differentQuads = [makeQuad('urn:other', 'urn:p', 'urn:val')];
    const handler = await createHandler(differentQuads);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Merkle root mismatch');
  });

  it('rejects non-core node role', async () => {
    const store = new OxigraphStore();
    const config: StorageACKHandlerConfig = {
      nodeRole: 'edge',
      nodeIdentityId: 1n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: () => 'urn:test',
    };

    const handler = new StorageACKHandler(store as any, config, new TypedEventBus() as any);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Only core nodes can issue StorageACKs');
  });
});
