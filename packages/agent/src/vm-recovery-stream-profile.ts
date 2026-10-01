// SPDX-License-Identifier: Apache-2.0
import {
  estimateVmRecoveryAssetBytes,
  planVmRecoveryMicrobatch,
  type VmRecoveryMicrobatchLimits,
  type VmRecoveryMicrobatchPlan,
  type VmRecoveryTargetFootprint,
} from './vm-recovery-microbatch.js';

export const VM_RECOVERY_STREAM_MAX_ASSET_ESTIMATED_BYTES = 8n * 1024n * 1024n;
export const VM_RECOVERY_STREAM_MAX_ASSET_LEAVES = 16_384n;
/** The executor still checks the actual encoded, signed START request. */
export const VM_RECOVERY_STREAM_MAX_START_BYTES = 8 * 1024;

/** Fixed pilot profile; ordinary recovery configuration cannot widen it. */
export const VM_RECOVERY_STREAM_MICROBATCH_LIMITS: Readonly<VmRecoveryMicrobatchLimits> = Object.freeze({
  maxAssets: 10,
  targetBytes: 80n * 1024n * 1024n,
  targetLeaves: 163_840n,
  fixedBytesPerAsset: 64n * 1024n,
  bytesPerLeafOverhead: 128n,
  byteSizeMultiplierBps: 11_500n,
  // Reserve half of START for request fields, authentication and encoding.
  maxSelectorBytes: VM_RECOVERY_STREAM_MAX_START_BYTES / 2,
});

function isStreamSizedTarget(candidate: VmRecoveryTargetFootprint): boolean {
  const footprint = candidate.recoveryFootprint;
  if (footprint?.kind !== 'public-v10') return false;
  const { byteSize, merkleLeafCount } = footprint;
  if (
    typeof byteSize !== 'bigint'
    || typeof merkleLeafCount !== 'bigint'
    || byteSize <= 0n
    || merkleLeafCount <= 0n
    || byteSize > VM_RECOVERY_STREAM_MAX_ASSET_ESTIMATED_BYTES
    || merkleLeafCount > VM_RECOVERY_STREAM_MAX_ASSET_LEAVES
  ) return false;

  const estimatedBytes = estimateVmRecoveryAssetBytes(
    byteSize,
    merkleLeafCount,
    VM_RECOVERY_STREAM_MICROBATCH_LIMITS,
  );
  return estimatedBytes <= VM_RECOVERY_STREAM_MAX_ASSET_ESTIMATED_BYTES;
}

/**
 * Select only a stable prefix with complete, nonzero public-v10 sizing hints.
 * Unknown or oversize work stays on the existing legacy singleton path; it
 * must never be skipped to stream a later asset. The caller separately proves
 * opt-in, current Core capability and public authority. This is sizing only.
 */
export function planVmRecoveryStreamMicrobatch<T extends VmRecoveryTargetFootprint>(
  candidates: readonly T[],
  selectorBytesFor: (targets: readonly T[]) => number,
): VmRecoveryMicrobatchPlan<T> | undefined {
  const eligible: T[] = [];
  for (const candidate of candidates) {
    if (eligible.length >= VM_RECOVERY_STREAM_MICROBATCH_LIMITS.maxAssets) break;
    if (!isStreamSizedTarget(candidate)) break;
    eligible.push(candidate);
  }
  if (eligible.length === 0) return undefined;
  const plan = planVmRecoveryMicrobatch(
    eligible,
    VM_RECOVERY_STREAM_MICROBATCH_LIMITS,
    selectorBytesFor,
  );
  return plan.targets.length > 0 ? plan : undefined;
}
