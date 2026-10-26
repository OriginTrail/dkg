import {
  asyncAdmissionUsage,
  createOperationContext,
  Logger,
  type AsyncAdmissionUsageSnapshot,
  type LatencySummary,
} from '@origintrail-official/dkg-core';
import { readLiftJournalEntryCount, readLiftQueueDepth, readShareQueueDepth } from '@origintrail-official/dkg-publisher';
import { takeStoreSchedulerStatsReports, type StoreSchedulerStatsReport, type TripleStore } from '@origintrail-official/dkg-storage';

/**
 * One `async_admission_usage` line every five minutes: how the async share and async publish
 * queues are doing, so an operator can tell whether admission or the workers are the slow part
 * (OT-RFC-73 P1b). OpenTelemetry is opt-in and the timeout warning is rate-limited, so this
 * line, which is neither, is the primary signal. It is logfmt, like `resource_usage`.
 *
 * Counters (`*_reclaimed`, `http=`, `store_rejections=` ...) are cumulative since the process
 * started and reset on restart. Latency, wait and pick-up figures (`*_n`, `*_p50_ms` ...) cover
 * the five minutes before the line, each with its sample count; an empty window prints `-`.
 * Depths are read when the line is built. Lists are `a/b:n,...` sorted by key, `-` when empty.
 *
 * Line shape (one line, wrapped here):
 *   async_admission_usage interval_s=300
 *     store_rejections=store/background/publisher.asyncLift/queue_full:3 store_max_wait_ms=store/ack:0,store/background:812
 *     http=publish_async/enqueue/202/-:41,publish_async/snapshot_preflight/503/store_busy:2 http_share_n=120 ...
 *     share_depth=failed:0,failed_retrying:0,queued:3,running:1,succeeded:200 lift_depth=accepted:2,... lift_journal=812 depth_errors=0
 *     share_reclaimed=0 share_abandoned=0 lift_reclaimed=0 lift_stale_claims=0
 *     share_hb_n=40 share_hb_p95_ms=12 ... share_claim_n=300 ... lift_wallets=2 lift_pickup_n=41 ...
 *
 * `http=` counts every admission request, 2xx included: `<route>/<phase>/<status>/<code>`, where
 * the phase is the step that answered (`request`, `write_preflight`, `intent_resolution`,
 * `snapshot_preflight`, `enqueue`) and status 0 is a client that left before any answer.
 */
export const ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS = 5 * 60_000;
/** A depth read still running after this is abandoned and the depths print `-`. */
export const ASYNC_ADMISSION_DEPTH_READ_TIMEOUT_MS = 15_000;

/** The queue depths of one line; `null` is a queue (or the journal) that could not be read. */
export interface AsyncQueueDepthReading {
  share: Record<string, number> | null;
  lift: Record<string, number> | null;
  liftJournal: number | null;
}

/** What the share worker supervisor counts; `null` while no supervisor runs. */
export interface ShareWorkerCountersView {
  attempted: number;
  succeeded: number;
  failedTerminal: number;
  failedRetrying: number;
}

export interface AsyncAdmissionUsageSample {
  /** Seconds since the previous line (0 for the first). */
  intervalSeconds: number;
  store: readonly StoreSchedulerStatsReport[];
  usage: AsyncAdmissionUsageSnapshot;
  depth: AsyncQueueDepthReading;
  /** Cumulative count of queue depth reads that failed or timed out. */
  depthErrors: number;
  shareWorker: ShareWorkerCountersView | null;
}

const UNKNOWN = '-';

function component(value: string | number): string {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function ms(value: number | null): string {
  return value === null ? UNKNOWN : `${Math.round(value)}`;
}

/** `key:n` entries sorted by key; `-` when there are none. */
function list(entries: Iterable<[string, number]>): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.length === 0 ? UNKNOWN : sorted.map(([key, n]) => `${key}:${n}`).join(',');
}

function depthList(depth: Record<string, number> | null): string {
  return depth === null ? UNKNOWN : list(Object.entries(depth).map(([state, n]) => [component(state), n]));
}

type Figure = 'p50' | 'p95' | 'p99' | 'max';

/** `<prefix>_n` and then the chosen figures of a window, in the order given. */
function windowFields(prefix: string, summary: LatencySummary, figures: readonly Figure[]): string[] {
  const value = {
    p50: summary.p50Ms, p95: summary.p95Ms, p99: summary.p99Ms, max: summary.maxMs,
  } satisfies Record<Figure, number | null>;
  return [`${prefix}_n=${summary.n}`, ...figures.map((figure) => `${prefix}_${figure}_ms=${ms(value[figure])}`)];
}

export function formatAsyncAdmissionUsageLine(sample: AsyncAdmissionUsageSample): string {
  const { usage, depth, shareWorker } = sample;
  const rejections: Array<[string, number]> = [];
  const maxWaits: Array<[string, number]> = [];
  for (const report of sample.store) {
    for (const r of report.rejections) {
      rejections.push([[report.scheduler, r.lane, r.family, r.reason].map(component).join('/'), r.count]);
    }
    for (const w of report.queueWaits) {
      maxWaits.push([[report.scheduler, w.lane].map(component).join('/'), Math.round(w.maxQueueWaitMs)]);
    }
  }
  const http = usage.http.map((entry): [string, number] => [
    [entry.route, entry.phase, entry.status, entry.code].map(component).join('/'),
    entry.count,
  ]);
  const counter = (value: number | undefined): string => (value === undefined ? UNKNOWN : `${value}`);
  const fields = [
    `interval_s=${Math.max(0, Math.round(sample.intervalSeconds))}`,
    `store_rejections=${list(rejections)}`,
    `store_max_wait_ms=${list(maxWaits)}`,
    `http=${list(http)}`,
    ...windowFields('http_share', usage.httpLatency.share_async, ['p50', 'p95', 'max']),
    ...windowFields('http_publish', usage.httpLatency.publish_async, ['p50', 'p95', 'max']),
    `share_depth=${depthList(depth.share)}`,
    `lift_depth=${depthList(depth.lift)}`,
    `lift_journal=${depth.liftJournal === null ? UNKNOWN : depth.liftJournal}`,
    `depth_errors=${sample.depthErrors}`,
    `share_reclaimed=${usage.shareReclaimed}`,
    `share_abandoned=${usage.shareAbandoned}`,
    `lift_reclaimed=${usage.liftReclaimed}`,
    `lift_stale_claims=${usage.liftStaleClaims}`,
    ...windowFields('share_hb', usage.shareHeartbeat, ['p95', 'p99', 'max']),
    `share_hb_pending=${usage.shareHeartbeat.pending}`,
    `share_hb_oldest_pending_ms=${ms(usage.shareHeartbeat.oldestPendingMs)}`,
    ...windowFields('share_claim', usage.shareClaim, ['p50', 'p95', 'max']),
    `share_attempted=${counter(shareWorker?.attempted)}`,
    `share_succeeded=${counter(shareWorker?.succeeded)}`,
    `share_failed_terminal=${counter(shareWorker?.failedTerminal)}`,
    `share_failed_retrying=${counter(shareWorker?.failedRetrying)}`,
    `lift_wallets=${usage.liftWallets}`,
    ...windowFields('lift_pickup', usage.liftPickup, ['p50', 'p95']),
    ...windowFields('lift_pickup_free', usage.liftPickupWorkerFree, ['p50', 'p95']),
    `lift_pickup_unclassified=${usage.liftPickupUnclassified}`,
    ...windowFields('lift_c2f', usage.liftClaimToFinish, ['p50', 'p95']),
    `lift_finalized=${usage.liftFinalized}`,
    `lift_failed=${usage.liftFailed}`,
  ];
  return `async_admission_usage ${fields.join(' ')}`;
}

/**
 * Reads both queues' depths and the journal's size, one after the other (they run on the store's
 * background lane, so a burst of three would only queue behind each other), each on its own so
 * one unreadable queue leaves the other's figures.
 */
export async function readAsyncQueueDepth(
  store: Pick<TripleStore, 'query'>,
  signal: AbortSignal,
): Promise<AsyncQueueDepthReading> {
  const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      return null;
    }
  };
  const share = await attempt(() => readShareQueueDepth(store, { signal }));
  const lift = await attempt(() => readLiftQueueDepth(store, { signal }));
  const liftJournal = await attempt(() => readLiftJournalEntryCount(store, { signal }));
  return { share, lift, liftJournal };
}

export interface AsyncAdmissionUsageLogOptions {
  emit?: (line: string) => void;
  /** Takes the interval's figures. Only the periodic line may take them. */
  capture?: () => { store: readonly StoreSchedulerStatsReport[]; usage: AsyncAdmissionUsageSnapshot };
  readDepth?: (signal: AbortSignal) => Promise<AsyncQueueDepthReading>;
  shareWorkerCounters?: () => ShareWorkerCountersView | null;
  intervalMs?: number;
  depthTimeoutMs?: number;
  now?: () => number;
}

const NO_DEPTH: AsyncQueueDepthReading = { share: null, lift: null, liftJournal: null };

/** Log one line now and one every `intervalMs` until stopped. */
export function startAsyncAdmissionUsageLog(options: AsyncAdmissionUsageLogOptions = {}): { stop(): void } {
  const logger = new Logger('admission');
  const emit = options.emit ?? ((line: string) => logger.info(createOperationContext('system'), line));
  const capture = options.capture ?? (() => ({
    store: takeStoreSchedulerStatsReports(),
    usage: asyncAdmissionUsage.take(),
  }));
  const now = options.now ?? (() => Date.now());
  const depthTimeoutMs = options.depthTimeoutMs ?? ASYNC_ADMISSION_DEPTH_READ_TIMEOUT_MS;
  let lastLineAt = now();
  let depthErrors = 0;
  let depthRead: Promise<unknown> | null = null;

  /** Never two reads at once: a read that outlived its deadline blocks the next until it settles. */
  const readDepth = async (): Promise<AsyncQueueDepthReading> => {
    if (!options.readDepth || depthRead !== null) return NO_DEPTH;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = options.readDepth(controller.signal);
      depthRead = read.then(() => undefined, () => undefined).finally(() => { depthRead = null; });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('async queue depth read timed out'));
        }, depthTimeoutMs);
        timer.unref?.();
      });
      const reading = await Promise.race([read, deadline]);
      depthErrors += Object.values(reading).filter((value) => value === null).length;
      return reading;
    } catch {
      depthErrors += 1;
      return NO_DEPTH;
    } finally {
      clearTimeout(timer);
    }
  };

  const write = async (): Promise<void> => {
    try {
      const at = now();
      const intervalSeconds = (at - lastLineAt) / 1000;
      lastLineAt = at;
      const captured = capture();
      const depth = await readDepth();
      if (depth.share) asyncAdmissionUsage.recordQueueDepth('share', depth.share);
      if (depth.lift) asyncAdmissionUsage.recordQueueDepth('lift', depth.lift);
      if (depth.liftJournal !== null) asyncAdmissionUsage.recordJournalEntries(depth.liftJournal);
      emit(formatAsyncAdmissionUsageLine({
        intervalSeconds,
        store: captured.store,
        usage: captured.usage,
        depth,
        depthErrors,
        shareWorker: options.shareWorkerCounters?.() ?? null,
      }));
    } catch {
      // A failed sample is skipped; the next one is taken on time.
    }
  };

  void write();
  const timer = setInterval(() => { void write(); }, options.intervalMs ?? ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
