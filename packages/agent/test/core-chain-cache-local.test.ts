import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_GENESIS_ID, computeNetworkId } from '@origintrail-official/dkg-core';
import { createEvmCoreChainCacheRegistry, EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { makeAdapterConfig, HARDHAT_KEYS, takeSnapshot, revertSnapshot } from '../../chain/test/evm-test-context.js';
import { graph, publicSnapshotFixture } from './helpers/public-snapshot-local-fixture.js';
import type { CoreChainCacheNetwork } from '../src/core-chain-cache-config.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('keeps the explicit-peer protocol compatible when the serving core enables chain cache', async () => {
  const before = await takeSnapshot();
  const f = await publicSnapshotFixture('exact');
  const registry = createEvmCoreChainCacheRegistry({ chainId: f.adapter.chainId,
    hubAddress: f.hubAddress, rpcUrls: [f.rpcUrl], finalityConfirmations: 1 });
  try {
    const core = await f.make('CompatibleCore', 'core', f.adapter, f.source, {
      DKG_Core_chain_cache: true, coreChainCacheNetworks: [{ registry, relays: [], identity: {
        chainId: f.adapter.chainId, genesisId: DEFAULT_GENESIS_ID, networkId: await computeNetworkId(DEFAULT_GENESIS_ID),
      } }],
    });
    const target = new OxigraphStore();
    const edge = await f.make('LegacyEdge', 'edge', new EVMChainAdapter(makeAdapterConfig(f.rpcUrl, f.hubAddress, HARDHAT_KEYS.REC1_OP)), target);
    await edge.connectTo(core.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    edge.subscribeToContextGraph(graph, { onChainId: f.onChainId, syncMode: 'on-demand', trackSyncScope: false, deferSharedMemoryGossipSubscribe: true });
    expect(await edge.syncPublicGraphSnapshot({ contextGraphId: graph, onChainId: f.onChainId,
      trustedCorePeerIds: [core.peerId], transport: 'exact' })).toMatchObject({ assets: 12, committed: 12, current: true });
  } finally { await f.dispose(); registry.destroy(); await revertSnapshot(before); }
});

it.each(['exact', 'bulk'] as const)('authenticates a foreign core, retrieves verified content on the data network and measures physical RPC (%s)', async transport => {
  vi.stubEnv("DKG_PUBLIC_SNAPSHOT_BULK", transport === "bulk" ? "1" : "0");
  const before = await takeSnapshot();
  const f = await publicSnapshotFixture(transport);
  const owned: CoreChainCacheNetwork[] = [];
  try {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    // Independent chain namespaces/deployments over the isolated local EVM fixture.
    // This is a controlled protocol/RPC measurement, not a live mainnet speed claim.
    const networks = (): CoreChainCacheNetwork[] => ['evm:31337', 'gnosis:31337'].map(chainId => {
      const n = { identity: { networkId, genesisId: DEFAULT_GENESIS_ID, chainId }, relays: [] as string[],
        registry: createEvmCoreChainCacheRegistry({ chainId, hubAddress: f.hubAddress, rpcUrls: [f.rpcUrl], finalityConfirmations: 1 }) };
      owned.push(n); return n;
    });
    const foreignChain = new EVMChainAdapter({ ...makeAdapterConfig(f.rpcUrl, f.hubAddress, HARDHAT_KEYS.CORE_OP), chainId: 'gnosis:31337' });
    const foreign = await f.make('ForeignCacheCore', 'core', foreignChain, new OxigraphStore(), {
      DKG_Core_chain_cache: true, coreChainCacheNetworks: networks(),
    });
    const content = await f.make('DataContentCore', 'core', f.adapter, f.source);
    const receiverChain = new EVMChainAdapter(makeAdapterConfig(f.rpcUrl, f.hubAddress, HARDHAT_KEYS.REC1_OP));
    const edgeNetworks = networks();
    (edgeNetworks[1].relays as string[]).push(foreign.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    const target = new OxigraphStore();
    const edge = await f.make('CacheEdge', 'edge', receiverChain, target, {
      DKG_Core_chain_cache: true, coreChainCacheNetworks: edgeNetworks,
    });
    await edge.connectTo(content.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
    await edge.awaitInitialChainPoll();
    edge.subscribeToContextGraph(graph, { onChainId: f.onChainId, syncMode: 'on-demand', trackSyncScope: false, deferSharedMemoryGossipSubscribe: true });
    // Measure the same complete inventory twice, as required at start/final coverage.
    const independent = createEvmCoreChainCacheRegistry({ chainId: receiverChain.chainId, hubAddress: f.hubAddress,
      rpcUrls: [f.rpcUrl], finalityConfirmations: 1 });
    try {
      for (let i = 0; i < 2; i++) await independent.readPublicGraphSnapshot(graph, f.onChainId, { signal: AbortSignal.timeout(110_000) });
      const baseline = independent.rpcUsage();
      const forbidden = ['readPublicGraphSnapshot', 'getLatestMerkleRoot', 'getMerkleRootCount', 'getKAContextGraphId'] as const;
      const spies = forbidden.map(name => vi.spyOn(receiverChain, name).mockRejectedValue(new Error('Edge asset RPC forbidden')));
      receiverChain.drainRpcUsage();
      const result = await edge.syncPublicGraphSnapshot({ contextGraphId: graph, onChainId: f.onChainId,
        sourcePolicy: 'DKG_Core_chain_cache', trustedCorePeerIds: [], transport });
      const regularEdgeRpc = receiverChain.drainRpcUsage();
      expect(result).toMatchObject({ mode: 'core-cache', assets: 12, committed: 12, current: true,
        sourceCore: foreign.peerId, coverageSourceCore: foreign.peerId, selectedCorePeerIds: [foreign.peerId] });
      if (transport === "bulk") expect(result.bulkChunks?.length).toBeGreaterThan(0);
      expect(result.contentPeerIds).toContain(content.peerId);
      expect(result.contentPeerIds).not.toContain(foreign.peerId);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      const rows = await target.query('SELECT ?name WHERE {GRAPH ?g {?s <http://schema.org/name> ?name}}');
      expect(rows.type === 'bindings' && rows.bindings.length).toBe(12);
      const privateRows = await target.query('SELECT ?v WHERE {GRAPH ?g {?s <urn:secret> ?v}}');
      expect(privateRows.type === 'bindings' && privateRows.bindings.length).toBe(0);
      const cacheCalls = edgeNetworks.reduce((sum, n) => sum + Object.values(n.registry.rpcUsage()).reduce((a, b) => a + b, 0), 0);
      const independentCalls = Object.values(baseline).reduce((a, b) => a + b, 0);
      expect(cacheCalls).toBeGreaterThan(0);
      expect(cacheCalls).toBeLessThan(independentCalls);
      const baselineChain = new EVMChainAdapter(makeAdapterConfig(f.rpcUrl, f.hubAddress, HARDHAT_KEYS.REC2_OP));
      const baselineStore = new OxigraphStore();
      const baselineEdge = await f.make('IndependentEdge', 'edge', baselineChain, baselineStore);
      await baselineEdge.connectTo(content.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!);
      await baselineEdge.awaitInitialChainPoll();
      baselineEdge.subscribeToContextGraph(graph, { onChainId: f.onChainId, syncMode: 'on-demand', trackSyncScope: false, deferSharedMemoryGossipSubscribe: true });
      baselineChain.drainRpcUsage();
      const independentResult = await baselineEdge.syncPublicGraphSnapshot({ contextGraphId: graph, onChainId: f.onChainId,
        mode: 'rpc-only', trustedCorePeerIds: [content.peerId], transport });
      const independentEdgeRpc = baselineChain.drainRpcUsage();
      expect(independentResult).toMatchObject({ assets: 12, committed: 12, current: true });
      expect(independentResult.inventoryDigest).toBe(result.inventoryDigest);
      const independentRows = await baselineStore.query('SELECT ?name WHERE {GRAPH ?g {?s <http://schema.org/name> ?name}}');
      expect(independentRows.type === 'bindings' && independentRows.bindings.length).toBe(12);
      console.log(JSON.stringify({ measurement: 'local-core-chain-cache-rpc', transport, assets: 12,
        independentInventoryRpc: baseline, edgeCacheRpc: result.chainCacheRpcUsage, regularEdgeRpc, independentEdgeRpc,
        cacheCalls, independentCalls, elapsedMs: result.elapsedMs }));
    } finally { independent.destroy(); }
  } finally {
    await f.dispose();
    for (const n of owned) n.registry.destroy();
    await revertSnapshot(before);
  }
});
