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
 * Pure + deterministic (rng injectable) so it is unit-tested without the daemon.
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

/**
 * A hold-off sleep whose timer is `unref`'d, so a pending rollout hold-off never
 * keeps the daemon process alive / blocks its exit during shutdown.
 */
function unrefSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export type UpdateHoldoffDecision = 'proceed' | 'abort-shutdown';

export interface AwaitUpdateHoldoffDeps {
  /** Resolved jitter window in ms (from `resolveUpdateJitterMs`). */
  jitterMs: number;
  /** True once the daemon has begun shutting down. */
  isShuttingDown: () => boolean;
  /** Invoked once, with the chosen hold-off ms, when a non-zero wait is about
   *  to start — lets the caller emit a mode-specific log line. */
  onHold?: (holdMs: number) => void;
  /** Injectable for deterministic tests. */
  rng?: () => number;
  /** Injectable for deterministic tests (default: an unref'd setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait out the per-node rollout hold-off, then report whether to proceed with
 * applying the update. Returns `'proceed'` after the (possibly zero) hold-off,
 * or `'abort-shutdown'` if the daemon began shutting down during the wait — in
 * which case the caller must NOT apply (the update is re-detected on next boot).
 *
 * The ordering (pick → optional log → sleep → re-check shutdown) is the exact
 * sequence both auto-update paths depend on; extracting it here makes the
 * shutdown-bail unit-testable rather than only eyeballed in the daemon loop.
 */
export async function awaitUpdateHoldoff(deps: AwaitUpdateHoldoffDeps): Promise<UpdateHoldoffDecision> {
  const holdMs = pickUpdateHoldoffMs(deps.jitterMs, deps.rng ?? Math.random);
  if (holdMs <= 0) return deps.isShuttingDown() ? 'abort-shutdown' : 'proceed';
  deps.onHold?.(holdMs);
  await (deps.sleep ?? unrefSleep)(holdMs);
  return deps.isShuttingDown() ? 'abort-shutdown' : 'proceed';
}
