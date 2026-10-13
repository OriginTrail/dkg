import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShutdownPolicy } from '../src/daemon/shutdown-policy.js';
import { orderNetworkRelaysForNode } from '../src/daemon/relay-order.js';
import { createFakeDaemonHttpServer } from './_helpers/daemon-boot-doubles.js';

// The daemon hands an edge the network file's relays in the node's own order
// and a Core the file order. Boots the real `runDaemonInner` up to
// `DKGAgent.create`, which is where the relay list leaves the daemon.
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

// Synthetic relay peer ids (fixed seeds) on documentation addresses.
const NETWORK_RELAYS = [
  '12D3KooWCaFu7Rpww4fUfHnEZJCWHZMtWtp1vhpj6srQLQrvgwpc',
  '12D3KooWQD8xYxuQmB3r9xXiN3GV7sQKUyQ1YvjjmexbgmWJKKq4',
  '12D3KooWNhWRxEC5kvZpRVDnoDD3bonXuzTa5dgoPJoDYkdbMimG',
  '12D3KooWEWecLEFycStociTJkkoEmqDyinjxQwcMajaedGPC3rXD',
  '12D3KooWBN7q5cx7M7YbDfnjiF5RQvBRKtGf2oqwdjeyGUoBr9op',
  '12D3KooWHiGDunMUSBgrKdYzAEjvQUvh8sRkbzG3WeYFh1CFsRDq',
].map((peerId, index) => `/ip4/203.0.113.${index + 1}/tcp/9090/p2p/${peerId}`);
const PREFERRED_RELAY =
  '/ip4/198.51.100.7/tcp/9090/p2p/12D3KooWLa2BakyRVLJcAwgTbg6ibNZZMzccEkPiVFq5XiE867wN';
// Placeholder operational wallets. Only the first address matters: it is the
// node-local key the relay order is derived from.
const FIRST_WALLET = '0x00000000000000000000000000000000000000a7';
const SECOND_WALLET = '0x00000000000000000000000000000000000000b8';

describe('runDaemonInner relay order', () => {
  let tempHome: string | undefined;
  let originalDkgHome: string | undefined;
  let originalPreferred: string | undefined;
  let uncaughtExceptionListeners: NodeJS.UncaughtExceptionListener[] = [];
  let unhandledRejectionListeners: NodeJS.UnhandledRejectionListener[] = [];
  let sigintListeners: NodeJS.SignalsListener[] = [];
  let sigtermListeners: NodeJS.SignalsListener[] = [];

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'dkg-relay-order-boot-'));
    originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = tempHome;
    originalPreferred = process.env.DKG_RELAY_PREFERRED;
    delete process.env.DKG_RELAY_PREFERRED;
    uncaughtExceptionListeners = process.listeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
    unhandledRejectionListeners = process.listeners('unhandledRejection') as NodeJS.UnhandledRejectionListener[];
    sigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    sigtermListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];

    mocks.createServer.mockImplementation(() => createFakeDaemonHttpServer());
    mocks.startPublisherRuntimeWithOutcome.mockResolvedValue({
      runtime: null,
      availability: { available: false, reason: 'no_publisher_wallets', retryable: false, operatorActionRequired: true },
    });
    mocks.loadNetworkConfig.mockResolvedValue({
      networkName: 'DKG V10 Gnosis Mainnet',
      genesisId: 'gnosis-mainnet',
      genesisVersion: 1,
      relays: NETWORK_RELAYS,
      defaultNodeRole: 'edge',
    });
    mocks.loadOpWallets.mockResolvedValue({
      adminWallet: undefined,
      wallets: [{ address: FIRST_WALLET }, { address: SECOND_WALLET }],
    });
    mocks.chainResetWipe.mockResolvedValue({
      wiped: false, skipped: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [],
    });
    mocks.agentCreate.mockRejectedValue(new Error('after-agent-create'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(async () => {
    const createArg = mocks.agentCreate.mock.calls[0]?.[0] as any;
    const db = createArg?.chainEventCursorStore?.cursors?.db
      ?? createArg?.contextGraphRegistryScanCursorStore?.cursors?.db;
    db?.close?.();
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
    if (originalPreferred === undefined) delete process.env.DKG_RELAY_PREFERRED;
    else process.env.DKG_RELAY_PREFERRED = originalPreferred;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  async function agentConfigOf(overrides: Record<string, unknown>): Promise<any> {
    await expect(runDaemonInner(true, {
      name: 'relay-order-boot-test',
      networkConfig: 'mainnet-gnosis',
      listenPort: 0,
      apiPort: 0,
      auth: { enabled: false },
      promoteQueue: { enabled: false },
      publisher: { enabled: false },
      chain: {
        type: 'evm',
        rpcUrl: 'https://private-rpc.example',
        hubAddress: '0x1234567890123456789012345678901234567890',
        chainId: 'evm:100',
      },
      ...overrides,
    } as any, Date.now(), resolveShutdownPolicy(undefined))).rejects.toThrow('after-agent-create');
    expect(mocks.agentCreate).toHaveBeenCalledTimes(1);
    return mocks.agentCreate.mock.calls[0]![0];
  }

  it('hands an edge the network relays in its own order, the trust and ACK lists in file order', async () => {
    const agentConfig = await agentConfigOf({ nodeRole: 'edge' });
    const own = orderNetworkRelaysForNode(NETWORK_RELAYS, FIRST_WALLET);

    expect(own).not.toEqual(NETWORK_RELAYS);
    expect(agentConfig.relayPeers).toEqual(own);
    expect(agentConfig.networkRelays).toEqual(NETWORK_RELAYS);
    expect(agentConfig.preferredACKPeerIds)
      .toEqual(NETWORK_RELAYS.map((relay) => relay.split('/p2p/')[1]));
  });

  it('keeps operator-preferred relays ahead of an edge\'s own order', async () => {
    const agentConfig = await agentConfigOf({ nodeRole: 'edge', preferredRelays: [PREFERRED_RELAY] });

    expect(agentConfig.relayPeers)
      .toEqual([PREFERRED_RELAY, ...orderNetworkRelaysForNode(NETWORK_RELAYS, FIRST_WALLET)]);
  });

  it('hands a Core the file order', async () => {
    const agentConfig = await agentConfigOf({ nodeRole: 'core' });

    expect(agentConfig.relayPeers).toEqual(NETWORK_RELAYS);
  });

  it('leaves an explicitly configured relay alone', async () => {
    const agentConfig = await agentConfigOf({ nodeRole: 'edge', relay: NETWORK_RELAYS[3] });

    expect(agentConfig.relayPeers).toEqual([NETWORK_RELAYS[3]]);
  });
});
