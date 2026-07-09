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
  type Quad,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageMsg,
  type V10ACKProviderParams,
  type V10CoreNodeACK,
} from './_helpers/ka-lifecycle.js';

describe('ka lifecycle finalization', () => {
  afterEach(() => {
    Logger.setSink(null);
    delete process.env.DKG_DEBUG_KA_LIFECYCLE;
  });

  it('logs already-confirmed finalization by assetUal', async () => {
    const store = new OxigraphStore();
    await store.insert([{
      subject: ASSET_UAL,
      predicate: 'http://dkg.io/ontology/status',
      object: '"confirmed"',
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID, '42'),
    }]);
    const handler = new (FinalizationHandler as any)(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    const entries = captureLogs();

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ual: ASSET_UAL,
      contextGraphId: CONTEXT_GRAPH_ID,
      kcMerkleRoot: new Uint8Array(32),
      txHash: '0x' + 'ab'.repeat(32),
      blockNumber: 100,
      batchId: 7,
      startKAId: 7,
      endKAId: 7,
      publisherAddress: AUTHOR_AGENT_ADDRESS,
      rootEntities: [ROOT_ENTITY],
      timestampMs: Date.now(),
      operationId: 'finalization-lifecycle-test',
      targetContextGraphId: '42',
    }), CONTEXT_GRAPH_ID);

    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=finalization_already_confirmed'),
    );
    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('role=receiver'),
    );
    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`localPeerId=${LOCAL_PEER_ID}`),
    );
    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('localNodeIdentityId=42'),
    );
  });

  it('logs finalization no-data fallback by assetUal', async () => {
    const store = new OxigraphStore();
    const handler = new (FinalizationHandler as any)(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    const entries = captureLogs();

    await handler.handleFinalizationMessage(encodeFinalizationMessage({
      ual: ASSET_UAL,
      contextGraphId: CONTEXT_GRAPH_ID,
      kcMerkleRoot: new Uint8Array(32),
      txHash: '0x' + 'bc'.repeat(32),
      blockNumber: 101,
      batchId: 8,
      startKAId: 8,
      endKAId: 8,
      publisherAddress: AUTHOR_AGENT_ADDRESS,
      rootEntities: [ROOT_ENTITY],
      timestampMs: Date.now(),
      operationId: 'finalization-no-data-lifecycle-test',
      targetContextGraphId: '42',
    }), CONTEXT_GRAPH_ID);

    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=finalization_no_data'),
    );
    expect(finalizationLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('reason="no shared memory data"'),
    );
  });

  it('logs applied finalization by assetUal after durable promotion', async () => {
    const store = new OxigraphStore();
    const rootEntity = `${ROOT_ENTITY}/finalized`;
    const swmQuads = [{
      subject: rootEntity,
      predicate: 'http://schema.org/name',
      object: '"Finalized lifecycle"',
      graph: contextGraphWorkspaceGraphUri(CONTEXT_GRAPH_ID),
    }];
    await store.insert(swmQuads);
    const merkleRoot = computeFlatKCRootV10(
      swmQuads.map((quad) => ({ ...quad, graph: '' })),
      [],
    );
    const txHash = '0x' + 'de'.repeat(32);
    const blockNumber = 144;
    const handler = new FinalizationHandler(
      store,
      finalizationChainWithEvent({
        txHash,
        blockNumber,
        merkleRoot,
        publisherAddress: AUTHOR_AGENT_ADDRESS,
        startKAId: 7n,
        endKAId: 7n,
      }) as any,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    const entries = captureLogs();

    await handler.handleFinalizationMessage(encodeFinalizationMessage(makeFinalizationMessage({
      kcMerkleRoot: merkleRoot,
      txHash,
      blockNumber,
      rootEntities: [rootEntity],
    })), CONTEXT_GRAPH_ID);

    const messages = finalizationLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=finalization_applied'));
    expect(messages).toContainEqual(expect.stringContaining('outcome=promoted'));
    expect(messages).toContainEqual(expect.stringContaining('swmStatementCount=1'));
    expect(messages).toContainEqual(expect.stringContaining('retryable=false'));
  });

  it('logs finalization catch failures by assetUal with resolved target context graph', async () => {
    const store = new OxigraphStore();
    const query = store.query.bind(store);
    store.query = async (...args: Parameters<typeof store.query>) => {
      const options = args[1] as { source?: string } | undefined;
      if (options?.source === 'agent.finalization.sharedMemorySlice') {
        throw new Error('SWM finalization slice unavailable');
      }
      return query(...args);
    };
    const handler = new FinalizationHandler(
      store,
      finalizationChainResolvingTarget('42') as any,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    const entries = captureLogs();

    await handler.handleFinalizationMessage(encodeFinalizationMessage(makeFinalizationMessage({
      operationId: 'finalization-catch-lifecycle-test',
      targetContextGraphId: undefined,
    })), CONTEXT_GRAPH_ID);

    const messages = finalizationLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=finalization_failed'));
    expect(messages).toContainEqual(expect.stringContaining('targetContextGraphId=42'));
    expect(messages).toContainEqual(expect.stringContaining('retryable=true'));
    expect(messages).toContainEqual(expect.stringContaining('reason="SWM finalization slice unavailable"'));
  });

  it('does not emit asset-scoped lifecycle logs for a mismatched finalization topic', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    const entries = captureLogs();

    await handler.handleFinalizationMessage(encodeFinalizationMessage(makeFinalizationMessage({
      contextGraphId: 'ka-lifecycle-cg-other',
      operationId: 'finalization-reject-lifecycle-test',
    })), CONTEXT_GRAPH_ID);

    const messages = finalizationLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).not.toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).not.toContainEqual(expect.stringContaining('event=finalization_received'));
    expect(messages).not.toContainEqual(expect.stringContaining('event=finalization_rejected'));
  });

  it('logs finalization verification failure by assetUal', async () => {
    const store = new OxigraphStore();
    const rootEntity = `${ROOT_ENTITY}/verification-failed`;
    const merkleRoot = await insertFinalizationSharedMemory(
      store,
      rootEntity,
      'Verification failure lifecycle',
    );
    const handler = new FinalizationHandler(
      store,
      finalizationChainResolvingTarget('42') as any,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    const entries = captureLogs();

    await handler.handleFinalizationMessage(encodeFinalizationMessage(makeFinalizationMessage({
      operationId: 'finalization-verification-failed-lifecycle-test',
      kcMerkleRoot: merkleRoot,
      rootEntities: [rootEntity],
    })), CONTEXT_GRAPH_ID);

    const messages = finalizationLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=finalization_verification_failed'));
    expect(messages).toContainEqual(expect.stringContaining('swmStatementCount=1'));
    expect(messages).toContainEqual(expect.stringContaining('outcome=deferred'));
    expect(messages).toContainEqual(expect.stringContaining('retryable=true'));
    expect(messages).toContainEqual(expect.stringContaining('reason="on-chain verification failed"'));
  });

  it('logs finalization merkle mismatch by assetUal', async () => {
    const store = new OxigraphStore();
    const rootEntity = `${ROOT_ENTITY}/merkle-mismatch`;
    await insertFinalizationSharedMemory(
      store,
      rootEntity,
      'Merkle mismatch lifecycle',
    );
    const handler = new FinalizationHandler(
      store,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    );
    const entries = captureLogs();

    await handler.handleFinalizationMessage(encodeFinalizationMessage(makeFinalizationMessage({
      operationId: 'finalization-merkle-mismatch-lifecycle-test',
      kcMerkleRoot: new Uint8Array(32).fill(0xee),
      rootEntities: [rootEntity],
    })), CONTEXT_GRAPH_ID);

    const messages = finalizationLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=finalization_merkle_mismatch'));
    expect(messages).toContainEqual(expect.stringContaining('swmStatementCount=1'));
    expect(messages).toContainEqual(expect.stringContaining('outcome=deferred'));
    expect(messages).toContainEqual(expect.stringContaining('retryable=true'));
    expect(messages).toContainEqual(expect.stringContaining('reason="shared memory merkle root mismatch"'));
  });
});
