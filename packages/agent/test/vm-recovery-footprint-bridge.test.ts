import { describe, expect, it, vi } from 'vitest';
import {
  enrichVmRecoveryFootprints,
  type VmRecoveryChainFootprint,
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

describe('classic VM recovery footprint bridge', () => {
  it('reads public policy once and enriches at most the bounded ten-target prefix', async () => {
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
      {
        getContextGraphAccessPolicy: policy,
        getKnowledgeAssetUpdateContext: updateContext,
      },
      { maxContextReads: 10, isCurrent: () => true },
    );

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
      {
        getContextGraphAccessPolicy: async () => 1,
        getKnowledgeAssetUpdateContext: updateContext,
      },
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
      {
        getContextGraphAccessPolicy: async () => {
          controller.abort();
          return 0;
        },
        getKnowledgeAssetUpdateContext: updateContext,
      },
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
      {
        getContextGraphAccessPolicy: async () => 0,
        getKnowledgeAssetUpdateContext: updateContext,
      },
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
      {
        getContextGraphAccessPolicy: async () => 0,
        getKnowledgeAssetUpdateContext: updateContext,
      },
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(updateContext).toHaveBeenCalledTimes(1);
    expect(updateContext).toHaveBeenCalledWith(3n, undefined);
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
      {
        getContextGraphAccessPolicy: async () => 0,
        getKnowledgeAssetUpdateContext: async (kaId) => {
          if (kaId === 1n) throw new Error('rpc failed');
          return {
            merkleRootsCount: 1n,
            byteSize: kaId === 2n ? 0n : 1_000n,
            merkleLeafCount: kaId === 3n ? 0 : 10,
          };
        },
      },
      { maxContextReads: 10, isCurrent: () => true },
    );

    expect(enriched).toEqual(targets);
  });
});
