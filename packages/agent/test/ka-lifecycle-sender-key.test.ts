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

describe('ka lifecycle sender key', () => {
  afterEach(() => {
    Logger.setSink(null);
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

  it('does not log Sender Key setup decline without authenticated assetUal evidence', async () => {
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
});
