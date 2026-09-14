import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_SYNC, tripleContentV10, type OperationContext } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { RandomSamplingRepairMethods } from '../src/dkg-agent-random-sampling-repair.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS } from '../src/sync/recovery/random-sampling-peer-source.js';

type LifecycleRepairMethod = typeof RandomSamplingRepairMethods.prototype.repairRandomSamplingKnowledgeAsset;
type LifecycleRepairInput = Parameters<LifecycleRepairMethod>[0];
type RegistryAgent = { peerId: string; nodeRole: string; agentAddress?: string };

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
  networkAdmissionCoordinator: {
    ensurePeerAgentBinding: (
      peerId: string,
      agentAddress: string,
      ctx: OperationContext,
      options?: { signal?: AbortSignal },
    ) => Promise<boolean>;
  };
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
    findAgents: (options: {
      signal: AbortSignal;
      limit: number;
      nodeRole: 'core';
    }) => Promise<RegistryAgent[]>;
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
  waitForSyncProtocol: (peerId: string, signal: AbortSignal) => Promise<boolean>;
  classifyShardingTableCore: (
    agentAddress: string | undefined,
  ) => Promise<'member' | 'non-member' | 'unavailable' | 'indeterminate'>;
  authenticateCorePeerAddress: (
    agent: RegistryAgent,
    signal?: AbortSignal,
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
    networkAdmissionCoordinator: {
      ensurePeerAgentBinding: vi.fn(async () => true),
    },
    resolveRandomSamplingLocalContextGraphId: vi.fn(async () => 'food-safety'),
    resolveCuratorPeerIdsForCg: vi.fn(async () => ({ peerIds: [] })),
    discovery: { findAgents: vi.fn(async () => []) },
    vmReconcileObservedCandidatePeerIds: vi.fn(() => []),
    preferredSyncPeers: new Map(),
    selectCatchupPeerWindow: vi.fn((candidates) => candidates),
    ensurePeerAdmittedForRecovery: vi.fn(async () => true),
    ensurePeerConnected: vi.fn(async () => undefined),
    waitForSyncProtocol: vi.fn(async () => true),
    authenticateCorePeerAddress: vi.fn(async () => true),
    classifyShardingTableCore: vi.fn(async () => 'member'),
    syncExactKnowledgeAssetsFromPeerDetailed: vi.fn(async () => ({
      disposition: 'clean-absent',
      result: { insertedTriples: 0 },
    })),
    ...overrides,
  };
}

/** Bind the production peer/address authentication adapter into the lifecycle harness. */
function withProductionCorePeerAuthentication(agent: RepairAgentHarness): RepairAgentHarness {
  const authenticateCorePeerAddress = RandomSamplingRepairMethods.prototype.authenticateCorePeerAddress;
  return {
    ...agent,
    authenticateCorePeerAddress: (candidate, signal) => authenticateCorePeerAddress.call(
      agent as unknown as ThisParameterType<typeof authenticateCorePeerAddress>,
      candidate,
      signal,
    ),
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
  return RandomSamplingRepairMethods.prototype.repairRandomSamplingKnowledgeAsset.call(
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
  it('assembles the extracted repair mixin onto the composed agent', async () => {
    // The prover binds `this.repairRandomSamplingKnowledgeAsset` from the
    // lifecycle mixin, so the extraction only holds while the composed class
    // still adopts this holder's implementations.
    const { DKGAgent } = await import('../src/dkg-agent.js');

    for (const method of ['repairRandomSamplingKnowledgeAsset', 'authenticateCorePeerAddress'] as const) {
      expect(DKGAgent.prototype[method], method)
        .toBe(RandomSamplingRepairMethods.prototype[method]);
      expect(LifecycleSyncMethods.prototype, method).not.toHaveProperty(method);
    }
  });

  it('forwards the exact peer binding and signal, and fails closed without proof', async () => {
    const ensurePeerAgentBinding = vi.fn(async () => true);
    const agentLike = makeRepairAgent({
      networkAdmissionCoordinator: { ensurePeerAgentBinding },
    });
    const authenticate = RandomSamplingRepairMethods.prototype.authenticateCorePeerAddress;
    const candidate = {
      peerId: 'peer-authenticated',
      nodeRole: 'core',
      agentAddress: '0x00000000000000000000000000000000000000bb',
    };
    const signal = new AbortController().signal;

    await expect(authenticate.call(
      agentLike as unknown as ThisParameterType<typeof authenticate>,
      candidate,
      signal,
    )).resolves.toBe(true);
    expect(ensurePeerAgentBinding).toHaveBeenCalledWith(
      candidate.peerId,
      candidate.agentAddress,
      expect.anything(),
      { signal },
    );

    await expect(authenticate.call(
      agentLike as unknown as ThisParameterType<typeof authenticate>,
      { peerId: 'peer-without-address', nodeRole: 'core' },
      signal,
    )).resolves.toBe(false);
    expect(ensurePeerAgentBinding).toHaveBeenCalledOnce();

    ensurePeerAgentBinding.mockRejectedValueOnce(new Error('identity protocol unavailable'));
    await expect(authenticate.call(
      agentLike as unknown as ThisParameterType<typeof authenticate>,
      candidate,
      signal,
    )).resolves.toBe(false);
  });

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

  it('treats a string that is not a peer ID as sync-unavailable without a peer-store lookup', async () => {
    const get = vi.fn(async () => ({ protocols: [PROTOCOL_SYNC] }));

    await expect(LifecycleSyncMethods.prototype.waitForSyncProtocol.call({
      node: { libp2p: { peerStore: { get } } },
    } as never, 'registry-entry-without-a-peer-id')).resolves.toBe(false);
    expect(get).not.toHaveBeenCalled();
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
    await expect(repair()).resolves.toEqual(proofMaterial);

    expect(syncExactKnowledgeAssetsFromPeerDetailed).toHaveBeenCalledTimes(peers.length);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(peers);
    expect(selectCatchupPeerWindow).toHaveBeenCalledOnce();
    for (const [, options] of selectCatchupPeerWindow.mock.calls) {
      expect(options).toEqual(expect.objectContaining({
        maxPeers: peers.length,
        peerRotationKey: 'rs-proof:food-safety',
      }));
    }
    expect(findAgents).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      limit: DKGAgentBase.VM_RECONCILE_EXACT_ROSTER_MAX,
      nodeRole: 'core',
    });
    const candidateMessage = vi.mocked(agentLike.log.info).mock.calls
      .map(([, message]) => message)
      .find((message) => message.includes('[rs.tick.kc-repair-candidates]'));
    expect(candidateMessage).toBeDefined();
    expect(JSON.parse(candidateMessage!.split('] ')[1]!)).toEqual({
      localContextGraphId: 'food-safety',
      curatorPeerIds: [curatorPeer],
      observedPeerIds: [],
      preferredPeerId: null,
      connectedPeerIds: [],
      corePeerIds: corePeers,
      candidatePeerIds: peers,
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

  it('attempts a known curator while Core authentication hangs, well inside the proof deadline', async () => {
    // Fake timers leave the repair's own 90s AbortSignal.timeout untouched, so
    // nothing but the Core lane's budget can release this repair: advancing by
    // that budget is the whole proof.
    vi.useFakeTimers();
    try {
      const authenticateCorePeerAddress = vi.fn(() => new Promise<boolean>(() => {}));
      const syncExactKnowledgeAssetsFromPeerDetailed = foundAt(['peer-curator']);
      const agentLike = makeRepairAgent({
        resolveCuratorPeerIdsForCg: vi.fn(async () => ({ peerIds: ['peer-curator'] })),
        discovery: {
          findAgents: vi.fn(async () => Array.from({ length: 64 }, (_, index) => ({
            peerId: `core-stale-${index}`,
            nodeRole: 'core',
            agentAddress: `0x${String(index).padStart(40, '0')}`,
          }))),
        },
        // Every stale profile's live identity handshake stays pending and
        // ignores the cancellation it is handed.
        authenticateCorePeerAddress,
        syncExactKnowledgeAssetsFromPeerDetailed,
      });

      const pending = runLifecycleRepair(agentLike);
      await vi.advanceTimersByTimeAsync(RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS);

      await expect(pending).resolves.toEqual(EMPTY_MATERIAL);
      expect(authenticateCorePeerAddress).toHaveBeenCalled();
      expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
        .toEqual(['peer-curator']);
      expect(RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS).toBeLessThan(90_000);
      expect(vi.mocked(agentLike.log.info).mock.calls.map(([, message]) => message))
        .toContainEqual('Random Sampling Core-roster discovery exceeded its '
          + `${RANDOM_SAMPLING_CORE_DISCOVERY_BUDGET_MS}ms budget for food-safety; `
          + 'continuing with graph-specific providers');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reaches a later Core in the same repair even when registry order is shuffled', async () => {
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

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);

    expect(DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX).toBe(3);
    expect(findAgents).toHaveBeenCalledOnce();
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

  it('offers already-connected peers as candidates without offering this node', async () => {
    const syncExactKnowledgeAssetsFromPeerDetailed = foundAt(['peer-connected']);
    const agentLike = makeRepairAgent({
      node: {
        stopSignal: undefined,
        libp2p: {
          getConnections: () => [
            { remotePeer: { toString: () => 'peer-connected' } },
            { remotePeer: { toString: () => 'self' } },
          ],
        },
      },
      syncExactKnowledgeAssetsFromPeerDetailed,
    });

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-connected']);
    const candidateMessage = vi.mocked(agentLike.log.info).mock.calls
      .map(([, message]) => message)
      .find((message) => message.includes('[rs.tick.kc-repair-candidates]'));
    expect(JSON.parse(candidateMessage!.split('] ')[1]!)).toMatchObject({
      connectedPeerIds: ['peer-connected', 'self'],
      candidatePeerIds: ['peer-connected'],
    });
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

  it('excludes self-declared Core profiles that lack current chain eligibility', async () => {
    const classifyShardingTableCore = vi.fn(async (address: string | undefined) => (
      address === '0x00000000000000000000000000000000000000aa'
        ? 'member' as const
        : 'non-member' as const
    ));
    const syncExactKnowledgeAssetsFromPeerDetailed = foundAt(['peer-eligible']);
    const agentLike = makeRepairAgent({
      discovery: {
        findAgents: vi.fn(async () => [
          {
            peerId: 'peer-unverified',
            nodeRole: 'core',
            agentAddress: '0x00000000000000000000000000000000000000bb',
          },
          {
            peerId: 'peer-eligible',
            nodeRole: 'core',
            agentAddress: '0x00000000000000000000000000000000000000aa',
          },
        ]),
      },
      classifyShardingTableCore,
      syncExactKnowledgeAssetsFromPeerDetailed,
    });

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);
    expect(classifyShardingTableCore).toHaveBeenCalledWith(
      '0x00000000000000000000000000000000000000bb',
    );
    expect(syncExactKnowledgeAssetsFromPeerDetailed.mock.calls.map(([peerId]) => peerId))
      .toEqual(['peer-eligible']);
  });

  it('excludes a staked address when the live peer cannot authenticate the binding', async () => {
    const classifyShardingTableCore = vi.fn(async () => 'member' as const);
    const ensurePeerAgentBinding = vi.fn(async (peerId: string) =>
      peerId === 'peer-authenticated');
    const agentLike = withProductionCorePeerAuthentication(makeRepairAgent({
      networkAdmissionCoordinator: { ensurePeerAgentBinding },
      discovery: {
        findAgents: vi.fn(async () => [
          {
            peerId: 'peer-borrowed-address',
            nodeRole: 'core',
            agentAddress: '0x00000000000000000000000000000000000000aa',
          },
          {
            peerId: 'peer-authenticated',
            nodeRole: 'core',
            agentAddress: '0x00000000000000000000000000000000000000bb',
          },
        ]),
      },
      classifyShardingTableCore,
      syncExactKnowledgeAssetsFromPeerDetailed: foundAt(['peer-authenticated']),
    }));

    await expect(runLifecycleRepair(agentLike)).resolves.toEqual(EMPTY_MATERIAL);
    expect(ensurePeerAgentBinding).toHaveBeenCalledTimes(2);
    expect(classifyShardingTableCore).toHaveBeenCalledOnce();
    expect(classifyShardingTableCore).toHaveBeenCalledWith(
      '0x00000000000000000000000000000000000000bb',
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
    const waitForSyncProtocol = vi.fn(async (peerId: string) => peerId !== 'peer-legacy');
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
      (RandomSamplingRepairMethods.prototype.repairRandomSamplingKnowledgeAsset as any).call(
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
