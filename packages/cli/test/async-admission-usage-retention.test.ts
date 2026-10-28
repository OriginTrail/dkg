/**
 * OT-RFC-73 P10b: queue retention in the periodic `async_admission_usage` line. The line is unchanged unless a retention sweep is registered and not off; with one
 * it gains a fixed, pinned set of fields: deleted by class, kept by reason, skipped by reason, errors, and the `lastCompletePass` gauge (report mode: would-delete by
 * class).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asyncAdmissionUsage, type AsyncAdmissionUsageSnapshot, type LatencySummary } from '@origintrail-official/dkg-core';
import {
  ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS, formatAsyncAdmissionUsageLine, startAsyncAdmissionUsageLog, type AsyncAdmissionUsageSample,
} from '../src/daemon/async-admission-usage-log.js';
import type { RetentionUsageView } from '../src/daemon/retention-timer.js';

const EMPTY: LatencySummary = { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
const usage = (): AsyncAdmissionUsageSnapshot => ({
  http: [], httpLatency: { share_async: EMPTY, publish_async: EMPTY }, shareReclaimed: 0, shareAbandoned: 0, shareHeartbeat: { ...EMPTY, pending: 0, oldestPendingMs: 0 },
  shareClaim: EMPTY, liftReclaimed: 0, liftStaleClaims: 0, liftFinalized: 0, liftFailed: 0, liftWallets: 0, liftPickup: EMPTY, liftPickupWorkerFree: EMPTY,
  liftPickupUnclassified: 0, liftClaimToFinish: EMPTY,
});
const base = (): AsyncAdmissionUsageSample => ({
  intervalSeconds: 300, store: [], usage: usage(), depth: { share: { queued: 3, succeeded: 200 }, lift: null, liftJournal: 812 }, depthErrors: 0, shareWorker: null,
});

const CLASSES = ['succeeded', 'cancelled', 'retired_no_effect'] as const;
const classes = (counts: Partial<Record<(typeof CLASSES)[number], number>> = {}) => Object.fromEntries(CLASSES.map(name => [name, counts[name] ?? 0]));
const REASONS = ['unreadable', 'index_mismatch', 'unknown_state', 'newer_format', 'not_terminal', 'unfinished_bound_obligation', 'failed_retained', 'post_commit_recoverable', 'pending_admission', 'too_recent', 'future_dated', 'vanished'] as const;
const reasons = (counts: Partial<Record<(typeof REASONS)[number], number>> = {}) => Object.fromEntries(REASONS.map(name => [name, counts[name] ?? 0]));

/** What the share core reports after a first complete report pass: every class and reason key present, most of them zero. */
const reportView = (over: Partial<RetentionUsageView> = {}): RetentionUsageView => ({
  queue: 'share', mode: 'report', ticks: 12,
  deleted: classes(),
  kept: reasons({ failed_retained: 2, too_recent: 40 }),
  skipped: { off: 0, overlap: 0, clock_invalid: 0, clock_backwards: 0, clock_jump: 1 },
  errors: { scan: 1, verify: 0, delete: 0, tick: 2 },
  lastCompletePass: { scanned: 300, wouldDelete: classes({ succeeded: 240, cancelled: 1 }), deleted: classes() },
  ...over,
});

afterEach(() => { vi.useRealTimers(); });

describe('unchanged by default', () => {
  it('a sample with no retention, an undefined one and an empty one print the same line, with no retention field', () => {
    const plain = formatAsyncAdmissionUsageLine(base());
    expect(formatAsyncAdmissionUsageLine({ ...base(), retention: undefined })).toBe(plain);
    expect(formatAsyncAdmissionUsageLine({ ...base(), retention: [] })).toBe(plain);
    expect(plain).not.toContain('retention');
    // The fixed line ends with the write preflight's fields (P12); the retention fields come after them, so nothing a reader already parses moves.
    expect(plain.endsWith(' preflight_direct=-')).toBe(true);
  });

  it('with a sweep the line is the plain line plus the retention fields at the end: nothing before them moves', () => {
    const plain = formatAsyncAdmissionUsageLine(base());
    const with_ = formatAsyncAdmissionUsageLine({ ...base(), retention: [reportView()] });
    expect(with_.startsWith(`${plain} share_retention=report `)).toBe(true);
  });
});

describe('the retention fields (pinned)', () => {
  it('report mode after a complete pass', () => {
    const suffix = formatAsyncAdmissionUsageLine({ ...base(), retention: [reportView()] }).slice(formatAsyncAdmissionUsageLine(base()).length + 1);
    expect(suffix).toBe([
      'share_retention=report',
      'share_retention_ticks=12',
      'share_retention_deleted=cancelled:0,retired_no_effect:0,succeeded:0',
      'share_retention_kept=failed_retained:2,too_recent:40',
      'share_retention_skipped=clock_jump:1',
      'share_retention_errors=scan:1,tick:2',
      'share_retention_pass_scanned=300',
      'share_retention_pass_would_delete=cancelled:1,retired_no_effect:0,succeeded:240',
      'share_retention_pass_deleted=cancelled:0,retired_no_effect:0,succeeded:0',
    ].join(' '));
  });

  it('before a pass has completed, and with nothing kept, skipped or failed: the gauge and the empty lists print `-`', () => {
    const view = reportView({
      ticks: 0, kept: reasons(), skipped: { off: 0, overlap: 0 }, errors: { scan: 0, verify: 0, delete: 0 }, lastCompletePass: null,
    });
    const suffix = formatAsyncAdmissionUsageLine({ ...base(), retention: [view] }).slice(formatAsyncAdmissionUsageLine(base()).length + 1);
    expect(suffix).toBe([
      'share_retention=report', 'share_retention_ticks=0', 'share_retention_deleted=cancelled:0,retired_no_effect:0,succeeded:0',
      'share_retention_kept=-', 'share_retention_skipped=-', 'share_retention_errors=-',
      'share_retention_pass_scanned=-', 'share_retention_pass_would_delete=-', 'share_retention_pass_deleted=-',
    ].join(' '));
  });

  it('delete mode: the cumulative deleted-by-class counters and the pass that deleted', () => {
    const view = reportView({
      mode: 'delete', ticks: 40, deleted: classes({ succeeded: 1200, cancelled: 3, retired_no_effect: 2 }), kept: reasons({ pending_admission: 1 }),
      lastCompletePass: { scanned: 90, wouldDelete: classes(), deleted: classes({ succeeded: 80, retired_no_effect: 1 }) },
    });
    const suffix = formatAsyncAdmissionUsageLine({ ...base(), retention: [view] }).slice(formatAsyncAdmissionUsageLine(base()).length + 1);
    expect(suffix).toContain('share_retention=delete share_retention_ticks=40 share_retention_deleted=cancelled:3,retired_no_effect:2,succeeded:1200 share_retention_kept=pending_admission:1 ');
    expect(suffix).toContain(' share_retention_pass_would_delete=cancelled:0,retired_no_effect:0,succeeded:0 share_retention_pass_deleted=cancelled:0,retired_no_effect:1,succeeded:80');
  });

  it('the publisher\'s sweep (P11) prints under the lift_ prefix, after the share\'s', () => {
    const publisher: RetentionUsageView = {
      queue: 'publisher', mode: 'report', ticks: 2, deleted: { finalized: 0 }, kept: { failed_retained: 5 }, skipped: {}, errors: {},
      lastCompletePass: { scanned: 7, wouldDelete: { finalized: 4 }, deleted: { finalized: 0 } },
    };
    const line = formatAsyncAdmissionUsageLine({ ...base(), retention: [reportView(), publisher] });
    expect(line.indexOf('share_retention=report')).toBeGreaterThan(0);
    expect(line.indexOf('lift_retention=report')).toBeGreaterThan(line.indexOf('share_retention_pass_deleted='));
    expect(line).toContain(' lift_retention=report lift_retention_ticks=2 lift_retention_deleted=finalized:0 lift_retention_kept=failed_retained:5 lift_retention_skipped=- lift_retention_errors=- '
      + 'lift_retention_pass_scanned=7 lift_retention_pass_would_delete=finalized:4 lift_retention_pass_deleted=finalized:0');
  });

  it('keys are sanitised like every other list key', () => {
    const line = formatAsyncAdmissionUsageLine({ ...base(), retention: [reportView({ kept: { 'weird key,x': 1 } })] });
    expect(line).toContain(' share_retention_kept=weird_key_x:1 ');
  });
});

describe('the periodic writer', () => {
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const fake = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const capture = () => ({ store: [], usage: usage() });

  it('prints the retention figures the provider returns, read at every line', async () => {
    fake();
    const lines: string[] = [];
    let ticks = 0;
    const log = startAsyncAdmissionUsageLog({ emit: line => lines.push(line), capture, retention: () => [reportView({ ticks: ++ticks })] });
    await flush();
    await vi.advanceTimersByTimeAsync(ASYNC_ADMISSION_USAGE_LOG_INTERVAL_MS);
    log.stop();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(' share_retention=report share_retention_ticks=1 ');
    expect(lines[1]).toContain(' share_retention=report share_retention_ticks=2 ');
  });

  it('prints no retention field when the provider returns no sweep, or when there is no provider', async () => {
    fake();
    const lines: string[] = [];
    const none = startAsyncAdmissionUsageLog({ emit: line => lines.push(line), capture, retention: () => [] });
    const absent = startAsyncAdmissionUsageLog({ emit: line => lines.push(line), capture });
    await flush();
    none.stop();
    absent.stop();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain('retention');
    expect(lines[0]).toBe(lines[1]!.replace(/interval_s=\d+/, 'interval_s=0'));
  });

  it('a provider that throws costs the retention fields and not the line', async () => {
    fake();
    const lines: string[] = [];
    const log = startAsyncAdmissionUsageLog({ emit: line => lines.push(line), capture, retention: () => { throw new Error('counters unavailable'); } });
    await flush();
    log.stop();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^async_admission_usage interval_s=0 /);
    expect(lines[0]).not.toContain('retention');
    asyncAdmissionUsage.reset();
  });
});
