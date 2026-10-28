import type { StoreWorkPriority } from './triple-store.js';
import { storeWorkPriorityRank } from './store-priority-scheduler.js';

export interface RefreshFlight<T> {
  readonly priority: StoreWorkPriority;
  readonly task: Promise<T>;
  lastScanSequence: number;
}

interface RefreshScan {
  readonly sequence: number;
}

/**
 * Coordinates priority-promoted refresh flights independently of graph-cache
 * mechanics. A caller may reuse a flight at its own or a higher priority; a
 * higher-priority caller starts a separate flight. Monotonic scan tokens then
 * fence both stale publication and stale failure handling.
 */
export class RefreshCoordinator<T> {
  private readonly flights = new Map<StoreWorkPriority, RefreshFlight<T>>();
  private nextScanSequence = 0;
  private latestPublishedScanSequence = 0;

  run(
    priority: StoreWorkPriority,
    start: (flight: RefreshFlight<T>) => Promise<T>,
  ): Promise<T> {
    const reusable = this.bestReusableFlight(priority);
    if (reusable) return reusable.task;

    // Register the flight before its work starts so even a re-entrant caller
    // sees a complete single-flight view.
    let resolveTask!: (value: T) => void;
    let rejectTask!: (reason?: unknown) => void;
    const task = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const flight: RefreshFlight<T> = { priority, task, lastScanSequence: 0 };
    this.flights.set(priority, flight);
    void (async () => {
      try {
        resolveTask(await start(flight));
      } catch (error: unknown) {
        rejectTask(error);
      } finally {
        if (this.flights.get(priority) === flight) this.flights.delete(priority);
      }
    })();
    return task;
  }

  beginScan(flight: RefreshFlight<T>): RefreshScan {
    const scan = { sequence: ++this.nextScanSequence };
    flight.lastScanSequence = scan.sequence;
    return scan;
  }

  tryPublish(scan: RefreshScan): boolean {
    if (scan.sequence < this.latestPublishedScanSequence) return false;
    this.latestPublishedScanSequence = scan.sequence;
    return true;
  }

  shouldApplyFailureBackoff(flight: RefreshFlight<T>): boolean {
    return flight.lastScanSequence >= this.latestPublishedScanSequence;
  }

  private bestReusableFlight(priority: StoreWorkPriority): RefreshFlight<T> | undefined {
    const requestedRank = storeWorkPriorityRank(priority);
    let best: RefreshFlight<T> | undefined;
    for (const candidate of this.flights.values()) {
      const candidateRank = storeWorkPriorityRank(candidate.priority);
      if (candidateRank > requestedRank) continue;
      if (!best || candidateRank < storeWorkPriorityRank(best.priority)) best = candidate;
    }
    return best;
  }
}
