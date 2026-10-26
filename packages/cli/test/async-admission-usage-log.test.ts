import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asyncAdmissionUsage,
  createLogRedactor,
  Logger,
  type AsyncAdmissionUsageSnapshot,
  type LatencySummary,
} from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  registerStoreSchedulerStats,
  STORE_QUEUE_WAIT_BUCKET_UPPER_MS,
  type StoreSchedulerLaneWait,
  type StoreSchedulerStatsReport,
} from '@origintrail-official/dkg-storage';
import {
  ASYNC_ADMISSION_DEPTH_READ_TIMEOUT_MS,
  ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS,
  formatAsyncAdmissionUsageLine,
  readAsyncQueueDepth,
  startAsyncAdmissionUsageLog,
  type AsyncAdmissionUsageSample,
  type AsyncQueueDepthReading,
} from '../src/daemon/async-admission-usage-log.js';

const EMPTY: LatencySummary = { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
const summary = (n: number, p50: number, p95: number, p99: number, max: number): LatencySummary =>
  ({ n, p50Ms: p50, p95Ms: p95, p99Ms: p99, maxMs: max });

function usage(over: Partial<AsyncAdmissionUsageSnapshot> = {}): AsyncAdmissionUsageSnapshot {
  return {
    http: [],
    httpLatency: { share_async: EMPTY, publish_async: EMPTY },
    shareReclaimed: 0,
    shareAbandoned: 0,
    shareHeartbeat: { ...EMPTY, pending: 0, oldestPendingMs: 0 },
    shareClaim: EMPTY,
    liftReclaimed: 0,
    liftStaleClaims: 0,
    liftFinalized: 0,
    liftFailed: 0,
    liftWallets: 0,
    liftPickup: EMPTY,
    liftPickupWorkerFree: EMPTY,
    liftPickupUnclassified: 0,
    liftClaimToFinish: EMPTY,
    ...over,
  };
}

const SHARE_DEPTH = { queued: 3, running: 1, failed_retrying: 0, succeeded: 200, failed: 2 };
const LIFT_DEPTH = { accepted: 2, claimed: 1, validated: 0, broadcast: 1, included: 0, finalized: 40, failed: 3 };
const DEPTH: AsyncQueueDepthReading = { share: SHARE_DEPTH, lift: LIFT_DEPTH, liftJournal: 812 };

/** A lane whose only wait in the interval was `maxQueueWaitMs` (none when 0), counted in its bucket. */
function laneWait(lane: string, maxQueueWaitMs: number): StoreSchedulerLaneWait {
  const queueWaitBuckets = new Array<number>(STORE_QUEUE_WAIT_BUCKET_UPPER_MS.length + 1).fill(0);
  if (maxQueueWaitMs > 0) {
    const bucket = STORE_QUEUE_WAIT_BUCKET_UPPER_MS.findIndex((upper) => maxQueueWaitMs <= upper);
    queueWaitBuckets[bucket < 0 ? STORE_QUEUE_WAIT_BUCKET_UPPER_MS.length : bucket] = 1;
  }
  return { lane, maxQueueWaitMs, queueWaitCount: maxQueueWaitMs > 0 ? 1 : 0, queueWaitBuckets };
}

const storeReport: StoreSchedulerStatsReport = {
  scheduler: 'store',
  queueWaits: [
    laneWait('ack', 0),
    laneWait('health', 0),
    laneWait('normal', 120),
    laneWait('background', 812.4),
  ],
  rejections: [
    { lane: 'normal', family: 'agent.writePreflight', reason: 'queue_wait_timeout', count: 1 },
    { lane: 'background', family: 'publisher.asyncLift', reason: 'queue_full', count: 3 },
  ],
};

const busy: AsyncAdmissionUsageSample = {
  intervalSeconds: 300.4,
  store: [storeReport],
  usage: usage({
    http: [
      { route: 'share_async', phase: 'enqueue', status: 200, code: '-', count: 120 },
      { route: 'publish_async', phase: 'snapshot_preflight', status: 503, code: 'STORE_SCHEDULER_BUSY', count: 2 },
      { route: 'publish_async', phase: 'enqueue', status: 202, code: '-', count: 41 },
    ],
    httpLatency: { share_async: summary(120, 40.4, 210.6, 400, 900), publish_async: summary(43, 1500, 4200.5, 5000, 9000.2) },
    shareReclaimed: 1,
    shareAbandoned: 2,
    liftReclaimed: 3,
    liftStaleClaims: 4,
    liftFinalized: 40,
    liftFailed: 3,
    shareHeartbeat: { ...summary(40, 5, 12.4, 30, 77), pending: 2, oldestPendingMs: 1500.7 },
    shareClaim: summary(300, 2, 9, 20, 210),
    liftWallets: 2,
    liftPickup: summary(41, 900, 4800, 6000, 9000),
    liftPickupWorkerFree: summary(30, 400, 1200, 2000, 3000),
    liftPickupUnclassified: 5,
    liftClaimToFinish: summary(38, 12_000, 15_500, 20_000, 30_000),
  }),
  depth: DEPTH,
  depthErrors: 0,
  shareWorker: { attempted: 210, succeeded: 200, failedTerminal: 2, failedRetrying: 8 },
};

const idle: AsyncAdmissionUsageSample = {
  intervalSeconds: 0,
  store: [],
  usage: usage(),
  depth: { share: null, lift: null, liftJournal: null },
  depthErrors: 0,
  shareWorker: null,
};

beforeEach(() => {
  asyncAdmissionUsage.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('async_admission_usage line', () => {
  it('carries every figure in a fixed order', () => {
    expect(formatAsyncAdmissionUsageLine(busy)).toBe([
      'async_admission_usage',
      'interval_s=300',
      'store_rejections=store/background/publisher.asyncLift/queue_full:3,store/normal/agent.writePreflight/queue_wait_timeout:1',
      'store_max_wait_ms=store/ack:0,store/background:812,store/health:0,store/normal:120',
      'http=publish_async/enqueue/202/-:41,publish_async/snapshot_preflight/503/STORE_SCHEDULER_BUSY:2,share_async/enqueue/200/-:120',
      'http_share_n=120 http_share_p50_ms=40 http_share_p95_ms=211 http_share_max_ms=900',
      'http_publish_n=43 http_publish_p50_ms=1500 http_publish_p95_ms=4201 http_publish_max_ms=9000',
      'share_depth=failed:2,failed_retrying:0,queued:3,running:1,succeeded:200',
      'lift_depth=accepted:2,broadcast:1,claimed:1,failed:3,finalized:40,included:0,validated:0',
      'lift_journal=812 depth_errors=0',
      'share_reclaimed=1 share_abandoned=2 lift_reclaimed=3 lift_stale_claims=4',
      'share_hb_n=40 share_hb_p95_ms=12 share_hb_p99_ms=30 share_hb_max_ms=77 share_hb_pending=2 share_hb_oldest_pending_ms=1501',
      'share_claim_n=300 share_claim_p50_ms=2 share_claim_p95_ms=9 share_claim_max_ms=210',
      'share_attempted=210 share_succeeded=200 share_failed_terminal=2 share_failed_retrying=8',
      'lift_wallets=2',
      'lift_pickup_n=41 lift_pickup_p50_ms=900 lift_pickup_p95_ms=4800',
      'lift_pickup_free_n=30 lift_pickup_free_p50_ms=400 lift_pickup_free_p95_ms=1200 lift_pickup_unclassified=5',
      'lift_c2f_n=38 lift_c2f_p50_ms=12000 lift_c2f_p95_ms=15500',
      'lift_finalized=40 lift_failed=3',
    ].join(' '));
  });

  it('prints "-" for empty windows, empty lists, unreadable depths and a missing share worker', () => {
    expect(formatAsyncAdmissionUsageLine(idle)).toBe([
      'async_admission_usage interval_s=0 store_rejections=- store_max_wait_ms=- http=-',
      'http_share_n=0 http_share_p50_ms=- http_share_p95_ms=- http_share_max_ms=-',
      'http_publish_n=0 http_publish_p50_ms=- http_publish_p95_ms=- http_publish_max_ms=-',
      'share_depth=- lift_depth=- lift_journal=- depth_errors=0',
      'share_reclaimed=0 share_abandoned=0 lift_reclaimed=0 lift_stale_claims=0',
      'share_hb_n=0 share_hb_p95_ms=- share_hb_p99_ms=- share_hb_max_ms=- share_hb_pending=0 share_hb_oldest_pending_ms=0',
      'share_claim_n=0 share_claim_p50_ms=- share_claim_p95_ms=- share_claim_max_ms=-',
      'share_attempted=- share_succeeded=- share_failed_terminal=- share_failed_retrying=-',
      'lift_wallets=0',
      'lift_pickup_n=0 lift_pickup_p50_ms=- lift_pickup_p95_ms=-',
      'lift_pickup_free_n=0 lift_pickup_free_p50_ms=- lift_pickup_free_p95_ms=- lift_pickup_unclassified=0',
      'lift_c2f_n=0 lift_c2f_p50_ms=- lift_c2f_p95_ms=-',
      'lift_finalized=0 lift_failed=0',
    ].join(' '));
  });

  it('keeps a readable queue when the other one could not be read', () => {
    const line = formatAsyncAdmissionUsageLine({
      ...busy,
      depth: { share: null, lift: LIFT_DEPTH, liftJournal: null },
      depthErrors: 2,
    });
    expect(line).toContain(' share_depth=- lift_depth=accepted:2,');
    expect(line).toContain(' lift_journal=- depth_errors=2 ');
  });

  it('is one logfmt record: a name, then key=value tokens without spaces or quotes', () => {
    for (const sample of [busy, idle]) {
      const [name, ...tokens] = formatAsyncAdmissionUsageLine(sample).split(' ');
      expect(name).toBe('async_admission_usage');
      for (const token of tokens) expect(token).toMatch(/^[a-z0-9_]+=[^\s="]+$/);
    }
  });

  it('survives the log redactor unchanged', () => {
    const redact = createLogRedactor();
    for (const sample of [busy, idle]) {
      const message = formatAsyncAdmissionUsageLine(sample);
      const record = { level: 'info', message } as never;
      expect((redact(record) as { message: string }).message).toBe(message);
    }
  });

  it('keeps list components free of separators, whatever the source says', () => {
    const line = formatAsyncAdmissionUsageLine({
      ...busy,
      store: [{
        scheduler: 'weird id',
        queueWaits: [laneWait('a/b', 1)],
        rejections: [{ lane: 'x', family: 'a:b,c', reason: 'r"s', count: 1 }],
      }],
      usage: usage({ http: [{ route: 'share_async', phase: 'request', status: 400, code: 'a:b', count: 1 }] }),
    });
    expect(line).toContain(' store_rejections=weird_id/x/a_b_c/r_s:1 ');
    expect(line).toContain(' store_max_wait_ms=weird_id/a_b:1 ');
    expect(line).toContain(' http=share_async/request/400/a_b:1 ');
  });

  it('prints the interval as whole seconds and never a negative one', () => {
    expect(formatAsyncAdmissionUsageLine({ ...idle, intervalSeconds: 299.6 })).toContain(' interval_s=300 ');
    expect(formatAsyncAdmissionUsageLine({ ...idle, intervalSeconds: -5 })).toContain(' interval_s=0 ');
  });
});

describe('startAsyncAdmissionUsageLog', () => {
  /** Lets the line's asynchronous depth read settle. */
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const capture = () => ({ store: [storeReport], usage: usage() });

  it('logs a line at start and one every five minutes until stopped, idle or not', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    const log = startAsyncAdmissionUsageLog({ emit: (line) => lines.push(line), capture });
    await flush();
    expect(lines).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS - 1);
    expect(lines).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith('async_admission_usage interval_s='))).toBe(true);

    log.stop();
    await vi.advanceTimersByTimeAsync(10 * ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    expect(lines).toHaveLength(3);
    expect(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS).toBe(5 * 60_000);
  });

  it('reports the seconds since the previous line', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    let nowMs = 1_000_000;
    const lines: string[] = [];
    const log = startAsyncAdmissionUsageLog({ emit: (line) => lines.push(line), capture, now: () => nowMs });
    await flush();
    nowMs += 301_000;
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    log.stop();

    expect(lines[0]).toContain(' interval_s=0 ');
    expect(lines[1]).toContain(' interval_s=301 ');
  });

  it('skips a failed sample and takes the next one on time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    let samples = 0;
    const log = startAsyncAdmissionUsageLog({
      emit: (line) => lines.push(line),
      capture: () => {
        samples += 1;
        if (samples === 2) throw new Error('registry source failed');
        return capture();
      },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    expect(lines).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    expect(lines).toHaveLength(2);
    log.stop();
  });

  it('takes the store reports and the usage window exactly once per line', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const takeWaits = vi.fn(() => [laneWait('normal', 7)]);
    const unregister = registerStoreSchedulerStats({
      backpressureId: 'usage-log-test',
      stats: { takeIntervalQueueWaits: takeWaits, rejectionTotals: () => [] } as never,
    });
    const take = vi.spyOn(asyncAdmissionUsage, 'take');
    const lines: string[] = [];
    try {
      const log = startAsyncAdmissionUsageLog({ emit: (line) => lines.push(line) });
      await flush();
      expect(take).toHaveBeenCalledTimes(1);
      expect(takeWaits).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
      expect(take).toHaveBeenCalledTimes(2);
      expect(takeWaits).toHaveBeenCalledTimes(2);
      log.stop();
    } finally {
      unregister();
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ store_max_wait_ms=\S*usage-log-test\/normal:7 /);
  });

  it('prints the depths it read, reports them to the gauges and passes a deadline signal', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    const signals: AbortSignal[] = [];
    const queueDepth = vi.spyOn(asyncAdmissionUsage, 'recordQueueDepth');
    const journal = vi.spyOn(asyncAdmissionUsage, 'recordJournalEntries');
    const log = startAsyncAdmissionUsageLog({
      emit: (line) => lines.push(line),
      capture,
      readDepth: async (signal) => { signals.push(signal); return DEPTH; },
      shareWorkerCounters: () => busy.shareWorker,
    });
    await flush();
    log.stop();

    expect(lines[0]).toContain(' share_depth=failed:2,failed_retrying:0,queued:3,running:1,succeeded:200 ');
    expect(lines[0]).toContain(' lift_journal=812 depth_errors=0 ');
    expect(lines[0]).toContain(' share_attempted=210 share_succeeded=200 share_failed_terminal=2 share_failed_retrying=8 ');
    expect(queueDepth.mock.calls).toEqual([['share', SHARE_DEPTH], ['lift', LIFT_DEPTH]]);
    expect(journal).toHaveBeenCalledWith(812);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
  });

  it('leaves "-" and counts an error for a queue that cannot be read, and for a read that throws', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    const queueDepth = vi.spyOn(asyncAdmissionUsage, 'recordQueueDepth');
    let attempt = 0;
    const log = startAsyncAdmissionUsageLog({
      emit: (line) => lines.push(line),
      capture,
      readDepth: async () => {
        attempt += 1;
        if (attempt === 2) throw new Error('store closed');
        return { share: SHARE_DEPTH, lift: null, liftJournal: null };
      },
    });
    await flush();
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    log.stop();

    expect(lines[0]).toContain(' share_depth=failed:2,');
    expect(lines[0]).toContain(' lift_depth=- lift_journal=- depth_errors=2 ');
    expect(lines[1]).toContain(' share_depth=- lift_depth=- lift_journal=- depth_errors=3 ');
    expect(queueDepth.mock.calls).toEqual([['share', SHARE_DEPTH]]);
  });

  it('abandons a depth read at its deadline, aborts its signal and never runs two reads at once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    const signals: AbortSignal[] = [];
    const finish: Array<() => void> = [];
    const readDepth = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<AsyncQueueDepthReading>((resolve) => { finish.push(() => resolve(DEPTH)); });
    });
    const log = startAsyncAdmissionUsageLog({ emit: (line) => lines.push(line), capture, readDepth });

    // The first read does not answer: the line waits for the deadline, then goes out without depths.
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_DEPTH_READ_TIMEOUT_MS - 1);
    expect(lines).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(' share_depth=- lift_depth=- lift_journal=- depth_errors=1 ');
    expect(signals[0]!.aborted).toBe(true);

    // The abandoned read is still running at the next tick: no second read starts, the line still goes
    // out, and the skipped read counts as an error so a hung store does not read as a bare `-`.
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    expect(readDepth).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(' share_depth=- ');
    expect(lines[1]).toContain(' depth_errors=2 ');

    // Once it settles, the next tick reads again (stopping the clock at the tick, inside the new read's deadline).
    finish[0]!();
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS - ASYNC_ADMISSION_DEPTH_READ_TIMEOUT_MS);
    expect(readDepth).toHaveBeenCalledTimes(2);
    finish[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain(' share_depth=failed:2,');
    expect(lines[2]).toContain(' depth_errors=2 ');
    log.stop();
  });

  it('writes through the structured logger by default, from the live registries', async () => {
    const info = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});

    startAsyncAdmissionUsageLog().stop();
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));

    const [ctx, line] = info.mock.calls[0]!;
    expect(ctx).toMatchObject({ operationName: 'system' });
    expect(line).toMatch(/^async_admission_usage interval_s=0 store_rejections=\S+ store_max_wait_ms=\S+ http=- /);
  });
});

describe('readAsyncQueueDepth', () => {
  it('reads both queues and the journal from the store', async () => {
    const store = new OxigraphStore();
    expect(await readAsyncQueueDepth(store, new AbortController().signal)).toEqual({
      share: { queued: 0, running: 0, failed_retrying: 0, succeeded: 0, failed: 0 },
      lift: { accepted: 0, claimed: 0, validated: 0, broadcast: 0, included: 0, finalized: 0, failed: 0 },
      liftJournal: 0,
    });
  });

  it('reads them one after the other, on the signal it was given', async () => {
    const store = new OxigraphStore();
    const signal = new AbortController().signal;
    let running = 0;
    let overlap = 0;
    const seen: Array<AbortSignal | undefined> = [];
    const spy = {
      query: async (sparql: string, options?: { signal?: AbortSignal }) => {
        running += 1;
        overlap = Math.max(overlap, running);
        seen.push(options?.signal);
        await Promise.resolve();
        running -= 1;
        return store.query(sparql);
      },
    };
    await readAsyncQueueDepth(spy, signal);
    expect(overlap).toBe(1);
    expect(seen).toEqual([signal, signal, signal]);
  });

  it('leaves null for a read that fails and still returns the others', async () => {
    const store = new OxigraphStore();
    const flaky = {
      query: async (sparql: string, options?: { source?: string }) => {
        if (options?.source === 'publisher.queueUsage.lift') throw new Error('queue_full');
        return store.query(sparql);
      },
    };
    expect(await readAsyncQueueDepth(flaky, new AbortController().signal)).toEqual({
      share: { queued: 0, running: 0, failed_retrying: 0, succeeded: 0, failed: 0 },
      lift: null,
      liftJournal: 0,
    });
  });
});
