import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Wiring guard for the CLI DAEMON call site in
// `packages/cli/src/daemon/lifecycle.ts` — inside `runDaemonInner`'s
// `DKGAgent.create({...})`:
//   syncAgentsMeta: resolveSyncAgentsMeta(config.syncAgentsMeta, process.env.DKG_SYNC_AGENTS_META)
//
// The pure resolver and the AGENT-side call site (`syncFromPeerDetailed`) are
// covered in the `agent` package. This locks the SEPARATE daemon construction
// path: a regression reverting ONLY this line back to
// `role === 'core' ? true : config.syncAgentsMeta` — which would make
// daemon-started cores fetch the bloated `agents/_meta` again — keeps every
// other test green but fails HERE.
//
// Pattern mirrors daemon-startup-validation.test.ts: mock `DKGAgent.create` to
// capture its options object and reject immediately, so `runDaemonInner`
// unwinds before the heavy post-create boot (HTTP server, libp2p). No hardhat,
// no real chain/network — the network + wallet loaders are mocked too.

const mocks = vi.hoisted(() => ({
  agentCreate: vi.fn(),
  loadOpWallets: vi.fn(),
  loadNetworkConfig: vi.fn(),
}));

vi.mock('@origintrail-official/dkg-agent', async importOriginal => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-agent')>();
  return {
    ...actual, // keeps the REAL resolveSyncAgentsMeta that lifecycle.ts calls
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

describe('runDaemonInner wires sync options into DKGAgent.create', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  const originalSyncEnv = process.env.DKG_SYNC_AGENTS_META;
  let stdoutWrite: typeof process.stdout.write = process.stdout.write;
  let stderrWrite: typeof process.stderr.write = process.stderr.write;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-sync-agents-meta-wiring-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    delete process.env.DKG_SYNC_AGENTS_META;
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];

    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: ['/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M'],
      defaultNodeRole: 'core',
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [] });
    // Reject right after DKGAgent.create so runDaemonInner unwinds before the
    // heavy post-create boot — we only need the captured create options.
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
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
    if (originalSyncEnv === undefined) delete process.env.DKG_SYNC_AGENTS_META;
    else process.env.DKG_SYNC_AGENTS_META = originalSyncEnv;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  // Drive runDaemonInner as a CORE node and return the options object that was
  // handed to DKGAgent.create. `configOverrides` is merged onto the base config.
  async function captureCreateArg(configOverrides: Record<string, unknown> = {}): Promise<any> {
    await expect(runDaemonInner(true, {
      name: 'sync-agents-meta-core-test',
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
    // Sanity: prove we actually exercised the CORE construction path, so the
    // syncAgentsMeta assertions below are meaningful for the case the reviewer
    // flagged (a core reverting to the always-true branch).
    expect(createArg.nodeRole).toBe('core');
    return createArg;
  }

  it('defaults syncAgentsMeta=false for a core node with no config flag and no env', async () => {
    const createArg = await captureCreateArg();
    // Regression trap: a revert to `role === 'core' ? true : config.syncAgentsMeta`
    // would make this `true`.
    expect(createArg.syncAgentsMeta).toBe(false);
  });

  it('passes syncAgentsMeta=true when DKG_SYNC_AGENTS_META=1 opts the core in', async () => {
    process.env.DKG_SYNC_AGENTS_META = '1';
    const createArg = await captureCreateArg();
    expect(createArg.syncAgentsMeta).toBe(true);
  });

  it('gives explicit config.syncAgentsMeta precedence over the env', async () => {
    process.env.DKG_SYNC_AGENTS_META = '0';
    const createArg = await captureCreateArg({ syncAgentsMeta: true });
    expect(createArg.syncAgentsMeta).toBe(true);
  });

  it('passes syncGlobalLimit and syncGlobalQueueLimit through unchanged', async () => {
    const createArg = await captureCreateArg({
      syncGlobalLimit: 1,
      syncGlobalQueueLimit: 0,
    });

    expect(createArg.syncGlobalLimit).toBe(1);
    expect(createArg.syncGlobalQueueLimit).toBe(0);
  });

  it('passes snapshot limits and Context Graph priorities through unchanged', async () => {
    const syncResponderSnapshotLimits = {
      global: { rows: 500, bytesEstimate: 600 },
      local: { rows: 100, bytesEstimate: 200 },
    };
    const syncContextGraphPriorities = { urgent: 50, bulk: -10 };
    const createArg = await captureCreateArg({
      syncResponderSnapshotLimits,
      syncContextGraphPriorities,
    });

    expect(createArg.syncResponderSnapshotLimits).toEqual(syncResponderSnapshotLimits);
    expect(createArg.syncContextGraphPriorities).toEqual(syncContextGraphPriorities);
  });
});
