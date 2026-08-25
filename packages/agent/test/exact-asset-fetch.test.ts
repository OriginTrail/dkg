import { describe, expect, it, vi } from 'vitest';

import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import {
  ContextGraphAssetFetchConflictError,
  ContextGraphAssetFetchValidationError,
  VmReconcileQueueClosedError,
} from '../src/vm-reconcile-service.js';

const CONTEXT_GRAPH = 'sports';
const ON_CHAIN_ID = '9';
const PEER = '12D3KooWExactFetchPeer';
const UALS = [
  'did:dkg:base:8453/0x00000000000000000000000000000000000000a1/1',
  'did:dkg:base:8453/0x00000000000000000000000000000000000000a1/2',
] as const;

function createFetchHost(options: {
  boundContextGraphId?: bigint;
  present?: readonly string[];
  materialize?: readonly string[];
  noPeers?: boolean;
} = {}) {
  const present = new Set(options.present ?? []);
  const materialize = new Set(options.materialize ?? []);
  const exactFetch = vi.fn(async (
    _peerId: string,
    _contextGraphId: string,
    uals: string[],
  ) => {
    for (const ual of uals) present.add(ual);
    return {
      result: {
        fetchedDataTriples: uals.length,
        fetchedMetaTriples: uals.length,
        insertedTriples: uals.length * 2,
        failedPeers: 0,
        failedPhases: 0,
        deferredBackpressure: 0,
      },
      disposition: 'found',
    };
  });
  const inspect = vi.fn(async (
    input: { ual: string },
    _ctx?: unknown,
    _options?: { allowLegacyScan?: boolean },
  ) => {
    if (materialize.delete(input.ual)) {
      present.add(input.ual);
      return 'promoted';
    }
    return present.has(input.ual) ? 'already-confirmed' : 'no-swm';
  });
  const flush = vi.fn(async () => undefined);
  const subscription = {
    subscribed: true,
    onChainId: ON_CHAIN_ID,
    lastReconciledOrdinal: 77,
  };
  const remotePeer = { toString: () => PEER };
  const host = {
    started: true,
    vmReconcileRuntimeReady: true,
    graphScopedStoreClosed: false,
    vmReconcileRotationClosed: false,
    vmReconcileLifecycleGeneration: 1,
    vmReconcileLifecycleController: new AbortController(),
    vmReconcilePhysicalRuns: new Set<Promise<unknown>>(),
    subscribedContextGraphs: new Map([[CONTEXT_GRAPH, subscription]]),
    chain: {
      chainId: 'base:8453',
      getBlockNumber: async () => 100,
      getKAContextGraphId: async () => options.boundContextGraphId ?? BigInt(ON_CHAIN_ID),
      getLatestMerkleRoot: async () => new Uint8Array(32).fill(7),
      getLatestMerkleRootPublisher: async () => '0x00000000000000000000000000000000000000b1',
    },
    requireLocalCgMatchesOnChainSlot: async () => true,
    getOrCreateFinalizationHandler: () => ({ handleChainReconciledKC: inspect }),
    resolveCuratorPeerIdsForCg: async () => ({ peerIds: options.noPeers ? [] : [PEER] }),
    preferredSyncPeers: new Map<string, string>(),
    peerId: '12D3KooWExactFetchLocal',
    node: {
      libp2p: {
        getConnections: () => options.noPeers ? [] : [{ remotePeer }],
      },
    },
    ensurePeerConnected: async () => undefined,
    waitForSyncProtocol: async () => true,
    ensurePeerAdmittedForRecovery: async () => true,
    syncExactKnowledgeAssetsFromPeerDetailed: exactFetch,
    store: { flush },
    log: { info: vi.fn() },
  };
  return { host, exactFetch, inspect, flush, subscription };
}

describe('exact Context Graph asset fetch', () => {
  it('fetches up to ten named assets without using the background reconciler', async () => {
    const { host, exactFetch, inspect, flush, subscription } = createFetchHost({ present: [UALS[0]] });
    Object.assign(host, {
      config: { syncReconcilerEnabled: false },
      vmReconcileEnabled: () => false,
    });

    const result = await SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
      host as never,
      CONTEXT_GRAPH,
      UALS,
      { peerIds: [PEER] },
    );

    expect(result).toMatchObject({
      contextGraphId: CONTEXT_GRAPH,
      onChainId: ON_CHAIN_ID,
      status: 'complete',
      requestedAssets: 2,
      alreadyPresentAssets: 1,
      materializedAssets: 0,
      fetchedAssets: 1,
      unresolvedAssets: 0,
      networkAttempted: true,
      peerAttempts: 1,
    });
    expect(exactFetch).toHaveBeenCalledWith(
      PEER,
      CONTEXT_GRAPH,
      [UALS[1]],
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(inspect.mock.calls.every((call) => call[2]?.allowLegacyScan === false)).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(subscription.lastReconciledOrdinal).toBe(77);
  });

  it('rejects an asset bound to another Context Graph before network work', async () => {
    const { host, exactFetch } = createFetchHost({ boundContextGraphId: 10n });

    await expect(SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
      host as never,
      CONTEXT_GRAPH,
      [UALS[0]],
      { peerIds: [PEER] },
    )).rejects.toBeInstanceOf(ContextGraphAssetFetchConflictError);
    expect(exactFetch).not.toHaveBeenCalled();
  });

  it('reports an asset materialized from exact local data without a peer fetch', async () => {
    const { host, exactFetch, flush } = createFetchHost({ materialize: [UALS[0]] });

    const result = await SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
      host as never,
      CONTEXT_GRAPH,
      [UALS[0]],
    );

    expect(result).toMatchObject({
      status: 'complete',
      materializedAssets: 1,
      fetchedAssets: 0,
      unresolvedAssets: 0,
      networkAttempted: false,
      items: [{ ual: UALS[0], status: 'materialized' }],
    });
    expect(exactFetch).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('enforces the RFC64 ten-UAL request bound', async () => {
    const { host, exactFetch } = createFetchHost();
    const tooMany = Array.from({ length: 11 }, (_, index) => (
      `did:dkg:base:8453/0x00000000000000000000000000000000000000a1/${index + 1}`
    ));

    await expect(SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
      host as never,
      CONTEXT_GRAPH,
      tooMany,
    )).rejects.toBeInstanceOf(ContextGraphAssetFetchValidationError);
    expect(exactFetch).not.toHaveBeenCalled();
  });

  it('enforces the five-peer request bound', async () => {
    const { host, exactFetch } = createFetchHost();

    await expect(SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
      host as never,
      CONTEXT_GRAPH,
      [UALS[0]],
      { peerIds: Array.from({ length: 6 }, (_, index) => `peer-${index}`) },
    )).rejects.toBeInstanceOf(ContextGraphAssetFetchValidationError);
    expect(exactFetch).not.toHaveBeenCalled();
  });

  it('returns unresolved items when no suitable peer is available', async () => {
    const { host, exactFetch, flush } = createFetchHost({ noPeers: true });

    const result = await SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
      host as never,
      CONTEXT_GRAPH,
      [UALS[0]],
    );

    expect(result).toMatchObject({
      status: 'partial',
      requestedAssets: 1,
      materializedAssets: 0,
      fetchedAssets: 0,
      unresolvedAssets: 1,
      networkAttempted: false,
      peerAttempts: 0,
      items: [{ ual: UALS[0], status: 'unresolved' }],
    });
    expect(exactFetch).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it('rejects new fetch work after shutdown admission closes', async () => {
    const { host } = createFetchHost();
    Object.assign(host, { started: true, vmReconcileRuntimeReady: false });

    await expect(SwmHostModeMethods.prototype.fetchContextGraphAssets.call(
      host as never,
      CONTEXT_GRAPH,
      [UALS[0]],
    )).rejects.toBeInstanceOf(VmReconcileQueueClosedError);
  });
});
