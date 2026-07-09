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
  readFileSync,
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
  reconcileLifecycleLogs,
  senderKeyLifecycleLogs,
  storageAckLifecycleLogs,
  swmLifecycleLogs,
  syncLifecycleLogs,
  type FinalizationMessageMsg,
  type LogRecord,
  type OperationContext,
  type Quad,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageMsg,
  type V10ACKProviderParams,
  type V10CoreNodeACK,
} from './_helpers/ka-lifecycle.js';

describe('ka lifecycle storage ack', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  it('logs StorageACK success by assetUal', async () => {
    const store = new OxigraphStore();
    const swmGraph = 'did:dkg:context-graph:42/_shared_memory';
    const swmQuads = [{
      subject: ROOT_ENTITY,
      predicate: 'http://schema.org/name',
      object: '"Storage ACK lifecycle"',
      graph: swmGraph,
    }];
    await store.insert(swmQuads);

    const merkleRoot = computeFlatKCRootV10(swmQuads, []);
    const merkleLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);
    const handler = new StorageACKHandler(store, {
      nodeRole: 'core',
      nodeIdentityId: 42n,
      signerWallet: ethers.Wallet.createRandom(),
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: 31337n,
      kav10Address: '0x000000000000000000000000000000000000c10a',
      localPeerId: LOCAL_PEER_ID,
      ackHandlerDeadlineMs: 0,
      resolveAssetUalForPublishIntent: async () => ASSET_UAL,
    } as unknown as ConstructorParameters<typeof StorageACKHandler>[1], new TypedEventBus());
    const entries = captureLogs();
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: '42',
      publisherPeerId: PUBLISHER_PEER_ID,
      publicByteSize: 1024,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [ROOT_ENTITY],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount,
    });

    await handler.handler(intent, { toString: () => PUBLISHER_PEER_ID });

    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=storage_ack_signed'),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('localNodeIdentityId=42'),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`peer=${PUBLISHER_PEER_ID}`),
    );
  });

  it('logs StorageACK decline reason and retry metadata by assetUal', async () => {
    const store = new OxigraphStore();
    const handler = new StorageACKHandler(store, {
      nodeRole: 'core',
      nodeIdentityId: 42n,
      signerWallet: ethers.Wallet.createRandom(),
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: 31337n,
      kav10Address: '0x000000000000000000000000000000000000c10a',
      localPeerId: LOCAL_PEER_ID,
      ackHandlerDeadlineMs: 0,
      resolveAssetUalForPublishIntent: async () => ASSET_UAL,
    } as unknown as ConstructorParameters<typeof StorageACKHandler>[1], new TypedEventBus());
    const entries = captureLogs();
    const intent = encodePublishIntent({
      merkleRoot: new Uint8Array(32),
      contextGraphId: '42',
      publisherPeerId: PUBLISHER_PEER_ID,
      publicByteSize: 1024,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [ROOT_ENTITY],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: 1,
    });

    await handler.handler(intent, { toString: () => PUBLISHER_PEER_ID });

    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=storage_ack_declined'),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`declineCode=${STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM}`),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('declineMessage="No data found in SWM'),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('retryable=true'),
    );
  });

  it('derives StorageACK lifecycle assetUal from verified local SWM graph identity', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', AUTHOR_AGENT_ADDRESS.toLowerCase());
    const swmGraph = contextGraphLayerUri('42', MemoryLayer.SharedWorkingMemory, AUTHOR_AGENT_ADDRESS, '7');
    await store.insert([{
      subject: ROOT_ENTITY,
      predicate: 'http://schema.org/name',
      object: '"Production ACK lifecycle"',
      graph: swmGraph,
    }]);

    const assetUal = await resolveStorageAckLifecycleAssetUalFromLocalSwm({
      store,
      chain,
      intent: {
        contextGraphId: '42',
        publisherPeerId: PUBLISHER_PEER_ID,
        merkleRoot: new Uint8Array(32),
        publicByteSize: 1024,
        isPrivate: false,
        kaCount: 1,
        rootEntities: [ROOT_ENTITY],
      },
    });

    expect(assetUal).toBe(buildKnowledgeAssetUal(
      chain.chainId,
      await chain.getDKGKnowledgeAssetsAddress(),
      (BigInt(ethers.getAddress(AUTHOR_AGENT_ADDRESS.toLowerCase())) << 96n) | 7n,
    ));
  });

  it('wires the production DKGAgent StorageACK handler with the lifecycle assetUal resolver', () => {
    const source = readFileSync(new URL('../src/dkg-agent-lifecycle.ts', import.meta.url), 'utf8');

    expect(source).toContain('resolveAssetUalForPublishIntent');
    expect(source).toContain('resolveStorageAckLifecycleAssetUalFromLocalSwm');
  });
});
