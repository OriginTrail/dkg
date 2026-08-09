/**
 * Adversarial boundary tests for the classic reconciler's bounded sizing
 * bridge. The bridge may improve scheduling, but it must remain a soft hint:
 * private policy, malformed/latest reads, aborts, and missing capabilities all
 * retain the legacy unknown-footprint singleton behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  enrichVmRecoveryFootprints,
  planVmRecoveryMicrobatch,
  type VmRecoveryChainFootprint,
  type VmRecoveryFootprintBridgeReader,
  type VmRecoveryMicrobatchLimits,
} from '../src/vm-recovery-microbatch.js';

interface BridgeTarget {
  readonly kaId: string;
  readonly recoveryFootprint?: VmRecoveryChainFootprint;
}

const LIMITS: VmRecoveryMicrobatchLimits = {
  maxAssets: 10,
  targetBytes: 32n * 1024n * 1024n,
  targetLeaves: 100_000n,
  fixedBytesPerAsset: 0n,
  bytesPerLeafOverhead: 0n,
  byteSizeMultiplierBps: 10_000n,
  maxSelectorBytes: 16 * 1024,
};

function target(kaId: number, recoveryFootprint?: VmRecoveryChainFootprint): BridgeTarget {
  return {
    kaId: String(kaId),
    ...(recoveryFootprint ? { recoveryFootprint } : {}),
  };
}

function publicContext(kaId: bigint) {
  return {
    merkleRootsCount: kaId + 1n,
    byteSize: (kaId + 1n) * 1_024n,
    merkleLeafCount: Number(kaId + 1n) * 8,
  };
}

function asPlannable(input: readonly BridgeTarget[]) {
  return input.map((item) => ({
    ...item,
    recoveryFootprint: item.recoveryFootprint ?? { kind: 'unknown' as const },
  }));
}

describe('classic VM recovery footprint bridge — adversarial boundaries', () => {
  it('reads public policy once and caps abortable update-context reads at ten per slice', async () => {
    const controller = new AbortController();
    const policyReads: bigint[] = [];
    const contextReads: Array<{ kaId: bigint; signal: AbortSignal | undefined }> = [];
    const reader: VmRecoveryFootprintBridgeReader = {
      getContextGraphAccessPolicy: async (contextGraphId) => {
        policyReads.push(contextGraphId);
        return 0;
      },
      getKnowledgeAssetUpdateContext: async (kaId, options) => {
        contextReads.push({ kaId, signal: options?.signal });
        return publicContext(kaId);
      },
    };
    const targets = Array.from({ length: 25 }, (_, kaId) => target(kaId));

    const enriched = await enrichVmRecoveryFootprints(targets, 77n, reader, {
      maxContextReads: 10,
      signal: controller.signal,
      isCurrent: () => true,
    });

    expect(policyReads).toEqual([77n]);
    expect(contextReads.map(({ kaId }) => kaId)).toEqual(
      Array.from({ length: 10 }, (_, kaId) => BigInt(kaId)),
    );
    expect(contextReads.every(({ signal }) => signal === controller.signal)).toBe(true);
    expect(enriched.slice(0, 10).every(({ recoveryFootprint }) =>
      recoveryFootprint?.kind === 'public-v10')).toBe(true);
    expect(enriched.slice(10).every(({ recoveryFootprint }) =>
      recoveryFootprint === undefined)).toBe(true);
  });

  it('does zero sizing reads for private CGs', async () => {
    let policyReads = 0;
    let contextReads = 0;
    const reader: VmRecoveryFootprintBridgeReader = {
      getContextGraphAccessPolicy: async () => {
        policyReads += 1;
        return 1;
      },
      getKnowledgeAssetUpdateContext: async () => {
        contextReads += 1;
        throw new Error('private/catalog byte size must never be consulted');
      },
    };
    const targets = [target(1), target(2)];

    const enriched = await enrichVmRecoveryFootprints(targets, 88n, reader, {
      maxContextReads: 10,
      isCurrent: () => true,
    });

    expect(policyReads).toBe(1);
    expect(contextReads).toBe(0);
    expect(enriched).toEqual(targets);
  });

  it('does not reread a prepopulated pinned footprint', async () => {
    const pinned: VmRecoveryChainFootprint = {
      kind: 'public-v10',
      byteSize: 4_096n,
      merkleLeafCount: 32n,
      assertionVersion: '3',
      anchor: { kind: 'pinned-finalized', blockHash: '0x1234' },
    };
    const contextReads: bigint[] = [];
    const reader: VmRecoveryFootprintBridgeReader = {
      getContextGraphAccessPolicy: async () => 0,
      getKnowledgeAssetUpdateContext: async (kaId) => {
        contextReads.push(kaId);
        return publicContext(kaId);
      },
    };
    const targets = [target(1, pinned), target(2), target(3, pinned)];

    const enriched = await enrichVmRecoveryFootprints(targets, 99n, reader, {
      maxContextReads: 10,
      isCurrent: () => true,
    });

    expect(contextReads).toEqual([2n]);
    expect(enriched[0]).toBe(targets[0]);
    expect(enriched[0]!.recoveryFootprint).toBe(pinned);
    expect(enriched[2]).toBe(targets[2]);
    expect(enriched[2]!.recoveryFootprint).toBe(pinned);
    expect(enriched[1]!.recoveryFootprint?.kind).toBe('public-v10');
  });

  it('keeps zero, malformed, and failed reads unknown and therefore singleton', async () => {
    const reader: VmRecoveryFootprintBridgeReader = {
      getContextGraphAccessPolicy: async () => 0,
      getKnowledgeAssetUpdateContext: async (kaId) => {
        if (kaId === 0n) return { ...publicContext(kaId), byteSize: 0n };
        if (kaId === 1n) {
          return { ...publicContext(kaId), merkleLeafCount: Number.NaN };
        }
        if (kaId === 2n) throw new Error('bounded RPC failure');
        return publicContext(kaId);
      },
    };
    const targets = [target(0), target(1), target(2), target(3), target(4)];

    const enriched = await enrichVmRecoveryFootprints(targets, 111n, reader, {
      maxContextReads: 10,
      isCurrent: () => true,
    });

    for (const index of [0, 1, 2]) {
      expect(enriched[index]!.recoveryFootprint).toBeUndefined();
      const plan = planVmRecoveryMicrobatch(
        asPlannable([enriched[index]!, enriched[3]!]),
        LIMITS,
        (planned) => planned.length * 48,
      );
      expect(plan.targets.map(({ kaId }) => kaId)).toEqual([String(index)]);
      expect(plan.completeFootprints).toBe(false);
    }
    expect(enriched[3]!.recoveryFootprint?.kind).toBe('public-v10');
    expect(enriched[4]!.recoveryFootprint?.kind).toBe('public-v10');
  });

  it('invalidates the whole observation on abort and leaks no partial hint', async () => {
    const controller = new AbortController();
    const contextReads: Array<{ kaId: bigint; signal: AbortSignal | undefined }> = [];
    const reader: VmRecoveryFootprintBridgeReader = {
      getContextGraphAccessPolicy: async () => 0,
      getKnowledgeAssetUpdateContext: async (kaId, options) => {
        contextReads.push({ kaId, signal: options?.signal });
        controller.abort();
        return publicContext(kaId);
      },
    };
    const targets = [target(0), target(1), target(2)];

    const enriched = await enrichVmRecoveryFootprints(targets, 222n, reader, {
      maxContextReads: 10,
      signal: controller.signal,
      isCurrent: () => true,
    });

    expect(contextReads).toEqual([{ kaId: 0n, signal: controller.signal }]);
    expect(enriched).toEqual(targets);
    expect(enriched.every(({ recoveryFootprint }) =>
      recoveryFootprint === undefined)).toBe(true);
  });

  it('labels classic observations latest-bounded without fabricating a finalized anchor', async () => {
    const reader: VmRecoveryFootprintBridgeReader = {
      getContextGraphAccessPolicy: async () => 0,
      getKnowledgeAssetUpdateContext: async () => ({
        merkleRootsCount: 7n,
        byteSize: 12_345n,
        merkleLeafCount: 99,
      }),
    };

    const [enriched] = await enrichVmRecoveryFootprints([target(7)], 333n, reader, {
      maxContextReads: 10,
      isCurrent: () => true,
    });

    expect(enriched!.recoveryFootprint).toEqual({
      kind: 'public-v10',
      byteSize: 12_345n,
      merkleLeafCount: 99n,
      assertionVersion: '7',
      anchor: { kind: 'latest-bounded' },
    });
    const anchor = enriched!.recoveryFootprint?.kind === 'public-v10'
      ? enriched.recoveryFootprint.anchor
      : undefined;
    expect(anchor).toEqual({ kind: 'latest-bounded' });
    expect(anchor && Object.hasOwn(anchor, 'blockHash')).toBe(false);
  });
});
