// SPDX-License-Identifier: Apache-2.0

/**
 * How a warm graph catalog revalidates once it is due. `blocking`, the
 * default, makes the caller that finds it due wait for the refresh;
 * `background` answers every caller from the warm catalog and refreshes it in
 * one background flight. Cold seeds and dirty rebuilds block either way.
 */
export type GraphSetRevalidation = 'background' | 'blocking';

/**
 * Read options for a caller that must read a current catalog: when the catalog
 * is `revalidateMs` older than its last refresh, the read waits for a
 * revalidation, whatever the revalidation mode and the cadence. Unscoped-query
 * admission reads the stored owners this way.
 */
export interface CurrentGraphCatalogReadOptions {
  readonly currentCatalog?: boolean;
}

export function readsCurrentGraphCatalog(options: unknown): boolean {
  return (options as CurrentGraphCatalogReadOptions | undefined)?.currentCatalog === true;
}

/** A revalidation starts no sooner than this many times the duration of the last refresh. */
const GRAPH_SET_REVALIDATE_DURATION_FACTOR = 20;

/** The wait before the next revalidation: the interval, or twenty times the last refresh when that is longer. */
export function graphSetRevalidationDelayMs(revalidateMs: number, lastRefreshMs: number): number {
  return Math.max(revalidateMs, GRAPH_SET_REVALIDATE_DURATION_FACTOR * Math.max(0, lastRefreshMs));
}

/**
 * At most one background revalidation at a time. Its failure never reaches a
 * caller: it goes to `onFailure`, which decides what the catalog keeps, and
 * only while no refresh has published a catalog since the flight began. A
 * newer catalog is not dropped for an older flight's failure.
 */
export class BackgroundGraphSetRevalidation {
  private running: Promise<void> | null = null;
  private published = 0;

  get active(): boolean {
    return this.running !== null;
  }

  /** Notes that a refresh published a catalog. */
  notePublished(): void {
    this.published++;
  }

  /** Start `refresh` unless a background revalidation is already running. */
  start(refresh: () => Promise<unknown>, onFailure: (error: unknown) => void): void {
    if (this.running) return;
    const publishedBefore = this.published;
    this.running = (async () => {
      try {
        await refresh();
      } catch (error: unknown) {
        if (this.published === publishedBefore) onFailure(error);
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
