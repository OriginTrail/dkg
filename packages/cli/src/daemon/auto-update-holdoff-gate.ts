/**
 * The auto-update rollout gate shared by the git and npm daemon paths. It runs
 * the whole update flight — check, per-node hold-off (through a required
 * {@link UpdateHoldoffDeadline} policy), re-check, apply — one at a time, with
 * shutdown aborts and the isUpdating flag.
 */
import type { UpdateHoldoffDeadline } from './auto-update-holdoff-deadline.js';

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
 * What one update check found, in mode-neutral terms. The runners map their
 * native git/npm statuses onto this, for the poll and for the re-check after
 * the hold-off; the gate alone decides what each outcome does to the deadline.
 */
export type UpdateCheckOutcome<T extends string = string> =
  | { status: 'available'; target: T }
  /** Definitive: nothing to apply (up to date, target withdrawn, no channel target). */
  | { status: 'none' }
  /** The check itself failed (network, registry): says nothing about the target. */
  | { status: 'failed' };

/** One update mode's checks and install. Bound to the gate once per mode. */
export interface UpdateHoldoffStep<T extends string = string> {
  /** The update check that starts each flight (records the daemon's status too). */
  check: () => Promise<UpdateCheckOutcome<T>>;
  /** Emit the mode-specific "holding Ns before applying" line for the detected
   *  target; `resumed` is true when the deadline was carried over from before a restart. */
  onHold: (target: T, holdMs: number, resumed: boolean) => void;
  /**
   * Re-run the check AFTER the hold-off. The jitter delay means the target
   * detected before the wait may have been withdrawn (dist-tag rolled back, ref
   * moved) or the node may have caught up, so the CURRENT outcome decides: a
   * refreshed target (e.g. a newer version published during the wait) is applied
   * in place of the stale one, and a withdrawn / superseded one never is.
   */
  revalidate: () => Promise<UpdateCheckOutcome<T>>;
  /** Apply the revalidated target (owns its own post-apply restart/log). */
  apply: (target: T) => Promise<void>;
  /** Logged when the rollout is aborted because the daemon is shutting down. */
  shutdownMessage: string;
  /** Logged when the re-check finds nothing to apply (withdrawn / caught up). */
  supersededMessage: string;
  /** Logged when the re-check itself failed; the deadline is kept. */
  recheckFailedMessage: string;
}

/** Daemon-wide config for the rollout gate — stable across polling ticks. */
export interface UpdateHoldoffGateConfig {
  /** The deadline policy (the daemon uses the persisted one). */
  deadline: UpdateHoldoffDeadline;
  /** True once the daemon has begun shutting down. */
  isShuttingDown: () => boolean;
  /** Toggle the daemon's user-visible "is updating" flag. */
  setUpdating: (updating: boolean) => void;
  log: (msg: string) => void;
  /** Injectable for deterministic tests (default: an unref'd setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run one update flight: check, then by the outcome
 *   available -> hold off, re-check, apply
 *   none      -> drop the deadline
 *   failed    -> nothing; the deadline is kept
 * A call made while a flight is running joins that flight (same promise), so
 * two flights never run at once.
 */
export type UpdateFlight = () => Promise<void>;

export interface UpdateHoldoffGate {
  /** Bind a mode's step once; run a flight on every polling tick. All flights
   *  of one gate share its deadline and never overlap. */
  bindRollout<T extends string>(rollout: UpdateHoldoffStep<T>): UpdateFlight;
}

/**
 * The single auto-update rollout gate — create it ONCE, at the daemon scope. It
 * runs one flight at a time (check → outcome → hold → re-check → apply); a call
 * made meanwhile joins the running flight. Nothing starts once shutdown has
 * begun, and a failed check keeps the deadline. An `available` check runs:
 *
 *   hold (the deadline policy's) -> log it if it is non-zero or resumed
 *     -> sleep it if non-zero
 *     -> abort if shutting down (deadline kept: next boot resumes it)
 *     -> RE-CHECK -> abort if shutting down (the re-check is async)
 *     -> re-check failed: stop, deadline kept
 *     -> nothing to apply: drop the deadline and stop
 *     -> newer target: record it as due -> abort if shutting down (last check)
 *     -> set isUpdating -> apply -> clear isUpdating
 *     -> drop the deadline unless the daemon is now shutting down
 *
 * The later shutdown checks matter: the re-check is a network call and the
 * deadline write is async, so SIGTERM can arrive during either; without a
 * re-check the gate would start a build/install after shutdown cleanup has
 * begun. No await separates the last check from starting the apply.
 *
 * The deadline survives an apply that is cut short by a restart, so the next
 * boot retries without a second hold. After an apply that returns (failed, or
 * the node caught up) it is dropped, and the next detection draws a new hold as
 * before. After a successful apply the daemon is shutting down for its restart;
 * the deadline is left for the next boot, which finds the node up to date and
 * drops it.
 */
export function createUpdateHoldoffGate(config: UpdateHoldoffGateConfig): UpdateHoldoffGate {
  const { deadline } = config;
  // The flight in progress, shared by every bound step: the single flight.
  let inFlight: Promise<void> | null = null;

  async function rollout<T extends string>(detected: T, step: UpdateHoldoffStep<T>): Promise<void> {
    const { holdMs, resumed } = await deadline.begin(detected);
    if (holdMs > 0 || resumed) step.onHold(detected, holdMs, resumed);
    if (holdMs > 0) await (config.sleep ?? unrefSleep)(holdMs);
    // Checked after the wait, not before: shutdown usually arrives during it.
    if (config.isShuttingDown()) {
      config.log(step.shutdownMessage);
      return;
    }

    const recheck = await step.revalidate();
    if (config.isShuttingDown()) {
      config.log(step.shutdownMessage);
      return;
    }
    if (recheck.status === 'failed') {
      config.log(step.recheckFailedMessage);
      return;
    }
    if (recheck.status === 'none') {
      config.log(step.supersededMessage);
      await deadline.clear();
      return;
    }
    const target = recheck.target;
    // A newer target replaced the detected one during the wait. This node has
    // served its hold, so record the new target as already due: a restart
    // during its apply then retries at once instead of drawing a new hold.
    if (target !== detected) await deadline.markDue(target);
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
      if (!config.isShuttingDown()) await deadline.clear();
    }
  }

  return {
    bindRollout<T extends string>(step: UpdateHoldoffStep<T>): UpdateFlight {
      async function flight(): Promise<void> {
        if (config.isShuttingDown()) return; // nothing starts once shutdown began
        const outcome = await step.check();
        if (outcome.status === 'failed') return; // says nothing: keep the deadline
        if (config.isShuttingDown()) return;
        if (outcome.status === 'none') await deadline.clear();
        else await rollout(outcome.target, step);
      }
      return () => {
        if (!inFlight) {
          inFlight = flight().finally(() => { inFlight = null; });
        }
        return inFlight;
      };
    },
  };
}
