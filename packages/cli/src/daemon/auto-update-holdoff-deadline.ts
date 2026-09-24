/**
 * The rollout deadline policy: how long a node holds before applying a detected
 * target, and what happens to that decision across restarts. The rollout gate
 * requires one.
 *
 * The daemon uses the persisted policy. Its deadline is drawn once per target
 * per node and kept (in `<DKG home>/.update-holdoff.json`), so a node that
 * restarts during its hold resumes the remaining wait instead of drawing a
 * fresh one. Without that, a node restarting more often than its hold never
 * reached the deadline: every boot redrew a hold in [0, jitter) and the restart
 * aborted it again, so the update was never applied. The volatile policy draws
 * every time and keeps nothing; it exists for callers that explicitly want that.
 */
import { pickUpdateHoldoffMs, type UpdateHold } from './auto-update-jitter.js';

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
 * Where the persisted policy keeps the {@link UpdateHoldoffRecord} across
 * restarts. `read` returns null when there is no record and throws when one
 * exists but cannot be read or parsed; the policy then draws a fresh hold.
 */
export interface UpdateHoldoffStore {
  read(): Promise<UpdateHoldoffRecord | null>;
  write(record: UpdateHoldoffRecord): Promise<void>;
  clear(): Promise<void>;
}

/** Every transition of a node's rollout deadline. */
export interface UpdateHoldoffDeadline {
  /** The hold before applying `target`. */
  begin(target: string): Promise<UpdateHold>;
  /** Record `target` as already due (a newer target found by the re-check). */
  markDue(target: string): Promise<void>;
  /** Forget the deadline (nothing to apply, or an apply finished). */
  clear(): Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface PersistedHoldoffDeadlineOptions {
  store: UpdateHoldoffStore;
  /** Resolved jitter window in ms (from `resolveUpdateJitterMs`); 0 disables. */
  jitterMs: number;
  /** Reports store failures, which are never thrown (see createPersistedHoldoffDeadline). */
  log: (msg: string) => void;
  /** Injectable for deterministic tests. */
  rng?: () => number;
  now?: () => number;
}

/**
 * The daemon's policy. `begin` resumes a persisted deadline for the same target
 * (0 once it has passed) and otherwise draws and persists a new one. It redraws
 * when the target changed, the record is unreadable, or the deadline lies
 * outside [now - MAX_HOLDOFF_OVERDUE_MS, now + jitterMs] (stale, the window was
 * lowered, or the clock went back). With jitter off it holds 0 and writes nothing.
 *
 * The store only carries the deadline across restarts. Within one process the
 * latest transition is also kept in memory and is authoritative: the store is
 * read only until this process has made a transition. So a failed write does
 * not make the next poll redraw, and a failed clear does not bring a stale
 * deadline back. Store failures are logged, never thrown.
 */
export function createPersistedHoldoffDeadline(opts: PersistedHoldoffDeadlineOptions): UpdateHoldoffDeadline {
  const { store, jitterMs, log } = opts;
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? Date.now;
  // This process's latest transition; `undefined` until it has made one.
  let latest: UpdateHoldoffRecord | null | undefined;

  async function write(record: UpdateHoldoffRecord): Promise<void> {
    latest = record;
    try {
      await store.write(record);
    } catch (err) {
      log(`Auto-update: could not persist the rollout hold-off deadline (${errorMessage(err)}); a restart will draw a new one.`);
    }
  }

  async function current(): Promise<UpdateHoldoffRecord | null> {
    if (latest !== undefined) return latest;
    try {
      return await store.read();
    } catch (err) {
      log(`Auto-update: ignoring unreadable rollout hold-off record (${errorMessage(err)}); drawing a fresh hold-off.`);
      return null;
    }
  }

  return {
    async begin(target) {
      if (!(jitterMs > 0)) return { holdMs: 0, resumed: false };
      const at = now();
      const record = await current();
      if (record && record.target === target) {
        const remainingMs = record.deadlineEpochMs - at;
        if (remainingMs <= jitterMs && remainingMs >= -MAX_HOLDOFF_OVERDUE_MS) {
          latest = record;
          return { holdMs: Math.max(0, Math.ceil(remainingMs)), resumed: true };
        }
      }
      const holdMs = pickUpdateHoldoffMs(jitterMs, rng);
      await write({ target, deadlineEpochMs: at + holdMs });
      return { holdMs, resumed: false };
    },
    async markDue(target) {
      if (jitterMs > 0) await write({ target, deadlineEpochMs: now() });
    },
    async clear() {
      latest = null;
      try {
        await store.clear();
      } catch (err) {
        log(`Auto-update: could not remove the rollout hold-off record (${errorMessage(err)}).`);
      }
    },
  };
}

/** A policy that draws a fresh hold every time and keeps nothing across restarts. */
export function createVolatileHoldoffDeadline(opts: { jitterMs: number; rng?: () => number }): UpdateHoldoffDeadline {
  return {
    async begin() {
      return { holdMs: pickUpdateHoldoffMs(opts.jitterMs, opts.rng ?? Math.random), resumed: false };
    },
    async markDue() {},
    async clear() {},
  };
}
