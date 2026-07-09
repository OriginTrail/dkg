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

describe('ka lifecycle sync reconcile', () => {
  afterEach(() => {
    Logger.setSink(null);
    delete process.env.DKG_DEBUG_KA_LIFECYCLE;
  });

  it('logs chain reconcile promote decisions by assetUal', async () => {
    const agent = await createReceiverAgent();
    const internals = agent as unknown as {
      subscribedContextGraphs: Map<string, { subscribed: boolean; onChainId?: string; lastReconciledOrdinal?: number }>;
      chain: MockChainAdapter & {
        getContextGraphKCCount?: (onChainCgId: bigint) => Promise<number>;
        getBlockNumber?: () => Promise<number | undefined>;
      };
      reconcileChainOrdinal: (
        localCgId: string,
        onChainCgId: bigint,
        ordinal: number,
        headBlock: number | undefined,
      ) => Promise<{ status: 'reconciled'; blockNumber: number; assetUal: string; kaId: string }>;
      runVmReconcileForCg(localCgId: string): Promise<void>;
    };
    internals.subscribedContextGraphs.set(CONTEXT_GRAPH_ID, {
      subscribed: true,
      onChainId: '77',
      lastReconciledOrdinal: 0,
    });
    internals.chain.getContextGraphKCCount = async () => 1;
    internals.chain.getBlockNumber = async () => undefined;
    internals.reconcileChainOrdinal = async () => ({
      status: 'reconciled',
      blockNumber: 12,
      assetUal: ASSET_UAL,
      kaId: '7',
    });
    const entries = captureLogs();

    try {
      await internals.runVmReconcileForCg(CONTEXT_GRAPH_ID);
    } finally {
      await agent.stop().catch(() => undefined);
    }

    const messages = reconcileLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=reconcile_promote'));
    expect(messages).toContainEqual(expect.stringContaining('role=sync'));
    expect(messages).toContainEqual(expect.stringContaining(`localPeerId=${LOCAL_PEER_ID}`));
    expect(messages).toContainEqual(expect.stringContaining('localNodeIdentityId=42'));
    expect(messages).toContainEqual(expect.stringContaining(`contextGraphId=${CONTEXT_GRAPH_ID}`));
    expect(messages).toContainEqual(expect.stringContaining('onChainCgId=77'));
    expect(messages).toContainEqual(expect.stringContaining('ordinal=0'));
    expect(messages).toContainEqual(expect.stringContaining('kaId=7'));
    expect(messages).toContainEqual(expect.stringContaining('action=promote'));
    expect(messages).toContainEqual(expect.stringContaining('result=reconciled'));
  });

  it('logs chain reconcile active fetch decisions by assetUal', async () => {
    const agent = await createReceiverAgent();
    const internals = agent as unknown as {
      chain: MockChainAdapter & {
        getContextGraphKCAt?: (onChainCgId: bigint, ordinal: bigint) => Promise<bigint>;
        getDKGKnowledgeAssetsAddress?: () => Promise<string>;
        getLatestMerkleRoot?: (kaId: bigint) => Promise<Uint8Array>;
        getLatestMerkleRootPublisher?: (kaId: bigint) => Promise<string>;
      };
      getOrCreateFinalizationHandler(): {
        handleChainReconciledKC(): Promise<'no-swm'>;
      };
      collectVmReconcileSwmCandidateState(localCgId: string): Promise<{
        swmGen: string;
        candidateNamespaces: string[];
        peerTopologyKey: string;
      }>;
      syncContextGraphFromConnectedPeers(localCgId: string, options?: unknown): Promise<{
        connectedPeers: number;
        totalPeers: number;
        syncCapablePeers: number;
        peersTried: number;
        peersSucceeded: number;
        sharedMemorySynced: number;
        diagnostics: { sharedMemory: { emptyResponses: number } };
      }>;
      reconcileChainOrdinal(
        localCgId: string,
        onChainCgId: bigint,
        ordinal: number,
        headBlock: number | undefined,
      ): Promise<unknown>;
    };
    internals.chain.getContextGraphKCAt = async () => 7n;
    internals.chain.getDKGKnowledgeAssetsAddress = async () => AUTHOR_AGENT_ADDRESS;
    internals.chain.getLatestMerkleRoot = async () => new Uint8Array(32);
    internals.chain.getLatestMerkleRootPublisher = async () => AUTHOR_AGENT_ADDRESS;
    const expectedUal = buildKnowledgeAssetUal(internals.chain.chainId, AUTHOR_AGENT_ADDRESS, 7n);
    internals.getOrCreateFinalizationHandler = () => ({
      handleChainReconciledKC: async () => 'no-swm',
    });
    internals.collectVmReconcileSwmCandidateState = async () => ({
      swmGen: 'empty:0',
      candidateNamespaces: [],
      peerTopologyKey: '',
    });
    internals.syncContextGraphFromConnectedPeers = async () => ({
      connectedPeers: 1,
      totalPeers: 1,
      syncCapablePeers: 1,
      peersTried: 1,
      peersSucceeded: 0,
      sharedMemorySynced: 0,
      diagnostics: { sharedMemory: { emptyResponses: 1 } },
    });
    const entries = captureLogs();

    try {
      await internals.reconcileChainOrdinal(CONTEXT_GRAPH_ID, 77n, 0, 12);
    } finally {
      await agent.stop().catch(() => undefined);
    }

    const messages = reconcileLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${expectedUal}`));
    expect(messages).toContainEqual(expect.stringContaining('event=reconcile_fetch'));
    expect(messages).toContainEqual(expect.stringContaining('action=fetch'));
    expect(messages).toContainEqual(expect.stringContaining('result=started'));
    expect(messages).toContainEqual(expect.stringContaining(`contextGraphId=${CONTEXT_GRAPH_ID}`));
    expect(messages).toContainEqual(expect.stringContaining('onChainCgId=77'));
    expect(messages).toContainEqual(expect.stringContaining('ordinal=0'));
    expect(messages).toContainEqual(expect.stringContaining('kaId=7'));
  });

  it('logs chain reconcile core-fill decisions by assetUal', async () => {
    const agent = await createReceiverAgent();
    const internals = agent as unknown as {
      subscribedContextGraphs: Map<string, {
        subscribed: boolean;
        coreHosted?: boolean;
        onChainId?: string;
        lastReconciledOrdinal?: number;
      }>;
      chain: MockChainAdapter & {
        getContextGraphKCCount?: (onChainCgId: bigint) => Promise<number>;
        getBlockNumber?: () => Promise<number | undefined>;
      };
      reconcileChainOrdinal: (
        localCgId: string,
        onChainCgId: bigint,
        ordinal: number,
        headBlock: number | undefined,
      ) => Promise<{ status: 'reconciled'; blockNumber: number; assetUal: string; kaId: string }>;
      runVmReconcileForCg(localCgId: string): Promise<void>;
    };
    internals.subscribedContextGraphs.set(CONTEXT_GRAPH_ID, {
      subscribed: false,
      coreHosted: true,
      onChainId: '77',
      lastReconciledOrdinal: 0,
    });
    internals.chain.getContextGraphKCCount = async () => 1;
    internals.chain.getBlockNumber = async () => undefined;
    internals.reconcileChainOrdinal = async () => ({
      status: 'reconciled',
      blockNumber: 12,
      assetUal: ASSET_UAL,
      kaId: '7',
    });
    const entries = captureLogs();

    try {
      await internals.runVmReconcileForCg(CONTEXT_GRAPH_ID);
    } finally {
      await agent.stop().catch(() => undefined);
    }

    const messages = reconcileLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=reconcile_core_fill'));
    expect(messages).toContainEqual(expect.stringContaining('action=core-fill'));
    expect(messages).toContainEqual(expect.stringContaining('result=filled'));
    expect(messages).toContainEqual(expect.stringContaining(`contextGraphId=${CONTEXT_GRAPH_ID}`));
    expect(messages).toContainEqual(expect.stringContaining('onChainCgId=77'));
    expect(messages).toContainEqual(expect.stringContaining('kaId=7'));
  });

  it('logs durable sync receive and apply by assetUal', async () => {
    const agent = await createReceiverAgent();
    const publishedMeta = {
      subject: ASSET_UAL,
      predicate: 'http://dkg.io/ontology/merkleRoot',
      object: `"${'ab'.repeat(32)}"`,
      graph: contextGraphMetaUri(CONTEXT_GRAPH_ID),
    };
    const publishedData = {
      subject: ROOT_ENTITY,
      predicate: 'http://schema.org/name',
      object: '"Synced lifecycle"',
      graph: contextGraphDataUri(CONTEXT_GRAPH_ID),
    };
    const internals = agent as unknown as {
      fetchSyncPages: () => Promise<{
        quads: unknown[];
        bytesReceived: number;
        resumedFromOffset: number;
        nextOffset: number;
        checkpointKey: string;
        completed: boolean;
        timedOut: boolean;
      }>;
      processDurableBatchInWorker: () => Promise<{
        verifiedData: typeof publishedData[];
        verifiedMeta: typeof publishedMeta[];
        totalFetchedDataQuads: number;
        totalFetchedMetaQuads: number;
        rejectedKcs: number;
        emptyResponses: number;
        metaOnlyResponses: number;
        dataRejectedMissingMeta: number;
      }>;
      insertSyncedQuadsAndInvalidateListCache: (quads: unknown[]) => Promise<void>;
      syncFromPeerDetailed(remotePeerId: string, contextGraphIds: string[]): Promise<unknown>;
    };
    internals.fetchSyncPages = async () => ({
      quads: [],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: 'sync-lifecycle-checkpoint',
      completed: true,
      timedOut: false,
    });
    internals.processDurableBatchInWorker = async () => ({
      verifiedData: [publishedData],
      verifiedMeta: [publishedMeta],
      totalFetchedDataQuads: 1,
      totalFetchedMetaQuads: 1,
      rejectedKcs: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });
    internals.insertSyncedQuadsAndInvalidateListCache = async () => undefined;
    const entries = captureLogs();

    try {
      await internals.syncFromPeerDetailed(PUBLISHER_PEER_ID, [CONTEXT_GRAPH_ID]);
    } finally {
      await agent.stop().catch(() => undefined);
    }

    const messages = syncLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=sync_receive'));
    expect(messages).toContainEqual(expect.stringContaining('event=sync_apply'));
    expect(messages).toContainEqual(expect.stringContaining('role=sync'));
    expect(messages).toContainEqual(expect.stringContaining(`localPeerId=${LOCAL_PEER_ID}`));
    expect(messages).toContainEqual(expect.stringContaining('localNodeIdentityId=42'));
    expect(messages).toContainEqual(expect.stringContaining(`peer=${PUBLISHER_PEER_ID}`));
    expect(messages).toContainEqual(expect.stringContaining(`contextGraphId=${CONTEXT_GRAPH_ID}`));
    expect(messages).toContainEqual(expect.stringContaining('action=apply'));
    expect(messages).toContainEqual(expect.stringContaining('result=inserted'));
  });
});
