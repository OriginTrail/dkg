import { afterEach, beforeEach, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShutdownPolicy } from '../../src/daemon/shutdown-policy.js';

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  chainResetWipe: vi.fn(),
  createServer: vi.fn(),
  checkExternalStoreReachable: vi.fn(),
  checkOrSetStoreIdentity: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  startPublisherRuntimeWithOutcome: vi.fn(),
  startManagedOxigraph: vi.fn(),
}));

export const daemonWiringMocks = mocks;

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

vi.mock('../../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    ...actual,
    loadNetworkConfig: mocks.loadNetworkConfig,
  };
});

vi.mock('../../src/daemon/chain-reset-wipe.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/daemon/chain-reset-wipe.js')>();
  return {
    ...actual,
    chainResetWipe: mocks.chainResetWipe,
  };
});

vi.mock('../../src/daemon/oxigraph-managed.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/daemon/oxigraph-managed.js')>();
  return { ...actual, startManagedOxigraph: mocks.startManagedOxigraph };
});

vi.mock('../../src/daemon/store-health-check.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/daemon/store-health-check.js')>();
  return {
    ...actual,
    checkExternalStoreReachable: mocks.checkExternalStoreReachable,
    checkOrSetStoreIdentity: mocks.checkOrSetStoreIdentity,
  };
});

vi.mock('../../src/publisher-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/publisher-runner.js')>();
  return {
    ...actual,
    startPublisherRuntimeWithOutcome: mocks.startPublisherRuntimeWithOutcome,
  };
});

export const { runDaemonInner } = await import('../../src/daemon/lifecycle.js');

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

export function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

/** One owner for mocked daemon lifecycle setup and global resource restoration. */
export function installDaemonLifecycleWiringFixture() {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let exitListeners: NodeJS.ExitListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];
  let stdoutLines: string[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-storage-ack-timing-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    exitListeners = process.listeners('exit') as NodeJS.ExitListener[];
    sigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    sigtermListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];
    stdoutLines = [];

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
    mocks.startManagedOxigraph.mockResolvedValue(null);
    mocks.checkExternalStoreReachable.mockResolvedValue({
      ok: true,
      backend: 'sparql-http',
      endpoint: 'http://127.0.0.1:7878/query',
    });
    mocks.checkOrSetStoreIdentity.mockResolvedValue({
      ok: true,
      action: 'matched',
      nodeName: 'storage-ack-timing-core-test',
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
      status: 'inactive',
      attempted: false,
      requiresStoreRetag: false,
      prevMarker: null,
      removedFiles: [],
      backedUpFiles: [],
      failedFiles: [],
    });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
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
    process.removeAllListeners('exit');
    for (const listener of exitListeners) process.on('exit', listener);
    process.removeAllListeners('SIGINT');
    for (const listener of sigintListeners) process.on('SIGINT', listener);
    process.removeAllListeners('SIGTERM');
    for (const listener of sigtermListeners) process.on('SIGTERM', listener);
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (tempHome) {
      await rm(tempHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
    tempHome = undefined;
  });

  async function captureCreateArg(
    configOverrides: Record<string, unknown> = {},
    inspectDuringCreate?: (createArg: any) => Promise<void>,
  ): Promise<any> {
    if (inspectDuringCreate) {
      mocks.agentCreate.mockImplementationOnce(async (createArg: any) => {
        await inspectDuringCreate(createArg);
        throw new Error('after-agent-create');
      });
    }
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
        receiptTimeoutMs: 1_200_000,
      },
      ...configOverrides,
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    closeDashboardDbFromAgentCreateArg(createArg);
    return createArg;
  }

  return {
    captureCreateArg,
    get tempHome() { return tempHome; },
    get stdoutLines() { return stdoutLines; },
    get uncaughtExceptionListeners() { return uncaughtExceptionListeners; },
    get unhandledRejectionListeners() { return unhandledRejectionListeners; },
  };
}
