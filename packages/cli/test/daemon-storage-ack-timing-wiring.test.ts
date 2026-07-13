import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  chainResetWipe: vi.fn(),
  createServer: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
}));

vi.mock('node:http', () => ({
  createServer: mocks.createServer,
}));

vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual,
    DKGAgent: { create: mocks.agentCreate },
    loadOpWallets: mocks.loadOpWallets,
    KaNumberAllocator: class KaNumberAllocator {},
  };
});

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadNetworkConfig: mocks.loadNetworkConfig,
  };
});

vi.mock('../src/daemon/chain-reset-wipe.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/chain-reset-wipe.js')>();
  return {
    ...actual,
    chainResetWipe: mocks.chainResetWipe,
  };
});

vi.mock('../src/publisher-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/publisher-runner.js')>();
  return {
    ...actual,
    startPublisherRuntimeWithOutcome: mocks.startPublisherRuntimeWithOutcome,
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

function createFakeServer() {
  const server = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return server;
    }),
    address: vi.fn(() => ({ port: 43123 })),
    close: vi.fn((cb?: () => void) => {
      cb?.();
      return server;
    }),
    on: vi.fn(() => server),
    once: vi.fn(() => server),
  };
  return server;
}

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

describe('runDaemonInner StorageACK timing wiring', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-storage-ack-timing-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    sigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    sigtermListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];

    mocks.createServer.mockImplementation(createFakeServer);
    mocks.startPublisherRuntimeWithOutcome.mockResolvedValue({
      runtime: null,
      availability: {
        available: false,
        reason: 'no_publisher_wallets',
        retryable: false,
        operatorActionRequired: true,
      },
    });
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'core',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.chainResetWipe.mockResolvedValue({
      wiped: false,
      skipped: false,
      prevMarker: null,
      removedFiles: [],
      backedUpFiles: [],
      failedFiles: [],
    });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.removeAllListeners('uncaughtException');
    for (const listener of uncaughtExceptionListeners) process.on('uncaughtException', listener);
    process.removeAllListeners('unhandledRejection');
    for (const listener of unhandledRejectionListeners) process.on('unhandledRejection', listener);
    process.removeAllListeners('SIGINT');
    for (const listener of sigintListeners) process.on('SIGINT', listener);
    process.removeAllListeners('SIGTERM');
    for (const listener of sigtermListeners) process.on('SIGTERM', listener);
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  async function captureCreateArg(configOverrides: Record<string, unknown> = {}): Promise<any> {
    await expect(runDaemonInner(true, {
      name: 'storage-ack-timing-core-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
      ...configOverrides,
    } as any, Date.now())).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    closeDashboardDbFromAgentCreateArg(createArg);
    return createArg;
  }

  it('passes resolved default StorageACK timing into DKGAgent.create when config is unset', async () => {
    const createArg = await captureCreateArg();

    expect(createArg.storageAckTiming).toEqual({
      handlerDeadlineMs: 15_000,
      sendTimeoutMs: 20_000,
    });
  });

  it('passes configured StorageACK timing into DKGAgent.create', async () => {
    const createArg = await captureCreateArg({
      storageAck: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
    });

    expect(createArg.storageAckTiming).toEqual({
      handlerDeadlineMs: 55_000,
      sendTimeoutMs: 60_000,
    });
  });

  it('passes disabled StorageACK handler deadlines into DKGAgent.create', async () => {
    const createArg = await captureCreateArg({
      storageAck: { handlerDeadlineMs: 0, sendTimeoutMs: 20_000 },
    });

    expect(createArg.storageAckTiming).toEqual({
      handlerDeadlineMs: 0,
      sendTimeoutMs: 20_000,
    });
  });

  it('validates malformed StorageACK timing before chain-reset wipe can run', async () => {
    await expect(runDaemonInner(true, {
      name: 'storage-ack-invalid-before-wipe-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      storageAck: '60000',
    } as any, Date.now())).rejects.toThrow(/storageAck must be an object/);

    expect(mocks.chainResetWipe).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('passes the resolved send timeout through the daemon async publisher startup handoff', async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: any[]) => {
      const handle = realSetTimeout(handler, timeout, ...args);
      if ((timeout ?? 0) > 0) handle.unref?.();
      return handle;
    }) as typeof setTimeout);
    const response = new Uint8Array([7]);
    const sendReliable = vi.fn(async () => ({
      delivered: true,
      response,
    }));
    const payload = new Uint8Array([1, 2, 3]);
    const createACKTransportFactory = vi.fn(({ sendTimeoutMs, log }: {
      sendTimeoutMs?: number;
      log?: (message: string) => void;
    }) => () => ({
      publisherPeerId: 'self-peer',
      gossipPublish: vi.fn(async () => undefined),
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        const result = await sendReliable(peerId, protocol, data, {
          timeoutMs: sendTimeoutMs,
        });
        if (!result.delivered) throw new Error(`substrate queued (transport): ${result.error}`);
        if (!result.response) throw new Error('substrate delivered (transport) without response');
        return result.response;
      },
      getConnectedCorePeers: vi.fn(() => ['peer-a']),
      log,
    }));
    const fakeAgent = {
      peerId: 'self-peer',
      multiaddrs: [],
      wallet: {
        keypair: {
          publicKey: new Uint8Array([1]),
          secretKey: new Uint8Array([2]),
        },
      },
      store: {},
      node: { libp2p: { getMultiaddrs: vi.fn(() => []) } },
      eventBus: { on: vi.fn() },
      assertion: {
        create: vi.fn(),
        write: vi.fn(),
      },
      setChatAcl: vi.fn(),
      setSkillAcl: vi.fn(),
      onChat: vi.fn(),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      publishProfile: vi.fn(async () => undefined),
      publishRelayRegistry: vi.fn(async () => undefined),
      ensureContextGraphLocal: vi.fn(async () => undefined),
      subscribeToContextGraph: vi.fn(),
      pingPeers: vi.fn(async () => undefined),
      listLocalAgents: vi.fn(() => []),
      registerImportedArtifactByteStore: vi.fn(),
      getDefaultAgentAddress: vi.fn(() => undefined),
      query: vi.fn(async () => ({ type: 'bindings', bindings: [] })),
      createContextGraph: vi.fn(),
      listContextGraphs: vi.fn(async () => []),
      createACKTransportFactory,
      drainRpcUsage: vi.fn(() => ({
        calls: 0,
        errors: 0,
        throttledMs: 0,
        byEndpoint: {},
      })),
    };
    mocks.agentCreate.mockResolvedValue(fakeAgent);

    await runDaemonInner(true, {
      name: 'storage-ack-async-publisher-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'edge',
      apiPort: 0,
      auth: { enabled: false },
      promoteQueue: { enabled: false },
      publisher: { enabled: true },
      source: 'monorepo',
      storageAck: { handlerDeadlineMs: 55_000, sendTimeoutMs: 60_000 },
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
    } as any, Date.now());

    await new Promise((resolve) => realSetTimeout(resolve, 0));
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    expect(mocks.startPublisherRuntimeWithOutcome).toHaveBeenCalledTimes(1);
    expect(createACKTransportFactory).toHaveBeenCalledWith(expect.objectContaining({
      sendTimeoutMs: 60_000,
      log: expect.any(Function),
    }));

    const startupArg = mocks.startPublisherRuntimeWithOutcome.mock.calls[0]?.[0] as any;
    const transport = startupArg.ackTransportFactory();

    await expect(transport.sendP2P('peer-a', '/dkg/test/storage-ack', payload)).resolves.toEqual(response);
    expect(sendReliable).toHaveBeenCalledWith('peer-a', '/dkg/test/storage-ack', payload, {
      timeoutMs: 60_000,
    });
    expect(transport.getConnectedCorePeers('/dkg/test/storage-ack')).toEqual(['peer-a']);
  });
});
