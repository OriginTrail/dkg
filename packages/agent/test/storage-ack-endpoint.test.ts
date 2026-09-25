import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  encodePublishIntent,
  generateEd25519Keypair,
  isStorageACKDecline,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, StorageACKHandler, computeFlatKCRootV10, computeFlatKCMerkleLeafCountV10, resolveKnowledgeAssetWorkspaceHead, type LocalStorageAckHeadExpectation } from '@origintrail-official/dkg-publisher';
import { registerStorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';

const PROTOCOLS = [
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK_V2,
] as const;
const execution = (response: Promise<Uint8Array>) => ({ response, completion: response });

describe('StorageACK endpoint request origin', () => {
  it('hands peer streams to the handler as remote and the local dispatch as local', async () => {
    const routes = new Map<string, (data: Uint8Array, peerId: string) => Promise<Uint8Array>>();
    const calls: Array<{
      kind: 'publish' | 'update';
      peerId: string;
      signal: AbortSignal | undefined;
      origin: 'remote' | 'local';
    }> = [];
    const endpoint = registerStorageACKEndpoint({
      registerGroup: (entries) => {
        for (const entry of entries) routes.set(entry.protocolId, entry.handler);
        return () => routes.clear();
      },
      publish: async (_data, peerId) => {
        calls.push({ kind: 'publish', peerId, signal: undefined, origin: 'remote' });
        return new Uint8Array([1]);
      },
      update: async (_data, peerId) => {
        calls.push({ kind: 'update', peerId, signal: undefined, origin: 'remote' });
        return new Uint8Array([2]);
      },
      publishLocal: (_data, peerId, signal) => {
        calls.push({ kind: 'publish', peerId, signal, origin: 'local' });
        return execution(Promise.resolve(new Uint8Array([1])));
      },
      updateLocal: (_data, peerId, signal) => {
        calls.push({ kind: 'update', peerId, signal, origin: 'local' });
        return execution(Promise.resolve(new Uint8Array([2])));
      },
    });
    const request = new Uint8Array([7]);
    const signal = new AbortController().signal;

    for (const protocol of PROTOCOLS) await routes.get(protocol)!(request, 'remote-core');
    for (const protocol of PROTOCOLS) await endpoint.dispatch({ protocol, data: request, peerId: 'this-core', signal }).response;

    const kinds = ['publish', 'publish', 'update', 'update'] as const;
    expect(calls).toEqual([
      ...kinds.map((kind) => ({ kind, peerId: 'remote-core', signal: undefined, origin: 'remote' })),
      ...kinds.map((kind) => ({ kind, peerId: 'this-core', signal, origin: 'local' })),
    ]);

    endpoint.dispose();
    expect(routes.size).toBe(0);
    expect(() => endpoint.dispatch({ protocol: PROTOCOL_STORAGE_ACK, data: request, peerId: 'this-core' }))
      .toThrow(/StorageACK handler is not registered/);
  });
});

describe('StorageACK endpoint persistence decisions', () => {
  const swmId = 'endpoint-head-plan';
  const author = '0x1111111111111111111111111111111111111111';
  const ual = `did:dkg:otp:20430/${author}/7`;
  const publisherPeerId = 'self-core';
  const quads = [
    { subject: 'urn:entity:endpoint', predicate: 'urn:p:value', object: '"same"', graph: '' },
  ];
  const graph = knowledgeAssetLayerGraphUri(swmId, MemoryLayer.SharedWorkingMemory, createGraphKnowledgeAssetScope(ual, 1));
  const stagingQuads = new TextEncoder().encode(`<urn:entity:endpoint> <urn:p:value> "same" <${graph}> .`);
  const intent = encodePublishIntent({
    merkleRoot: computeFlatKCRootV10(quads, []),
    contextGraphId: '42',
    swmGraphId: swmId,
    publisherPeerId,
    publicByteSize: stagingQuads.length,
    isPrivate: false,
    kaCount: 1,
    rootEntities: [],
    merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
    stagingQuads,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    accessPolicy: 'allowList',
    allowedPeers: ['reader'],
  });

  async function setup() {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: { chainId: 'none' } as never,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const signerWallet = ethers.Wallet.createRandom();
    const handler = new StorageACKHandler(store, {
      nodeRole: 'core',
      nodeIdentityId: 17n,
      signerWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: 31337n,
      kav10Address: '0x000000000000000000000000000000000000c10a',
      workspaceWriteLocks: publisher.writeLocks,
      ensureVmPromotion: async () => ({ ok: true }),
    }, new TypedEventBus());
    const routes = new Map<string, (data: Uint8Array, peerId: string) => Promise<Uint8Array>>();
    const peer = (peerId: string) => ({ toString: () => peerId });
    const endpoint = registerStorageACKEndpoint({
      registerGroup: (entries) => {
        for (const entry of entries) routes.set(entry.protocolId, entry.handler);
        return () => routes.clear();
      },
      publish: (data, peerId) => handler.handler(data, peer(peerId)),
      update: (data, peerId) => handler.updateHandler(data, peer(peerId)),
      publishLocal: (data, peerId, signal, context) => handler.localExecution(data, peer(peerId), signal,
        context as LocalStorageAckHeadExpectation | undefined),
      updateLocal: (data, peerId, signal, context) => handler.localUpdateExecution(data, peer(peerId), signal,
        context as LocalStorageAckHeadExpectation | undefined),
    });
    const stage = (shareOperationId: string) => publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId: swmId,
      kaUal: ual,
      assertionVersion: '1',
      shareOperationId,
      quads,
      privateTripleCount: 0,
      publisherPeerId,
      accessPolicy: 'allowList' as const,
      allowedPeers: ['reader'],
      agentAddress: author,
      timestamp: new Date('2026-09-24T12:00:00.000Z'),
    });
    const head = () => resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager: new GraphManager(store),
      contextGraphId: swmId,
      kaUal: ual,
    });
    const expectedHead = {
      shareOperationId: 'queued-share',
      publisherPeerId,
      kaUal: ual,
      assertionVersion: '1',
      accessPolicy: 'allowList' as const,
      allowedPeers: ['reader'],
    };
    return { endpoint, routes, stage, head, expectedHead };
  }

  it('preserves the exact queued head on local dispatch', async () => {
    const h = await setup();
    await h.stage('queued-share');
    const before = await h.head();
    const ack = decodeStorageACK(await h.endpoint.dispatch({ protocol: PROTOCOL_STORAGE_ACK, data: intent,
      peerId: publisherPeerId, context: h.expectedHead }).response);
    expect(isStorageACKDecline(ack)).toBe(false);
    expect(await h.head()).toEqual(before);
    h.endpoint.dispose();
  });

  it.each(['remote', 'direct-local'] as const)('replaces the head on %s dispatch', async (source) => {
    const h = await setup();
    await h.stage('queued-share');
    const response = source === 'remote'
      ? await h.routes.get(PROTOCOL_STORAGE_ACK)!(intent, 'remote-core')
      : await h.endpoint.dispatch({ protocol: PROTOCOL_STORAGE_ACK, data: intent, peerId: publisherPeerId }).response;
    expect(isStorageACKDecline(decodeStorageACK(response))).toBe(false);
    expect((await h.head())?.shareOperationId).toMatch(/^storage-ack-/);
    h.endpoint.dispose();
  });

  it('declines a stale queued head after a same-content operation change', async () => {
    const h = await setup();
    await h.stage('queued-share');
    await h.stage('replacement-share');
    const before = await h.head();
    const ack = decodeStorageACK(await h.endpoint.dispatch({ protocol: PROTOCOL_STORAGE_ACK, data: intent,
      peerId: publisherPeerId, context: h.expectedHead }).response);
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(await h.head()).toEqual(before);
    h.endpoint.dispose();
  });
});
