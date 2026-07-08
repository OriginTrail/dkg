import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  Logger,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
  computeSwmSenderKeyMessageAAD,
  computeSwmSenderKeyPackageAAD,
  computeSwmSenderKeyPackageEncryptionAAD,
  contextGraphDataUri,
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
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  generateWorkspaceRecipientEncryptionKey,
  isStorageACKDecline,
  type FinalizationMessageMsg,
  type LogRecord,
  type OperationContext,
  type SwmSenderKeyMessageAADFields,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageAADFields,
  type SwmSenderKeyPackageMsg,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  SharedMemoryHandler,
  StorageACKHandler,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
  type V10ACKProviderParams,
  type V10CoreNodeACK,
} from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { DKGAgent } from '../src/index.js';
import { makeTestKaAllocator } from '../../publisher/test/_helpers/ka-allocator.js';
import { mockSealCtx, wrapPublisherForTest } from '../../publisher/test/_helpers/seal.js';

const LOCAL_PEER_ID = '12D3KooWKaLifecycleReceiver';
const PUBLISHER_PEER_ID = '12D3KooWPublisherPeer';
const AUTHOR_AGENT_ADDRESS = '0x000000000000000000000000000000000000c10A';
const CONTEXT_GRAPH_ID = 'ka-lifecycle-cg';
const ROOT_ENTITY = 'http://example.org/ka-lifecycle/root';
const ASSET_UAL = 'did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7';
const CONNECTED_CONTEXT_GRAPH_ID = '42';
const PUBLISHER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

async function createReceiverAgent(): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: `ka-lifecycle-receiver-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
  });
  Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
    value: LOCAL_PEER_ID,
    configurable: true,
  });
  agent.publisher.setIdentityId(42n);
  return agent;
}

function captureLogs(): LogRecord[] {
  const entries: LogRecord[] = [];
  Logger.setSink((entry) => entries.push(entry));
  return entries;
}

function readOptionalUtf8(path: URL): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function swmLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=swm_share')
  ));
}

function senderKeyLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=sender_key')
  ));
}

function storageAckLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=storage_ack')
  ));
}

function finalizationLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=finalization')
  ));
}

function reconcileLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=reconcile')
  ));
}

function syncLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=sync')
  ));
}

function publishQuad(contextGraphId: string, subject: string, predicate: string, object: string): Quad {
  return {
    subject,
    predicate,
    object,
    graph: `did:dkg:context-graph:${contextGraphId}`,
  };
}

function bytes(value: Uint8Array | number[] | undefined): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
}

async function insertAgentGate(
  agent: DKGAgent,
  contextGraphId: string,
  agentAddress: string,
): Promise<void> {
  await agent.store.insert([{
    subject: contextGraphDataUri(contextGraphId),
    predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    object: `"${agentAddress}"`,
    graph: contextGraphMetaUri(contextGraphId),
  }]);
}

async function buildSenderKeyPackage(input: {
  contextGraphId: string;
  senderWallet: ethers.HDNodeWallet;
  recipientAgentAddress: string;
  recipientKeyId: string;
  assetUal: string;
}): Promise<SwmSenderKeyPackageMsg> {
  const signingKeypair = await generateEd25519Keypair();
  const recipientPublicKey = generateWorkspaceRecipientEncryptionKey(
    `did:dkg:agent:${input.recipientAgentAddress}`,
    input.recipientKeyId,
  ).publicKeyBytes!;
  const pkg = await encryptSwmSenderKeyPackage({
    contextGraphId: input.contextGraphId,
    senderAgentAddress: input.senderWallet.address,
    epochId: generateSwmSenderEpochId(),
    membershipHash: 'sha256:ka-lifecycle-sender-key-decline',
    recipientAgentAddress: input.recipientAgentAddress,
    recipientKeyId: input.recipientKeyId,
    createdAtMs: Date.now(),
    initialMessageIndex: 0,
    chainKey: generateSwmSenderChainKey(),
    senderSigningPublicKey: signingKeypair.publicKey,
    recipientPublicKey,
    assetUal: input.assetUal,
  });
  pkg.signature = ethers.getBytes(
    await input.senderWallet.signMessage(computeSwmSenderKeyPackageAAD(pkg)),
  );
  return pkg;
}

function makeFinalizationMessage(overrides: Partial<FinalizationMessageMsg> = {}): FinalizationMessageMsg {
  return {
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
    ...overrides,
  };
}

function finalizationChainWithEvent(input: {
  txHash: string;
  blockNumber: number;
  merkleRoot: Uint8Array;
  publisherAddress: string;
  startKAId: bigint;
  endKAId: bigint;
}) {
  return {
    chainId: '31337',
    isV10Ready: () => true,
    async *listenForEvents() {
      yield {
        blockNumber: input.blockNumber,
        data: {
          txHash: input.txHash,
          merkleRoot: ethers.hexlify(input.merkleRoot),
          publisherAddress: input.publisherAddress,
          startKAId: input.startKAId.toString(),
          endKAId: input.endKAId.toString(),
          author: AUTHOR_AGENT_ADDRESS,
          txIndex: 0,
        },
      };
    },
  };
}

function finalizationChainResolvingTarget(targetContextGraphId = '42') {
  return {
    chainId: '31337',
    getKAContextGraphId: async () => BigInt(targetContextGraphId),
    async *listenForEvents() {},
  };
}

async function insertFinalizationSharedMemory(
  store: OxigraphStore,
  rootEntity: string,
  label: string,
): Promise<Uint8Array> {
  const swmQuads = [{
    subject: rootEntity,
    predicate: 'http://schema.org/name',
    object: JSON.stringify(label),
    graph: contextGraphWorkspaceGraphUri(CONTEXT_GRAPH_ID),
  }];
  await store.insert(swmQuads);
  return computeFlatKCRootV10(
    swmQuads.map((quad) => ({ ...quad, graph: '' })),
    [],
  );
}

describe('KA receiver lifecycle logs', () => {
  afterEach(() => {
    Logger.setSink(null);
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
      localPeerId: LOCAL_PEER_ID,
      ackHandlerDeadlineMs: 0,
      resolveAssetUalForPublishIntent: async () => {
        if (!connectedAssetUal) throw new Error('connected ACK provider has not supplied assetUal');
        return connectedAssetUal;
      },
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

    const syncAgent = await createReceiverAgent();
    const reconcileAgent = await createReceiverAgent();
    try {
      const syncInternals = syncAgent as unknown as {
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
          verifiedData: Quad[];
          verifiedMeta: Quad[];
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
      const publishedMeta = {
        subject: result.ual,
        predicate: 'http://dkg.io/ontology/merkleRoot',
        object: `"${ethers.hexlify(result.merkleRoot).slice(2)}"`,
        graph: contextGraphMetaUri(CONNECTED_CONTEXT_GRAPH_ID),
      };
      const publishedData = publishQuad(
        CONNECTED_CONTEXT_GRAPH_ID,
        ROOT_ENTITY,
        'http://schema.org/name',
        '"Connected lifecycle proof"',
      );
      syncInternals.fetchSyncPages = async () => ({
        quads: [],
        bytesReceived: 1,
        resumedFromOffset: 0,
        nextOffset: 1,
        checkpointKey: 'connected-sync-checkpoint',
        completed: true,
        timedOut: false,
      });
      syncInternals.processDurableBatchInWorker = async () => ({
        verifiedData: [publishedData],
        verifiedMeta: [publishedMeta],
        totalFetchedDataQuads: 1,
        totalFetchedMetaQuads: 1,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      });
      syncInternals.insertSyncedQuadsAndInvalidateListCache = async () => undefined;
      await syncInternals.syncFromPeerDetailed(PUBLISHER_PEER_ID, [CONNECTED_CONTEXT_GRAPH_ID]);

      const reconcileInternals = reconcileAgent as unknown as {
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
      reconcileInternals.subscribedContextGraphs.set(CONNECTED_CONTEXT_GRAPH_ID, {
        subscribed: true,
        onChainId: CONNECTED_CONTEXT_GRAPH_ID,
        lastReconciledOrdinal: 0,
      });
      reconcileInternals.chain.getContextGraphKCCount = async () => 1;
      reconcileInternals.chain.getBlockNumber = async () => undefined;
      reconcileInternals.reconcileChainOrdinal = async () => ({
        status: 'reconciled',
        blockNumber: onChain.blockNumber,
        assetUal: result.ual,
        kaId: result.kaId.toString(),
      });
      await reconcileInternals.runVmReconcileForCg(CONNECTED_CONTEXT_GRAPH_ID);
    } finally {
      await syncAgent.stop().catch(() => undefined);
      await reconcileAgent.stop().catch(() => undefined);
    }

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
      'sync',
      'reconcile',
    ]);
    expect((proof as { roleTrail?: string[] }).roleTrail).toEqual(['publisher', 'receiver', 'sync']);
    expect((proof as { sourceTrail?: string[] }).sourceTrail).toEqual(expect.arrayContaining([
      PUBLISHER_PEER_ID,
      LOCAL_PEER_ID,
    ]));
    expect(proof.eventTrail).toContain('storage_ack_signed');
    expect(proof.eventTrail).toContain('finalization_applied');
    expect(proof.eventTrail).toContain('sync_apply');
    expect(proof.eventTrail).toContain('reconcile_promote');
    expect(proof.hasAckLog).toBe(true);
    expect(proof.hasStateChangeLog).toBe(true);
    expect(proof.hasFailureOrDeclineLog).toBe(true);
    expect(proof.hasPayloadLeak).toBe(false);
    expect(proof.grep).toContain(`assetUal=${result.ual}`);
    expect(proof.grep).toContain('localPeerId=12D3KooWKaLifecycleReceiver');
    expect(proof.grep).not.toContain('Connected lifecycle proof');
    expect(proof.entries.map((entry) => entry.module)).toEqual(expect.arrayContaining([
      'DKGPublisher',
      'SharedMemoryHandler',
      'StorageACKHandler',
      'FinalizationHandler',
      'DKGAgent',
    ]));
  });

  it('documents the KA lifecycle log proof handoff sources and grep surface', () => {
    const handoff = readOptionalUtf8(new URL('../../../docs/use-dkg/ka-publish-lifecycle-log-proof.md', import.meta.url));

    expect(handoff).toBeDefined();
    if (!handoff) return;
    expect(handoff).toContain('CONTEXT.md');
    expect(handoff).toContain('docs/adr/0001-log-ka-publish-lifecycle-by-asset-ual.md');
    expect(handoff).toContain('grep');
    expect(handoff).toContain('ka_lifecycle');
    expect(handoff).toContain('assetUal');
    expect(handoff).toContain('identity');
    expect(handoff).toContain('storage_ack');
    expect(handoff).toContain('finalization');
    expect(handoff).toContain('sync');
    expect(handoff).toContain('reconcile');
    expect(handoff).toContain('raw payload');
    expect(handoff).toContain('## Recorded Devnet Grep Evidence');
    expect(handoff).toContain('.devnet/node1/daemon.log: ka_lifecycle');
    expect(handoff).toContain('.devnet/node2/daemon.log: ka_lifecycle');
    expect(handoff).toContain('stage=identity event=asset_ual_allocated role=publisher');
    expect(handoff).toContain('stage=storage_ack event=storage_ack_signed role=receiver');
    expect(handoff).toContain('stage=finalization event=finalization_applied role=receiver');
    expect(handoff).toContain('stage=sync event=sync_apply role=sync');
    expect(handoff).toContain('stage=reconcile event=reconcile_promote role=sync');
  });

  it('keeps Sender Key v1 cryptographic binding compatible when assetUal is carried for logs', () => {
    const packageFields: SwmSenderKeyPackageAADFields = {
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: 'sender-key-compat',
      senderAgentAddress: AUTHOR_AGENT_ADDRESS,
      epochId: 'sender-key-compat-epoch',
      membershipHash: 'sha256:sender-key-compat',
      recipientAgentAddress: '0x000000000000000000000000000000000000c20A',
      recipientKeyId: 'did:dkg:agent:0x000000000000000000000000000000000000c20A#x25519',
      createdAtMs: 1_770_000_000_000,
      initialMessageIndex: 0,
      senderSigningPublicKey: new Uint8Array(32).fill(1),
      ephemeralPublicKey: new Uint8Array(32).fill(2),
      nonce: new Uint8Array(12).fill(3),
      ciphertext: new Uint8Array(48).fill(4),
    };
    const messageFields: SwmSenderKeyMessageAADFields = {
      contextGraphId: CONTEXT_GRAPH_ID,
      subGraphName: 'sender-key-compat',
      senderAgentAddress: AUTHOR_AGENT_ADDRESS,
      epochId: 'sender-key-compat-epoch',
      membershipHash: 'sha256:sender-key-compat',
      messageIndex: 7,
      nonce: new Uint8Array(12).fill(5),
    };

    expect(computeSwmSenderKeyPackageAAD({ ...packageFields, assetUal: ASSET_UAL }))
      .toEqual(computeSwmSenderKeyPackageAAD(packageFields));
    expect(computeSwmSenderKeyPackageEncryptionAAD({ ...packageFields, assetUal: ASSET_UAL }))
      .toEqual(computeSwmSenderKeyPackageEncryptionAAD(packageFields));
    expect(computeSwmSenderKeyMessageAAD({ ...messageFields, assetUal: ASSET_UAL }))
      .toEqual(computeSwmSenderKeyMessageAAD(messageFields));
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

    expect(resolverInput).toEqual({ agentAddress: AUTHOR_AGENT_ADDRESS, kaNumber: '7' });
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

  it('logs Sender Key payload decrypt by assetUal', async () => {
    const agent = await DKGAgent.create({
      name: `ka-lifecycle-sender-key-${Math.random().toString(36).slice(2)}`,
      chainAdapter: new MockChainAdapter(),
    });
    agent.publisher.setIdentityId(42n);
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => LOCAL_PEER_ID },
      configurable: true,
    });
    const localRecord = await agent.registerAgent('sender-key-local');
    const contextGraphId = 'ka-lifecycle-sender-key-cg';
    await insertAgentGate(agent, contextGraphId, localRecord.agentAddress);

    const storageAddress = await agent.chain.getDKGKnowledgeAssetsAddress!();
    const kaId = (BigInt(ethers.getAddress(localRecord.agentAddress)) << 96n) | 7n;
    const assetUal = buildKnowledgeAssetUal(agent.chain.chainId, storageAddress, kaId);
    const plaintext = encodeWorkspacePublishRequest({
      shareOperationId: 'sender-key-share-op',
      contextGraphId,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Sender Key lifecycle" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: localRecord.agentAddress,
      kaNumber: '7',
    });
    const internals = agent as unknown as {
      encryptWorkspacePayloadWithSenderKey(input: {
        contextGraphId: string;
        plaintext: Uint8Array;
        senderAgentAddress: string;
        operationId: string;
      }): Promise<Uint8Array>;
      decryptWorkspacePayloadWithSenderKey(
        message: SwmSenderKeyMessageMsg,
        contextGraphId: string,
        ctx: OperationContext,
      ): Promise<Uint8Array>;
    };
    const encrypted = await internals.encryptWorkspacePayloadWithSenderKey({
      contextGraphId,
      plaintext,
      senderAgentAddress: localRecord.agentAddress,
      operationId: 'sender-key-lifecycle-test',
    });
    const message = decodeSwmSenderKeyMessage(encrypted);
    const entries = captureLogs();

    await internals.decryptWorkspacePayloadWithSenderKey(
      message,
      contextGraphId,
      { operationId: 'sender-key-lifecycle-test', operationName: 'share' },
    );

    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${assetUal}`),
    );
    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=sender_key_payload_decrypted'),
    );
  expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('role=receiver'),
    );
  });

  it('does not log Sender Key setup receive by unauthenticated package assetUal', async () => {
    const agent = await DKGAgent.create({
      name: `ka-lifecycle-sender-key-setup-${Math.random().toString(36).slice(2)}`,
      chainAdapter: new MockChainAdapter(),
    });
    agent.publisher.setIdentityId(42n);
    Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => LOCAL_PEER_ID },
      configurable: true,
    });
    const localRecord = await agent.registerAgent('sender-key-setup-local');
    const contextGraphId = 'ka-lifecycle-sender-key-setup-cg';
    await insertAgentGate(agent, contextGraphId, localRecord.agentAddress);

    const storageAddress = await agent.chain.getDKGKnowledgeAssetsAddress!();
    const kaId = (BigInt(ethers.getAddress(localRecord.agentAddress)) << 96n) | 7n;
    const assetUal = buildKnowledgeAssetUal(agent.chain.chainId, storageAddress, kaId);
    const plaintext = encodeWorkspacePublishRequest({
      shareOperationId: 'sender-key-setup-share-op',
      contextGraphId,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Sender Key setup lifecycle" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: localRecord.agentAddress,
      kaNumber: '7',
    });
    const entries = captureLogs();

    await (agent as unknown as {
      encryptWorkspacePayloadWithSenderKey(input: {
        contextGraphId: string;
        plaintext: Uint8Array;
        senderAgentAddress: string;
        operationId: string;
      }): Promise<Uint8Array>;
    }).encryptWorkspacePayloadWithSenderKey({
      contextGraphId,
      plaintext,
      senderAgentAddress: localRecord.agentAddress,
      operationId: 'sender-key-setup-lifecycle-test',
    });

    expect(senderKeyLifecycleLogs(entries).some((entry) =>
      entry.message.includes(`assetUal=${assetUal}`),
    )).toBe(false);
    expect(senderKeyLifecycleLogs(entries).some((entry) =>
      entry.message.includes('event=sender_key_setup_received'),
    )).toBe(false);
  });

  it('does not log Sender Key setup decline by unauthenticated package assetUal', async () => {
    const agent = await createReceiverAgent();
    const senderWallet = ethers.Wallet.createRandom();
    const recipientWallet = ethers.Wallet.createRandom();
    const contextGraphId = 'ka-lifecycle-sender-key-decline-cg';
    const recipientKeyId =
      `did:dkg:agent:${recipientWallet.address.toLowerCase()}#x25519-decline`;
    const internals = agent as unknown as {
      getContextGraphAgentGateAddresses(contextGraphId: string): Promise<string[] | null>;
      handleSwmSenderKeyPackage(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
    };
    internals.getContextGraphAgentGateAddresses = async () => [
      senderWallet.address,
      recipientWallet.address,
    ];
    const pkg = await buildSenderKeyPackage({
      contextGraphId,
      senderWallet,
      recipientAgentAddress: recipientWallet.address,
      recipientKeyId,
      assetUal: ASSET_UAL,
    });
    const entries = captureLogs();

    const response = await internals.handleSwmSenderKeyPackage(
      encodeSwmSenderKeyPackage(pkg),
      PUBLISHER_PEER_ID,
    );
    const ack = decodeSwmSenderKeyPackageAck(response);

    expect(ack.accepted).toBe(false);
    expect(ack.reasonCode).toBe('recipient-not-local');
    expect((ack as { assetUal?: string }).assetUal).toBeUndefined();

    const messages = senderKeyLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages.some((message) => message.includes(`assetUal=${ASSET_UAL}`))).toBe(false);
    expect(messages.some((message) => message.includes('event=sender_key_setup_declined'))).toBe(false);
    expect(messages.some((message) => message.includes('event=sender_key_setup_ack_declined'))).toBe(false);
  });

  it('does not log Sender Key decrypt failure by unauthenticated message assetUal', async () => {
    const sender = await DKGAgent.create({
      name: `ka-lifecycle-sender-key-fail-${Math.random().toString(36).slice(2)}`,
      chainAdapter: new MockChainAdapter(),
    });
    sender.publisher.setIdentityId(42n);
    Object.defineProperty((sender as unknown as { node: object }).node, 'peerId', {
      value: { toString: () => LOCAL_PEER_ID },
      configurable: true,
    });
    const senderRecord = await sender.registerAgent('sender-key-fail-local');
    const contextGraphId = 'ka-lifecycle-sender-key-fail-cg';
    await insertAgentGate(sender, contextGraphId, senderRecord.agentAddress);

    const storageAddress = await sender.chain.getDKGKnowledgeAssetsAddress!();
    const kaId = (BigInt(ethers.getAddress(senderRecord.agentAddress)) << 96n) | 7n;
    const assetUal = buildKnowledgeAssetUal(sender.chain.chainId, storageAddress, kaId);
    const plaintext = encodeWorkspacePublishRequest({
      shareOperationId: 'sender-key-fail-share-op',
      contextGraphId,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Sender Key failure lifecycle" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: senderRecord.agentAddress,
      kaNumber: '7',
    });
    const encrypted = await (sender as unknown as {
      encryptWorkspacePayloadWithSenderKey(input: {
        contextGraphId: string;
        plaintext: Uint8Array;
        senderAgentAddress: string;
        operationId: string;
      }): Promise<Uint8Array>;
    }).encryptWorkspacePayloadWithSenderKey({
      contextGraphId,
      plaintext,
      senderAgentAddress: senderRecord.agentAddress,
      operationId: 'sender-key-failure-lifecycle-test',
    });
    const message = decodeSwmSenderKeyMessage(encrypted);

    const receiver = await createReceiverAgent();
    const entries = captureLogs();

    await expect((receiver as unknown as {
      decryptWorkspacePayloadWithSenderKey(
        message: SwmSenderKeyMessageMsg,
        contextGraphId: string,
        ctx: OperationContext,
      ): Promise<Uint8Array>;
    }).decryptWorkspacePayloadWithSenderKey(
      message,
      contextGraphId,
      { operationId: 'sender-key-failure-lifecycle-test', operationName: 'share' },
    )).rejects.toThrow(/No local Sender Key state/);

    expect(senderKeyLifecycleLogs(entries).some((entry) =>
      entry.message.includes(`assetUal=${assetUal}`),
    )).toBe(false);
    expect(senderKeyLifecycleLogs(entries).some((entry) =>
      entry.message.includes('event=sender_key_payload_decrypt_failed'),
    )).toBe(false);
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

  it('logs rejected finalization by assetUal', async () => {
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
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('event=finalization_rejected'));
    expect(messages).toContainEqual(expect.stringContaining('outcome=rejected'));
    expect(messages).toContainEqual(expect.stringContaining('retryable=false'));
    expect(messages).toContainEqual(
      expect.stringContaining('reason="contextGraphId'),
    );
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
