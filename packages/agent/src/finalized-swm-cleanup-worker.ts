// SPDX-License-Identifier: Apache-2.0

/**
 * Independent, pressure-gated maintenance worker for finalized SWM cleanup.
 *
 * Foreground finalization and catch-up only call {@link wake}; they never await
 * discovery, payload verification, or deletion. The worker owns retry and
 * single-flight semantics so repeated wake-ups cannot create overlapping store
 * scans. A periodic caller remains the restart/lost-wakeup safety net.
 */

export interface FinalizedSwmCleanupSweepResult {
  /**
   * Cleanup tasks still requiring a safe idle pass, as a whole-node total from
   * the last context-graph rotation that ran to completion. Never a partial sum:
   * a sweep that only covers part of a rotation republishes the previous total
   * and sets {@link stale}.
   */
  backlogDepth: number;
  /** Oldest surviving cleanup marker, or null when the backlog is empty/unknown. */
  oldestMarkerAt: number | null;
  /** Exact SWM lifecycles deleted by this sweep. */
  deletedItems: number;
  /** True when pressure appeared before or during discovery/cleanup. */
  pressureSkipped: boolean;
  /** True when the bounded slice yielded with more discovery work possible. */
  budgetExhausted?: boolean;
  /**
   * True when `backlogDepth`/`oldestMarkerAt` are not a current measurement —
   * this sweep deferred on pressure or wall clock, or is part-way through a
   * rotation. Distinguishes a deferred backlog from an empty one.
   */
  stale?: boolean;
}

export interface FinalizedSwmCleanupStats {
  backlogDepth: number;
  oldestMarkerAgeMs: number | null;
  /**
   * True until a full context-graph rotation has published a whole-node
   * measurement, and again whenever the latest sweep deferred. While true,
   * `backlogDepth` 0 / `oldestMarkerAgeMs` null mean "unknown", not "empty".
   */
  backlogStale: boolean;
  pressureSkips: number;
  deletedItems: number;
  runs: number;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface FinalizedSwmCleanupWorkerOptions {
  sweep: () => Promise<FinalizedSwmCleanupSweepResult>;
  now?: () => number;
  retryDelayMs?: number;
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (error: unknown) => void;
}

export class FinalizedSwmCleanupWorker {
  private readonly sweep: () => Promise<FinalizedSwmCleanupSweepResult>;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly setTimer: NonNullable<FinalizedSwmCleanupWorkerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<FinalizedSwmCleanupWorkerOptions['clearTimer']>;
  private readonly onError: (error: unknown) => void;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private wakePendingDelayMs: number | null = null;
  private closed = false;
  private oldestMarkerAt: number | null = null;
  private readonly stats: FinalizedSwmCleanupStats = {
    backlogDepth: 0,
    oldestMarkerAgeMs: null,
    // Nothing has been measured yet, which is not the same as an empty backlog.
    backlogStale: true,
    pressureSkips: 0,
    deletedItems: 0,
    runs: 0,
    lastRunAt: null,
    lastError: null,
  };

  constructor(options: FinalizedSwmCleanupWorkerOptions) {
    this.sweep = options.sweep;
    this.now = options.now ?? Date.now;
    this.retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 5_000));
    this.setTimer = options.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onError = options.onError ?? (() => {});
  }

  /** Schedule an independent maintenance pass; never waits for store work. */
  wake(delayMs = 0): void {
    if (this.closed) return;
    if (this.inFlight) {
      const normalizedDelay = Math.max(0, Math.floor(delayMs));
      this.wakePendingDelayMs = this.wakePendingDelayMs === null
        ? normalizedDelay
        : Math.min(this.wakePendingDelayMs, normalizedDelay);
      return;
    }
    if (this.wakeTimer) return;
    this.wakeTimer = this.setTimer(() => {
      this.wakeTimer = null;
      void this.run();
    }, Math.max(0, Math.floor(delayMs)));
    this.wakeTimer.unref?.();
  }

  /** Test/diagnostic seam that joins the current pass without starting overlap. */
  async runNow(): Promise<void> {
    if (this.closed) return;
    if (this.wakeTimer) {
      this.clearTimer(this.wakeTimer);
      this.wakeTimer = null;
    }
    await this.run();
  }

  snapshot(): FinalizedSwmCleanupStats {
    return {
      ...this.stats,
      oldestMarkerAgeMs: this.oldestMarkerAt === null
        ? null
        : Math.max(0, this.now() - this.oldestMarkerAt),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wakePendingDelayMs = null;
    if (this.wakeTimer) {
      this.clearTimer(this.wakeTimer);
      this.wakeTimer = null;
    }
    await this.inFlight;
  }

  private async run(): Promise<void> {
    if (this.closed) return;
    if (this.inFlight) {
      this.wakePendingDelayMs = 0;
      await this.inFlight;
      return;
    }
    const task = this.performSweep();
    this.inFlight = task;
    try {
      await task;
    } finally {
      if (this.inFlight === task) this.inFlight = null;
      if (this.closed) return;
      if (this.wakePendingDelayMs !== null) {
        const delayMs = this.wakePendingDelayMs;
        this.wakePendingDelayMs = null;
        this.wake(delayMs);
      }
    }
  }

  private async performSweep(): Promise<void> {
    const startedAt = this.now();
    this.stats.runs += 1;
    this.stats.lastRunAt = new Date(startedAt).toISOString();
    try {
      const result = await this.sweep();
      this.stats.backlogDepth = Math.max(0, Math.floor(result.backlogDepth));
      this.stats.backlogStale = result.stale === true;
      this.oldestMarkerAt = result.oldestMarkerAt;
      this.stats.oldestMarkerAgeMs = this.oldestMarkerAt === null
        ? null
        : Math.max(0, this.now() - this.oldestMarkerAt);
      this.stats.deletedItems += Math.max(0, Math.floor(result.deletedItems));
      if (result.pressureSkipped) this.stats.pressureSkips += 1;
      this.stats.lastError = null;

      // Pressure is expected and retryable. Continue a productive bounded
      // drain without waiting for the 15-minute periodic backstop; a stuck or
      // fail-closed backlog (no deletion) waits for the next explicit wake.
      if (
        result.pressureSkipped
        || result.budgetExhausted === true
        || (result.deletedItems > 0 && result.backlogDepth > 0)
      ) {
        this.wake(this.retryDelayMs);
      }
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      this.onError(error);
    }
  }
}
