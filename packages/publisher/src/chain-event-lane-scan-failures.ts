import { isStoreSchedulerBusyError } from '@origintrail-official/dkg-storage';

/**
 * Failed scans of one range in a row at which a busy store is logged as an
 * error. With the lane's failure backoff (1, 2, 4, then 5 minutes) the fifth
 * comes about 12 minutes after the first.
 */
export const STORE_BUSY_SCANS_BEFORE_ERROR = 5;

const MAX_CAUSE_DEPTH = 8;

/**
 * Whether a scan failed only because the store refused background work: its
 * scheduler queue was full, or the queue wait ran out, so the read never
 * started. A handler wraps the store's error in its own context, so the causes
 * are read too. Nothing is lost: the lane keeps its cursor and scans the range
 * again on a later poll.
 */
export function isBackgroundStoreBusyFailure(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
      if (isStoreSchedulerBusyError(current)) return current.priority === 'background';
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // An unreadable error is no proof of a busy store.
  }
  return false;
}

/** Per lane: how many scans of the same range failed in a row, and how many met a busy store. */
export class ChainEventLaneScanFailures {
  private readonly streaks = new Map<string, { fromBlock: number; count: number }>();
  private readonly storeBusyTotals = new Map<string, number>();

  /** Records a failed scan from `fromBlock`; returns how many scans from it failed in a row. */
  failed(lane: string, fromBlock: number, storeBusy: boolean): number {
    const previous = this.streaks.get(lane);
    const count = previous?.fromBlock === fromBlock ? previous.count + 1 : 1;
    this.streaks.set(lane, { fromBlock, count });
    if (storeBusy) this.storeBusyTotals.set(lane, this.storeBusyScans(lane) + 1);
    return count;
  }

  /** The lane read its range, so the next failure starts a new streak. */
  succeeded(lane: string): void {
    this.streaks.delete(lane);
  }

  /** Scans of this lane that a busy store refused since the runner started. */
  storeBusyScans(lane: string): number {
    return this.storeBusyTotals.get(lane) ?? 0;
  }
}
