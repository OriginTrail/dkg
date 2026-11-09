/**
 * OT-RFC-73 P11: the publisher sweep through the production wiring (plan section 5.3, AC7). The sweep is created AFTER the publisher and FROM the daemon's admission
 * instance (`createPublisherControlFromStore`, the object `lifecycle.ts` calls `publisherControl`), with that instance's own `retentionAccess()` and so over the store
 * object the instance was built with: the claim transaction it deletes in is the one that serializes this instance's admissions, claims and clears. Mode `off` touches
 * nothing; a sweep that cannot be built is logged loudly and the daemon keeps running without it.
 *
 * The rows below are written by the real publisher (enqueue, claim, validate, finalize or fail), aged by steering the wall clock only while they are written.
 *
 * Two blocks pin the hand-offs of the factory: the operator's resolved settings into the core (a lost window would make the core fall back to 7 days and delete what the
 * operator asked to keep, AC7/D-6), and the core's counters and the sweep's mode out to the periodic usage line (delete-gate item 1 reads the pass gauge).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { createLiftJobFailureMetadata, createPublisherRetention, readLiftJournalEntryCount } from '@origintrail-official/dkg-publisher';
import { createPublisherControlFromStore } from '../src/publisher-runner.js';
import { resolveRetentionConfig } from '../src/retention-config.js';
import { startRetention } from '../src/daemon/retention-sweeps.js';
import { createPublisherRetentionSweep, publisherRetentionSweepFactory } from '../src/daemon/retention-publisher-sweep.js';
import { formatAsyncAdmissionUsageLine, type AsyncAdmissionUsageSample } from '../src/daemon/async-admission-usage-log.js';
import type { RetentionAgent, RetentionSweepContext } from '../src/daemon/retention-timer.js';

// A spy that delegates to the real core: the hand-off tests read the config the factory passed, every other test runs the real thing.
vi.mock('@origintrail-official/dkg-publisher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-publisher')>();
  return { ...actual, createPublisherRetention: vi.fn(actual.createPublisherRetention) };
});

const DAY = 24 * 3_600_000;
type Control = ReturnType<typeof createPublisherControlFromStore>;
const settingsFor = (mode: 'report' | 'delete', over: Record<string, unknown> = {}) => resolveRetentionConfig({ publisher: { mode, ...over } });

/** Anything that touches it fails the test: the agent of a publisher-only start, and the publisher of a start that must not reach it. */
const untouchable = <T,>(): T => new Proxy({}, {
  get(_target, property) { throw new Error(`touched: ${String(property)}`); },
  has() { throw new Error('touched'); },
}) as T;

/** A store object that is not the raw store, as every production store is a wrapper around it; `intercept` may replace a method. */
const wrapped = (raw: TripleStore, intercept?: (name: string, run: (...args: unknown[]) => Promise<unknown>) => ((...args: unknown[]) => Promise<unknown>) | undefined): TripleStore =>
  new Proxy(raw, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const run = (...args: unknown[]) => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      return intercept?.(String(property), run) ?? value.bind(target);
    },
  }) as TripleStore;

/** The request of the nth publish job; jobs with the same `key` are siblings (one lifecycle key). */
function publishRequest(key: string, n: number) {
  const authorAddress = '0x1111111111111111111111111111111111111111';
  const kaNumber = BigInt(n);
  const kaUal = `did:dkg:31337/${authorAddress}/${n}`;
  const hex = n.toString(16).padStart(2, '0');
  return {
    contextGraphId: 'music-social', name: key, agentAddress: '0x0', shareOperationId: `share-op-${n}`,
    roots: [] as string[], contentScopeVersion: 2 as const, kaUal, assertionVersion: '1',
    publicTripleCount: 2, privateTripleCount: 0,
    seal: {
      merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`, authorAddress: authorAddress as `0x${string}`,
      signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
      schemeVersion: 1, reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
    },
    sealChainId: '31337' as `${bigint}`, sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
    intentKey: `sha256:${hex.repeat(32)}`, wmCurrentAssertion: '12'.repeat(32), swmCurrentAssertion: '12'.repeat(32),
    kaNumber: kaNumber.toString(), reservedUal: kaUal,
  };
}

interface JobSpec {
  /** Jobs of one key are siblings, in the order given. */
  readonly key: string;
  /** How long ago the job finished (or failed, or was accepted). */
  readonly ageMs: number;
  readonly end: 'finalized' | 'failed' | 'accepted';
}

/**
 * A real publisher (the daemon's admission instance) over a wrapped store, with the jobs of `specs` written through its public API in the order given. The wall clock
 * is steered, and only it, while each job is written, so the job carries its age. A job that stays `accepted` must come last (the next claim would take it).
 */
async function publisherWithJobs(stores: OxigraphStore[], specs: readonly JobSpec[], intercept?: Parameters<typeof wrapped>[1]) {
  const raw = new OxigraphStore();
  stores.push(raw);
  const store = wrapped(raw, intercept);
  const publisher: Control = createPublisherControlFromStore(store, {});
  const real = Date.now();
  const ids: string[] = [];
  vi.useFakeTimers({ toFake: ['Date'], now: real });
  try {
    for (const [index, spec] of specs.entries()) {
      vi.setSystemTime(real - spec.ageMs);
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(publishRequest(spec.key, index + 1));
      ids.push(jobId);
      if (spec.end === 'accepted') continue;
      await publisher.claimNext('wallet-1');
      await publisher.update(jobId, 'validated', {
        validation: { canonicalRoots: [], canonicalRootMap: {}, swmQuadCount: 2, authorityProofRef: 'knowledge-asset-lifecycle', transitionType: 'CREATE' },
      });
      if (spec.end === 'finalized') await publisher.update(jobId, 'finalized', { finalization: { mode: 'local' } });
      else {
        await publisher.update(jobId, 'failed', {
          failure: createLiftJobFailureMetadata({ failedFromState: 'validated', code: 'workspace_slice_not_found', message: 'gone', errorPayloadRef: 'urn:error:gone' }) as never,
        });
      }
    }
  } finally {
    vi.useRealTimers();
  }
  const exists = async (jobId: string): Promise<boolean> => (await publisher.getStatus(jobId)) !== null;
  return { raw, store, publisher, ids, exists };
}

const emptyUsage = (): AsyncAdmissionUsageSample['usage'] => {
  const empty = { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  return {
    http: [], httpLatency: { share_async: empty, publish_async: empty }, shareReclaimed: 0, shareAbandoned: 0, shareHeartbeat: { ...empty, pending: 0, oldestPendingMs: 0 },
    shareClaim: empty, liftReclaimed: 0, liftStaleClaims: 0, liftFinalized: 0, liftFailed: 0, liftWallets: 0, liftPickup: empty, liftPickupWorkerFree: empty,
    liftPickupUnclassified: 0, liftClaimToFinish: empty,
  };
};
const usageLine = (retention: AsyncAdmissionUsageSample['retention']): string => formatAsyncAdmissionUsageLine({
  intervalSeconds: 300, store: [], usage: emptyUsage(), depth: { share: null, lift: null, liftJournal: null }, depthErrors: 0, shareWorker: null, retention,
});

const stores: OxigraphStore[] = [];
beforeEach(() => { vi.mocked(createPublisherRetention).mockClear(); });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map(store => store.close().catch(() => undefined)));
});

describe('the publisher sweep is made from the daemon admission instance, over its own store object', () => {
  const OPERATOR = { intervalMs: 5_000, batchSize: 7, finalizedMaxAgeMs: 10 * DAY, rescanIntervalMs: 120_000 };

  it.each(['report', 'delete'] as const)('%s mode: the core gets publisher.retentionAccess() and every resolved value, none dropped or defaulted', async (mode) => {
    const { publisher, store } = await publisherWithJobs(stores, []);
    const access = publisher.retentionAccess();
    const spy = vi.spyOn(publisher, 'retentionAccess').mockReturnValue(access);
    const sweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher, settings: settingsFor(mode, OPERATOR), log: vi.fn() })!;
    expect(spy).toHaveBeenCalledTimes(1);
    const created = vi.mocked(createPublisherRetention).mock.calls;
    expect(created).toHaveLength(1);
    const { access: given, ...rest } = created[0]![0];
    expect(given).toBe(access);                                                     // the access of that instance, not one made on the side
    expect(given.store).toBe(store);                                                // the object the instance was built with: not the raw store, not a wrapper of it
    expect(rest).toStrictEqual({ mode, ...OPERATOR });
    expect(sweep).toMatchObject({ queue: 'publisher', mode, intervalMs: OPERATOR.intervalMs });
  });

  it('the starter hands the daemon\'s publisher to the factory, and only that publisher', async () => {
    const { publisher } = await publisherWithJobs(stores, []);
    const create = vi.fn((context: RetentionSweepContext) => publisherRetentionSweepFactory.create(context));
    const handle = startRetention({
      runtime: 'daemon-admission', settings: settingsFor('report'), agent: untouchable<RetentionAgent>(), publisher, log: vi.fn(),
      factories: [{ queue: 'publisher', create }],
    });
    try {
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0].publisher).toBe(publisher);
      expect(handle.usage().map(view => view.queue)).toEqual(['publisher']);
    } finally {
      await handle.stop();
    }
  });

  it('mode off creates nothing: neither the publisher nor the agent is touched, and the core is never asked for anything', () => {
    expect(createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher: untouchable(), settings: resolveRetentionConfig(undefined), log: vi.fn() })).toBeUndefined();
    expect(publisherRetentionSweepFactory.create({ agent: untouchable<RetentionAgent>(), publisher: untouchable(), settings: resolveRetentionConfig({ publisher: { mode: 'off' } }), log: vi.fn() })).toBeUndefined();
    const handle = startRetention({ runtime: 'daemon-admission', settings: resolveRetentionConfig(undefined), agent: untouchable<RetentionAgent>(), publisher: untouchable(), log: vi.fn() });
    expect(handle.usage()).toEqual([]);
    expect(createPublisherRetention).not.toHaveBeenCalled();
  });

  it('mode off makes no store call even when the publisher is real: no timer exists and the publisher\'s store is never reached', async () => {
    const calls: string[] = [];
    const { publisher } = await publisherWithJobs(stores, [], (name, run) => async (...args) => { calls.push(name); return run(...args); });
    calls.length = 0;
    vi.useFakeTimers();
    try {
      const handle = startRetention({ runtime: 'daemon-admission', settings: resolveRetentionConfig({ share: { mode: 'off' }, publisher: { mode: 'off' } }), agent: untouchable<RetentionAgent>(), publisher, log: vi.fn() });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a sweep that cannot be built is logged loudly and the daemon keeps running', () => {
  const cases: ReadonlyArray<readonly [string, (publisher: Control) => Control | undefined, string]> = [
    ['no publisher was handed in', () => undefined, 'the daemon admission instance of the publisher queue is unavailable'],
    ['the instance cannot give its retention access', (publisher) => Object.assign(publisher, { retentionAccess: () => { throw new Error('access refused'); } }), 'access refused'],
  ];

  it.each(['report', 'delete'] as const)('%s mode, through the starter: an error naming the cause, no timer, no usage figures, nothing thrown into the daemon, not one store call', async (mode) => {
    for (const [name, prepare, cause] of cases) {
      const calls: string[] = [];
      const { publisher } = await publisherWithJobs(stores, [], (method, run) => async (...args) => { calls.push(method); return run(...args); });
      calls.length = 0;
      const log = vi.fn();
      vi.useFakeTimers();
      try {
        const handle = startRetention({ runtime: 'daemon-admission', settings: settingsFor(mode), agent: untouchable<RetentionAgent>(), publisher: prepare(publisher), log });
        expect(handle.usage(), name).toEqual([]);
        expect(vi.getTimerCount(), name).toBe(0);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(calls, name).toEqual([]);
        const errors = log.mock.calls.map(call => String(call[0])).filter(line => line.includes('[error]'));
        expect(errors, name).toHaveLength(1);
        expect(errors[0], name).toBe(`[error] [retention] publisher retention (mode=${mode}) was NOT started: ${cause}. The daemon keeps running with publisher retention off.`);
        await expect(handle.stop()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('a setting the core refuses is not swallowed by the factory: it throws, and the starter logs it and starts the other queue', async () => {
    const { publisher } = await publisherWithJobs(stores, []);
    vi.useFakeTimers();
    try {
      vi.mocked(createPublisherRetention).mockImplementationOnce(() => { throw new Error('finalizedMaxAgeMs must be at least 86400000 ms (24 hours)'); });
      expect(() => createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher, settings: settingsFor('delete'), log: vi.fn() })).toThrow('at least 86400000 ms');

      vi.mocked(createPublisherRetention).mockImplementationOnce(() => { throw new Error('finalizedMaxAgeMs must be at least 86400000 ms (24 hours)'); });
      const share = { queue: 'share' as const, create: vi.fn(() => undefined) };
      const log = vi.fn();
      const handle = startRetention({
        runtime: 'daemon-admission', settings: resolveRetentionConfig({ share: { mode: 'report' }, publisher: { mode: 'delete' } }), agent: untouchable<RetentionAgent>(), publisher, log,
        factories: [share, publisherRetentionSweepFactory],
      });
      expect(share.create).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.map(call => String(call[0])).find(line => line.includes('NOT started'))).toMatch(/^\[error\] \[retention\] publisher retention \(mode=delete\) was NOT started: finalizedMaxAgeMs must be at least/);
      expect(handle.usage()).toEqual([]);
      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the sweep does to real rows', () => {
  const old = 8 * DAY;
  const specsOf = (...specs: JobSpec[]) => specs;

  it('delete mode removes an old finalized job and keeps the rest: a young one, a failed one however old, a job that is not finished; the journal is untouched', async () => {
    const { raw, publisher, ids, exists } = await publisherWithJobs(stores, specsOf(
      { key: 'old-finalized', ageMs: old, end: 'finalized' },
      { key: 'young-finalized', ageMs: 1 * DAY, end: 'finalized' },
      { key: 'old-failed', ageMs: 30 * DAY, end: 'failed' },
      { key: 'unfinished', ageMs: old, end: 'accepted' },
    ));
    const signal = new AbortController().signal;
    const journalBefore = await readLiftJournalEntryCount(raw, { signal });
    expect(journalBefore).toBeGreaterThan(0);                                         // the journal is on in the admission instance, so there is something to leave alone
    const log = vi.fn();
    const sweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher, settings: settingsFor('delete'), log })!;
    expect(sweep.mode).toBe('delete');
    expect(await sweep.runBatch()).toMatchObject({ scanned: 1, deleted: 1, wouldDelete: 0 });
    expect(await Promise.all(ids.map(exists))).toEqual([false, true, true, true]);
    expect(await readLiftJournalEntryCount(raw, { signal })).toBe(journalBefore);
    expect(sweep.counters().deleted).toEqual({ finalized: 1 });
    expect(sweep.counters().lastCompletePass).toMatchObject({ scanned: 1, deleted: { finalized: 1 }, wouldDelete: { finalized: 0 } });
    expect(log).not.toHaveBeenCalled();                                              // the factory has nothing of its own to say about a healthy sweep
  });

  it('report mode counts what delete would remove and removes nothing (the gauge delete-gate item 1 reads)', async () => {
    const { publisher, ids, exists } = await publisherWithJobs(stores, specsOf(
      { key: 'a', ageMs: old, end: 'finalized' }, { key: 'b', ageMs: old + 1, end: 'finalized' }, { key: 'c', ageMs: 2 * DAY, end: 'finalized' },
    ));
    const sweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher, settings: settingsFor('report'), log: vi.fn() })!;
    expect(sweep.mode).toBe('report');
    expect(sweep.counters().lastCompletePass).toBeNull();                              // nothing has run yet
    expect(await sweep.runBatch()).toMatchObject({ scanned: 2, deleted: 0, wouldDelete: 2 });
    expect(await Promise.all(ids.map(exists))).toEqual([true, true, true]);
    expect(sweep.counters().deleted).toEqual({ finalized: 0 });
    expect(sweep.counters().lastCompletePass).toMatchObject({ scanned: 2, wouldDelete: { finalized: 2 }, deleted: { finalized: 0 } });
    expect(sweep.counters().errors).toEqual({ scan: 0, verify: 0, delete: 0 });
  });

  it('the sibling rule holds through the wiring: a finalized job stays while an older failed job of its key stays, and goes once an operator has cleared the failed one', async () => {
    const { publisher, ids, exists } = await publisherWithJobs(stores, specsOf(
      { key: 'same-asset', ageMs: 20 * DAY, end: 'failed' }, { key: 'same-asset', ageMs: old, end: 'finalized' },
    ));
    expect(new Set(ids).size).toBe(2);                                                 // two jobs of one lifecycle key
    const first = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher, settings: settingsFor('delete'), log: vi.fn() })!;
    expect(await first.runBatch()).toMatchObject({ scanned: 1, deleted: 0, kept: { older_sibling_kept: 1 } });
    expect(await Promise.all(ids.map(exists))).toEqual([true, true]);

    // clearing the failed job is the operator's act; the finalized one then has no older record left
    await expect(publisher.clearTerminalJob(ids[0]!)).resolves.toMatchObject({ outcome: 'cleared' });
    const second = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher, settings: settingsFor('delete'), log: vi.fn() })!;
    expect(await second.runBatch()).toMatchObject({ scanned: 1, deleted: 1 });
    expect(await Promise.all(ids.map(exists))).toEqual([false, false]);
  });
});

describe('settings seen in the rows the sweep touches', () => {
  // Each case has a control that deletes the job under the default settings, so a job that survives survives because of the operator's value.
  it('finalizedMaxAgeMs: a 10-day window keeps an 8-day-old finalized job that the default 7-day window removes', async () => {
    const kept = await publisherWithJobs(stores, [{ key: 'a', ageMs: 8 * DAY, end: 'finalized' }]);
    const keptSweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher: kept.publisher, settings: settingsFor('delete', { finalizedMaxAgeMs: 10 * DAY }), log: vi.fn() })!;
    expect(await keptSweep.runBatch()).toMatchObject({ scanned: 0, deleted: 0 });
    expect(await kept.exists(kept.ids[0]!)).toBe(true);

    const control = await publisherWithJobs(stores, [{ key: 'a', ageMs: 8 * DAY, end: 'finalized' }]);
    const controlSweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher: control.publisher, settings: settingsFor('delete'), log: vi.fn() })!;
    expect(await controlSweep.runBatch()).toMatchObject({ deleted: 1 });
    expect(await control.exists(control.ids[0]!)).toBe(false);
  });

  it('batchSize: 1 judges one of two old jobs per tick, the default judges both', async () => {
    const jobs: JobSpec[] = [{ key: 'a', ageMs: 8 * DAY, end: 'finalized' }, { key: 'b', ageMs: 8 * DAY + 1, end: 'finalized' }];
    const one = await publisherWithJobs(stores, jobs);
    const oneSweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher: one.publisher, settings: settingsFor('report', { batchSize: 1 }), log: vi.fn() })!;
    expect(await oneSweep.runBatch()).toMatchObject({ scanned: 1, wouldDelete: 1 });

    const both = await publisherWithJobs(stores, jobs);
    const bothSweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher: both.publisher, settings: settingsFor('report'), log: vi.fn() })!;
    expect(await bothSweep.runBatch()).toMatchObject({ scanned: 2, wouldDelete: 2 });
  });

  it('intervalMs is the core\'s clock-guard unit: a 10 s forward clock step skips the next tick at 1 s (tolerance 3 s) and not at the default 60 s (tolerance 3 min)', async () => {
    const outcomes: Array<string | undefined> = [];
    const tick = async (sweep: { runBatch(): Promise<unknown> }) => ((await sweep.runBatch()) as { skipped?: string }).skipped;
    for (const intervalMs of [1_000, 60_000]) {
      const { publisher } = await publisherWithJobs(stores, [{ key: 'a', ageMs: 8 * DAY, end: 'finalized' }]);
      const sweep = createPublisherRetentionSweep({ agent: untouchable<RetentionAgent>(), publisher, settings: settingsFor('report', { intervalMs }), log: vi.fn() })!;
      vi.useFakeTimers({ toFake: ['Date'] });                                        // the wall clock only; the store and the monotonic clock stay real
      try {
        expect(await tick(sweep)).toBeUndefined();                                   // the baseline tick
        vi.setSystemTime(Date.now() + 10_000);
        outcomes.push(await tick(sweep));
        expect(sweep.counters().skipped).toMatchObject({ clock_jump: outcomes.at(-1) === 'clock_jump' ? 1 : 0 });
      } finally {
        vi.useRealTimers();
      }
    }
    expect(outcomes).toEqual(['clock_jump', undefined]);
  });
});

describe('counters and mode out of the core, and the periodic line', () => {
  it('a failed scan is counted: errors.scan reaches the sweep counters and the usage line, and the timer logs the failed tick', async () => {
    let failing = false;
    const { publisher } = await publisherWithJobs(stores, [{ key: 'a', ageMs: 8 * DAY, end: 'finalized' }], (name, run) => (name !== 'query' ? undefined : async (...args) => {
      if (failing) throw new Error('store down');
      return run(...args);
    }));
    failing = true;
    const log = vi.fn();
    const handle = startRetention({ runtime: 'daemon-admission', settings: settingsFor('report', { intervalMs: 1_000 }), agent: untouchable<RetentionAgent>(), publisher, log });
    try {
      await vi.waitFor(() => expect(handle.usage()[0]?.ticks).toBeGreaterThanOrEqual(1), { timeout: 10_000, interval: 50 });
      const view = handle.usage()[0]!;
      expect(view.errors.scan).toBeGreaterThanOrEqual(1);                              // the core's own count, not a constant
      expect(view.errors).not.toHaveProperty('tick');                                   // the core counted it; the batch did not throw
      expect(usageLine(handle.usage())).toMatch(/ lift_retention_errors=scan:[1-9]\d* /);
      expect(log.mock.calls.map(call => String(call[0])).filter(entry => entry.includes('tick failed'))[0]).toContain('publisher retention (report) tick failed');
      expect(log.mock.calls.map(call => String(call[0])).filter(entry => entry.includes('tick failed'))[0]).toContain('scan phase: store down');
    } finally {
      await handle.stop();
    }
  });

  /** The production timer and the production line: one complete report pass over a kept and a would-delete job, then a forward clock step makes the next tick skip. */
  it('the usage view and line carry the pass gauge (would-delete), the kept reasons, the mode and the skips the core reported', async () => {
    const { publisher } = await publisherWithJobs(stores, [
      { key: 'a', ageMs: 8 * DAY, end: 'finalized' }, { key: 'b', ageMs: 1 * DAY, end: 'finalized' }, { key: 'c', ageMs: 9 * DAY, end: 'failed' },
    ]);
    vi.useFakeTimers({ toFake: ['Date'] });                                           // only the wall clock is steered; timers and the store stay real
    const handle = startRetention({ runtime: 'daemon-admission', settings: settingsFor('report', { intervalMs: 1_000 }), agent: untouchable<RetentionAgent>(), publisher, log: vi.fn() });
    try {
      await vi.waitFor(() => expect(handle.usage()[0]?.ticks).toBeGreaterThanOrEqual(1), { timeout: 10_000, interval: 50 });
      vi.setSystemTime(Date.now() + 3_600_000);                                        // a real forward step of an hour: 3 s is the tolerance at this interval
      await vi.waitFor(() => expect(handle.usage()[0]?.ticks).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 50 });
      const view = handle.usage()[0]!;
      expect(view).toMatchObject({ queue: 'publisher', mode: 'report' });
      expect(view.lastCompletePass).toMatchObject({ scanned: 1, wouldDelete: { finalized: 1 }, deleted: { finalized: 0 } });
      expect(view.skipped.clock_jump).toBeGreaterThanOrEqual(1);
      const line = usageLine(handle.usage());
      expect(line).toContain(' lift_retention=report ');
      expect(line).not.toContain('share_retention');                                    // only a registered sweep prints
      expect(line).toContain(' lift_retention_pass_scanned=1 lift_retention_pass_would_delete=finalized:1 lift_retention_pass_deleted=finalized:0');
      expect(line).toMatch(/ lift_retention_skipped=clock_jump:[1-9]\d* /);
      expect(line).toMatch(/ lift_retention_deleted=finalized:0 /);
    } finally {
      await handle.stop();
    }
  });

  it('delete mode through the timer: the job leaves, the cumulative counter and the pass gauge say so, and nothing else moves', async () => {
    const { publisher, ids, exists } = await publisherWithJobs(stores, [{ key: 'a', ageMs: 8 * DAY, end: 'finalized' }, { key: 'b', ageMs: 2 * DAY, end: 'finalized' }]);
    const log = vi.fn();
    const handle = startRetention({ runtime: 'daemon-admission', settings: settingsFor('delete', { intervalMs: 1_000 }), agent: untouchable<RetentionAgent>(), publisher, log });
    try {
      await vi.waitFor(() => expect(handle.usage()[0]?.ticks).toBeGreaterThanOrEqual(1), { timeout: 10_000, interval: 50 });
      expect(await Promise.all(ids.map(exists))).toEqual([false, true]);
      const line = usageLine(handle.usage());
      expect(line).toContain(' lift_retention=delete ');
      expect(line).toContain(' lift_retention_deleted=finalized:1 ');
      expect(line).toMatch(/ lift_retention_pass_deleted=finalized:1$/);
      const lines = log.mock.calls.map(call => String(call[0]));
      expect(lines.find(entry => entry.includes('started'))).toMatch(/^\[warn\] \[retention\] publisher retention started in DELETE mode/);
    } finally {
      await handle.stop();
    }
    const ticks = handle.usage()[0]!.ticks;
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(handle.usage()[0]!.ticks).toBe(ticks);                                      // stopped: no tick after the stop
  });
});
