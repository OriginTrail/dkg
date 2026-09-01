// SPDX-License-Identifier: Apache-2.0
/**
 * Per-lane periodic-replay coordination (#2435, review r3-bot).
 *
 * The lane runner schedules FORWARD scans; everything about the trailing
 * replay — the poll counting that makes a periodic window due, the retained
 * window whose dispatch rejected (r19), its durable persistence (r20) and
 * write-ahead ordering (r24), transient-load retry (r24), and the
 * unread-window guard (r27-bot) — lives HERE, as one component with explicit
 * state instead of three temporal booleans interleaved through the scheduler.
 *
 * Invariants this class owns:
 *  - At most ONE window is outstanding; a retained retry window has priority
 *    over a newly due periodic window.
 *  - The write-ahead: a window is marked dispatching — in memory AND durably —
 *    BEFORE its dispatch runs, so a crash mid-callback cannot lose it while
 *    the forward cursor has durably passed that history.
 *  - A transient persistence-load failure leaves restoration RETRYABLE, and
 *    while the durable window is UNREAD nothing replays at all: a newly due
 *    periodic window must not overwrite — nor its success clear — durable
 *    state this process has never seen.
 *  - Persistence writes are best-effort: the in-memory retry never depends on
 *    the save having succeeded.
 */
import type {
  LaneReplayRetryPersistence,
  LaneReplayRetryWindow,
} from './chain-event-lane-cursor-store.js';
import type { ChainEventPollerLane } from './chain-event-lane-runner.js';

export interface LaneReplayCoordinatorDeps {
  lane: ChainEventPollerLane;
  periodicRescan?: { everyPolls: number; windowBlocks: number } | undefined;
  persistence?: LaneReplayRetryPersistence | undefined;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

export class LaneReplayCoordinator {
  #pendingRetry: LaneReplayRetryWindow | undefined;
  #restorePending = false;
  #pollCount = 0;

  constructor(private readonly deps: LaneReplayCoordinatorDeps) {}

  /** Diagnostic: is a rejected window currently retained for retry? */
  get hasPendingRetry(): boolean {
    return this.#pendingRetry !== undefined;
  }

  /**
   * Load the persisted replay-retry window. A TRANSIENT store failure must
   * not read as "nothing retained" (review r24): the attempt is flagged for
   * retry on a later poll instead of being permanently skipped for the
   * lifetime of the runner.
   */
  async restoreFromPersistence(): Promise<void> {
    if (!this.deps.persistence) return;
    try {
      const retained = await this.deps.persistence.load(this.deps.lane);
      this.#restorePending = false;
      if (retained) {
        this.#pendingRetry = { ...retained };
        this.deps.logInfo(
          `Restored replay-retry window from persistence: lane=${this.deps.lane} ` +
          `[${retained.fromBlock}, ${retained.toBlock}]`,
        );
      }
    } catch (err) {
      this.#restorePending = true;
      this.deps.logWarn(
        `Failed to load replay-retry window (will retry on a later poll): lane=${this.deps.lane} ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The window to replay on THIS due tick, if any — and count the tick.
   *
   * MUTATES deliberately: the per-lane tick counter advances on every due
   * tick, idle ones included — the loss the periodic replay bounds happens
   * while the lane is idle and caught up, so idle ticks are exactly the ones
   * that must carry the schedule forward. A failed restoration is retried
   * first; while the durable window is still UNREAD, nothing replays
   * (review r27-bot) — forward scanning continues and the periodic schedule
   * resumes once a restore attempt completes.
   */
  private async takeWindow(lastBlock: number): Promise<LaneReplayRetryWindow | undefined> {
    if (this.#restorePending) {
      await this.restoreFromPersistence();
    }
    const scheduled = this.takeDueScheduledWindow(lastBlock);
    if (this.#restorePending) return undefined;
    return this.#pendingRetry ?? scheduled;
  }

  /**
   * The ONE dispatch operation (review r6-bot): selects the due window,
   * write-ahead marks it — in memory AND durably, BEFORE the dispatch runs
   * (review r24: a crash while the callback is in flight otherwise loses
   * the window entirely while the forward cursor has durably passed this
   * history) — invokes the dispatch, and releases the mark only after a
   * clean dispatch. A dispatch failure needs no further bookkeeping: the
   * retained window IS the write-ahead mark, retried on the next poll.
   * Owning the whole protocol here makes dispatch-without-mark and
   * clear-after-failure structurally impossible at every call site.
   */
  async dispatchDue(
    lastBlock: number,
    dispatchWindow: (window: LaneReplayRetryWindow) => Promise<void>,
    finalizedBound?: number,
  ): Promise<{ window: LaneReplayRetryWindow; dispatched: boolean } | undefined> {
    let window = await this.takeWindow(lastBlock);
    if (!window) return undefined;
    // The lane’s scan bound applies to REPLAY too (review r7-bot): scheduled
    // windows derive from `lastBlock`, but a restored cursor — or a raised
    // confirmation depth — can leave a retained or durable window ABOVE the
    // finalized head. A replay must not deliver a block the forward scan is
    // not yet allowed to touch, so the DISPATCHED window is clamped to the
    // bound — while the write-ahead mark keeps the FULL obligation, and a
    // clean clamped dispatch retains the unfinalized TAIL for the poll on
    // which the bound reaches it. Nothing above the bound is ever lost.
    const original = window;
    let tail: LaneReplayRetryWindow | undefined;
    if (finalizedBound !== undefined && window.toBlock > finalizedBound) {
      if (window.fromBlock > finalizedBound) return undefined;
      window = { fromBlock: window.fromBlock, toBlock: finalizedBound };
      tail = { fromBlock: finalizedBound + 1, toBlock: original.toBlock };
    }
    this.#pendingRetry = { fromBlock: original.fromBlock, toBlock: original.toBlock };
    await this.persist(this.#pendingRetry);
    try {
      await dispatchWindow(window);
    } catch (err) {
      this.deps.logWarn(
        `Periodic re-scan failed (forward scan unaffected; window retained for retry): ` +
        `lane=${this.deps.lane} [${window.fromBlock}, ${window.toBlock}] ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      return { window, dispatched: false };
    }
    this.#pendingRetry = tail;
    await this.persist(tail);
    return { window, dispatched: true };
  }

  private takeDueScheduledWindow(lastBlock: number): LaneReplayRetryWindow | undefined {
    const rescan = this.deps.periodicRescan;
    if (!rescan) return undefined;
    const everyPolls = Math.floor(rescan.everyPolls);
    const windowBlocks = Math.floor(rescan.windowBlocks);

    this.#pollCount += 1;

    if (!Number.isFinite(everyPolls) || everyPolls <= 0) return undefined;
    if (!Number.isFinite(windowBlocks) || windowBlocks <= 0) return undefined;
    if (this.#pollCount % everyPolls !== 0) return undefined;

    const toBlock = lastBlock;
    // Nothing has been scanned yet — there is no history to look back over,
    // and `[1, 0]` would be an inverted window.
    if (toBlock < 1) return undefined;
    // Inclusive window of EXACTLY `windowBlocks` blocks (review r3): the naive
    // `toBlock - windowBlocks` spans windowBlocks + 1 blocks inclusive, which a
    // provider enforcing a strict range cap would reject — turning the re-scan
    // into a permanent no-op on exactly the providers it exists to survive.
    return { fromBlock: Math.max(1, toBlock - windowBlocks + 1), toBlock };
  }

  /**
   * Best-effort persistence (review r20): the in-memory retry must remain
   * usable even when the durable write fails — losing the save costs
   * restart-safety for this window, not the retry itself.
   */
  private async persist(window: LaneReplayRetryWindow | undefined): Promise<void> {
    if (!this.deps.persistence) return;
    try {
      await this.deps.persistence.save(this.deps.lane, window);
    } catch (err) {
      this.deps.logWarn(
        `Failed to persist replay-retry window (in-memory retry unaffected): lane=${this.deps.lane} ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
