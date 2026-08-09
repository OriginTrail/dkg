/**
 * Adversarial boundary tests for the classic reconciler's bounded sizing
 * bridge. The bridge may improve scheduling, but it must remain a soft hint:
 * private policy, malformed/latest reads, aborts, and missing capabilities all
 * retain the legacy unknown-footprint singleton behavior.
 */
import { describe, expect, it, vi } from 'vitest';
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
      isContextGraphActiveOnChain: async () => true,
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
    expect(contextReads.every(({ signal }) =>
      signal instanceof AbortSignal && signal !== controller.signal)).toBe(true);
    expect(enriched.slice(0, 10).every(({ recoveryFootprint }) =>
      recoveryFootprint?.kind === 'public-v10')).toBe(true);
    expect(enriched.slice(10).every(({ recoveryFootprint }) =>
      recoveryFootprint === undefined)).toBe(true);
  });

  it('does zero sizing reads for private CGs', async () => {
    let policyReads = 0;
    let contextReads = 0;
    const reader: VmRecoveryFootprintBridgeReader = {
      isContextGraphActiveOnChain: async () => true,
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
      isContextGraphActiveOnChain: async () => true,
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
      isContextGraphActiveOnChain: async () => true,
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
      isContextGraphActiveOnChain: async () => true,
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

    expect(contextReads).toHaveLength(1);
    expect(contextReads[0]!.kaId).toBe(0n);
    expect(contextReads[0]!.signal).not.toBe(controller.signal);
    expect(contextReads[0]!.signal?.aborted).toBe(true);
    expect(enriched).toEqual(targets);
    expect(enriched.every(({ recoveryFootprint }) =>
      recoveryFootprint === undefined)).toBe(true);
  });

  it('bounds a hung sizing read, aborts its child signal, and admits no late hint', async () => {
    vi.useFakeTimers();
    try {
      let sizingSignal: AbortSignal | undefined;
      let resolveLate: ((value: ReturnType<typeof publicContext>) => void) | undefined;
      const targets = [target(7)];
      const pending = enrichVmRecoveryFootprints(
        targets,
        222n,
        {
          isContextGraphActiveOnChain: async () => true,
          getContextGraphAccessPolicy: async () => 0,
          getKnowledgeAssetUpdateContext: async (_kaId, options) => {
            sizingSignal = options?.signal;
            return new Promise((resolve) => { resolveLate = resolve; });
          },
        },
        {
          maxContextReads: 10,
          sizingReadTimeoutMs: 25,
          isCurrent: () => true,
        },
      );
      let settled = false;
      void pending.finally(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(24);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const enriched = await pending;

      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(sizingSignal?.aborted).toBe(true);
      expect(enriched).toEqual(targets);
      resolveLate?.(publicContext(7n));
      await vi.runAllTicks();
      expect(enriched).toEqual(targets);
      expect(targets[0]!.recoveryFootprint).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects valid sizing data synchronously resolved by the deadline abort handler', async () => {
    vi.useFakeTimers();
    try {
      let deadlineAborts = 0;
      const targets = [target(8)];
      const pending = enrichVmRecoveryFootprints(
        targets,
        222n,
        {
          isContextGraphActiveOnChain: async () => true,
          getContextGraphAccessPolicy: async () => 0,
          getKnowledgeAssetUpdateContext: async (_kaId, options) =>
            new Promise((resolve) => {
              options?.signal?.addEventListener('abort', () => {
                deadlineAborts += 1;
                resolve(publicContext(8n));
              }, { once: true });
            }),
        },
        {
          maxContextReads: 10,
          sizingReadTimeoutMs: 25,
          isCurrent: () => true,
        },
      );

      await vi.advanceTimersByTimeAsync(25);
      const enriched = await pending;

      expect(deadlineAborts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(enriched).toEqual(targets);
      expect(enriched[0]!.recoveryFootprint).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('labels classic observations latest-bounded without fabricating a finalized anchor', async () => {
    const reader: VmRecoveryFootprintBridgeReader = {
      isContextGraphActiveOnChain: async () => true,
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

  it('proves positive-id liveness before consulting public policy or KA sizing', async () => {
    const calls: string[] = [];
    const reader: VmRecoveryFootprintBridgeReader = {
      isContextGraphActiveOnChain: async (contextGraphId) => {
        calls.push(`active:${contextGraphId}`);
        return true;
      },
      getContextGraphAccessPolicy: async (contextGraphId) => {
        calls.push(`policy:${contextGraphId}`);
        return 0;
      },
      getKnowledgeAssetUpdateContext: async (kaId) => {
        calls.push(`context:${kaId}`);
        return publicContext(kaId);
      },
    };

    const enriched = await enrichVmRecoveryFootprints([target(9)], 444n, reader, {
      maxContextReads: 10,
      isCurrent: () => true,
    });

    expect(calls).toEqual(['active:444', 'policy:444', 'context:9']);
    expect(enriched[0]!.recoveryFootprint?.kind).toBe('public-v10');
  });

  it.each([
    { label: 'zero id', contextGraphId: 0n, active: true },
    { label: 'negative id', contextGraphId: -1n, active: true },
    { label: 'inactive slot', contextGraphId: 5n, active: false },
  ])('does zero policy and sizing reads for $label', async ({ contextGraphId, active }) => {
    let livenessReads = 0;
    let policyReads = 0;
    let contextReads = 0;
    const reader: VmRecoveryFootprintBridgeReader = {
      isContextGraphActiveOnChain: async () => {
        livenessReads += 1;
        return active;
      },
      getContextGraphAccessPolicy: async () => {
        policyReads += 1;
        return 0;
      },
      getKnowledgeAssetUpdateContext: async () => {
        contextReads += 1;
        return publicContext(1n);
      },
    };
    const targets = [target(1)];

    const enriched = await enrichVmRecoveryFootprints(targets, contextGraphId, reader, {
      maxContextReads: 10,
      isCurrent: () => true,
    });

    expect(livenessReads).toBe(contextGraphId > 0n ? 1 : 0);
    expect(policyReads).toBe(0);
    expect(contextReads).toBe(0);
    expect(enriched).toEqual(targets);
  });

  it('fails closed when liveness is missing or rejects', async () => {
    for (const liveness of ['missing', 'rejects'] as const) {
      let policyReads = 0;
      let contextReads = 0;
      const reader: VmRecoveryFootprintBridgeReader = {
        ...(liveness === 'rejects'
          ? {
              isContextGraphActiveOnChain: async () => {
                throw new Error('liveness unavailable');
              },
            }
          : {}),
        getContextGraphAccessPolicy: async () => {
          policyReads += 1;
          return 0;
        },
        getKnowledgeAssetUpdateContext: async () => {
          contextReads += 1;
          return publicContext(1n);
        },
      };
      const targets = [target(1)];

      const enriched = await enrichVmRecoveryFootprints(targets, 5n, reader, {
        maxContextReads: 10,
        isCurrent: () => true,
      });

      expect(policyReads, liveness).toBe(0);
      expect(contextReads, liveness).toBe(0);
      expect(enriched, liveness).toEqual(targets);
    }
  });
});
