import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peerIdFromRelayAddress } from '@origintrail-official/dkg-core';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';

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

describe('runDaemonInner wires sync and authority index options into DKGAgent.create', () => {
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

  // Drive runDaemonInner as a core by default and return the options object that was
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
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');

    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    closeDashboardDbFromAgentCreateArg(createArg);
    expect(createArg.nodeRole).toBe(configOverrides.nodeRole ?? 'core');
    return createArg;
  }

  const trustedCorePeer = '/dns4/core.example.com/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
  // The relay the beforeEach network file lists; the harness never dials it.
  const networkFileRelay = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
  const operationalWallet = {
    address: '0x1111111111111111111111111111111111111111',
    privateKey: `0x${'11'.repeat(32)}`,
  };
  const localHistoryStartupLine =
    '[info] [authority-index] mode=local-history trustedCoreCount=0 maxTailBlocks=unbounded cacheEpoch=0';
  const skippedDefaultPrefix = '[info] [authority-index] network-relay default skipped: ';

  it.each([undefined, 200, 10_000])(
    'forwards explicit edge snapshot trust with bounded tail %j', async maxTailBlocks => {
      mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [operationalWallet] });
      const createArg = await captureCreateArg({
        nodeRole: 'edge',
        authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], maxTailBlocks },
      });
      expect(createArg.authorityIndex).toEqual({
        mode: 'core-snapshot',
        trustedCorePeers: [trustedCorePeer],
        maxTailBlocks: maxTailBlocks ?? 2_000,
        cacheEpoch: 0,
      });
      const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
      expect(logs).toContain(
        `[info] [authority-index] mode=core-snapshot trustedCoreCount=1 maxTailBlocks=${maxTailBlocks ?? 2_000} cacheEpoch=0`,
      );
    },
  );

  it('forwards an explicit cache reset epoch and logs its active value', async () => {
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [operationalWallet] });
    const createArg = await captureCreateArg({
      nodeRole: 'edge',
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], cacheEpoch: 3 },
    });
    expect(createArg.authorityIndex.cacheEpoch).toBe(3);
    const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
    expect(logs).toContain('mode=core-snapshot trustedCoreCount=1 maxTailBlocks=2000 cacheEpoch=3');
    expect(logs).not.toContain('source=network-relays');
  });

  it('fails startup on explicit trust the agent cannot run instead of downgrading it', async () => {
    // The harness wallets.json is empty: no operational key for the EVM chain.
    await expect(runDaemonInner(true, {
      name: 'explicit-authority-index-without-keys',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      nodeRole: 'edge',
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer] },
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow(
      'authorityIndex core-snapshot mode requires a configured EVM chain and a local authority index store',
    );
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it('seeds an unconfigured edge from the network file relays, never its authorityIndex block or operator relays', async () => {
    const operatorRelay = '/dns4/relay.operator.example/tcp/9090/p2p/12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: [networkFileRelay],
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer] },
    });
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [operationalWallet] });
    const createArg = await captureCreateArg({ nodeRole: 'edge', relay: operatorRelay });
    // The operator block stays the only `authorityIndex`; the agent plans the
    // relay default from `networkRelays`, the network file's list alone.
    expect(createArg.authorityIndex).toBeUndefined();
    expect(createArg.relayPeers).toEqual([operatorRelay]);
    expect(createArg.networkRelays).toEqual([networkFileRelay]);
    const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
    expect(logs).toContain(
      '[info] [authority-index] mode=core-snapshot trustedCoreCount=1 source=network-relays '
      + 'fallback=local-history maxTailBlocks=2000 cacheEpoch=0',
    );
    expect(logs).not.toContain(skippedDefaultPrefix);
  });

  describe('transport-level network peer isolation', () => {
    const originalIsolationEnv = process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED;
    afterEach(() => {
      if (originalIsolationEnv === undefined) delete process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED;
      else process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED = originalIsolationEnv;
    });

    async function bundled(name: string) {
      const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
      const network = await actual.loadNetworkConfig(name);
      if (!network) throw new Error(`bundled network config ${name} is missing`);
      return network;
    }
    const peerIds = (addresses: readonly string[]) =>
      addresses.map((address) => peerIdFromRelayAddress(address) ?? `unparseable:${address}`);

    it('hands the node the other bundled networks\' relays, never its own effective relays', async () => {
      delete process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED;
      const [gnosis, base, testnet] = await Promise.all(
        ['mainnet-gnosis', 'mainnet-base', 'testnet'].map(bundled),
      );
      // "Changed `network`, forgot `relay`": the operator's relay is a testnet
      // one. It stays the node's relay (the identity proof judges it), so it
      // must not also be on the static refusal list.
      const operatorRelay = testnet.relays[1]!;
      mocks.loadNetworkConfig.mockResolvedValue(gnosis);

      const createArg = await captureCreateArg({ relay: operatorRelay });

      const handed = peerIds(createArg.otherNetworkRelays);
      expect(createArg.relayPeers).toEqual([operatorRelay]);
      expect(handed).toEqual(expect.arrayContaining(peerIds(base.relays)));
      expect(handed).toEqual(expect.arrayContaining(
        peerIds(testnet.relays.filter((relay) => relay !== operatorRelay)),
      ));
      expect(handed).not.toContain(peerIdFromRelayAddress(operatorRelay));
      for (const own of peerIds(gnosis.relays)) expect(handed).not.toContain(own);
      expect(createArg.networkPeerIsolation).toBe(true);
      const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
      expect(logs).toContain(
        `Network isolation: refusing connections to ${handed.length} relay peer(s) of other DKG networks`,
      );
    });

    it('turns the transport layer off with the config kill switch', async () => {
      delete process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED;
      const createArg = await captureCreateArg({ networkPeerIsolationEnabled: false });

      expect(createArg.networkPeerIsolation).toBe(false);
      expect(createArg.otherNetworkRelays).toEqual([]);
      const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
      expect(logs).toContain('Network isolation: transport-level peer isolation disabled');
      expect(logs).not.toContain('Network isolation: refusing connections to');
    });

    it('lets DKG_NETWORK_PEER_ISOLATION_ENABLED=0 turn it off over the config', async () => {
      process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED = '0';
      const createArg = await captureCreateArg({ networkPeerIsolationEnabled: true });

      expect(createArg.networkPeerIsolation).toBe(false);
      expect(createArg.otherNetworkRelays).toEqual([]);
    });

    it('lets DKG_NETWORK_PEER_ISOLATION_ENABLED=1 turn it back on over the config', async () => {
      process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED = '1';
      const createArg = await captureCreateArg({ networkPeerIsolationEnabled: false });

      expect(createArg.networkPeerIsolation).toBe(true);
      expect(createArg.otherNetworkRelays.length).toBeGreaterThan(0);
    });

    it.each(['off', '', 'disable'])(
      'refuses to start on an unreadable DKG_NETWORK_PEER_ISOLATION_ENABLED=%j instead of guessing',
      async (value) => {
        process.env.DKG_NETWORK_PEER_ISOLATION_ENABLED = value;
        await expect(runDaemonInner(true, {
          name: 'invalid-peer-isolation-env',
          networkConfig: 'mainnet-gnosis',
          listenPort: 0,
          nodeRole: 'core',
        } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow(
          `DKG_NETWORK_PEER_ISOLATION_ENABLED must be one of 1, 0, true, or false (received ${JSON.stringify(value)})`,
        );
        expect(mocks.agentCreate).not.toHaveBeenCalled();
      },
    );
  });

  it('keeps a relay "none" edge off every relay, authority-index seeding included', async () => {
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [operationalWallet] });
    const createArg = await captureCreateArg({ nodeRole: 'edge', relay: 'none' });
    expect(createArg.relayPeers).toBeUndefined();
    expect(createArg.networkRelays).toEqual([]);
    expect(createArg.authorityIndex).toBeUndefined();
    const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
    expect(logs).toContain(`${skippedDefaultPrefix}no network relay is available to seed from; using local history`);
    expect(logs).toContain(localHistoryStartupLine);
  });

  it.each([
    ['the mock chain adapter', { chain: { type: 'mock', chainId: 'mock:31337' } }, [operationalWallet],
      'the chain adapter is injected (such as the mock chain), not a configured EVM chain'],
    ['no chain configuration', { chain: undefined }, [operationalWallet], 'no EVM chain is configured'],
    ['no operational wallet', {}, [], 'no operational key is configured'],
  ])('keeps an unconfigured edge with %s on local history and logs why', async (_label, overrides, wallets, reason) => {
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets });
    const createArg = await captureCreateArg({ nodeRole: 'edge', ...overrides });
    expect(createArg.networkRelays).toEqual([networkFileRelay]);
    const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
    expect(logs).toContain(`${skippedDefaultPrefix}${reason}; using local history`);
    expect(logs).toContain(localHistoryStartupLine);
    expect(logs).not.toContain('source=network-relays');
  });

  it('keeps an unconfigured core on its chain-history index without a skip reason', async () => {
    mocks.loadOpWallets.mockResolvedValue({ adminWallet: undefined, wallets: [operationalWallet] });
    const createArg = await captureCreateArg();
    expect(createArg.authorityIndex).toBeUndefined();
    const logs = await readFile(join(tempHome!, 'daemon.log'), 'utf8');
    expect(logs).toContain(localHistoryStartupLine);
    expect(logs).not.toContain(skippedDefaultPrefix);
  });

  it.each([
    { nodeRole: 'core', authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer] } },
    { core: { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer] } } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], maxTailBlock: 2_000 } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], trustedCorePeer: trustedCorePeer } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], cacheEpoch: -1 } },
    { authorityIndex: null },
    { authorityIndex: {} },
    { authorityIndex: { mode: 'auto', trustedCorePeers: [trustedCorePeer] } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [] } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: ['/dns4/core.example.com/tcp/9090'] } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: ['invalid'] } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], maxTailBlocks: 0 } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], maxTailBlocks: 199 } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], maxTailBlocks: 10_001 } },
    { authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [trustedCorePeer], maxTailBlocks: 1.5 } },
  ])('rejects invalid snapshot trust before allocating daemon resources: %j', async overrides => {
    await expect(runDaemonInner(true, {
      name: 'invalid-authority-index',
      nodeRole: 'edge',
      listenPort: 0,
      ...overrides,
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow(/authorityIndex/);
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(mocks.loadNetworkConfig).not.toHaveBeenCalled();
    expect(mocks.loadOpWallets).not.toHaveBeenCalled();
  });

  it.each([undefined, { batchSize: 50, maxPayloadBytes: 8 * 1024 * 1024, concurrency: 2 }])(
    'passes operator outbox limits into agent construction: %j', async limits => {
      const createArg = await captureCreateArg({ messengerOutboxDrain: limits });
      expect(createArg.messengerOutboxDrain).toEqual(limits);
    },
  );

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

  it('passes partitioned sync admission through unchanged', async () => {
    const syncAdmission = {
      globalMaxInflight: 10,
      fast: { maxInflight: 8, queueLimit: 64, queueTimeoutMs: 5_000 },
      slow: {
        maxInflight: 2,
        foregroundReserved: 1,
        foregroundQueueLimit: 8,
        backgroundMaxInflight: 1,
        backgroundQueueLimit: 0,
      },
    } as const;
    const createArg = await captureCreateArg({ syncAdmission });

    expect(createArg.syncAdmission).toEqual(syncAdmission);
  });

  it('passes the automatic system Context Graph sync override through unchanged', async () => {
    const createArg = await captureCreateArg({
      syncSystemContextGraphsOnConnect: false,
    });

    expect(createArg.syncSystemContextGraphsOnConnect).toBe(false);
  });

  it('passes the on-demand agents phonebook kill switch through unchanged', async () => {
    const createArg = await captureCreateArg({ onDemandAgentsPhonebook: false });

    expect(createArg.onDemandAgentsPhonebook).toBe(false);
  });

  it('leaves the on-demand agents phonebook at the agent default when unset', async () => {
    const createArg = await captureCreateArg({});

    expect(createArg.onDemandAgentsPhonebook).toBeUndefined();
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
