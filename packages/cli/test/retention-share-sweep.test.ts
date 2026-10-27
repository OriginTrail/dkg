/**
 * OT-RFC-73 P10b: the share sweep through the production wiring (plan section 5.3, AC7): the sweep is created AFTER the queue and over the queue's OWN store object
 * (`agent.store`, the object `dkg-agent.ts` hands to `TripleStoreAsyncPromoteQueue`), reached through `agent.promoteQueue`, so an admission still pending through
 * the queue (a lost-ack enqueue) protects its job from the sweep. When the wiring is broken the daemon says so and keeps running without retention.
 *
 * The last block pins the two hand-offs of the factory: the operator's resolved settings into the core (a lost window would make the core fall back to 7 days and
 * delete what the operator asked to keep, AC7/D-6), and the core's counters and the sweep's mode out to the periodic usage line (delete-gate item 1 reads the pass
 * gauge; the startup log and the usage line must say the mode the sweep really runs in).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore, StoreSchedulerBusyError, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue, createShareRetention, type AsyncPromoteQueueConfig } from '@origintrail-official/dkg-publisher';
import { resolveRetentionConfig } from '../src/retention-config.js';
import { startRetention } from '../src/daemon/retention-sweeps.js';
import { createShareRetentionSweep, shareRetentionSweepFactory } from '../src/daemon/retention-share-sweep.js';
import { formatAsyncAdmissionUsageLine, type AsyncAdmissionUsageSample } from '../src/daemon/async-admission-usage-log.js';
import type { RetentionAgent } from '../src/daemon/retention-timer.js';

// A spy that delegates to the real core: the hand-off tests read the config the factory passed, every other test runs the real thing.
vi.mock('@origintrail-official/dkg-publisher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-publisher')>();
  return { ...actual, createShareRetention: vi.fn(actual.createShareRetention) };
});

const DAY = 24 * 3_600_000;
const GRAPH = 'urn:dkg:promote-queue:control-plane';
const JOB = 'lost-ack-1';
const AGENT_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const settingsFor = (mode: 'report' | 'delete', over: Record<string, unknown> = {}) => resolveRetentionConfig({ share: { mode, ...over } });

/** A store object that is not the raw store, as every production store is a wrapper around it. */
const wrapped = (raw: TripleStore, intercept?: (name: string, run: (...args: unknown[]) => Promise<unknown>) => ((...args: unknown[]) => Promise<unknown>) | undefined): TripleStore =>
  new Proxy(raw, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const run = (...args: unknown[]) => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      return intercept?.(String(property), run) ?? value.bind(target);
    },
  }) as TripleStore;

describe('the share sweep over the production wiring', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close().catch(() => undefined))); });

  /**
   * A real `DKGAgent` (its production `store` field and `promoteQueue` getter; the libp2p node is not built) whose queue admits one share and loses the reply: job
   * `lost-ack-1` is committed, and the queue's own coordinator keeps the admission pending. The job is then finished eight days ago by a second queue over the raw
   * store (a different object, hence a different coordinator), so nothing has observed it through the agent's queue and only the pending admission protects it.
   */
  async function lostAckAgent() {
    const raw = new OxigraphStore();
    stores.push(raw);
    const then = Date.now() - 8 * DAY;
    let armed = true;
    const store = wrapped(raw, (name, run) => (name !== 'replaceSubject' ? undefined : async (...args) => {
      const out = await run(...args);
      if (armed) { armed = false; throw new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'nested.query', { storeOperation: 'query' }); }   // the write commits, the reply is lost
      return out;
    }));
    const agent = Object.create(DKGAgent.prototype) as DKGAgent & { store: TripleStore };
    agent.store = store;
    agent.configurePromoteQueue({ now: () => then, idGenerator: () => JOB, admissionTimeoutMs: 1_000 } satisfies Partial<AsyncPromoteQueueConfig>);
    const admission = await agent.promoteQueue.enqueue({ contextGraphId: 'cg', assertionName: 'lost', agentAddress: AGENT_ADDRESS, entities: 'all' })
      .then(() => undefined, (cause: unknown) => cause) as { admissionOutcome?: string; jobId?: string };
    expect(admission).toMatchObject({ admissionOutcome: 'indeterminate', jobId: JOB });
    const other = new TripleStoreAsyncPromoteQueue(raw, { now: () => then });
    const claimed = (await other.claimNext('worker'))!;
    await other.recordCommitMarker(claimed.jobId, claimed.lease!.claimToken, 'swmInserted');
    await other.succeed(claimed.jobId, claimed.lease!.claimToken, { promotedCount: 1, succeededAt: then });
    return { raw, agent, store };
  }

  const present = async (raw: TripleStore): Promise<boolean> => {
    const result = await raw.query(`ASK { GRAPH <${GRAPH}> { <urn:dkg:promote-queue:job:${JOB}> ?p ?o } }`);
    return result.type === 'boolean' ? result.value : false;
  };

  it('report mode: an admission still pending through agent.promoteQueue keeps its job (pending_admission) until a durable read through the queue settles it', async () => {
    const { raw, agent } = await lostAckAgent();
    const log = vi.fn();
    const sweep = createShareRetentionSweep({ agent, settings: settingsFor('report'), log })!;
    expect(sweep).toBeDefined();
    expect(await sweep.runBatch()).toMatchObject({ wouldDelete: 0, kept: { pending_admission: 1 } });
    expect(sweep.counters().kept).toMatchObject({ pending_admission: 1 });
    expect(await present(raw)).toBe(true);

    // a durable read through the production queue settles the admission; the next sweep judges the job deletable
    expect(await agent.promoteQueue.getStatus(JOB)).toMatchObject({ state: 'succeeded' });
    const later = createShareRetentionSweep({ agent, settings: settingsFor('report'), log })!;
    expect(await later.runBatch()).toMatchObject({ wouldDelete: 1, deleted: 0, kept: { pending_admission: 0 } });
    expect(await present(raw)).toBe(true);                                          // report deletes nothing
    expect(log).not.toHaveBeenCalled();
  });

  it('delete mode: the same job survives the sweep while its admission is pending, and is removed once the queue has settled it', async () => {
    const { raw, agent } = await lostAckAgent();
    const log = vi.fn();
    const sweep = createShareRetentionSweep({ agent, settings: settingsFor('delete'), log })!;
    expect(await sweep.runBatch()).toMatchObject({ deleted: 0, kept: { pending_admission: 1 } });
    expect(await present(raw)).toBe(true);
    await agent.promoteQueue.getStatus(JOB);
    expect(await createShareRetentionSweep({ agent, settings: settingsFor('delete'), log })!.runBatch()).toMatchObject({ deleted: 1 });
    expect(await present(raw)).toBe(false);
  });

  it('reads agent.promoteQueue first: with no queue yet, the factory makes it (over agent.store) before it looks for the coordinator', async () => {
    const raw = new OxigraphStore();
    stores.push(raw);
    const agent = Object.create(DKGAgent.prototype) as DKGAgent & { store: TripleStore; _promoteQueue?: unknown };
    agent.store = wrapped(raw);
    expect(agent._promoteQueue).toBeUndefined();
    const log = vi.fn();
    const sweep = createShareRetentionSweep({ agent, settings: settingsFor('report'), log });
    expect(sweep).toBeDefined();                                                    // had the queue not been made first, the core would have refused
    expect(log).not.toHaveBeenCalled();
    expect(agent._promoteQueue).toBeInstanceOf(TripleStoreAsyncPromoteQueue);
  });

  it('mode off creates nothing: the agent and its store are not touched', () => {
    const untouchable = new Proxy({}, { get(_target, property) { throw new Error(`touched: ${String(property)}`); } }) as RetentionAgent;
    expect(createShareRetentionSweep({ agent: untouchable, settings: resolveRetentionConfig(undefined), log: vi.fn() })).toBeUndefined();
    expect(shareRetentionSweepFactory.create({ agent: untouchable, settings: settingsFor('report', { mode: 'off' }), log: vi.fn() })).toBeUndefined();
  });

  describe('when the queue was not made over agent.store (a wiring defect)', () => {
    /** The queue exists, but over another object; `agent.store` has no coordinator. A spy records every call made on `agent.store`. */
    function brokenAgent() {
      const raw = new OxigraphStore();
      stores.push(raw);
      const calls: string[] = [];
      const store = wrapped(raw, (name, run) => async (...args) => { calls.push(name); return run(...args); });
      const agent = Object.create(DKGAgent.prototype) as DKGAgent & { store: TripleStore; _promoteQueue: unknown };
      agent.store = store;
      agent._promoteQueue = new TripleStoreAsyncPromoteQueue(wrapped(raw), {});
      return { raw, agent, calls };
    }

    it.each(['report', 'delete'] as const)('%s mode: an error naming the cause is logged, no sweep exists, the daemon keeps running, and not one store call was made', (mode) => {
      const { agent, calls } = brokenAgent();
      const log = vi.fn();
      expect(createShareRetentionSweep({ agent, settings: settingsFor(mode), log })).toBeUndefined();     // no throw
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]![0]);
      expect(line).toMatch(new RegExp(`^\\[error\\] \\[retention\\] share retention \\(mode=${mode}\\) was NOT started - SHARE_RETENTION_ADMISSION_UNAVAILABLE: `));
      expect(line).toContain(GRAPH);
      expect(line).toContain('wiring defect');
      expect(line).toContain('keeps running with share retention off');
      expect(calls).toEqual([]);
    });

    it('through the starter: no timer, no usage figures, nothing thrown into the daemon', async () => {
      vi.useFakeTimers();
      try {
        const { agent, calls } = brokenAgent();
        const log = vi.fn();
        const handle = startRetention({ runtime: 'daemon-admission', settings: settingsFor('delete'), agent, log });
        expect(handle.usage()).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(calls).toEqual([]);
        expect(log.mock.calls.map(call => String(call[0])).filter(line => line.includes('[error]'))).toHaveLength(1);
        await expect(handle.stop()).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('end to end: startRetention -> factory -> agent.promoteQueue -> core -> timer -> the usage line', async () => {
    const { raw, agent } = await lostAckAgent();
    const log = vi.fn();
    const handle = startRetention({ runtime: 'daemon-admission', settings: settingsFor('report', { intervalMs: 1_000 }), agent, log });
    try {
      await vi.waitFor(() => expect(handle.usage()[0]?.ticks).toBeGreaterThanOrEqual(1), { timeout: 10_000, interval: 50 });
      const view = handle.usage()[0]!;
      expect(view).toMatchObject({ queue: 'share', mode: 'report', kept: { pending_admission: 1 }, errors: { scan: 0, verify: 0, delete: 0 } });
      expect(view.deleted).toEqual({ succeeded: 0, cancelled: 0, retired_no_effect: 0 });
      const line = formatAsyncAdmissionUsageLine({
        intervalSeconds: 300, store: [], usage: emptyUsage(), depth: { share: null, lift: null, liftJournal: null }, depthErrors: 0, shareWorker: null, retention: handle.usage(),
      });
      expect(line).toContain(' share_retention=report ');
      expect(line).toContain(' share_retention_kept=pending_admission:1 ');
      expect(await present(raw)).toBe(true);
    } finally {
      await handle.stop();
    }
    const ticks = handle.usage()[0]!.ticks;
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(handle.usage()[0]!.ticks).toBe(ticks);                                    // stopped: no tick after the stop
  });
});

/** A real `DKGAgent` (production `store` field and `promoteQueue` getter) whose queue holds finished jobs, each admitted with certainty (a settled enqueue). */
async function agentWithFinishedJobs(stores: OxigraphStore[], jobs: ReadonlyArray<{ id: string; ageMs: number; end: 'succeeded' | 'cancelled' }>) {
  const raw = new OxigraphStore();
  stores.push(raw);
  const agent = Object.create(DKGAgent.prototype) as DKGAgent & { store: TripleStore };
  agent.store = wrapped(raw);
  let clock = Date.now();
  let nextId = '';
  agent.configurePromoteQueue({ now: () => clock, idGenerator: () => nextId } satisfies Partial<AsyncPromoteQueueConfig>);
  for (const job of jobs) {
    clock = Date.now() - job.ageMs;                                                 // the queue stamps updatedAt from this clock
    nextId = job.id;
    const queue = agent.promoteQueue;
    await queue.enqueue({ contextGraphId: 'cg', assertionName: job.id, agentAddress: AGENT_ADDRESS, entities: 'all' });
    if (job.end === 'cancelled') { await queue.cancel(job.id); continue; }
    const claimed = (await queue.claimNext('worker'))!;
    await queue.recordCommitMarker(claimed.jobId, claimed.lease!.claimToken, 'swmInserted');
    await queue.succeed(claimed.jobId, claimed.lease!.claimToken, { promotedCount: 1, succeededAt: clock });
  }
  return { raw, agent };
}

const jobPresent = async (raw: TripleStore, id: string): Promise<boolean> => {
  const result = await raw.query(`ASK { GRAPH <${GRAPH}> { <urn:dkg:promote-queue:job:${id}> ?p ?o } }`);
  return result.type === 'boolean' ? result.value : false;
};

describe('the share factory hands the operator\'s settings to the core and the core\'s figures to the usage line', () => {
  const stores: OxigraphStore[] = [];
  beforeEach(() => { vi.mocked(createShareRetention).mockClear(); });              // the calls of the earlier blocks are not this block's
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(stores.splice(0).map(store => store.close().catch(() => undefined)));
  });
  const OPERATOR = { intervalMs: 5_000, batchSize: 7, succeededMaxAgeMs: 10 * DAY, benignFailedMaxAgeMs: 12 * DAY, rescanIntervalMs: 120_000 };

  describe('settings into the core', () => {
    it.each(['report', 'delete'] as const)('%s mode: the core is created over agent.store with every resolved value, none dropped or defaulted', (mode) => {
      const agent = Object.create(DKGAgent.prototype) as DKGAgent & { store: TripleStore };
      agent.store = wrapped(new OxigraphStore());
      stores.push(agent.store as unknown as OxigraphStore);
      const sweep = createShareRetentionSweep({ agent, settings: settingsFor(mode, OPERATOR), log: vi.fn() })!;
      const created = vi.mocked(createShareRetention).mock.calls;
      expect(created).toHaveLength(1);
      const { store, ...rest } = created[0]![0];
      expect(store).toBe(agent.store);                                              // the queue's own object, not a wrapper of it
      expect(rest).toStrictEqual({ mode, ...OPERATOR });
      expect(sweep).toMatchObject({ queue: 'share', mode, intervalMs: OPERATOR.intervalMs });
    });

    it('benignFailedMaxAgeMs null (keep the harmless failed classes too) reaches the core as null, not as an absent value that means 7 days', () => {
      const agent = Object.create(DKGAgent.prototype) as DKGAgent & { store: TripleStore };
      agent.store = wrapped(new OxigraphStore());
      stores.push(agent.store as unknown as OxigraphStore);
      createShareRetentionSweep({ agent, settings: settingsFor('delete', { benignFailedMaxAgeMs: null }), log: vi.fn() });
      expect(vi.mocked(createShareRetention).mock.calls[0]![0].benignFailedMaxAgeMs).toBeNull();
    });

    it('a failure of the core that is not the admission refusal is not swallowed: the factory throws it (the starter logs it)', () => {
      const agent = Object.create(DKGAgent.prototype) as DKGAgent & { store: TripleStore };
      agent.store = wrapped(new OxigraphStore());
      stores.push(agent.store as unknown as OxigraphStore);
      vi.mocked(createShareRetention).mockImplementationOnce(() => { throw new Error('succeededMaxAgeMs must be at least 86400000 ms (24 hours)'); });
      const log = vi.fn();
      expect(() => createShareRetentionSweep({ agent, settings: settingsFor('delete'), log })).toThrow('at least 86400000 ms');
      expect(log).not.toHaveBeenCalled();
    });

    it('a missing queue is refused before the core is asked for anything', () => {
      const agent = { store: wrapped(new OxigraphStore()), promoteQueue: undefined } as unknown as RetentionAgent;
      stores.push(agent.store as unknown as OxigraphStore);
      expect(() => createShareRetentionSweep({ agent, settings: settingsFor('report'), log: vi.fn() })).toThrow('the share promote queue is unavailable');
      expect(createShareRetention).not.toHaveBeenCalled();
    });
  });

  // The same values, seen from the outside: what the core does with them to real rows. Each case has a control that deletes the job under the default settings,
  // so a job that survives survives because of the operator's value and not because it was never old enough.
  describe('settings seen in the rows the sweep touches', () => {
    const jobs = (end: 'succeeded' | 'cancelled', count = 1) => Array.from({ length: count }, (_, i) => ({ id: `${end}-${i}`, ageMs: 8 * DAY + i, end }));

    it('succeededMaxAgeMs: a 10-day window keeps an 8-day-old succeeded job that the default 7-day window removes', async () => {
      const kept = await agentWithFinishedJobs(stores, jobs('succeeded'));
      const keptSweep = createShareRetentionSweep({ agent: kept.agent, settings: settingsFor('delete', { succeededMaxAgeMs: 10 * DAY }), log: vi.fn() })!;
      expect(await keptSweep.runBatch()).toMatchObject({ scanned: 0, deleted: 0 });
      expect(keptSweep.counters().deleted).toMatchObject({ succeeded: 0 });
      expect(await jobPresent(kept.raw, 'succeeded-0')).toBe(true);

      const control = await agentWithFinishedJobs(stores, jobs('succeeded'));
      const controlSweep = createShareRetentionSweep({ agent: control.agent, settings: settingsFor('delete'), log: vi.fn() })!;
      expect(await controlSweep.runBatch()).toMatchObject({ deleted: 1 });
      expect(await jobPresent(control.raw, 'succeeded-0')).toBe(false);
    });

    it.each([['null (keep the harmless failed classes)', null], ['10 days', 10 * DAY]])('benignFailedMaxAgeMs %s: an 8-day-old cancelled job survives, and the default window removes it', async (_name, window) => {
      const kept = await agentWithFinishedJobs(stores, jobs('cancelled'));
      const keptSweep = createShareRetentionSweep({ agent: kept.agent, settings: settingsFor('delete', { benignFailedMaxAgeMs: window }), log: vi.fn() })!;
      expect(await keptSweep.runBatch()).toMatchObject({ deleted: 0 });
      expect(keptSweep.counters().deleted).toMatchObject({ cancelled: 0 });
      expect(await jobPresent(kept.raw, 'cancelled-0')).toBe(true);

      const control = await agentWithFinishedJobs(stores, jobs('cancelled'));
      const controlSweep = createShareRetentionSweep({ agent: control.agent, settings: settingsFor('delete'), log: vi.fn() })!;
      expect(await controlSweep.runBatch()).toMatchObject({ deleted: 1 });
      expect(controlSweep.counters().deleted).toMatchObject({ cancelled: 1 });
      expect(await jobPresent(control.raw, 'cancelled-0')).toBe(false);
    });

    it('batchSize: 1 judges one of two old jobs per tick, the default judges both', async () => {
      const one = await agentWithFinishedJobs(stores, jobs('succeeded', 2));
      const oneSweep = createShareRetentionSweep({ agent: one.agent, settings: settingsFor('report', { batchSize: 1 }), log: vi.fn() })!;
      expect(await oneSweep.runBatch()).toMatchObject({ scanned: 1, wouldDelete: 1 });

      const both = await agentWithFinishedJobs(stores, jobs('succeeded', 2));
      const bothSweep = createShareRetentionSweep({ agent: both.agent, settings: settingsFor('report'), log: vi.fn() })!;
      expect(await bothSweep.runBatch()).toMatchObject({ scanned: 2, wouldDelete: 2 });
    });

    it('intervalMs is the core\'s clock-guard unit: a 10 s forward clock step skips the next tick at 1 s (tolerance 3 s) and not at the default 60 s (tolerance 3 min)', async () => {
      const outcomes: Array<string | undefined> = [];
      const tick = async (sweep: { runBatch(): Promise<unknown> }) => ((await sweep.runBatch()) as { skipped?: string }).skipped;   // the core's result carries `skipped`
      for (const intervalMs of [1_000, 60_000]) {
        const { agent } = await agentWithFinishedJobs(stores, jobs('succeeded'));
        const sweep = createShareRetentionSweep({ agent, settings: settingsFor('report', { intervalMs }), log: vi.fn() })!;
        vi.useFakeTimers({ toFake: ['Date'] });                                    // the wall clock only; the store and the monotonic clock stay real
        try {
          expect(await tick(sweep)).toBeUndefined();                // the baseline tick
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

  describe('counters and mode out of the core', () => {
    it.each(['report', 'delete'] as const)('sweep.mode is the mode the core runs in (%s), and the counters are the core\'s own, field by field', async (mode) => {
      const { raw, agent } = await agentWithFinishedJobs(stores, [
        { id: 'old-succeeded', ageMs: 8 * DAY, end: 'succeeded' }, { id: 'old-cancelled', ageMs: 8 * DAY + 1, end: 'cancelled' },
      ]);
      const sweep = createShareRetentionSweep({ agent, settings: settingsFor(mode), log: vi.fn() })!;
      expect(sweep.mode).toBe(mode);
      expect(sweep.counters().lastCompletePass).toBeNull();                         // nothing has run yet
      await sweep.runBatch();
      const counters = sweep.counters();
      const reportMode = mode === 'report';
      expect(counters.deleted).toEqual({ succeeded: reportMode ? 0 : 1, cancelled: reportMode ? 0 : 1, retired_no_effect: 0 });
      expect(counters.lastCompletePass).toMatchObject({
        scanned: 2,
        wouldDelete: { succeeded: reportMode ? 1 : 0, cancelled: reportMode ? 1 : 0, retired_no_effect: 0 },   // the gauge delete-gate item 1 reads: report mode only
        deleted: { succeeded: reportMode ? 0 : 1, cancelled: reportMode ? 0 : 1, retired_no_effect: 0 },
      });
      expect(counters.errors).toEqual({ scan: 0, verify: 0, delete: 0 });
      expect(await jobPresent(raw, 'old-succeeded')).toBe(!(mode === 'delete'));
    });

    /** The production timer and the production line: one complete report pass, then a forward clock step makes the next tick skip (clock_jump) for good. */
    it('the usage view and line carry the pass gauge (would-delete by class), the mode and the skips the core reported', async () => {
      const { agent } = await agentWithFinishedJobs(stores, [{ id: 'old', ageMs: 8 * DAY, end: 'succeeded' }]);
      vi.useFakeTimers({ toFake: ['Date'] });                                       // only the wall clock is steered; timers and the store stay real
      const handle = startRetention({ runtime: 'daemon-admission', settings: settingsFor('report', { intervalMs: 1_000 }), agent, log: vi.fn() });
      const until = async (condition: () => boolean) => {
        for (let waited = 0; !condition(); waited += 25) {
          if (waited > 10_000) throw new Error('timed out waiting for a retention tick');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      };
      try {
        await until(() => handle.usage()[0]!.ticks >= 1);
        vi.setSystemTime(Date.now() + 3_600_000);                                   // a real forward step of an hour: 3 s is the tolerance at this interval
        await until(() => handle.usage()[0]!.ticks >= 2);
        const view = handle.usage()[0]!;
        expect(view.mode).toBe('report');
        expect(view.lastCompletePass).toMatchObject({ scanned: 1, wouldDelete: { succeeded: 1, cancelled: 0, retired_no_effect: 0 }, deleted: { succeeded: 0 } });
        expect(view.skipped.clock_jump).toBeGreaterThanOrEqual(1);
        const line = formatAsyncAdmissionUsageLine({
          intervalSeconds: 300, store: [], usage: emptyUsage(), depth: { share: null, lift: null, liftJournal: null }, depthErrors: 0, shareWorker: null, retention: handle.usage(),
        });
        expect(line).toContain(' share_retention=report ');
        expect(line).toContain(' share_retention_pass_scanned=1 ');
        expect(line).toContain(' share_retention_pass_would_delete=cancelled:0,retired_no_effect:0,succeeded:1 ');
        expect(line).toMatch(/ share_retention_pass_deleted=cancelled:0,retired_no_effect:0,succeeded:0$/);
        expect(line).toMatch(/ share_retention_skipped=clock_jump:[1-9]\d* /);
      } finally {
        await handle.stop();
      }
    });
  });
});

function emptyUsage(): AsyncAdmissionUsageSample['usage'] {
  const empty = { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  return {
    http: [], httpLatency: { share_async: empty, publish_async: empty }, shareReclaimed: 0, shareAbandoned: 0, shareHeartbeat: { ...empty, pending: 0, oldestPendingMs: 0 },
    shareClaim: empty, liftReclaimed: 0, liftStaleClaims: 0, liftFinalized: 0, liftFailed: 0, liftWallets: 0, liftPickup: empty, liftPickupWorkerFree: empty,
    liftPickupUnclassified: 0, liftClaimToFinish: empty,
  };
}
