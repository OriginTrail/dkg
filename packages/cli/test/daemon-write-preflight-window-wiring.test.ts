import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV } from '../src/daemon/write-preflight-coalescing.js';

// Wiring guard for the CLI DAEMON call site in `packages/cli/src/daemon/lifecycle.ts`: the unresolved-write
// window the operator sets with DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS is read once at start and
// handed to the agent as `writePreflightUnresolvedWriteWindowMs` in `DKGAgent.create({...})`. The parsing is
// covered in write-preflight-coalescing.test.ts and the agent's use of it in the agent package; this locks the
// line between them, which neither sees: a daemon that read the variable and never passed it on would keep
// every other test green and leave `0` (strict) without effect.
//
// Pattern mirrors daemon-sync-agents-meta-wiring.test.ts: `DKGAgent.create` is mocked to capture its options
// and reject, so `runDaemonInner` unwinds before the heavy post-create boot. No hardhat, no network.

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
  return { ...actual, loadNetworkConfig: mocks.loadNetworkConfig };
});

const { runDaemonInner } = await import('../src/daemon/lifecycle.js');

describe('runDaemonInner hands the write-preflight unresolved-write window to DKGAgent.create', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  const originalWindowEnv = process.env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV];
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let logged: string[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-write-preflight-window-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    delete process.env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV];
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    logged = [];

    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'core',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.removeAllListeners('uncaughtException');
    for (const listener of uncaughtExceptionListeners) process.on('uncaughtException', listener);
    process.removeAllListeners('unhandledRejection');
    for (const listener of unhandledRejectionListeners) process.on('unhandledRejection', listener);
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (originalWindowEnv === undefined) delete process.env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV];
    else process.env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV] = originalWindowEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  async function captureCreateArg(): Promise<any> {
    await expect(runDaemonInner(true, {
      name: 'write-preflight-window-wiring-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'core',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    const db =
      createArg?.chainEventCursorStore?.cursors?.db ??
      createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
    db?.close?.();
    return createArg;
  }

  it('passes the two-minute default when the variable is unset', async () => {
    const createArg = await captureCreateArg();
    expect(createArg.writePreflightUnresolvedWriteWindowMs).toBe(120_000);
    expect(logged.join('')).toContain('unresolved-write window: 120000 ms');
  });

  it('passes the window the operator set', async () => {
    process.env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV] = '45000';
    const createArg = await captureCreateArg();
    expect(createArg.writePreflightUnresolvedWriteWindowMs).toBe(45_000);
    expect(logged.join('')).toContain('unresolved-write window: 45000 ms');
  });

  it('passes 0 for strict', async () => {
    process.env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV] = '0';
    const createArg = await captureCreateArg();
    expect(createArg.writePreflightUnresolvedWriteWindowMs).toBe(0);
    expect(logged.join('')).toContain('unresolved-write window: strict');
  });

  it('passes the default, with a warning in the log, when the variable is malformed', async () => {
    process.env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV] = 'two minutes';
    const createArg = await captureCreateArg();
    expect(createArg.writePreflightUnresolvedWriteWindowMs).toBe(120_000);
    const output = logged.join('');
    expect(output).toContain(`Invalid ${WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV}="two minutes"`);
  });
});
