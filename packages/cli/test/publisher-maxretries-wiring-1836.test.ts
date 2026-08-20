import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GH #1836 — regression at the CONFIG→CONSTRUCTION seam. The original bug was
// that daemon config was not forwarded into the admission-time publisher, so a
// helper-only test cannot protect it. These tests drive runDaemonInner and prove
// config.publisher.maxRetries reaches BOTH admission constructors:
//   • DKGAgent.create (publisherMaxRetries → agent publishAsync: EPCIS/Kafka), and
//   • createPublisherControlFromStore (daemon HTTP admission — the reported bug).
// Removing either forwarding makes one of these fail.
//
// GH#2270 extends the same seam: the admission instance now also carries the retry
// knobs, because it derives the `retryState` the job-detail routes serve.
const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  chainResetWipe: vi.fn(),
  createServer: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
  createPublisherControlFromStore: vi.fn(),
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
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

describe('runDaemonInner publisher admission-config wiring (#1836, #2270)', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-maxretries-wiring-'));
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

  // agentCreate rejects → runDaemonInner throws right after DKGAgent.create, so we
  // capture the exact create arg (the DKGAgent.create forwarding).
  async function captureCreateArg(configOverrides: Record<string, unknown> = {}): Promise<any> {
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    await expect(runDaemonInner(true, {
      name: 'maxretries-wiring-core-test',
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

  it('forwards config.publisher.maxRetries (incl. 0) into DKGAgent.create as publisherMaxRetries', async () => {
    const createArg = await captureCreateArg({ publisher: { enabled: true, maxRetries: 0 } });
    expect(createArg.publisherMaxRetries).toBe(0);
  });

  it('leaves publisherMaxRetries undefined when unconfigured (publisher default preserved)', async () => {
    const createArg = await captureCreateArg();
    expect(createArg.publisherMaxRetries).toBeUndefined();
  });

  /**
   * Boot far enough to capture the admission-construction call, then stop right there so
   * the rest of daemon startup needs no faking. Shared by the #1836 budget row and the
   * GH#2270 retry-knob rows — one seam, one harness.
   */
  async function captureAdmissionControlCall(
    publisher: Record<string, unknown>,
  ): Promise<{ store: unknown; options: { maxRetries?: number; retryTuning?: Record<string, unknown> }; agentStore: unknown }> {
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
    mocks.createPublisherControlFromStore.mockImplementation(() => {
      throw new Error('after-publisher-control');
    });

    await expect(runDaemonInner(true, {
      name: 'maxretries-wiring-admission-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      apiPort: 0,
      nodeRole: 'edge',
      auth: { enabled: false },
      promoteQueue: { enabled: false },
      source: 'monorepo',
      publisher,
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
    } as any, Date.now())).rejects.toThrow('after-publisher-control');

    closeDashboardDbFromAgentCreateArg(mocks.agentCreate.mock.calls[0]?.[0]);
    expect(mocks.createPublisherControlFromStore).toHaveBeenCalledTimes(1);
    const [store, options] = mocks.createPublisherControlFromStore.mock.calls[0] as [
      unknown,
      { maxRetries?: number; retryTuning?: Record<string, unknown> },
    ];
    return { store, options, agentStore: fakeAgent.store };
  }

  it('forwards config.publisher.maxRetries into createPublisherControlFromStore (daemon HTTP admission)', async () => {
    const { store, options, agentStore } = await captureAdmissionControlCall({ enabled: true, maxRetries: 0 });
    expect(store).toBe(agentStore);
    expect(options.maxRetries).toBe(0);
  });

  // GH#2270 — the admission instance also DERIVES the `retryState` the job-detail routes
  // serve, and that derivation reads the effective kill-switch. Without this forwarding the
  // route would answer "this node will retry it" on a node where the operator switched the
  // lane off: the #1836 dead-config class again, on a read surface.
  it('forwards the resolved retry knobs into the admission control (#2270)', async () => {
    const { options } = await captureAdmissionControlCall({
      enabled: true,
      autoRetryEnabled: false,
      retryJitterRatio: 0.4,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 90_000,
    });

    expect(options.retryTuning).toEqual({
      autoRetryEnabled: false,
      retryJitterRatio: 0.4,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 90_000,
    });
  });

  // A DORMANT publisher block is never validated at boot (a typo there must not stop a node
  // that publishes nothing), so it is not resolved here either — and with no runtime there
  // is no automatic lane, which is exactly what the forced-off switch makes the projection
  // report. An invalid knob in a disabled block must still boot.
  it('forces the projection switch off for a disabled publisher, without resolving the block (#2270)', async () => {
    const { options } = await captureAdmissionControlCall({
      enabled: false,
      retryJitterRatio: 5,
    });

    expect(options.retryTuning).toEqual({ autoRetryEnabled: false });
  });
});
