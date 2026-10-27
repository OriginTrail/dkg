/**
 * OT-RFC-73 P10b: the share sweep through the production wiring (plan section 5.3, AC7): the sweep is created AFTER the queue and over the queue's OWN store object
 * (`agent.store`, the object `dkg-agent.ts` hands to `TripleStoreAsyncPromoteQueue`), reached through `agent.promoteQueue`, so an admission still pending through
 * the queue (a lost-ack enqueue) protects its job from the sweep. When the wiring is broken the daemon says so and keeps running without retention.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { OxigraphStore, StoreSchedulerBusyError, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue, type AsyncPromoteQueueConfig } from '@origintrail-official/dkg-publisher';
import { resolveRetentionConfig } from '../src/retention-config.js';
import { startRetention } from '../src/daemon/retention-sweeps.js';
import { createShareRetentionSweep, shareRetentionSweepFactory } from '../src/daemon/retention-share-sweep.js';
import { formatAsyncAdmissionUsageLine, type AsyncAdmissionUsageSample } from '../src/daemon/async-admission-usage-log.js';
import type { RetentionAgent } from '../src/daemon/retention-timer.js';

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

function emptyUsage(): AsyncAdmissionUsageSample['usage'] {
  const empty = { n: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  return {
    http: [], httpLatency: { share_async: empty, publish_async: empty }, shareReclaimed: 0, shareAbandoned: 0, shareHeartbeat: { ...empty, pending: 0, oldestPendingMs: 0 },
    shareClaim: empty, liftReclaimed: 0, liftStaleClaims: 0, liftFinalized: 0, liftFailed: 0, liftWallets: 0, liftPickup: empty, liftPickupWorkerFree: empty,
    liftPickupUnclassified: 0, liftClaimToFinish: empty,
  };
}
