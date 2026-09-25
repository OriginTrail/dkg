import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  decodeStorageACK,
  isStorageACKDecline,
  TypedEventBus,
  encodePublishIntent,
  encodeUpdateIntent,
} from '@origintrail-official/dkg-core';
import {
  StorageACKHandler,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
  type LocalStorageAckHeadExpectation,
} from '@origintrail-official/dkg-publisher';
import type { QueryOptions, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent, MockChainAdapter, OxigraphStore } from './agent.shared';
import { registerStorageACKEndpoint, type StorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';
import { LocalStorageACKDrainTimeoutError, LocalStorageACKTransport } from '../src/p2p/local-storage-ack-transport.js';
import { StorageACKRegistrationRuntime } from '../src/p2p/storage-ack-registration-runtime.js';
import { installStorageACKFixtureEndpoint } from './_helpers/storage-ack-endpoint-fixture.js';

const graph = 'did:dkg:context-graph:42/_shared_memory';
const quads: Quad[] = [
  { subject: 'urn:entity:1', predicate: 'urn:p', object: 'urn:o1', graph },
  { subject: 'urn:entity:1', predicate: 'urn:p', object: 'urn:o2', graph },
];

type LocalAgent = DKGAgent & {
  peerId: string;
  storageACKRegistrationRuntime: StorageACKRegistrationRuntime;
  createACKTransportFactory(options: { sendTimeoutMs: number }): () => {
    sendP2P(peerId: string, protocol: string, data: Uint8Array): Promise<Uint8Array>;
  };
};

describe('local StorageACK cancellation through the registered real handler', () => {
  let agent: DKGAgent | undefined;
  afterEach(async () => { await agent?.stop(); agent = undefined; });

  it('fails stop drain closed when physical handler work refuses to retire', async () => {
    const transport = new LocalStorageACKTransport();
    let entered!: () => void;
    let release!: (value: Uint8Array) => void;
    const inHandler = new Promise<void>((resolve) => { entered = resolve; });
    const work = new Promise<Uint8Array>((resolve) => { release = resolve; });
    const endpoint: StorageACKEndpoint = {
      dispatch: () => { entered(); return { response: work, completion: work }; },
      dispose: () => {},
    };
    const sendWork = (signal: AbortSignal) =>
      endpoint.dispatch({ protocol: PROTOCOL_STORAGE_ACK, data: new Uint8Array(), peerId: 'self', signal });
    const send = transport.send(sendWork, 1_000)
      .then(() => undefined, (error: unknown) => error);
    await inHandler;
    transport.close();
    expect(await send).toBeInstanceOf(Error);
    await expect(transport.drain(10)).rejects.toBeInstanceOf(LocalStorageACKDrainTimeoutError);
    release(new Uint8Array());
    await expect(transport.drain()).resolves.toBeUndefined();
    await expect(transport.send(sendWork, 10))
      .rejects.toThrow(/closed/);
  });

  for (const kind of ['publish', 'update'] as const) {
    it(`aborts ${kind} store work and prevents late signing when the local send times out`, async () => {
      const base = new OxigraphStore();
      await base.insert(quads);
      const insert = vi.spyOn(base, 'insert');
      const seenSignals: AbortSignal[] = [];
      const store = new Proxy(base as TripleStore, {
        get(target, property, receiver) {
          if (property === 'query') {
            return async (...args: unknown[]) => {
              const options = args.at(-1) as QueryOptions;
              if (options?.signal) seenSignals.push(options.signal);
              await new Promise((resolve) => setTimeout(resolve, 45));
              return (target.query as (...args: unknown[]) => unknown).apply(target, args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const signer = ethers.Wallet.createRandom();
      const sign = vi.spyOn(signer, 'signMessage');
      const handler = new StorageACKHandler(store, {
        nodeRole: 'core',
        nodeIdentityId: 42n,
        signerWallet: signer,
        contextGraphSharedMemoryUri: () => graph,
        chainId: 31337n,
        kav10Address: '0x000000000000000000000000000000000000c10a',
        isCgCurated: async () => false,
        ackHandlerDeadlineMs: 0,
      }, new TypedEventBus());
      agent = await DKGAgent.create({
        name: `LocalACKCancellation${kind}`,
        store: base,
        chainAdapter: new MockChainAdapter(),
        nodeRole: 'core',
      });
      const local = agent as LocalAgent;
      (local as unknown as { node: { peerId: string } }).node = { peerId: 'local-core' };
      const routes = new Map<string, (data: Uint8Array, peerId: string) => Promise<Uint8Array>>();
      await installStorageACKFixtureEndpoint(local, registerStorageACKEndpoint({
        registerGroup: (entries) => {
          for (const entry of entries) routes.set(entry.protocolId, entry.handler);
          return () => routes.clear();
        },
        publish: (data, peerId, signal) => handler.handler(data, { toString: () => peerId } as any, signal),
        update: (data, peerId, signal) => handler.updateHandler(data, { toString: () => peerId } as any, signal),
        publishLocal: (data, peerId, signal, context) => handler.localExecution(data, { toString: () => peerId } as any, signal,
          context as LocalStorageAckHeadExpectation | undefined),
        updateLocal: (data, peerId, signal, context) => handler.localUpdateExecution(data, { toString: () => peerId } as any, signal,
          context as LocalStorageAckHeadExpectation | undefined),
      }));
      expect(routes.has(PROTOCOL_STORAGE_ACK)).toBe(true);
      expect(routes.has(PROTOCOL_STORAGE_UPDATE_ACK)).toBe(true);
      const root = computeFlatKCRootV10(quads, []);
      const leafCount = computeFlatKCMerkleLeafCountV10(quads, []);
      const data = kind === 'publish'
        ? encodePublishIntent({
            merkleRoot: root,
            contextGraphId: '42',
            publisherPeerId: 'publisher-0',
            publicByteSize: 300,
            isPrivate: false,
            kaCount: 1,
            rootEntities: ['urn:entity:1'],
            epochs: 1,
            tokenAmountStr: '1000',
            merkleLeafCount: leafCount,
          })
        : encodeUpdateIntent({
            kaId: '987654321',
            contextGraphId: '42',
            preUpdateMerkleRootCount: 1,
            newMerkleRoot: root,
            newByteSize: 300,
            newTokenAmount: '1500',
            mintAmount: 0,
            burnTokenIds: [],
            newMerkleLeafCount: leafCount,
            publisherPeerId: 'publisher-0',
          });
      const protocol = kind === 'publish' ? PROTOCOL_STORAGE_ACK : PROTOCOL_STORAGE_UPDATE_ACK;
      const send = local.createACKTransportFactory({ sendTimeoutMs: 10 })().sendP2P;
      const insertsBeforeSend = insert.mock.calls.length;
      await expect(send(local.peerId, protocol, data)).rejects.toThrow(/timed out after 10ms/);
      await expect(send(local.peerId, protocol, data)).rejects.toThrow(/timed out after 10ms/);
      expect(seenSignals).toHaveLength(1);
      expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(insert).toHaveBeenCalledTimes(insertsBeforeSend);
      expect(sign).not.toHaveBeenCalled();
      expect(seenSignals).toHaveLength(1);

      const healthySend = local.createACKTransportFactory({ sendTimeoutMs: 200 })().sendP2P;
      await healthySend(local.peerId, protocol, data);
      expect(sign).toHaveBeenCalledOnce();
    });
  }

  for (const kind of ['publish', 'update'] as const) {
    it(`retires ${kind} without signing after a non-cooperative late signer lookup times out`, async () => {
      const store = new OxigraphStore();
      await store.insert(quads);
      const insert = vi.spyOn(store, 'insert');
      const signer = ethers.Wallet.createRandom();
      const sign = vi.spyOn(signer, 'signMessage');
      let entered!: () => void;
      let release!: (registered: boolean) => void;
      const inGate = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<boolean>((resolve) => { release = resolve; });
      const handler = new StorageACKHandler(store, {
        nodeRole: 'core',
        nodeIdentityId: 42n,
        signerWallet: signer,
        contextGraphSharedMemoryUri: () => graph,
        chainId: 31337n,
        kav10Address: '0x000000000000000000000000000000000000c10a',
        isCgCurated: async () => false,
        isSignerRegistered: () => { entered(); return gate; },
        ackHandlerDeadlineMs: 0,
      }, new TypedEventBus());
      agent = await DKGAgent.create({
        name: `LateLocalACKCancellation${kind}`,
        store,
        chainAdapter: new MockChainAdapter(),
        nodeRole: 'core',
      });
      const local = agent as LocalAgent;
      (local as unknown as { node: { peerId: string } }).node = { peerId: 'local-core' };
      let physical: Promise<Uint8Array> | undefined;
      await installStorageACKFixtureEndpoint(local, registerStorageACKEndpoint({
        registerGroup: () => () => {},
        publish: (data, peerId, signal) => {
          physical = handler.handler(data, { toString: () => peerId } as any, signal);
          return physical;
        },
        update: (data, peerId, signal) => {
          physical = handler.updateHandler(data, { toString: () => peerId } as any, signal);
          return physical;
        },
        publishLocal: (data, peerId, signal, context) => {
          const execution = handler.localExecution(data, { toString: () => peerId } as any, signal,
            context as LocalStorageAckHeadExpectation | undefined);
          physical = execution.completion;
          return execution;
        },
        updateLocal: (data, peerId, signal, context) => {
          const execution = handler.localUpdateExecution(data, { toString: () => peerId } as any, signal,
            context as LocalStorageAckHeadExpectation | undefined);
          physical = execution.completion;
          return execution;
        },
      }));
      const root = computeFlatKCRootV10(quads, []);
      const leafCount = computeFlatKCMerkleLeafCountV10(quads, []);
      const data = kind === 'publish'
        ? encodePublishIntent({
            merkleRoot: root, contextGraphId: '42', publisherPeerId: 'publisher-0',
            publicByteSize: 300, isPrivate: false, kaCount: 1,
            rootEntities: ['urn:entity:1'], epochs: 1, tokenAmountStr: '1000',
            merkleLeafCount: leafCount,
          })
        : encodeUpdateIntent({
            kaId: '987654321', contextGraphId: '42', preUpdateMerkleRootCount: 1,
            newMerkleRoot: root, newByteSize: 300, newTokenAmount: '1500',
            mintAmount: 0, burnTokenIds: [], newMerkleLeafCount: leafCount,
            publisherPeerId: 'publisher-0',
          });
      const protocol = kind === 'publish' ? PROTOCOL_STORAGE_ACK : PROTOCOL_STORAGE_UPDATE_ACK;
      const send = local.createACKTransportFactory({ sendTimeoutMs: 40 })().sendP2P(local.peerId, protocol, data);
      const rejectedSend = expect(send).rejects.toThrow(/timed out after 40ms/);
      await inGate;
      const insertsAtGate = insert.mock.calls.length;
      await rejectedSend;
      release(true);
      await expect(physical).rejects.toThrow();
      await local.storageACKRegistrationRuntime.closeAndDrain();
      expect(insert).toHaveBeenCalledTimes(insertsAtGate);
      expect(sign).not.toHaveBeenCalled();
    });
  }

  it('does not encode an ACK when a non-cooperative signer finishes after the send deadline', async () => {
    const store = new OxigraphStore();
    await store.insert(quads);
    const signer = ethers.Wallet.createRandom();
    const originalSign = signer.signMessage.bind(signer);
    let entered!: () => void;
    let release!: () => void;
    const inSigner = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sign = vi.spyOn(signer, 'signMessage').mockImplementation(async (message) => {
      entered();
      await gate;
      return originalSign(message);
    });
    const handler = new StorageACKHandler(store, {
      nodeRole: 'core', nodeIdentityId: 42n, signerWallet: signer,
      contextGraphSharedMemoryUri: () => graph, chainId: 31337n,
      kav10Address: '0x000000000000000000000000000000000000c10a',
      isCgCurated: async () => false, ackHandlerDeadlineMs: 0,
    }, new TypedEventBus());
    let physical: Promise<Uint8Array> | undefined;
    const endpoint = registerStorageACKEndpoint({
      registerGroup: () => () => {},
      publish: (data, peerId, signal) => {
        physical = handler.handler(data, { toString: () => peerId } as any, signal);
        return physical;
      },
      update: (data, peerId, signal) => handler.updateHandler(data, { toString: () => peerId } as any, signal),
      publishLocal: (data, peerId, signal, context) => {
        const execution = handler.localExecution(data, { toString: () => peerId } as any, signal,
          context as LocalStorageAckHeadExpectation | undefined);
        physical = execution.completion;
        return execution;
      },
      updateLocal: (data, peerId, signal, context) => handler.localUpdateExecution(data, { toString: () => peerId } as any, signal,
        context as LocalStorageAckHeadExpectation | undefined),
    });
    const data = encodePublishIntent({
      merkleRoot: computeFlatKCRootV10(quads, []), contextGraphId: '42',
      publisherPeerId: 'publisher-0', publicByteSize: 300, isPrivate: false,
      kaCount: 1, rootEntities: ['urn:entity:1'], epochs: 1,
      tokenAmountStr: '1000', merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
    });
    const transport = new LocalStorageACKTransport();
    const send = transport.send((signal) => endpoint.dispatch({
      protocol: PROTOCOL_STORAGE_ACK, data, peerId: 'self', signal,
    }), 40);
    const rejectedSend = expect(send).rejects.toThrow(/timed out after 40ms/);
    await inSigner;
    await rejectedSend;
    release();
    await expect(physical).rejects.toThrow();
    await transport.drain();
    expect(sign).toHaveBeenCalledOnce();
    endpoint.dispose();
  });

  it('holds store teardown for a graph commit that outlives the handler deadline', async () => {
    const store = new OxigraphStore();
    const close = vi.spyOn(store, 'close');
    const originalReplace = store.replaceGraph!.bind(store);
    let entered!: () => void;
    let release!: () => void;
    const inReplace = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, 'replaceGraph').mockImplementation(async (graphUri, replacement) => {
      entered();
      await held;
      await originalReplace(graphUri, replacement); // adapter ignores cancellation
    });
    const signer = ethers.Wallet.createRandom();
    const sign = vi.spyOn(signer, 'signMessage');
    const handler = new StorageACKHandler(store, {
      nodeRole: 'core', nodeIdentityId: 42n, signerWallet: signer,
      contextGraphSharedMemoryUri: (cgId) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: 31337n, kav10Address: '0x000000000000000000000000000000000000c10a',
      isCgCurated: async () => false,
      ensureVmPromotion: async () => ({ ok: true }),
      ackHandlerDeadlineMs: 200,
    }, new TypedEventBus());
    agent = await DKGAgent.create({
      name: 'LateLocalACKCommitDrain', store, chainAdapter: new MockChainAdapter(), nodeRole: 'core',
    });
    await agent.start();
    const local = agent as LocalAgent;
    await installStorageACKFixtureEndpoint(local, registerStorageACKEndpoint({
      registerGroup: () => () => {},
      publish: (data, peerId) => handler.handler(data, { toString: () => peerId } as any),
      update: (data, peerId) => handler.updateHandler(data, { toString: () => peerId } as any),
      publishLocal: (data, peerId, signal, context) =>
        handler.localExecution(data, { toString: () => peerId } as any, signal,
          context as LocalStorageAckHeadExpectation | undefined),
      updateLocal: (data, peerId, signal, context) =>
        handler.localUpdateExecution(data, { toString: () => peerId } as any, signal,
          context as LocalStorageAckHeadExpectation | undefined),
    }));
    const ual = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7';
    const quads = [{ subject: 'urn:entity:late', predicate: 'urn:p:value', object: '"value"', graph: '' }];
    const graphUri = knowledgeAssetLayerGraphUri('late-local', MemoryLayer.SharedWorkingMemory,
      createGraphKnowledgeAssetScope(ual, 1));
    const stagingQuads = new TextEncoder().encode(`<urn:entity:late> <urn:p:value> "value" <${graphUri}> .`);
    const intent = encodePublishIntent({
      merkleRoot: computeFlatKCRootV10(quads, []), contextGraphId: '42', swmGraphId: 'late-local',
      publisherPeerId: local.peerId, publicByteSize: stagingQuads.length, isPrivate: false,
      kaCount: 1, rootEntities: [], merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
      stagingQuads, contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: ual,
      assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0,
      accessPolicy: 'public', allowedPeers: [],
    });
    const send = local.createACKTransportFactory({ sendTimeoutMs: 1_000 })().sendP2P(local.peerId, PROTOCOL_STORAGE_ACK, intent);
    await Promise.race([inReplace, send.then(() => { throw new Error('ACK completed before graph replacement started'); })]);
    expect(isStorageACKDecline(decodeStorageACK(await send))).toBe(true);
    const stopping = local.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(close).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(close).toHaveBeenCalledOnce();
    expect(sign).not.toHaveBeenCalled();
    agent = undefined;
  });
});
