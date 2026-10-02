// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import {
  planVmRecoveryMicrobatch,
  type VmRecoveryTargetFootprint,
} from '../src/vm-recovery-microbatch.js';
import {
  planVmRecoveryStreamMicrobatch,
  VM_RECOVERY_STREAM_MAX_ASSET_ESTIMATED_BYTES,
  VM_RECOVERY_STREAM_MAX_ASSET_LEAVES,
  VM_RECOVERY_STREAM_MAX_START_BYTES,
  VM_RECOVERY_STREAM_MICROBATCH_LIMITS,
} from '../src/vm-recovery-stream-profile.js';

interface Target extends VmRecoveryTargetFootprint {
  readonly id: number;
}

function target(id: number, byteSize = 1_024n, merkleLeafCount = 8n): Target {
  return {
    id,
    recoveryFootprint: {
      kind: 'public-v10',
      byteSize,
      merkleLeafCount,
      assertionVersion: '1',
      anchor: { kind: 'latest-bounded' },
    },
  };
}

const selectorBytesFor = (targets: readonly Target[]): number => targets.length * 48;
const maxGraphFloorByteSize = VM_RECOVERY_STREAM_MAX_ASSET_ESTIMATED_BYTES
  - VM_RECOVERY_STREAM_MICROBATCH_LIMITS.fixedBytesPerAsset
  - VM_RECOVERY_STREAM_MAX_ASSET_LEAVES * VM_RECOVERY_STREAM_MICROBATCH_LIMITS.bytesPerLeafOverhead;

describe('fixed VM recovery stream profile', () => {
  it('fills the ten-asset window without consulting an eleventh footprint', () => {
    const firstTen = Array.from({ length: 10 }, (_, id) => target(id));
    const eleventh: Target = {
      id: 10,
      get recoveryFootprint(): never { throw new Error('past pilot count boundary'); },
    };
    const plan = planVmRecoveryStreamMicrobatch([...firstTen, eleventh], selectorBytesFor);

    expect(plan?.targets).toEqual(firstTen);
    expect(plan?.completeFootprints).toBe(true);
    expect(plan?.estimatedLeaves).toBe(80n);
  });

  it('accepts exact per-asset and aggregate byte/leaf boundaries', () => {
    const candidates = Array.from({ length: 11 }, (_, id) =>
      target(id, maxGraphFloorByteSize, VM_RECOVERY_STREAM_MAX_ASSET_LEAVES));
    const plan = planVmRecoveryStreamMicrobatch(candidates, () => 4_096);

    expect(plan?.targets).toEqual(candidates.slice(0, 10));
    expect(plan?.estimatedBytes).toBe(80n * 1024n * 1024n);
    expect(plan?.estimatedLeaves).toBe(163_840n);
    expect(plan?.selectorBytes).toBe(4_096);
  });

  it.each([
    ['one estimated byte over', maxGraphFloorByteSize + 1n, VM_RECOVERY_STREAM_MAX_ASSET_LEAVES],
    ['one leaf over', 1n, VM_RECOVERY_STREAM_MAX_ASSET_LEAVES + 1n],
    ['raw bytes fit but overhead does not', VM_RECOVERY_STREAM_MAX_ASSET_ESTIMATED_BYTES, 1n],
    ['zero bytes', 0n, 1n],
    ['zero leaves', 1n, 0n],
    ['negative bytes', -1n, 1n],
    ['negative leaves', 1n, -1n],
    ['huge bigint bytes', 1n << 512n, 1n],
    ['huge bigint leaves', 1n, 1n << 512n],
  ] as const)('keeps %s on the legacy path without skipping it', (_label, byteSize, leaves) => {
    const invalid = target(1, byteSize, leaves);
    const first = target(0);
    const later = target(2);
    expect(planVmRecoveryStreamMicrobatch([invalid, later], selectorBytesFor)).toBeUndefined();
    expect(planVmRecoveryStreamMicrobatch([first, invalid, later], selectorBytesFor)?.targets)
      .toEqual([first]);
  });

  it.each([
    { label: 'unknown', recoveryFootprint: { kind: 'unknown' } },
    { label: 'missing', recoveryFootprint: undefined },
    { label: 'null', recoveryFootprint: null },
    { label: 'number bytes', recoveryFootprint: { kind: 'public-v10', byteSize: 1_024, merkleLeafCount: 8n } },
    { label: 'string leaves', recoveryFootprint: { kind: 'public-v10', byteSize: 1_024n, merkleLeafCount: '8' } },
    { label: 'missing leaves', recoveryFootprint: { kind: 'public-v10', byteSize: 1_024n } },
  ])('does not promote $label sizing', ({ recoveryFootprint }) => {
    const invalid = { id: 1, recoveryFootprint } as unknown as Target;
    const bytesFor = vi.fn(selectorBytesFor);
    expect(planVmRecoveryStreamMicrobatch([invalid, target(2)], bytesFor)).toBeUndefined();
    expect(bytesFor).not.toHaveBeenCalled();
    expect(planVmRecoveryStreamMicrobatch([target(0), invalid, target(2)], bytesFor)?.targets)
      .toEqual([target(0)]);
  });

  it('uses the same conservative estimator and rounding as the legacy planner', () => {
    const candidates = [target(0, 100_001n, 1n), target(1, 1_024n, 500n)];
    const plan = planVmRecoveryStreamMicrobatch(candidates, selectorBytesFor);
    expect(plan).toEqual(planVmRecoveryMicrobatch(
      candidates, VM_RECOVERY_STREAM_MICROBATCH_LIMITS, selectorBytesFor,
    ));
    expect(plan?.estimatedBytes).toBe(180_538n + 130_560n);

    const scaledByteBoundary = (
      VM_RECOVERY_STREAM_MAX_ASSET_ESTIMATED_BYTES
      - VM_RECOVERY_STREAM_MICROBATCH_LIMITS.fixedBytesPerAsset
    ) * 10_000n / VM_RECOVERY_STREAM_MICROBATCH_LIMITS.byteSizeMultiplierBps;
    expect(planVmRecoveryStreamMicrobatch([target(2, scaledByteBoundary, 1n)], selectorBytesFor))
      .toBeDefined();
    expect(planVmRecoveryStreamMicrobatch([target(2, scaledByteBoundary + 1n, 1n)], selectorBytesFor))
      .toBeUndefined();
  });

  it('stops at the selector boundary and preserves the eligible prefix order', () => {
    const candidates = [target(3), target(1), target(2)];
    const plan = planVmRecoveryStreamMicrobatch(candidates, (items) =>
      items.length < 3 ? 4_096 : 4_097);
    expect(plan?.targets).toEqual(candidates.slice(0, 2));
    expect(plan?.targets[0]).toBe(candidates[0]);
    expect(plan?.selectorBytes).toBe(4_096);
    expect(planVmRecoveryStreamMicrobatch(candidates, () => 4_097)).toBeUndefined();
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid encoded selector size: %s',
    (bytes) => {
      expect(planVmRecoveryStreamMicrobatch([target(0)], () => bytes)).toBeUndefined();
      expect(planVmRecoveryStreamMicrobatch([target(0), target(1)], (items) =>
        items.length === 1 ? 48 : bytes)?.targets).toEqual([target(0)]);
    },
  );

  it('reserves START overhead through fixed, frozen configuration', () => {
    expect(Object.isFrozen(VM_RECOVERY_STREAM_MICROBATCH_LIMITS)).toBe(true);
    expect(VM_RECOVERY_STREAM_MICROBATCH_LIMITS.maxSelectorBytes).toBe(4_096);
    expect(VM_RECOVERY_STREAM_MAX_START_BYTES).toBe(8_192);
    expect(Reflect.set(VM_RECOVERY_STREAM_MICROBATCH_LIMITS, 'maxAssets', 100)).toBe(false);
    expect(Reflect.set(VM_RECOVERY_STREAM_MICROBATCH_LIMITS, 'targetBytes', 1n << 512n)).toBe(false);
    const unrelatedRecoveryConfig = { ...VM_RECOVERY_STREAM_MICROBATCH_LIMITS, maxAssets: 100 };
    unrelatedRecoveryConfig.targetBytes = 1n << 512n;
    const candidates = Array.from({ length: unrelatedRecoveryConfig.maxAssets }, (_, id) => target(id));
    expect(planVmRecoveryStreamMicrobatch(candidates, selectorBytesFor)?.targets).toHaveLength(10);
  });

  it('returns no stream plan for empty work and preserves immutable candidate inputs', () => {
    const bytesFor = vi.fn(selectorBytesFor);
    expect(planVmRecoveryStreamMicrobatch([], bytesFor)).toBeUndefined();
    expect(bytesFor).not.toHaveBeenCalled();
    const candidates = Object.freeze([Object.freeze(target(4)), Object.freeze(target(1))]);
    expect(planVmRecoveryStreamMicrobatch(candidates, bytesFor)?.targets).toEqual(candidates);
    expect(candidates.map(({ id }) => id)).toEqual([4, 1]);
  });
});
