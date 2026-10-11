import { describe, expect, it, vi } from 'vitest';
import {
  enrichVmRecoveryFootprints,
  type VmRecoveryFootprintBridge,
  type VmRecoveryFootprintObservation,
  type VmRecoveryPreparedHints,
} from '../src/vm-recovery-footprint.js';
import type { VmRecoveryChainFootprint } from '../src/vm-recovery-types.js';

const goodContext = { merkleRootsCount: 2n, byteSize: 4_096n, merkleLeafCount: 12 };
const hint = (byteSize: bigint): VmRecoveryChainFootprint => ({
  kind: 'public-v10', byteSize, merkleLeafCount: 5n, assertionVersion: '9', anchor: { kind: 'latest-bounded' },
});

function bridge(overrides: Partial<VmRecoveryFootprintBridge> = {}): VmRecoveryFootprintBridge {
  return {
    resolvePublicAccess: async () => true,
    sizing: { readUpdateContext: async () => goodContext },
    ...overrides,
  };
}

const targets = (count: number) => Array.from({ length: count }, (_, index) => ({ kaId: String(index + 1) }));
const baseOptions = { maxContextReads: 10, isCurrent: () => true };

describe('VM recovery sizing with bounded in-order reads and prepared hints', () => {
  it('keeps every read concurrent from the start when no bound is requested', async () => {
    let active = 0;
    let maxActive = 0;
    const result = await enrichVmRecoveryFootprints(targets(6), 1n, bridge({
      sizing: { readUpdateContext: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return goodContext;
      } },
    }), baseOptions);
    expect(maxActive).toBe(6);
    expect(result.every((item) => item.recoveryFootprint.kind === 'public-v10')).toBe(true);
  });

  it('starts reads in candidate order under a bound and gives each read its own deadline', async () => {
    vi.useFakeTimers();
    try {
      const started: number[] = [];
      let active = 0;
      let maxActive = 0;
      // Each read takes 1.2 s: sequentially they would blow a shared 2.5 s budget,
      // but each read's own 2.5 s deadline starts when that read starts.
      const observed: VmRecoveryFootprintObservation[] = [];
      const pending = enrichVmRecoveryFootprints(targets(5), 1n, bridge({
        sizing: { readUpdateContext: async (kaId) => {
          started.push(Number(kaId));
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          active -= 1;
          return goodContext;
        } },
      }), { ...baseOptions, readConcurrency: 2, observe: (observation) => observed.push(observation) });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(started).toEqual([1, 2, 3, 4, 5]);
      expect(maxActive).toBe(2);
      expect(result.map((item) => item.recoveryFootprint.kind)).toEqual(Array(5).fill('public-v10'));
      expect(observed[0]).toMatchObject({ requested: 5, resolved: 5, timedOut: 0, prepared: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('without the bound, the same slow reads queue behind each other and later candidates time out', async () => {
    vi.useFakeTimers();
    try {
      let gate = 0;
      const observed: VmRecoveryFootprintObservation[] = [];
      const pending = enrichVmRecoveryFootprints(targets(5), 1n, bridge({
        // A governor admitting one request per 1.2 s, all queued at once.
        sizing: { readUpdateContext: async () => {
          const turn = gate;
          gate += 1;
          await new Promise((resolve) => setTimeout(resolve, 1_200 * (turn + 1)));
          return goodContext;
        } },
      }), { ...baseOptions, observe: (observation) => observed.push(observation) });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.map((item) => item.recoveryFootprint.kind)).toEqual(
        ['public-v10', 'public-v10', 'unknown', 'unknown', 'unknown'],
      );
      expect(observed[0]).toMatchObject({ resolved: 2, timedOut: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a prepared hint without a live read and counts it', async () => {
    const reads = vi.fn(async () => goodContext);
    const prepared: VmRecoveryPreparedHints = {
      take: vi.fn(async (kaId: string) => (kaId === '2' ? hint(777n) : undefined)),
    };
    const observed: VmRecoveryFootprintObservation[] = [];
    const result = await enrichVmRecoveryFootprints(targets(3), 1n,
      bridge({ sizing: { readUpdateContext: reads }, prepared }),
      { ...baseOptions, observe: (observation) => observed.push(observation) });
    expect(result[1]!.recoveryFootprint).toMatchObject({ byteSize: 777n });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(observed[0]).toMatchObject({ requested: 3, prepared: 1, resolved: 2 });
  });

  it.each([
    ['rejects', async () => { throw new Error('hint store failed'); }],
    ['returns an unknown footprint', async () => ({ kind: 'unknown' }) as VmRecoveryChainFootprint],
    ['returns a zero-sized footprint', async () => hint(0n)],
    ['returns a non-latest-bounded anchor', async () => ({
      ...hint(10n), anchor: { kind: 'pinned-finalized', blockHash: '0x' },
    }) as VmRecoveryChainFootprint],
  ])('treats a prepared hint that %s as a miss and reads live', async (_name, take) => {
    const reads = vi.fn(async () => goodContext);
    const result = await enrichVmRecoveryFootprints(targets(1), 1n,
      bridge({ sizing: { readUpdateContext: reads }, prepared: { take } }), baseOptions);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(result[0]!.recoveryFootprint).toMatchObject({ byteSize: 4_096n });
  });

  it('ignores prepared hints when there is no live reader, keeping the conservative unknown footprint', async () => {
    const take = vi.fn(async () => hint(10n));
    const result = await enrichVmRecoveryFootprints(targets(2), 1n,
      bridge({ sizing: null, prepared: { take } }), baseOptions);
    expect(take).not.toHaveBeenCalled();
    expect(result.every((item) => item.recoveryFootprint.kind === 'unknown')).toBe(true);
  });

  it('drops a prepared hint if the operation ended while it was being awaited', async () => {
    let current = true;
    const result = await enrichVmRecoveryFootprints(targets(1), 1n, bridge({
      prepared: { take: async () => { current = false; return hint(10n); } },
    }), { ...baseOptions, isCurrent: () => current });
    expect(result[0]!.recoveryFootprint.kind).toBe('unknown');
  });
});
