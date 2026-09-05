import { describe, expect, it } from 'vitest';
import {
  AUTHOR_SCHEME_VERSION_V1,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  buildUpdateAuthorAttestationTypedData,
  contextGraphDataUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  PrivateContentStore,
  canonicalSharedMemoryScopeWriteGraph,
  loadSharedMemoryQuadsForScope,
  type Quad,
  type SharedMemoryGraphScope,
} from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  computeFlatKCRootV10,
  computePrivateRootV10,
  resolveKnowledgeAssetOperationPublicQuads,
  resolveKnowledgeAssetWorkspaceHead,
  skolemizeKnowledgeAssetParts,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { PublishMethods } from '../src/dkg-agent-publish.js';

const CG = 'rootless-update-boundary';
const CHAIN_ID = 'mock:31337';
const ORIGINAL_AUTHOR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EVM_CHAIN_ID = 31337n;
const KAV_ADDRESS = '0x1111111111111111111111111111111111111111';
const CURRENT_OWNER_WALLET = new ethers.Wallet(
  '0x59c6995e998f97a5a0044976f7d4b21ddc10b15f2b79366a0a69c3fcf4e7f5c2',
);
const ATTACKER_WALLET = new ethers.Wallet(
  '0x8b3a350cf5c34c9194ca3a545d05a0f4f70e6fb072cf5f77b905d8b317f2f3d0',
);
const CURRENT_OWNER = CURRENT_OWNER_WALLET.address;
const KA_NUMBER = 7n;
const KA_ID = (BigInt(ORIGINAL_AUTHOR) << 96n) | KA_NUMBER;
const UAL = `did:dkg:${CHAIN_ID}/${ORIGINAL_AUTHOR}/${KA_NUMBER.toString()}`;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function int(value: bigint | number): string {
  return `"${value.toString()}"^^<${XSD_INTEGER}>`;
}

function q(subject: string, predicate: string, object: string, graph = ''): Quad {
  return { subject, predicate, object, graph };
}

async function seedConfirmedRootlessHead(store: OxigraphStore): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(UAL, 1);
  const metaGraph = contextGraphMetaUri(CG);
  const vmGraph = knowledgeAssetLayerGraphUri(
    CG,
    MemoryLayer.VerifiableMemory,
    scope,
  );
  await store.insert([
    q(UAL, `${DKG}contentScopeVersion`, int(GRAPH_KA_CONTENT_SCOPE_VERSION), metaGraph),
    q(UAL, `${DKG}kaUal`, UAL, metaGraph),
    q(UAL, `${DKG}assertionVersion`, int(1), metaGraph),
    q(UAL, `${DKG}batchId`, int(KA_ID), metaGraph),
    q(UAL, `${DKG}status`, '"confirmed"', metaGraph),
    q(UAL, `${DKG}contextGraph`, contextGraphDataUri(CG), metaGraph),
    q(UAL, `${DKG}assertionGraph`, vmGraph, metaGraph),
    q('urn:old:vm', 'urn:value', '"one"', vmGraph),
  ]);
}

async function updateAttestation(
  publicQuads: Quad[],
  privateQuads: Quad[] = [],
  signer = CURRENT_OWNER_WALLET,
  authorAddress = signer.address,
) {
  const canonical = await skolemizeKnowledgeAssetParts(publicQuads, privateQuads);
  const privateRoot = computePrivateRootV10(canonical.privateQuads);
  const expectedNewMerkleRoot = computeFlatKCRootV10(
    canonical.publicQuads,
    privateRoot ? [privateRoot] : [],
  );
  const typedData = buildUpdateAuthorAttestationTypedData({
    chainId: EVM_CHAIN_ID,
    kav10Address: KAV_ADDRESS,
    kaId: KA_ID,
    newMerkleRoot: expectedNewMerkleRoot,
    authorAddress,
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  });
  const signed = ethers.Signature.from(await signer.signTypedData(
    typedData.domain,
    typedData.types,
    typedData.message,
  ));
  return {
    canonical,
    privateRoot,
    attestation: {
      expectedNewMerkleRoot,
      authorAddress,
      signature: {
        r: ethers.getBytes(signed.r),
        vs: ethers.getBytes(signed.yParityAndS),
      },
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    },
  };
}

async function makeAgentLike(
  store: OxigraphStore,
  onPublisherUpdate: (kaId: bigint, options: Record<string, any>) => Promise<any>,
  currentOwner = CURRENT_OWNER,
) {
  const writeLocks = new Map<string, Promise<void>>();
  const chain = {
    chainId: CHAIN_ID,
    getEvmChainId: async () => EVM_CHAIN_ID,
    getKnowledgeAssetsLifecycleAddress: async () => KAV_ADDRESS,
    getKnowledgeAssetOwner: async () => currentOwner,
    hasContractCode: async () => false,
  };
  const publisher = new DKGPublisher({
    store,
    chain: chain as never,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    writeLocks,
  });
  publisher.updateKnowledgeAssetFromStagedSharedWorkingMemoryV1 = onPublisherUpdate as never;
  return {
    store,
    chain,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    node: { peerId: { toString: () => 'peer-rootless-update' } },
    writeLocks,
    publisher,
    getContextGraphOnChainId: async () => null,
    createV10UpdateACKProvider: () => undefined,
    _resolveEncryptInlinePayload: async () => undefined,
    _resolveEncryptInlineChunked: async () => undefined,
    gossip: { publish: async () => undefined },
  } as any;
}

describe('DKGAgent rootless update boundary', () => {
  it('stages one exact SWM graph, versions private content, and permits a transferred owner', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const publicQuads = [
      q('urn:update:asset', 'urn:hasPart', '_:part'),
      q('_:part', 'urn:value', '"two"'),
    ];
    const privateQuads = [q('_:secret', 'urn:secret', '"classified"')];
    const { canonical, privateRoot, attestation } = await updateAttestation(
      publicQuads,
      privateQuads,
    );

    const graphManager = new GraphManager(store);
    const swmBucket = graphManager.sharedMemoryUri(CG);
    const scope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    const canonicalSwm = canonicalSharedMemoryScopeWriteGraph(swmBucket, scope);
    const historicalAlias = `${swmBucket}/0x${ORIGINAL_AUTHOR.slice(2).toUpperCase()}/${KA_NUMBER.toString()}`;
    await store.insert([q('urn:stale', 'urn:value', '"stale"', historicalAlias)]);

    let publisherCalls = 0;
    let lastStagedReference: unknown;
    const interleavedPublicQuads = [q('urn:update:interleaved', 'urn:value', '"three"')];
    const agent = await makeAgentLike(store, async (kaId, options) => {
      publisherCalls += 1;
      expect(kaId).toBe(KA_ID);
      expect(options).toMatchObject({
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: UAL,
        assertionVersion: '2',
        publicTripleCount: canonical.publicQuads.length,
        privateTripleCount: canonical.privateQuads.length,
      });
      expect(options.privateMerkleRoot).toEqual(privateRoot);
      expect(options.stagedOperation).toBe(lastStagedReference);
      const operationA = options.stagedOperation;

      await agent.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
        contextGraphId: CG,
        shareOperationId: 'interleaved-operation-b',
        kaUal: UAL,
        assertionVersion: '2',
        quads: interleavedPublicQuads,
        privateTripleCount: 0,
      });
      const liveAfterInterleave = await loadSharedMemoryQuadsForScope(
        store,
        swmBucket,
        'all',
        scope,
      );
      expect(liveAfterInterleave.map(({ graph: _graph, ...quad }) => quad))
        .toEqual(interleavedPublicQuads.map(({ graph: _graph, ...quad }) => quad));
      const stagedA = await resolveKnowledgeAssetOperationPublicQuads({
        store,
        graphManager,
        contextGraphId: operationA.contextGraphId,
        shareOperationId: operationA.shareOperationId,
        kaUal: operationA.kaUal,
        assertionVersion: operationA.assertionVersion,
      });
      const byTriple = (left: Omit<Quad, 'graph'>, right: Omit<Quad, 'graph'>) =>
        `${left.subject}\u0000${left.predicate}\u0000${left.object}`
          .localeCompare(`${right.subject}\u0000${right.predicate}\u0000${right.object}`);
      expect(stagedA.quads.map(({ graph: _graph, ...quad }) => quad).sort(byTriple)).toEqual(
        canonical.publicQuads.map(({ graph: _graph, ...quad }) => quad).sort(byTriple),
      );
      return {
        kaId,
        ual: UAL,
        merkleRoot: attestation.expectedNewMerkleRoot,
        kaManifest: [],
        status: 'tentative',
        publicQuads: stagedA.quads,
      };
    });
    const realStage = agent.publisher.stageKnowledgeAssetSharedWorkingMemoryV1.bind(
      agent.publisher,
    );
    agent.publisher.stageKnowledgeAssetSharedWorkingMemoryV1 = async (input) => {
      const staged = await realStage(input);
      lastStagedReference = staged;
      return staged;
    };

    const result = await (PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      privateQuads,
      { precomputedUpdateAttestation: attestation },
    );

    expect(result.status).toBe('tentative');
    expect(publisherCalls).toBe(1);
    expect(await store.countQuads(canonicalSwm)).toBe(interleavedPublicQuads.length);
    expect(await store.countQuads(historicalAlias)).toBe(0);
    const privateStore = new PrivateContentStore(store, graphManager);
    expect(await privateStore.getKnowledgeAssetPrivateTriples(
      CG,
      createGraphKnowledgeAssetScope(UAL, 2),
    )).toEqual(canonical.privateQuads);

    // Staging an update must not mutate the current VM graph before the
    // publisher/chain confirms it.
    const currentVm = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(UAL, 1),
    );
    expect(await store.countQuads(currentVm)).toBe(1);
  });

  it('rejects an attestation-root mismatch before touching SWM or private storage', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const publicQuads = [q('urn:update:asset', 'urn:value', '"two"')];
    const { attestation } = await updateAttestation(publicQuads);
    attestation.expectedNewMerkleRoot = new Uint8Array(32).fill(0xff);
    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toThrow(/expectedNewMerkleRoot mismatch/);

    const graphManager = new GraphManager(store);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    expect(await store.countQuads(canonicalSharedMemoryScopeWriteGraph(
      graphManager.sharedMemoryUri(CG),
      swmScope,
    ))).toBe(0);
    expect(await new PrivateContentStore(store, graphManager)
      .getKnowledgeAssetPrivateTriples(CG, createGraphKnowledgeAssetScope(UAL, 2)))
      .toEqual([]);
    expect(publisherCalls).toBe(0);
  });

  it('rejects an invalid update signer before replacing existing SWM or private state', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const replacementPublic = [q('urn:update:new', 'urn:value', '"replacement"')];
    const replacementPrivate = [q('urn:update:secret', 'urn:value', '"replacement-secret"')];
    const { attestation } = await updateAttestation(
      replacementPublic,
      replacementPrivate,
      ATTACKER_WALLET,
      CURRENT_OWNER,
    );

    const graphManager = new GraphManager(store);
    const swmBucket = graphManager.sharedMemoryUri(CG);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    const canonicalSwm = canonicalSharedMemoryScopeWriteGraph(swmBucket, swmScope);
    const priorPublic = [q('urn:update:prior', 'urn:value', '"prior"', canonicalSwm)];
    await store.insert(priorPublic);
    const privateStore = new PrivateContentStore(store, graphManager);
    const nextScope = createGraphKnowledgeAssetScope(UAL, 2);
    const priorPrivate = [q('urn:update:prior-secret', 'urn:value', '"prior-secret"')];
    await privateStore.replaceKnowledgeAssetPrivateTriples(CG, nextScope, priorPrivate);

    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      replacementPublic,
      replacementPrivate,
      { precomputedUpdateAttestation: attestation },
    )).rejects.toThrow(/signer mismatch/);

    const persistedPublic = await loadSharedMemoryQuadsForScope(
      store,
      swmBucket,
      'all',
      swmScope,
    );
    expect(persistedPublic.map(({ graph: _graph, ...quad }) => quad)).toEqual(
      priorPublic.map(({ graph: _graph, ...quad }) => quad),
    );
    expect(await privateStore.getKnowledgeAssetPrivateTriples(CG, nextScope))
      .toEqual(priorPrivate);
    expect(publisherCalls).toBe(0);
  });

  it('rejects an invalid EIP-1271 update signature before durable staging', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const publicQuads = [q('urn:update:contract', 'urn:value', '"replacement"')];
    const { attestation } = await updateAttestation(publicQuads);
    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });
    agent.chain.hasContractCode = async () => true;
    agent.chain.verifyContractSignature = async () => false;

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toThrow(/contract signature is invalid/);

    const graphManager = new GraphManager(store);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    expect(await store.countQuads(canonicalSharedMemoryScopeWriteGraph(
      graphManager.sharedMemoryUri(CG),
      swmScope,
    ))).toBe(0);
    expect(publisherCalls).toBe(0);
  });

  it('rejects a valid non-owner attestation before replacing existing SWM or private state', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const replacementPublic = [q('urn:update:new', 'urn:value', '"replacement"')];
    const replacementPrivate = [q('urn:update:secret', 'urn:value', '"replacement-secret"')];
    const { attestation } = await updateAttestation(
      replacementPublic,
      replacementPrivate,
      ATTACKER_WALLET,
    );

    const graphManager = new GraphManager(store);
    const swmBucket = graphManager.sharedMemoryUri(CG);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    const canonicalSwm = canonicalSharedMemoryScopeWriteGraph(swmBucket, swmScope);
    const priorPublic = [q('urn:update:prior', 'urn:value', '"prior"', canonicalSwm)];
    await store.insert(priorPublic);
    const privateStore = new PrivateContentStore(store, graphManager);
    const nextScope = createGraphKnowledgeAssetScope(UAL, 2);
    const priorPrivate = [q('urn:update:prior-secret', 'urn:value', '"prior-secret"')];
    await privateStore.replaceKnowledgeAssetPrivateTriples(CG, nextScope, priorPrivate);

    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      replacementPublic,
      replacementPrivate,
      { precomputedUpdateAttestation: attestation },
    )).rejects.toMatchObject({ code: 'KA_UPDATE_AUTHOR_NOT_OWNER' });

    const persistedPublic = await loadSharedMemoryQuadsForScope(
      store,
      swmBucket,
      'all',
      swmScope,
    );
    expect(persistedPublic.map(({ graph: _graph, ...quad }) => quad)).toEqual(
      priorPublic.map(({ graph: _graph, ...quad }) => quad),
    );
    expect(await privateStore.getKnowledgeAssetPrivateTriples(CG, nextScope))
      .toEqual(priorPrivate);
    expect(publisherCalls).toBe(0);
  });

  it('persists an exact update snapshot and head before publisher chain write-ahead', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const publicQuads = [q('urn:update:recover', 'urn:value', '"recoverable"')];
    const privateQuads = [q('urn:update:recover-secret', 'urn:value', '"private"')];
    const { canonical, privateRoot, attestation } = await updateAttestation(
      publicQuads,
      privateQuads,
    );
    const agent = await makeAgentLike(store, async () => {
      throw new Error('simulated crash after chain write-ahead');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      privateQuads,
      { precomputedUpdateAttestation: attestation },
    )).rejects.toThrow('simulated crash after chain write-ahead');

    const graphManager = new GraphManager(store);
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: UAL,
    });
    expect(head).toMatchObject({
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: canonical.publicQuads.length,
      privateTripleCount: canonical.privateQuads.length,
      publisherPeerId: 'peer-rootless-update',
    });
    expect(head?.privateMerkleRoot?.toLowerCase()).toBe(
      privateRoot ? ethers.hexlify(privateRoot).toLowerCase() : undefined,
    );
    const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: head!.shareOperationId,
      kaUal: UAL,
      assertionVersion: 2,
    });
    expect(snapshot.quads).toEqual(canonical.publicQuads);
  });

  it('rejects caller-authored named graphs before staging or publisher side effects', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const plain = [q('urn:update:named', 'urn:value', '"blocked"')];
    const { attestation } = await updateAttestation(plain);
    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      [q('urn:update:named', 'urn:value', '"blocked"', 'urn:user:graph')],
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toMatchObject({ code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED' });
    expect(publisherCalls).toBe(0);
  });

  it('serializes same-KA updates so each publisher call reads its own staged graph', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const publicA = [q('urn:update:a', 'urn:value', '"A"')];
    const publicB = [q('urn:update:b', 'urn:value', '"B"')];
    const signedA = await updateAttestation(publicA);
    const signedB = await updateAttestation(publicB);
    const graphManager = new GraphManager(store);
    const swmBucket = graphManager.sharedMemoryUri(CG);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };

    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstPublisherEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstPublisherEntered = resolve; });
    const stagedByCall: Quad[][] = [];
    const agent = await makeAgentLike(store, async (kaId) => {
      const staged = await loadSharedMemoryQuadsForScope(
        store,
        swmBucket,
        'all',
        swmScope,
      );
      stagedByCall.push(staged.map(({ graph: _graph, ...quad }) => quad));
      if (stagedByCall.length === 1) {
        firstPublisherEntered();
        await holdFirst;
      }
      return {
        kaId,
        ual: UAL,
        merkleRoot: stagedByCall.length === 1
          ? signedA.attestation.expectedNewMerkleRoot
          : signedB.attestation.expectedNewMerkleRoot,
        kaManifest: [],
        status: 'tentative',
        publicQuads: staged,
      };
    });

    const first = (PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicA,
      [],
      { precomputedUpdateAttestation: signedA.attestation },
    );
    await firstEntered;
    const second = (PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicB,
      [],
      { precomputedUpdateAttestation: signedB.attestation },
    );

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(stagedByCall).toHaveLength(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(stagedByCall).toEqual([
      signedA.canonical.publicQuads.map(({ graph: _graph, ...quad }) => quad),
      signedB.canonical.publicQuads.map(({ graph: _graph, ...quad }) => quad),
    ]);
  });

  it('stages a fully private update without inventing a public placeholder', async () => {
    const store = new OxigraphStore();
    await seedConfirmedRootlessHead(store);
    const privateQuads = [q('urn:private:only', 'urn:secret', '"updated"')];
    const { canonical, privateRoot, attestation } = await updateAttestation([], privateQuads);
    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async (kaId, options) => {
      publisherCalls += 1;
      expect(kaId).toBe(KA_ID);
      expect(options.publicTripleCount).toBe(0);
      expect(options.privateTripleCount).toBe(canonical.privateQuads.length);
      expect(options.privateMerkleRoot).toEqual(privateRoot);
      expect(options.privateQuads).toEqual(canonical.privateQuads);
      return {
        kaId,
        ual: UAL,
        merkleRoot: attestation.expectedNewMerkleRoot,
        kaManifest: [],
        status: 'tentative',
        publicQuads: [],
      };
    });

    await (PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      [],
      privateQuads,
      { precomputedUpdateAttestation: attestation },
    );

    expect(publisherCalls).toBe(1);
    const scope = createGraphKnowledgeAssetScope(UAL, 2);
    const graphManager = new GraphManager(store);
    const swmScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: { agentAddress: ORIGINAL_AUTHOR, kaNumber: KA_NUMBER },
    };
    expect(await store.countQuads(canonicalSharedMemoryScopeWriteGraph(
      graphManager.sharedMemoryUri(CG),
      swmScope,
    ))).toBe(0);
    expect(await new PrivateContentStore(store, graphManager)
      .getKnowledgeAssetPrivateTriples(CG, scope)).toEqual(canonical.privateQuads);
  });

  it('requires the confirmed V2 head to be locally materialized', async () => {
    const store = new OxigraphStore();
    const publicQuads = [q('urn:update:asset', 'urn:value', '"two"')];
    const { attestation } = await updateAttestation(publicQuads);
    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toMatchObject({ code: 'ROOTLESS_KA_NOT_MATERIALIZED' });
    expect(publisherCalls).toBe(0);
  });

  it('keeps an existing root-scoped KA read-only instead of synthesizing a V2 target', async () => {
    const store = new OxigraphStore();
    const legacyUal = 'did:dkg:legacy/0xcccccccccccccccccccccccccccccccccccccccc/1';
    await store.insert([
      q(legacyUal, `${DKG}batchId`, int(KA_ID), contextGraphMetaUri(CG)),
      q(legacyUal, `${DKG}status`, '"confirmed"', contextGraphMetaUri(CG)),
    ]);
    const publicQuads = [q('urn:update:asset', 'urn:value', '"two"')];
    const { attestation } = await updateAttestation(publicQuads);
    let publisherCalls = 0;
    const agent = await makeAgentLike(store, async () => {
      publisherCalls += 1;
      throw new Error('publisher must not be called');
    });

    await expect((PublishMethods.prototype as any).update.call(
      agent,
      KA_ID,
      CG,
      publicQuads,
      [],
      { precomputedUpdateAttestation: attestation },
    )).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
    expect(publisherCalls).toBe(0);
  });
});
