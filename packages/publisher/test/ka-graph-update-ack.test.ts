import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  computeCatalogRoot,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  encodeUpdateIntent,
  isStorageACKDecline,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
} from '../src/storage-ack-handler.js';
import {
  computeFlatKCMerkleLeafCountV10,
  computeFlatKCRootV10,
} from '../src/merkle.js';

const TARGET_CG_ID = '42';
const SOURCE_CG_ID = 'private-rootless-cg';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const SCOPE = createGraphKnowledgeAssetScope(UAL, 2);
const EXACT_SWM_GRAPH = knowledgeAssetLayerGraphUri(
  SOURCE_CG_ID,
  MemoryLayer.SharedWorkingMemory,
  SCOPE,
);
const LEGACY_SWM_GRAPH = `did:dkg:context-graph:${SOURCE_CG_ID}/_shared_memory`;
const PRIVATE_ROOT = ethers.getBytes(
  ethers.keccak256(ethers.toUtf8Bytes('rootless-private-update')),
);
const PEER = { toString: () => 'publisher-peer' };

function config(wallet: ethers.Wallet, curated = false): StorageACKHandlerConfig {
  return {
    nodeRole: 'core',
    nodeIdentityId: 17n,
    signerWallet: wallet,
    contextGraphSharedMemoryUri: (cgId: string) =>
      `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: 31337n,
    kav10Address: '0x000000000000000000000000000000000000c10a',
    isCgCurated: async () => curated,
  };
}

function byteSizeFloor(quads: readonly Quad[]): number {
  return quads.reduce(
    (sum, quad) => sum
      + Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8'),
    0,
  );
}

function wireNquads(quads: readonly Quad[]): Uint8Array {
  return new TextEncoder().encode(quads.map((quad) =>
    `<${quad.subject}> <${quad.predicate}> ${quad.object.startsWith('"') ? quad.object : `<${quad.object}>`} <${quad.graph}> .`,
  ).join('\n'));
}

function intent(
  publicQuads: readonly Quad[],
  privateTripleCount: number,
  overrides: Record<string, unknown> = {},
): Uint8Array {
  const privateRoots = privateTripleCount > 0 ? [PRIVATE_ROOT] : [];
  return encodeUpdateIntent({
    kaId: KA_ID.toString(),
    contextGraphId: TARGET_CG_ID,
    swmGraphId: SOURCE_CG_ID,
    preUpdateMerkleRootCount: 1,
    newMerkleRoot: computeFlatKCRootV10([...publicQuads], privateRoots),
    newByteSize: Math.max(1, byteSizeFloor(publicQuads)),
    newTokenAmount: '1000',
    mintAmount: 0,
    burnTokenIds: [],
    newMerkleLeafCount: computeFlatKCMerkleLeafCountV10(
      [...publicQuads],
      privateRoots,
    ),
    publisherPeerId: 'publisher-peer',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: '2',
    publicTripleCount: publicQuads.length,
    ...(privateTripleCount > 0 ? { privateMerkleRoot: PRIVATE_ROOT } : {}),
    privateTripleCount,
    ...overrides,
  });
}

describe('StorageACKHandler graph-scoped updates', () => {
  it('verifies a public-plus-private update from only its exact per-KA SWM graph', async () => {
    const store = new OxigraphStore();
    const quads: Quad[] = [
      { subject: 'urn:entity:a', predicate: 'urn:p:value', object: '"a"', graph: EXACT_SWM_GRAPH },
      { subject: 'urn:entity:b', predicate: 'urn:p:value', object: '"b"', graph: EXACT_SWM_GRAPH },
    ];
    await store.insert([
      ...quads,
      // Deliberately poison the legacy shared bucket. A fallback to it would
      // change both the triple count and Merkle root and therefore decline.
      { subject: 'urn:legacy', predicate: 'urn:p:value', object: '"wrong"', graph: LEGACY_SWM_GRAPH },
    ]);
    const handler = new StorageACKHandler(
      store,
      config(ethers.Wallet.createRandom()),
      new TypedEventBus(),
    );

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 3), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ethers.hexlify(ack.merkleRoot)).toBe(
      ethers.hexlify(computeFlatKCRootV10(quads, [PRIVATE_ROOT])),
    );
  });

  it('collects an ACK for a fully private curated update without a public placeholder', async () => {
    const store = new OxigraphStore();
    // The legacy bucket must not become an accidental public placeholder.
    await store.insert([{
      subject: 'urn:legacy',
      predicate: 'urn:p:value',
      object: '"wrong"',
      graph: LEGACY_SWM_GRAPH,
    }]);
    const handler = new StorageACKHandler(
      store,
      config(ethers.Wallet.createRandom(), true),
      new TypedEventBus(),
    );
    const catalogTriples = [{
      subject: `did:dkg:context-graph:${TARGET_CG_ID}`,
      predicate: 'http://purl.org/dc/terms/identifier',
      object: `"did:dkg:context-graph:${TARGET_CG_ID}"`,
    }];
    const catalogCommitment = computeCatalogRoot(catalogTriples);
    const catalogNquads = new TextEncoder().encode(
      catalogTriples.map((quad) =>
        `<${quad.subject}> <${quad.predicate}> ${quad.object} .`,
      ).join('\n'),
    );
    const root = computeFlatKCRootV10([], [PRIVATE_ROOT]);
    const selectedProtocols: string[] = [];
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (_peerId, protocol, data) => {
        selectedProtocols.push(protocol);
        return handler.updateHandler(data, PEER);
      },
      getConnectedCorePeers: (protocol) => {
        selectedProtocols.push(protocol ?? '');
        return ['core-1'];
      },
      verifyIdentity: async () => true,
      log: () => {},
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collectUpdate({
      kaId: KA_ID,
      contextGraphId: BigInt(TARGET_CG_ID),
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: root,
      newByteSize: BigInt(catalogNquads.length),
      newTokenAmount: 1000n,
      mintAmount: 0n,
      burnTokenIds: [],
      newMerkleLeafCount: 0,
      newCatalogRoot: catalogCommitment.root,
      newCatalogLeafCount: catalogCommitment.leafCount,
      chainId: 31337n,
      kav10Address: '0x000000000000000000000000000000000000c10a',
      publisherPeerId: 'publisher-peer',
      requiredACKs: 1,
      swmGraphId: SOURCE_CG_ID,
      stagingQuads: catalogNquads,
      isEncryptedPayload: true,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: 0,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 9,
    });

    expect(result.acks).toHaveLength(1);
    expect(ethers.hexlify(result.merkleRoot)).toBe(ethers.hexlify(root));
    expect(selectedProtocols).toEqual([
      PROTOCOL_STORAGE_UPDATE_ACK_V2,
      PROTOCOL_STORAGE_UPDATE_ACK_V2,
    ]);
  });

  it('does not discover graph-scoped update data from the legacy shared bucket', async () => {
    const store = new OxigraphStore();
    const content: Quad[] = [{
      subject: 'urn:entity:a',
      predicate: 'urn:p:value',
      object: '"a"',
      graph: LEGACY_SWM_GRAPH,
    }];
    await store.insert(content);
    const handler = new StorageACKHandler(
      store,
      config(ethers.Wallet.createRandom()),
      new TypedEventBus(),
    );

    const ack = decodeStorageACK(await handler.updateHandler(intent(content, 0), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(ack.declineMessage).toContain('public triple count mismatch');
  });

  it('rejects an assertion version that is not pre-update count plus one', async () => {
    const handler = new StorageACKHandler(
      new OxigraphStore(),
      config(ethers.Wallet.createRandom()),
      new TypedEventBus(),
    );

    await expect(handler.updateHandler(intent([], 1, {
      assertionVersion: '3',
    }), PEER)).rejects.toThrow('must equal preUpdateMerkleRootCount + 1');
  });

  it('rejects a non-canonical sub-graph before deriving an SWM graph URI', async () => {
    const handler = new StorageACKHandler(
      new OxigraphStore(),
      config(ethers.Wallet.createRandom()),
      new TypedEventBus(),
    );

    await expect(handler.updateHandler(intent([], 1, {
      subGraphName: 'nested/graph',
    }), PEER)).rejects.toThrow('invalid graph-scoped subGraphName');
  });

  it('declines a graph update whose signed leaf count was not recomputed', async () => {
    const store = new OxigraphStore();
    const quads: Quad[] = [{
      subject: 'urn:entity:a', predicate: 'urn:p:value', object: '"a"', graph: EXACT_SWM_GRAPH,
    }];
    await store.insert(quads);
    const handler = new StorageACKHandler(
      store,
      config(ethers.Wallet.createRandom()),
      new TypedEventBus(),
    );

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 0, {
      newMerkleLeafCount: 999,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineMessage).toContain('newMerkleLeafCount mismatch');
  });

  it('keeps a legacy sub-graph update on the legacy handler', async () => {
    const quad: Quad = {
      subject: 'urn:legacy:entity',
      predicate: 'urn:p:value',
      object: '"legacy"',
      graph: `did:dkg:context-graph:${SOURCE_CG_ID}/sub/_shared_memory`,
    };
    const stagingQuads = wireNquads([quad]);
    const handler = new StorageACKHandler(
      new OxigraphStore(),
      config(ethers.Wallet.createRandom()),
      new TypedEventBus(),
    );
    const encoded = encodeUpdateIntent({
      kaId: KA_ID.toString(),
      contextGraphId: TARGET_CG_ID,
      swmGraphId: SOURCE_CG_ID,
      subGraphName: 'sub',
      preUpdateMerkleRootCount: 1,
      newMerkleRoot: computeFlatKCRootV10([quad], []),
      newByteSize: stagingQuads.length,
      newTokenAmount: '1000',
      mintAmount: 0,
      burnTokenIds: [],
      newMerkleLeafCount: computeFlatKCMerkleLeafCountV10([quad], []),
      publisherPeerId: 'publisher-peer',
      stagingQuads,
    });

    const ack = decodeStorageACK(await handler.updateHandler(encoded, PEER));
    expect(isStorageACKDecline(ack)).toBe(false);
  });

  it('declines reserved skolem terms received over the graph-scoped ACK protocol', async () => {
    const malicious: Quad[] = [{
      subject: 'urn:dkg:ka-skolem:c14n0',
      predicate: 'urn:p:value',
      object: '"attacker-authored"',
      graph: EXACT_SWM_GRAPH,
    }];
    const handler = new StorageACKHandler(
      new OxigraphStore(),
      config(ethers.Wallet.createRandom()),
      new TypedEventBus(),
    );

    const ack = decodeStorageACK(await handler.updateHandler(intent(malicious, 0, {
      stagingQuads: wireNquads(malicious),
      newByteSize: wireNquads(malicious).length,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineMessage).toContain('reserved KA skolem namespace');
  });
});
