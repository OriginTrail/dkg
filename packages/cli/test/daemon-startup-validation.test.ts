import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNetworkId } from '../../core/src/genesis.js';
import { buildEvmDeploymentId } from '@origintrail-official/dkg-chain';
import {
  DEFAULT_DAEMON_LOG_MAX_BYTES,
} from '../src/daemon/log-rotation.js';

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
  db?.close?.();
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
    } as any, Date.now())).rejects.toThrow('process.exit:1');

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
    } as any, Date.now())).rejects.toThrow('process.exit:1');

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
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
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
      chainId: 'gnosis:100',
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
