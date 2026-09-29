import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  NoChainAdapter,
  type TxResult,
  type V10UpdateKAParams,
} from '@origintrail-official/dkg-chain';
import {
  computeCatalogRoot,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
  STORAGE_ACK_DECLINE_CODES,
  STORAGE_ACK_MAX_STAGING_BYTES,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  encodeUpdateIntent,
  generateEd25519Keypair,
  isStorageACKDecline,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { DKGPublisher } from '../src/dkg-publisher.js';
import type {
  PublishResult,
  V10UpdateACKProvider,
} from '../src/publisher.js';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
} from '../src/storage-ack-handler.js';
import {
  computeFlatKCMerkleLeafCountV10,
  computeFlatKCRootV10,
  computePrivateRootV10,
} from '../src/merkle.js';
import { buildUpdateSeal, mockSealCtx } from './_helpers/seal.js';

const TARGET_CG_ID = '42';
const SOURCE_CG_ID = 'private-rootless-cg';
const PRODUCER_WALLET = new ethers.Wallet(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const AUTHOR = PRODUCER_WALLET.address.toLowerCase();
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const SCOPE = createGraphKnowledgeAssetScope(UAL, 2);
const EXACT_VM_GRAPH = knowledgeAssetLayerGraphUri(
  SOURCE_CG_ID,
  MemoryLayer.VerifiableMemory,
  SCOPE,
);
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
const UPDATE_TX_HASH = `0x${'42'.padStart(64, '0')}`;

class ProducerUpdateChain extends MockChainAdapter {
  constructor() {
    super('otp:20430', AUTHOR);
  }

  override async getKnowledgeAssetOwner(kaId: bigint): Promise<string> {
    if (kaId === KA_ID) return AUTHOR;
    return super.getKnowledgeAssetOwner(kaId);
  }

  async getUpdateAckDigestFields() {
    return {
      contextGraphId: BigInt(TARGET_CG_ID),
      preUpdateMerkleRootCount: 1n,
      newTokenAmount: 1000n,
      mintAmount: 0n,
      burnTokenIds: [],
    };
  }

  override async updateKnowledgeCollectionV10(
    params: V10UpdateKAParams,
  ): Promise<TxResult> {
    await params.onBroadcast?.({ txHash: UPDATE_TX_HASH });
    return {
      success: true,
      hash: UPDATE_TX_HASH,
      blockNumber: 2,
      txIndex: 0,
      publisherAddress: AUTHOR,
    };
  }
}

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

function createHandler({
  store = new OxigraphStore(),
  wallet = ethers.Wallet.createRandom(),
  curated = false,
}: {
  store?: OxigraphStore;
  wallet?: ethers.Wallet;
  curated?: boolean;
} = {}): StorageACKHandler {
  return new StorageACKHandler(store, config(wallet, curated), new TypedEventBus());
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

function buildPublicQuadsWithWireByteSize(targetBytes: number, graph: string): Quad[] {
  const quads: Quad[] = [];
  const maxSafeLiteralBytes = 50_000;

  for (let i = 0; i < 1_000; i++) {
    const emptyQuad: Quad = {
      subject: `urn:test:oversized-update:${i}`,
      predicate: 'http://schema.org/description',
      object: '""',
      graph,
    };
    const currentBytes = wireNquads(quads).length;
    const separatorBytes = quads.length === 0 ? 0 : 1;
    const bytesNeededInsideLiteral =
      targetBytes - currentBytes - separatorBytes - wireNquads([emptyQuad]).length;
    const literalBytes =
      bytesNeededInsideLiteral >= 0 && bytesNeededInsideLiteral <= maxSafeLiteralBytes
        ? bytesNeededInsideLiteral
        : maxSafeLiteralBytes;
    quads.push({ ...emptyQuad, object: `"${'x'.repeat(literalBytes)}"` });

    const actualBytes = wireNquads(quads).length;
    if (actualBytes >= targetBytes) {
      if (actualBytes !== targetBytes) {
        throw new Error(
          `oversized update fixture byte-size drift: expected ${targetBytes}, got ${actualBytes}`,
        );
      }
      return quads;
    }
  }

  throw new Error(`failed to build public update quads with byte size ${targetBytes}`);
}

type CapturedUpdateParams = Parameters<V10UpdateACKProvider>[0];

interface GraphUpdateRun {
  result: PublishResult;
  params: CapturedUpdateParams;
  privateRoot?: Uint8Array;
}

interface RunGraphUpdateOptions {
  publicQuads: Quad[];
  privateQuads?: Quad[];
  fromSharedMemory?: boolean;
}

async function createGraphUpdateHarness(receiverStore = new OxigraphStore()): Promise<{
  runGraphUpdate: (options: RunGraphUpdateOptions) => Promise<GraphUpdateRun>;
}> {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherAddress: AUTHOR,
  });
  const initial = await publisher.publish({
    contextGraphId: SOURCE_CG_ID,
    quads: [{
      subject: 'urn:entity:producer',
      predicate: 'urn:p:value',
      object: '"v1"',
      graph: '',
    }],
    publisherPeerId: 'publisher-peer',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: 1,
    publicTripleCount: 1,
    privateTripleCount: 0,
  });
  expect(initial.kaId).toBe(KA_ID);

  const chain = new ProducerUpdateChain();
  chain.__registerKC({
    kaId: KA_ID,
    contextGraphId: BigInt(TARGET_CG_ID),
    merkleRootHex: ethers.hexlify(initial.merkleRoot),
    chunks: [],
    merkleLeafCount: 1,
    publisherAddress: AUTHOR,
  });
  (publisher as unknown as { chain: ProducerUpdateChain }).chain = chain;

  const handler = createHandler({ store: receiverStore });
  const collector = new ACKCollector({
    gossipPublish: async () => {},
    sendP2P: async (_peerId, _protocol, data) => handler.updateHandler(data, PEER),
    getConnectedCorePeers: () => ['core-1'],
    verifyIdentity: async () => true,
    log: () => {},
  });

  return {
    runGraphUpdate: async ({
      publicQuads,
      privateQuads = [],
      fromSharedMemory = false,
    }: RunGraphUpdateOptions): Promise<GraphUpdateRun> => {
      const privateRoot = privateQuads.length > 0
        ? computePrivateRootV10(privateQuads)
        : undefined;
      if (privateQuads.length > 0 && privateRoot === undefined) {
        throw new Error('private graph-update fixture did not produce a Merkle root');
      }
      const updateSeal = await buildUpdateSeal({
        kaId: KA_ID,
        quads: publicQuads,
        ...(privateQuads.length > 0 ? { privateQuads } : {}),
        author: PRODUCER_WALLET,
        ctx: mockSealCtx(),
      });
      let captured: CapturedUpdateParams | undefined;
      const v10UpdateACKProvider: V10UpdateACKProvider = async (params) => {
        captured = params;
        const collected = await collector.collectUpdate({
          ...params,
          contextGraphId: BigInt(params.contextGraphId),
          chainId: 31337n,
          kav10Address: '0x000000000000000000000000000000000000c10a',
          publisherPeerId: 'publisher-peer',
          requiredACKs: 1,
        });
        return collected.acks;
      };
      const commonOptions = {
        contextGraphId: SOURCE_CG_ID,
        publishContextGraphId: TARGET_CG_ID,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: 2,
        publicTripleCount: publicQuads.length,
        privateTripleCount: privateQuads.length,
        ...(privateRoot === undefined ? {} : { privateMerkleRoot: privateRoot }),
        precomputedUpdateAttestation: updateSeal,
        v10UpdateACKProvider,
      };

      let result: PublishResult;
      if (fromSharedMemory) {
        await store.insert(publicQuads.map((quad) => ({ ...quad, graph: EXACT_SWM_GRAPH })));
        result = await publisher.updateKnowledgeAssetFromSharedMemory(KA_ID, commonOptions);
      } else {
        result = await publisher.update(KA_ID, {
          ...commonOptions,
          quads: publicQuads,
          privateQuads,
        });
      }
      if (captured === undefined) {
        throw new Error('graph-update fixture did not invoke its ACK provider');
      }
      return {
        result,
        params: captured,
        ...(privateRoot === undefined ? {} : { privateRoot }),
      };
    },
  };
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
  it.each([
    { label: 'no triples', overrides: { publicTripleCount: 0, privateTripleCount: 0 } },
    {
      label: 'an undeclared private root',
      overrides: {
        publicTripleCount: 1,
        privateTripleCount: 0,
        privateMerkleRoot: PRIVATE_ROOT,
      },
    },
  ])('rejects an update intent with $label before signing', async ({ overrides }) => {
    const wallet = ethers.Wallet.createRandom();
    const signMessage = vi.spyOn(wallet, 'signMessage');
    const handler = createHandler({ wallet });

    await expect(handler.updateHandler(intent([], 0, overrides), PEER))
      .rejects.toThrow('invalid graph-scoped content envelope');
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('accepts the inline VM payload emitted by a public graph-update producer', async () => {
    const harness = await createGraphUpdateHarness();
    const publicQuads: Quad[] = [{
      subject: 'urn:entity:producer',
      predicate: 'urn:p:value',
      object: '"v2"',
      graph: '',
    }];

    const { result, params } = await harness.runGraphUpdate({
      publicQuads,
      fromSharedMemory: true,
    });

    expect(result.status).toBe('confirmed');
    expect(params.stagingQuads).toBeDefined();
    expect(new TextDecoder().decode(params.stagingQuads)).toContain(`<${EXACT_VM_GRAPH}>`);
    expect(new TextDecoder().decode(params.stagingQuads)).not.toContain(`<${EXACT_SWM_GRAPH}>`);
  });

  it('accepts an inline public-plus-private graph update with no local SWM copy', async () => {
    const quads: Quad[] = [
      { subject: 'urn:entity:a', predicate: 'urn:p:value', object: '"a"', graph: EXACT_VM_GRAPH },
      { subject: 'urn:entity:b', predicate: 'urn:p:value', object: '"b"', graph: EXACT_VM_GRAPH },
    ];
    const stagingQuads = wireNquads(quads);
    const handler = createHandler();

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 3, {
      stagingQuads,
      newByteSize: stagingQuads.length,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ethers.hexlify(ack.merkleRoot)).toBe(
      ethers.hexlify(computeFlatKCRootV10(quads, [PRIVATE_ROOT])),
    );
  });

  it('declines the same public-plus-private graph update when staging is absent and SWM is empty', async () => {
    const quads: Quad[] = [
      { subject: 'urn:entity:a', predicate: 'urn:p:value', object: '"a"', graph: EXACT_VM_GRAPH },
      { subject: 'urn:entity:b', predicate: 'urn:p:value', object: '"b"', graph: EXACT_VM_GRAPH },
    ];
    const handler = createHandler();

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 3), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(ack.declineMessage).toContain(
      'graph-scoped public triple count mismatch: intent=2, local=0',
    );
  });

  it('declines inline graph updates whose claimed root omits the private commitment', async () => {
    const quads: Quad[] = [{
      subject: 'urn:entity:a',
      predicate: 'urn:p:value',
      object: '"a"',
      graph: EXACT_VM_GRAPH,
    }];
    const stagingQuads = wireNquads(quads);
    const handler = createHandler();

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 1, {
      stagingQuads,
      newByteSize: stagingQuads.length,
      newMerkleRoot: computeFlatKCRootV10(quads, []),
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(ack.declineMessage).toContain('graph-scoped newMerkleRoot mismatch');
  });

  it('declines inline private-root updates whose public triple count does not match the payload', async () => {
    const quads: Quad[] = [{
      subject: 'urn:entity:a',
      predicate: 'urn:p:value',
      object: '"a"',
      graph: EXACT_VM_GRAPH,
    }];
    const stagingQuads = wireNquads(quads);
    const handler = createHandler();

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 1, {
      stagingQuads,
      newByteSize: stagingQuads.length,
      publicTripleCount: 2,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(ack.declineMessage).toContain('public triple count mismatch: intent=2, local=1');
  });

  it('keeps fully private unencrypted graph updates outside the public ACK path', async () => {
    const handler = createHandler();

    await expect(handler.updateHandler(intent([], 1), PEER)).rejects.toThrow(
      'newMerkleLeafCount must be positive for public KAs',
    );
  });

  it('ships graph-scoped public quads inline with a private root so an empty core can sign', async () => {
    const harness = await createGraphUpdateHarness();
    const publicQuads: Quad[] = [{
      subject: 'urn:entity:producer',
      predicate: 'urn:p:value',
      object: '"v2"',
      graph: '',
    }];
    const privateQuads: Quad[] = [{
      subject: 'urn:entity:producer',
      predicate: 'urn:p:secret',
      object: '"secret"',
      graph: '',
    }];
    const { result, params, privateRoot } = await harness.runGraphUpdate({
      publicQuads,
      privateQuads,
    });

    expect(result.status).toBe('confirmed');
    const stagingQuads = params.stagingQuads;
    expect(stagingQuads).toBeDefined();
    if (stagingQuads === undefined) {
      throw new Error('small mixed graph update did not carry inline staging quads');
    }
    expect(params.publicTripleCount).toBe(1);
    expect(params.privateTripleCount).toBe(1);
    expect(params.privateMerkleRoot).toEqual(privateRoot);
    expect(params.newByteSize).toBe(BigInt(stagingQuads.length));
    expect(new TextDecoder().decode(stagingQuads)).toContain(`<${EXACT_VM_GRAPH}>`);
    expect(new TextDecoder().decode(stagingQuads)).not.toContain(`<${EXACT_SWM_GRAPH}>`);
  });

  it('omits just-over-limit mixed update staging and verifies from exact SWM', async () => {
    const targetBytes = STORAGE_ACK_MAX_STAGING_BYTES + 1;
    const vmQuads = buildPublicQuadsWithWireByteSize(targetBytes, EXACT_VM_GRAPH);
    const publicQuads = vmQuads.map((quad) => ({ ...quad, graph: '' }));
    const receiverStore = new OxigraphStore();
    await receiverStore.insert(vmQuads.map((quad) => ({ ...quad, graph: EXACT_SWM_GRAPH })));
    const harness = await createGraphUpdateHarness(receiverStore);

    expect(wireNquads(vmQuads).length).toBe(targetBytes);
    const { result, params } = await harness.runGraphUpdate({
      publicQuads,
      privateQuads: [{
        subject: publicQuads[0].subject,
        predicate: 'urn:p:secret',
        object: '"secret"',
        graph: '',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(params.stagingQuads).toBeUndefined();
    expect(params.newByteSize).toBe(BigInt(targetBytes));
    expect(params.publicTripleCount).toBe(publicQuads.length);
    expect(params.privateTripleCount).toBe(1);
  });

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
    const handler = createHandler({ store });

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
    const handler = createHandler({ store, curated: true });
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
    const handler = createHandler({ store });

    const ack = decodeStorageACK(await handler.updateHandler(intent(content, 0), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(ack.declineMessage).toContain('public triple count mismatch');
  });

  it('rejects an assertion version that is not pre-update count plus one', async () => {
    const handler = createHandler();

    await expect(handler.updateHandler(intent([], 1, {
      assertionVersion: '3',
    }), PEER)).rejects.toThrow('must equal preUpdateMerkleRootCount + 1');
  });

  it('rejects a non-canonical sub-graph before deriving an SWM graph URI', async () => {
    const handler = createHandler();

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
    const handler = createHandler({ store });

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 0, {
      newMerkleLeafCount: 999,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineMessage).toContain('newMerkleLeafCount mismatch');
  });

  it('ACKs canonical Markdown section entities from the exact SWM graph', async () => {
    const store = new OxigraphStore();
    const section = 'urn:dkg:ka-skolem:c14n0';
    const quads: Quad[] = [
      {
        subject: 'urn:document:construction-notes',
        predicate: 'http://dkg.io/ontology/hasSection',
        object: section,
        graph: EXACT_SWM_GRAPH,
      },
      {
        subject: section,
        predicate: 'http://schema.org/name',
        object: '"Safety"',
        graph: EXACT_SWM_GRAPH,
      },
    ];
    await store.insert(quads);
    const handler = createHandler({ store });

    const ack = decodeStorageACK(await handler.updateHandler(intent(quads, 0), PEER));

    expect(isStorageACKDecline(ack)).toBe(false);
  });

  it('keeps a legacy sub-graph update on the legacy handler', async () => {
    const quad: Quad = {
      subject: 'urn:legacy:entity',
      predicate: 'urn:p:value',
      object: '"legacy"',
      graph: `did:dkg:context-graph:${SOURCE_CG_ID}/sub/_shared_memory`,
    };
    const stagingQuads = wireNquads([quad]);
    const handler = createHandler();
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

  it('declines non-canonical reserved skolem terms over the graph-scoped ACK protocol', async () => {
    const malicious: Quad[] = [{
      subject: 'urn:dkg:ka-skolem:attacker',
      predicate: 'urn:p:value',
      object: '"attacker-authored"',
      graph: EXACT_SWM_GRAPH,
    }];
    const handler = createHandler();

    const ack = decodeStorageACK(await handler.updateHandler(intent(malicious, 0, {
      stagingQuads: wireNquads(malicious),
      newByteSize: wireNquads(malicious).length,
    }), PEER));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineMessage).toContain('reserved KA skolem namespace');
  });
});
