import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import {
  MockChainAdapter,
  createContextGraphAuthorityIndexCheckpoint,
  decodeContextGraphAuthorityIndexSnapshot,
  type ContextGraphAuthorityIndexBootstrap,
  type ContextGraphAuthorityIndexSnapshots,
} from '@origintrail-official/dkg-chain';
import {
  DEFAULT_GENESIS_ID,
  Logger,
  PROTOCOL_NETWORK_IDENTITY,
  computeNetworkId,
  type LogRecord,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { resolveAuthorityIndexConfig } from '../src/authority-index-config.js';
import {
  AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
  createAuthorityIndexSnapshotClient,
  PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT,
} from '../src/authority-index-snapshot-service.js';

const request = {
  scope: 'mock:31337:0x1111111111111111111111111111111111111111',
  deploymentBlockNumber: 100,
  minThroughBlockNumber: 500,
  maxThroughBlockNumber: 2_500,
};
const checkpoint = createContextGraphAuthorityIndexCheckpoint({
  deploymentBlockNumber: 100,
  throughBlockNumber: 1_000,
  throughBlockHash: `0x${'22'.repeat(32)}`,
}, []);
const snapshot = { version: 1 as const, scope: request.scope, checkpoint };
const OPERATIONAL_KEY = '0x59c6995e998f97a5a0044966f0945388c9e82d88a3fdf0e0c7b33e0d2d2d8b2f';
const PINNED_PEER = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const pinnedAddress = `/ip4/127.0.0.1/tcp/9200/p2p/${PINNED_PEER}`;
const SECOND_PINNED_PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const secondPinnedAddress = `/dns4/core.example.com/tcp/9090/p2p/${SECOND_PINNED_PEER}`;
const evmChainConfig = {
  rpcUrl: 'http://127.0.0.1:59998',
  hubAddress: '0x0000000000000000000000000000000000000001',
  operationalKeys: [OPERATIONAL_KEY],
  chainId: 'evm:31337',
};

function localAuthorityIndexStore() {
  return {
    load: vi.fn(async () => undefined),
    compareAndSwap: vi.fn(async () => 1),
    invalidate: vi.fn(async () => 2),
  };
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function capability() {
  return {
    open: vi.fn(),
    close: vi.fn(async () => {}),
    refresh: vi.fn(async (_options?: { signal?: AbortSignal }) => {}),
    exportSnapshot: vi.fn(async () => snapshot),
  } satisfies ContextGraphAuthorityIndexSnapshots;
}

function address(agent: DKGAgent): string {
  const value = agent.multiaddrs.find((entry) => entry.includes('/ip4/127.0.0.1/tcp/')
    && !entry.includes('/p2p-circuit'));
  if (!value) throw new Error('Fixture did not expose its loopback TCP address');
  return value;
}

function snapshotClient(edge: DKGAgent, core: DKGAgent) {
  return createAuthorityIndexSnapshotClient({
    config: { trustedCorePeers: [address(core)] },
    timeoutMs: 5_000,
    request: async (peer, bytes, options) => {
      await edge.node.libp2p.peerStore.merge(peerIdFromString(peer.peerId), {
        multiaddrs: [multiaddr(peer.multiaddr)],
      });
      await edge.node.libp2p.dial(multiaddr(peer.multiaddr), { signal: options.signal });
      return edge.router.send(peer.peerId, PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT, bytes, options);
    },
  });
}

describe('authority index snapshot production wiring', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0).reverse()) await agent.stop();
    vi.restoreAllMocks();
  });

  async function startAgent(
    name: string,
    nodeRole: 'core' | 'edge',
    snapshots = capability(),
    genesisId = DEFAULT_GENESIS_ID,
  ) {
    const chain = Object.assign(new MockChainAdapter('mock:31337'), {
      contextGraphAuthorityIndexSnapshots: snapshots,
    });
    const agent = await DKGAgent.create({
      name,
      listenHost: '127.0.0.1',
      listenPort: 0,
      nodeRole,
      chainAdapter: chain,
      store: new OxigraphStore(),
      randomSamplingUseWorkerThread: false,
      networkIdentity: {
        genesisId,
        networkId: await computeNetworkId(genesisId),
        chainId: chain.chainId,
      },
    });
    agents.push(agent);
    await agent.start();
    return { agent, snapshots };
  }

  it('waits for foreground identity startup before starting background snapshot refresh', async () => {
    const snapshots = capability();
    const chain = Object.assign(new MockChainAdapter('mock:31337'), {
      contextGraphAuthorityIndexSnapshots: snapshots,
    });
    const identityEntered = Promise.withResolvers<void>();
    const identityRelease = Promise.withResolvers<void>();
    const readIdentity = chain.getIdentityId.bind(chain);
    vi.spyOn(chain, 'getIdentityId').mockImplementationOnce(async () => {
      identityEntered.resolve();
      await identityRelease.promise;
      return readIdentity();
    });
    const agent = await DKGAgent.create({
      name: 'SnapshotStartupOrder', nodeRole: 'core',
      listenHost: '127.0.0.1', listenPort: 0,
      chainAdapter: chain, store: new OxigraphStore(),
      randomSamplingUseWorkerThread: false,
    });
    agents.push(agent);
    const starting = agent.start();
    try {
      await identityEntered.promise;
      expect(snapshots.refresh).not.toHaveBeenCalled();
      identityRelease.resolve();
      await starting;
      await vi.waitFor(() => expect(snapshots.refresh).toHaveBeenCalledOnce());
    } finally {
      identityRelease.resolve();
      await starting;
    }
  });

  it('serves cached snapshots over authenticated P2P and limits the real router peer identity', async () => {
    const core = await startAgent('SnapshotCore', 'core');
    const edge = await startAgent('SnapshotEdge', 'edge');

    expect(core.snapshots.open).toHaveBeenCalledOnce();
    expect(edge.snapshots.open).toHaveBeenCalledOnce();
    expect(core.agent.node.libp2p.getProtocols()).toContain(PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT);
    expect(edge.agent.node.libp2p.getProtocols()).not.toContain(PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT);
    await vi.waitFor(() => expect(core.snapshots.refresh).toHaveBeenCalledOnce());
    expect(edge.snapshots.refresh).not.toHaveBeenCalled();

    const validate = vi.fn(async (value: unknown) => {
      expect(decodeContextGraphAuthorityIndexSnapshot(value, request)).toEqual(checkpoint);
    });
    const client = snapshotClient(edge.agent, core.agent);
    // Hold only the wall clock constant: real libp2p I/O and its timers still
    // run, while slow CI cannot roll the server's five-second quota window.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    await expect(client.fetchSnapshot(request, undefined, validate)).resolves.toEqual(snapshot);
    await expect(client.fetchSnapshot(request)).resolves.toEqual(snapshot);
    await expect(client.fetchSnapshot(request)).resolves.toEqual(snapshot);
    await expect(client.fetchSnapshot(request)).resolves.toEqual(snapshot);
    await expect(client.fetchSnapshot(request)).rejects.toMatchObject({
      errors: [expect.objectContaining({ status: 'busy' })],
    });

    expect(validate).toHaveBeenCalledOnce();
    expect(core.snapshots.exportSnapshot).toHaveBeenCalledTimes(4);
    expect(core.snapshots.exportSnapshot).toHaveBeenCalledWith(request);
    expect(core.snapshots.refresh).toHaveBeenCalledOnce();
    expect(edge.snapshots.exportSnapshot).not.toHaveBeenCalled();
    expect(edge.snapshots.refresh).not.toHaveBeenCalled();
    expect(edge.agent.networkAdmission.snapshot().verifiedPeerIds).toContain(core.agent.peerId);
    await edge.agent.stop();
    expect(edge.snapshots.close).toHaveBeenCalledOnce();
  }, 25_000);

  it('retains canonical peers across daemon and agent resolution without changing persisted config', () => {
    const resolved = resolveAuthorityIndexConfig({
      mode: 'core-snapshot', trustedCorePeers: [pinnedAddress, secondPinnedAddress], cacheEpoch: 2,
    }, 'edge')!;
    expect(resolved.snapshot.trustedCorePeers).toEqual([
      { peerId: PINNED_PEER, multiaddr: pinnedAddress },
      { peerId: SECOND_PINNED_PEER, multiaddr: secondPinnedAddress },
    ]);
    expect(resolveAuthorityIndexConfig(resolved, 'edge')).toBe(resolved);
    expect(Object.isFrozen(resolved.snapshot.trustedCorePeers)).toBe(true);
    const persisted = JSON.parse(JSON.stringify(resolved));
    expect(persisted).toEqual({
      mode: 'core-snapshot', trustedCorePeers: [pinnedAddress, secondPinnedAddress],
      maxTailBlocks: 2_000, cacheEpoch: 2,
    });
    expect(resolveAuthorityIndexConfig(persisted, 'edge')?.snapshot).toEqual(resolved.snapshot);
    expect(() => resolveAuthorityIndexConfig(resolved, 'core')).toThrow('only supported on edge nodes');
  });

  it('keeps network admission on the bootstrap protocol even for a pinned reachable core', async () => {
    const core = await startAgent('ForeignSnapshotCore', 'core', capability(), 'gnosis-mainnet');
    // Both nodes probe each other on connect, and the first rejection closes the
    // connection. If the core rejects first, the edge's in-flight probe ends
    // without a response and stays retryable instead of quarantined. Park the
    // core's reciprocal probe until the edge's fetch settles, so the edge always
    // receives the core's identity proof before the core can disconnect it.
    const edgeFetchSettled = Promise.withResolvers<void>();
    const coreSend = core.agent.router.send.bind(core.agent.router);
    vi.spyOn(core.agent.router, 'send').mockImplementation(async (peerId, protocolId, data, options) => {
      if (protocolId === PROTOCOL_NETWORK_IDENTITY) await edgeFetchSettled.promise;
      return coreSend(peerId, protocolId, data, options);
    });
    const edge = await startAgent('SnapshotEdgeAdmission', 'edge');

    try {
      await expect(snapshotClient(edge.agent, core.agent).fetchSnapshot(request))
        .rejects.toThrow('No configured trusted core supplied a usable authority index snapshot');
    } finally {
      edgeFetchSettled.resolve();
    }

    expect(core.snapshots.exportSnapshot).not.toHaveBeenCalled();
    expect(edge.agent.networkAdmission.snapshot().verifiedPeerIds).not.toContain(core.agent.peerId);
    expect(edge.agent.networkAdmission.snapshot().quarantinedPeerIds).toContain(core.agent.peerId);
  }, 25_000);

  it('aborts and drains an in-flight core refresh before stop completes', async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const pendingRefresh = new Promise<void>((resolve) => { release = resolve; });
    let releaseChainClose!: () => void;
    const pendingChainClose = new Promise<void>((resolve) => { releaseChainClose = resolve; });
    const snapshots = capability();
    snapshots.refresh.mockImplementation(async (options) => {
      signal = options?.signal;
      await pendingRefresh;
    });
    snapshots.close.mockImplementation(async () => { await pendingChainClose; });
    const { agent } = await startAgent('StoppingSnapshotCore', 'core', snapshots);
    const closeStore = vi.spyOn((agent as any).store, 'close');
    await vi.waitFor(() => expect(signal).toBeDefined());

    let stopped = false;
    const stopping = agent.stop().then(() => { stopped = true; });
    try {
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      expect(stopped).toBe(false);
      expect(snapshots.close).toHaveBeenCalledOnce();
      expect(snapshots.refresh).toHaveBeenCalledOnce();
      expect(closeStore).not.toHaveBeenCalled();
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(closeStore).not.toHaveBeenCalled();
    } finally {
      release();
      releaseChainClose();
      await stopping;
    }
    expect(stopped).toBe(true);
    expect(closeStore).toHaveBeenCalledOnce();
  }, 20_000);

  it('passes snapshot bootstrap into a constructed EVM adapter and primes the pinned transport address', async () => {
    const authorityIndexStore = localAuthorityIndexStore();
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'SnapshotEvmConstruction',
      listenHost: '127.0.0.1',
      listenPort: 0,
      store,
      nodeRole: 'edge',
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [pinnedAddress] },
      localContextGraphAuthorityIndexStore: authorityIndexStore,
      chainConfig: evmChainConfig,
    });
    const chain = (agent as any).chain;
    const bootstrap = chain.contextGraphAuthorityIndex.bootstrap as ContextGraphAuthorityIndexBootstrap;
    const validate = vi.fn(async () => {});
    const abort = new AbortController();
    try {
      expect(chain.contextGraphAuthorityIndex.localStore).toBe(authorityIndexStore);
      expect(bootstrap.maxTailBlocks).toBe(2_000);
      expect(bootstrap.trustDomain).toBe(createHash('sha256').update(JSON.stringify([PINNED_PEER])).digest('hex'));
      // Start only the libp2p transport: this construction test must not run
      // EVM startup reads against its intentionally unreachable RPC endpoint.
      await agent.node.start();
      const merge = vi.spyOn(agent.node.libp2p.peerStore, 'merge');
      const dial = vi.spyOn(agent.node.libp2p, 'dial').mockResolvedValue({} as any);
      const send = vi.fn(async () => encode({ version: 1, status: 'ok', snapshot }));
      (agent as any).router = { send };
      (agent as any).started = true;
      await expect(bootstrap.fetchSnapshot(request, abort.signal, validate)).resolves.toEqual(snapshot);

      expect(merge).toHaveBeenCalledWith(peerIdFromString(PINNED_PEER), {
        multiaddrs: [multiaddr(pinnedAddress)],
      });
      expect(dial).toHaveBeenCalledWith(multiaddr(pinnedAddress), { signal: expect.any(AbortSignal) });
      expect(send).toHaveBeenCalledWith(
        PINNED_PEER,
        PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT,
        expect.any(Uint8Array),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          timeoutMs: 10_000,
          maxReadBytes: AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
          payloadReuse: 'single-use',
        }),
      );
      expect(validate).toHaveBeenCalledOnce();
    } finally {
      (agent as any).started = false;
      await agent.node.stop();
      await store.close();
      chain.destroy();
    }
  }, 20_000);

  it('honors a custom 200-block tail in the constructed chain and production fetch closure', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'SnapshotCustomTail', listenHost: '127.0.0.1', listenPort: 0,
      store, nodeRole: 'edge',
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [pinnedAddress], maxTailBlocks: 200 },
      localContextGraphAuthorityIndexStore: localAuthorityIndexStore(),
      chainConfig: evmChainConfig,
    });
    const chain = (agent as any).chain;
    const bootstrap = chain.contextGraphAuthorityIndex.bootstrap as ContextGraphAuthorityIndexBootstrap;
    const transport = vi.spyOn(agent.node, 'libp2p', 'get');
    const send = vi.fn();
    (agent as any).router = { send };
    (agent as any).started = true;
    try {
      expect(bootstrap.maxTailBlocks).toBe(200);
      await expect(bootstrap.fetchSnapshot({
        ...request, minThroughBlockNumber: 900, maxThroughBlockNumber: 1_101,
      }, new AbortController().signal, vi.fn())).rejects.toThrow('Invalid authority index snapshot request');
      expect(transport).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      (agent as any).started = false;
      await agent.node.stop();
      await store.close();
      chain.destroy();
    }
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ] as const)('passes boundedAuthorityReads=%s through normal agent construction', async (configured, expected) => {
    const agent = await DKGAgent.create({
      name: 'BoundedAuthorityConstruction',
      store: new OxigraphStore(),
      chainConfig: {
        ...evmChainConfig,
        ...(configured === undefined ? {} : { boundedAuthorityReads: configured }),
      },
    });
    agents.push(agent);
    const chain = (agent as any).chain;
    // Construct without starting: this tests the configuration path without
    // contacting the deliberately unreachable RPC endpoint.
    expect(chain.contextGraphBoundedAuthorityReadsEnabled).toBe(expected);
  });

  it('keeps snapshot fetch fenced until the agent transport has started', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'SnapshotBeforeStart',
      listenHost: '127.0.0.1',
      listenPort: 0,
      store,
      nodeRole: 'edge',
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [pinnedAddress] },
      localContextGraphAuthorityIndexStore: localAuthorityIndexStore(),
      chainConfig: evmChainConfig,
    });
    const chain = (agent as any).chain;
    const transport = vi.spyOn(agent.node, 'libp2p', 'get');
    try {
      await expect(chain.contextGraphAuthorityIndex.bootstrap.fetchSnapshot(request)).rejects.toThrow(
        'No configured trusted core supplied a usable authority index snapshot',
      );
      expect(transport).not.toHaveBeenCalled();
    } finally {
      await agent.node.stop();
      await store.close();
      chain.destroy();
    }
  });

  it.each([
    ['injected chain adapter', { chainAdapter: new MockChainAdapter() }],
    ['missing EVM configuration', { chainConfig: undefined }],
    ['missing operational keys', { chainConfig: { ...evmChainConfig, operationalKeys: [] } }],
    ['missing local store', { localContextGraphAuthorityIndexStore: undefined }],
  ])('rejects snapshot mode with %s before allocating an agent', async (_label, overrides) => {
    await expect(DKGAgent.create({
      name: 'InvalidSnapshotConstruction',
      nodeRole: 'edge',
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [pinnedAddress] },
      chainConfig: evmChainConfig,
      localContextGraphAuthorityIndexStore: localAuthorityIndexStore(),
      ...overrides,
    })).rejects.toThrow('requires a configured EVM chain and a local authority index store');
  });

  it('keys trusted cache scope by peer identity set and explicit reset epoch', async () => {
    async function trustDomain(trustedCorePeers: string[], cacheEpoch?: number): Promise<string> {
      const store = new OxigraphStore();
      const agent = await DKGAgent.create({
        name: 'SnapshotTrustDomain',
        listenHost: '127.0.0.1',
        listenPort: 0,
        nodeRole: 'edge',
        store,
        authorityIndex: { mode: 'core-snapshot', trustedCorePeers, cacheEpoch },
        chainConfig: evmChainConfig,
        localContextGraphAuthorityIndexStore: localAuthorityIndexStore(),
      });
      const chain = (agent as any).chain;
      try {
        return chain.contextGraphAuthorityIndex.bootstrap.trustDomain;
      } finally {
        await agent.node.stop();
        await store.close();
        chain.destroy();
      }
    }
    const initial = await trustDomain([pinnedAddress, secondPinnedAddress]);
    expect(await trustDomain([secondPinnedAddress, pinnedAddress], 0)).toBe(initial);
    expect(await trustDomain([
      `/dns4/moved.example.com/tcp/9091/p2p/${PINNED_PEER}`,
      secondPinnedAddress,
    ])).toBe(initial);
    expect(await trustDomain([pinnedAddress])).not.toBe(initial);
    expect(await trustDomain([pinnedAddress, secondPinnedAddress], 1)).not.toBe(initial);
    expect(await trustDomain([pinnedAddress, secondPinnedAddress], 1)).toBe(
      await trustDomain([secondPinnedAddress, pinnedAddress], 1),
    );
  }, 20_000);

  it.each(['maxTailBlock', 'trustedCorePeer', 'unexpected'])(
    'rejects unknown authorityIndex option %s with supported keys', (unknownKey) => {
      expect(() => resolveAuthorityIndexConfig({
        mode: 'core-snapshot',
        trustedCorePeers: [pinnedAddress],
        [unknownKey]: 2_000,
      }, 'edge')).toThrow(`Unknown authorityIndex option(s): ${unknownKey}. Supported options:`);
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, '1'])(
    'rejects invalid authorityIndex.cacheEpoch %j', (cacheEpoch) => {
      expect(() => resolveAuthorityIndexConfig({
        mode: 'core-snapshot', trustedCorePeers: [pinnedAddress], cacheEpoch,
      }, 'edge')).toThrow('authorityIndex.cacheEpoch must be a non-negative safe integer');
    },
  );

  it('seeds an edge without operator config from the network relays only, with local-history fallback hooks', async () => {
    const logs: LogRecord[] = [];
    Logger.setSink((record) => { logs.push(record); });
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'SnapshotNetworkRelayDefault',
      listenHost: '127.0.0.1',
      listenPort: 0,
      store,
      nodeRole: 'edge',
      // An operator transport relay the network file never vouched for.
      relayPeers: [secondPinnedAddress],
      networkRelays: [pinnedAddress],
      localContextGraphAuthorityIndexStore: localAuthorityIndexStore(),
      chainConfig: evmChainConfig,
    });
    const chain = (agent as any).chain;
    const bootstrap = chain.contextGraphAuthorityIndex.bootstrap as ContextGraphAuthorityIndexBootstrap;
    try {
      expect(bootstrap.maxTailBlocks).toBe(2_000);
      expect(bootstrap.localHistoryFallback).toBe(true);
      // The namespace an operator block pinning the same relay would use.
      expect(bootstrap.trustDomain).toBe(createHash('sha256').update(JSON.stringify([PINNED_PEER])).digest('hex'));

      const libp2p = {
        peerStore: { merge: vi.fn(async () => {}) },
        dial: vi.fn(async () => ({})),
      };
      vi.spyOn(agent.node, 'libp2p', 'get').mockReturnValue(libp2p as any);
      // A forged registry row: a "core" claiming a staked member's operational
      // address under an unrelated PeerID, which the chain would vouch for.
      const findAgents = vi.spyOn(agent.discovery, 'findAgents').mockResolvedValue([{
        agentUri: 'did:dkg:agent:0x00000000000000000000000000000000000000c0',
        name: 'forged-core',
        peerId: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
        nodeRole: 'core',
        agentAddress: '0x00000000000000000000000000000000000000c0',
        lastSeen: new Date().toISOString(),
      }]);
      vi.spyOn(chain, 'getIdentityIdForAddress').mockResolvedValue(7n);
      vi.spyOn(chain, 'isShardingTableMember').mockResolvedValue(true);
      const send = vi.fn(async () => encode({ version: 1, status: 'ok', snapshot }));
      (agent as any).router = { send };
      (agent as any).started = true;
      const validate = vi.fn(async () => {});
      await expect(bootstrap.fetchSnapshot(request, new AbortController().signal, validate)).resolves.toEqual(snapshot);
      // Only the network relay is asked, dialed by the address the network file
      // pins; the phonebook is never consulted, so no registry row earns trust.
      expect(findAgents).not.toHaveBeenCalled();
      expect(send.mock.calls.map(([peerId]) => peerId)).toEqual([PINNED_PEER]);
      expect(libp2p.dial).toHaveBeenCalledExactlyOnceWith(multiaddr(pinnedAddress), { signal: expect.any(AbortSignal) });
      expect(validate).toHaveBeenCalledOnce();

      bootstrap.onLocalHistoryFallback!({ scope: request.scope, reason: 'no trusted core answered' });
      expect(logs.filter((record) => record.level === 'warn').map((record) => record.message)).toContain(
        `[authority-index] no network relay supplied a snapshot for ${request.scope}; `
        + 'falling back to local history: no trusted core answered',
      );
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const progress = (throughBlockNumber: number, scannedBlocks: number) => bootstrap.onScanProgress!({
        scope: request.scope, fromBlockNumber: 100, throughBlockNumber, finalizedNumber: 2_500, scannedBlocks,
      });
      progress(600, 500);
      progress(1_100, 1_000);
      now.mockReturnValue(1_029_999);
      progress(1_600, 1_500);
      now.mockReturnValue(1_030_000);
      progress(2_100, 2_000);
      expect(logs.filter((record) => record.message.startsWith('[authority-index] scope=')).map((record) => record.message))
        .toEqual([
          `[authority-index] scope=${request.scope} scanned=500 through=600 behind=1900`,
          `[authority-index] scope=${request.scope} scanned=2000 through=2100 behind=400`,
        ]);
    } finally {
      Logger.setSink(null);
      (agent as any).started = false;
      await agent.node.stop();
      await store.close();
      chain.destroy();
    }
  }, 20_000);

  it.each([
    ['no network relay', { networkRelays: [] }],
    ['no local index store', { localContextGraphAuthorityIndexStore: undefined }],
    ['an injected chain adapter', { chainAdapter: new MockChainAdapter('mock:31337') }],
  ])('builds an edge that cannot seed from network relays on local history: %s', async (_label, overrides) => {
    // The default is the agent's own decision: where it cannot run, the edge
    // indexes chain history instead of failing construction.
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'SnapshotDefaultSkipped',
      listenHost: '127.0.0.1',
      listenPort: 0,
      store,
      nodeRole: 'edge',
      networkRelays: [pinnedAddress],
      localContextGraphAuthorityIndexStore: localAuthorityIndexStore(),
      chainConfig: evmChainConfig,
      ...overrides,
    });
    const chain = (agent as any).chain;
    try {
      expect(chain.contextGraphAuthorityIndex?.bootstrap).toBeUndefined();
    } finally {
      await agent.node.stop();
      await store.close();
      chain.destroy?.();
    }
  }, 20_000);

  it('keeps operator trust on its pinned walk over the network relays, without fallback hooks', async () => {
    const store = new OxigraphStore();
    const agent = await DKGAgent.create({
      name: 'SnapshotOperatorNoFallback',
      listenHost: '127.0.0.1',
      listenPort: 0,
      store,
      nodeRole: 'edge',
      authorityIndex: { mode: 'core-snapshot', trustedCorePeers: [pinnedAddress] },
      networkRelays: [secondPinnedAddress],
      localContextGraphAuthorityIndexStore: localAuthorityIndexStore(),
      chainConfig: evmChainConfig,
    });
    const chain = (agent as any).chain;
    const bootstrap = chain.contextGraphAuthorityIndex.bootstrap as ContextGraphAuthorityIndexBootstrap;
    try {
      expect(bootstrap.trustDomain).toBe(createHash('sha256').update(JSON.stringify([PINNED_PEER])).digest('hex'));
      expect('localHistoryFallback' in bootstrap).toBe(false);
      expect(bootstrap.onLocalHistoryFallback).toBeUndefined();
      expect(bootstrap.onScanProgress).toBeUndefined();
    } finally {
      await agent.node.stop();
      await store.close();
      chain.destroy();
    }
  });
});
