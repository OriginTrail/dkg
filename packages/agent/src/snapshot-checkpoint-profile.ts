// SPDX-License-Identifier: Apache-2.0
import { availableParallelism, totalmem } from 'node:os';

/** Fixed experimental profile. Stage-specific space calculations remain with their owners. */
export const CHECKPOINT_PROFILE = Object.freeze({
  diskReserveBytes: 7 * 2 ** 30, minimumMemoryBytes: 4 * 2 ** 30,
  maxPlainBytes: 8 * 2 ** 30, maxEncodedBytes: 2 ** 30,
  maxAssets: 100_000, jobTimeoutMs: 3_600_000,
});
export function assertCheckpointMemory(): void {
  if (Math.min(totalmem(), process.constrainedMemory() || Infinity) < CHECKPOINT_PROFILE.minimumMemoryBytes)
    throw new Error('Native bootstrap requires a 4 GiB memory allowance; use incremental recovery');
}
export function checkpointJavaArguments(): string[] {
  return ['-Xms256m', '-Xmx3g', `-XX:ActiveProcessorCount=${Math.min(4, availableParallelism())}`];
}
