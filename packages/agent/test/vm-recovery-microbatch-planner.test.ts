/** Focused acceptance lane for byte-aware exact-VM microbatch planning. */
import { describe, expect, it } from 'vitest';
import { DKG_GOSSIP_MAX_MESSAGE_BYTES } from '@origintrail-official/dkg-core';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import {
  MAX_EXACT_SYNC_ASSETS,
  MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
  exactSyncPhaseAccumulationLimits,
} from '../src/sync/exact-assets.js';
import {
  planVmRecoveryMicrobatch,
  type VmRecoveryTargetFootprint,
  type VmRecoveryMicrobatchLimits,
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
});
