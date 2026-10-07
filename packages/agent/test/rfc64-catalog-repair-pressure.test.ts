import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext, type ContextGraphIdV1, type EvmAddressV1 } from '@origintrail-official/dkg-core';
import { StorePriorityScheduler, type StoreWorkPriority } from '@origintrail-official/dkg-storage';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';

const CG = 'pressure-fixture' as ContextGraphIdV1;
const AUTHOR = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];
const releases: Array<() => void> = [];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

interface Sample {
  source: string;
  submittedAt: number;
  startedAt?: number;
  settledAt?: number;
  outcome?: 'completed' | 'rejected';
}

function fixture(reconcile: (signal: AbortSignal) => Promise<void>, queueLimit = 64) {
  const scheduler = new StorePriorityScheduler({
    maxConcurrent: 4, ackReservedSlots: 1, healthReservedSlots: 1,
    normalReservedSlots: 1, backgroundReservedSlots: 1,
    queueLimits: queueLimit, queueWaitTimeoutMs: 100, now: Date.now,
  });
  const samples: Sample[] = [];
  function run(priority: StoreWorkPriority | undefined, source: string, work: () => Promise<void>, signal?: AbortSignal) {
    const sample: Sample = { source, submittedAt: Date.now() };
    samples.push(sample);
    return scheduler.run(priority, source, async () => {
      sample.startedAt = Date.now();
      await work();
    }, signal).then(() => {
      sample.outcome = 'completed';
      sample.settledAt = Date.now();
    }, (error: unknown) => {
      sample.outcome = 'rejected';
      sample.settledAt = Date.now();
      throw error;
    });
  }
  // Extra revision dependency is ignored by the pre-fix owner. Keep the fixture
  // compatible with both sides of the regression without fabricating repair policy.
  const dependencies = {
    resolvePartition: () => undefined,
    listLocalAuthorAddresses: () => [AUTHOR],
    acceptsPublicRootLane: () => true,
    acceptsFinalizedPrivateLane: () => true,
    listFinalizedPrivateRepairs: () => [],
    repairFinalizedPrivatePlacement: async () => {},
    readRepairRevision: () => ({ scopeIdentity: 'scope-1', headRevision: 'revision-1' }),
    reconcile: async ({ signal }: { signal: AbortSignal }) => { await reconcile(signal); return null; },
    warn: () => {},
  };
  const owner = new Rfc64SwmCatalogProjectionOwnerV1(dependencies);
  owners.push(owner);
  const request = () => owner.request({ contextGraphId: CG, authorAddress: AUTHOR, ctx: createOperationContext('system') });
  return { scheduler, samples, run, owner, request };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T00:00:00Z'));
});

afterEach(async () => {
  // Release physical work even when a baseline assertion fails, then drain owners.
  for (const release of releases.splice(0)) release();
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.useRealTimers();
});

describe('GH#2893 catalog repair admission at the incident store capacity', () => {
  it('keeps publisher/promotion work within its deadline while nested catalog reads are held', async () => {
    const held = [gate(), gate()];
    const h = fixture(async (signal) => {
      // Await boundaries and Promise fanout model nested resolver helpers whose
      // query options omit priority. Only the production owner assigns the lane.
      await Promise.resolve();
      await Promise.all(held.map(async (entry, index) => {
        await Promise.resolve();
        await h.run(undefined, index === 0
          ? 'agent.rfc64.swmInventory.catalogReconcile.seal'
          : 'agent.rfc64.swmInventory.catalogReconcile.vmProjection', () => entry.promise, signal);
      }));
    });
    h.request();
    await vi.advanceTimersByTimeAsync(0);
    const foreground = Promise.allSettled([
      h.run('normal', 'publisher.asyncLift.list', async () => {}),
      h.run('normal', 'publisher.asyncPromote.claimNext.candidates', async () => {}),
    ]).then((results) => {
      // A baseline timeout also releases the fixture, avoiding stuck test work.
      for (const entry of held) entry.release();
      return results;
    });
    await vi.advanceTimersByTimeAsync(101);
    const outcomes = await foreground;
    await h.owner.whenIdle();
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(h.samples).toHaveLength(4);
    expect(h.samples.every((sample) => sample.outcome === 'completed')).toBe(true);
    for (const sample of h.samples.filter((entry) => entry.source.startsWith('publisher.'))) {
      expect(sample.startedAt! - sample.submittedAt).toBeLessThan(100);
    }
    expect(h.scheduler.snapshot).toMatchObject({ maxConcurrent: 4, ackReservedSlots: 1, healthReservedSlots: 1 });
  });

  it('makes catalog and foreground progress with both queues continuously populated', async () => {
    const normal = Array.from({ length: 8 }, () => gate());
    const background = Array.from({ length: 4 }, () => gate());
    const h = fixture(async (signal) => {
      await Promise.all(background.map((entry, index) =>
        h.run(undefined, `catalog.repair.${index}`, () => entry.promise, signal)));
    });
    const normalCompletion = Promise.allSettled(normal.map((entry, index) =>
      h.run('normal', `foreground.${index}`, () => entry.promise)));
    h.request();
    await vi.advanceTimersByTimeAsync(0);
    normal[0]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.snapshot).toMatchObject({ backgroundInflight: 1, normalInflight: 1, backgroundQueued: 3 });
    normal[1]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.samples.find((sample) => sample.source === 'foreground.2')?.startedAt).toBeDefined();

    // One held slot per ordinary lane, with both queues still populated.
    for (let index = 0; index < background.length; index += 1) {
      background[index]!.release();
      normal[index + 2]!.release();
      await vi.advanceTimersByTimeAsync(0);
    }
    for (const entry of normal) entry.release();
    await normalCompletion;
    await h.owner.whenIdle();
    expect(h.samples.filter((sample) => sample.source.startsWith('catalog.'))).toHaveLength(4);
    expect(h.samples.every((sample) => sample.outcome === 'completed')).toBe(true);
  });

  it('retains explicit ACK/health overrides, bounded background admission and queued cancellation', async () => {
    const held = [gate(), gate(), gate()];
    let queuedResults: PromiseSettledResult<void>[] = [];
    const h = fixture(async (signal) => {
      const pending = held.map((entry, index) => h.run(undefined, `catalog.cancel.${index}`, () => entry.promise, signal));
      const overrides = [
        h.run('ack', 'catalog.explicit-ack', async () => {}),
        h.run('health', 'catalog.explicit-health', async () => {}),
      ];
      queuedResults = await Promise.allSettled([...pending, ...overrides]);
    }, 2);
    h.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.snapshot).toMatchObject({ backgroundInflight: 1, backgroundQueued: 2, normalInflight: 0 });
    expect(h.samples.filter((sample) => sample.source.startsWith('catalog.explicit')).every((sample) => sample.outcome === 'completed')).toBe(true);
    await expect(h.run('background', 'catalog.overflow', async () => {})).rejects.toMatchObject({ code: 'STORE_SCHEDULER_BUSY', reason: 'queue_full' });
    const closing = h.owner.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.snapshot.backgroundQueued).toBe(0);
    expect(h.samples.filter((sample) => sample.source === 'catalog.cancel.1' || sample.source === 'catalog.cancel.2')
      .every((sample) => sample.startedAt === undefined && sample.outcome === 'rejected')).toBe(true);
    held[0]!.release();
    await closing;
    expect(queuedResults.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'rejected', 'fulfilled', 'fulfilled']);
  });

  it('distinguishes active read time from queue wait and does not preempt an admitted read', async () => {
    const held = gate();
    const h = fixture(async (signal) => h.run(undefined, 'catalog.slow-active', () => held.promise, signal));
    h.request();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(150);
    const active = h.samples[0]!;
    expect(active.startedAt! - active.submittedAt).toBe(0);
    expect(active.outcome).toBeUndefined();
    // Queue deadlines apply before start, not to a noncooperative active closure.
    await h.run('normal', 'foreground.during-slow-read', async () => {});
    const closing = h.owner.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(active.outcome).toBeUndefined();
    held.release();
    await closing;
    expect(active).toMatchObject({ outcome: 'completed' });
    expect(active.settledAt! - active.startedAt!).toBe(150);
  });
});
