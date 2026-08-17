import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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

  function bootWith(publisher: Record<string, unknown>): Promise<unknown> {
    return runDaemonInner(true, {
      name: 'retry-tuning-boot-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      publisher: { enabled: true, ...publisher },
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
    } as any, Date.now());
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
      .rejects.toThrow(/publisher\.retryBackoffMaxMs must be at least publisher\.retryBackoffBaseMs/);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('fails the boot on a half-configured backoff pair', async () => {
    await expect(bootWith({ retryBackoffBaseMs: 30_000 }))
      .rejects.toThrow(/must be set together/);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('boots past the boundary with a fully valid retry-knob block', async () => {
    await expect(bootWith({
      autoRetryEnabled: false,
      retryJitterRatio: 0.35,
      retryBackoffBaseMs: 2_000,
      retryBackoffMaxMs: 90_000,
    })).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    const db = createArg?.chainEventCursorStore?.cursors?.db
      ?? createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
    db?.close?.();
  });
});
