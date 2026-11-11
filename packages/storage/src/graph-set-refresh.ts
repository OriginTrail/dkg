// SPDX-License-Identifier: Apache-2.0

/**
 * How a warm graph catalog revalidates once it is due. `background` answers
 * every caller from the warm catalog and refreshes it in one background
 * flight; `blocking`, the behaviour before, makes the caller that finds it due
 * wait for the refresh. Cold seeds and dirty rebuilds block either way.
 */
export type GraphSetRevalidation = 'background' | 'blocking';

/** A revalidation starts no sooner than this many times the duration of the last refresh. */
const GRAPH_SET_REVALIDATE_DURATION_FACTOR = 20;

/** The wait before the next revalidation: the interval, or twenty times the last refresh when that is longer. */
export function graphSetRevalidationDelayMs(revalidateMs: number, lastRefreshMs: number): number {
  return Math.max(revalidateMs, GRAPH_SET_REVALIDATE_DURATION_FACTOR * Math.max(0, lastRefreshMs));
}

/**
 * At most one background revalidation at a time. Its failure never reaches a
 * caller: it goes to `onFailure`, which decides what the catalog keeps.
 */
export class BackgroundGraphSetRevalidation {
  private running: Promise<void> | null = null;

  get active(): boolean {
    return this.running !== null;
  }

  /** Start `refresh` unless a background revalidation is already running. */
  start(refresh: () => Promise<unknown>, onFailure: (error: unknown) => void): void {
    if (this.running) return;
    this.running = (async () => {
      try {
        await refresh();
      } catch (error: unknown) {
        onFailure(error);
      } finally {
        this.running = null;
      }
    })();
  }

  /** Settles once no background revalidation is running. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }
}
