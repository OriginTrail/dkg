// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphDormancyAfterAuthority,
  type ContextGraphDormancyReason,
  type ContextGraphReadAuthorityNotAllowed,
} from './context-graph-subscription-dormancy.js';

/**
 * Shortest pause after a check that activated nothing. A check that has to
 * refresh the authority index is seven to nine chain reads, so however fast
 * the endpoint answers, these checks stay under a fifth of the default
 * request budget (10 a second).
 */
export const ROLLING_CHECK_MIN_PAUSE_MS = 5_000;
/**
 * The pause is at least this many times the time the check took. Checks that
 * activate nothing then occupy at most a fifth of the pass's time: a small
 * request budget or a slow endpoint slows them down instead of handing them a
 * larger share.
 */
export const ROLLING_CHECK_PAUSE_PER_CHECK_TIME = 4;
/** Longest pause; a check that waited out a failing endpoint ends here. */
export const ROLLING_CHECK_MAX_PAUSE_MS = 30_000;
/** How often a pass in progress reports the rows it left dormant. */
export const ROLLING_CHECK_REPORT_INTERVAL_MS = 300_000;

export interface RollingSubscriptionCheckOptions {
  readonly minPauseMs?: number;
  readonly maxPauseMs?: number;
  readonly pausePerCheckTime?: number;
  readonly reportIntervalMs?: number;
  readonly now?: () => number;
}

export interface RollingSubscriptionCheckPassInput {
  /** Rows waiting behind the activation cap. */
  readonly pendingIds: ReadonlySet<string>;
  readonly dormancyById: ReadonlyMap<string, ContextGraphDormancyReason>;
  /** Runtime rows; a dormant row with a saved chain id keeps its identity here. */
  readonly subscriptions: ReadonlyMap<string, Readonly<{ onChainId?: string }>>;
  warn(message: string): void;
  debug(message: string): void;
}

export interface RollingSubscriptionCheckPass {
  /**
   * The row to check next, or undefined when the pass has none left. Waits
   * out the pause the previous check left; rejects with the signal's reason
   * when it aborts.
   */
  next(signal: AbortSignal): Promise<string | undefined>;
  /** Run one row's authority read. A pause follows unless the row activates. */
  read<T>(check: () => Promise<T>): Promise<T>;
  /** The row just read was activated: the next check does not wait. */
  activated(): void;
  /** The row just read stays dormant. Returns the dormancy to record for it. */
  leftDormant(
    contextGraphId: string,
    authority: ContextGraphReadAuthorityNotAllowed,
  ): ContextGraphDormancyReason;
}

/**
 * Order and pace of the read-authority checks rolling activation makes for
 * saved subscriptions the activation cap left dormant.
 *
 * A check is a handful of chain reads, issued in the foreground request class
 * with authority admission priority, where they go ahead of every ordinary
 * read. Run back to back for several hundred rows the chain does not confirm,
 * they take the node's whole request budget for minutes, and every other read
 * waits out its deadline unsent. So a check that activated nothing is
 * followed by a pause. The pause grows with the time the check took: a slower
 * lane gets slower checks, not a larger share of them.
 *
 * A check that activates its row leaves no pause. Those are bounded by the
 * activation cap, and a graph the chain confirms should not wait.
 *
 * Order: a row someone asked for, then rows with a saved chain id (their
 * check needs no name lookup, and they were confirmed once), then the rest;
 * by id inside each group. The order is decided again before every check, so
 * a row asked for while a pass is running is the next one checked.
 *
 * No row is given up: one that stays dormant as unavailable is asked again by
 * background authority recovery, as before.
 */
export class RollingSubscriptionChecks {
  readonly #minPauseMs: number;
  readonly #maxPauseMs: number;
  readonly #pausePerCheckTime: number;
  readonly #reportIntervalMs: number;
  readonly #now: () => number;
  readonly #preferred = new Set<string>();
  /** No check starts before this instant. */
  #notBeforeMs = 0;
  /** Rows left dormant since the last report, by the authority's answer. */
  readonly #unreported = new Map<string, number>();
  #reportedAtMs: number | undefined;

  constructor(options: RollingSubscriptionCheckOptions = {}) {
    this.#minPauseMs = options.minPauseMs ?? ROLLING_CHECK_MIN_PAUSE_MS;
    this.#maxPauseMs = options.maxPauseMs ?? ROLLING_CHECK_MAX_PAUSE_MS;
    this.#pausePerCheckTime = options.pausePerCheckTime ?? ROLLING_CHECK_PAUSE_PER_CHECK_TIME;
    this.#reportIntervalMs = options.reportIntervalMs ?? ROLLING_CHECK_REPORT_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Check this row before the rest of the backlog. */
  prefer(contextGraphId: string): void {
    this.#preferred.add(contextGraphId);
  }

  beginPass(input: RollingSubscriptionCheckPassInput): RollingSubscriptionCheckPass {
    // A row that stays pending after its check (its saved binding changed
    // under the read) is left for the next pass, not asked again in this one.
    const checked = new Set<string>();
    const waits = (id: string): boolean => (
      input.pendingIds.has(id) && input.dormancyById.get(id) === 'activationCap'
    );
    const pick = (): string | undefined => {
      for (const id of this.#preferred) {
        if (!waits(id)) this.#preferred.delete(id);
      }
      let picked: string | undefined;
      let pickedRank = Number.POSITIVE_INFINITY;
      for (const id of input.pendingIds) {
        if (checked.has(id) || !waits(id)) continue;
        const rank = this.#preferred.has(id)
          ? 0
          : input.subscriptions.get(id)?.onChainId ? 1 : 2;
        if (rank < pickedRank || (rank === pickedRank && id < picked!)) {
          picked = id;
          pickedRank = rank;
        }
      }
      return picked;
    };
    const report = (): void => {
      if (this.#unreported.size === 0) return;
      let left = 0;
      const answers = [...this.#unreported]
        .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1))
        .map(([answer, count]) => {
          left += count;
          return `${count} ${answer}`;
        });
      let waiting = 0;
      for (const id of input.pendingIds) {
        if (waits(id)) waiting += 1;
      }
      this.#unreported.clear();
      this.#reportedAtMs = this.#now();
      input.warn(
        `Left ${left} pending persisted context-graph subscription(s) dormant: ${answers.join(', ')}. ` +
          `${waiting} more wait for their check. ` +
          `Inspect 'GET /api/context-graph/subscriptions' for dormant ids.`,
      );
    };

    return {
      next: async (signal) => {
        signal.throwIfAborted();
        // Nothing left: end the pass now instead of waiting out a pause first.
        if (pick() === undefined) {
          report();
          return undefined;
        }
        await this.#pause(signal);
        const contextGraphId = pick();
        if (contextGraphId === undefined) report();
        else checked.add(contextGraphId);
        return contextGraphId;
      },
      read: async (check) => {
        const startedAtMs = this.#now();
        try {
          return await check();
        } finally {
          const tookMs = this.#now() - startedAtMs;
          this.#notBeforeMs = this.#now() + Math.min(
            this.#maxPauseMs,
            Math.max(this.#minPauseMs, this.#pausePerCheckTime * tookMs),
          );
        }
      },
      activated: () => {
        this.#notBeforeMs = 0;
      },
      leftDormant: (contextGraphId, authority) => {
        const answer = `${authority.outcome} by ${authority.source} (${authority.reason})`;
        input.debug(
          `Left pending persisted context-graph subscription "${contextGraphId}" dormant: ${answer}`,
        );
        this.#unreported.set(answer, (this.#unreported.get(answer) ?? 0) + 1);
        this.#reportedAtMs ??= this.#now();
        if (this.#now() - this.#reportedAtMs >= this.#reportIntervalMs) report();
        return contextGraphDormancyAfterAuthority(authority);
      },
    };
  }

  /** Wait until the next check may start, or until `signal` aborts. */
  async #pause(signal: AbortSignal): Promise<void> {
    // The clock is the wall clock; a step backwards must not stretch a pause.
    const waitMs = Math.min(this.#notBeforeMs - this.#now(), this.#maxPauseMs);
    if (waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, waitMs);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
