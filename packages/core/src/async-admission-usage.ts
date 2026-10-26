import { IntervalLatency, type LatencySummary } from './interval-latency.js';
import { WalletBusyTracker } from './wallet-busy-tracker.js';
import { getMetrics } from './telemetry-api.js';

export type { LatencySummary } from './interval-latency.js';

/**
 * In-process figures for the async share and async publish queues, read once every five
 * minutes by the daemon's `async_admission_usage` line (OT-RFC-73 P1b). OpenTelemetry is
 * opt-in, so these counters and windows are the primary signal; each recorder also writes
 * the matching OTel instrument for nodes that export metrics.
 *
 * Counters are cumulative since process start. Latency, wait and pick-up figures are
 * windows: {@link AsyncAdmissionUsage.take} returns the samples since the previous call and
 * empties them, so only the periodic line may call it. Every recorder swallows its own
 * failure: bookkeeping must never reach queue code.
 */

export type AsyncAdmissionRoute = 'share_async' | 'publish_async';

/** The step that answered a request (or that it was in when the client left). */
export type AsyncAdmissionPhase =
  | 'request'
  | 'write_preflight'
  | 'intent_resolution'
  | 'snapshot_preflight'
  | 'enqueue';

export type AsyncQueueName = 'share' | 'lift';

export interface AsyncAdmissionHttpCount {
  route: AsyncAdmissionRoute;
  phase: AsyncAdmissionPhase;
  status: number;
  code: string;
  count: number;
}

export interface AsyncAdmissionUsageSnapshot {
  /** Cumulative, sorted by route, phase, status and code. */
  http: AsyncAdmissionHttpCount[];
  /** Window: request start to response, every outcome. */
  httpLatency: Record<AsyncAdmissionRoute, LatencySummary>;
  shareReclaimed: number;
  shareAbandoned: number;
  /** Window: lease-renewal call duration, mutex wait included. `pending` is a gauge. */
  shareHeartbeat: LatencySummary & { pending: number; oldestPendingMs: number };
  /** Window: `claimNext` duration, mutex wait and idle polls included. */
  shareClaim: LatencySummary;
  liftReclaimed: number;
  liftStaleClaims: number;
  liftFinalized: number;
  liftFailed: number;
  /** Gauge: wallets that run publisher workers. */
  liftWallets: number;
  /** Window: ready to claimed, every job. */
  liftPickup: LatencySummary;
  /** Window: ready to claimed, only jobs that became ready while a configured wallet was free. */
  liftPickupWorkerFree: LatencySummary;
  /** Cumulative: jobs whose wallet state at ready time could not be determined. */
  liftPickupUnclassified: number;
  /** Window: claimed to finalized. */
  liftClaimToFinish: LatencySummary;
}

/** Distinct (route, phase, status, code) counters kept; after that a new code counts as `other` for its route, phase and status. */
const MAX_HTTP_KEYS = 64;
const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,48}$/;

function sanitizeCode(code: unknown): string {
  return typeof code === 'string' && CODE_PATTERN.test(code) ? code : '-';
}

function sanitizeStatus(status: unknown): number {
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? (status as number) : 0;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safely(record: () => void): void {
  try {
    record();
  } catch {
    // Bookkeeping must never throw into the queues.
  }
}

export class AsyncAdmissionUsage {
  private readonly clock: () => number;
  private readonly httpCounts = new Map<string, AsyncAdmissionHttpCount>();
  private readonly httpLatency: Record<AsyncAdmissionRoute, IntervalLatency> = {
    share_async: new IntervalLatency(),
    publish_async: new IntervalLatency(),
  };
  private shareReclaimed = 0;
  private shareAbandoned = 0;
  private readonly shareHeartbeat = new IntervalLatency();
  private readonly pendingHeartbeats = new Map<number, number>();
  private heartbeatSeq = 0;
  private readonly shareClaim = new IntervalLatency();
  private liftReclaimed = 0;
  private liftStaleClaims = 0;
  private liftFinalized = 0;
  private liftFailed = 0;
  private liftPickupUnclassified = 0;
  private readonly liftPickup = new IntervalLatency();
  private readonly liftPickupWorkerFree = new IntervalLatency();
  private readonly liftClaimToFinish = new IntervalLatency();
  private wallets = new WalletBusyTracker();

  /** `clock` is a monotonic millisecond clock for durations; pick-up times come from the caller. */
  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? (() => performance.now());
  }

  /** One finished admission request. Status 0 means the client left before any response. */
  recordHttpOutcome(outcome: {
    route: AsyncAdmissionRoute;
    phase: AsyncAdmissionPhase;
    status: number;
    code: string;
    latencyMs: number;
  }): void {
    safely(() => {
      const { route, phase } = outcome;
      const status = sanitizeStatus(outcome.status);
      let code = sanitizeCode(outcome.code);
      let key = `${route}/${phase}/${status}/${code}`;
      let entry = this.httpCounts.get(key);
      if (!entry && this.httpCounts.size >= MAX_HTTP_KEYS) {
        code = 'other';
        key = `${route}/${phase}/${status}/${code}`;
        entry = this.httpCounts.get(key);
      }
      if (!entry) {
        entry = { route, phase, status, code, count: 0 };
        this.httpCounts.set(key, entry);
      }
      entry.count += 1;
      this.httpLatency[route].record(outcome.latencyMs);
      const metrics = getMetrics();
      metrics.asyncAdmissionOutcomesTotal.add(1, { route, phase, status: String(status), code });
      if (Number.isFinite(outcome.latencyMs) && outcome.latencyMs >= 0) {
        metrics.asyncAdmissionLatencyMs.record(outcome.latencyMs, { route });
      }
    });
  }

  /** Counts what a share lease sweep reclaimed and abandoned, and returns the summary unchanged. */
  recordShareLeaseRecovery<T extends { reclaimed: number; abandoned: number }>(summary: T): T {
    safely(() => {
      const reclaimed = count(summary?.reclaimed);
      const abandoned = count(summary?.abandoned);
      this.shareReclaimed += reclaimed;
      this.shareAbandoned += abandoned;
      const metrics = getMetrics();
      if (reclaimed > 0) metrics.asyncQueueLeaseRecoveriesTotal.add(reclaimed, { queue: 'share', outcome: 'reclaimed' });
      if (abandoned > 0) metrics.asyncQueueLeaseRecoveriesTotal.add(abandoned, { queue: 'share', outcome: 'abandoned' });
    });
    return summary;
  }

  /** Times one share `claimNext`, whether it resolves or rejects, and passes the outcome through. */
  async timeShareClaim<T>(run: () => Promise<T>): Promise<T> {
    const start = this.clock();
    try {
      return await run();
    } finally {
      safely(() => {
        const elapsed = this.clock() - start;
        this.shareClaim.record(elapsed);
        getMetrics().asyncShareClaimNextMs.record(elapsed);
      });
    }
  }

  /**
   * Times one lease renewal from the call to its settlement, so a renewal waiting behind the
   * share mutex counts as late, and tracks it as pending until then. The outcome is passed
   * through: a rejection still reaches the caller's own handler.
   */
  observeShareHeartbeat<T>(call: Promise<T>): Promise<T> {
    const id = ++this.heartbeatSeq;
    const start = this.clock();
    this.pendingHeartbeats.set(id, start);
    const settle = (): void => {
      this.pendingHeartbeats.delete(id);
      safely(() => {
        const elapsed = this.clock() - start;
        this.shareHeartbeat.record(elapsed);
        getMetrics().asyncQueueHeartbeatLatenessMs.record(elapsed);
      });
    };
    return Promise.resolve(call).then(
      (value) => {
        settle();
        return value;
      },
      (error: unknown) => {
        settle();
        throw error;
      },
    );
  }

  /** A claimed publisher job whose claim token no longer matched when its worker acted. */
  recordLiftStaleClaim(): void {
    safely(() => {
      this.liftStaleClaims += 1;
      getMetrics().asyncQueueStaleClaimsTotal.add(1, { queue: 'lift' });
    });
  }

  /** A claimed publisher job reset to accepted by recovery. */
  recordLiftReclaim(): void {
    safely(() => {
      this.liftReclaimed += 1;
      getMetrics().asyncQueueLeaseRecoveriesTotal.add(1, { queue: 'lift', outcome: 'reclaimed' });
    });
  }

  /** The wallets that run publisher workers; set when the runner starts and emptied when it stops. */
  setLiftWallets(walletIds: readonly string[]): void {
    safely(() => {
      this.wallets.setConfigured(walletIds);
      getMetrics().asyncLiftConfiguredWallets.record(this.wallets.configuredCount);
    });
  }

  liftWalletBusy(walletId: string, atMs: number): void {
    safely(() => this.wallets.markBusy(walletId, atMs));
  }

  liftWalletFree(walletId: string, atMs: number): void {
    safely(() => this.wallets.markFree(walletId, atMs));
  }

  /** A read of a wallet's lock: `usable` is true while an unexpired active lock is held. */
  liftWalletObserved(walletId: string, usable: boolean, atMs: number): void {
    safely(() => this.wallets.observe(walletId, usable, atMs));
  }

  /**
   * A publisher job was claimed. Its pick-up wait runs from `readyAtMs` (the latest of
   * accepted, retried and recovered) to `claimedAtMs`. It also joins the worker-free sample
   * when a configured wallet held no lock at `readyAtMs`; a job whose wallet state at that
   * instant is unknown is counted as unclassified and left out of that sample.
   */
  recordLiftClaim(readyAtMs: number, claimedAtMs: number): void {
    safely(() => {
      if (!Number.isFinite(readyAtMs) || !Number.isFinite(claimedAtMs)) return;
      const wait = Math.max(0, claimedAtMs - readyAtMs);
      const availability = this.wallets.classify(readyAtMs);
      this.liftPickup.record(wait);
      if (availability === 'free') this.liftPickupWorkerFree.record(wait);
      else if (availability === 'unknown') this.liftPickupUnclassified += 1;
      getMetrics().asyncLiftPickupMs.record(wait, {
        worker_free: availability === 'free' ? 'true' : availability === 'busy' ? 'false' : 'unknown',
      });
    });
  }

  /** A publisher job reached a terminal state. Only a finalized job has a claim-to-finish time. */
  recordLiftFinish(status: string, claimedAtMs: number | undefined, finishedAtMs: number): void {
    safely(() => {
      if (status === 'failed') {
        this.liftFailed += 1;
        return;
      }
      if (status !== 'finalized') return;
      this.liftFinalized += 1;
      if (claimedAtMs === undefined || !Number.isFinite(claimedAtMs) || !Number.isFinite(finishedAtMs)) return;
      const elapsed = Math.max(0, finishedAtMs - claimedAtMs);
      this.liftClaimToFinish.record(elapsed);
      getMetrics().asyncLiftClaimToFinishMs.record(elapsed);
    });
  }

  /** Publishes a queue's jobs per state to the OTel depth gauge. */
  recordQueueDepth(queue: AsyncQueueName, states: Readonly<Record<string, number>>): void {
    safely(() => {
      const gauge = getMetrics().asyncQueueDepth;
      for (const [state, depth] of Object.entries(states)) gauge.record(depth, { queue, state });
    });
  }

  recordJournalEntries(entries: number): void {
    safely(() => getMetrics().asyncQueueJournalEntries.record(entries));
  }

  /** The cumulative counters as they stand, and the windows since the previous call, which then start empty. */
  take(): AsyncAdmissionUsageSnapshot {
    const now = this.clock();
    let oldestPendingMs = 0;
    for (const start of this.pendingHeartbeats.values()) oldestPendingMs = Math.max(oldestPendingMs, now - start);
    return {
      http: [...this.httpCounts.values()]
        .map((entry) => ({ ...entry }))
        .sort((a, b) => (
          a.route.localeCompare(b.route)
          || a.phase.localeCompare(b.phase)
          || a.status - b.status
          || a.code.localeCompare(b.code)
        )),
      httpLatency: {
        share_async: this.httpLatency.share_async.take(),
        publish_async: this.httpLatency.publish_async.take(),
      },
      shareReclaimed: this.shareReclaimed,
      shareAbandoned: this.shareAbandoned,
      shareHeartbeat: {
        ...this.shareHeartbeat.take(),
        pending: this.pendingHeartbeats.size,
        oldestPendingMs,
      },
      shareClaim: this.shareClaim.take(),
      liftReclaimed: this.liftReclaimed,
      liftStaleClaims: this.liftStaleClaims,
      liftFinalized: this.liftFinalized,
      liftFailed: this.liftFailed,
      liftWallets: this.wallets.configuredCount,
      liftPickup: this.liftPickup.take(),
      liftPickupWorkerFree: this.liftPickupWorkerFree.take(),
      liftPickupUnclassified: this.liftPickupUnclassified,
      liftClaimToFinish: this.liftClaimToFinish.take(),
    };
  }

  /** Forgets everything. For tests, which share the process-wide instance. */
  reset(): void {
    this.httpCounts.clear();
    this.pendingHeartbeats.clear();
    this.shareReclaimed = this.shareAbandoned = 0;
    this.liftReclaimed = this.liftStaleClaims = this.liftFinalized = this.liftFailed = 0;
    this.liftPickupUnclassified = 0;
    this.wallets = new WalletBusyTracker();
    this.take();
  }
}

/** The process-wide instance the queues and the daemon share. */
export const asyncAdmissionUsage = new AsyncAdmissionUsage();
