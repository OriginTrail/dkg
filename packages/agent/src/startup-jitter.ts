import { createHash } from 'node:crypto';

/** Stable across restarts, distinct across peers, and trivially testable. */
export function deterministicStartupJitterMs(seed: string, maxDelayMs: number): number {
  const max = Math.max(0, Math.floor(maxDelayMs));
  if (max === 0) return 0;
  const sample = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return Math.floor((sample / 0x1_0000_0000) * (max + 1));
}

/** Arm the recurring cadence only after the jittered startup run fires. */
export function scheduleAfterStartupJitter(
  run: () => void,
  startupDelayMs: number,
  intervalMs: number,
  onIntervalArmed: (timer: ReturnType<typeof setInterval>) => void,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    run();
    onIntervalArmed(setInterval(run, intervalMs));
  }, startupDelayMs);
}

/**
 * Default the VM reconcile startup-jitter window to its sweep cadence. An
 * explicit zero remains meaningful for operators who intentionally want an
 * immediate safety-net sweep.
 */
export function resolveVmReconcileStartupMaxDelayMs(
  configured: string | undefined,
  sweepIntervalMs: number,
): number {
  const fallback = Math.max(0, sweepIntervalMs);
  if (configured === undefined || configured.trim() === '') return fallback;
  const parsed = Number(configured);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}
