import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_STORAGE_UPDATE_ACK,
  TypedEventBus,
  encodePublishIntent,
  encodeUpdateIntent,
} from '@origintrail-official/dkg-core';
import {
  StorageACKHandler,
  computeFlatKCRootV10,
  computeFlatKCMerkleLeafCountV10,
} from '@origintrail-official/dkg-publisher';
import type { QueryOptions, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent, MockChainAdapter, OxigraphStore } from './agent.shared';
import { registerStorageACKEndpoint, type StorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';
import { LocalStorageACKDrainTimeoutError, LocalStorageACKTransport } from '../src/p2p/local-storage-ack-transport.js';

const graph = 'did:dkg:context-graph:42/_shared_memory';
const quads: Quad[] = [
  { subject: 'urn:entity:1', predicate: 'urn:p', object: 'urn:o1', graph },
  { subject: 'urn:entity:1', predicate: 'urn:p', object: 'urn:o2', graph },
];

type LocalAgent = DKGAgent & {
  peerId: string;
  storageAckEndpoint: StorageACKEndpoint | null;
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
      dispatch: () => { entered(); return work; },
      dispose: () => {},
    };
    const send = transport.send(endpoint, 'self', PROTOCOL_STORAGE_ACK, new Uint8Array(), 1_000)
      .then(() => undefined, (error: unknown) => error);
    await inHandler;
    transport.close();
    expect(await send).toBeInstanceOf(Error);
    await expect(transport.drain(10)).rejects.toBeInstanceOf(LocalStorageACKDrainTimeoutError);
    release(new Uint8Array());
    await expect(transport.drain()).resolves.toBeUndefined();
    await expect(transport.send(endpoint, 'self', PROTOCOL_STORAGE_ACK, new Uint8Array(), 10))
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
      local.storageAckEndpoint = registerStorageACKEndpoint({
        registerGroup: (entries) => {
          for (const entry of entries) routes.set(entry.protocolId, entry.handler);
          return () => routes.clear();
        },
        publish: (data, peerId, signal) => handler.handler(data, { toString: () => peerId } as any, signal),
        update: (data, peerId, signal) => handler.updateHandler(data, { toString: () => peerId } as any, signal),
      });
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
});
