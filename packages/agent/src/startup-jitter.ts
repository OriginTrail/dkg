import { createHash } from 'node:crypto';

/** Stable across restarts, distinct across peers, and trivially testable. */
export function deterministicStartupJitterMs(seed: string, maxDelayMs: number): number {
  const max = Math.max(0, Math.floor(maxDelayMs));
  if (max === 0) return 0;
  const sample = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return Math.floor((sample / 0x1_0000_0000) * (max + 1));
}
