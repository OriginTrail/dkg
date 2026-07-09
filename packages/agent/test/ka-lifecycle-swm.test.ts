import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('ka lifecycle swm', () => {
  afterEach(() => {
    Logger.setSink(null);
    delete process.env.DKG_DEBUG_KA_LIFECYCLE;
  });

  it('logs a substrate-applied SWM receive by assetUal', async () => {
    const agent = await createReceiverAgent();
    const entries = captureLogs();

    (agent as unknown as {
      getOrCreateSharedMemoryHandler(): {
        handle(data: Uint8Array, fromPeerId: string): Promise<unknown>;
      };
    }).getOrCreateSharedMemoryHandler = () => ({
      handle: async () => ({
        applied: true,
        assetUal: ASSET_UAL,
        cgId: CONTEXT_GRAPH_ID,
        shareOperationId: 'share-op-asset-7',
        publisherPeerId: LOCAL_PEER_ID,
        insertedTriples: 3,
      }),
    });

    await (agent as unknown as {
      handleSwmUpdate(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
    }).handleSwmUpdate(new Uint8Array([1, 2, 3]), PUBLISHER_PEER_ID);

    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_update_applied'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`localPeerId=${LOCAL_PEER_ID}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('localNodeIdentityId=42'),
    );
  });

  it('logs a permanent SWM substrate rejection by assetUal', async () => {
    const agent = await createReceiverAgent();
    const entries = captureLogs();

    (agent as unknown as {
      getOrCreateSharedMemoryHandler(): {
        handle(data: Uint8Array, fromPeerId: string): Promise<unknown>;
      };
    }).getOrCreateSharedMemoryHandler = () => ({
      handle: async () => ({
        applied: false,
        retryable: false,
        assetUal: ASSET_UAL,
        cgId: CONTEXT_GRAPH_ID,
        shareOperationId: 'share-op-asset-7',
        publisherPeerId: PUBLISHER_PEER_ID,
        reason: 'validation rejected payload',
      }),
    });

    await (agent as unknown as {
      handleSwmUpdate(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
    }).handleSwmUpdate(new Uint8Array([1, 2, 3]), PUBLISHER_PEER_ID);

    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_update_rejected'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('outcome=rejected'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('reason="validation rejected payload"'),
    );
  });

  it('threads SWM assetUal from workspace request identity fields', async () => {
    const store = new OxigraphStore();
    let resolverInput: { agentAddress: string; kaNumber: string } | undefined;
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async (input: { agentAddress: string; kaNumber: string }) => {
        resolverInput = input;
        return ASSET_UAL;
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-asset-7',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    const outcome = await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(resolverInput).toEqual({ agentAddress: ethers.getAddress(AUTHOR_AGENT_ADDRESS.toLowerCase()), kaNumber: '7' });
    expect(outcome).toMatchObject({ applied: true, assetUal: ASSET_UAL });
  });

  it('threads SWM assetUal onto validation rejection outcomes', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async () => ASSET_UAL,
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-validation-reject',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        [
          `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle" .`,
          `<http://example.org/ka-lifecycle/stranger> <http://schema.org/name> "Reject me" .`,
        ].join('\n'),
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    const outcome = await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(outcome).toMatchObject({
      applied: false,
      retryable: false,
      assetUal: ASSET_UAL,
      cgId: CONTEXT_GRAPH_ID,
      shareOperationId: 'share-op-validation-reject',
      publisherPeerId: PUBLISHER_PEER_ID,
    });
  });

  it('logs SWM validation failure lifecycle by assetUal', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async () => ASSET_UAL,
      lifecycleLogOptions: {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);
    const entries = captureLogs();

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-validation-lifecycle-fail',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        [
          `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle" .`,
          `<http://example.org/ka-lifecycle/stranger> <http://schema.org/name> "Reject me" .`,
        ].join('\n'),
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_validation_failed'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('outcome=rejected'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('retryable=false'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('validationErrorCount=1'),
    );
  });

  it('logs SWM validation pass lifecycle by assetUal', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async () => ASSET_UAL,
      lifecycleLogOptions: {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);
    const entries = captureLogs();

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-validation-lifecycle-pass',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle validation pass" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_validation_passed'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('outcome=accepted'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('rootEntityCount=1'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('statementCount=1'),
    );
  });

  it('logs SWM durable state change lifecycle by assetUal', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async () => ASSET_UAL,
      lifecycleLogOptions: {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);
    const entries = captureLogs();

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-state-change-lifecycle',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle state change" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_state_changed'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('outcome=applied'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('insertedCount=1'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('shareOperationId=share-op-state-change-lifecycle'),
    );
  });

  it('threads SWM assetUal onto retryable catch outcomes after request identity is decoded', async () => {
    class FailingSwmStore extends OxigraphStore {
      override async insert(quads: Parameters<OxigraphStore['insert']>[0]): Promise<void> {
        if (quads.some((quad) => quad.graph.includes('_shared_memory') && quad.subject === ROOT_ENTITY)) {
          throw new Error('transient SWM store failure');
        }
        await super.insert(quads);
      }
    }
    const store = new FailingSwmStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async () => ASSET_UAL,
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-malformed-retry',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    const outcome = await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(outcome).toMatchObject({
      applied: false,
      retryable: true,
      assetUal: ASSET_UAL,
      cgId: CONTEXT_GRAPH_ID,
      shareOperationId: 'share-op-malformed-retry',
      publisherPeerId: PUBLISHER_PEER_ID,
    });
  });

  it('logs SWM receive lifecycle by assetUal after request identity decode', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async () => ASSET_UAL,
      lifecycleLogOptions: {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);
    const entries = captureLogs();

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-receive-lifecycle',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle receive" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_update_received'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`localPeerId=${LOCAL_PEER_ID}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('localNodeIdentityId=42'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`peer=${PUBLISHER_PEER_ID}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('shareOperationId=share-op-receive-lifecycle'),
    );
  });

  it('does not emit assetUal-scoped SWM receive logs before publisher peer verification', async () => {
    const store = new OxigraphStore();
    const resolveAssetUal = vi.fn(async () => ASSET_UAL);
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: resolveAssetUal,
      lifecycleLogOptions: {
        localPeerId: LOCAL_PEER_ID,
        localNodeIdentityId: 42n,
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);
    const entries = captureLogs();

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-spoofed-peer',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle spoof" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    const outcome = await handler.handle(msg, '12D3KooWAttackerPeer');

    expect(outcome).toMatchObject({
      applied: false,
      retryable: false,
    });
    expect(resolveAssetUal).not.toHaveBeenCalled();
    expect(swmLifecycleLogs(entries).some((entry) =>
      entry.message.includes(`assetUal=${ASSET_UAL}`),
    )).toBe(false);
    expect(swmLifecycleLogs(entries).some((entry) =>
      entry.message.includes('event=swm_update_received'),
    )).toBe(false);
  });

  it('logs SWM Share ACK send by assetUal', async () => {
    const agent = await createReceiverAgent();
    const sent: Array<{ peerId: string; protocol: string; data: Uint8Array }> = [];
    Object.defineProperty(agent, 'messenger', {
      value: {
        sendToPeer: async (peerId: string, protocol: string, data: Uint8Array) => {
          sent.push({ peerId, protocol, data });
          return new Uint8Array();
        },
      },
      configurable: true,
    });
    const entries = captureLogs();

    await (agent as unknown as {
      maybeEmitSwmShareAck(outcome: unknown): Promise<void>;
    }).maybeEmitSwmShareAck({
      applied: true,
      assetUal: ASSET_UAL,
      cgId: CONTEXT_GRAPH_ID,
      shareOperationId: 'share-op-asset-7',
      publisherPeerId: PUBLISHER_PEER_ID,
    });

    expect(sent).toHaveLength(1);
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_share_ack_sent'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`localPeerId=${LOCAL_PEER_ID}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`peer=${PUBLISHER_PEER_ID}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('outcome=sent'),
    );
  });
});
