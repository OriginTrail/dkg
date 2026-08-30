import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GH #1828 — regression at the daemon-boot WIRING point. The durable-admission
// intent index only repairs pre-index jobs if runDaemonInner actually calls the
// backfill on boot. The helper's own contract is unit-tested in
// vm-publish-intent-backfill.test.ts, but a helper-only test stays green if the
// boot call (lifecycle.ts) is deleted or moved out of the boot path. This drives
// runDaemonInner and proves backfillVmPublishIntentIndexOnBoot is invoked with the
// admission publisher control that createPublisherControlFromStore returns.
// (Mirrors the #1836 config→construction wiring test.)
const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  chainResetWipe: vi.fn(),
  createServer: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
  createPublisherControlFromStore: vi.fn(),
  backfillOnBoot: vi.fn(),
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

vi.mock('../src/publisher-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/publisher-runner.js')>();
  return {
    ...actual,
    startPublisherRuntimeWithOutcome: mocks.startPublisherRuntimeWithOutcome,
    createPublisherControlFromStore: mocks.createPublisherControlFromStore,
  };
});

vi.mock('../src/daemon/vm-publish-intent-backfill.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/vm-publish-intent-backfill.js')>();
  return { ...actual, backfillVmPublishIntentIndexOnBoot: mocks.backfillOnBoot };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

function createFakeServer() {
  const server = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); return server; }),
    address: vi.fn(() => ({ port: 43123 })),
    close: vi.fn((cb?: () => void) => { cb?.(); return server; }),
    on: vi.fn(() => server),
    once: vi.fn(() => server),
  };
  return server;
}

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorPersistence?.store?.cursors?.db;
  db?.close?.();
}

describe('runDaemonInner VM-publish intent backfill wiring (#1828)', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-backfill-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    sigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    sigtermListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];

    mocks.createServer.mockImplementation(createFakeServer);
    mocks.startPublisherRuntimeWithOutcome.mockResolvedValue({
      runtime: null,
      availability: { available: false, reason: 'no_publisher_wallets', retryable: false, operatorActionRequired: true },
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
      wiped: false, skipped: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [],
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.removeAllListeners('uncaughtException');
    for (const l of uncaughtExceptionListeners) process.on('uncaughtException', l);
    process.removeAllListeners('unhandledRejection');
    for (const l of unhandledRejectionListeners) process.on('unhandledRejection', l);
    process.removeAllListeners('SIGINT');
    for (const l of sigintListeners) process.on('SIGINT', l);
    process.removeAllListeners('SIGTERM');
    for (const l of sigtermListeners) process.on('SIGTERM', l);
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('invokes backfillVmPublishIntentIndexOnBoot with the admission publisher control on boot', async () => {
    const fakeAgent = {
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
      drainRpcUsage: vi.fn(() => ({ calls: 0, errors: 0, throttledMs: 0, byEndpoint: {} })),
    };
    mocks.agentCreate.mockResolvedValue(fakeAgent);
    // createPublisherControlFromStore returns the admission control; boot then reaches
    // the backfill call on the very next statement (lifecycle.ts). Make the backfill
    // reject to stop boot cleanly right there so the rest of startup isn't faked.
    const fakeControl = { __brand: 'publisher-control' };
    mocks.createPublisherControlFromStore.mockReturnValue(fakeControl as never);
    mocks.backfillOnBoot.mockRejectedValue(new Error('after-backfill'));

    await expect(runDaemonInner(true, {
      name: 'backfill-wiring-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      apiPort: 0,
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
    } as any, Date.now())).rejects.toThrow('after-backfill');

    closeDashboardDbFromAgentCreateArg(mocks.agentCreate.mock.calls[0]?.[0]);
    // The boot path actually called the backfill (delete the call → this fails)...
    expect(mocks.backfillOnBoot).toHaveBeenCalledTimes(1);
    // ...with the SAME control createPublisherControlFromStore built (the wiring).
    const [controlArg] = mocks.backfillOnBoot.mock.calls[0] as [unknown, unknown];
    expect(controlArg).toBe(fakeControl);
  });
});
