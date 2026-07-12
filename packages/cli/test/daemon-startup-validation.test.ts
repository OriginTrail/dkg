import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNetworkId } from '../../core/src/genesis.js';
import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
  checkExternalStoreReachable: vi.fn(),
  checkOrSetStoreIdentity: vi.fn(),
  startManagedOxigraph: vi.fn(),
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

vi.mock('../src/daemon/oxigraph-managed.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/oxigraph-managed.js')>();
  return {
    ...actual,
    startManagedOxigraph: mocks.startManagedOxigraph,
  };
});

vi.mock('../src/daemon/store-health-check.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/store-health-check.js')>();
  return {
    ...actual,
    checkExternalStoreReachable: mocks.checkExternalStoreReachable,
    checkOrSetStoreIdentity: mocks.checkOrSetStoreIdentity,
  };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

function closeDashboardDbFromAgentCreateArg(createArg: any): void {
  const db =
    createArg?.chainEventCursorStore?.cursors?.db ??
    createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
  db?.close?.();
}

describe('daemon startup network validation', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  const originalAcceptStoreReset = process.env.DKG_ACCEPT_STORE_RESET;

  beforeEach(() => {
    mocks.loadNetworkConfig.mockResolvedValue(undefined);
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.startManagedOxigraph.mockResolvedValue(null);
    mocks.checkExternalStoreReachable.mockResolvedValue({ ok: true, backend: 'sparql-http', endpoint: 'http://127.0.0.1:12001/query' });
    mocks.checkOrSetStoreIdentity.mockResolvedValue({ ok: true, action: 'matched', nodeName: 'test-node' });
  });

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
    if (originalAcceptStoreReset === undefined) {
      delete process.env.DKG_ACCEPT_STORE_RESET;
    } else {
      process.env.DKG_ACCEPT_STORE_RESET = originalAcceptStoreReset;
    }
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  async function useTempHome(prefix: string) {
    tempHome = await mkdtemp(join(tmpdir(), prefix));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    return vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  }

  it('exits before managed store startup when a blockless config has legacy store.nq and no reset acknowledgement', async () => {
    const stdoutSpy = await useTempHome('dkg-legacy-store-gate-');
    await writeFile(join(tempHome!, 'store.nq'), '<s> <p> <o> .');
    vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit:${code}`);
      }) as never);

    await expect(runDaemonInner(true, {
      name: 'legacy-store-gate-test',
      listenPort: 0,
      nodeRole: 'edge',
    } as any, Date.now())).rejects.toThrow('process.exit:1');

    const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
    expect(output).toContain('legacy store.nq from the old implicit worker default');
    expect(output).toContain('DKG_ACCEPT_STORE_RESET=1');
    expect(mocks.startManagedOxigraph).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('continues with the effective oxigraph-server store after legacy store.nq is acknowledged', async () => {
    const stdoutSpy = await useTempHome('dkg-legacy-store-ack-');
    process.env.DKG_ACCEPT_STORE_RESET = '1';
    await writeFile(join(tempHome!, 'store.nq'), '<s> <p> <o> .');
    mocks.startManagedOxigraph.mockResolvedValue({
      handle: { queryEndpoint: 'http://127.0.0.1:12001/query', updateEndpoint: 'http://127.0.0.1:12001/update', killSync: vi.fn() },
      storeConfig: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://127.0.0.1:12001/query',
          updateEndpoint: 'http://127.0.0.1:12001/update',
          managedByDkg: true,
        },
      },
      largeLiteralStorage: { enabled: true, directory: join(tempHome!, 'literal-blobs') },
      sharedMemoryPublicSnapshotStorage: { enabled: true, directory: join(tempHome!, 'swm-public-snapshots') },
    });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));

    await expect(runDaemonInner(true, {
      name: 'legacy-store-ack-test',
      listenPort: 0,
      nodeRole: 'edge',
    } as any, Date.now())).rejects.toThrow('after-agent-create');

    const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
    expect(output).toContain('using oxigraph-server');
    expect(mocks.startManagedOxigraph).toHaveBeenCalledTimes(1);
    expect(mocks.startManagedOxigraph.mock.calls[0]?.[0]).toMatchObject({
      dataDir: tempHome,
      config: {
        store: { backend: 'oxigraph-server', options: {} },
      },
    });
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    expect(mocks.agentCreate.mock.calls[0]?.[0]).toMatchObject({
      storeConfig: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://127.0.0.1:12001/query',
          updateEndpoint: 'http://127.0.0.1:12001/update',
          managedByDkg: true,
        },
      },
      largeLiteralStorage: { enabled: true, directory: join(tempHome!, 'literal-blobs') },
      sharedMemoryPublicSnapshotStorage: { enabled: true, directory: join(tempHome!, 'swm-public-snapshots') },
    });
  });

  it('blocks a wizard-rewritten oxigraph-server config with legacy store.nq and no backend marker', async () => {
    const stdoutSpy = await useTempHome('dkg-rewritten-legacy-store-gate-');
    await writeFile(join(tempHome!, 'store.nq'), '<s> <p> <o> .');
    vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new Error(`process.exit:${code}`);
      }) as never);

    await expect(runDaemonInner(true, {
      name: 'rewritten-legacy-store-gate-test',
      listenPort: 0,
      nodeRole: 'edge',
      store: { backend: 'oxigraph-server', options: {} },
    } as any, Date.now())).rejects.toThrow('process.exit:1');

    const output = stdoutSpy.mock.calls.map(call => String(call[0])).join('');
    expect(output).toContain('legacy store.nq from the old worker-backed store');
    expect(output).toContain('DKG_ACCEPT_STORE_RESET=1');
    expect(mocks.startManagedOxigraph).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('migrates an explicit legacy worker config after reset acknowledgement', async () => {
    await useTempHome('dkg-explicit-legacy-store-ack-');
    process.env.DKG_ACCEPT_STORE_RESET = '1';
    await writeFile(join(tempHome!, 'store.nq'), '<s> <p> <o> .');
    mocks.startManagedOxigraph.mockResolvedValue({
      handle: { queryEndpoint: 'http://127.0.0.1:12001/query', updateEndpoint: 'http://127.0.0.1:12001/update', killSync: vi.fn() },
      storeConfig: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://127.0.0.1:12001/query',
          updateEndpoint: 'http://127.0.0.1:12001/update',
          managedByDkg: true,
        },
      },
      largeLiteralStorage: { enabled: true, directory: join(tempHome!, 'literal-blobs') },
      sharedMemoryPublicSnapshotStorage: { enabled: true, directory: join(tempHome!, 'swm-public-snapshots') },
    });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));

    await expect(runDaemonInner(true, {
      name: 'explicit-legacy-store-ack-test',
      listenPort: 0,
      nodeRole: 'edge',
      store: { backend: 'oxigraph-worker' },
    } as any, Date.now())).rejects.toThrow('after-agent-create');

    expect(mocks.startManagedOxigraph.mock.calls[0]?.[0]).toMatchObject({
      config: { store: { backend: 'oxigraph-server', options: {} } },
    });
    expect(mocks.agentCreate.mock.calls[0]?.[0]).toMatchObject({
      storeConfig: { backend: 'sparql-http' },
    });
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
    } as any, Date.now())).rejects.toThrow('process.exit:1');

    expect(mocks.loadNetworkConfig).toHaveBeenCalledWith('mainnet-base');
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map(call => String(call[0])).join('')).toContain(
      'FATAL: network config DKG V10 Base Mainnet is marked pre-deployment',
    );
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
    } as any, Date.now())).rejects.toThrow('process.exit:1');

    expect(mocks.loadNetworkConfig).toHaveBeenCalledWith('missing-mainnet');
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(stdoutSpy.mock.calls.map(call => String(call[0])).join('')).toContain(
      'FATAL: network config "missing-mainnet" was not found',
    );
  });

  it('passes the selected network genesis id into agent creation', async () => {
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
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runDaemonInner(true, {
      name: 'genesis-startup-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'edge',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
    } as any, Date.now())).rejects.toThrow('after-agent-create');

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
    });
    expect((createArg.chainEventCursorStore as any).scope).toBe(buildEvmDeploymentId({
      chainId: 'evm:100',
      hubAddress: '0x1234567890123456789012345678901234567890',
    }));
    closeDashboardDbFromAgentCreateArg(createArg);
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
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
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
    } as any, Date.now())).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    expect((createArg.chainEventCursorStore as any).scope).toBe(buildEvmDeploymentId({
      chainId: 'evm:31337',
      hubAddress: '0x2234567890123456789012345678901234567890',
    }));
    closeDashboardDbFromAgentCreateArg(createArg);
  });
});
