import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNetworkId } from '../../core/src/genesis.js';
import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';
import { DashboardDB, SqliteContextGraphStorageDiscoveryStore } from '@origintrail-official/dkg-node-ui';
import * as corePrerequisites from '../src/daemon/core-prereq-check.js';
import {
  DEFAULT_DAEMON_LOG_MAX_BYTES,
} from '../src/daemon/log-rotation.js';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { ChainIndexReadWorker } from '../src/daemon/worker/chain-index-read-worker.js';

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
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

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  if (db?.open) db.close();
}

/**
 * The ContextGraphStorage discovery checkpoint must reach the agent as a
 * durable store scoped to this chain deployment. The agent silently falls back
 * to an in-memory store when none is passed, so only this catches a dropped
 * wiring (a re-enumeration from id 1 on every restart) or a dropped scope (a
 * node home reused across deployments replaying another one's catalog).
 */
async function expectDeploymentScopedStorageDiscoveryStore(
  createArg: any,
  deploymentId: string,
): Promise<void> {
  const store = createArg.contextGraphStorageDiscoveryStore;
  expect(store).toBeInstanceOf(SqliteContextGraphStorageDiscoveryStore);
  expect(store.scope).toBe(deploymentId);
  const checkpoint = { version: 1, nextId: '7', entries: [] };
  await store.save(checkpoint);
  const dashboard = { db: createArg.chainEventCursorStore.cursors.db } as any;
  await expect(new SqliteContextGraphStorageDiscoveryStore(dashboard, { scope: deploymentId }).load())
    .resolves.toEqual(checkpoint);
  await expect(new SqliteContextGraphStorageDiscoveryStore(dashboard, {
    scope: buildEvmDeploymentId({
      chainId: 'evm:1',
      hubAddress: '0x9999999999999999999999999999999999999999',
    }),
  }).load()).resolves.toBeUndefined();
}

async function readFileTail(path: string, maxBytes = 16 * 1024): Promise<string> {
  const before = await stat(path);
  const bytesToRead = Math.min(before.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(path, 'r');
  try {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      bytesToRead,
      before.size - bytesToRead,
    );
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await handle.close();
  }
}

describe('daemon startup network validation', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.removeAllListeners('uncaughtException');
    for (const listener of uncaughtExceptionListeners) {
      process.on('uncaughtException', listener);
    }
    process.removeAllListeners('unhandledRejection');
    for (const listener of unhandledRejectionListeners) {
      process.on('unhandledRejection', listener);
    }
    if (originalDkgHome === undefined) {
      delete process.env.DKG_HOME;
    } else {
      process.env.DKG_HOME = originalDkgHome;
    }
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('rejects an unsupported Node runtime before agent creation', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-node-runtime-startup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => undefined);

    await expect(runDaemonInner(true, {
      name: 'node-runtime-startup-test',
      listenPort: 0,
      nodeRole: 'edge',
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow(
      'Node runtime preflight failed',
    );

    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map(call => String(call[0])).join('')).toContain(
      'FATAL: node:sqlite is unavailable',
    );
  });

  it('exits before agent creation when the selected network is pre-deployment', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-predeployment-startup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    const networkId = await computeNetworkId('base-mainnet');
    mocks.loadNetworkConfig.mockResolvedValue({
      _status: 'pre-deployment: replace PEER_ID_* relay values before enabling Base mainnet',
      networkName: 'DKG V10 Base Mainnet',
      genesisId: 'base-mainnet',
      networkId,
      genesisVersion: 1,
      relays: ['/ip4/178.105.87.39/tcp/9090/p2p/PEER_ID_SOLARIS'],
      defaultNodeRole: 'edge',
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit:${code}`);
      }) as never);

    await expect(runDaemonInner(true, {
      name: 'predeployment-startup-test',
      networkConfig: 'mainnet-base',
      listenPort: 0,
      nodeRole: 'edge',
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('process.exit:1');

    expect(mocks.loadNetworkConfig).toHaveBeenCalledWith('mainnet-base');
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map(call => String(call[0])).join('')).toContain(
      'FATAL: network config DKG V10 Base Mainnet is marked pre-deployment',
    );
  });

  it('rotates an oversized inherited daemon log during startup before tee appends', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-log-rotation-startup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    const daemonLog = join(tempHome, 'daemon.log');
    const logHandle = await open(daemonLog, 'w');
    await logHandle.truncate(DEFAULT_DAEMON_LOG_MAX_BYTES + 1024);
    await logHandle.close();

    mocks.loadNetworkConfig.mockResolvedValue(null);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    await expect(runDaemonInner(true, {
      name: 'startup-log-rotation-test',
      networkConfig: 'missing-mainnet',
      listenPort: 0,
      nodeRole: 'edge',
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('process.exit:1');

    expect((await stat(daemonLog)).size).toBeLessThan(DEFAULT_DAEMON_LOG_MAX_BYTES);
    let tail = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      tail = await readFileTail(daemonLog);
      if (tail.includes('Rotated daemon.log during startup')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(tail).toContain('Rotated daemon.log during startup');
  });

  it('exits before agent creation when config.networkConfig does not resolve', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-missing-network-startup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    mocks.loadNetworkConfig.mockResolvedValue(null);
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit:${code}`);
      }) as never);

    await expect(runDaemonInner(true, {
      name: 'missing-network-startup-test',
      networkConfig: 'missing-mainnet',
      listenPort: 0,
      nodeRole: 'edge',
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('process.exit:1');

    expect(mocks.loadNetworkConfig).toHaveBeenCalledWith('missing-mainnet');
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map(call => String(call[0])).join('')).toContain(
      'FATAL: network config "missing-mainnet" was not found',
    );
  });

  it('infers a legacy network from chainId and passes its genesis id into agent creation', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-genesis-startup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'edge',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.agentCreate.mockImplementation(async (createArg) => {
      const authorityCheckpoint = {
        version: 1,
        state: { throughBlockNumber: 30 },
        integrity: `0x${'11'.repeat(32)}`,
      };
      await createArg.localContextGraphAuthorityHistoryStore.save(
        'daemon-startup-wiring',
        authorityCheckpoint,
      );
      await expect(createArg.localContextGraphAuthorityHistoryStore.load('daemon-startup-wiring'))
        .resolves.toEqual(authorityCheckpoint);
      await createArg.localContextGraphAuthorityHistoryStore.delete('daemon-startup-wiring');
      await expect(createArg.localContextGraphAuthorityHistoryStore.load('daemon-startup-wiring'))
        .resolves.toBeUndefined();
      const indexCheckpoint = {
        version: 1,
        cursor: { throughBlockNumber: 30 },
        integrity: `0x${'22'.repeat(32)}`,
      };
      await expect(createArg.localContextGraphAuthorityIndexStore.compareAndSwap(
        'daemon-startup-index-wiring',
        undefined,
        indexCheckpoint,
      )).resolves.toBe(1);
      await expect(createArg.localContextGraphAuthorityIndexStore.load(
        'daemon-startup-index-wiring',
      )).resolves.toEqual({ token: 1, value: indexCheckpoint });
      await expect(createArg.localContextGraphAuthorityIndexStore.invalidate(
        'daemon-startup-index-wiring',
        1,
      )).resolves.toBe(2);
      await expect(createArg.localContextGraphAuthorityIndexStore.load(
        'daemon-startup-index-wiring',
      )).resolves.toEqual({ token: 2, value: null });
      expect((createArg.chainEventCursorStore as any).scope).toBe(buildEvmDeploymentId({
        chainId: 'gnosis:100',
        hubAddress: '0x1234567890123456789012345678901234567890',
      }));
      await expectDeploymentScopedStorageDiscoveryStore(createArg, buildEvmDeploymentId({
        chainId: 'gnosis:100',
        hubAddress: '0x1234567890123456789012345678901234567890',
      }));
      throw new Error('after-agent-create');
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runDaemonInner(true, {
      name: 'genesis-startup-test',
      listenPort: 0,
      nodeRole: 'edge',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'gnosis:100',
      },
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');

    expect(mocks.loadNetworkConfig).toHaveBeenCalledWith('mainnet-gnosis');
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    expect(createArg).toMatchObject({
      genesisId: 'gnosis-mainnet',
      chainEventCursorStore: {
        loadLane: expect.any(Function),
        saveLane: expect.any(Function),
      },
      contextGraphRegistryScanCursorStore: {
        load: expect.any(Function),
        save: expect.any(Function),
      },
      localContextGraphAuthorityHistoryStore: {
        load: expect.any(Function),
        save: expect.any(Function),
        delete: expect.any(Function),
      },
      localContextGraphAuthorityIndexStore: {
        load: expect.any(Function),
        compareAndSwap: expect.any(Function),
        invalidate: expect.any(Function),
      },
      chainIndex: {
        store: {
          load: expect.any(Function),
          commit: expect.any(Function),
          tombstone: expect.any(Function),
          readEvents: expect.any(Function),
          blockHashAt: expect.any(Function),
        },
        readModelFactory: expect.any(Function),
      },
    });
    expect(createArg.chainEventCursorStore.cursors.db.open).toBe(false);
  });

  it('scopes chain event cursors with the EVM default chain id when chainId is omitted', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-omitted-chainid-startup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'Local EVM',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: [],
      defaultNodeRole: 'edge',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.agentCreate.mockImplementation(async (createArg) => {
      await expectDeploymentScopedStorageDiscoveryStore(createArg, buildEvmDeploymentId({
        chainId: 'evm:31337',
        hubAddress: '0x2234567890123456789012345678901234567890',
      }));
      throw new Error('after-agent-create');
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runDaemonInner(true, {
      name: 'omitted-chainid-startup-test',
      networkConfig: 'local-evm',
      listenPort: 0,
      nodeRole: 'edge',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x2234567890123456789012345678901234567890',
      },
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    expect((createArg.chainEventCursorStore as any).scope).toBe(buildEvmDeploymentId({
      chainId: 'evm:31337',
      hubAddress: '0x2234567890123456789012345678901234567890',
    }));
    expect(createArg.chainEventCursorStore.cursors.db.open).toBe(false);
  });

  it('reuses resource cleanup for a fatal prerequisite and its propagated startup failure', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-fatal-resource-cleanup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'Local EVM', genesisId: 'gnosis-mainnet', genesisVersion: 1,
      relays: [], defaultNodeRole: 'core',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(corePrerequisites, 'checkCoreRelayPrereqs').mockReturnValue({
      publicListenAddresses: [], nonRoutableAddresses: [], looksDegraded: true,
      indeterminate: false, reasons: ['no public listener'],
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fatal prerequisite exit'); });
    const events: string[] = [];
    const actualReaderClose = ChainIndexReadWorker.prototype.close;
    const readerClose = vi.spyOn(ChainIndexReadWorker.prototype, 'close').mockImplementation(async function () {
      events.push('reader');
      await actualReaderClose.call(this);
    });
    const actualDbClose = DashboardDB.prototype.close;
    const dbClose = vi.spyOn(DashboardDB.prototype, 'close').mockImplementation(function () {
      events.push('database');
      actualDbClose.call(this);
    });
    await expect(runDaemonInner(true, {
      name: 'fatal-resource-cleanup', networkConfig: 'local-evm', listenPort: 0,
      nodeRole: 'core', core: { allowDegradedRelay: false },
      chain: { type: 'evm', rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890', chainId: 'evm:31337' },
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('fatal prerequisite exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(readerClose).toHaveBeenCalledOnce();
    expect(dbClose).toHaveBeenCalledOnce();
    expect(events).toEqual(['reader', 'database']);
  });

  it('awaits reader shutdown when boot fails after a chain-index read starts the worker', async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-reader-startup-cleanup-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'Local EVM', genesisId: 'gnosis-mainnet', genesisVersion: 1,
      relays: [], defaultNodeRole: 'edge',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const modelOptions = {
      scope: 'startup-cleanup-test',
      contextGraphStorageAddress: '0x1234567890123456789012345678901234567890',
      contextGraphStorageAbi: '[]', maxHeadAgeMs: 15_000,
    };
    mocks.agentCreate.mockImplementation(async (createArg) => {
      // The empty local log refuses this read, but it opens the real worker's
      // read-only SQLite connection before the simulated startup failure.
      await createArg.chainIndex.readModelFactory(modelOptions).readContextGraphForKa(42n);
      throw new Error('boot failed after reader started');
    });

    let releaseClose!: () => void;
    let closeStarted!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closing = new Promise<void>((resolve) => { closeStarted = resolve; });
    const actualClose = ChainIndexReadWorker.prototype.close;
    const close = vi.spyOn(ChainIndexReadWorker.prototype, 'close')
      .mockImplementation(async function (this: ChainIndexReadWorker) {
        closeStarted();
        await closeGate;
        await actualClose.call(this);
      });
    let settled = false;
    const startup = runDaemonInner(true, {
      name: 'reader-startup-cleanup-test', networkConfig: 'local-evm', listenPort: 0, nodeRole: 'edge',
      chain: { type: 'evm', rpcUrl: 'https://private-rpc.example',
        hubAddress: modelOptions.contextGraphStorageAddress, chainId: 'evm:31337' },
    } as any, Date.now(), resolveShutdownPolicy(undefined)).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await Promise.race([
        closing,
        startup.then(() => { throw new Error('Boot settled before reader cleanup started'); }),
      ]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).toHaveBeenCalledOnce();
      const sharedDb = mocks.agentCreate.mock.calls[0]?.[0].chainEventCursorStore.cursors.db;
      expect(sharedDb.open).toBe(true);
      expect(settled).toBe(false);
      releaseClose();
      expect(await startup).toMatchObject({ message: 'boot failed after reader started' });
      expect(sharedDb.open).toBe(false);
      const reader = close.mock.contexts[0] as ChainIndexReadWorker;
      await expect(reader.createReadModel(modelOptions).readContextGraphForKa(43n))
        .resolves.toBeUndefined();
    } finally {
      releaseClose();
      await startup;
      const reader = close.mock.contexts[0] as ChainIndexReadWorker | undefined;
      if (reader) await actualClose.call(reader);
      closeDashboardDbFromAgentCreateArg(mocks.agentCreate.mock.calls[0]?.[0]);
    }
  });
});
