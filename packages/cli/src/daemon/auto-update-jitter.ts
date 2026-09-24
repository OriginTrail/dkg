/**
 * Auto-update rollout jitter.
 *
 * A commit landing on the tracked ref is detected by every node within one poll
 * interval, so without jitter the whole fleet builds + restarts in one narrow
 * window — a synchronized bootstrap storm (the trigger behind the 2026-07-10
 * beacon OOM incident, where all 4 cores auto-updated to 10.0.6 within ~6 min
 * and hit the O(store) sync fallback lane at once).
 *
 * Poll-phase jitter does NOT fix this: detection is bounded by the interval
 * regardless of phase. The effective lever is a per-node random HOLD-OFF
 * between *detecting* an available update and *applying* it (build + restart) —
 * a staggered rollout that spreads the fleet's restarts across the jitter
 * window so only a few nodes bootstrap at any moment.
 *
 * This module is the pure part: the jitter window and the random draw. The
 * per-target deadline policy (persisted across restarts) lives in
 * `auto-update-holdoff-deadline.ts`, and the rollout state machine, including
 * the wait, in `auto-update-holdoff-gate.ts`.
 *
 * Deterministic (rng injectable) so it is unit-tested without the daemon.
 */

export const UPDATE_JITTER_ENV = 'DKG_UPDATE_JITTER_MINUTES';

/** Upper sanity bound so a fat-fingered config can't stall updates for days. */
const MAX_JITTER_MINUTES = 12 * 60; // 12h

function parseNonNegativeMinutes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Resolve the rollout-jitter window in milliseconds.
 *
 * Precedence: env `DKG_UPDATE_JITTER_MINUTES` > resolved config
 * `updateJitterMinutes` > fallback = the poll interval (so the window
 * self-scales with cadence). `0` disables. Clamped to [0, 12h].
 */
export function resolveUpdateJitterMs(
  configuredMinutes: number | undefined,
  checkIntervalMinutes: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = parseNonNegativeMinutes(env[UPDATE_JITTER_ENV]);
  const fallback = Number.isFinite(checkIntervalMinutes) && checkIntervalMinutes > 0
    ? checkIntervalMinutes
    : 0;
  const chosen = fromEnv
    ?? (typeof configuredMinutes === 'number' && Number.isFinite(configuredMinutes) && configuredMinutes >= 0
      ? configuredMinutes
      : fallback);
  const clamped = Math.max(0, Math.min(chosen, MAX_JITTER_MINUTES));
  return Math.round(clamped * 60_000);
}

/**
 * A random hold-off in [0, jitterMs). Returns 0 when jitter is disabled or the
 * window is non-positive. `rng` returns a float in [0, 1) (defaults to
 * Math.random) and is injectable for deterministic tests.
 */
export function pickUpdateHoldoffMs(jitterMs: number, rng: () => number = Math.random): number {
  if (!(jitterMs > 0)) return 0;
  const r = rng();
  const safe = Number.isFinite(r) && r >= 0 && r < 1 ? r : 0;
  return Math.floor(safe * jitterMs);
}
