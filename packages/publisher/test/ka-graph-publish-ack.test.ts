import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  PROTOCOL_STORAGE_ACK_V2,
  TypedEventBus,
  computeCatalogRoot,
  contextGraphCatalogUri,
  createGraphKnowledgeAssetScope,
  decodePublishIntent,
  encodePublishIntent,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
} from '../src/storage-ack-handler.js';
import { resolveKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import {
  computeFlatKCMerkleLeafCountV10,
  computeFlatKCRootV10,
} from '../src/merkle.js';

const CONTEXT_GRAPH_ID = '42';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const SCOPE = createGraphKnowledgeAssetScope(UAL, 1);
const SWM_GRAPH = knowledgeAssetLayerGraphUri(
  CONTEXT_GRAPH_ID,
  MemoryLayer.SharedWorkingMemory,
  SCOPE,
);
const KAV10 = '0x000000000000000000000000000000000000c10a';
const PRIVATE_ROOT = ethers.getBytes(
  ethers.keccak256(ethers.toUtf8Bytes('rootless-private-publish')),
);
const PEER = { toString: () => 'publisher-peer' };

function handlerConfig(wallet: ethers.Wallet, curated: boolean): StorageACKHandlerConfig {
  return {
    nodeRole: 'core',
    nodeIdentityId: 17n,
    signerWallet: wallet,
    contextGraphSharedMemoryUri: (cgId: string) =>
      `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: 31337n,
    kav10Address: KAV10,
    isCgCurated: async () => curated,
  };
}

function byteSizeFloor(quads: readonly Pick<Quad, 'subject' | 'predicate' | 'object'>[]): number {
  return quads.reduce(
    (sum, quad) => sum
      + Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8'),
    0,
  );
}

describe('graph-scoped publish storage ACKs', () => {
  it.each([
    {
      label: 'content without triples',
      envelope: { publicTripleCount: 0, privateTripleCount: 0, accessPolicy: 'public' as const, allowedPeers: [] },
      error: 'invalid content envelope',
    },
    {
      label: 'content with an undeclared private root',
      envelope: {
        publicTripleCount: 1,
        privateTripleCount: 0,
        privateMerkleRoot: PRIVATE_ROOT,
        accessPolicy: 'public' as const,
        allowedPeers: [],
      },
      error: 'invalid content envelope',
    },
    {
      label: 'access',
      envelope: {
        publicTripleCount: 1,
        privateTripleCount: 0,
        accessPolicy: 'public' as const,
        allowedPeers: ['12D3KooWReader'],
      },
      error: 'invalid access envelope',
    },
  ])('rejects a malformed graph-scoped $label envelope before persistence or signing', async ({ envelope, error }) => {
    const store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    const signMessage = vi.spyOn(wallet, 'signMessage');
    const handler = new StorageACKHandler(
      store,
      handlerConfig(wallet, false),
      new TypedEventBus(),
    );
    const intent = encodePublishIntent({
      merkleRoot: new Uint8Array(32),
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: 'publisher-peer',
      publicByteSize: 1,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      merkleLeafCount: 1,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '1',
      ...envelope,
    });

    await expect(handler.handler(intent, PEER)).rejects.toThrow(error);
    expect(signMessage).not.toHaveBeenCalled();
    expect(await store.countQuads(SWM_GRAPH)).toBe(0);
    expect(await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
    })).toBeUndefined();
  });

  it('keeps identical-content KAs in distinct durable workspace operations', async () => {
    const store = new OxigraphStore();
    const handler = new StorageACKHandler(
      store,
      handlerConfig(ethers.Wallet.createRandom(), false),
      new TypedEventBus(),
    );
    const secondUal = `did:dkg:otp:20430/${AUTHOR}/8`;

    for (const ual of [UAL, secondUal]) {
      const scope = createGraphKnowledgeAssetScope(ual, 1);
      const swmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH_ID,
        MemoryLayer.SharedWorkingMemory,
        scope,
      );
      const quads: Quad[] = [{
        subject: 'urn:asset:same',
        predicate: 'urn:p:value',
        object: '"same"',
        graph: swmGraph,
      }];
      await store.insert(quads);
      const merkleRoot = computeFlatKCRootV10(quads, []);
      const deps: ACKCollectorDeps = {
        gossipPublish: async () => {},
        sendP2P: async (_peerId, _protocol, data) => handler.handler(data, PEER),
        getConnectedCorePeers: () => ['core-1'],
        verifyIdentity: async () => true,
        log: () => {},
      };
      const result = await new ACKCollector(deps).collect({
        merkleRoot,
        contextGraphId: BigInt(CONTEXT_GRAPH_ID),
        contextGraphIdStr: CONTEXT_GRAPH_ID,
        publisherPeerId: 'publisher-peer',
        publicByteSize: BigInt(byteSizeFloor(quads)),
        isPrivate: false,
        kaCount: 1,
        rootEntities: [],
        chainId: 31337n,
        kav10Address: KAV10,
        requiredACKs: 1,
        merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: ual,
        assertionVersion: '1',
        publicTripleCount: quads.length,
        privateTripleCount: 0,
        accessPolicy: 'public',
        allowedPeers: [],
        ackMode: { kind: 'public' },
      });
      expect(result.acks).toHaveLength(1);
    }

    const graphManager = new GraphManager(store);
    const firstHead = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
    });
    const secondHead = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: secondUal,
    });
    expect(firstHead?.kaUal).toBe(UAL);
    expect(secondHead?.kaUal).toBe(secondUal);
    expect(firstHead?.shareOperationId).not.toBe(secondHead?.shareOperationId);
  });

  it('collects over V2 from only the exact per-KA SWM graph', async () => {
    const store = new OxigraphStore();
    const quads: Quad[] = [
      { subject: 'urn:asset:a', predicate: 'urn:p:value', object: '"a"', graph: SWM_GRAPH },
      { subject: 'urn:asset:b', predicate: 'urn:p:value', object: '"b"', graph: SWM_GRAPH },
    ];
    await store.insert([
      ...quads,
      {
        subject: 'urn:legacy:poison',
        predicate: 'urn:p:value',
        object: '"wrong"',
        graph: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}/_shared_memory`,
      },
    ]);
    const handler = new StorageACKHandler(
      store,
      handlerConfig(ethers.Wallet.createRandom(), false),
      new TypedEventBus(),
    );
    const merkleRoot = computeFlatKCRootV10(quads, []);
    let capturedIntent: ReturnType<typeof decodePublishIntent> | undefined;
    let capturedProtocol: string | undefined;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (_peerId, protocol, data) => {
        capturedProtocol = protocol;
        capturedIntent = decodePublishIntent(data);
        return handler.handler(data, PEER);
      },
      getConnectedCorePeers: () => ['core-1'],
      verifyIdentity: async () => true,
      log: () => {},
    };

    const result = await new ACKCollector(deps).collect({
      merkleRoot,
      contextGraphId: BigInt(CONTEXT_GRAPH_ID),
      contextGraphIdStr: CONTEXT_GRAPH_ID,
      publisherPeerId: 'publisher-peer',
      publicByteSize: BigInt(Math.max(1, byteSizeFloor(quads))),
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      chainId: 31337n,
      kav10Address: KAV10,
      requiredACKs: 1,
      merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '1',
      publicTripleCount: quads.length,
      privateTripleCount: 0,
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWReader'],
      ackMode: { kind: 'public' },
    });

    expect(result.acks).toHaveLength(1);
    expect(capturedProtocol).toBe(PROTOCOL_STORAGE_ACK_V2);
    expect(capturedIntent?.rootEntities).toEqual([]);
    expect(capturedIntent?.privateMerkleRoots).toEqual([]);
    expect(capturedIntent?.kaUal).toBe(UAL);
    expect(capturedIntent?.publicTripleCount).toBe(quads.length);
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: CONTEXT_GRAPH_ID,
      kaUal: UAL,
    });
    expect(head).toMatchObject({
      kaUal: UAL,
      assertionVersion: '1',
      assertionGraph: SWM_GRAPH,
      publicTripleCount: quads.length,
      privateTripleCount: 0,
      publisherPeerId: 'publisher-peer',
      accessPolicy: 'allowList',
      allowedPeers: ['12D3KooWReader'],
    });
  });

  it('collects a curated publish with one KA-level private commitment and no root manifest', async () => {
    const store = new OxigraphStore();
    const handler = new StorageACKHandler(
      store,
      handlerConfig(ethers.Wallet.createRandom(), true),
      new TypedEventBus(),
    );
    const catalogTriples = [{
      subject: `did:dkg:context-graph:${CONTEXT_GRAPH_ID}`,
      predicate: 'http://purl.org/dc/terms/identifier',
      object: `"did:dkg:context-graph:${CONTEXT_GRAPH_ID}"`,
    }];
    const catalog = computeCatalogRoot(catalogTriples);
    const stagingQuads = new TextEncoder().encode(
      catalogTriples.map((quad) =>
        `<${quad.subject}> <${quad.predicate}> ${quad.object} .`,
      ).join('\n'),
    );
    const publicQuads: Quad[] = catalogTriples.map((quad) => ({
      ...quad,
      graph: SWM_GRAPH,
    }));
    const merkleRoot = computeFlatKCRootV10(publicQuads, [PRIVATE_ROOT]);
    let capturedIntent: ReturnType<typeof decodePublishIntent> | undefined;
    const deps: ACKCollectorDeps = {
      gossipPublish: async () => {},
      sendP2P: async (_peerId, protocol, data) => {
        expect(protocol).toBe(PROTOCOL_STORAGE_ACK_V2);
        capturedIntent = decodePublishIntent(data);
        return handler.handler(data, PEER);
      },
      getConnectedCorePeers: () => ['core-1'],
      verifyIdentity: async () => true,
      log: () => {},
    };

    const result = await new ACKCollector(deps).collect({
      merkleRoot,
      contextGraphId: BigInt(CONTEXT_GRAPH_ID),
      contextGraphIdStr: CONTEXT_GRAPH_ID,
      publisherPeerId: 'publisher-peer',
      publicByteSize: BigInt(stagingQuads.length),
      isPrivate: true,
      kaCount: 1,
      rootEntities: [],
      chainId: 31337n,
      kav10Address: KAV10,
      requiredACKs: 1,
      stagingQuads,
      merkleLeafCount: computeFlatKCMerkleLeafCountV10(publicQuads, [PRIVATE_ROOT]),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '1',
      publicTripleCount: publicQuads.length,
      privateMerkleRoot: PRIVATE_ROOT,
      privateTripleCount: 9,
      accessPolicy: 'ownerOnly',
      allowedPeers: [],
      ackMode: {
        kind: 'curated-catalog',
        catalogCommitment: {
          catalogRoot: catalog.root,
          catalogLeafCount: catalog.leafCount,
        },
      },
    });

    expect(result.acks).toHaveLength(1);
    expect(capturedIntent?.rootEntities).toEqual([]);
    expect(capturedIntent?.privateMerkleRoots).toEqual([]);
    expect(ethers.hexlify(capturedIntent!.privateMerkleRoot!)).toBe(
      ethers.hexlify(PRIVATE_ROOT),
    );
    expect(await store.countQuads(contextGraphCatalogUri(CONTEXT_GRAPH_ID))).toBe(
      publicQuads.length,
    );
    // A storage core that is not a curated-CG member must retain only the
    // independently verified public catalog. The protected assertion reaches
    // members through encrypted gossip/sync and must never be mislabeled as a
    // complete exact SWM graph on this core.
    expect(await store.countQuads(SWM_GRAPH)).toBe(0);
  });
});
