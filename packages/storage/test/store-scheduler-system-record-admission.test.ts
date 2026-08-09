import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  STORE_ADMISSION_DEFAULT_DOMAIN,
  STORE_ADMISSION_EXCLUSIVE_WAIT_BOUND_MS,
  STORE_ADMISSION_SHARED_BYPASS_LIMIT,
  StoreControlBarrierTimeoutError,
  StorePriorityScheduler,
  getExternalStorePrioritySchedulerSnapshot,
  type StoreAdmissionV1,
  type StoreQueuedAdmissionV1,
} from '../src/store-priority-scheduler.js';

interface AuditedAdmissionFixture extends StoreAdmissionV1 {
  readonly auditId: string;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A scheduler wide enough that lane policy never explains a blocked entry. */
function openScheduler(now?: () => number): StorePriorityScheduler {
  return new StorePriorityScheduler({
    maxConcurrent: 16,
    ackReservedSlots: 0,
    healthReservedSlots: 0,
    normalReservedSlots: 0,
    backgroundReservedSlots: 0,
    queueLimits: 64,
    queueWaitTimeoutMs: 60_000,
    ...(now ? { now } : {}),
  });
}

function admission(
  storeId: object,
  mode: StoreQueuedAdmissionV1['mode'],
  domain?: string,
  generation = 'gen-1',
): StoreQueuedAdmissionV1 {
  return domain === undefined
    ? { storeId, generation, mode }
    : { storeId, generation, domain, mode };
}

/** Resolves once `predicate` holds, without depending on a fixed tick count. */
async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`condition never held: ${label}`);
}

describe('StorePriorityScheduler admission V1 — default-path invariance', () => {
  it('preserves the public admission interface extension contract', () => {
    const admission: AuditedAdmissionFixture = {
      storeId: {},
      generation: 'gen-1',
      mode: 'shared',
      auditId: 'audit-1',
    };

    expect(admission.auditId).toBe('audit-1');
  });

  it('retains the deprecated occupied-slot metric on the public snapshot', () => {
    expect(getExternalStorePrioritySchedulerSnapshot().barrierWaitOccupiedSlotMs).toBe(0);
  });

  it('does no admission work at all when nothing carries admission metadata', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueLimits: 1,
      queueWaitTimeoutMs: 30,
    });
    const settled: Array<Promise<unknown>> = [];
    let release!: () => void;

    // Exercise every default-path shape: inflight, queued, queue_full,
    // queue_wait_timeout and caller abort, across all four lanes.
    const blocker = scheduler.run('normal', 'default.blocker', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await tick();
    const timedOut = scheduler.run('normal', 'default.timeout', async () => 'never');
    settled.push(blocker, timedOut);

    await expect(
      scheduler.run('normal', 'default.queue-full', async () => 'never'),
    ).rejects.toMatchObject({ reason: 'queue_full' });

    const controller = new AbortController();
    const aborted = scheduler.run('background', 'default.aborted', async () => 'never', controller.signal);
    settled.push(aborted);
    controller.abort(new Error('caller cancelled'));
    await expect(aborted).rejects.toThrow('caller cancelled');
    await expect(timedOut).rejects.toMatchObject({
      code: 'STORE_SCHEDULER_BUSY',
      reason: 'queue_wait_timeout',
    });

    release();
    await blocker;
    await expect(scheduler.run('ack', 'default.ack', async () => 'ack')).resolves.toBe('ack');
    await expect(scheduler.run('health', 'default.health', async () => 'health')).resolves.toBe('health');

    // The whole point: not one per-entry rule evaluated, not one byte of
    // per-store state allocated, nothing pending on the control path.
    expect(scheduler.snapshot).toMatchObject({
      admissionEvaluations: 0,
      admissionTrackedStores: 0,
      admissionTaggedQueued: 0,
      admissionTaggedInflight: 0,
      admissionHeldRuns: 0,
      admissionSealedStores: 0,
      admissionBypassesGranted: 0,
      admissionBoundHolds: 0,
      barrierPending: 0,
      barrierInflight: 0,
      barrierWaitOccupiedSlotMs: 0,
    });

    await Promise.allSettled(settled);

    // Positive control: the counter is genuinely wired, so the zero above is a
    // measurement of the fast path and not of a dead counter.
    const storeId = {};
    let releaseTagged!: () => void;
    const taggedBlocker = scheduler.run('normal', 'tagged.blocker', async () => {
      await new Promise<void>((resolve) => {
        releaseTagged = resolve;
      });
    }, undefined, admission(storeId, 'shared'));
    await tick();
    const taggedQueued = scheduler.run('normal', 'tagged.queued', async () => 'ok',
      undefined, admission(storeId, 'shared'));
    await tick();

    expect(scheduler.snapshot.admissionEvaluations).toBeGreaterThan(0);
    expect(scheduler.snapshot.admissionTrackedStores).toBe(1);

    releaseTagged();
    await Promise.all([taggedBlocker, taggedQueued]);
    // State is released the moment the store stops carrying an obligation.
    expect(scheduler.snapshot.admissionTrackedStores).toBe(0);
  });

  it('keeps the existing run() signature working unchanged', async () => {
    const scheduler = openScheduler();
    await expect(scheduler.run('normal', 'legacy.three-arg', async () => 'ok')).resolves.toBe('ok');
    const controller = new AbortController();
    await expect(
      scheduler.run('ack', 'legacy.four-arg', async () => 'ok', controller.signal),
    ).resolves.toBe('ok');
    await expect(scheduler.run(undefined, 'legacy.no-priority', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('StorePriorityScheduler admission V1 — ordering domains', () => {
  it('exports the bounded-bypass constants', () => {
    expect(STORE_ADMISSION_SHARED_BYPASS_LIMIT).toBe(8);
    expect(STORE_ADMISSION_EXCLUSIVE_WAIT_BOUND_MS).toBe(250);
    expect(STORE_ADMISSION_DEFAULT_DOMAIN).toBe('agents');
  });

  it('pauses later same-domain shared work after the bypass count is spent', async () => {
    let clock = 0;
    const scheduler = openScheduler(() => clock);
    const storeId = {};
    const events: string[] = [];
    let releaseBlocker!: () => void;

    // Holds the domain so the exclusive cannot start and the bound can be
    // observed rather than raced past.
    const blocker = scheduler.run('normal', 'agents.blocker', async () => {
      events.push('blocker:start');
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
      events.push('blocker:end');
    }, undefined, admission(storeId, 'shared'));
    await tick();

    const exclusive = scheduler.run('normal', 'agents.apply', async () => {
      events.push('exclusive:start');
    }, undefined, admission(storeId, 'exclusive'));
    await tick();
    expect(events).not.toContain('exclusive:start');

    const bypassers: Array<Promise<unknown>> = [];
    for (let index = 0; index < STORE_ADMISSION_SHARED_BYPASS_LIMIT; index += 1) {
      bypassers.push(scheduler.run('normal', `agents.bypass.${index}`, async () => {
        events.push(`bypass-${index}:start`);
      }, undefined, admission(storeId, 'shared')));
    }
    await settle(() => events.filter((e) => e.startsWith('bypass-')).length
      === STORE_ADMISSION_SHARED_BYPASS_LIMIT, 'all bypasses ran');
    expect(scheduler.snapshot.admissionBypassesGranted).toBe(STORE_ADMISSION_SHARED_BYPASS_LIMIT);

    // Ninth same-domain shared entry: the bound is spent, so it waits.
    const held = scheduler.run('normal', 'agents.held', async () => {
      events.push('held:start');
    }, undefined, admission(storeId, 'shared'));
    await tick();
    expect(events).not.toContain('held:start');
    expect(scheduler.snapshot.admissionBoundHolds).toBeGreaterThan(0);

    // Unrelated domain, unrelated store and untagged legacy work all run right
    // through the pause — that is the whole reason the bound is domain-scoped.
    await expect(scheduler.run('normal', 'trusted.write', async () => {
      events.push('other-domain:start');
      return 'other-domain';
    }, undefined, admission(storeId, 'shared', 'trusted-cg'))).resolves.toBe('other-domain');
    await expect(scheduler.run('normal', 'other-store.write', async () => {
      events.push('other-store:start');
      return 'other-store';
    }, undefined, admission({}, 'shared'))).resolves.toBe('other-store');
    await expect(scheduler.run('normal', 'legacy.write', async () => {
      events.push('untagged:start');
      return 'untagged';
    })).resolves.toBe('untagged');

    // ACK in the SAME domain honours the bound; ACK elsewhere bypasses freely.
    const ackSameDomain = scheduler.run('ack', 'agents.ack', async () => {
      events.push('ack-same-domain:start');
    }, undefined, admission(storeId, 'shared'));
    await tick();
    expect(events).not.toContain('ack-same-domain:start');
    await expect(scheduler.run('ack', 'trusted.ack', async () => {
      events.push('ack-other-domain:start');
      return 'ack-other-domain';
    }, undefined, admission(storeId, 'shared', 'trusted-cg'))).resolves.toBe('ack-other-domain');

    clock += 1;
    releaseBlocker();
    await Promise.all([blocker, exclusive, held, ackSameDomain, ...bypassers]);

    // The exclusive ran before the work the bound held back, and the paused
    // entries kept their enqueue order.
    expect(events.indexOf('exclusive:start')).toBeLessThan(events.indexOf('ack-same-domain:start'));
    expect(events.indexOf('exclusive:start')).toBeLessThan(events.indexOf('held:start'));
    expect(events).toContain('other-domain:start');
    expect(events).toContain('untagged:start');
  });

  it('pauses same-domain shared work once the exclusive has waited the time bound', async () => {
    let clock = 1_000;
    const scheduler = openScheduler(() => clock);
    const storeId = {};
    const events: string[] = [];
    let releaseBlocker!: () => void;

    const blocker = scheduler.run('normal', 'agents.blocker', async () => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    }, undefined, admission(storeId, 'shared'));
    await tick();

    const exclusive = scheduler.run('normal', 'agents.apply', async () => {
      events.push('exclusive:start');
    }, undefined, admission(storeId, 'exclusive'));
    await tick();

    // One bypass — far below the count arm, so only the time arm can trip.
    await expect(scheduler.run('normal', 'agents.early', async () => {
      events.push('early:start');
      return 'early';
    }, undefined, admission(storeId, 'shared'))).resolves.toBe('early');
    expect(scheduler.snapshot.admissionBypassesGranted).toBe(1);

    clock += STORE_ADMISSION_EXCLUSIVE_WAIT_BOUND_MS;
    const late = scheduler.run('normal', 'agents.late', async () => {
      events.push('late:start');
    }, undefined, admission(storeId, 'shared'));
    await tick();
    expect(events).not.toContain('late:start');
    expect(scheduler.snapshot.admissionBoundHolds).toBeGreaterThan(0);

    releaseBlocker();
    await Promise.all([blocker, exclusive, late]);
    expect(events).toEqual(['early:start', 'exclusive:start', 'late:start']);
  });

  it('never asks shared work queued AHEAD of an exclusive to wait for it', async () => {
    let clock = 0;
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueLimits: 8,
      queueWaitTimeoutMs: 60_000,
      now: () => clock,
    });
    const storeId = {};
    const events: string[] = [];
    let releaseBlocker!: () => void;

    // Untagged work holds the only slot, so both tagged entries queue up.
    const blocker = scheduler.run('normal', 'legacy.blocker', async () => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    });
    await tick();
    const early = scheduler.run('normal', 'agents.early', async () => {
      events.push('early:start');
    }, undefined, admission(storeId, 'shared'));
    const exclusive = scheduler.run('normal', 'agents.apply', async () => {
      events.push('exclusive:start');
    }, undefined, admission(storeId, 'exclusive'));
    await tick();

    // Bound fully exhausted by time — it still must not touch `early`, which
    // was already in line when the exclusive arrived.
    clock += STORE_ADMISSION_EXCLUSIVE_WAIT_BOUND_MS * 4;
    releaseBlocker();
    await Promise.all([blocker, early, exclusive]);
    expect(events).toEqual(['early:start', 'exclusive:start']);
  });

  it('skips blocked entries without dequeuing them, preserving FIFO per (priority, domain)', async () => {
    let clock = 0;
    const scheduler = openScheduler(() => clock);
    const storeId = {};
    const events: string[] = [];
    let releaseBlocker!: () => void;

    const blocker = scheduler.run('normal', 'agents.blocker', async () => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    }, undefined, admission(storeId, 'shared'));
    await tick();
    const exclusive = scheduler.run('normal', 'agents.apply', async () => {
      events.push('exclusive:start');
    }, undefined, admission(storeId, 'exclusive'));
    await tick();
    clock += STORE_ADMISSION_EXCLUSIVE_WAIT_BOUND_MS;

    const blockedFirst = scheduler.run('normal', 'agents.blocked.1', async () => {
      events.push('blocked-1:start');
    }, undefined, admission(storeId, 'shared'));
    const blockedSecond = scheduler.run('normal', 'agents.blocked.2', async () => {
      events.push('blocked-2:start');
    }, undefined, admission(storeId, 'shared'));
    // Enqueued LAST but in another domain — it must overtake without disturbing
    // the order of the two entries it stepped over.
    const overtaker = scheduler.run('normal', 'trusted.write', async () => {
      events.push('overtaker:start');
    }, undefined, admission(storeId, 'shared', 'trusted-cg'));
    await settle(() => events.includes('overtaker:start'), 'other-domain entry overtook');

    expect(events).toEqual(['overtaker:start']);
    // The two blocked shared entries plus the exclusive they are waiting on are
    // all still QUEUED — skipping never dequeues.
    expect(scheduler.snapshot.admissionTaggedQueued).toBe(3);

    releaseBlocker();
    await Promise.all([blocker, exclusive, blockedFirst, blockedSecond, overtaker]);
    expect(events).toEqual([
      'overtaker:start',
      'exclusive:start',
      'blocked-1:start',
      'blocked-2:start',
    ]);
  });

  it('serializes exclusives against every peer in their own domain only', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];

    const exclusives = [0, 1, 2].map((index) => scheduler.run('normal', `agents.apply.${index}`, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      active -= 1;
    }, undefined, admission(storeId, 'exclusive')));
    await settle(() => releases.length === 1, 'first exclusive started');

    expect(maxActive).toBe(1);
    // Another domain keeps full concurrency while the exclusives serialize.
    await expect(scheduler.run('normal', 'trusted.write', async () => 'trusted',
      undefined, admission(storeId, 'shared', 'trusted-cg'))).resolves.toBe('trusted');

    for (let index = 0; index < 3; index += 1) {
      await settle(() => releases.length > index, `exclusive ${index} started`);
      releases[index]!();
      await tick();
    }
    await Promise.all(exclusives);
    expect(maxActive).toBe(1);
  });

  it('blocks every domain of a store behind store-wide-exclusive work', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    const otherStoreId = {};
    const events: string[] = [];
    let releaseReset!: () => void;

    const reset = scheduler.run('normal', 'store.reset', async () => {
      events.push('reset:start');
      await new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      events.push('reset:end');
    }, undefined, admission(storeId, 'store-wide-exclusive'));
    await settle(() => events.includes('reset:start'), 'reset started');

    const agentsWrite = scheduler.run('normal', 'agents.write', async () => {
      events.push('agents:start');
    }, undefined, admission(storeId, 'shared'));
    const trustedWrite = scheduler.run('ack', 'trusted.write', async () => {
      events.push('trusted:start');
    }, undefined, admission(storeId, 'shared', 'trusted-cg'));
    await tick();
    expect(events).toEqual(['reset:start']);

    // A different store and untagged legacy work are untouched.
    await expect(scheduler.run('normal', 'other-store.write', async () => 'other',
      undefined, admission(otherStoreId, 'shared'))).resolves.toBe('other');
    await expect(scheduler.run('normal', 'legacy.write', async () => 'legacy')).resolves.toBe('legacy');

    releaseReset();
    await Promise.all([reset, agentsWrite, trustedWrite]);
    expect(events.indexOf('reset:end')).toBeLessThan(events.indexOf('agents:start'));
    expect(events.indexOf('reset:end')).toBeLessThan(events.indexOf('trusted:start'));
  });

  it('waits for in-flight tagged work of every domain before a store-wide transition starts', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    const events: string[] = [];
    let releaseTrusted!: () => void;

    const trusted = scheduler.run('normal', 'trusted.write', async () => {
      events.push('trusted:start');
      await new Promise<void>((resolve) => {
        releaseTrusted = resolve;
      });
      events.push('trusted:end');
    }, undefined, admission(storeId, 'shared', 'trusted-cg'));
    await settle(() => events.includes('trusted:start'), 'trusted write started');

    const reset = scheduler.run('normal', 'store.reset', async () => {
      events.push('reset:start');
    }, undefined, admission(storeId, 'store-wide-exclusive'));
    await tick();
    expect(events).toEqual(['trusted:start']);

    // Arrives while the reset is only QUEUED. Letting it past here is exactly
    // how a store-wide transition gets starved under sustained load.
    const latecomer = scheduler.run('normal', 'agents.latecomer', async () => {
      events.push('latecomer:start');
    }, undefined, admission(storeId, 'shared'));
    await tick();
    expect(events).toEqual(['trusted:start']);

    releaseTrusted();
    await Promise.all([trusted, reset, latecomer]);
    expect(events).toEqual([
      'trusted:start',
      'trusted:end',
      'reset:start',
      'latecomer:start',
    ]);
  });
});

describe('StorePriorityScheduler admission V1 — generation seals', () => {
  it('holds tagged run() calls while sealed instead of rejecting them', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 1,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        backgroundReservedSlots: 0,
        // Headroom on purpose. A held call now counts against its lane's queue
        // limit, so a limit of 1 would be the degenerate arity where one held
        // call alone saturates the lane and nothing else can be observed.
        queueLimits: 4,
        queueWaitTimeoutMs: 50,
      });
      const storeId = {};
      const seal = scheduler.sealStoreGeneration(storeId, 'gen-1');
      expect(scheduler.snapshot.admissionSealedStores).toBe(1);

      let started = false;
      const held = scheduler.run('normal', 'agents.write', async () => {
        started = true;
        return 'written';
      }, undefined, admission(storeId, 'shared'));

      // Parked off-queue and carrying no wait timer, so the queue-wait timeout
      // cannot reach it. It does hold a reservation against the lane's limit —
      // that is what makes the release below total.
      expect(scheduler.snapshot).toMatchObject({
        admissionHeldRuns: 1,
        normalQueued: 0,
        admissionTaggedQueued: 0,
      });

      let untaggedSettled = false;
      const untagged = scheduler.run('normal', 'legacy.blocker', async () => 'legacy');
      void untagged.finally(() => {
        untaggedSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(untaggedSettled).toBe(true);
      await expect(untagged).resolves.toBe('legacy');

      // Well past the queue-wait timeout: still held, still not started.
      await vi.advanceTimersByTimeAsync(500);
      expect(started).toBe(false);
      expect(scheduler.snapshot.admissionHeldRuns).toBe(1);

      seal.commit();
      await vi.advanceTimersByTimeAsync(0);
      await expect(held).resolves.toBe('written');
      expect(scheduler.snapshot).toMatchObject({
        admissionHeldRuns: 0,
        admissionSealedStores: 0,
        admissionTrackedStores: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops an already-queued tagged entry from starting once the seal lands', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueLimits: 8,
      queueWaitTimeoutMs: 60_000,
    });
    const storeId = {};
    let started = false;
    let releaseBlocker!: () => void;

    const blocker = scheduler.run('normal', 'legacy.blocker', async () => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    });
    await tick();
    // Queued BEFORE the seal exists, so it is gated at SELECTION rather than at
    // `run()` — the other half of the seal, and the one a hold cannot cover.
    const queued = scheduler.run('normal', 'agents.write', async () => {
      started = true;
      return 'written';
    }, undefined, admission(storeId, 'shared'));
    await tick();
    expect(scheduler.snapshot.admissionTaggedQueued).toBe(1);

    const seal = scheduler.sealStoreGeneration(storeId, 'gen-1');
    releaseBlocker();
    await blocker;
    await tick();
    expect(started).toBe(false);
    expect(scheduler.snapshot).toMatchObject({
      admissionTaggedQueued: 1,
      admissionHeldRuns: 0,
      normalInflight: 0,
    });

    seal.commit();
    await expect(queued).resolves.toBe('written');
  });

  it('bounds the held population and never converts a release into a rejection burst', async () => {
    // Discriminating by construction: N is 25x the queue limit, so any policy
    // that parks first and bounds later shows up as a rejection burst AFTER the
    // wait. The earlier version of this test held exactly ONE call at a limit of
    // one — the single arity at which a release cannot overrun — so it could
    // only ever confirm what it already expected.
    const queueLimit = 8;
    const callCount = 200;
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      normalReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueLimits: queueLimit,
      queueWaitTimeoutMs: 600_000,
    });
    const storeId = {};
    const seal = scheduler.sealStoreGeneration(storeId, 'gen-1');

    let rejectedAtAdmission = 0;
    let rejectedAfterRelease = 0;
    let sealCommitted = false;
    const calls = Array.from({ length: callCount }, (_, index) =>
      scheduler.run('normal', `agents.write.${index}`, async () => 'ok',
        undefined, admission(storeId, 'shared'))
        .catch((error: { code?: string }) => {
          if (error?.code !== 'STORE_SCHEDULER_BUSY') throw error;
          if (sealCommitted) rejectedAfterRelease += 1;
          else rejectedAtAdmission += 1;
          return 'rejected';
        }));
    await tick();

    // Memory is bounded by the lane's limit, not by caller volume.
    expect(scheduler.snapshot.admissionHeldRuns).toBe(queueLimit);
    expect(rejectedAtAdmission).toBe(callCount - queueLimit);
    expect(rejectedAfterRelease).toBe(0);

    sealCommitted = true;
    seal.commit();
    const outcomes = await Promise.all(calls);

    // The load-bearing assertion: every call that was ever held still ran.
    // Nothing waited out the seal only to be rejected at the end of it.
    expect(rejectedAfterRelease).toBe(0);
    expect(outcomes.filter((outcome) => outcome === 'ok')).toHaveLength(queueLimit);
    expect(outcomes.filter((outcome) => outcome === 'rejected'))
      .toHaveLength(callCount - queueLimit);
    expect(scheduler.snapshot).toMatchObject({
      admissionHeldRuns: 0,
      admissionSealedStores: 0,
      admissionTrackedStores: 0,
      normalQueued: 0,
      normalInflight: 0,
    });
  });

  it('refcounts nested seals and commits idempotently', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    const outer = scheduler.sealStoreGeneration(storeId, 'gen-1');
    const inner = scheduler.sealStoreGeneration(storeId, 'gen-1');
    expect(scheduler.snapshot.admissionSealedStores).toBe(1);

    let started = false;
    const held = scheduler.run('normal', 'agents.write', async () => {
      started = true;
      return 'written';
    }, undefined, admission(storeId, 'shared'));
    await tick();

    inner.commit();
    inner.commit();
    await tick();
    expect(started).toBe(false);
    expect(scheduler.snapshot.admissionSealedStores).toBe(1);

    outer.commit();
    await expect(held).resolves.toBe('written');
    expect(scheduler.snapshot.admissionSealedStores).toBe(0);
  });

  it('honours caller abort while a run is held', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    const seal = scheduler.sealStoreGeneration(storeId, 'gen-1');
    const controller = new AbortController();
    let started = false;
    const held = scheduler.run('normal', 'agents.write', async () => {
      started = true;
    }, controller.signal, admission(storeId, 'shared'));
    expect(scheduler.snapshot.admissionHeldRuns).toBe(1);

    const reason = new Error('caller cancelled');
    controller.abort(reason);
    await expect(held).rejects.toBe(reason);
    expect(started).toBe(false);
    expect(scheduler.snapshot.admissionHeldRuns).toBe(0);

    seal.commit();
    expect(scheduler.snapshot.admissionTrackedStores).toBe(0);
  });
});

describe('StorePriorityScheduler admission V1 — control barrier', () => {
  it('waits at zero execution slots, coalesces by purpose, and cannot be rejected', async () => {
    let clock = 0;
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 1,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      backgroundReservedSlots: 0,
      // Deliberately tiny: the barrier must be immune to `queue_full`.
      queueLimits: 1,
      queueWaitTimeoutMs: 600_000,
      now: () => clock,
    });
    const storeId = {};
    const events: string[] = [];
    let releaseWriter!: () => void;

    const writer = scheduler.run('normal', 'agents.write', async () => {
      events.push('writer:start');
      await new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      events.push('writer:end');
    }, undefined, admission(storeId, 'shared'));
    await settle(() => events.includes('writer:start'), 'writer started');

    // Saturate the ordinary queue so `queue_full` is live for anything that
    // takes the ordinary path.
    const queueFiller = scheduler.run('normal', 'legacy.filler', async () => 'filler');
    await expect(scheduler.run('normal', 'legacy.rejected', async () => 'never'))
      .rejects.toMatchObject({ reason: 'queue_full' });

    clock += 40;
    const first = scheduler.runControlBarrier(storeId, 'profile.apply', async () => {
      events.push('barrier:start');
      return 'barrier-1';
    }, 'gen-1');

    // Waiting: no ordinary slot, no queue slot, no lane inflight of its own.
    expect(scheduler.snapshot).toMatchObject({
      barrierPending: 1,
      barrierInflight: 0,
      normalInflight: 1,
    });

    let secondTransitionRan = false;
    const second = scheduler.runControlBarrier(storeId, 'profile.apply', async () => {
      secondTransitionRan = true;
      return 'barrier-2';
    }, 'gen-1');
    expectTypeOf(first).toEqualTypeOf<Promise<string>>();
    expectTypeOf(second).toEqualTypeOf<Promise<string>>();
    expect(scheduler.snapshot).toMatchObject({ barrierPending: 1, barrierCoalesced: 1 });

    // An already-aborted caller signal cannot reject a control transition.
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const viaRun = scheduler.run('normal', 'profile.apply', async () => 'barrier-3', controller.signal, {
      storeId,
      generation: 'gen-1',
      mode: 'control-barrier',
    });
    expectTypeOf(viaRun).toEqualTypeOf<Promise<string>>();
    expect(scheduler.snapshot.barrierCoalesced).toBe(2);

    expect(events).not.toContain('barrier:start');

    clock += 60;
    releaseWriter();
    await settle(() => events.includes('barrier:start'), 'barrier ran after drain');

    expect(secondTransitionRan).toBe(false);
    await expect(first).resolves.toBe('barrier-1');
    await expect(second).resolves.toBe('barrier-1');
    await expect(viaRun).resolves.toBe('barrier-1');

    const snapshot = scheduler.snapshot;
    // The barrier genuinely waited, and it held no ordinary execution slot for
    // the duration — proven above by `barrier:start` being absent until the
    // writer released (749/753), not by a snapshot field. There was one such
    // field; it reported a hardcoded 0, so asserting it proved only that a
    // literal equals itself.
    expect(snapshot.barrierWaitMs).toBeGreaterThan(0);
    expect(snapshot.barrierWaitOccupiedSlotMs).toBe(0);
    expect(snapshot).toMatchObject({ barrierPending: 0, barrierInflight: 0 });

    await Promise.all([writer, queueFiller]);
    expect(scheduler.snapshot.admissionTrackedStores).toBe(0);
  });

  it('runs one transition at a time without head-of-line blocking the waits', async () => {
    const scheduler = openScheduler();
    const busyStoreId = {};
    const idleStoreId = {};
    const events: string[] = [];
    let releaseWriter!: () => void;

    const writer = scheduler.run('normal', 'agents.write', async () => {
      events.push('writer:start');
      await new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
    }, undefined, admission(busyStoreId, 'shared'));
    await settle(() => events.includes('writer:start'), 'writer started');

    let releaseIdleBarrier!: () => void;
    // Enqueued FIRST but blocked on a busy store; it must not stop the second.
    const blocked = scheduler.runControlBarrier(busyStoreId, 'profile.apply', async () => {
      events.push('blocked-barrier:start');
      return 'blocked';
    }, 'gen-1');
    const ready = scheduler.runControlBarrier(idleStoreId, 'profile.apply', async () => {
      events.push('ready-barrier:start');
      await new Promise<void>((resolve) => {
        releaseIdleBarrier = resolve;
      });
      return 'ready';
    }, 'gen-1');
    await settle(() => events.includes('ready-barrier:start'), 'quiesced barrier ran');

    expect(events).toEqual(['writer:start', 'ready-barrier:start']);
    expect(scheduler.snapshot).toMatchObject({ barrierPending: 2, barrierInflight: 1 });

    // The single controller slot is genuinely single: draining the busy store
    // does not let a second transition in while the first is still running.
    releaseWriter();
    await tick();
    expect(events).not.toContain('blocked-barrier:start');

    releaseIdleBarrier();
    await expect(ready).resolves.toBe('ready');
    await expect(blocked).resolves.toBe('blocked');
    await writer;
    expect(scheduler.snapshot).toMatchObject({
      barrierPending: 0,
      barrierInflight: 0,
      admissionTrackedStores: 0,
    });
  });

  it('stops UNTAGGED traffic for the whole transition and waits for it to drain', async () => {
    // The operational case this exists for: the transition IS the Oxigraph
    // stop-and-restart, and untagged legacy work is 100% of today's store
    // traffic. Dispatching it into a child being SIGTERM'd — or into no
    // listener at all — is a burst of connection errors across unrelated lanes
    // instead of backpressure.
    const scheduler = openScheduler();
    const storeId = {};
    let untaggedStartedDuringTransition = 0;
    let transitionActive = false;
    let releasePre!: () => void;
    let releaseTransition!: () => void;

    const pre = scheduler.run('normal', 'legacy.pre', async () => {
      await new Promise<void>((resolve) => {
        releasePre = resolve;
      });
    });
    await settle(() => scheduler.snapshot.normalInflight === 1, 'untagged work in flight');

    const barrier = scheduler.runControlBarrier(storeId, 'oxigraph.restart', async () => {
      transitionActive = true;
      await new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      transitionActive = false;
      return 'restarted';
    }, 'gen-1');

    // Untagged work already in flight when the barrier armed must be WAITED on:
    // the transition cannot claim the store while it is still being read.
    await tick();
    expect(scheduler.snapshot).toMatchObject({ barrierPending: 1, barrierInflight: 0 });
    expect(transitionActive).toBe(false);

    const during: Array<Promise<unknown>> = [];
    for (let index = 0; index < 20; index += 1) {
      during.push(scheduler.run('normal', `legacy.during.${index}`, async () => {
        if (transitionActive) untaggedStartedDuringTransition += 1;
        return 'during';
      }));
    }
    await tick();
    // Held in their queue rather than dispatched — still admitted, still owed a
    // result, simply not started.
    expect(scheduler.snapshot.normalQueued).toBe(20);

    releasePre();
    await settle(() => transitionActive, 'transition started after untagged drain');
    expect(scheduler.snapshot).toMatchObject({ barrierInflight: 1, normalInflight: 0 });

    await tick();
    releaseTransition();
    await expect(barrier).resolves.toBe('restarted');
    await Promise.all([pre, ...during]);

    // Not one ordinary store operation was dispatched into the restart window,
    // and every one of them still completed afterwards.
    expect(untaggedStartedDuringTransition).toBe(0);
    expect(scheduler.snapshot).toMatchObject({
      barrierPending: 0,
      barrierInflight: 0,
      normalQueued: 0,
      normalInflight: 0,
    });
  });

  it('waits for tagged work of EVERY generation on the store, not just the sealed one', async () => {
    // Supersedes an earlier assertion that a barrier ignored other generations.
    // That was wrong for the case the barrier exists to serve: the transition
    // restarts one child process, and that child serves every generation.
    const scheduler = openScheduler();
    const storeId = {};
    const events: string[] = [];
    let releaseNextGen!: () => void;

    const nextGenWrite = scheduler.run('normal', 'agents.write.next', async () => {
      events.push('next-gen:start');
      await new Promise<void>((resolve) => {
        releaseNextGen = resolve;
      });
      events.push('next-gen:end');
    }, undefined, admission(storeId, 'shared', undefined, 'gen-2'));
    await settle(() => events.includes('next-gen:start'), 'gen-2 write started');
    expect(scheduler.snapshot.admissionGenerationsInflight).toBe(1);

    const barrier = scheduler.runControlBarrier(storeId, 'retire.gen-1', async () => {
      events.push('barrier:start');
      return 'retired';
    }, 'gen-1');
    await tick();
    expect(events).toEqual(['next-gen:start']);

    releaseNextGen();
    await expect(barrier).resolves.toBe('retired');
    await nextGenWrite;
    expect(events).toEqual(['next-gen:start', 'next-gen:end', 'barrier:start']);
  });

  it('holds tagged work arriving mid-transition and releases it on commit', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    let heldStarted = false;
    let releaseTransition!: () => void;

    const barrier = scheduler.runControlBarrier(storeId, 'profile.apply', async () => {
      await new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      return 'applied';
    }, 'gen-1');
    await settle(() => scheduler.snapshot.barrierInflight === 1, 'transition running');

    const heldWrite = scheduler.run('normal', 'agents.write.during', async () => {
      heldStarted = true;
      return 'held';
    }, undefined, admission(storeId, 'shared'));
    await tick();
    expect(scheduler.snapshot.admissionHeldRuns).toBe(1);
    expect(heldStarted).toBe(false);

    releaseTransition();
    await expect(barrier).resolves.toBe('applied');
    await expect(heldWrite).resolves.toBe('held');
    expect(heldStarted).toBe(true);
    expect(scheduler.snapshot.admissionTrackedStores).toBe(0);
  });

  it('bounds a transition that deadlocks against its own quiescence gate', async () => {
    // The exact shape that hung: blocking untagged work is only released from
    // INSIDE the transition, and the transition cannot start until that work
    // drains. Circular wait — the contract working as documented, but silently.
    const scheduler = openScheduler();
    const storeId = {};
    let transitionRan = false;
    let releaseBlocker!: () => void;

    const blocker = scheduler.run('normal', 'legacy.blocker', async () => {
      await new Promise<void>((resolve) => {
        releaseBlocker = resolve;
      });
    });
    await settle(() => scheduler.snapshot.normalInflight === 1, 'blocking work in flight');

    const barrier = scheduler.runControlBarrier(storeId, 'oxigraph.restart', async () => {
      transitionRan = true;
      // Never reached: the barrier cannot start while the blocker is in flight.
      releaseBlocker();
      return 'restarted';
    }, 'gen-1', 25);

    const error = await barrier.then(
      () => { throw new Error('barrier resolved instead of timing out'); },
      (err: unknown) => err as StoreControlBarrierTimeoutError,
    );

    expect(error).toBeInstanceOf(StoreControlBarrierTimeoutError);
    expect(error).toMatchObject({
      code: 'STORE_CONTROL_BARRIER_TIMEOUT',
      phase: 'wait',
      purpose: 'oxigraph.restart',
    });
    // Diagnostics name the cause instead of leaving an operator to guess.
    expect(error.blockedBy.untaggedInflight).toBe(1);
    expect(error.message).toContain('issues store work through the scheduler');
    expect(transitionRan).toBe(false);
    expect(scheduler.snapshot.barrierTimeouts).toBe(1);

    // A wait-phase timeout is fully recoverable: nothing was disrupted, so the
    // barrier withdraws and the store resumes rather than staying frozen.
    expect(scheduler.snapshot).toMatchObject({
      barrierPending: 0,
      barrierInflight: 0,
      admissionSealedStores: 0,
      admissionHeldRuns: 0,
    });
    await expect(scheduler.run('normal', 'legacy.after', async () => 'ok')).resolves.toBe('ok');

    releaseBlocker();
    await blocker;
  });

  it('bounds a transition that re-enters the scheduler for its own store', async () => {
    // The other half: the transition DID start, then issued scheduled work for
    // the store it owns. Its own seal holds that call until it returns, and it
    // cannot return until the call completes.
    const scheduler = openScheduler();
    const storeId = {};
    let reentrantStarted = false;

    const barrier = scheduler.runControlBarrier(storeId, 'profile.apply', async () => {
      await scheduler.run('normal', 'agents.write.reentrant', async () => {
        reentrantStarted = true;
        return 'written';
      }, undefined, admission(storeId, 'shared'));
      return 'applied';
    }, 'gen-1', 25);

    const error = await barrier.then(
      () => { throw new Error('barrier resolved instead of timing out'); },
      (err: unknown) => err as StoreControlBarrierTimeoutError,
    );

    expect(error).toMatchObject({
      code: 'STORE_CONTROL_BARRIER_TIMEOUT',
      phase: 'transition',
      purpose: 'profile.apply',
    });
    expect(error.blockedBy.heldRuns).toBe(1);
    expect(reentrantStarted).toBe(false);
    expect(scheduler.snapshot.barrierTimeouts).toBe(1);

    // Reported, deliberately not force-recovered: the transition may be part-way
    // through stopping a child, so the seal outlives the rejection.
    expect(scheduler.snapshot).toMatchObject({
      barrierInflight: 1,
      admissionSealedStores: 1,
      admissionHeldRuns: 1,
    });
  });

  it('does not arm the bound against an ordinary slow transition', async () => {
    // The bound must catch a circular wait, not police a slow restart. A
    // transition that simply takes a while and then finishes must be untouched.
    const scheduler = openScheduler();
    const storeId = {};
    let releaseTransition!: () => void;

    const barrier = scheduler.runControlBarrier(storeId, 'oxigraph.restart', async () => {
      await new Promise<void>((resolve) => {
        releaseTransition = resolve;
      });
      return 'restarted';
    }, 'gen-1', 10_000);
    await settle(() => scheduler.snapshot.barrierInflight === 1, 'transition running');

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    releaseTransition();
    await expect(barrier).resolves.toBe('restarted');
    expect(scheduler.snapshot).toMatchObject({
      barrierTimeouts: 0,
      barrierPending: 0,
      barrierInflight: 0,
      admissionSealedStores: 0,
    });
  });

  it('propagates a failing transition and still releases the seal', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    const boom = new Error('transition failed');

    await expect(
      scheduler.runControlBarrier(storeId, 'profile.apply', async () => {
        throw boom;
      }, 'gen-1'),
    ).rejects.toBe(boom);

    expect(scheduler.snapshot).toMatchObject({
      barrierPending: 0,
      barrierInflight: 0,
      admissionSealedStores: 0,
      admissionHeldRuns: 0,
      admissionTrackedStores: 0,
    });
    await expect(scheduler.run('normal', 'agents.write', async () => 'ok',
      undefined, admission(storeId, 'shared'))).resolves.toBe('ok');
  });

  it('releases the seal when a transition throws synchronously', async () => {
    const scheduler = openScheduler();
    const storeId = {};
    const boom = new Error('sync boom');
    const throwing = (() => {
      throw boom;
    }) as unknown as () => Promise<string>;

    await expect(scheduler.runControlBarrier(storeId, 'profile.apply', throwing, 'gen-1'))
      .rejects.toBe(boom);
    expect(scheduler.snapshot).toMatchObject({
      barrierInflight: 0,
      admissionSealedStores: 0,
      admissionTrackedStores: 0,
    });
  });
});
