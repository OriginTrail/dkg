import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asyncAdmissionUsage,
  createLogRedactor,
  Logger,
  type AsyncAdmissionUsageSnapshot,
  type LatencySummary,
} from '@origintrail-official/dkg-core';
import {
  estimateQueueWaitPercentileMs,
  OxigraphStore,
  registerStoreSchedulerStats,
  STORE_QUEUE_WAIT_BUCKET_UPPER_MS,
  StoreSchedulerStats,
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
import {
  configureWritePreflightCoalescing,
  getWritePreflightCoalescingCounters,
  probeWritePreflight,
} from '../src/daemon/write-preflight-coalescing.js';

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

/** A lane report for the waits (ms) that ended in the interval, as a real `StoreSchedulerStats` reports them. */
function laneWaits(lane: string, waitsMs: readonly number[]): StoreSchedulerLaneWait {
  const stats = new StoreSchedulerStats([lane]);
  for (const wait of waitsMs) stats.recordQueueWait(lane, wait);
  return stats.takeIntervalQueueWaits()[0]!;
}

/** A lane whose only wait in the interval was `maxQueueWaitMs` (none when 0). */
const laneWait = (lane: string, maxQueueWaitMs: number): StoreSchedulerLaneWait =>
  laneWaits(lane, maxQueueWaitMs > 0 ? [maxQueueWaitMs] : []);

const repeat = (waitMs: number, times: number): number[] => Array.from({ length: times }, () => waitMs);

const storeReport: StoreSchedulerStatsReport = {
  scheduler: 'store',
  queueWaits: [
    laneWaits('ack', [...repeat(4, 38), ...repeat(80, 2)]),
    laneWait('health', 0),
    laneWait('normal', 120),
    laneWaits('background', [...repeat(30, 9), 812.4]),
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
  preflight: { flights: 812, joins: 3390, cacheHits: 12, cacheStores: 5, direct: 1 },
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
      'store_max_wait_ms=store/ack:80,store/background:812,store/health:0,store/normal:120',
      'store_wait_n=store/ack:40,store/background:10,store/health:0,store/normal:1',
      'store_wait_p95_ms=store/ack:4,store/background:869,store/health:0,store/normal:129',
      'store_wait_buckets=store/ack:4x38|80x2,store/background:31x9|869x1,store/health:-,store/normal:129x1',
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
      'preflight_flights=812 preflight_joins=3390 preflight_cache_hits=12 preflight_cache_stores=5 preflight_direct=1',
    ].join(' '));
  });

  it('prints "-" for empty windows, empty lists, unreadable depths and a missing share worker', () => {
    expect(formatAsyncAdmissionUsageLine(idle)).toBe([
      'async_admission_usage interval_s=0 store_rejections=- store_max_wait_ms=- store_wait_n=- store_wait_p95_ms=- store_wait_buckets=- http=-',
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
      'preflight_flights=- preflight_joins=- preflight_cache_hits=- preflight_cache_stores=- preflight_direct=-',
    ].join(' '));
  });

  it('lists the queue control schedulers beside the store scheduler, each with its one control lane', () => {
    const control = (queue: string, waitsMs: readonly number[], count: number): StoreSchedulerStatsReport => ({
      scheduler: `store-control-${queue}`,
      queueWaits: [laneWaits('control', waitsMs)],
      rejections: count === 0 ? [] : [{ lane: 'control', family: `publisher.${queue}`, reason: 'queue_full', count }],
    });
    const line = formatAsyncAdmissionUsageLine({
      ...idle,
      store: [storeReport, control('publisher', [...repeat(1, 9), 17], 2), control('share', [], 0)],
    });
    expect(line).toContain(
      ' store_rejections=store-control-publisher/control/publisher.publisher/queue_full:2,'
      + 'store/background/publisher.asyncLift/queue_full:3,store/normal/agent.writePreflight/queue_wait_timeout:1 ',
    );
    expect(line).toContain(' store_max_wait_ms=store-control-publisher/control:17,store-control-share/control:0,store/ack:80,');
    expect(line).toContain(' store_wait_n=store-control-publisher/control:10,store-control-share/control:0,store/ack:40,');
    expect(line).toContain(' store_wait_p95_ms=store-control-publisher/control:17,store-control-share/control:0,store/ack:4,');
    expect(line).toContain(' store_wait_buckets=store-control-publisher/control:1x9|17x1,store-control-share/control:-,store/ack:4x38|80x2,');
    const [, ...tokens] = line.split(' ');
    for (const token of tokens) expect(token).toMatch(/^[a-z0-9_]+=[^\s="]+$/);
  });

  it('prints the preflight counters as plain cumulative integers, zero included', () => {
    const line = formatAsyncAdmissionUsageLine({
      ...busy,
      preflight: { flights: 0, joins: 0, cacheHits: 0, cacheStores: 0, direct: 0 },
    });
    expect(line.split(' ').filter((token) => token.startsWith('preflight_'))).toEqual([
      'preflight_flights=0', 'preflight_joins=0', 'preflight_cache_hits=0', 'preflight_cache_stores=0', 'preflight_direct=0',
    ]);
  });

  it('documents every preflight figure the line prints, in the usage-line field reference', () => {
    const doc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../docs/async-admission-usage-line.md'), 'utf8');
    const printed = formatAsyncAdmissionUsageLine(busy).split(' ')
      .filter((token) => token.startsWith('preflight_'))
      .map((token) => token.slice(0, token.indexOf('=')));
    expect(printed).toHaveLength(5);
    for (const field of printed) expect(doc, field).toContain(`\`${field}\``);
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
    expect(line).toContain(' store_max_wait_ms=weird_id/a_b:1 store_wait_n=weird_id/a_b:1 store_wait_p95_ms=weird_id/a_b:1 store_wait_buckets=weird_id/a_b:1x1 ');
    expect(line).toContain(' http=share_async/request/400/a_b:1 ');
  });

  describe('store_wait_p95_ms', () => {
    const waitFields = (waits: StoreSchedulerLaneWait[]): { n: string; p95: string; max: string } => {
      const line = formatAsyncAdmissionUsageLine({ ...idle, store: [{ scheduler: 'store', queueWaits: waits, rejections: [] }] });
      const field = (name: string) => new RegExp(` ${name}=(\\S+) `).exec(line)![1]!;
      return { n: field('store_wait_n'), p95: field('store_wait_p95_ms'), max: field('store_max_wait_ms') };
    };

    it('is the upper bound of the bucket holding the 95th-percentile wait, not the interval max', () => {
      // One slow ACK wait among 99 fast ones: the max shows it, the P95 does not.
      expect(waitFields([laneWaits('ack', [...repeat(3, 99), 4000])])).toEqual({
        n: 'store/ack:100', p95: 'store/ack:3', max: 'store/ack:4000',
      });
    });

    it('moves to the next bucket when the slow waits are more than 5% of the interval', () => {
      // Rank 95 of 100: five slow waits leave it in the fast bucket, six push it into the slow one.
      expect(waitFields([laneWaits('ack', [...repeat(30, 95), ...repeat(700, 5)])]).p95).toBe('store/ack:31');
      expect(waitFields([laneWaits('ack', [...repeat(30, 94), ...repeat(700, 6)])]).p95).toBe('store/ack:718');
    });

    it('counts a wait on a bucket bound in that bucket and one just past it in the next', () => {
      expect(waitFields([laneWaits('ack', [10])]).p95).toBe('store/ack:10');
      expect(waitFields([laneWaits('ack', [10.5])]).p95).toBe('store/ack:11');
      expect(waitFields([laneWaits('ack', [10_000])]).p95).toBe('store/ack:10000');
    });

    it('counts work that started at once as a wait of about 0 ms, which keeps a quiet lane at the first bound', () => {
      expect(waitFields([laneWaits('ack', [...repeat(0.02, 400), 0, 3])])).toEqual({
        n: 'store/ack:402', p95: 'store/ack:1', max: 'store/ack:3',
      });
    });

    it('can exceed the max, because it is a bucket upper bound', () => {
      expect(waitFields([laneWaits('normal', [120])])).toEqual({
        n: 'store/normal:1', p95: 'store/normal:129', max: 'store/normal:120',
      });
    });

    it('is the interval max when the rank falls past the last bucket', () => {
      // 19 of 20 waits are in the 2048 ms bucket, so the one overflow wait is above the rank.
      expect(waitFields([laneWaits('background', [...repeat(2000, 19), 12_345.4])]).p95).toBe('store/background:2048');
      // Two of 3 are in overflow, so the rank is too.
      expect(waitFields([laneWaits('background', [2000, 12_000, 12_345.4])]).p95).toBe('store/background:12345');
      expect(waitFields([laneWaits('background', [...repeat(12_000, 20), 31_000.6])]).p95).toBe('store/background:31001');
    });

    it('is 0, with a count of 0, for a lane that had no wait', () => {
      expect(waitFields([laneWait('health', 0)])).toEqual({ n: 'store/health:0', p95: 'store/health:0', max: 'store/health:0' });
    });

    it('is reported for every lane of every scheduler, sorted by key like the max', () => {
      const line = formatAsyncAdmissionUsageLine({
        ...idle,
        store: [
          { scheduler: 'store', queueWaits: [laneWait('normal', 40), laneWait('ack', 5)], rejections: [] },
          { scheduler: 'queue-control', queueWaits: [laneWait('ack', 700)], rejections: [] },
        ],
      });
      expect(line).toContain(' store_wait_p95_ms=queue-control/ack:718,store/ack:5,store/normal:41 ');
    });
  });

  describe('store_wait_buckets', () => {
    const lineFor = (waits: StoreSchedulerLaneWait[]) =>
      formatAsyncAdmissionUsageLine({ ...idle, store: [{ scheduler: 'store', queueWaits: waits, rejections: [] }] });
    const field = (line: string, name: string) => new RegExp(` ${name}=(\\S+) `).exec(line)![1]!;
    /** Reads a line's `store_wait_buckets` as `{ lane: { upperBound or 'inf': count } }`, the way a harness would. */
    const parseBuckets = (line: string): Record<string, Record<string, number>> => {
      const value = field(line, 'store_wait_buckets');
      if (value === '-') return {};
      return Object.fromEntries(value.split(',').map((entry) => {
        const [lane, counts] = [entry.slice(0, entry.indexOf(':')), entry.slice(entry.indexOf(':') + 1)];
        const parsed = counts === '-' ? [] : counts.split('|').map((pair): [string, number] => {
          const [bound, count] = pair.split('x');
          return [bound!, Number(count)];
        });
        return [lane, Object.fromEntries(parsed)];
      }));
    };

    it('prints each bucket that holds a wait as <upper bound>x<count>, ascending, and - for a lane with none', () => {
      const line = lineFor([
        laneWaits('ack', [0, 0.3, 1, 1.5, 2, 9, 9, 9, 5000]),
        laneWaits('health', []),
        laneWaits('normal', [12_000, 99_999, 3]),
      ]);
      expect(field(line, 'store_wait_buckets')).toBe('store/ack:1x3|2x2|9x3|5313x1,store/health:-,store/normal:3x1|infx2');
      expect(field(line, 'store_wait_n')).toBe('store/ack:9,store/health:0,store/normal:3');
    });

    it('prints the counts the lane\'s P95 comes from: they add up to store_wait_n and give store_wait_p95_ms again', () => {
      for (const waits of [[3], [...repeat(3, 99), 4000], [...repeat(30, 94), ...repeat(700, 6)], [2000, 12_000, 12_345.4]]) {
        const line = lineFor([laneWaits('ack', waits)]);
        const counts = parseBuckets(line)['store/ack']!;
        expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(waits.length);
        expect(field(line, 'store_wait_n')).toBe(`store/ack:${waits.length}`);
        const array = STORE_QUEUE_WAIT_BUCKET_UPPER_MS.map((bound) => counts[String(bound)] ?? 0).concat(counts.inf ?? 0);
        const max = Math.round(Math.max(...waits));
        expect(`store/ack:${estimateQueueWaitPercentileMs(array, 0.95, max)}`).toBe(field(line, 'store_wait_p95_ms'));
      }
    });

    it('lets lines be added into the P95 of a longer window, which their own P95s do not give', () => {
      // Three five-minute intervals of one lane: a busy quiet one, a short one with a long tail, a short one with a small tail.
      const intervals = [
        [...repeat(0.05, 400)],
        [...repeat(0.05, 70), ...repeat(700, 30)],
        [...repeat(0.05, 90), ...repeat(40, 10)],
      ];
      const lines = intervals.map((waits) => lineFor([laneWaits('ack', waits)]));
      expect(lines.map((line) => field(line, 'store_wait_p95_ms'))).toEqual(['store/ack:1', 'store/ack:718', 'store/ack:41']);

      // The documented method: add the counts per bound, take the smallest bound that reaches rank ceil(0.95 * n),
      // and use the largest per-line max when that is the overflow bucket.
      const merged = new Map<number, number>();
      for (const line of lines) {
        for (const [bound, count] of Object.entries(parseBuckets(line)['store/ack']!)) {
          merged.set(Number(bound), (merged.get(Number(bound)) ?? 0) + count);
        }
      }
      const total = [...merged.values()].reduce((sum, count) => sum + count, 0);
      let seen = 0;
      let windowP95 = Number.NaN;
      for (const bound of [...merged.keys()].sort((a, b) => a - b)) {
        seen += merged.get(bound)!;
        if (seen >= Math.ceil(0.95 * total)) { windowP95 = bound; break; }
      }

      // The same waits in one interval of a single scheduler: the exact bucket-level answer.
      const whole = laneWaits('ack', intervals.flat());
      expect(total).toBe(whole.queueWaitCount);
      expect(windowP95).toBe(estimateQueueWaitPercentileMs(whole.queueWaitBuckets, 0.95, whole.maxQueueWaitMs));
      // 600 waits, rank 570: 560 started at once, then the ten 40 ms waits. The worst line's P95 (718) and the mean of the three (253) are not it.
      expect(windowP95).toBe(41);
    });

    it('lists in the usage-line field reference exactly the bounds it counts in, since a reader sums counts by bound', () => {
      const doc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../docs/async-admission-usage-line.md'), 'utf8');
      const listed = /```text\n(1 2 3[\s\S]*?)```/.exec(doc)?.[1]?.trim().split(/\s+/).map(Number);
      expect(listed).toEqual([...STORE_QUEUE_WAIT_BUCKET_UPPER_MS]);
    });

    it('keeps the same list shape as the other lane figures: sorted by key, scheduler and lane sanitised', () => {
      const line = formatAsyncAdmissionUsageLine({
        ...idle,
        store: [
          { scheduler: 'store', queueWaits: [laneWaits('normal', [40]), laneWaits('ack', [5])], rejections: [] },
          { scheduler: 'queue control', queueWaits: [laneWaits('ack', [700])], rejections: [] },
        ],
      });
      expect(field(line, 'store_wait_buckets')).toBe('queue_control/ack:718x1,store/ack:5x1,store/normal:41x1');
    });
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
    expect(lines[0]).toMatch(/ store_max_wait_ms=\S*usage-log-test\/normal:7 store_wait_n=\S*usage-log-test\/normal:1 store_wait_p95_ms=\S*usage-log-test\/normal:7 store_wait_buckets=\S*usage-log-test\/normal:7x1 /);
  });

  it('reports the P95 of a registered scheduler\'s own bucket counts, per interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const stats = new StoreSchedulerStats(['ack', 'normal']);
    for (let i = 0; i < 19; i++) stats.recordQueueWait('ack', 5);
    stats.recordQueueWait('ack', 900);
    const unregister = registerStoreSchedulerStats({ backpressureId: 'usage-log-p95-test', stats });
    const lines: string[] = [];
    try {
      const log = startAsyncAdmissionUsageLog({ emit: (line) => lines.push(line) });
      await flush();
      await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
      log.stop();
    } finally {
      unregister();
    }
    expect(lines).toHaveLength(2);
    // The live registry may hold other schedulers too, which sort before this id.
    expect(lines[0]).toMatch(/ store_max_wait_ms=\S*usage-log-p95-test\/ack:900,usage-log-p95-test\/normal:0 /);
    expect(lines[0]).toMatch(/ store_wait_n=\S*usage-log-p95-test\/ack:20,usage-log-p95-test\/normal:0 /);
    expect(lines[0]).toMatch(/ store_wait_p95_ms=\S*usage-log-p95-test\/ack:5,usage-log-p95-test\/normal:0 /);
    expect(lines[0]).toMatch(/ store_wait_buckets=\S*usage-log-p95-test\/ack:5x19\|956x1,usage-log-p95-test\/normal:- /);
    // Taking the line ended the interval: the next one starts from empty buckets.
    expect(lines[1]).toMatch(/ store_wait_n=\S*usage-log-p95-test\/ack:0,usage-log-p95-test\/normal:0 /);
    expect(lines[1]).toMatch(/ store_wait_p95_ms=\S*usage-log-p95-test\/ack:0,usage-log-p95-test\/normal:0 /);
    expect(lines[1]).toMatch(/ store_wait_buckets=\S*usage-log-p95-test\/ack:-,usage-log-p95-test\/normal:- /);
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

  it('republishes the wallet gauge on every line, before the depth read can hang it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const republish = vi.spyOn(asyncAdmissionUsage, 'republishLiftWallets');
    const log = startAsyncAdmissionUsageLog({
      emit: () => {},
      capture,
      readDepth: () => new Promise<AsyncQueueDepthReading>(() => {}), // never answers
    });

    await flush();
    expect(republish).toHaveBeenCalledTimes(1); // the first line is still waiting on its depth read
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    expect(republish).toHaveBeenCalledTimes(2);
    log.stop();
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
    expect(line).toMatch(/^async_admission_usage interval_s=0 store_rejections=\S+ store_max_wait_ms=\S+ store_wait_n=\S+ store_wait_p95_ms=\S+ store_wait_buckets=\S+ http=- /);
  });
});

describe('the preflight counters of a running log', () => {
  const quiet = { info: () => {}, warn: () => {} };
  const probe = { contextGraphId: 'cg', exists: true } as never;
  afterEach(() => { configureWritePreflightCoalescing({}, quiet); });

  it('reads the coalescer\'s own counters by default, as they stand when each line is built', async () => {
    configureWritePreflightCoalescing({}, quiet);
    const lines: string[] = [];
    const agent = {
      probeContextGraphWritePreflight: async () => probe,
      writePreflightIdentity: () => ({ key: 'k', stamp: 's' }),
    };
    const accepts = () => true;
    await Promise.all([
      probeWritePreflight(agent, 'cg', null, { accepts }),
      probeWritePreflight(agent, 'cg', null, { accepts }),
      probeWritePreflight(agent, 'cg', null, { accepts }),
    ]);
    const log = startAsyncAdmissionUsageLog({ emit: (line) => lines.push(line), capture: () => ({ store: [], usage: usage() }) });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    log.stop();
    expect(lines[0]).toContain(' preflight_flights=1 preflight_joins=2 preflight_cache_hits=0 preflight_cache_stores=0 preflight_direct=0');
    expect(getWritePreflightCoalescingCounters()).toMatchObject({ flights: 1, joins: 2 });
  });

  it('takes a counter source of its own, and does not take (zero) the counters it reads', async () => {
    const lines: string[] = [];
    const source = vi.fn(() => ({ flights: 7, joins: 6, cacheHits: 5, cacheStores: 4, direct: 3 }));
    const log = startAsyncAdmissionUsageLog({
      emit: (line) => lines.push(line),
      capture: () => ({ store: [], usage: usage() }),
      preflightCounters: source,
    });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    log.stop();
    expect(lines[0]).toContain(' preflight_flights=7 preflight_joins=6 preflight_cache_hits=5 preflight_cache_stores=4 preflight_direct=3');
    expect(source).toHaveBeenCalledTimes(1);
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
