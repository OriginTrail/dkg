/**
 * Daemon call-site wiring guard for the store-survivability build
 * (2026-07-18 mainnet wedge): runDaemonInner must actually invoke the
 * boot recovery and install the runtime store monitor under the intended
 * conditions. The helper state machines are covered in
 * store-monitor.test.ts, but those tests instantiate the helpers
 * directly — if lifecycle.ts dropped the managedByDkg condition, the
 * harden lock path, the health re-check after recovery, or the
 * daemonState.storeMonitor assignment, every helper test would stay
 * green while the fleet silently lost its self-healing. These tests
 * pin the wiring.
 *
 * Pattern mirrors daemon-sync-agents-meta-wiring.test.ts /
 * daemon-storage-ack-timing-wiring.test.ts: mock DKGAgent.create (reject
 * to unwind after the boot-phase assertions, or resolve a fake agent +
 * fake http server for the full-boot monitor-install case). The
 * store-runtime-monitor module is PARTIALLY mocked: recovery + monitor
 * factory are mocks, but resolveManagedBlazegraphContainer and the lock
 * path helpers stay REAL so the managed-store criteria under test are
 * the production ones.
 */
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
  checkExternalStoreReachable: vi.fn(),
  checkOrSetStoreIdentity: vi.fn(),
  attemptManagedStoreBootRecovery: vi.fn(),
  createStoreRuntimeMonitor: vi.fn(),
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

vi.mock('../src/daemon/store-health-check.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/store-health-check.js')>();
  return {
    ...actual, // real formatters
    checkExternalStoreReachable: mocks.checkExternalStoreReachable,
    checkOrSetStoreIdentity: mocks.checkOrSetStoreIdentity,
  };
});

vi.mock('../src/daemon/store-runtime-monitor.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/store-runtime-monitor.js')>();
  return {
    // Keep resolveManagedBlazegraphContainer + lock-path helpers REAL —
    // the managed-store criteria are part of what these tests verify.
    ...actual,
    attemptManagedStoreBootRecovery: mocks.attemptManagedStoreBootRecovery,
    createStoreRuntimeMonitor: mocks.createStoreRuntimeMonitor,
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');
const { daemonState } = await import('../src/daemon/state.js');
const { storeHardenLockPath, storeBootRestartTsPath } = await import(
  '../src/daemon/store-runtime-monitor.js'
);

const MANAGED_STORE = {
  backend: 'blazegraph',
  options: {
    url: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql',
    managedByDkg: true,
  },
};
const OPERATOR_STORE = {
  backend: 'blazegraph',
  options: { url: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql' },
};
const CONTAINER = 'dkg-blazegraph-dkg';

const HEALTH_OK = {
  ok: true,
  backend: 'blazegraph',
  endpoint: MANAGED_STORE.options.url,
};
const HEALTH_DEAD = {
  ok: false,
  backend: 'blazegraph',
  endpoint: MANAGED_STORE.options.url,
  error: 'timed out after 5000ms',
};

function createFakeServer() {
  const server = {
    listen: vi.fn((_port: number, _host: string, cb?: () => void) => {
      cb?.();
      return server;
    }),
    address: vi.fn(() => ({ port: 43124 })),
    close: vi.fn((cb?: () => void) => {
      cb?.();
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
    // A circuit address up-front, or the boot's relay-reservation loop
    // polls agent.multiaddrs for a full 10 seconds per test.
    multiaddrs: ['/ip4/127.0.0.1/tcp/9090/p2p/relay-peer/p2p-circuit/p2p/self-peer'],
    wallet: {
      keypair: {
        publicKey: new Uint8Array([1]),
        secretKey: new Uint8Array([2]),
      },
    },
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
    createACKTransportFactory: vi.fn(() => () => ({})),
    drainRpcUsage: vi.fn(() => ({ calls: 0, errors: 0, throttledMs: 0, byEndpoint: {} })),
  };
}

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'store-monitor-wiring-test',
    networkConfig: 'mainnet-gnosis',
    listenPort: 0,
    nodeRole: 'edge',
    apiPort: 0,
    auth: { enabled: false },
    promoteQueue: { enabled: false },
    chain: {
      type: 'evm',
      rpcUrl: 'https://private-rpc.example',
      hubAddress: '0x1234567890123456789012345678901234567890',
      chainId: 'evm:100',
    },
    ...overrides,
  } as any;
}

describe('runDaemonInner store recovery/monitor wiring', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-store-monitor-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    delete process.env.DKG_STORE_MONITOR_DISABLED;
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
    mocks.checkExternalStoreReachable.mockResolvedValue(HEALTH_OK);
    mocks.checkOrSetStoreIdentity.mockResolvedValue({
      ok: true,
      action: 'matched',
      nodeName: 'store-monitor-wiring-test',
    });
    mocks.attemptManagedStoreBootRecovery.mockResolvedValue(true);
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    daemonState.storeMonitor = null;
    vi.restoreAllMocks();
    vi.clearAllMocks();
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

  it('managed Blazegraph failing the boot probe triggers recovery with the real container name and lock paths, then re-checks health', async () => {
    // First probe: dead (the wedge). Every later probe: healthy (recovery
    // "worked"), so the boot proceeds instead of exit(1).
    mocks.checkExternalStoreReachable
      .mockResolvedValueOnce(HEALTH_DEAD)
      .mockResolvedValue(HEALTH_OK);

    await expect(
      runDaemonInner(true, baseConfig({ store: MANAGED_STORE }), Date.now()),
    ).rejects.toThrow('after-agent-create');
    closeDashboardDbFromAgentCreateArg(mocks.agentCreate.mock.calls[0]?.[0]);

    expect(mocks.attemptManagedStoreBootRecovery).toHaveBeenCalledTimes(1);
    const arg = mocks.attemptManagedStoreBootRecovery.mock.calls[0][0];
    // Container name resolved by the REAL resolveManagedBlazegraphContainer
    // from the store URL — not a hardcoded test value.
    expect(arg.managedContainerName).toBe(CONTAINER);
    expect(arg.storeConfig).toEqual(MANAGED_STORE);
    // The harden lock / boot-cooldown files must be the ones the harden
    // executor writes and the monitor reads: <dkgDir()>/…
    expect(arg.hardenLockPath).toBe(storeHardenLockPath(tempHome!));
    expect(arg.restartCooldownFilePath).toBe(storeBootRestartTsPath(tempHome!));
    // Health is RE-CHECKED after recovery (probe count: initial + recheck).
    expect(mocks.checkExternalStoreReachable.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Boot proceeded past the store gate: identity check ran, agent created.
    expect(mocks.checkOrSetStoreIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
  });

  it('an operator-managed store failing the probe exits 1 WITHOUT any docker recovery', async () => {
    mocks.checkExternalStoreReachable.mockResolvedValue(HEALTH_DEAD);

    await expect(
      runDaemonInner(true, baseConfig({ store: OPERATOR_STORE }), Date.now()),
    ).rejects.toThrow('process.exit:1');

    // The fail-fast contract for stores the daemon does not own: no
    // recovery, no monitor, no agent boot.
    expect(mocks.attemptManagedStoreBootRecovery).not.toHaveBeenCalled();
    expect(mocks.createStoreRuntimeMonitor).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  /**
   * Unref every positive-delay timer the boot schedules (profile publish,
   * pings, pruners) so the full-boot tests neither leak post-test timer
   * callbacks nor hold the process open — same trick as
   * daemon-storage-ack-timing-wiring.test.ts.
   */
  function unrefBootTimers(): void {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: any[]) => {
      const handle = realSetTimeout(handler, timeout, ...args);
      if ((timeout ?? 0) > 0) (handle as NodeJS.Timeout).unref?.();
      return handle;
    }) as typeof setTimeout);
  }

  it('a healthy managed-store startup installs the runtime monitor into daemonState with the harden lock path, and shutdown stops it', async () => {
    unrefBootTimers();
    const fakeMonitor = {
      start: vi.fn(),
      stop: vi.fn(),
      tick: vi.fn(async () => undefined),
      stats: {
        probesTotal: 0,
        failuresTotal: 0,
        consecutiveFailures: 0,
        restartsTotal: 0,
        restartFailuresTotal: 0,
        lastProbeOkAt: null,
        lastRestartAt: null,
        cooldownUntilMs: null,
        managedContainer: CONTAINER,
      },
    };
    mocks.createStoreRuntimeMonitor.mockReturnValue(fakeMonitor);
    mocks.agentCreate.mockResolvedValue(createFakeAgent());

    await runDaemonInner(true, baseConfig({ store: MANAGED_STORE }), Date.now());

    // No recovery needed on a healthy store.
    expect(mocks.attemptManagedStoreBootRecovery).not.toHaveBeenCalled();

    expect(mocks.createStoreRuntimeMonitor).toHaveBeenCalledTimes(1);
    const arg = mocks.createStoreRuntimeMonitor.mock.calls[0][0];
    expect(arg.managedContainerName).toBe(CONTAINER);
    expect(arg.storeConfig).toEqual(MANAGED_STORE);
    // The monitor must watch the SAME lock path the harden executor writes.
    expect(arg.hardenLockPath).toBe(storeHardenLockPath(tempHome!));
    expect(fakeMonitor.start).toHaveBeenCalledTimes(1);
    // The long-running daemon state carries the monitor (status route +
    // shutdown path read it from here).
    expect(daemonState.storeMonitor).toBe(fakeMonitor);

    // Shutdown wiring: the SIGTERM handler installed by this boot must stop
    // the monitor and clear the slot.
    const shutdownListeners = (process.listeners('SIGTERM') as NodeJS.SignalsListener[])
      .filter((l) => !sigtermListeners.includes(l));
    expect(shutdownListeners.length).toBeGreaterThan(0);
    for (const listener of shutdownListeners) {
      try {
        await (listener as (signal: string) => unknown)('SIGTERM');
      } catch (err) {
        // The shutdown path ends in process.exit, which the test mocks to
        // throw — everything before it (including monitor.stop) has run.
        expect((err as Error).message).toMatch(/process\.exit/);
      }
    }
    expect(fakeMonitor.stop).toHaveBeenCalled();
    expect(daemonState.storeMonitor).toBeNull();
  });

  it('DKG_STORE_MONITOR_DISABLED=1 keeps the monitor uninstalled even for a managed store', async () => {
    process.env.DKG_STORE_MONITOR_DISABLED = '1';
    try {
      unrefBootTimers();
      mocks.agentCreate.mockResolvedValue(createFakeAgent());
      await runDaemonInner(true, baseConfig({ store: MANAGED_STORE }), Date.now());
      expect(mocks.createStoreRuntimeMonitor).not.toHaveBeenCalled();
      expect(daemonState.storeMonitor).toBeNull();
    } finally {
      delete process.env.DKG_STORE_MONITOR_DISABLED;
    }
  });
});
