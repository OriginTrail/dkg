/**
 * Adversarial acceptance lane for byte-aware exact-VM microbatch recovery.
 *
 * This file intentionally lives outside the large core-fills-gap suite so the
 * planner and host integration can be reviewed and executed independently.
 * The production contract expected by these tests is:
 *
 *   planVmRecoveryMicrobatch(candidates, limits)
 *     -> one deterministic, stable-prefix, byte/leaf bounded plan
 *
 * The host must use that plan only after a single exact request proves a
 * holder. Every requested UAL is then revalidated independently; aggregate
 * transport success must never turn an unresolved member into clean absence
 * or a successful VM reconciliation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_GOSSIP_MAX_MESSAGE_BYTES } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import type { PendingOrdinalRecoveryResult } from '../src/chain-reconciler.js';
import {
  MAX_EXACT_SYNC_ASSETS,
  MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
  exactSyncPhaseAccumulationLimits,
} from '../src/sync/exact-assets.js';
import {
  planVmRecoveryMicrobatch,
  VmRecoveryProviderPolicy,
  type VmRecoveryChainFootprint,
  type VmRecoveryTargetFootprint,
  type VmRecoveryMicrobatchLimits,
  type VmRecoveryUalDisposition,
} from '../src/vm-recovery-microbatch.js';

interface SizedTarget extends VmRecoveryTargetFootprint {
  readonly id: number;
}

function sizedTarget(
  id: number,
  byteSize?: bigint,
  merkleLeafCount?: bigint,
): SizedTarget {
  return {
    id,
    recoveryFootprint: byteSize === undefined || merkleLeafCount === undefined
      ? { kind: 'unknown' }
      : {
          kind: 'public-v10',
          byteSize,
          merkleLeafCount,
          assertionVersion: '1',
          anchor: { kind: 'pinned-finalized', blockHash: '0x01' },
        },
  };
}

const selectorBytesFor = (targets: readonly SizedTarget[]): number =>
  targets.length * 48;

function dispositions(
  ...entries: Array<readonly [string, VmRecoveryUalDisposition]>
): ReadonlyMap<string, VmRecoveryUalDisposition> {
  return new Map(entries);
}

const MICRO_LIMITS: VmRecoveryMicrobatchLimits = {
  maxAssets: MAX_EXACT_SYNC_ASSETS,
  targetBytes: 32n * 1024n * 1024n,
  targetLeaves: 100_000n,
  fixedBytesPerAsset: 0n,
  bytesPerLeafOverhead: 0n,
  byteSizeMultiplierBps: 10_000n,
  maxSelectorBytes: 64 * 1024,
};

// Production exact data pages contain at most 64 rows. This soft planner
// budget therefore keeps a microbatch near 64 non-empty data pages.
const EXACT_PAGE_FAIRNESS_LEAVES = 4_096n;

function planAll(
  targets: readonly SizedTarget[],
  limits: VmRecoveryMicrobatchLimits,
): SizedTarget[][] {
  const batches: SizedTarget[][] = [];
  let remaining = [...targets];
  while (remaining.length > 0) {
    const plan = planVmRecoveryMicrobatch(remaining, limits, selectorBytesFor);
    expect(plan.targets.length).toBeGreaterThan(0);
    batches.push([...plan.targets]);
    remaining = remaining.slice(plan.targets.length);
  }
  return batches;
}

describe('VM recovery microbatch planner — adversarial boundaries', () => {
  it('collapses many small assets into the largest wire-bounded multi-UAL call', () => {
    const targets = Array.from({ length: 40 }, (_, id) => sizedTarget(id, 1_024n, 8n));
    const plan = planVmRecoveryMicrobatch(targets, {
      ...MICRO_LIMITS,
      // The current request executor advertises ten here. A future streaming
      // executor can advertise a larger capability without changing packing.
      maxAssets: MAX_EXACT_SYNC_ASSETS,
    }, selectorBytesFor);

    // 10 is the current additive exact-sync compatibility ceiling, not the
    // scheduling policy. The planner must fill that advertised capability for
    // small assets instead of falling back to one request per KA.
    expect(plan.targets.map(({ id }) => id)).toEqual(
      Array.from({ length: MAX_EXACT_SYNC_ASSETS }, (_, id) => id),
    );
    expect(plan.estimatedBytes).toBe(BigInt(MAX_EXACT_SYNC_ASSETS) * 1_024n);
    expect(plan.estimatedLeaves).toBe(BigInt(MAX_EXACT_SYNC_ASSETS) * 8n);
    expect(plan.completeFootprints).toBe(true);
  });

  it('packs ten 100-triple KAs up to the executor asset-count cap', () => {
    const targets = Array.from({ length: 20 }, (_, id) => sizedTarget(id, 8_192n, 100n));
    const plan = planVmRecoveryMicrobatch(targets, {
      ...MICRO_LIMITS,
      targetLeaves: EXACT_PAGE_FAIRNESS_LEAVES,
    }, selectorBytesFor);

    expect(plan.targets.map(({ id }) => id)).toEqual(
      Array.from({ length: MAX_EXACT_SYNC_ASSETS }, (_, id) => id),
    );
    expect(plan.estimatedLeaves).toBe(1_000n);
  });

  it('caps 500-triple KAs at eight before exceeding the 4,096-leaf window', () => {
    const targets = Array.from({ length: 10 }, (_, id) => sizedTarget(id, 32_768n, 500n));
    const plan = planVmRecoveryMicrobatch(targets, {
      ...MICRO_LIMITS,
      targetLeaves: EXACT_PAGE_FAIRNESS_LEAVES,
    }, selectorBytesFor);

    expect(plan.targets.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, id) => id),
    );
    expect(plan.estimatedLeaves).toBe(4_000n);
  });

  it('admits a KA over the 4,096-leaf fairness window only as a singleton', () => {
    const targets = [
      sizedTarget(0, 512_000n, 5_000n),
      sizedTarget(1, 8_192n, 100n),
      sizedTarget(2, 8_192n, 100n),
    ];
    const limits = {
      ...MICRO_LIMITS,
      targetLeaves: EXACT_PAGE_FAIRNESS_LEAVES,
    };

    expect(planAll(targets, limits).map((batch) => batch.map(({ id }) => id)))
      .toEqual([[0], [1, 2]]);
    expect(planVmRecoveryMicrobatch(targets, limits, selectorBytesFor)).toMatchObject({
      targets: [targets[0]],
      estimatedLeaves: 5_000n,
      completeFootprints: true,
    });
  });

  it('splits mixed sizes deterministically by stable prefix, bytes, and leaves', () => {
    const targets = [
      sizedTarget(0, 3n, 2n),
      sizedTarget(1, 5n, 3n),
      sizedTarget(2, 1n, 1n),
      sizedTarget(3, 7n, 4n),
      sizedTarget(4, 4n, 8n),
    ];
    const limits = { ...MICRO_LIMITS, targetBytes: 8n, targetLeaves: 9n };

    const first = planAll(targets, limits).map((batch) => batch.map(({ id }) => id));
    const replay = planAll(targets, limits).map((batch) => batch.map(({ id }) => id));

    expect(first).toEqual([[0, 1], [2, 3], [4]]);
    expect(replay).toEqual(first);
  });

  it('admits one oversized asset alone without starving the following assets', () => {
    const targets = [
      sizedTarget(0, 64n * 1024n * 1024n, 500_000n),
      sizedTarget(1, 1_024n, 8n),
      sizedTarget(2, 2_048n, 16n),
    ];
    const limits = {
      ...MICRO_LIMITS,
      targetBytes: 32n * 1024n * 1024n,
      targetLeaves: 100_000n,
    };

    const batches = planAll(targets, limits);

    expect(batches.map((batch) => batch.map(({ id }) => id))).toEqual([[0], [1, 2]]);
    expect(planVmRecoveryMicrobatch(targets, limits, selectorBytesFor)).toMatchObject({
      estimatedBytes: 64n * 1024n * 1024n,
      estimatedLeaves: 500_000n,
      completeFootprints: true,
    });
  });

  it('fails safe to a singleton when a footprint is unknown', () => {
    const unknownFirst = [sizedTarget(0), sizedTarget(1, 1_024n, 8n)];
    const unknownAfterKnown = [sizedTarget(2, 1_024n, 8n), sizedTarget(3)];
    const limits = {
      ...MICRO_LIMITS,
      targetBytes: 32n * 1024n,
      targetLeaves: 1_000n,
    };

    expect(planVmRecoveryMicrobatch(unknownFirst, limits, selectorBytesFor)).toMatchObject({
      targets: [unknownFirst[0]],
      completeFootprints: false,
    });
    expect(planVmRecoveryMicrobatch(unknownAfterKnown, limits, selectorBytesFor)).toMatchObject({
      targets: [unknownAfterKnown[0]],
      completeFootprints: true,
    });
  });

  it('rejects even a singleton when its encoded selector exceeds the executor cap', () => {
    const target = sizedTarget(0, 1_024n, 8n);
    const plan = planVmRecoveryMicrobatch(
      [target],
      { ...MICRO_LIMITS, maxSelectorBytes: 47 },
      selectorBytesFor,
    );

    expect(plan.targets).toEqual([]);
    expect(plan.selectorBytes).toBe(0);
  });

  it('is stateless and deterministic when restart resumes after a durable checkpoint', () => {
    const targets = Array.from({ length: 7 }, (_, id) => sizedTarget(id, 4n, 2n));
    const limits = { ...MICRO_LIMITS, maxAssets: 3, targetBytes: 12n, targetLeaves: 6n };
    const beforeRestart = planVmRecoveryMicrobatch(targets, limits, selectorBytesFor);
    const checkpointedIds = new Set(beforeRestart.targets.map(({ id }) => id));
    const remaining = targets.filter(({ id }) => !checkpointedIds.has(id));

    const afterRestart = planAll(remaining, limits).map((batch) =>
      batch.map(({ id }) => id));

    expect(beforeRestart.targets.map(({ id }) => id)).toEqual([0, 1, 2]);
    expect(afterRestart).toEqual([[3, 4, 5], [6]]);
    expect(planAll(remaining, limits).map((batch) => batch.map(({ id }) => id)))
      .toEqual(afterRestart);
  });

  it('does not widen the existing exact-sync, frame, peer, or scheduler bounds', () => {
    const before = {
      peerMax: DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
      concurrency: DKGAgentBase.VM_RECONCILE_CONCURRENCY,
      queueMaxPending: DKGAgentBase.VM_RECONCILE_QUEUE_MAX_PENDING,
    };
    const targets = Array.from({ length: 500 }, (_, id) => sizedTarget(id, 1n, 1n));
    const plan = planVmRecoveryMicrobatch(targets, {
      ...MICRO_LIMITS,
      maxAssets: MAX_EXACT_SYNC_ASSETS,
      targetBytes: BigInt(Number.MAX_SAFE_INTEGER),
      targetLeaves: BigInt(Number.MAX_SAFE_INTEGER),
    }, selectorBytesFor);
    const uals = Array.from(
      { length: plan.targets.length },
      (_, id) => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${id}`,
    );

    expect(plan.targets).toHaveLength(MAX_EXACT_SYNC_ASSETS);
    expect(MAX_EXACT_SYNC_ASSETS).toBe(10);
    expect(MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET).toBe(DKG_GOSSIP_MAX_MESSAGE_BYTES);
    expect(exactSyncPhaseAccumulationLimits(uals).maxBytes)
      .toBe(uals.length * DKG_GOSSIP_MAX_MESSAGE_BYTES);
    expect({
      peerMax: DKGAgentBase.VM_RECONCILE_EXACT_PEER_MAX,
      concurrency: DKGAgentBase.VM_RECONCILE_CONCURRENCY,
      queueMaxPending: DKGAgentBase.VM_RECONCILE_QUEUE_MAX_PENDING,
    }).toEqual(before);
  });

  it('revokes provider affinity on partial or incomplete per-UAL outcomes', () => {
    const peerId = '12D3KooWPolicyHolder';
    const policy = new VmRecoveryProviderPolicy();
    policy.recordAttempt(peerId);
    policy.recordBatch(peerId, 'found', dispositions(['ual-0', 'found']));
    expect(policy.isProvenHolder(peerId)).toBe(true);
    expect(policy.canAttempt(peerId)).toBe(true);

    policy.recordBatch(peerId, 'found', dispositions(
      ['ual-1', 'found'],
      ['ual-2', 'incomplete'],
    ));

    expect(policy.ualDisposition(peerId, 'ual-1')).toBe('found');
    expect(policy.ualDisposition(peerId, 'ual-2')).toBe('incomplete');
    expect(policy.isProvenHolder(peerId)).toBe(false);
    expect(policy.canAttempt(peerId)).toBe(false);

    const nextSweep = new VmRecoveryProviderPolicy();
    expect(nextSweep.isProvenHolder(peerId)).toBe(false);
    expect(nextSweep.canAttempt(peerId)).toBe(true);
  });

  it('revokes provider affinity when the aggregate response is incomplete', () => {
    const peerId = '12D3KooWAggregateIncomplete';
    const policy = new VmRecoveryProviderPolicy();
    policy.recordAttempt(peerId);
    policy.recordBatch(peerId, 'found', dispositions(['ual-0', 'found']));
    expect(policy.isProvenHolder(peerId)).toBe(true);

    policy.recordBatch(peerId, 'incomplete', dispositions(
      ['ual-1', 'found'],
      ['ual-2', 'found'],
    ));

    expect(policy.isProvenHolder(peerId)).toBe(false);
    expect(policy.canAttempt(peerId)).toBe(false);
  });
});

interface RecoveryTarget {
  readonly localCgId: string;
  readonly onChainCgId: string;
  readonly ordinal: number;
  readonly ual: string;
  readonly merkleRoot: string;
  readonly kaId: string;
  readonly reason: 'no-swm';
  readonly recoveryFootprint: VmRecoveryChainFootprint;
}

interface RecoveryInternals {
  preferredSyncPeers: Map<string, string>;
  recoverVmReconcileBatch(
    localCgId: string,
    onChainCgId: bigint,
    targets: readonly RecoveryTarget[],
    headBlock: number | undefined,
    isTargetCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<PendingOrdinalRecoveryResult>;
}

function recoveryTarget(
  localCgId: string,
  ordinal: number,
  footprint?: Readonly<{ byteSize: bigint; merkleLeafCount: bigint }>,
): RecoveryTarget {
  return {
    localCgId,
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    merkleRoot: `root-${ordinal}`,
    kaId: String(ordinal),
    reason: 'no-swm',
    recoveryFootprint: {
      kind: 'public-v10',
      byteSize: footprint?.byteSize ?? 1_024n,
      merkleLeafCount: footprint?.merkleLeafCount ?? 8n,
      assertionVersion: '1',
      anchor: { kind: 'pinned-finalized', blockHash: '0x01' },
    },
  };
}

interface ExactFetch {
  readonly peerId: string;
  readonly uals: readonly string[];
}

async function createRecoveryHarness(options: {
  name: string;
  localCgId: string;
  peers: readonly string[];
  targetCount: number;
  footprintForOrdinal?: (
    ordinal: number,
  ) => Readonly<{ byteSize: bigint; merkleLeafCount: bigint }>;
  onFetch: (
    peerId: string,
    targets: readonly RecoveryTarget[],
    recovered: Set<number>,
    signal?: AbortSignal,
  ) => 'found' | 'clean-absent' | 'incomplete';
}) {
  const chainAdapter = new MockChainAdapter();
  const { contextGraphId } = await chainAdapter.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 1,
  });
  if (contextGraphId !== 1n) {
    throw new Error(`unexpected mock context graph id ${contextGraphId}`);
  }
  const agent = await DKGAgent.create({
    name: options.name,
    chainAdapter,
  });
  const internals = agent as unknown as RecoveryInternals & Record<string, any>;
  const connected = options.peers.map((peerId) => ({ toString: () => peerId }));
  internals.node = {
    peerId: `12D3KooW${options.name}Local`,
    libp2p: { getConnections: () => connected.map((remotePeer) => ({ remotePeer })) },
  };
  internals.preferredSyncPeers.set(options.localCgId, options.peers[0]!);
  internals.resolveCuratorPeerIdsForCg = async () => ({
    peerIds: [...options.peers],
    curatorIsLocal: false,
    legacyTripleResolved: false,
  });
  internals.ensurePeerConnected = async () => undefined;
  internals.selectCatchupPeers = (peers: Array<{ toString(): string }>) => peers;
  internals.waitForSyncProtocol = async () => true;
  internals.ensurePeerAdmittedForRecovery = async () => true;

  const targets = Array.from(
    { length: options.targetCount },
    (_, ordinal) => recoveryTarget(
      options.localCgId,
      ordinal,
      options.footprintForOrdinal?.(ordinal),
    ),
  );
  const targetsByUal = new Map(targets.map((target) => [target.ual, target]));
  const fetched: ExactFetch[] = [];
  const recovered = new Set<number>();
  let activeFetches = 0;
  let maxActiveFetches = 0;

  internals.readVmReconcileRecoveryFootprint = async () => ({
    byteSize: 1_024n,
    merkleLeafCount: 8n,
  });
  internals.syncExactKnowledgeAssetsFromPeerDetailed = async (
    peerId: string,
    _contextGraphId: string,
    uals: string[],
    requestOptions?: { signal?: AbortSignal },
  ) => {
    activeFetches += 1;
    maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
    const requested = uals.map((ual) => {
      const target = targetsByUal.get(ual);
      if (!target) throw new Error(`unexpected UAL ${ual}`);
      return target;
    });
    fetched.push({ peerId, uals: [...uals] });
    const disposition = options.onFetch(
      peerId,
      requested,
      recovered,
      requestOptions?.signal,
    );
    activeFetches -= 1;
    return {
      result: {
        fetchedDataTriples: disposition === 'found' ? requested.length : 0,
        fetchedMetaTriples: disposition === 'found' ? requested.length * 8 : 0,
        insertedTriples: disposition === 'found' ? requested.length * 9 : 0,
        failedPeers: disposition === 'incomplete' ? 1 : 0,
        failedPhases: 0,
        deferredBackpressure: 0,
      },
      disposition,
    };
  };
  internals.reconcileChainOrdinal = async (
    _localCgId: string,
    _onChainCgId: bigint,
    ordinal: number,
  ) => recovered.has(ordinal)
    ? { status: 'reconciled', blockNumber: 100 }
    : { status: 'pending', recovery: targets[ordinal] };

  return {
    agent,
    chainAdapter,
    contextGraphId,
    internals,
    targets,
    fetched,
    recovered,
    maxActiveFetches: () => maxActiveFetches,
  };
}

describe('VM recovery microbatch host — adversarial integration', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) =>
      agent.stop().catch(() => undefined)));
  });

  it('uses one proven-holder microbatch and independently revalidates every UAL', async () => {
    const holder = '12D3KooWMicrobatchAHolder';
    const fallback = '12D3KooWMicrobatchZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/many-small';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchManySmall',
      localCgId,
      peers: [holder, fallback],
      targetCount: 8,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(result.attemptedOrdinals).toEqual(harness.targets.map(({ ordinal }) => ordinal));
    expect([...result.outcomes.values()]).toEqual(
      harness.targets.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
    expect(harness.maxActiveFetches()).toBe(1);
  });

  it('enriches unknown targets through the production host before batching', async () => {
    const holder = '12D3KooWBridgeAHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/host-bridge';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchHostBridge',
      localCgId,
      peers: [holder],
      targetCount: 8,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);
    for (const target of harness.targets) {
      const kaId = BigInt(target.kaId);
      harness.chainAdapter.__registerKC({
        kaId,
        contextGraphId: harness.contextGraphId,
        merkleRootHex: `0x${(kaId + 1n).toString(16).padStart(64, '0')}`,
        chunks: [],
        byteSize: 1_024n,
        merkleLeafCount: 8,
      });
    }

    // Count the production host's reads without replacing the adapter
    // implementations: liveness, policy, and sizing all come from the actual
    // in-memory ContextGraph/KA state seeded above.
    const liveness = vi.spyOn(harness.chainAdapter, 'isContextGraphActiveOnChain');
    const policy = vi.spyOn(harness.chainAdapter, 'getContextGraphAccessPolicy');
    const updateContext = vi.spyOn(harness.chainAdapter, 'getKnowledgeAssetUpdateContext');
    const unknownTargets: RecoveryTarget[] = harness.targets.map((target) => ({
      ...target,
      recoveryFootprint: { kind: 'unknown' },
    }));

    await harness.internals.recoverVmReconcileBatch(
      localCgId,
      1n,
      unknownTargets,
      100,
      () => true,
    );

    expect(liveness).toHaveBeenCalledTimes(1);
    expect(liveness).toHaveBeenCalledWith(1n);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith(1n);
    expect(updateContext).toHaveBeenCalledTimes(8);
    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [unknownTargets[0]!.ual] },
      { peerId: holder, uals: unknownTargets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(harness.fetched[1]!.uals.length).toBeGreaterThan(1);
  });

  it('requests ten 100-triple KAs as one probe followed by one nine-asset batch', async () => {
    const holder = '12D3KooWExactCountSmallHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-count-small';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchExactCountSmall',
      localCgId,
      peers: [holder],
      targetCount: 10,
      footprintForOrdinal: () => ({ byteSize: 8_192n, merkleLeafCount: 100n }),
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched.map(({ uals }) => uals.length)).toEqual([1, 9]);
    expect(result.attemptedOrdinals).toEqual(harness.targets.map(({ ordinal }) => ordinal));
  });

  it('requests ten 500-triple KAs as one probe, eight assets, then one asset', async () => {
    const holder = '12D3KooWExactCountMediumHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-count-medium';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchExactCountMedium',
      localCgId,
      peers: [holder],
      targetCount: 10,
      footprintForOrdinal: () => ({ byteSize: 32_768n, merkleLeafCount: 500n }),
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched.map(({ uals }) => uals.length)).toEqual([1, 8, 1]);
    expect(result.attemptedOrdinals).toEqual(harness.targets.map(({ ordinal }) => ordinal));
  });

  it('commits found members but rotates unresolved members without false absence', async () => {
    const holder = '12D3KooWPartialAHolder';
    const fallback = '12D3KooWPartialZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/partial';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchPartialCoverage',
      localCgId,
      peers: [holder, fallback],
      targetCount: 6,
      onFetch: (peerId, requested, recovered) => {
        if (peerId === holder) {
          for (const target of requested) {
            if (target.ordinal <= 2) recovered.add(target.ordinal);
          }
          // Aggregate transfer success is intentionally insufficient evidence
          // that every requested UAL was present.
          return 'found';
        }
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const first = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(first.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(first.outcomes.get(1)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(first.outcomes.get(2)).toEqual({ status: 'reconciled', blockNumber: 100 });
    for (const ordinal of [3, 4, 5]) {
      expect(first.outcomes.get(ordinal)).toMatchObject({ status: 'pending' });
    }

    // A later bounded sweep supplies only the still-pending set. Rotation
    // evidence retained by #2183 selects the next provider; recovered members
    // are neither re-requested nor falsely credited as absent.
    const unresolved = harness.targets.slice(3);
    const second = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, unresolved, 100, () => true,
    );

    expect(harness.fetched.slice(2)).toEqual([
      { peerId: fallback, uals: [unresolved[0]!.ual] },
      { peerId: fallback, uals: unresolved.slice(1).map(({ ual }) => ual) },
    ]);
    expect(second.attemptedOrdinals).toEqual(unresolved.map(({ ordinal }) => ordinal));
    expect([...second.outcomes.values()]).toEqual(
      unresolved.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
  });

  it('revokes a proven-holder hint after an incomplete microbatch response', async () => {
    const holder = '12D3KooWIncompleteAHolder';
    const fallback = '12D3KooWIncompleteZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/incomplete';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchIncompleteRevocation',
      localCgId,
      peers: [holder, fallback],
      targetCount: 5,
      onFetch: (peerId, requested, recovered) => {
        if (peerId === holder && requested.length === 1 && requested[0]!.ordinal === 0) {
          recovered.add(0);
          return 'found';
        }
        if (peerId === holder) return 'incomplete';
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const first = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(first.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    for (const ordinal of [1, 2, 3, 4]) {
      expect(first.outcomes.get(ordinal)).toMatchObject({ status: 'pending' });
    }

    const unresolved = harness.targets.slice(1);
    const second = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, unresolved, 100, () => true,
    );

    // The old successful probe must not leave a stale holder preference after
    // the multi-UAL request becomes incomplete. The next sweep starts with the
    // unresolved set at the fallback and can establish a new local hint there.
    expect(harness.fetched.slice(2)).toEqual([
      { peerId: fallback, uals: [unresolved[0]!.ual] },
      { peerId: fallback, uals: unresolved.slice(1).map(({ ual }) => ual) },
    ]);
    expect(second.attemptedOrdinals).toEqual(unresolved.map(({ ordinal }) => ordinal));
    expect([...second.outcomes.values()]).toEqual(
      unresolved.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
  });

  it('stops after lifecycle abort without installing outcomes or starting another batch', async () => {
    const controller = new AbortController();
    const localCgId = '0x0000000000000000000000000000000000000001/abort';
    let reconcileCalls = 0;
    const harness = await createRecoveryHarness({
      name: 'MicrobatchAbort',
      localCgId,
      peers: ['12D3KooWMicrobatchAbortHolder'],
      targetCount: 5,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        controller.abort();
        return 'found';
      },
    });
    agents.push(harness.agent);
    harness.internals.reconcileChainOrdinal = async () => {
      reconcileCalls += 1;
      return { status: 'reconciled', blockNumber: 100 };
    };

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId,
      1n,
      harness.targets,
      100,
      () => true,
      controller.signal,
    );

    expect(harness.fetched).toEqual([
      { peerId: '12D3KooWMicrobatchAbortHolder', uals: [harness.targets[0]!.ual] },
    ]);
    expect(reconcileCalls).toBe(0);
    expect(result.outcomes.size).toBe(0);
    expect(result.attemptedOrdinals).toEqual([]);
    expect(result.hasImmediateRecoveryWork).toBe(false);
  });
});
