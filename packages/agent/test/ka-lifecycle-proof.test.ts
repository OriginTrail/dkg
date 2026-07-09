import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSET_UAL,
  AUTHOR_AGENT_ADDRESS,
  CONNECTED_CONTEXT_GRAPH_ID,
  CONTEXT_GRAPH_ID,
  LOCAL_PEER_ID,
  PUBLISHER_PEER_ID,
  PUBLISHER_PRIVATE_KEY,
  ROOT_ENTITY,
  DKG_ONTOLOGY,
  Logger,
  MemoryLayer,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
  computeSwmSenderKeyPackageAAD,
  contextGraphDataUri,
  contextGraphLayerUri,
  contextGraphMetaUri,
  contextGraphWorkspaceGraphUri,
  decodeSwmSenderKeyPackageAck,
  decodeStorageACK,
  decodeSwmSenderKeyMessage,
  encodeFinalizationMessage,
  encodePublishIntent,
  encodeSwmSenderKeyPackage,
  encodeWorkspacePublishRequest,
  encryptSwmSenderKeyPackage,
  generateEd25519Keypair,
  generateWorkspaceRecipientEncryptionKey,
  isStorageACKDecline,
  MockChainAdapter,
  buildKnowledgeAssetUal,
  ethers,
  OxigraphStore,
  DKGPublisher,
  SharedMemoryHandler,
  StorageACKHandler,
  createStorageAckLifecycleObserver,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
  FinalizationHandler,
  DKGAgent,
  resolveStorageAckLifecycleAssetUalFromLocalSwm,
  makeTestKaAllocator,
  mockSealCtx,
  wrapPublisherForTest,
  buildSenderKeyPackage,
  bytes,
  captureLogs,
  createReceiverAgent,
  finalizationChainResolvingTarget,
  finalizationChainWithEvent,
  finalizationLifecycleLogs,
  insertAgentGate,
  insertFinalizationSharedMemory,
  makeFinalizationMessage,
  publishQuad,
  readOptionalUtf8,
  senderKeyLifecycleLogs,
  storageAckLifecycleLogs,
  swmLifecycleLogs,
  type FinalizationMessageMsg,
  type LogRecord,
  type OperationContext,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageMsg,
  type V10ACKProviderParams,
  type V10CoreNodeACK,
} from './_helpers/ka-lifecycle.js';

describe('ka lifecycle proof', () => {
  afterEach(() => {
    Logger.setSink(null);
    delete process.env.DKG_DEBUG_KA_LIFECYCLE;
  });

  it('builds a grepable multi-node KA publish lifecycle proof from connected publisher and receiver paths by assetUal', async () => {
    const proofModule = await import('../src/ka-lifecycle-log-proof.js').catch(() => undefined);
    expect(proofModule).toBeDefined();
    if (!proofModule) return;
    const { buildKaLifecycleLogProof, KA_LIFECYCLE_PROOF_SOURCE_DOCS } = proofModule;
    expect(KA_LIFECYCLE_PROOF_SOURCE_DOCS).toEqual([
      'CONTEXT.md',
      'docs/adr/0001-log-ka-publish-lifecycle-by-asset-ual.md',
    ]);

    const entries = captureLogs();
    const author = new ethers.Wallet(PUBLISHER_PRIVATE_KEY);
    const chain = new MockChainAdapter('mock:31337', author.address);
    chain.seedIdentity(author.address, 7n);
    chain.minimumRequiredSignatures = 1;
    const receiverAckWallet = ethers.Wallet.createRandom();
    const receiverStore = new OxigraphStore();
    const receiverBus = new TypedEventBus();
    let connectedAssetUal: string | undefined;
    const receiverSwmHandler = new SharedMemoryHandler(receiverStore, receiverBus, {
      assetUalForKaIdentity: async (_input: { agentAddress: string; kaNumber: string }) => {
        if (!connectedAssetUal) throw new Error('connected ACK provider has not supplied assetUal');
        return connectedAssetUal;
      },
      lifecycleLogOptions: {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);
    const receiverAckHandler = new StorageACKHandler(receiverStore, {
      nodeRole: 'core',
      nodeIdentityId: 42n,
      signerWallet: receiverAckWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: await chain.getEvmChainId(),
      kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
      ackHandlerDeadlineMs: 0,
      onStorageAckDecision: createStorageAckLifecycleObserver({
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
        resolveAssetUalForPublishIntent: async () => {
          if (!connectedAssetUal) throw new Error('connected ACK provider has not supplied assetUal');
          return connectedAssetUal;
        },
      }),
    } as unknown as ConstructorParameters<typeof StorageACKHandler>[1], receiverBus);
    const publisherStore = new OxigraphStore();
    const publishQuads = [
      publishQuad(
        CONNECTED_CONTEXT_GRAPH_ID,
        ROOT_ENTITY,
        'http://schema.org/name',
        '"Connected lifecycle proof"',
      ),
    ];
    const connectedAckProvider = async (params: V10ACKProviderParams): Promise<V10CoreNodeACK[]> => {
      if (!params.assetUal) throw new Error('connected ACK provider requires publisher assetUal');
      connectedAssetUal = params.assetUal;
      await receiverSwmHandler.handle(
        encodeWorkspacePublishRequest({
          shareOperationId: 'connected-share-op',
          contextGraphId: CONNECTED_CONTEXT_GRAPH_ID,
          publisherPeerId: PUBLISHER_PEER_ID,
          nquads: new TextEncoder().encode(
            `<${ROOT_ENTITY}> <http://schema.org/name> "Connected lifecycle proof" .`,
          ),
          manifest: [{ rootEntity: ROOT_ENTITY }],
          timestampMs: Date.now(),
          agentAddress: author.address,
          kaNumber: params.assetUal.slice(params.assetUal.lastIndexOf('/') + 1),
        }),
        PUBLISHER_PEER_ID,
      );
      const response = await receiverAckHandler.handler(
        encodePublishIntent({
          merkleRoot: params.merkleRoot,
          contextGraphId: params.contextGraphId,
          publisherPeerId: PUBLISHER_PEER_ID,
          publicByteSize: Number(params.publicByteSize),
          isPrivate: false,
          kaCount: params.kaCount,
          rootEntities: params.rootEntities,
          epochs: params.epochs,
          tokenAmountStr: (params.tokenAmount ?? 0n).toString(),
          merkleLeafCount: params.merkleLeafCount,
          stagingQuads: params.stagingQuads,
          swmGraphId: params.swmGraphId,
          subGraphName: params.subGraphName,
        }),
        { toString: () => PUBLISHER_PEER_ID },
      );
      const ack = decodeStorageACK(response);
      if (isStorageACKDecline(ack)) {
        throw new Error(`receiver declined connected ACK: ${ack.declineCode}`);
      }
      return [{
        peerId: LOCAL_PEER_ID,
        signatureR: bytes(ack.coreNodeSignatureR),
        signatureVS: bytes(ack.coreNodeSignatureVS),
        nodeIdentityId: BigInt(ack.nodeIdentityId.toString()),
      }];
    };
    const publisher = wrapPublisherForTest(new DKGPublisher({
      store: publisherStore,
      chain,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: PUBLISHER_PRIVATE_KEY,
      publisherNodeIdentityId: 7n,
      kaAllocator: makeTestKaAllocator(),
    }), {
      author,
      ctx: mockSealCtx({
        chainId: await chain.getEvmChainId(),
        kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
      }),
      v10ACKProvider: connectedAckProvider,
    });

    const result = await publisher.publish({
      contextGraphId: CONNECTED_CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      quads: publishQuads,
    });
    expect(result.status).toBe('confirmed');
    expect(result.onChainResult).toBeDefined();
    const onChain = result.onChainResult!;

    await receiverAckHandler.handler(
      encodePublishIntent({
        merkleRoot: new Uint8Array(32),
        contextGraphId: CONNECTED_CONTEXT_GRAPH_ID,
        publisherPeerId: PUBLISHER_PEER_ID,
        publicByteSize: 1024,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [`${ROOT_ENTITY}/missing`],
        epochs: 1,
        tokenAmountStr: '0',
        merkleLeafCount: 1,
      }),
      { toString: () => PUBLISHER_PEER_ID },
    );

    const finalizationHandler = new FinalizationHandler(
      receiverStore,
      finalizationChainWithEvent({
        txHash: onChain.txHash,
        blockNumber: onChain.blockNumber,
        merkleRoot: result.merkleRoot,
        publisherAddress: author.address,
        startKAId: onChain.startKAId ?? result.kaId,
        endKAId: onChain.endKAId ?? result.kaId,
      }) as any,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    await finalizationHandler.handleFinalizationMessage(encodeFinalizationMessage({
      ual: result.ual,
      contextGraphId: CONNECTED_CONTEXT_GRAPH_ID,
      kcMerkleRoot: result.merkleRoot,
      txHash: onChain.txHash,
      blockNumber: onChain.blockNumber,
      batchId: result.kaId,
      startKAId: onChain.startKAId ?? result.kaId,
      endKAId: onChain.endKAId ?? result.kaId,
      publisherAddress: author.address,
      rootEntities: [ROOT_ENTITY],
      timestampMs: Date.now(),
      operationId: 'connected-finalization-proof',
      targetContextGraphId: CONNECTED_CONTEXT_GRAPH_ID,
    }), CONNECTED_CONTEXT_GRAPH_ID);

    const proof = buildKaLifecycleLogProof(entries, result.ual);

    expect(proof.missingRequiredStages).toEqual([]);
    expect(proof.stageTrail).toEqual([
      'identity',
      'wm',
      'swm_share',
      'storage_ack',
      'chain',
      'vm',
      'finalization',
    ]);
    expect((proof as { roleTrail?: string[] }).roleTrail).toEqual(['publisher', 'receiver']);
    expect((proof as { sourceTrail?: string[] }).sourceTrail).toEqual(expect.arrayContaining([
      PUBLISHER_PEER_ID,
      LOCAL_PEER_ID,
    ]));
    expect(proof.eventTrail).toContain('storage_ack_signed');
    expect(proof.eventTrail).toContain('finalization_applied');
    expect(proof.hasAckLog).toBe(true);
    expect(proof.hasStateChangeLog).toBe(true);
    expect(proof.hasFailureOrDeclineLog).toBe(true);
    expect(proof.hasPayloadLeak).toBe(false);
    expect(proof.grep).toContain(`assetUal=${result.ual}`);
    expect(proof.grep).toContain('localPeerId=12D3KooWKaLifecycleReceiver');
    expect(proof.entries.map((entry) => entry.module)).toEqual(expect.arrayContaining([
      'DKGPublisher',
      'SharedMemoryHandler',
      'StorageACKHandler',
      'FinalizationHandler',
    ]));
  });

  it('documents the repeatable KA lifecycle log proof handoff and artifact script', () => {
    const handoff = readOptionalUtf8(new URL('../../../docs/use-dkg/ka-publish-lifecycle-log-proof.md', import.meta.url));
    const script = readOptionalUtf8(new URL('../../../scripts/devnet-ka-lifecycle-log-proof.sh', import.meta.url));
    const suite = readOptionalUtf8(new URL('../../../devnet/ka-lifecycle-log-proof/automated.test.ts', import.meta.url));
    const suitesManifest = readOptionalUtf8(new URL('../../../devnet/suites.json', import.meta.url));

    expect(handoff).toBeDefined();
    expect(script).toBeDefined();
    expect(suite).toBeDefined();
    expect(suitesManifest).toBeDefined();
    if (!handoff) return;
    if (!script) return;
    if (!suite) return;
    if (!suitesManifest) return;
    expect(handoff).toContain('CONTEXT.md');
    expect(handoff).toContain('docs/adr/0001-log-ka-publish-lifecycle-by-asset-ual.md');
    expect(handoff).toContain('scripts/devnet-ka-lifecycle-log-proof.sh');
    expect(handoff).toContain('pnpm test:devnet:ka-lifecycle-log-proof');
    expect(handoff).toContain('grep');
    expect(handoff).toContain('ka_lifecycle');
    expect(handoff).toContain('assetUal');
    expect(handoff).toContain('identity');
    expect(handoff).toContain('storage_ack');
    expect(handoff).toContain('finalization');
    expect(handoff).toContain('raw payload');
    expect(handoff).toContain('## Repeatable Devnet Artifact');
    expect(handoff).toContain('metadata.txt');
    expect(handoff).toContain('grep.txt');
    expect(handoff).not.toContain('Recorded compact grep result');
    expect(script).toContain('stage=identity');
    expect(script).toContain('stage=storage_ack');
    expect(script).toContain('stage=finalization');
    expect(suite).toContain('scripts/devnet-ka-lifecycle-log-proof.sh');
    expect(suite).toContain('metadata.txt');
    expect(suite).toContain('publish.txt');
    expect(suite).toContain('grep.txt');
    expect(suitesManifest).toContain('ka-lifecycle-log-proof');
  });
});
