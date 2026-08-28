import type { VmRecoveryChainFootprint } from './vm-recovery-types.js';

export interface VmRecoveryTargetFootprint {
  readonly recoveryFootprint: VmRecoveryChainFootprint;
}

export interface VmRecoveryMicrobatchLimits {
  maxAssets: number;
  targetBytes: bigint;
  targetLeaves: bigint;
  fixedBytesPerAsset: bigint;
  bytesPerLeafOverhead: bigint;
  byteSizeMultiplierBps: bigint;
  maxSelectorBytes: number;
}

export interface VmRecoveryMicrobatchPlan<T> {
  readonly targets: readonly T[];
  readonly estimatedBytes: bigint;
  readonly estimatedLeaves: bigint;
  readonly selectorBytes: number;
  readonly completeFootprints: boolean;
}

function nonNegativeFiniteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeBigint(value: unknown): bigint | undefined {
  return typeof value === 'bigint' && value >= 0n ? value : undefined;
}

/**
 * Pack one stable exact-recovery prefix. Unknown footprints remain singleton;
 * soft byte/leaf targets never reject an individually large KA, while executor
 * asset-count and encoded-selector caps remain hard.
 */
export function planVmRecoveryMicrobatch<T extends VmRecoveryTargetFootprint>(
  candidates: readonly T[],
  limits: Readonly<VmRecoveryMicrobatchLimits>,
  selectorBytesFor: (targets: readonly T[]) => number,
): VmRecoveryMicrobatchPlan<T> {
  if (
    !Number.isSafeInteger(limits.maxAssets)
    || limits.maxAssets <= 0
    || limits.targetBytes < 0n
    || limits.targetLeaves < 0n
    || limits.fixedBytesPerAsset < 0n
    || limits.bytesPerLeafOverhead < 0n
    || limits.byteSizeMultiplierBps < 10_000n
    || !Number.isSafeInteger(limits.maxSelectorBytes)
    || limits.maxSelectorBytes <= 0
  ) throw new Error('Invalid VM recovery microbatch limits');

  const targets: T[] = [];
  let estimatedBytes = 0n;
  let estimatedLeaves = 0n;
  let selectorBytes = 0;
  let completeFootprints = true;
  for (const candidate of candidates) {
    if (targets.length >= limits.maxAssets) break;
    const footprint = candidate.recoveryFootprint;
    const byteSize = footprint.kind === 'public-v10'
      ? nonNegativeBigint(footprint.byteSize)
      : undefined;
    const merkleLeafCount = footprint.kind === 'public-v10'
      ? nonNegativeBigint(footprint.merkleLeafCount)
      : undefined;
    const footprintComplete = byteSize !== undefined && merkleLeafCount !== undefined;
    const candidateTargets = [...targets, candidate];
    const nextSelectorBytes = nonNegativeFiniteInteger(selectorBytesFor(candidateTargets));
    if (nextSelectorBytes === undefined || nextSelectorBytes > limits.maxSelectorBytes) break;
    if (
      byteSize === undefined
      || merkleLeafCount === undefined
      || byteSize === 0n
      || merkleLeafCount === 0n
    ) {
      if (targets.length === 0) {
        targets.push(candidate);
        selectorBytes = nextSelectorBytes;
        completeFootprints = footprintComplete;
      }
      break;
    }

    const scaledByteFloor = (byteSize * limits.byteSizeMultiplierBps + 9_999n) / 10_000n;
    const graphAndLeafFloor = byteSize + merkleLeafCount * limits.bytesPerLeafOverhead;
    const candidateEstimatedBytes = (
      scaledByteFloor > graphAndLeafFloor ? scaledByteFloor : graphAndLeafFloor
    ) + limits.fixedBytesPerAsset;
    const nextBytes = estimatedBytes + candidateEstimatedBytes;
    const nextLeaves = estimatedLeaves + merkleLeafCount;
    if (targets.length > 0 && (
      nextBytes > limits.targetBytes || nextLeaves > limits.targetLeaves
    )) break;

    targets.push(candidate);
    estimatedBytes = nextBytes;
    estimatedLeaves = nextLeaves;
    selectorBytes = nextSelectorBytes;
    completeFootprints &&= footprintComplete;
  }
  return {
    targets,
    estimatedBytes,
    estimatedLeaves,
    selectorBytes,
    completeFootprints,
  };
}
