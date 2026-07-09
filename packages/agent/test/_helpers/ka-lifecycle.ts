import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { MockChainAdapter, buildKnowledgeAssetUal } from '@origintrail-official/dkg-chain';
import {
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
  generateSwmSenderChainKey,
  generateSwmSenderEpochId,
  generateWorkspaceRecipientEncryptionKey,
  isStorageACKDecline,
  type FinalizationMessageMsg,
  type LogRecord,
  type OperationContext,
  type SwmSenderKeyMessageMsg,
  type SwmSenderKeyPackageMsg,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  SharedMemoryHandler,
  StorageACKHandler,
  createStorageAckLifecycleObserver,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
  type V10ACKProviderParams,
  type V10CoreNodeACK,
} from '@origintrail-official/dkg-publisher';
import { FinalizationHandler } from '../../src/finalization-handler.js';
import { DKGAgent } from '../../src/index.js';
import { resolveStorageAckLifecycleAssetUalFromLocalSwm } from '../../src/dkg-agent-lifecycle.js';
import { makeTestKaAllocator } from '../../../publisher/test/_helpers/ka-allocator.js';
import { mockSealCtx, wrapPublisherForTest } from '../../../publisher/test/_helpers/seal.js';

export const LOCAL_PEER_ID = '12D3KooWKaLifecycleReceiver';
export const PUBLISHER_PEER_ID = '12D3KooWPublisherPeer';
export const AUTHOR_AGENT_ADDRESS = '0x000000000000000000000000000000000000c10A';
export const CONTEXT_GRAPH_ID = 'ka-lifecycle-cg';
export const ROOT_ENTITY = 'http://example.org/ka-lifecycle/root';
export const ASSET_UAL = 'did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7';
export const CONNECTED_CONTEXT_GRAPH_ID = '42';
export const PUBLISHER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export async function createReceiverAgent(): Promise<DKGAgent> {
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

export function captureLogs(): LogRecord[] {
  const entries: LogRecord[] = [];
  Logger.setSink((entry) => entries.push(entry));
  return entries;
}

export function readOptionalUtf8(path: URL): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function swmLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=swm_share')
  ));
}

export function senderKeyLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=sender_key')
  ));
}

export function storageAckLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=storage_ack')
  ));
}

export function finalizationLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=finalization')
  ));
}

export function reconcileLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=reconcile')
  ));
}

export function syncLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=sync')
  ));
}

export function publishQuad(contextGraphId: string, subject: string, predicate: string, object: string): Quad {
  return {
    subject,
    predicate,
    object,
    graph: `did:dkg:context-graph:${contextGraphId}`,
  };
}

export function bytes(value: Uint8Array | number[] | undefined): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
}

export async function insertAgentGate(
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

export async function buildSenderKeyPackage(input: {
  contextGraphId: string;
  senderWallet: ethers.HDNodeWallet;
  recipientAgentAddress: string;
  recipientKeyId: string;
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
  });
  pkg.signature = ethers.getBytes(
    await input.senderWallet.signMessage(computeSwmSenderKeyPackageAAD(pkg)),
  );
  return pkg;
}

export function makeFinalizationMessage(overrides: Partial<FinalizationMessageMsg> = {}): FinalizationMessageMsg {
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

export function finalizationChainWithEvent(input: {
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

export function finalizationChainResolvingTarget(targetContextGraphId = '42') {
  return {
    chainId: '31337',
    getKAContextGraphId: async () => BigInt(targetContextGraphId),
    async *listenForEvents() {},
  };
}

export async function insertFinalizationSharedMemory(
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


export {
  readFileSync,
  ethers,
  MockChainAdapter,
  buildKnowledgeAssetUal,
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
};

export type {
  FinalizationMessageMsg,
  LogRecord,
  OperationContext,
  SwmSenderKeyMessageMsg,
  SwmSenderKeyPackageMsg,
  Quad,
  V10ACKProviderParams,
  V10CoreNodeACK,
};
