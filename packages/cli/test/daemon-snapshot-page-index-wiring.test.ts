import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  backfillOnBoot: vi.fn(),
  chainResetWipe: vi.fn(),
  createPublicSnapshotStore: vi.fn(),
  createPublisherControlFromStore: vi.fn(),
  createServer: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadOpWallets: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
}));

vi.mock('node:http', () => ({ createServer: mocks.createServer }));

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
  return { ...actual, loadNetworkConfig: mocks.loadNetworkConfig };
});

vi.mock('../src/daemon/chain-reset-wipe.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/chain-reset-wipe.js')>();
  return { ...actual, chainResetWipe: mocks.chainResetWipe };
});

vi.mock('../src/daemon/vm-publish-intent-backfill.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/vm-publish-intent-backfill.js')>();
  return { ...actual, backfillVmPublishIntentIndexOnBoot: mocks.backfillOnBoot };
});

vi.mock('../src/publisher-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/publisher-runner.js')>();
  return {
    ...actual,
    createPublicSnapshotStore: mocks.createPublicSnapshotStore,
    createPublisherControlFromStore: mocks.createPublisherControlFromStore,
    startPublisherRuntimeWithOutcome: mocks.startPublisherRuntimeWithOutcome,
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');
const { SqliteSnapshotPageIndexStore } = await import('../src/daemon/snapshot-page-index-store.js');

function createFakeServer() {
  const server = {
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return server;
    }),
    address: vi.fn(() => ({ port: 43123 })),
    close: vi.fn((callback?: () => void) => {
      callback?.();
      return server;
    }),
    on: vi.fn(() => server),
    once: vi.fn(() => server),
  };
  return server;
}

function createFakeAgent() {
  return {
    peerId: 'self-peer',
    multiaddrs: [],
    wallet: { keypair: { publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) } },
    store: {},
    node: { libp2p: { getMultiaddrs: vi.fn(() => []) } },
    eventBus: { on: vi.fn() },
    assertion: { create: vi.fn(), write: vi.fn() },
    setChatAcl: vi.fn(),
    setSkillAcl: vi.fn(),
    onChat: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    publishProfile: vi.fn(async () => undefined),
    ensureProfilePublished: vi.fn(async () => undefined),
    publishRelayRegistry: vi.fn(async () => undefined),
    ensureContextGraphLocal: vi.fn(async () => undefined),
    getSubscribedContextGraphs: vi.fn(() => new Map()),
    subscribeToContextGraph: vi.fn(),
    pingPeers: vi.fn(async () => undefined),
    listLocalAgents: vi.fn(() => []),
    registerImportedArtifactByteStore: vi.fn(),
    getDefaultAgentAddress: vi.fn(() => undefined),
    query: vi.fn(async () => ({ type: 'bindings', bindings: [] })),
    createContextGraph: vi.fn(),
    listContextGraphs: vi.fn(async () => []),
    createACKTransportFactory: vi.fn(() => ({})),
    drainRpcUsage: vi.fn(() => ({ calls: 0, errors: 0, throttledMs: 0, byEndpoint: {} })),
  };
}

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db
    ?? createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

describe('runDaemonInner public snapshot page-index wiring', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-snapshot-index-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    sigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    sigtermListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];

    mocks.createServer.mockImplementation(createFakeServer);
    mocks.agentCreate.mockResolvedValue(createFakeAgent());
    mocks.backfillOnBoot.mockResolvedValue(undefined);
    mocks.createPublisherControlFromStore.mockReturnValue({ __brand: 'publisher-control' });
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
      relays: [],
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
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    process.removeAllListeners('uncaughtException');
    for (const listener of uncaughtExceptionListeners) process.on('uncaughtException', listener);
    process.removeAllListeners('unhandledRejection');
    for (const listener of unhandledRejectionListeners) process.on('unhandledRejection', listener);
    process.removeAllListeners('SIGINT');
    for (const listener of sigintListeners) process.on('SIGINT', listener);
    process.removeAllListeners('SIGTERM');
    for (const listener of sigtermListeners) process.on('SIGTERM', listener);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0];
    closeDashboardDbFromAgentCreateArg(createArg);
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('injects one SQLite-indexed snapshot store into every daemon snapshot path', async () => {
    vi.useFakeTimers();
    const publicSnapshotStore = {
      putSnapshot: vi.fn(),
      getSnapshot: vi.fn(),
      getSnapshotPage: vi.fn(),
    };
    mocks.createPublicSnapshotStore.mockReturnValue(publicSnapshotStore);

    await runDaemonInner(true, {
      name: 'snapshot-index-wiring-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      apiPort: 0,
      bootstrapPeers: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      nodeRole: 'edge',
      auth: { enabled: false },
      promoteQueue: { enabled: false },
      source: 'monorepo',
      publisher: { enabled: true },
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
    } as any, Date.now());

    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.createPublicSnapshotStore).toHaveBeenCalledTimes(1);
    const [, , pageIndexStore] = mocks.createPublicSnapshotStore.mock.calls[0] as unknown[];
    expect(pageIndexStore).toBeInstanceOf(SqliteSnapshotPageIndexStore);

    const agentCreateArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    expect(agentCreateArg.publicSnapshotStore).toBe(publicSnapshotStore);

    const [, publisherControlOptions] = mocks.createPublisherControlFromStore.mock.calls[0] as [
      unknown,
      { publicSnapshotStore?: unknown },
    ];
    expect(publisherControlOptions.publicSnapshotStore).toBe(publicSnapshotStore);

    const publisherRuntimeArg = mocks.startPublisherRuntimeWithOutcome.mock.calls[0]?.[0] as any;
    expect(publisherRuntimeArg.publicSnapshotStore).toBe(publicSnapshotStore);
  });
});
