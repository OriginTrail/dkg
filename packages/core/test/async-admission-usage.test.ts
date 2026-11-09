import { afterEach, describe, expect, it } from 'vitest';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { AsyncAdmissionUsage, asyncAdmissionUsage } from '../src/async-admission-usage.js';
import { rebuildMetrics } from '../src/telemetry-api.js';

interface Recorded { metric: string; value: number; attributes: Record<string, unknown> }

/**
 * Capture the instruments by NAME through a stand-in meter provider. With no provider the API
 * hands back one shared no-op instrument, so spying on an instrument cannot tell them apart.
 */
function captureMetrics(run: () => void | Promise<void>): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  const instrument = (metric: string) => {
    const note = (value: number, attributes?: Record<string, unknown>) => {
      recorded.push({ metric, value, attributes: attributes ?? {} });
    };
    return { add: note, record: note };
  };
  const meter = {
    createGauge: instrument,
    createCounter: instrument,
    createHistogram: instrument,
    createUpDownCounter: instrument,
  };
  otelMetrics.setGlobalMeterProvider({ getMeter: () => meter } as never);
  rebuildMetrics();
  return Promise.resolve(run()).then(() => recorded).finally(() => {
    otelMetrics.disable();
    rebuildMetrics();
  });
}

function manualClock(start = 0) {
  let now = start;
  return { clock: () => now, advance: (ms: number) => { now += ms; } };
}

const outcome = (over: Partial<Parameters<AsyncAdmissionUsage['recordHttpOutcome']>[0]> = {}) => ({
  route: 'publish_async' as const,
  phase: 'enqueue' as const,
  status: 202,
  code: '-',
  latencyMs: 10,
  ...over,
});

afterEach(() => {
  otelMetrics.disable();
  rebuildMetrics();
});

describe('AsyncAdmissionUsage HTTP outcomes', () => {
  it('counts per route, phase, status and code, sorted, and keeps counting after a take', () => {
    const usage = new AsyncAdmissionUsage();
    usage.recordHttpOutcome(outcome());
    usage.recordHttpOutcome(outcome({ status: 409, code: 'PUBLISH_INTENT_STALE', phase: 'snapshot_preflight' }));
    usage.recordHttpOutcome(outcome({ status: 409, code: 'PUBLISH_INTENT_STALE', phase: 'snapshot_preflight' }));
    usage.recordHttpOutcome(outcome({ route: 'share_async', status: 503, code: 'store_busy', phase: 'write_preflight' }));

    const expected = [
      { route: 'publish_async', phase: 'enqueue', status: 202, code: '-', count: 1 },
      { route: 'publish_async', phase: 'snapshot_preflight', status: 409, code: 'PUBLISH_INTENT_STALE', count: 2 },
      { route: 'share_async', phase: 'write_preflight', status: 503, code: 'store_busy', count: 1 },
    ];
    expect(usage.take().http).toEqual(expected);
    expect(usage.take().http).toEqual(expected);
  });

  it('sanitizes the code and the status', () => {
    const usage = new AsyncAdmissionUsage();
    usage.recordHttpOutcome(outcome({ code: 'has space' }));
    usage.recordHttpOutcome(outcome({ code: 'x'.repeat(49) }));
    usage.recordHttpOutcome(outcome({ code: undefined as unknown as string }));
    usage.recordHttpOutcome(outcome({ code: 'ok.code:1_a-b', status: 99 }));
    usage.recordHttpOutcome(outcome({ status: 2.5 }));

    expect(usage.take().http).toEqual([
      { route: 'publish_async', phase: 'enqueue', status: 0, code: '-', count: 1 },
      { route: 'publish_async', phase: 'enqueue', status: 0, code: 'ok.code:1_a-b', count: 1 },
      { route: 'publish_async', phase: 'enqueue', status: 202, code: '-', count: 3 },
    ]);
  });

  it('keeps at most 64 distinct series and counts later codes as other', () => {
    const usage = new AsyncAdmissionUsage();
    for (let i = 0; i < 70; i += 1) usage.recordHttpOutcome(outcome({ status: 400, code: `code_${i}` }));
    usage.recordHttpOutcome(outcome({ status: 400, code: 'code_3' })); // an existing series still counts
    usage.recordHttpOutcome(outcome({ status: 500, code: 'new_after_cap' }));

    const { http } = usage.take();
    const status400 = http.filter((entry) => entry.status === 400);
    expect(status400.filter((entry) => entry.code !== 'other')).toHaveLength(64);
    expect(status400.find((entry) => entry.code === 'other')?.count).toBe(6);
    expect(status400.find((entry) => entry.code === 'code_3')?.count).toBe(2);
    expect(http.find((entry) => entry.status === 500)).toMatchObject({ code: 'other', count: 1 });
    expect(usage.take().http.reduce((sum, entry) => sum + entry.count, 0)).toBe(72);
  });

  it('summarizes the latency per route over a window that the take empties', () => {
    const usage = new AsyncAdmissionUsage();
    usage.recordHttpOutcome(outcome({ route: 'share_async', latencyMs: 100 }));
    usage.recordHttpOutcome(outcome({ route: 'share_async', latencyMs: 300 }));
    usage.recordHttpOutcome(outcome({ route: 'publish_async', latencyMs: 40 }));
    usage.recordHttpOutcome(outcome({ route: 'publish_async', latencyMs: Number.NaN }));

    const first = usage.take().httpLatency;
    expect(first.share_async.n).toBe(2);
    expect(first.share_async.maxMs).toBeCloseTo(300, 0);
    expect(first.publish_async.n).toBe(1);
    expect(first.publish_async.p50Ms).toBeCloseTo(40, 0);

    const second = usage.take().httpLatency;
    expect(second.share_async.n).toBe(0);
    expect(second.publish_async.n).toBe(0);
  });

  it('records the OTel counter with the bounded attributes and the latency histogram by route', async () => {
    const usage = new AsyncAdmissionUsage();
    const recorded = await captureMetrics(() => {
      usage.recordHttpOutcome(outcome({ status: 503, code: 'store_busy', phase: 'intent_resolution', latencyMs: 12 }));
    });
    expect(recorded).toEqual([
      {
        metric: 'dkg.async_admission.outcomes_total',
        value: 1,
        attributes: { route: 'publish_async', phase: 'intent_resolution', status: '503', code: 'store_busy' },
      },
      { metric: 'dkg.async_admission.latency_ms', value: 12, attributes: { route: 'publish_async' } },
    ]);
  });
});

describe('AsyncAdmissionUsage share queue', () => {
  it('counts reclaimed and abandoned leases, returns the summary itself and survives garbage', async () => {
    const usage = new AsyncAdmissionUsage();
    const summary = { reclaimed: 2, abandoned: 1 };
    const recorded = await captureMetrics(() => {
      expect(usage.recordShareLeaseRecovery(summary)).toBe(summary);
    });
    expect(recorded).toEqual([
      { metric: 'dkg.async_queue.lease_recoveries_total', value: 2, attributes: { queue: 'share', outcome: 'reclaimed' } },
      { metric: 'dkg.async_queue.lease_recoveries_total', value: 1, attributes: { queue: 'share', outcome: 'abandoned' } },
    ]);

    const garbage = { reclaimed: Number.NaN, abandoned: -3 };
    expect(usage.recordShareLeaseRecovery(garbage)).toBe(garbage);
    expect(usage.recordShareLeaseRecovery(undefined as never)).toBeUndefined();
    expect(usage.recordShareLeaseRecovery({ reclaimed: 1.9, abandoned: 0 }).reclaimed).toBe(1.9);

    expect(usage.take()).toMatchObject({ shareReclaimed: 3, shareAbandoned: 1 });
  });

  it('times a claim that resolves and one that rejects, and passes both outcomes through', async () => {
    const { clock, advance } = manualClock();
    const usage = new AsyncAdmissionUsage({ clock });
    const recorded = await captureMetrics(async () => {
      await expect(usage.timeShareClaim(async () => { advance(40); return 'job'; })).resolves.toBe('job');
      const failure = new Error('claim failed');
      await expect(usage.timeShareClaim(async () => { advance(160); throw failure; })).rejects.toBe(failure);
    });

    const claim = usage.take().shareClaim;
    expect(claim.n).toBe(2);
    expect(claim.maxMs).toBeCloseTo(160, 0);
    expect(recorded.map((r) => [r.metric, r.value])).toEqual([
      ['dkg.async_share.claim_next_ms', 40],
      ['dkg.async_share.claim_next_ms', 160],
    ]);
  });

  it('shows a heartbeat as pending until it settles, then records its lateness whatever the outcome', async () => {
    const { clock, advance } = manualClock(1_000);
    const usage = new AsyncAdmissionUsage({ clock });
    let finish!: (value: string) => void;
    let fail!: (error: Error) => void;
    const slow = usage.observeShareHeartbeat(new Promise<string>((resolve) => { finish = resolve; }));
    advance(250);
    const failing = usage.observeShareHeartbeat(new Promise<string>((_, reject) => { fail = reject; }));
    failing.catch(() => {});
    advance(750);

    const pending = usage.take().shareHeartbeat;
    expect(pending).toMatchObject({ n: 0, pending: 2, oldestPendingMs: 1_000 });

    advance(500);
    finish('renewed');
    await expect(slow).resolves.toBe('renewed');
    const lost = new Error('lease lost');
    fail(lost);
    await expect(failing).rejects.toBe(lost);

    const settled = usage.take().shareHeartbeat;
    expect(settled.n).toBe(2);
    expect(settled.pending).toBe(0);
    expect(settled.oldestPendingMs).toBe(0);
    expect(settled.maxMs).toBeCloseTo(1_500, 0);
  });
});

describe('AsyncAdmissionUsage publisher queue', () => {
  function usageWithWallets(wallets: string[]): AsyncAdmissionUsage {
    const usage = new AsyncAdmissionUsage();
    usage.setLiftWallets(wallets);
    for (const wallet of wallets) usage.liftWalletObserved(wallet, false, 0);
    return usage;
  }

  it('classifies each claim as worker-free, busy or unclassified', () => {
    const usage = usageWithWallets(['a', 'b']);
    usage.liftWalletBusy('a', 1_000);
    usage.liftWalletBusy('b', 1_100);
    usage.liftWalletFree('b', 5_000);

    usage.recordLiftClaim(500, 700); // both free: free
    usage.recordLiftClaim(1_050, 6_050); // only a busy: free
    usage.recordLiftClaim(1_200, 4_200); // both busy: not worker-free
    usage.recordLiftClaim(-10, 0); // before anything was known: unknown

    const snapshot = usage.take();
    expect(snapshot.liftWallets).toBe(2);
    expect(snapshot.liftPickup.n).toBe(4);
    expect(snapshot.liftPickupWorkerFree.n).toBe(2);
    expect(snapshot.liftPickupWorkerFree.maxMs).toBeCloseTo(5_000, 0);
    expect(snapshot.liftPickupUnclassified).toBe(1);
  });

  it('never reports a negative wait and ignores a non-finite time', () => {
    const usage = usageWithWallets(['a']);
    usage.recordLiftClaim(1_000, 900);
    usage.recordLiftClaim(Number.NaN, 900);
    usage.recordLiftClaim(100, Number.POSITIVE_INFINITY);
    const { liftPickup } = usage.take();
    expect(liftPickup.n).toBe(1);
    expect(liftPickup.maxMs).toBeLessThan(0.01);
  });

  it('has no worker-free sample when no wallets are configured', () => {
    const usage = new AsyncAdmissionUsage();
    usage.recordLiftClaim(100, 200);
    expect(usage.take()).toMatchObject({ liftWallets: 0, liftPickupUnclassified: 1 });
  });

  it('seeds a wallet from a lock read and frees it on delete', () => {
    const usage = new AsyncAdmissionUsage();
    usage.setLiftWallets(['a']);
    usage.liftWalletObserved('a', true, 100);
    usage.recordLiftClaim(150, 160);
    expect(usage.take().liftPickupWorkerFree.n).toBe(0);
    usage.liftWalletFree('a', 200);
    usage.recordLiftClaim(250, 260);
    expect(usage.take().liftPickupWorkerFree.n).toBe(1);
  });

  it('samples claim-to-finish only for a finalized job and only counts a failed one', () => {
    const usage = new AsyncAdmissionUsage();
    usage.recordLiftFinish('finalized', 1_000, 4_000);
    usage.recordLiftFinish('finalized', undefined, 4_000);
    usage.recordLiftFinish('finalized', Number.NaN, 4_000);
    usage.recordLiftFinish('failed', 1_000, 9_000);
    usage.recordLiftFinish('broadcast', 1_000, 9_000);

    const snapshot = usage.take();
    expect(snapshot).toMatchObject({ liftFinalized: 3, liftFailed: 1 });
    expect(snapshot.liftClaimToFinish.n).toBe(1);
    expect(snapshot.liftClaimToFinish.maxMs).toBeCloseTo(3_000, 0);
  });

  it('counts stale claims and reclaims', async () => {
    const usage = new AsyncAdmissionUsage();
    const recorded = await captureMetrics(() => {
      usage.recordLiftStaleClaim();
      usage.recordLiftReclaim();
      usage.recordLiftReclaim();
    });
    expect(usage.take()).toMatchObject({ liftStaleClaims: 1, liftReclaimed: 2 });
    expect(recorded).toEqual([
      { metric: 'dkg.async_queue.stale_claims_total', value: 1, attributes: { queue: 'lift' } },
      { metric: 'dkg.async_queue.lease_recoveries_total', value: 1, attributes: { queue: 'lift', outcome: 'reclaimed' } },
      { metric: 'dkg.async_queue.lease_recoveries_total', value: 1, attributes: { queue: 'lift', outcome: 'reclaimed' } },
    ]);
  });

  it('records the pick-up, claim-to-finish and wallet instruments with their attributes', async () => {
    const usage = new AsyncAdmissionUsage();
    const recorded = await captureMetrics(() => {
      usage.setLiftWallets(['a', 'b']);
      usage.liftWalletObserved('a', false, 0);
      usage.recordLiftClaim(100, 350); // a free: worker_free=true
      usage.recordLiftClaim(-5, 0); // unknown
      usage.liftWalletObserved('b', true, 10);
      usage.liftWalletBusy('a', 20);
      usage.recordLiftClaim(30, 40); // both busy
      usage.recordLiftFinish('finalized', 1_000, 3_500);
    });
    expect(recorded).toEqual([
      { metric: 'dkg.async_lift.configured_wallets', value: 2, attributes: {} },
      { metric: 'dkg.async_lift.pickup_ms', value: 250, attributes: { worker_free: 'true' } },
      { metric: 'dkg.async_lift.pickup_ms', value: 5, attributes: { worker_free: 'unknown' } },
      { metric: 'dkg.async_lift.pickup_ms', value: 10, attributes: { worker_free: 'false' } },
      { metric: 'dkg.async_lift.claim_to_finish_ms', value: 2_500, attributes: {} },
    ]);
  });

  it('publishes the retained wallet count to instruments built after the runner started', async () => {
    const usage = new AsyncAdmissionUsage();
    usage.setLiftWallets(['a', 'b']); // telemetry is off, so this record reached no instrument

    // Telemetry is enabled while the runner is active: the wallets do not change again.
    const enabled = await captureMetrics(() => usage.republishLiftWallets());
    expect(enabled).toEqual([{ metric: 'dkg.async_lift.configured_wallets', value: 2, attributes: {} }]);

    // After the runner stops, the sampling path publishes zero rather than the last count.
    usage.setLiftWallets([]);
    const stopped = await captureMetrics(() => usage.republishLiftWallets());
    expect(stopped).toEqual([{ metric: 'dkg.async_lift.configured_wallets', value: 0, attributes: {} }]);
  });

  it('publishes queue depth and journal entries to the gauges', async () => {
    const usage = new AsyncAdmissionUsage();
    const recorded = await captureMetrics(() => {
      usage.recordQueueDepth('lift', { accepted: 3, claimed: 1 });
      usage.recordJournalEntries(42);
    });
    expect(recorded).toEqual([
      { metric: 'dkg.async_queue.depth', value: 3, attributes: { queue: 'lift', state: 'accepted' } },
      { metric: 'dkg.async_queue.depth', value: 1, attributes: { queue: 'lift', state: 'claimed' } },
      { metric: 'dkg.async_queue.journal_entries', value: 42, attributes: {} },
    ]);
  });
});

describe('AsyncAdmissionUsage windows and counters', () => {
  it('drains every window on take but keeps the counters and the gauges', () => {
    const usage = new AsyncAdmissionUsage();
    usage.setLiftWallets(['a']);
    usage.liftWalletObserved('a', false, 0);
    usage.recordHttpOutcome(outcome());
    usage.recordLiftClaim(1, 2);
    usage.recordLiftFinish('finalized', 1, 2);
    usage.recordShareLeaseRecovery({ reclaimed: 1, abandoned: 1 });

    const first = usage.take();
    expect(first.liftPickup.n).toBe(1);
    const second = usage.take();
    expect(second.liftPickup.n).toBe(0);
    expect(second.liftClaimToFinish.n).toBe(0);
    expect(second.httpLatency.publish_async.n).toBe(0);
    expect(second).toMatchObject({
      shareReclaimed: 1, shareAbandoned: 1, liftFinalized: 1, liftWallets: 1,
    });
    expect(second.http).toHaveLength(1);
  });

  it('forgets everything on reset', () => {
    const usage = new AsyncAdmissionUsage();
    usage.setLiftWallets(['a']);
    usage.recordHttpOutcome(outcome());
    usage.recordLiftStaleClaim();
    usage.recordLiftClaim(1, 2);
    void usage.observeShareHeartbeat(new Promise<void>(() => {}));
    usage.reset();

    const snapshot = usage.take();
    expect(snapshot.http).toEqual([]);
    expect(snapshot).toMatchObject({ liftStaleClaims: 0, liftWallets: 0, liftPickupUnclassified: 0 });
    expect(snapshot.shareHeartbeat.pending).toBe(0);
    expect(snapshot.liftPickup.n).toBe(0);
  });

  it('defaults to a monotonic clock and shares one process-wide instance', async () => {
    const usage = new AsyncAdmissionUsage();
    await usage.timeShareClaim(async () => undefined);
    expect(usage.take().shareClaim.n).toBe(1);
    expect(asyncAdmissionUsage).toBeInstanceOf(AsyncAdmissionUsage);
  });

  it('never throws into the caller when an instrument fails', () => {
    const usage = new AsyncAdmissionUsage();
    const instrument = () => ({ add: () => { throw new Error('exporter down'); }, record: () => { throw new Error('exporter down'); } });
    otelMetrics.setGlobalMeterProvider({
      getMeter: () => ({
        createGauge: instrument, createCounter: instrument, createHistogram: instrument, createUpDownCounter: instrument,
      }),
    } as never);
    rebuildMetrics();

    expect(() => {
      usage.recordHttpOutcome(outcome());
      usage.recordShareLeaseRecovery({ reclaimed: 1, abandoned: 1 });
      usage.recordLiftStaleClaim();
      usage.recordLiftReclaim();
      usage.setLiftWallets(['a']);
      usage.recordLiftClaim(1, 2);
      usage.recordLiftFinish('finalized', 1, 2);
      usage.recordQueueDepth('share', { queued: 1 });
      usage.recordJournalEntries(1);
    }).not.toThrow();
    expect(usage.take().http).toHaveLength(1);
  });
});
