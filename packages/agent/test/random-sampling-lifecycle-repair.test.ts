import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC, tripleContentV10, type OperationContext } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';

type LifecycleRepairMethod = typeof LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset;
type LifecycleRepairInput = Parameters<LifecycleRepairMethod>[0];
type RegistryAgent = { peerId: string; nodeRole: string };

interface RepairAgentHarness {
  started: boolean;
  peerId: string;
  chain: {
    chainId: string;
    getDKGKnowledgeAssetsAddress: () => Promise<string>;
  };
  node: {
    stopSignal: AbortSignal | undefined;
    libp2p: {
      getConnections: () => Array<{ remotePeer: { toString(): string } }>;
    };
  };
  log: { info: (ctx: OperationContext, message: string) => void };
  resolveRandomSamplingLocalContextGraphId: (
    cgId: bigint,
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  resolveCuratorPeerIdsForCg: (
    contextGraphId: string,
    options: { maxPeerIds: number; signal: AbortSignal; isCurrent: () => boolean },
  ) => Promise<{
    peerIds: string[];
    curatorIsLocal?: boolean;
    legacyTripleResolved?: boolean;
  }>;
  discovery: {
    findAgents: (options: { signal: AbortSignal }) => Promise<RegistryAgent[]>;
  };
  vmReconcileObservedCandidatePeerIds: (contextGraphId: string) => string[];
  preferredSyncPeers: Map<string, string>;
  selectCatchupPeerWindow: (
    candidates: Array<{ toString(): string }>,
    options: { maxPeers: number; peerRotationKey?: string },
  ) => Array<{ toString(): string }>;
  ensurePeerAdmittedForRecovery: (
    peerId: string,
    ctx: OperationContext,
    label: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  ensurePeerConnected: (peerId: string, options: { signal: AbortSignal }) => Promise<void>;
  waitForSyncProtocol: (
    peer: string | { toString(): string },
    signal: AbortSignal,
  ) => Promise<boolean>;
  syncExactKnowledgeAssetsFromPeerDetailed: (
    peerId: string,
    contextGraphId: string,
    selection: unknown,
    options: { signal: AbortSignal; isCurrent: () => boolean },
  ) => Promise<unknown>;
}

const EXPECTED_UAL = 'did:dkg:base:8453/0x0000000000000000000000000000000000001234/7';
const EMPTY_MATERIAL = { contents: [], privateRoots: [] };

function foundAt(peerIds: readonly string[]) {
  return vi.fn(async (peerId: string) => (peerIds.includes(peerId)
    ? {
        disposition: 'found' as const,
        result: { insertedTriples: 0 },
        authenticatedAssets: [{
          asset: { ual: EXPECTED_UAL, dataQuads: [] },
          privateRoots: [],
        }],
      }
    : { disposition: 'clean-absent' as const, result: { insertedTriples: 0 } }));
}

function makeRepairAgent(overrides: Partial<RepairAgentHarness> = {}): RepairAgentHarness {
  return {
    started: true,
    peerId: 'self',
    chain: {
      chainId: 'base:8453',
      getDKGKnowledgeAssetsAddress: vi.fn(async () =>
        '0x0000000000000000000000000000000000001234'),
    },
    node: { stopSignal: undefined, libp2p: { getConnections: () => [] } },
    log: { info: vi.fn() },
    resolveRandomSamplingLocalContextGraphId: vi.fn(async () => 'food-safety'),
    resolveCuratorPeerIdsForCg: vi.fn(async () => ({ peerIds: [] })),
    discovery: { findAgents: vi.fn(async () => []) },
    vmReconcileObservedCandidatePeerIds: vi.fn(() => []),
    preferredSyncPeers: new Map(),
    selectCatchupPeerWindow: vi.fn((candidates) => candidates),
    ensurePeerAdmittedForRecovery: vi.fn(async () => true),
    ensurePeerConnected: vi.fn(async () => undefined),
    waitForSyncProtocol: vi.fn(async () => true),
    syncExactKnowledgeAssetsFromPeerDetailed: vi.fn(async () => ({
      disposition: 'clean-absent',
      result: { insertedTriples: 0 },
    })),
    ...overrides,
  };
}

/** Bind the production keyed peer window so rotation state persists across repairs. */
function withProductionPeerWindow(agent: RepairAgentHarness): RepairAgentHarness {
  const rotationState = {
    vmReconcileCatchupPeerCursor: new Map<string, number>(),
    vmReconcileCatchupPeerOrder: new Map<string, {
      orderedPeers: string[];
      nextPeerId?: string;
      priorityRanks?: Record<string, number>;
    }>(),
    pruneVmReconcileState: () => undefined,
  };
  const selectCatchupPeerWindow = LifecycleSyncMethods.prototype.selectCatchupPeerWindow;
  return {
    ...agent,
    selectCatchupPeerWindow: (candidates, options) => selectCatchupPeerWindow.call(
      rotationState as never,
      candidates,
      options,
    ),
  };
}

const DEFAULT_REPAIR_INPUT: LifecycleRepairInput = {
  kaId: (0x1234n << 96n) | 7n,
  cgId: 1n,
  expectedRoot: new Uint8Array(32).fill(0x11),
  expectedLeafCount: 1n,
};

function startLifecycleRepair(
  agent: RepairAgentHarness,
  input: LifecycleRepairInput = DEFAULT_REPAIR_INPUT,
) {
  return LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset.call(
    agent as unknown as ThisParameterType<LifecycleRepairMethod>,
    input,
  );
}

function runLifecycleRepair(
  agent: RepairAgentHarness,
  input: LifecycleRepairInput = DEFAULT_REPAIR_INPUT,
) {
  return startLifecycleRepair(agent, input).result;
}

describe('Random Sampling lifecycle repair adapter', () => {
  it('canonicalizes string peer IDs before the libp2p protocol lookup', async () => {
    const peerId = '12D3KooWLwPkoiastt27S2SRPtdx6t8KuFXwcbHovgCkAMfkJcXx';
    const get = vi.fn(async (peer: {
      toString(): string;
      type: string;
      multihash: unknown;
    }) => {
      expect(peer.toString()).toBe(peerId);
      expect(peer.type).toBe('Ed25519');
      expect(peer.multihash).toBeDefined();
      return { protocols: [PROTOCOL_SYNC] };
    });

    await expect(LifecycleSyncMethods.prototype.waitForSyncProtocol.call({
      node: { libp2p: { peerStore: { get } } },
    } as never, peerId)).resolves.toBe(true);
    expect(get).toHaveBeenCalledOnce();
  });

  it('keeps every Core eligible after a distinct graph-specific provider', async () => {
    const curatorPeer = 'peer-curator';
    const corePeers = Array.from(
      { length: 256 },
      (_, index) => `peer-core-${String(index + 1).padStart(3, '0')}`,
    );
    const peers = [curatorPeer, ...corePeers];
    const finalCorePeer = corePeers.at(-1)!;
    const historicalQuad = {
      subject: 'urn:historical',
      predicate: 'urn:value',
      object: '"proof"',
      graph: 'urn:historical-graph',
    };
    const proofMaterial = {
      contents: [tripleContentV10(
        historicalQuad.subject,
        historicalQuad.predicate,
        historicalQuad.object,
      )],
      privateRoots: [],
    };
    const syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async (peerId: string, ..._rest: unknown[]) => ({
      disposition: peerId === finalCorePeer ? 'found' : 'clean-absent',
      result: { insertedTriples: 0 },
      ...(peerId === finalCorePeer
        ? {
            authenticatedAssets: [{
              asset: {
                ual: EXPECTED_UAL,
                dataQuads: [historicalQuad],
              },
              privateRoots: [],
            }],
          }
        : {}),
    }));
    let nextPeerIndex = 0;
    const selectCatchupPeerWindow = vi.fn((
      candidates: Array<{ toString(): string }>,
      options: { maxPeers: number },
    ) => {
      const selected = Array.from(
        { length: Math.min(options.maxPeers, candidates.length) },
        (_, offset) => candidates[(nextPeerIndex + offset) % candidates.length]!,
      );
      nextPeerIndex = (nextPeerIndex + selected.length) % candidates.length;
      return selected;
    });
    const findAgents = vi.fn(async () => [
      ...corePeers.map((peerId) => ({ peerId, nodeRole: 'core' })),
      { peerId: 'edge-0001', nodeRole: 'edge' },
      { peerId: 'self', nodeRole: 'core' },
    ]);
    const agentLike = makeRepairAgent({
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({ peerIds: [curatorPeer] })),
      discovery: { findAgents },
      selectCatchupPeerWindow,
      syncExactKnowledgeAssetsFromPeerDetailed,
    });
    const kaId = (0x1234n << 96n) | 7n;
    const expectedRoot = new Uint8Array(32).fill(0x11);

    const repair = () => runLifecycleRepair(agentLike, {
      kaId,
      cgId: 1n,
      expectedRoot,
      expectedLeafCount: 12n,
    });
    const repairCount = Math.ceil(peers.length / DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX);
    for (let index = 1; index < repairCount; index += 1) {
      await expect(repair()).rejects.toThrow('did not recover');
    }
    await expect(repair()).resolves.toEqual(proofMaterial);

    expect(syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenCalledTimes(peers.length);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(peers);
    expect(selectCatchupPeerWindow).toHaveBeenCalledTimes(repairCount);
    for (const [, options] of selectCatchupPeerWindow.mock.calls) {
      expect(options).toEqual(expect.objectContaining({
        maxPeers: DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
        peerRotationKey: 'rs-proof:food-safety',
      }));
    }
    expect(findAgents).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    for (const call of syncExactKnowledgeAssetsFromPeerDetailed.mock.calls) {
      expect(call[1]).toBe('food-safety');
      expect(call[2]).toEqual({
        kind: 'challenge-pinned',
        commitments: [{
          assetUal: EXPECTED_UAL,
          merkleRootHex: '11'.repeat(32),
          merkleLeafCount: 12n,
        }],
      });
      expect(call[3]).toEqual(expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
    }
    expect(vi.mocked(agentLike.ensurePeerAdmittedForRecovery).mock.calls[0]?.[3])
      .toBeInstanceOf(AbortSignal);
    expect(vi.mocked(agentLike.ensurePeerConnected).mock.calls[0]?.[1])
      .toEqual({ signal: expect.any(AbortSignal) });
    expect(vi.mocked(agentLike.waitForSyncProtocol).mock.calls[0]?.[1])
      .toBeInstanceOf(AbortSignal);
    expect(vi.mocked(agentLike.waitForSyncProtocol).mock.calls[0]?.[0]).toBe(peers[0]);
  });

  it('reaches every Core across repairs when the registry shuffles its order', async () => {
    const corePeers = ['core-a', 'core-b', 'core-c', 'core-d', 'core-e', 'core-f'];
    const registryOrders = [
      ['core-c', 'core-f', 'core-a', 'core-e', 'core-b', 'core-d'],
      ['core-b', 'core-a', 'core-d', 'core-f', 'core-c', 'core-e'],
    ];
    let discoveryCount = 0;
    const findAgents = vi.fn(async () => registryOrders[discoveryCount++ % registryOrders.length]!
      .map((peerId) => ({ peerId, nodeRole: 'core' })));
    const syncExactKnowledgeAssetsFromPeerDetailed = foundAt(['core-f']);
    const agentLike = withProductionPeerWindow(makeRepairAgent({
      discovery: { findAgents },
      syncExactKnowledgeAssetsFromPeerDetailed,
    }));

    expect(DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX).toBe(3);
    await expect(runLifecycleRepair(agentLike)).rejects.toThrow('did not recover');
    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);

    expect(findAgents).toHaveBeenCalledTimes(2);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(corePeers);
  });

  it('discovers candidate sources concurrently and tries observed providers before Cores', async () => {
    let releaseCurator!: (value: { peerIds: string[] }) => void;
    let releaseRegistry!: (value: RegistryAgent[]) => void;
    const curatorPromise = new Promise<{ peerIds: string[] }>((resolve) => {
      releaseCurator = resolve;
    });
    const registryPromise = new Promise<RegistryAgent[]>((resolve) => {
      releaseRegistry = resolve;
    });
    const resolveCuratorPeerIdsForCg = vi.fn(() => curatorPromise);
    const findAgents = vi.fn(() => registryPromise);
    const syncExactKnowledgeAssetsFromPeerDetailed = vi.fn(async (peerId: string) => {
      if (peerId === 'peer-stalled-core') throw new Error('stale Core must not outrank evidence');
      return {
        disposition: 'found' as const,
        result: { insertedTriples: 0 },
        authenticatedAssets: [{
          asset: { ual: EXPECTED_UAL, dataQuads: [] },
          privateRoots: [],
        }],
      };
    });
    const agentLike = makeRepairAgent({
      resolveCuratorPeerIdsForCg,
      discovery: { findAgents },
      vmReconcileObservedCandidatePeerIds: vi.fn(() => ['peer-known']),
      syncExactKnowledgeAssetsFromPeerDetailed,
    });

    const repair = runLifecycleRepair(agentLike);
    await vi.waitFor(() => {
      expect(resolveCuratorPeerIdsForCg).toHaveBeenCalledOnce();
      expect(findAgents).toHaveBeenCalledOnce();
    });
    releaseRegistry([{ peerId: 'peer-stalled-core', nodeRole: 'core' }]);
    releaseCurator({ peerIds: [] });

    await expect(repair).resolves.toEqual(EMPTY_MATERIAL);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-known']);
  });

  it('falls back to graph-specific providers when Core discovery fails', async () => {
    const logInfo = vi.fn();
    const syncExactKnowledgeAssetsFromPeerDetailed = foundAt(['peer-curator']);
    const agentLike = makeRepairAgent({
      log: { info: logInfo },
      resolveCuratorPeerIdsForCg: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
      discovery: { findAgents: vi.fn(async () => { throw new Error('registry unavailable'); }) },
      syncExactKnowledgeAssetsFromPeerDetailed,
    });

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls[0]?.[0]).toBe('peer-curator');
    expect(logInfo).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('registry unavailable'),
    );
  });

  it('falls back to the Core roster when curator discovery fails', async () => {
    const syncExactKnowledgeAssetsFromPeerDetailed = foundAt(['peer-core']);
    const agentLike = makeRepairAgent({
      resolveCuratorPeerIdsForCg: vi.fn(async () => { throw new Error('curator lookup failed'); }),
      discovery: { findAgents: vi.fn(async () => [{ peerId: 'peer-core', nodeRole: 'core' }]) },
      syncExactKnowledgeAssetsFromPeerDetailed,
    });

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-core']);
  });

  it('propagates prover cancellation raised while both discovery sources are pending', async () => {
    const rejectOnAbort = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const resolveCuratorPeerIdsForCg = vi.fn(
      (_contextGraphId: string, options: { signal: AbortSignal }) => rejectOnAbort(options.signal),
    );
    const findAgents = vi.fn((options: { signal: AbortSignal }) => rejectOnAbort(options.signal));
    const agentLike = makeRepairAgent({
      resolveCuratorPeerIdsForCg,
      discovery: { findAgents },
    });

    const repair = startLifecycleRepair(agentLike);
    await vi.waitFor(() => expect(findAgents).toHaveBeenCalledOnce());
    const reason = new Error('prover stopped');
    repair.cancel(reason);

    await expect(repair.result).rejects.toBe(reason);
    await expect(repair.settled).resolves.toBeUndefined();
    expect(agentLike.log.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Core-roster discovery failed'),
    );
    expect(agentLike.syncExactKnowledgeAssetsFromPeerDetailed).not.toHaveBeenCalled();
  });

  it('skips peers that fail admission or lack the sync protocol without dialing past the gate', async () => {
    const ensurePeerAdmittedForRecovery = vi.fn(async (peerId: string) => peerId !== 'peer-rejected');
    const waitForSyncProtocol = vi.fn(async (peer: string | { toString(): string }) =>
      peer.toString() !== 'peer-legacy');
    const syncExactKnowledgeAssetsFromPeerDetailed = foundAt(['peer-holder']);
    const agentLike = makeRepairAgent({
      log: { info: vi.fn() },
      vmReconcileObservedCandidatePeerIds: vi.fn(() => ['peer-rejected', 'peer-legacy', 'peer-holder']),
      ensurePeerAdmittedForRecovery,
      waitForSyncProtocol,
      syncExactKnowledgeAssetsFromPeerDetailed,
    });

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);
    expect(vi.mocked(agentLike.ensurePeerConnected).mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-legacy', 'peer-holder']);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-holder']);
    const messages = vi.mocked(agentLike.log.info).mock.calls.map(([, message]) => message);
    expect(messages).toContainEqual(expect.stringContaining('peer-rejected skipped: not-admitted'));
    expect(messages).toContainEqual(expect.stringContaining('peer-legacy skipped: sync-protocol-unavailable'));
  });

  it('reports skipped peers in the aggregate failure when nothing recovers the asset', async () => {
    const agentLike = makeRepairAgent({
      vmReconcileObservedCandidatePeerIds: vi.fn(() => ['peer-rejected', 'peer-legacy']),
      ensurePeerAdmittedForRecovery: vi.fn(async (peerId: string) => peerId !== 'peer-rejected'),
      waitForSyncProtocol: vi.fn(async () => false),
    });

    await expect(runLifecycleRepair(agentLike)).rejects.toThrow(
      'did not recover: rejected=skipped:not-admitted,r-legacy=skipped:sync-protocol-unavailable; asset=',
    );
    expect(agentLike.syncExactKnowledgeAssetsFromPeerDetailed).not.toHaveBeenCalled();
  });

  it('discovers and dials a registry provider with an empty local cache and no connection', async () => {
    const providerPeerId = '12D3KooWRegistryProofProvider';
    const resolveCuratorPeerIdsForCg = vi.fn(async () => ({
      peerIds: [providerPeerId],
      curatorIsLocal: false,
      legacyTripleResolved: false,
    }));
    const ensurePeerConnected = vi.fn(async () => undefined);
    const syncExactKnowledgeAssetsFromPeerDetailed = foundAt([providerPeerId]);
    const agentLike = makeRepairAgent({
      resolveCuratorPeerIdsForCg,
      discovery: { findAgents: vi.fn(async () => []) },
      ensurePeerConnected,
      syncExactKnowledgeAssetsFromPeerDetailed,
    });

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);

    expect(resolveCuratorPeerIdsForCg).toHaveBeenCalledWith(
      'food-safety',
      expect.objectContaining({
        maxPeerIds: expect.any(Number),
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
    );
    expect(ensurePeerConnected).toHaveBeenCalledWith(
      providerPeerId,
      { signal: expect.any(AbortSignal) },
    );
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls[0]?.[0])
      .toBe(providerPeerId);
  });

  it('fails closed when no local on-chain CG binding exists', async () => {
    const agentLike = {
      chain: {},
      node: { stopSignal: undefined },
      log: { info: vi.fn() },
      resolveLocalCgIdByOnChainId: vi.fn(() => undefined),
      resolveRandomSamplingLocalContextGraphId: vi.fn(async () => undefined),
    };

    await expect(
      (LifecycleSyncMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
        agentLike,
        {
          kaId: 7n,
          cgId: 1n,
          expectedRoot: new Uint8Array(32),
          expectedLeafCount: 1n,
        },
      ).result,
    ).rejects.toThrow('cannot resolve local CG 1');
  });

  it('awaits the required cold-binding resolver before provider discovery', async () => {
    const resolverSignal: AbortSignal[] = [];
    const resolveRandomSamplingLocalContextGraphId = vi.fn(async (
      _cgId: bigint,
      signal: AbortSignal,
    ) => {
      resolverSignal.push(signal);
      return 'cold-public-proof-cg';
    });
    const resolveCuratorPeerIdsForCg = vi.fn(async () => ({ peerIds: [] }));
    const agentLike = makeRepairAgent({
      resolveRandomSamplingLocalContextGraphId,
      resolveCuratorPeerIdsForCg,
    });

    await expect(runLifecycleRepair(agentLike, {
      kaId: 7n,
      cgId: 317n,
      expectedRoot: new Uint8Array(32),
      expectedLeafCount: 1n,
    })).rejects.toThrow('no providers for cold-public-proof-cg');

    expect(resolveRandomSamplingLocalContextGraphId).toHaveBeenCalledWith(
      317n,
      expect.any(AbortSignal),
    );
    expect(resolveCuratorPeerIdsForCg).toHaveBeenCalledWith(
      'cold-public-proof-cg',
      expect.objectContaining({ signal: resolverSignal[0] }),
    );
  });
});
