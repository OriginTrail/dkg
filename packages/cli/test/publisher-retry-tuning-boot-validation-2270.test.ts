import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GH#2270 — a bad retry knob must fail CONFIG VALIDATION at daemon boot, not the
// publisher constructor. The publisher runtime starts deferred and folds its
// construction error into `publisher_startup_failed`, so without the boundary
// check at runDaemonInner a typo'd knob would boot a silently publisher-less
// node. These rows pin the boundary (and its ordering: before the chain-reset
// wipe and before DKGAgent.create), following the StorageACK timing precedent.
const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  chainResetWipe: vi.fn(),
  createServer: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
  daemonLogShutdown: vi.fn(),
  daemonLogPush: vi.fn(),
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
  return { ...actual, startPublisherRuntimeWithOutcome: mocks.startPublisherRuntimeWithOutcome };
});

vi.mock('../src/daemon/daemon-log-file-writer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/daemon-log-file-writer.js')>();
  return {
    ...actual,
    startDaemonLogFileWriter: (
      ...args: Parameters<typeof actual.startDaemonLogFileWriter>
    ) => {
      const writer = actual.startDaemonLogFileWriter(...args);
      return {
        ...writer,
        push: (data: string) => {
          mocks.daemonLogPush(data);
          return writer.push(data);
        },
        shutdown: () => mocks.daemonLogShutdown(writer.shutdown),
      };
    },
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

describe('runDaemonInner publisher retry-knob config validation (#2270)', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-retry-tuning-boot-'));
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
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    mocks.daemonLogShutdown.mockImplementation(
      async (shutdown: () => Promise<void>) => await shutdown(),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
    // A failed boot owns and drains its daemon-log writer before rejecting, so
    // teardown never needs timing-dependent filesystem retries.
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  function bootWith(
    publisher: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Promise<unknown> {
    return runDaemonInner(true, {
      name: 'retry-tuning-boot-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      publisher: { enabled: true, ...publisher, ...overrides },
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
    } as any, Date.now());
  }

  function closeAgentCreateDb(): void {
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    const db = createArg?.chainEventCursorStore?.cursors?.db
      ?? createArg?.contextGraphRegistryScanCursorStore?.store?.cursors?.db;
    db?.close?.();
  }

  it('fails the boot on an out-of-range retryJitterRatio before wipe or agent create', async () => {
    await expect(bootWith({ retryJitterRatio: 1.5 }))
      .rejects.toThrow(/publisher\.retryJitterRatio must be a number at least 0 and below 1/);

    expect(mocks.chainResetWipe).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(mocks.startPublisherRuntimeWithOutcome).not.toHaveBeenCalled();
  });

  it('fails the boot on a non-boolean autoRetryEnabled', async () => {
    await expect(bootWith({ autoRetryEnabled: 'off' }))
      .rejects.toThrow(/publisher\.autoRetryEnabled must be a boolean/);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('fails the boot on a backoff max below base', async () => {
    await expect(bootWith({ retryBackoffBaseMs: 30_000, retryBackoffMaxMs: 10_000 }))
      .rejects.toThrow(/publisher\.retryBackoffMaxMs \(10000\) must be at least publisher\.retryBackoffBaseMs \(30000\)/);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('fails the boot when a lone base exceeds the default max', async () => {
    await expect(bootWith({ retryBackoffBaseMs: 120_000 }))
      .rejects.toThrow(/publisher\.retryBackoffMaxMs \(60000, the default\) must be at least/);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('validates for ANY truthy enabled value, matching the runtime gate', async () => {
    // The runner starts the publisher on a TRUTHY enabled, so the boot gate
    // must cover exactly that set — a strict-boolean gate would skip
    // validation for enabled: 1 while the runtime still constructs and
    // crashes mid-boot.
    await expect(bootWith({ retryJitterRatio: '0.2' as never }, { enabled: 1 as never }))
      .rejects.toThrow(/publisher\.retryJitterRatio must be a number/);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('boots past the boundary when the publisher is DISABLED, even with an invalid knob', async () => {
    // A typo in a dormant publisher block must not take the node down: no
    // retry scheduler is constructed while enabled is false, so nothing
    // consumes the bad value. Operators disable the publisher precisely to
    // keep the node serving while they fix its config.
    await expect(bootWith({ retryJitterRatio: '0.2' as never }, { enabled: false }))
      .rejects.toThrow('after-agent-create');
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    closeAgentCreateDb();
  });

  // End-to-end teardown-determinism proof against the REAL writer: the
  // controlled ordering test pins that the rejection settles after shutdown() was
  // CALLED, but a mock-level assertion cannot catch a shutdown() that
  // resolves without actually draining, or a tee left installed. Nothing may
  // land in DKG_HOME once the boot has rejected — that is the property the
  // plain-rm() afterEach depends on (#2270's ENOTEMPTY race). The explicit
  // push-boundary assertion keeps this proof free of another timing budget.
  it('a failed boot writes nothing more into DKG_HOME after it rejects (#2270)', async () => {
    await expect(bootWith({ maxAttempts: 3 })).rejects.toThrow('after-agent-create');
    const logFile = join(tempHome!, 'daemon.log');
    const sizeAtRejection = (await stat(logFile)).size;
    expect(sizeAtRejection).toBeGreaterThan(0);
    const probe = 'post-rejection straggler probe\n';
    process.stdout.write(probe);
    process.stderr.write(probe);
    expect(mocks.daemonLogPush).not.toHaveBeenCalledWith(probe);
    expect((await stat(logFile)).size).toBe(sizeAtRejection);
    closeAgentCreateDb();
  });

  it('boots past the boundary with a fully valid retry-knob block', async () => {
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
    mocks.daemonLogShutdown.mockImplementationOnce(async (shutdown: () => Promise<void>) => {
      await shutdown();
      await shutdownGate;
    });

    const boot = bootWith({
      autoRetryEnabled: false,
      retryJitterRatio: 0.35,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 90_000,
    });
    let bootSettled = false;
    void boot.then(
      () => { bootSettled = true; },
      () => { bootSettled = true; },
    );
    await vi.waitFor(() => expect(mocks.daemonLogShutdown).toHaveBeenCalledTimes(1));
    expect(bootSettled).toBe(false);

    releaseShutdown();
    await expect(boot).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    closeAgentCreateDb();
  });
});
