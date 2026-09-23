import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
  computeCatalogRoot,
  contextGraphCatalogUri,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  encodePublishIntent,
  encodeUpdateIntent,
  isStorageACKDecline,
  isTransientStorageACKDeclineCode,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
  type StorageAckVmPromotionRequest,
  type StorageAckVmPromotionVerdict,
} from '../src/storage-ack-handler.js';
import { resolveKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { computeFlatKCMerkleLeafCountV10, computeFlatKCRootV10 } from '../src/merkle.js';

const CG_ID = '42';
const SWM_GRAPH_ID = 'public-source-cg';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const PEER = { toString: () => 'publisher-peer' };

function swmGraph(version: number): string {
  return knowledgeAssetLayerGraphUri(
    SWM_GRAPH_ID,
    MemoryLayer.SharedWorkingMemory,
    createGraphKnowledgeAssetScope(UAL, version),
  );
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

function handlerWithGate(
  store: OxigraphStore,
  gate: StorageACKHandlerConfig['ensureVmPromotion'],
  options: { curated?: boolean; wallet?: ethers.Wallet } = {},
) {
  const wallet = options.wallet ?? ethers.Wallet.createRandom();
  const signMessage = vi.spyOn(wallet, 'signMessage');
  const handler = new StorageACKHandler(store, {
    nodeRole: 'core',
    nodeIdentityId: 17n,
    signerWallet: wallet,
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: 31337n,
    kav10Address: '0x000000000000000000000000000000000000c10a',
    isCgCurated: async () => options.curated === true,
    ensureVmPromotion: gate,
  }, new TypedEventBus());
  return { handler, signMessage };
}

function publicPublishIntent(quads: readonly Quad[]): Uint8Array {
  return encodePublishIntent({
    merkleRoot: computeFlatKCRootV10([...quads], []),
    contextGraphId: CG_ID,
    swmGraphId: SWM_GRAPH_ID,
    publisherPeerId: 'publisher-peer',
    publicByteSize: byteSizeFloor(quads),
    isPrivate: false,
    kaCount: 1,
    rootEntities: [],
    merkleLeafCount: computeFlatKCMerkleLeafCountV10([...quads], []),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: '1',
    publicTripleCount: quads.length,
    privateTripleCount: 0,
    accessPolicy: 'public',
    allowedPeers: [],
  });
}

function publicUpdateIntent(quads: readonly Quad[]): Uint8Array {
  return encodeUpdateIntent({
    kaId: KA_ID.toString(),
    contextGraphId: CG_ID,
    swmGraphId: SWM_GRAPH_ID,
    preUpdateMerkleRootCount: 1,
    newMerkleRoot: computeFlatKCRootV10([...quads], []),
    newByteSize: byteSizeFloor(quads),
    newTokenAmount: '1000',
    mintAmount: 0,
    burnTokenIds: [],
    newMerkleLeafCount: computeFlatKCMerkleLeafCountV10([...quads], []),
    publisherPeerId: 'publisher-peer',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: '2',
    publicTripleCount: quads.length,
    privateTripleCount: 0,
  });
}

async function seededPublishStore(): Promise<{ store: OxigraphStore; quads: Quad[] }> {
  const store = new OxigraphStore();
  const quads: Quad[] = [{
    subject: 'urn:asset:gated',
    predicate: 'urn:p:value',
    object: '"gated"',
    graph: swmGraph(1),
  }];
  await store.insert(quads);
  return { store, quads };
}

describe('StorageACK VM-promotion finality gate', () => {
  it('signs a public publish only after the data, its head and the gate are in place', async () => {
    const { store, quads } = await seededPublishStore();
    const requests: StorageAckVmPromotionRequest[] = [];
    let headAtGate: unknown;
    const { handler, signMessage } = handlerWithGate(store, async (request) => {
      requests.push(request);
      // The gate runs after the ACK's durable workspace head is written.
      headAtGate = await resolveKnowledgeAssetWorkspaceHead({
        store,
        graphManager: new GraphManager(store),
        contextGraphId: SWM_GRAPH_ID,
        kaUal: UAL,
      });
      expect(signMessage).not.toHaveBeenCalled();
      return { ok: true };
    });

    const ack = decodeStorageACK(await handler.handler(publicPublishIntent(quads), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(signMessage).toHaveBeenCalledOnce();
    expect(requests).toEqual([
      expect.objectContaining({ contextGraphId: CG_ID, swmGraphId: SWM_GRAPH_ID, operation: 'publish' }),
    ]);
    expect(headAtGate).toMatchObject({ kaUal: UAL });
  });

  it.each([
    {
      label: 'transient',
      verdict: {
        ok: false,
        code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
        message: 'VM reconciliation is not running on this core yet',
      },
      transient: true,
    },
    {
      label: 'permanent',
      verdict: {
        ok: false,
        code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
        message: 'VM reconciliation is disabled on this core',
      },
      transient: false,
    },
  ] as const)('declines a public publish with the gate\'s $label verdict and never signs', async ({
    verdict,
    transient,
  }) => {
    const { store, quads } = await seededPublishStore();
    const { handler, signMessage } = handlerWithGate(
      store,
      async () => verdict as StorageAckVmPromotionVerdict,
    );

    const ack = decodeStorageACK(await handler.handler(publicPublishIntent(quads), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(verdict.code);
    expect(ack.declineMessage).toBe(verdict.message);
    expect(isTransientStorageACKDeclineCode(ack.declineCode)).toBe(transient);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('treats a throwing gate as a transient refusal, not a signature', async () => {
    const { store, quads } = await seededPublishStore();
    const { handler, signMessage } = handlerWithGate(store, async () => {
      throw new Error('subscription store unavailable');
    });

    const ack = decodeStorageACK(await handler.handler(publicPublishIntent(quads), PEER));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE);
    // The local error text stays off the wire.
    expect(ack.declineMessage).not.toContain('subscription store');
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('gates a public update the same way and reports the update operation', async () => {
    const store = new OxigraphStore();
    const quads: Quad[] = [{
      subject: 'urn:asset:gated',
      predicate: 'urn:p:value',
      object: '"v2"',
      graph: swmGraph(2),
    }];
    await store.insert(quads);
    const requests: StorageAckVmPromotionRequest[] = [];
    const { handler, signMessage } = handlerWithGate(store, async (request) => {
      requests.push(request);
      return {
        ok: false,
        code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
        message: 'VM reconciliation is disabled on this core',
      };
    });

    const ack = decodeStorageACK(await handler.updateHandler(publicUpdateIntent(quads), PEER));

    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED);
    expect(signMessage).not.toHaveBeenCalled();
    expect(requests).toEqual([
      expect.objectContaining({ contextGraphId: CG_ID, swmGraphId: SWM_GRAPH_ID, operation: 'update' }),
    ]);
  });

  it('does not consult the gate for a curated catalog ACK, whose guarantee is the persisted catalog', async () => {
    const store = new OxigraphStore();
    const gate = vi.fn(async (): Promise<StorageAckVmPromotionVerdict> => ({
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
      message: 'must not be asked',
    }));
    const { handler, signMessage } = handlerWithGate(store, gate, { curated: true });
    const catalogTriples = [{
      subject: `did:dkg:context-graph:${CG_ID}`,
      predicate: 'http://purl.org/dc/terms/identifier',
      object: `"did:dkg:context-graph:${CG_ID}"`,
    }];
    const catalog = computeCatalogRoot(catalogTriples);
    const stagingQuads = new TextEncoder().encode(
      catalogTriples.map((quad) => `<${quad.subject}> <${quad.predicate}> ${quad.object} .`).join('\n'),
    );

    const ack = decodeStorageACK(await handler.handler(encodePublishIntent({
      merkleRoot: ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('curated-root'))),
      contextGraphId: CG_ID,
      publisherPeerId: 'publisher-peer',
      publicByteSize: stagingQuads.length,
      isPrivate: true,
      kaCount: 1,
      rootEntities: [],
      stagingQuads,
      merkleLeafCount: 0,
      isEncryptedPayload: true,
      catalogRoot: catalog.root,
      catalogLeafCount: catalog.leafCount,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(signMessage).toHaveBeenCalledOnce();
    expect(gate).not.toHaveBeenCalled();
    expect(await store.countQuads(contextGraphCatalogUri(CG_ID))).toBe(catalogTriples.length);
  });

  it('keeps the pre-gate behaviour for an embedding that wires no gate', async () => {
    const { store, quads } = await seededPublishStore();
    const { handler, signMessage } = handlerWithGate(store, undefined);

    const ack = decodeStorageACK(await handler.handler(publicPublishIntent(quads), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(signMessage).toHaveBeenCalledOnce();
  });
});
