import { describe, it, expect, vi } from 'vitest';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { computeFlatKCRootV10 as computeFlatKCRoot } from '../src/merkle.js';
import {
  encodePublishIntent, decodeStorageACK, computePublishACKDigest,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

// Test H5 prefix inputs — must match whatever `StorageACKHandlerConfig`
// carries so that the ACK digest the test computes equals the one the
// handler computes. The handler rejects non-numeric / zero CG ids
// (production guard), so the test CG id is a plain numeric string.
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn() };
}

describe('StorageACKHandler', () => {
  const contextGraphId = '42';
  const cgIdBigInt = 42n;

  const swmQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
    makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
    makeQuad('urn:entity:2', 'urn:p', 'urn:o3'),
  ];
  const merkleRoot = computeFlatKCRoot(swmQuads, []);

  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 42n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  function createHandler(storeQuads: Quad[]) {
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
          const filtered = storeQuads.filter(q =>
            q.subject === entity || q.subject.startsWith(genidPrefix),
          );
          return Promise.resolve({ type: 'quads' as const, quads: filtered });
        }
        return Promise.resolve({ type: 'quads' as const, quads: storeQuads });
      }),
      close: vi.fn(),
    };

    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };

    return new StorageACKHandler(mockStore as any, config, makeEventBus() as any);
  }

  it('returns valid StorageACK for matching data', async () => {
    const handler = createHandler(swmQuads);
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

    // Verify signature recovers to core wallet address. The handler builds
    // this exact shape in storage-ack-handler.ts via computePublishACKDigest,
    // and the test oracle must match byte-for-byte.
    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      merkleRoot,
      2n,
      300n,
      1n,
      1000n,
    );
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
    const handler = createHandler([]);
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
    const handler = createHandler(differentQuads);

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
    const mockStore = {
      query: vi.fn(),
    };
    const config: StorageACKHandlerConfig = {
      nodeRole: 'edge',
      nodeIdentityId: 1n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: () => 'urn:test',
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };

    const handler = new StorageACKHandler(mockStore as any, config, makeEventBus() as any);
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
