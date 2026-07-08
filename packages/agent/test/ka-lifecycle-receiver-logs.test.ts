import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  Logger,
  TypedEventBus,
  contextGraphDataUri,
  contextGraphMetaUri,
  decodeSwmSenderKeyMessage,
  encodeFinalizationMessage,
  encodePublishIntent,
  encodeWorkspacePublishRequest,
  type LogRecord,
  type OperationContext,
  type SwmSenderKeyMessageMsg,
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

describe('KA receiver lifecycle logs', () => {
  afterEach(() => {
    Logger.setSink(null);
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
});
