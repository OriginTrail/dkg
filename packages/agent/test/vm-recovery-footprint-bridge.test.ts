import { describe, expect, it, vi } from 'vitest';
import {
  enrichVmRecoveryFootprints,
  type VmRecoveryChainFootprint,
  type VmRecoveryFootprintBridge,
  type VmRecoveryUpdateContext,
} from '../src/vm-recovery-microbatch.js';

interface Target {
  readonly kaId: string;
  readonly recoveryFootprint?: VmRecoveryChainFootprint;
}

const unknownTarget = (kaId: number): Target => ({
  kaId: String(kaId),
  recoveryFootprint: { kind: 'unknown' },
});

const pinnedTarget = (kaId: number): Target => ({
  kaId: String(kaId),
  recoveryFootprint: {
    kind: 'public-v10',
    byteSize: 123n,
    merkleLeafCount: 4n,
    assertionVersion: '7',
    anchor: { kind: 'pinned-finalized', blockHash: '0x1234' },
  },
});

function chainBridge(reader: {
  isContextGraphActiveOnChain: (contextGraphId: bigint) => Promise<boolean>;
  getContextGraphAccessPolicy: (contextGraphId: bigint) => Promise<number>;
  getKnowledgeAssetUpdateContext?: (
    kaId: bigint,
    options?: { signal?: AbortSignal },
  ) => Promise<VmRecoveryUpdateContext>;
}): VmRecoveryFootprintBridge {
  return {
    authority: {
      kind: 'chain-reader',
      isContextGraphActive: reader.isContextGraphActiveOnChain,
      readAccessPolicy: reader.getContextGraphAccessPolicy,
    },
    sizing: reader.getKnowledgeAssetUpdateContext
      ? { readUpdateContext: reader.getKnowledgeAssetUpdateContext }
      : null,
  };
}

function hostBridge(
  resolveAccessPolicy: (contextGraphId: bigint) => Promise<0 | 1 | null>,
  readUpdateContext?: (
    kaId: bigint,
    options?: { signal?: AbortSignal },
  ) => Promise<VmRecoveryUpdateContext>,
): VmRecoveryFootprintBridge {
  return {
    authority: { kind: 'host-policy', resolveAccessPolicy },
    sizing: readUpdateContext ? { readUpdateContext } : null,
  };
}

describe('classic VM recovery footprint bridge', () => {
  it('reads public policy once and enriches at most the bounded ten-target prefix', async () => {
    const liveness = vi.fn(async () => true);
    const policy = vi.fn(async () => 0);
    const updateContext = vi.fn(async (kaId: bigint) => ({
      merkleRootsCount: kaId + 1n,
      minted: 0n,
      byteSize: kaId * 1_000n,
      endEpoch: 0n,
      tokenAmount: 0n,
      isImmutable: false,
      merkleLeafCount: Number(kaId) * 10,
    }));
    const targets = Array.from({ length: 12 }, (_, index) => unknownTarget(index + 1));

    const enriched = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: liveness,
        getContextGraphAccessPolicy: policy,
        getKnowledgeAssetUpdateContext: updateContext,
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(liveness).toHaveBeenCalledTimes(1);
    expect(liveness).toHaveBeenCalledWith(14n);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith(14n);
    expect(updateContext).toHaveBeenCalledTimes(10);
    expect(enriched.slice(0, 10).every(
      ({ recoveryFootprint }) => recoveryFootprint?.kind === 'public-v10',
    )).toBe(true);
    expect(enriched.slice(10).map(({ recoveryFootprint }) => recoveryFootprint)).toEqual([
      { kind: 'unknown' },
      { kind: 'unknown' },
    ]);
    const first = enriched[0]!.recoveryFootprint;
    expect(first).toMatchObject({
      kind: 'public-v10',
      assertionVersion: '2',
      anchor: { kind: 'latest-bounded' },
    });
    expect(first).not.toHaveProperty('finalizedBlockHash');
    expect(first).not.toHaveProperty('anchor.blockHash');
  });

  it('does not read KA sizing for a private CG', async () => {
    const updateContext = vi.fn();
    const targets = [unknownTarget(1), unknownTarget(2)];

    const enriched = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => 1,
        getKnowledgeAssetUpdateContext: updateContext,
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(updateContext).not.toHaveBeenCalled();
    expect(enriched).toEqual(targets);
  });

  it('stops before context reads when the operation aborts during policy resolution', async () => {
    const controller = new AbortController();
    const updateContext = vi.fn();

    const enriched = await enrichVmRecoveryFootprints(
      [unknownTarget(1)],
      14n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => {
          controller.abort();
          return 0;
        },
        getKnowledgeAssetUpdateContext: updateContext,
      }),
      { maxContextReads: 10, signal: controller.signal, isCurrent: () => true },
    );

    expect(updateContext).not.toHaveBeenCalled();
    expect(enriched).toEqual([unknownTarget(1)]);
  });

  it('drops the whole latest-state observation when its lifecycle becomes stale', async () => {
    let current = true;
    const updateContext = vi.fn(async () => {
      current = false;
      return {
        merkleRootsCount: 1n,
        byteSize: 1_000n,
        merkleLeafCount: 10,
      };
    });
    const targets = [unknownTarget(1), unknownTarget(2)];

    const enriched = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => 0,
        getKnowledgeAssetUpdateContext: updateContext,
      }),
      { maxContextReads: 10, isCurrent: () => current },
    );

    expect(enriched).toEqual(targets);
  });

  it('preserves pre-populated footprints and never issues duplicate sizing reads', async () => {
    const latest: Target = {
      kaId: '2',
      recoveryFootprint: {
        kind: 'public-v10',
        byteSize: 456n,
        merkleLeafCount: 8n,
        assertionVersion: '3',
        anchor: { kind: 'latest-bounded' },
      },
    };
    const updateContext = vi.fn(async () => ({
      merkleRootsCount: 1n,
      byteSize: 1_000n,
      merkleLeafCount: 10,
    }));
    const targets = [pinnedTarget(1), latest, unknownTarget(3)];

    const enriched = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => 0,
        getKnowledgeAssetUpdateContext: updateContext,
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(updateContext).toHaveBeenCalledTimes(1);
    expect(updateContext).toHaveBeenCalledWith(3n, {
      signal: expect.any(AbortSignal),
    });
    expect(enriched[0]).toBe(targets[0]);
    expect(enriched[1]).toBe(targets[1]);
    expect(enriched[2]!.recoveryFootprint).toMatchObject({
      kind: 'public-v10',
      anchor: { kind: 'latest-bounded' },
    });
  });

  it('keeps failed and zero scalar observations unknown', async () => {
    const targets = [unknownTarget(1), unknownTarget(2), unknownTarget(3)];
    const enriched = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => 0,
        getKnowledgeAssetUpdateContext: async (kaId) => {
          if (kaId === 1n) throw new Error('rpc failed');
          return {
            merkleRootsCount: 1n,
            byteSize: kaId === 2n ? 0n : 1_000n,
            merkleLeafCount: kaId === 3n ? 0 : 10,
          };
        },
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(enriched).toEqual(targets);
  });

  it.each([
    ['inactive', async () => false],
    ['liveness-error', async () => { throw new Error('liveness unavailable'); }],
  ])('does not read policy or sizing for an %s CG', async (_label, readActive) => {
    const policy = vi.fn(async () => 0);
    const updateContext = vi.fn();
    const targets = [unknownTarget(1)];

    const enriched = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: readActive,
        getContextGraphAccessPolicy: policy,
        getKnowledgeAssetUpdateContext: updateContext,
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(policy).not.toHaveBeenCalled();
    expect(updateContext).not.toHaveBeenCalled();
    expect(enriched).toEqual(targets);
  });

  it('represents unavailable sizing explicitly and fails closed for a non-positive CG id', async () => {
    const policy = vi.fn(async () => 0);
    const updateContext = vi.fn();
    const targets = [unknownTarget(1)];

    const unavailableSizing = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: policy,
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );
    const invalidId = await enrichVmRecoveryFootprints(
      targets,
      0n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: policy,
        getKnowledgeAssetUpdateContext: updateContext,
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(policy).toHaveBeenCalledTimes(1);
    expect(updateContext).not.toHaveBeenCalled();
    expect(unavailableSizing).toEqual(targets);
    expect(invalidId).toEqual(targets);
  });

  it('accepts a bounded host trust anchor without rereading raw liveness or policy', async () => {
    const resolveLiveAccessPolicy = vi.fn(async () => 0 as const);
    const rawLiveness = vi.fn();
    const rawPolicy = vi.fn();
    const enriched = await enrichVmRecoveryFootprints(
      [unknownTarget(1)],
      14n,
      hostBridge(resolveLiveAccessPolicy, async () => ({
          merkleRootsCount: 2n,
          byteSize: 1_000n,
          merkleLeafCount: 10,
      })),
      {
        maxContextReads: 10,
        isCurrent: () => true,
      },
    );

    expect(resolveLiveAccessPolicy).toHaveBeenCalledOnce();
    expect(resolveLiveAccessPolicy).toHaveBeenCalledWith(14n);
    expect(rawLiveness).not.toHaveBeenCalled();
    expect(rawPolicy).not.toHaveBeenCalled();
    expect(enriched[0]!.recoveryFootprint).toMatchObject({ kind: 'public-v10' });
  });

  it('returns unknown immediately when a caller aborts a hung authority read', async () => {
    const controller = new AbortController();
    const updateContext = vi.fn();
    const targets = [unknownTarget(1)];
    const pending = enrichVmRecoveryFootprints(
      targets,
      14n,
      hostBridge(
        () => new Promise<0 | 1 | null>(() => undefined),
        updateContext,
      ),
      {
        maxContextReads: 10,
        signal: controller.signal,
        isCurrent: () => true,
      },
    );

    controller.abort();
    await expect(pending).resolves.toEqual(targets);
    expect(updateContext).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'inactive',
      bridge: chainBridge({
        isContextGraphActiveOnChain: async () => false,
        getContextGraphAccessPolicy: async () => 0,
      }),
    },
    {
      label: 'private',
      bridge: chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => 1,
      }),
    },
    {
      label: 'unavailable host authority',
      bridge: hostBridge(async () => null),
    },
    {
      label: 'bounded authority timeout',
      bridge: hostBridge(async () => null),
    },
  ])('downgrades pre-populated public hints when authority is $label', async ({
    bridge,
  }) => {
    const targets = [pinnedTarget(1)];

    const [result] = await enrichVmRecoveryFootprints(targets, 14n, bridge, {
      maxContextReads: 10,
      isCurrent: () => true,
    });

    expect(result).not.toBe(targets[0]);
    expect(result!.recoveryFootprint).toEqual({ kind: 'unknown' });
  });

  it('preserves proven-public pre-populated hints without a sizing capability', async () => {
    const latest: Target = {
      kaId: '2',
      recoveryFootprint: {
        kind: 'public-v10',
        byteSize: 456n,
        merkleLeafCount: 8n,
        assertionVersion: '3',
        anchor: { kind: 'latest-bounded' },
      },
    };
    const targets = [pinnedTarget(1), latest];

    const enriched = await enrichVmRecoveryFootprints(
      targets,
      14n,
      chainBridge({
        isContextGraphActiveOnChain: async () => true,
        getContextGraphAccessPolicy: async () => 0,
      }),
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(enriched[0]).toBe(targets[0]);
    expect(enriched[1]).toBe(targets[1]);
  });
});
