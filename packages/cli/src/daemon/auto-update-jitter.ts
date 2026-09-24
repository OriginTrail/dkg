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
 * The hold-off DEADLINE is persisted per target (see {@link UpdateHoldoffStore};
 * the file-backed store lives in `auto-update-holdoff-store.ts`),
 * so a node that restarts during its hold resumes the remaining wait instead of
 * drawing a fresh one. Without that, a node restarting more often than its hold
 * never reached the deadline: every boot redrew a hold in [0, jitter) and the
 * restart aborted it again, so the update was never applied.
 *
 * Deterministic (rng, clock and store injectable) so it is unit-tested without the daemon.
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

/**
 * A persisted deadline this far in the past is stale and redrawn rather than
 * honoured. Such a record means the node stopped polling for a day (auto-update
 * disabled, or the node was down). Applying at once would let a fleet that comes
 * back together restart together, so the node draws a fresh hold instead.
 */
export const MAX_HOLDOFF_OVERDUE_MS = 24 * 60 * 60_000;

/** The per-node rollout deadline for one detected target (git commit or npm version). */
export interface UpdateHoldoffRecord {
  target: string;
  deadlineEpochMs: number;
}

/**
 * Where the gate keeps the {@link UpdateHoldoffRecord} across restarts.
 * `read` returns null when there is no record and throws when one exists but
 * cannot be read or parsed; the gate then draws a fresh hold.
 */
export interface UpdateHoldoffStore {
  read(): Promise<UpdateHoldoffRecord | null>;
  write(record: UpdateHoldoffRecord): Promise<void>;
  clear(): Promise<void>;
}

/** A durable hold-off: the deadline for `target` is kept in `store`. */
export interface UpdateHoldoffPersistence {
  /** Identity of the detected target (commit SHA / npm version). */
  target: string;
  store: UpdateHoldoffStore;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Persist a deadline. A failure is logged, never thrown: the hold still runs in memory. */
async function persistHoldoffRecord(
  store: UpdateHoldoffStore,
  record: UpdateHoldoffRecord,
  log: ((msg: string) => void) | undefined,
): Promise<void> {
  try {
    await store.write(record);
  } catch (err) {
    log?.(`Auto-update: could not persist the rollout hold-off deadline (${errorMessage(err)}); a restart will draw a new one.`);
  }
}

export type UpdateHoldoffDecision = 'proceed' | 'abort-shutdown';

export interface AwaitUpdateHoldoffDeps {
  /** Resolved jitter window in ms (from `resolveUpdateJitterMs`). */
  jitterMs: number;
  /** True once the daemon has begun shutting down. */
  isShuttingDown: () => boolean;
  /** Invoked once before the wait, when the hold is non-zero or was carried
   *  over from before a restart — lets the caller emit a mode-specific log
   *  line. `resumed` is true when the deadline came from the persisted record. */
  onHold?: (holdMs: number, resumed: boolean) => void;
  /** Omitted: the hold lives in memory and a restart redraws it. Present: the
   *  deadline is drawn once per target and resumed across restarts. */
  persistence?: UpdateHoldoffPersistence;
  /** Reports store failures, which never block the hold-off. */
  log?: (msg: string) => void;
  /** Injectable for deterministic tests. */
  rng?: () => number;
  /** Injectable for deterministic tests (default: Date.now). */
  now?: () => number;
  /** Injectable for deterministic tests (default: an unref'd setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to hold before applying. With `persistence`, the deadline is drawn
 * ONCE per target per node and persisted, so a restart mid-hold resumes the
 * remaining time (0 once the deadline has passed) instead of redrawing.
 * A fresh draw replaces the record when the target changed, the record is
 * unreadable, or the deadline lies outside [now - MAX_HOLDOFF_OVERDUE_MS,
 * now + jitterMs] (stale, the window was lowered, or the clock went back).
 * Store failures are logged and fall back to an in-memory hold; they never throw.
 */
async function resolveUpdateHoldoff(
  deps: Pick<AwaitUpdateHoldoffDeps, 'jitterMs' | 'persistence' | 'log' | 'rng' | 'now'>,
): Promise<{ holdMs: number; resumed: boolean }> {
  const rng = deps.rng ?? Math.random;
  if (!(deps.jitterMs > 0)) return { holdMs: 0, resumed: false };
  if (!deps.persistence) return { holdMs: pickUpdateHoldoffMs(deps.jitterMs, rng), resumed: false };

  const { target, store } = deps.persistence;
  const now = (deps.now ?? Date.now)();
  let record: UpdateHoldoffRecord | null = null;
  try {
    record = await store.read();
  } catch (err) {
    deps.log?.(`Auto-update: ignoring unreadable rollout hold-off record (${errorMessage(err)}); drawing a fresh hold-off.`);
  }
  if (record && record.target === target) {
    const remainingMs = record.deadlineEpochMs - now;
    if (remainingMs <= deps.jitterMs && remainingMs >= -MAX_HOLDOFF_OVERDUE_MS) {
      return { holdMs: Math.max(0, Math.ceil(remainingMs)), resumed: true };
    }
  }

  const holdMs = pickUpdateHoldoffMs(deps.jitterMs, rng);
  await persistHoldoffRecord(store, { target, deadlineEpochMs: now + holdMs }, deps.log);
  return { holdMs, resumed: false };
}

/**
 * Wait out the per-node rollout hold-off, then report whether to proceed with
 * applying the update. Returns `'proceed'` after the (possibly zero) hold-off,
 * or `'abort-shutdown'` if the daemon began shutting down during the wait — in
 * which case the caller must NOT apply. The update is re-detected on next boot,
 * which resumes the persisted deadline when `persistence` is configured.
 *
 * The ordering (resolve → optional log → sleep → re-check shutdown) is the exact
 * sequence both auto-update paths depend on; extracting it here makes the
 * shutdown-bail unit-testable rather than only eyeballed in the daemon loop.
 */
export async function awaitUpdateHoldoff(deps: AwaitUpdateHoldoffDeps): Promise<UpdateHoldoffDecision> {
  const { holdMs, resumed } = await resolveUpdateHoldoff(deps);
  if (holdMs > 0 || resumed) deps.onHold?.(holdMs, resumed);
  if (holdMs <= 0) return deps.isShuttingDown() ? 'abort-shutdown' : 'proceed';
  await (deps.sleep ?? unrefSleep)(holdMs);
  return deps.isShuttingDown() ? 'abort-shutdown' : 'proceed';
}

/**
 * The mode-neutral tail of the "update available" log line, so the git and npm
 * paths word the three hold-off cases identically.
 */
export function describeUpdateHold(holdMs: number, resumed: boolean): string {
  const secs = Math.round(holdMs / 1000);
  if (!resumed) return `holding ${secs}s before applying (rollout jitter — spreads fleet restarts).`;
  if (holdMs <= 0) return 'rollout hold-off deadline carried over from before a restart has passed — applying now.';
  return `resuming the rollout hold-off carried over from before a restart — ${secs}s left before applying.`;
}

/** Daemon-wide config for the rollout gate — stable across polling ticks. */
export interface UpdateHoldoffGateConfig {
  /** Resolved jitter window in ms (from resolveUpdateJitterMs). */
  jitterMs: number;
  /** True once the daemon has begun shutting down. */
  isShuttingDown: () => boolean;
  /** Toggle the daemon's user-visible "is updating" flag. */
  setUpdating: (updating: boolean) => void;
  log: (msg: string) => void;
  /** Persists the per-target deadline across restarts (see createFileUpdateHoldoffStore
   *  in auto-update-holdoff-store.ts). Omitted or null: the hold lives in memory
   *  only and a restart redraws it. */
  store?: UpdateHoldoffStore | null;
  /** Injectable for deterministic tests. */
  rng?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Per-rollout, mode-specific behaviour injected into a gate run. */
export interface UpdateHoldoffStep<T extends string = string> {
  /** The target the poll detected (commit SHA / npm version). Keys the persisted deadline. */
  detectedTarget: string;
  /** Emit the mode-specific "holding Ns before applying" line (detected target);
   *  `resumed` is true when the deadline was carried over from before a restart. */
  onHold: (holdMs: number, resumed: boolean) => void;
  /**
   * Re-confirm — AFTER the hold-off — that there is still a target to apply, and
   * return the CURRENT one. The jitter delay means the target detected before
   * the wait may have been withdrawn (dist-tag rolled back, ref moved) or the
   * node may have caught up; returning null skips the apply so a superseded /
   * withdrawn release is never installed, and drops the persisted deadline.
   * A refreshed target (e.g. a newer version published during the wait) is
   * applied in place of the stale one. THROW when the check itself failed
   * (network, registry): that says nothing about the target, so the gate skips
   * the apply but keeps the deadline, and the next poll retries without a new hold.
   */
  revalidate: () => Promise<T | null>;
  /** Apply the revalidated target (owns its own post-apply restart/log). */
  apply: (target: T) => Promise<void>;
  /** Logged when the run is aborted because the daemon is shutting down. */
  shutdownMessage: string;
  /** Logged when revalidate() reports no current target (withdrawn / caught up). */
  supersededMessage: string;
}

export interface UpdateHoldoffGate {
  /** Run one rollout attempt for a detected update. A no-op while a run or a
   *  clearHold() is in flight (single-flight across polling ticks). */
  run<T extends string>(step: UpdateHoldoffStep<T>): Promise<void>;
  /** The poll found nothing to apply (node caught up, or the target was
   *  withdrawn): drop the persisted deadline. Shares run()'s single-flight, so
   *  it is a no-op while a run owns the record, and a run cannot start (and
   *  write a deadline this clear would then delete) until it is done. */
  clearHold(): Promise<void>;
}

/**
 * The single auto-update rollout gate shared by the git and npm daemon paths.
 * A factory so it OWNS its single-flight state (the `pending` flag) instead of
 * making callers allocate and thread a mutable object — create it ONCE, at the
 * daemon scope, and call `.run(step)` on every polling tick. Each run:
 *
 *   single-flight guard -> hold-off (jitter, deadline persisted per target)
 *     -> abort if shutting down (record kept: next boot resumes it)
 *     -> REVALIDATE the target (check failed: stop, record kept)
 *     -> abort if shutting down (revalidate is async)
 *     -> nothing to apply: drop the record and stop
 *     -> newer target: record it as due -> abort if shutting down (last check)
 *     -> set isUpdating -> apply -> clear isUpdating
 *     -> drop the record unless the daemon is now shutting down
 *
 * The later shutdown checks matter: revalidate() is a network call and the
 * record write is async, so SIGTERM can arrive during either; without a re-check
 * the gate would start a build/install after shutdown cleanup has begun. No
 * await separates the last check from starting the apply.
 *
 * The record survives an apply that is cut short by a restart, so the next boot
 * retries without a second hold. After an apply that returns (failed, or the node
 * caught up) it is dropped, and the next detection draws a new hold as before.
 * After a successful apply the daemon is shutting down for its restart; the
 * record is left for the next boot, which finds the node up to date and drops it.
 */
export function createUpdateHoldoffGate(config: UpdateHoldoffGateConfig): UpdateHoldoffGate {
  // Owned here so single-flight holds across ticks — do NOT recreate per tick.
  // Held by run() and by clearHold(), the two transitions of the record.
  let pending = false;
  const store = config.store ?? null;
  const now = config.now ?? Date.now;

  async function forget(): Promise<void> {
    if (!store) return;
    try {
      await store.clear();
    } catch (err) {
      config.log(`Auto-update: could not remove the rollout hold-off record (${errorMessage(err)}).`);
    }
  }

  return {
    async run<T extends string>(step: UpdateHoldoffStep<T>): Promise<void> {
      if (pending) return; // one rollout at a time
      pending = true;
      try {
        const decision = await awaitUpdateHoldoff({
          jitterMs: config.jitterMs,
          isShuttingDown: config.isShuttingDown,
          onHold: step.onHold,
          persistence: store ? { target: step.detectedTarget, store } : undefined,
          log: config.log,
          rng: config.rng,
          now,
          sleep: config.sleep,
        });
        if (decision === 'abort-shutdown') {
          config.log(step.shutdownMessage);
          return;
        }

        let target: T | null;
        try {
          target = await step.revalidate();
        } catch (err) {
          config.log(
            `Auto-update: re-check after the hold-off failed (${errorMessage(err)}); ` +
              'not applying. The rollout deadline is kept and the next poll retries.',
          );
          return;
        }
        // revalidate() is async (a network check); shutdown may have started
        // during it, so re-check before committing to an install/restart.
        if (config.isShuttingDown()) {
          config.log(step.shutdownMessage);
          return;
        }
        if (target === null || target === undefined) {
          config.log(step.supersededMessage);
          await forget();
          return;
        }
        // A newer target replaced the detected one during the wait. This node has
        // served its hold, so record the new target as already due: a restart
        // during its apply then retries at once instead of drawing a new hold.
        if (store && target !== step.detectedTarget && config.jitterMs > 0) {
          await persistHoldoffRecord(store, { target, deadlineEpochMs: now() }, config.log);
        }
        // Last shutdown check: nothing async may run between it and the apply.
        if (config.isShuttingDown()) {
          config.log(step.shutdownMessage);
          return;
        }

        config.setUpdating(true);
        try {
          await step.apply(target);
        } finally {
          config.setUpdating(false);
          if (!config.isShuttingDown()) await forget();
        }
      } finally {
        pending = false;
      }
    },
    async clearHold(): Promise<void> {
      if (!store || pending) return; // an in-flight run owns the record
      pending = true;
      try {
        await forget();
      } finally {
        pending = false;
      }
    },
  };
}
