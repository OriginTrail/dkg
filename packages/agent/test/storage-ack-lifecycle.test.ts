import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2,
  PROTOCOL_STORAGE_UPDATE_ACK, PROTOCOL_STORAGE_UPDATE_ACK_V2,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { Messenger } from '../src/p2p/messenger.js';
import { StorageACKRegistrationRuntime } from '../src/p2p/storage-ack-registration-runtime.js';
import { installStorageACKFixtureEndpoint, clearStorageACKFixtureEndpoint } from './_helpers/storage-ack-endpoint-fixture.js';

const capturedStorageACKHandlerConfigs: unknown[] = [];
const capturedStorageACKHandlerCalls: Array<{ kind: 'publish' | 'update'; data: Uint8Array; peerId: string }> = [];
const capturedStorageACKHandlerSignals: Array<AbortSignal | undefined> = [];
let localACKHandlerWorkHook: ((signal?: AbortSignal) => Promise<void>) | undefined;
let remoteACKHandlerWorkHook: ((config: StorageACKHandlerConfigCapture) => Promise<void>) | undefined;

vi.mock('@origintrail-official/dkg-publisher', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-publisher')>(
    '@origintrail-official/dkg-publisher',
  );
  return {
    ...actual,
    StorageACKHandler: class CapturingStorageACKHandler {
      constructor(_store: unknown, private readonly config: StorageACKHandlerConfigCapture) {
        capturedStorageACKHandlerConfigs.push(config);
      }
      async handler(data: Uint8Array, peer: { toString(): string }, signal?: AbortSignal): Promise<Uint8Array> {
        capturedStorageACKHandlerCalls.push({ kind: 'publish', data, peerId: peer.toString() });
        capturedStorageACKHandlerSignals.push(signal);
        await localACKHandlerWorkHook?.(signal);
        await remoteACKHandlerWorkHook?.(this.config);
        return new Uint8Array([1]);
      }
      async updateHandler(data: Uint8Array, peer: { toString(): string }, signal?: AbortSignal): Promise<Uint8Array> {
        capturedStorageACKHandlerCalls.push({ kind: 'update', data, peerId: peer.toString() });
        capturedStorageACKHandlerSignals.push(signal);
        return new Uint8Array([2]);
      }
    },
  };
});

interface StorageACKHandlerConfigCapture {
  onSignerUnregistered?: () => void;
}

interface ProviderInternals {
  peerId: string;
  node: { peerId: string; libp2p: { getPeers(): unknown[] } };
  config: { nodeRole?: string };
  messenger: unknown;
  router: unknown;
  gossip: unknown;
  storageAckHandlerRegistered: boolean;
  storageAckEndpoint: {
    dispatch(protocol: string, data: Uint8Array, peerId: string, signal?: AbortSignal): Promise<Uint8Array>;
  } | null;
  createACKTransportFactory(options?: { sendTimeoutMs?: number }): () => {
    sendP2P(peerId: string, protocol: string, data: Uint8Array): Promise<Uint8Array>;
  };
  getACKCandidatePeers(): string[];
}

async function bootProviderAgent(): Promise<{ agent: DKGAgent; internals: ProviderInternals }> {
  const agent = await DKGAgent.create({
    name: 'LocalACKLifecycleTest', chainAdapter: new MockChainAdapter(),
  });
  const internals = agent as unknown as ProviderInternals;
  internals.router = { probeProtocol: async () => 'unsupported' };
  internals.gossip = { publish: async () => undefined };
  internals.node = { peerId: 'local-core', libp2p: { getPeers: () => [] } };
  return { agent, internals };
}

describe('StorageACK endpoint and local dispatch lifecycle', () => {
  let agent: DKGAgent | null | undefined = null;

  beforeEach(() => {
    capturedStorageACKHandlerConfigs.length = 0;
    capturedStorageACKHandlerCalls.length = 0;
    capturedStorageACKHandlerSignals.length = 0;
    localACKHandlerWorkHook = undefined;
    remoteACKHandlerWorkHook = undefined;
  });

  afterEach(async () => {
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
    vi.restoreAllMocks();
  });

  it('routes self ACK requests through the registered core handler for publish and update', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;
    const remoteSend = vi.fn();
    internals.messenger = { sendRequestOwned: remoteSend };
    internals.config.nodeRole = 'core';
    const publish = vi.fn(async () => new Uint8Array([1]));
    const update = vi.fn(async () => new Uint8Array([2]));
    installStorageACKFixtureEndpoint(agent, {
      dispatch: (protocol, data) => protocol === PROTOCOL_STORAGE_ACK || protocol === PROTOCOL_STORAGE_ACK_V2
        ? publish(data)
        : update(data),
    });
    const send = internals.createACKTransportFactory()().sendP2P;
    const request = new Uint8Array([3]);

    await expect(send(internals.peerId, PROTOCOL_STORAGE_ACK, request)).resolves.toEqual(new Uint8Array([1]));
    await expect(send(internals.peerId, PROTOCOL_STORAGE_ACK_V2, request)).resolves.toEqual(new Uint8Array([1]));
    await expect(send(internals.peerId, PROTOCOL_STORAGE_UPDATE_ACK, request)).resolves.toEqual(new Uint8Array([2]));
    await expect(send(internals.peerId, PROTOCOL_STORAGE_UPDATE_ACK_V2, request)).resolves.toEqual(new Uint8Array([2]));
    await expect(send(internals.peerId, '/dkg/test/unsupported-ack', request)).rejects.toThrow(/Unsupported StorageACK protocol/);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
    expect(remoteSend).not.toHaveBeenCalled();

    await clearStorageACKFixtureEndpoint(agent);
    await expect(send(internals.peerId, PROTOCOL_STORAGE_ACK, request)).rejects.toThrow(/not registered/);
  });

  it('bounds local ACK dispatch by the configured send timeout and aborts late work', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;
    internals.config.nodeRole = 'core';
    let observedSignal: AbortSignal | undefined;
    let lateMutation = false;
    let dispatchCalls = 0;
    installStorageACKFixtureEndpoint(agent, {
      dispatch: async (_protocol, _data, _peerId, signal) => {
        dispatchCalls++;
        observedSignal = signal;
        await new Promise((resolve) => setTimeout(resolve, 45));
        if (!signal?.aborted) lateMutation = true;
        return new Uint8Array([1]);
      },
    });
    const send = internals.createACKTransportFactory({ sendTimeoutMs: 10 })().sendP2P;
    await expect(send(internals.peerId, PROTOCOL_STORAGE_ACK, new Uint8Array([3])))
      .rejects.toThrow(/timed out after 10ms/);
    await expect(send(internals.peerId, PROTOCOL_STORAGE_ACK, new Uint8Array([3])))
      .rejects.toThrow(/timed out after 10ms/);
    expect(observedSignal?.aborted).toBe(true);
    expect(dispatchCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 55));
    expect(lateMutation).toBe(false);
    expect(dispatchCalls).toBe(1);
  });

  it('passes ackHandlerDeadlineMs into StorageACKHandler construction during core startup', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    const remoteHandlers: Array<(data: Uint8Array, peerId: string) => Promise<Uint8Array>> = [];
    const originalRegister = Messenger.prototype.register;
    vi.spyOn(Messenger.prototype, 'register').mockImplementation(function (protocol, handler, options) {
      if (protocol === PROTOCOL_STORAGE_ACK) remoteHandlers.push(handler);
      return originalRegister.call(this, protocol, handler, options);
    });

    agent = await DKGAgent.create({
      name: 'ACKHandlerDeadlineWiringTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
      storageAckTiming: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
    });
    await agent.start();

    expect(capturedStorageACKHandlerConfigs).toContainEqual(
      expect.objectContaining({ ackHandlerDeadlineMs: 55_000 }),
    );
    const internals = agent as unknown as ProviderInternals;
    expect(internals.storageAckHandlerRegistered).toBe(true);
    expect(internals.storageAckEndpoint).not.toBeNull();
    const localPeerId = internals.peerId;
    const request = new Uint8Array([3, 4]);
    const send = internals.createACKTransportFactory()().sendP2P;
    await expect(send(localPeerId, PROTOCOL_STORAGE_ACK, request)).resolves.toEqual(new Uint8Array([1]));
    await expect(send(localPeerId, PROTOCOL_STORAGE_ACK_V2, request)).resolves.toEqual(new Uint8Array([1]));
    await expect(send(localPeerId, PROTOCOL_STORAGE_UPDATE_ACK, request)).resolves.toEqual(new Uint8Array([2]));
    await expect(send(localPeerId, PROTOCOL_STORAGE_UPDATE_ACK_V2, request)).resolves.toEqual(new Uint8Array([2]));
    expect(capturedStorageACKHandlerCalls).toEqual([
      { kind: 'publish', data: request, peerId: localPeerId },
      { kind: 'publish', data: request, peerId: localPeerId },
      { kind: 'update', data: request, peerId: localPeerId },
      { kind: 'update', data: request, peerId: localPeerId },
    ]);
    expect(capturedStorageACKHandlerSignals).toHaveLength(4);
    expect(capturedStorageACKHandlerSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    const handlerConfig = capturedStorageACKHandlerConfigs.at(-1) as StorageACKHandlerConfigCapture;
    expect(handlerConfig.onSignerUnregistered).toBeTypeOf('function');
    const staleRemoteHandler = remoteHandlers[0]!;
    handlerConfig.onSignerUnregistered?.();
    expect(internals.storageAckEndpoint).toBeNull();
    expect(internals.storageAckHandlerRegistered).toBe(false);
    expect(internals.getACKCandidatePeers()).not.toContain(localPeerId);
    const callsBeforeStale = capturedStorageACKHandlerCalls.length;
    expect(() => staleRemoteHandler(request, 'remote-peer')).toThrow(/StorageACK handler is not registered/);
    expect(capturedStorageACKHandlerCalls).toHaveLength(callsBeforeStale);
    await expect.poll(() => internals.storageAckHandlerRegistered).toBe(true);
    expect(remoteHandlers).toHaveLength(2);
    expect(() => staleRemoteHandler(request, 'remote-peer')).toThrow(/StorageACK handler is not registered/);
    expect(capturedStorageACKHandlerCalls).toHaveLength(callsBeforeStale);
    await expect(remoteHandlers.at(-1)!(request, 'remote-peer')).resolves.toEqual(new Uint8Array([1]));
    await agent.stop();
    expect(internals.storageAckEndpoint).toBeNull();
    agent = undefined;
  });

  it('ignores a stale signer callback after a replacement endpoint is registered', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    const remoteHandlers: Array<(data: Uint8Array, peerId: string) => Promise<Uint8Array>> = [];
    const originalRegister = Messenger.prototype.register;
    vi.spyOn(Messenger.prototype, 'register').mockImplementation(function (protocol, handler, options) {
      if (protocol === PROTOCOL_STORAGE_ACK) remoteHandlers.push(handler);
      return originalRegister.call(this, protocol, handler, options);
    });

    agent = await DKGAgent.create({
      name: 'ACKStaleSignerCallbackTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
    });
    await agent.start();
    const internals = agent as unknown as ProviderInternals;
    expect(remoteHandlers).toHaveLength(1);

    let firstEntered!: () => void;
    let secondEntered!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstInside = new Promise<void>((resolve) => { firstEntered = resolve; });
    const secondInside = new Promise<void>((resolve) => { secondEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let calls = 0;
    remoteACKHandlerWorkHook = async (config) => {
      const call = ++calls;
      if (call === 1) {
        firstEntered();
        await firstGate;
      } else if (call === 2) {
        secondEntered();
        await secondGate;
      }
      config.onSignerUnregistered?.();
    };

    const oldHandler = remoteHandlers[0]!;
    const firstRequest = oldHandler(new Uint8Array([1]), 'remote-1');
    const secondRequest = oldHandler(new Uint8Array([2]), 'remote-2');
    await Promise.all([firstInside, secondInside]);
    releaseFirst();
    await firstRequest;
    await expect.poll(() => remoteHandlers.length).toBe(2);
    const replacement = internals.storageAckEndpoint;
    expect(replacement).not.toBeNull();
    expect(internals.storageAckHandlerRegistered).toBe(true);

    releaseSecond();
    await secondRequest;
    expect(internals.storageAckEndpoint).toBe(replacement);
    expect(internals.storageAckHandlerRegistered).toBe(true);
    expect(remoteHandlers).toHaveLength(2);
    remoteACKHandlerWorkHook = undefined;
    await expect(remoteHandlers[1]!(new Uint8Array([3]), 'remote-3'))
      .resolves.toEqual(new Uint8Array([1]));
  });

  it('aborts and drains a running local handler before closing the store on stop', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    const store = new OxigraphStore();
    agent = await DKGAgent.create({
      name: 'LocalACKShutdownDrainTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      store,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
    });
    await agent.start();
    const internals = agent as unknown as ProviderInternals;
    const close = vi.spyOn(store, 'close');
    let entered!: () => void;
    let release!: () => void;
    const insideWork = new Promise<void>((resolve) => { entered = resolve; });
    const workGate = new Promise<void>((resolve) => { release = resolve; });
    let mutation = false;
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      entered();
      await workGate;
      options?.signal?.throwIfAborted();
      return query(sparql, options);
    });
    localACKHandlerWorkHook = async (signal) => {
      await store.query('SELECT * WHERE { ?s ?p ?o } LIMIT 1', { signal });
      mutation = true;
    };
    const send = internals.createACKTransportFactory({ sendTimeoutMs: 10_000 })().sendP2P;
    const sendOutcome = send(internals.peerId, PROTOCOL_STORAGE_ACK, new Uint8Array([1]))
      .then(() => undefined, (error: unknown) => error);
    await insideWork;

    const stopping = agent.stop();
    await vi.waitFor(() => expect(capturedStorageACKHandlerSignals.at(-1)?.aborted).toBe(true));
    expect(close).not.toHaveBeenCalled();
    expect(mutation).toBe(false);
    release();
    await stopping;
    expect(close).toHaveBeenCalledOnce();
    expect(mutation).toBe(false);
    expect(await sendOutcome).toBeInstanceOf(Error);
    agent = null;
  });

  it('reopens local ACK dispatch after a same-instance core restart', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    agent = await DKGAgent.create({
      name: 'LocalACKSameInstanceRestartTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
    });
    const internals = agent as unknown as ProviderInternals;
    const request = new Uint8Array([3, 4]);
    await agent.start();
    await expect.poll(() => internals.storageAckHandlerRegistered).toBe(true);
    const firstSend = internals.createACKTransportFactory()().sendP2P;
    await expect(firstSend(internals.peerId, PROTOCOL_STORAGE_ACK, request))
      .resolves.toEqual(new Uint8Array([1]));
    await expect(firstSend(internals.peerId, PROTOCOL_STORAGE_UPDATE_ACK, request))
      .resolves.toEqual(new Uint8Array([2]));

    await agent.stop();
    await agent.start();
    await expect.poll(() => internals.storageAckHandlerRegistered).toBe(true);
    const secondSend = internals.createACKTransportFactory()().sendP2P;
    await expect(secondSend(internals.peerId, PROTOCOL_STORAGE_ACK, request))
      .resolves.toEqual(new Uint8Array([1]));
    await expect(secondSend(internals.peerId, PROTOCOL_STORAGE_UPDATE_ACK, request))
      .resolves.toEqual(new Uint8Array([2]));
    await expect(firstSend(internals.peerId, PROTOCOL_STORAGE_ACK, request))
      .rejects.toThrow(/transport is closed/);
    expect(capturedStorageACKHandlerCalls.filter(({ kind }) => kind === 'publish')).toHaveLength(2);
    expect(capturedStorageACKHandlerCalls.filter(({ kind }) => kind === 'update')).toHaveLength(2);
  });

  it('fences a sender created before the first start so it cannot escape shutdown ownership', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    agent = await DKGAgent.create({
      name: 'ACKPrestartSenderFenceTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
    });
    const internals = agent as unknown as ProviderInternals;
    // The public factory reads the not-yet-started node peer ID, so capture
    // its underlying local sender before start to exercise the lifetime fence.
    const prestartSend = (agent as unknown as {
      storageACKRegistrationRuntime: StorageACKRegistrationRuntime;
    }).storageACKRegistrationRuntime.createLocalSender();
    await agent.start();
    expect(internals.storageAckHandlerRegistered).toBe(true);
    expect(() => prestartSend(internals.peerId, PROTOCOL_STORAGE_ACK, new Uint8Array([1]), 1_000))
      .toThrow(/transport is closed/);
    expect(capturedStorageACKHandlerCalls).toHaveLength(0);
    const currentSend = internals.createACKTransportFactory()().sendP2P;
    await expect(currentSend(internals.peerId, PROTOCOL_STORAGE_ACK, new Uint8Array([1])))
      .resolves.toEqual(new Uint8Array([1]));
  });

  it('joins a paused signer failover without resurrecting ACK routes during stop', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    agent = await DKGAgent.create({
      name: 'ACKRegistrationShutdownFenceTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
    });
    await agent.start();
    const internals = agent as unknown as ProviderInternals;
    const oldRouterHandlers = (internals.router as { handlers: Map<string, unknown> }).handlers;
    const oldMessengerHandlers = (internals.messenger as { handlers: Map<string, unknown> }).handlers;
    const originalResolve = agent.resolveConfirmedACKSigner.bind(agent);
    let entered!: () => void;
    let release!: () => void;
    const insideResolution = new Promise<void>((resolve) => { entered = resolve; });
    const resolutionGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(agent, 'resolveConfirmedACKSigner').mockImplementation(async (...args) => {
      entered();
      await resolutionGate;
      return originalResolve(...args);
    });
    const config = capturedStorageACKHandlerConfigs.at(-1) as StorageACKHandlerConfigCapture;
    config.onSignerUnregistered?.();
    await insideResolution;

    let stopped = false;
    const stopping = agent.stop().finally(() => { stopped = true; });
    await vi.waitFor(() => expect(internals.storageAckEndpoint).toBeNull());
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(internals.storageAckEndpoint).toBeNull();
    expect(internals.storageAckHandlerRegistered).toBe(false);
    const protocols = [
      PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2,
      PROTOCOL_STORAGE_UPDATE_ACK, PROTOCOL_STORAGE_UPDATE_ACK_V2,
    ];
    expect(protocols.every((protocol) => !oldRouterHandlers.has(protocol))).toBe(true);
    expect(protocols.every((protocol) => !oldMessengerHandlers.has(protocol))).toBe(true);

    await agent.start();
    await expect.poll(() => internals.storageAckHandlerRegistered).toBe(true);
    const routerHandlers = (internals.router as { handlers: Map<string, unknown> }).handlers;
    const messengerHandlers = (internals.messenger as { handlers: Map<string, unknown> }).handlers;
    expect(protocols.every((protocol) => routerHandlers.has(protocol))).toBe(true);
    expect(protocols.every((protocol) => messengerHandlers.has(protocol))).toBe(true);
    const send = internals.createACKTransportFactory()().sendP2P;
    await expect(send(internals.peerId, PROTOCOL_STORAGE_ACK, new Uint8Array([1])))
      .resolves.toEqual(new Uint8Array([1]));
  });

  it('joins the first signer lookup when stop races initial ACK registration', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    agent = await DKGAgent.create({
      name: 'ACKInitialRegistrationShutdownFenceTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
    });
    const internals = agent as unknown as ProviderInternals;
    const originalResolve = agent.resolveConfirmedACKSigner.bind(agent);
    let entered!: () => void;
    let release!: () => void;
    const insideLookup = new Promise<void>((resolve) => { entered = resolve; });
    const lookupGate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(agent, 'resolveConfirmedACKSigner').mockImplementation(async (...args) => {
      entered();
      await lookupGate;
      return originalResolve(...args);
    });

    const starting = agent.start();
    await insideLookup;
    expect(internals.storageAckEndpoint).toBeNull();
    let stopped = false;
    const stopping = agent.stop().finally(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    const [, stopOutcome] = await Promise.allSettled([starting, stopping]);
    expect(stopOutcome.status).toBe('fulfilled');
    expect(stopped).toBe(true);
    expect(internals.storageAckEndpoint).toBeNull();
    expect(internals.storageAckHandlerRegistered).toBe(false);
    const protocols = [
      PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2,
      PROTOCOL_STORAGE_UPDATE_ACK, PROTOCOL_STORAGE_UPDATE_ACK_V2,
    ];
    const routerHandlers = (internals.router as { handlers: Map<string, unknown> }).handlers;
    const messengerHandlers = (internals.messenger as { handlers: Map<string, unknown> }).handlers;
    expect(protocols.every((protocol) => !routerHandlers.has(protocol))).toBe(true);
    expect(protocols.every((protocol) => !messengerHandlers.has(protocol))).toBe(true);
    agent = null;
  });

  it('rolls back partial ACK registration and restores all routes on retry', async () => {
    const primary = ethers.Wallet.createRandom();
    const ackSigner = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', primary.address);
    chain.seedIdentity(primary.address, 42n);
    const protocols = [
      PROTOCOL_STORAGE_ACK,
      PROTOCOL_STORAGE_ACK_V2,
      PROTOCOL_STORAGE_UPDATE_ACK,
      PROTOCOL_STORAGE_UPDATE_ACK_V2,
    ];
    const originalRegister = Messenger.prototype.register;
    let ackRegistrations = 0;
    vi.spyOn(Messenger.prototype, 'register').mockImplementation(function (protocol, handler, options) {
      if (protocols.includes(protocol) && ++ackRegistrations === 3) {
        throw new Error('injected third ACK registration failure');
      }
      return originalRegister.call(this, protocol, handler, options);
    });

    agent = await DKGAgent.create({
      name: 'ACKRegistrationRollbackTest',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: chain,
      nodeRole: 'core',
      ackSignerKey: ackSigner.privateKey,
      storageAckRegistrationRetryMs: 1_000,
    });
    await agent.start();
    const internals = agent as unknown as ProviderInternals;
    const routerHandlers = (internals.router as { handlers: Map<string, unknown> }).handlers;
    const messengerHandlers = (internals.messenger as { handlers: Map<string, unknown> }).handlers;
    expect(ackRegistrations).toBe(3);
    expect(internals.storageAckEndpoint).toBeNull();
    expect(internals.getACKCandidatePeers()).not.toContain(internals.peerId);
    expect(protocols.every((protocol) => !routerHandlers.has(protocol))).toBe(true);
    expect(protocols.every((protocol) => !messengerHandlers.has(protocol))).toBe(true);

    await expect.poll(() => internals.storageAckHandlerRegistered, { timeout: 5_000 }).toBe(true);
    expect(internals.getACKCandidatePeers()).toContain(internals.peerId);
    expect(protocols.every((protocol) => routerHandlers.has(protocol))).toBe(true);
    expect(protocols.every((protocol) => messengerHandlers.has(protocol))).toBe(true);
    const send = internals.createACKTransportFactory()().sendP2P;
    const request = new Uint8Array([4, 5]);
    const responses = await Promise.all(protocols.map((protocol) => send(internals.peerId, protocol, request)));
    expect(responses).toEqual([
      new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([2]),
    ]);
  });

});
