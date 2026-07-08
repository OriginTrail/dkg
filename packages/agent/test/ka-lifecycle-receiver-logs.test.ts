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
  type FinalizationMessageMsg,
  type LogRecord,
  type OperationContext,
  type SwmSenderKeyMessageAADFields,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageAADFields,
  type SwmSenderKeyPackageMsg,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  SharedMemoryHandler,
  StorageACKHandler,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
} from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { DKGAgent } from '../src/index.js';

const LOCAL_PEER_ID = '12D3KooWKaLifecycleReceiver';
const PUBLISHER_PEER_ID = '12D3KooWPublisherPeer';
const AUTHOR_AGENT_ADDRESS = '0x000000000000000000000000000000000000c10A';
const CONTEXT_GRAPH_ID = 'ka-lifecycle-cg';
const ROOT_ENTITY = 'http://example.org/ka-lifecycle/root';
const ASSET_UAL = 'did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7';

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

describe('KA receiver lifecycle logs', () => {
  afterEach(() => {
    Logger.setSink(null);
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
      expect.stringContaining('reason=validation rejected payload'),
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

  it('logs Sender Key setup receive by assetUal', async () => {
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

    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${assetUal}`),
    );
    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=sender_key_setup_received'),
    );
    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('recipientAgentAddress='),
    );
    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('outcome=accepted'),
    );
  });

  it('logs Sender Key setup decline and ACK-decline by assetUal', async () => {
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
    expect((ack as { assetUal?: string }).assetUal).toBe(ASSET_UAL);

    const messages = senderKeyLifecycleLogs(entries).map((entry) => entry.message);
    expect(messages).toContainEqual(expect.stringContaining('event=sender_key_setup_declined'));
    expect(messages).toContainEqual(expect.stringContaining('event=sender_key_setup_ack_declined'));
    expect(messages).toContainEqual(expect.stringContaining(`assetUal=${ASSET_UAL}`));
    expect(messages).toContainEqual(expect.stringContaining('outcome=declined'));
    expect(messages).toContainEqual(expect.stringContaining('accepted=false'));
    expect(messages).toContainEqual(expect.stringContaining('reasonCode=recipient-not-local'));
    expect(messages).toContainEqual(expect.stringContaining('retryable=false'));
    expect(messages).toContainEqual(expect.stringContaining(`peer=${PUBLISHER_PEER_ID}`));
  });

  it('logs Sender Key decrypt failure by assetUal', async () => {
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

    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${assetUal}`),
    );
    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=sender_key_payload_decrypt_failed'),
    );
    expect(senderKeyLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('reason=No local Sender Key state'),
    );
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
      assetUal: ASSET_UAL,
    } as unknown as Parameters<typeof encodePublishIntent>[0]);

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
      assetUal: ASSET_UAL,
    } as unknown as Parameters<typeof encodePublishIntent>[0]);

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
      expect.stringContaining('declineMessage=No data found in SWM'),
    );
    expect(storageAckLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('retryable=true'),
    );
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
      expect.stringContaining('reason=no shared memory data'),
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
    expect(messages).toContainEqual(expect.stringContaining('reason=SWM finalization slice unavailable'));
  });
});
