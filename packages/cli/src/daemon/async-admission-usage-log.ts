import {
  asyncAdmissionUsage,
  createOperationContext,
  Logger,
  type AsyncAdmissionUsageSnapshot,
  type LatencySummary,
} from '@origintrail-official/dkg-core';
import { readLiftJournalEntryCount, readLiftQueueDepth, readShareQueueDepth } from '@origintrail-official/dkg-publisher';
import {
  estimateQueueWaitPercentileMs,
  STORE_QUEUE_WAIT_BUCKET_UPPER_MS,
  takeStoreSchedulerStatsReports,
  type StoreSchedulerStatsReport,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { getWritePreflightCoalescingCounters, type WritePreflightCoalescingCounters } from './write-preflight-coalescing.js';
import type { RetentionQueueName, RetentionUsageView } from './retention-timer.js';

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
 *     store_wait_n=store/ack:412,store/background:57 store_wait_p95_ms=store/ack:1,store/background:539
 *     store_wait_buckets=store/ack:1x400|2x10|9x2,store/background:31x50|539x7
 *     http=publish_async/enqueue/202/-:41,publish_async/snapshot_preflight/503/store_busy:2 http_share_n=120 ...
 *     share_depth=failed:0,failed_retrying:0,queued:3,running:1,succeeded:200 lift_depth=accepted:2,... lift_journal=812 depth_errors=0
 *     share_reclaimed=0 share_abandoned=0 lift_reclaimed=0 lift_stale_claims=0
 *     share_hb_n=40 share_hb_p95_ms=12 ... share_claim_n=300 ... lift_wallets=2 lift_pickup_n=41 ...
 *     ... lift_finalized=40 lift_failed=3 preflight_flights=812 preflight_joins=3390 preflight_cache_hits=0 preflight_cache_stores=0 preflight_direct=0
 *
 * `store_wait_p95_ms` is an upper bound: the top of the fixed bucket (about 10 % wider than the one below, 1 to
 * 10000 ms) holding the 95th-percentile wait, so the true P95 is at most that and up to one step lower; past
 * 10000 ms it is the interval's longest wait. It is 0 for a lane with no wait (`store_wait_n` is that lane's
 * count), and `store/ack` is the storage-ACK queue-wait P95. P95s of single lines cannot be merged, so the line
 * also prints `store_wait_buckets`, the lane's wait counts as `<upper bound ms>x<count>` for each bucket that
 * holds a wait, ascending, joined by `|` (`infx<count>` past 10000 ms, `-` for none). Adding those counts over
 * the lines of a test cell or a monitoring window gives that window's P95 (packages/cli/docs/async-admission-usage-line.md).
 *
 * `preflight_*` are cumulative counts of the write preflight's coalescing (`write-preflight-coalescing.ts`): probes
 * started, calls that joined one, calls served from the result cache, probes kept in it, and calls probed outright.
 * `-` when the sample carries none.
 *
 * Queue retention (OT-RFC-73 P10b, P11) appends fields only while a retention sweep runs (a queue whose mode is not `off`), so the line is unchanged by default. Per
 * sweep, with the prefix `share_retention` (the publisher's is `lift_retention`, with the single class `finalized` and the publisher's own reasons):
 *     share_retention=report share_retention_ticks=12 share_retention_deleted=cancelled:0,retired_no_effect:0,succeeded:0
 *     share_retention_kept=failed_retained:2,too_recent:40 share_retention_skipped=clock_jump:1 share_retention_errors=scan:1
 *     share_retention_pass_scanned=300 share_retention_pass_would_delete=cancelled:1,retired_no_effect:0,succeeded:240 share_retention_pass_deleted=cancelled:0,...
 * `_deleted`, `_kept` (judgments by reason), `_skipped` (ticks not run, by reason) and `_errors` (by phase, `tick` for a batch that threw) are cumulative since the
 * process started; `_kept`, `_skipped` and `_errors` list only what is not zero. The `_pass_` fields are a gauge of the latest COMPLETE pass, not cumulative (`-`
 * until one completed): in report mode `_pass_would_delete` counts what the latest pass would remove (see "Before you switch to delete" in
 * docs/use-dkg/async-queue-operations.md). The `cancelled` class counts only jobs whose every attempt is proven
 * unstarted at an integer format of 2 or more; packages/publisher/docs/async-queue-internals.md states that rule and its two limits.
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
  /** Cumulative count of queue depth reads that failed, timed out, or were skipped behind a hung one. */
  depthErrors: number;
  shareWorker: ShareWorkerCountersView | null;
  /** What write preflight coalescing has done since the daemon started; absent prints `-`. */
  preflight?: Readonly<WritePreflightCoalescingCounters>;
  /** The running retention sweeps; absent or empty prints nothing. */
  retention?: readonly RetentionUsageView[];
}

const UNKNOWN = '-';

function component(value: string | number): string {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function ms(value: number | null): string {
  return value === null ? UNKNOWN : `${Math.round(value)}`;
}

/** `key:value` entries sorted by key; `-` when there are none. */
function list(entries: Iterable<[string, number | string]>): string {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.length === 0 ? UNKNOWN : sorted.map(([key, n]) => `${key}:${n}`).join(',');
}

function depthList(depth: Record<string, number> | null): string {
  return depth === null ? UNKNOWN : list(Object.entries(depth).map(([state, n]) => [component(state), n]));
}

/** A lane's wait counts: `<upper bound ms>x<count>` for each bucket that holds a wait (`inf` for the overflow bucket), `|`-joined; `-` for none. */
function waitBucketCounts(buckets: readonly number[]): string {
  const counts: string[] = [];
  buckets.forEach((count, index) => {
    if (count > 0) counts.push(`${STORE_QUEUE_WAIT_BUCKET_UPPER_MS[index] ?? 'inf'}x${count}`);
  });
  return counts.length === 0 ? UNKNOWN : counts.join('|');
}

type Figure = 'p50' | 'p95' | 'p99' | 'max';

/** `<prefix>_n` and then the chosen figures of a window, in the order given. */
function windowFields(prefix: string, summary: LatencySummary, figures: readonly Figure[]): string[] {
  const value = {
    p50: summary.p50Ms, p95: summary.p95Ms, p99: summary.p99Ms, max: summary.maxMs,
  } satisfies Record<Figure, number | null>;
  return [`${prefix}_n=${summary.n}`, ...figures.map((figure) => `${prefix}_${figure}_ms=${ms(value[figure])}`)];
}

const RETENTION_PREFIX: Record<RetentionQueueName, string> = { share: 'share_retention', publisher: 'lift_retention' };

/** `key:count` entries sorted by key; with `omitZero` only the keys that are not zero. */
function retentionCounts(counts: Readonly<Record<string, number>>, omitZero: boolean): string {
  return list(Object.entries(counts).filter(([, n]) => !omitZero || n !== 0).map(([key, n]): [string, number] => [component(key), n]));
}

function retentionFields(views: readonly RetentionUsageView[] | undefined): string[] {
  return (views ?? []).flatMap((view) => {
    const prefix = RETENTION_PREFIX[view.queue];
    const pass = view.lastCompletePass;
    return [
      `${prefix}=${view.mode}`,
      `${prefix}_ticks=${view.ticks}`,
      `${prefix}_deleted=${retentionCounts(view.deleted, false)}`,
      `${prefix}_kept=${retentionCounts(view.kept, true)}`,
      `${prefix}_skipped=${retentionCounts(view.skipped, true)}`,
      `${prefix}_errors=${retentionCounts(view.errors, true)}`,
      `${prefix}_pass_scanned=${pass ? pass.scanned : UNKNOWN}`,
      `${prefix}_pass_would_delete=${pass ? retentionCounts(pass.wouldDelete, false) : UNKNOWN}`,
      `${prefix}_pass_deleted=${pass ? retentionCounts(pass.deleted, false) : UNKNOWN}`,
    ];
  });
}

export function formatAsyncAdmissionUsageLine(sample: AsyncAdmissionUsageSample): string {
  const { usage, depth, shareWorker, preflight } = sample;
  const rejections: Array<[string, number]> = [];
  const maxWaits: Array<[string, number]> = [];
  const waitCounts: Array<[string, number]> = [];
  const waitP95s: Array<[string, number]> = [];
  const waitBuckets: Array<[string, string]> = [];
  for (const report of sample.store) {
    for (const r of report.rejections) {
      rejections.push([[report.scheduler, r.lane, r.family, r.reason].map(component).join('/'), r.count]);
    }
    for (const w of report.queueWaits) {
      const key = [report.scheduler, w.lane].map(component).join('/');
      maxWaits.push([key, Math.round(w.maxQueueWaitMs)]);
      waitCounts.push([key, w.queueWaitCount]);
      waitP95s.push([key, Math.round(estimateQueueWaitPercentileMs(w.queueWaitBuckets, 0.95, w.maxQueueWaitMs))]);
      waitBuckets.push([key, waitBucketCounts(w.queueWaitBuckets)]);
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
    `store_wait_n=${list(waitCounts)}`,
    `store_wait_p95_ms=${list(waitP95s)}`,
    `store_wait_buckets=${list(waitBuckets)}`,
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
    `preflight_flights=${counter(preflight?.flights)}`,
    `preflight_joins=${counter(preflight?.joins)}`,
    `preflight_cache_hits=${counter(preflight?.cacheHits)}`,
    `preflight_cache_stores=${counter(preflight?.cacheStores)}`,
    `preflight_direct=${counter(preflight?.direct)}`,
    ...retentionFields(sample.retention),
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
  /** The write preflight coalescer's counters; the live ones by default. */
  preflightCounters?: () => Readonly<WritePreflightCoalescingCounters>;
  /** The running retention sweeps' figures (OT-RFC-73 P10b); the line prints them only while a sweep runs. */
  retention?: () => readonly RetentionUsageView[];
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
    if (!options.readDepth) return NO_DEPTH;
    if (depthRead !== null) {
      depthErrors += 1; // a hung store must read as an error, not only as `-`
      return NO_DEPTH;
    }
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

  /** The retention figures never cost the line: a provider that fails prints no retention fields. */
  const readRetention = (): readonly RetentionUsageView[] | undefined => {
    try {
      return options.retention?.();
    } catch {
      return undefined;
    }
  };

  const write = async (): Promise<void> => {
    try {
      const at = now();
      const intervalSeconds = (at - lastLineAt) / 1000;
      lastLineAt = at;
      const captured = capture();
      asyncAdmissionUsage.republishLiftWallets(); // before the depth read, which may hang
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
        preflight: (options.preflightCounters ?? getWritePreflightCoalescingCounters)(),
        retention: readRetention(),
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
