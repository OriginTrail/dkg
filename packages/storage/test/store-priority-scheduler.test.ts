import { describe, expect, it, vi } from 'vitest';
import {
  StorePriorityScheduler,
  StoreSchedulerBusyError,
} from '../src/store-priority-scheduler.js';
import type { StoreWorkPriority } from '../src/triple-store.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('StorePriorityScheduler', () => {
  for (const priority of ['ack', 'health', 'normal', 'background'] as const satisfies readonly StoreWorkPriority[]) {
    it(`bounds the ${priority} queue and returns a typed retryable rejection`, async () => {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 1,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        backgroundReservedSlots: 0,
        queueLimits: { ack: 1, health: 1, normal: 1, background: 1 },
        queueWaitTimeoutMs: 1_000,
      });
      let release!: () => void;
      let queuedStarted = false;
      let rejectedStarted = false;
      const blocker = scheduler.run(priority, `${priority}.blocker`, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const queued = scheduler.run(priority, `${priority}.queued`, async () => {
        queuedStarted = true;
      });

      await expect(scheduler.run(priority, `${priority}.rejected`, async () => {
        rejectedStarted = true;
      })).rejects.toMatchObject({
        name: 'StoreSchedulerBusyError',
        code: 'STORE_SCHEDULER_BUSY',
        retryable: true,
        reason: 'queue_full',
        priority,
      });
      expect(rejectedStarted).toBe(false);
      expect(scheduler.snapshot[`${priority}Queued`]).toBe(1);

      release();
      await expect(Promise.all([blocker, queued])).resolves.toEqual([undefined, undefined]);
      expect(queuedStarted).toBe(true);
    });

    it(`expires ${priority} work before dispatch and recovers after pressure clears`, async () => {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 1,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        backgroundReservedSlots: 0,
        queueLimits: 2,
        queueWaitTimeoutMs: 20,
      });
      let release!: () => void;
      let expiredStarted = false;
      const blocker = scheduler.run(priority, `${priority}.blocker`, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const expired = scheduler.run(priority, `${priority}.expired`, async () => {
        expiredStarted = true;
      });

      await expect(expired).rejects.toMatchObject({
        code: 'STORE_SCHEDULER_BUSY',
        retryable: true,
        reason: 'queue_wait_timeout',
        priority,
      });
      expect(expiredStarted).toBe(false);
      expect(scheduler.snapshot[`${priority}Queued`]).toBe(0);

      release();
      await blocker;
      await expect(scheduler.run(priority, `${priority}.recovered`, async () => 'ok')).resolves.toBe('ok');
    });
  }

  it('removes a cancelled queued entry and releases its abort listener and wait timer', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 1,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        backgroundReservedSlots: 0,
        queueLimits: 1,
        queueWaitTimeoutMs: 100,
      });
      let release!: () => void;
      const blocker = scheduler.run('normal', 'normal.blocker', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, 'addEventListener');
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      let cancelledStarted = false;
      const cancelled = scheduler.run('normal', 'normal.cancelled', async () => {
        cancelledStarted = true;
      }, controller.signal);
      const reason = new Error('caller cancelled');

      controller.abort(reason);
      await expect(cancelled).rejects.toBe(reason);
      expect(cancelledStarted).toBe(false);
      expect(scheduler.snapshot.normalQueued).toBe(0);
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(scheduler.snapshot.normalQueued).toBe(0);
      release();
      await blocker;
      addListener.mockRestore();
      removeListener.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up admission state when queued work starts normally', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 1,
        ackReservedSlots: 0,
        backgroundReservedSlots: 0,
        queueLimits: 1,
        queueWaitTimeoutMs: 100,
      });
      let release!: () => void;
      const blocker = scheduler.run('normal', 'normal.blocker', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, 'addEventListener');
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const queued = scheduler.run('normal', 'normal.queued', async () => 'ok', controller.signal);

      release();
      await blocker;
      await expect(queued).resolves.toBe('ok');
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(scheduler.snapshot).toMatchObject({ normalInflight: 0, normalQueued: 0 });
      addListener.mockRestore();
      removeListener.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports a distinguishable busy error type for boundary mapping', () => {
    const error = new StoreSchedulerBusyError('queue_full', 'ack', 'storage-ack.read');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StoreSchedulerBusyError);
    expect(error).toMatchObject({
      code: 'STORE_SCHEDULER_BUSY',
      retryable: true,
      reason: 'queue_full',
    });
  });

  it('preserves queue admission settings in the deprecated positional constructor', async () => {
    vi.useFakeTimers();
    let releaseNormal1: (() => void) | undefined;
    let releaseNormal2: (() => void) | undefined;
    let releaseBackground: (() => void) | undefined;
    const running: Array<Promise<unknown>> = [];
    try {
      const scheduler = new StorePriorityScheduler(
        2,
        0,
        undefined,
        1,
        { ack: 3, normal: 2, background: 1 },
        25,
        0,
      );
      expect(scheduler.snapshot).toMatchObject({
        maxConcurrent: 2,
        ackReservedSlots: 0,
        healthReservedSlots: 0,
        backgroundReservedSlots: 1,
        ackQueueLimit: 3,
        normalQueueLimit: 2,
        backgroundQueueLimit: 1,
        queueWaitTimeoutMs: 25,
      });

      const events: string[] = [];
      const normal1 = scheduler.run('normal', 'legacy.normal.1', async () => {
        events.push('normal-1:start');
        await new Promise<void>((resolve) => {
          releaseNormal1 = resolve;
        });
        events.push('normal-1:end');
      });
      const normal2 = scheduler.run('normal', 'legacy.normal.2', async () => {
        events.push('normal-2:start');
        await new Promise<void>((resolve) => {
          releaseNormal2 = resolve;
        });
      });
      const background = scheduler.run('background', 'legacy.background', async () => {
        events.push('background:start');
        await new Promise<void>((resolve) => {
          releaseBackground = resolve;
        });
      });
      const timedOutNormal = scheduler.run('normal', 'legacy.normal.timeout', async () => {
        events.push('timed-out-normal:start');
      });
      const timedOutNormalAssertion = expect(timedOutNormal).rejects.toMatchObject({
        reason: 'queue_wait_timeout',
        priority: 'normal',
      });
      running.push(normal1, normal2, background, timedOutNormal);

      await expect(
        scheduler.run('background', 'legacy.background.queue-full', async () => undefined),
      ).rejects.toMatchObject({
        reason: 'queue_full',
        priority: 'background',
      });

      releaseNormal1();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual([
        'normal-1:start',
        'normal-2:start',
        'normal-1:end',
        'background:start',
      ]);

      await vi.advanceTimersByTimeAsync(25);
      await timedOutNormalAssertion;
      expect(events).not.toContain('timed-out-normal:start');

      releaseBackground();
      releaseNormal2();
      await Promise.all([normal1, normal2, background]);
    } finally {
      releaseNormal1?.();
      releaseNormal2?.();
      await vi.advanceTimersByTimeAsync(0);
      releaseBackground?.();
      await vi.runAllTimersAsync();
      await Promise.allSettled(running);
      vi.useRealTimers();
    }
  });

  it('honors the deprecated seventh positional health reservation', () => {
    const scheduler = new StorePriorityScheduler(
      3,
      1,
      undefined,
      0,
      undefined,
      1_000,
      1,
    );

    expect(scheduler.snapshot.healthReservedSlots).toBe(1);
  });

  it('lets ACK work jump ahead of queued background work', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 1 });
    const events: string[] = [];
    let releaseBackground!: () => void;
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });

    const firstBackground = scheduler.run('background', 'sync.listGraphs', async () => {
      events.push('background-1:start');
      await backgroundGate;
      events.push('background-1:end');
      return 'background-1';
    });
    await tick();

    const secondBackground = scheduler.run('background', 'metrics.countQuads', async () => {
      events.push('background-2:start');
      return 'background-2';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      backgroundInflight: 1,
      backgroundQueued: 1,
      ackInflight: 0,
    });

    const ack = scheduler.run('ack', 'storage-ack.loadSWMQuads', async () => {
      events.push('ack:start');
      return 'ack';
    });
    await expect(ack).resolves.toBe('ack');

    expect(events).toEqual(['background-1:start', 'ack:start']);

    releaseBackground();
    await expect(Promise.all([firstBackground, secondBackground])).resolves.toEqual([
      'background-1',
      'background-2',
    ]);
    expect(events).toEqual([
      'background-1:start',
      'ack:start',
      'background-1:end',
      'background-2:start',
    ]);
  });

  it('keeps normal capacity available while long background work is in flight', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 3,
      ackReservedSlots: 1,
      healthReservedSlots: 0,
      normalReservedSlots: 1,
      backgroundReservedSlots: 1,
      queueLimits: 64,
      queueWaitTimeoutMs: 1_000,
    });
    const events: string[] = [];
    let releaseBackground!: () => void;

    const firstBackground = scheduler.run('background', 'finalization.slice.1', async () => {
      events.push('background-1:start');
      await new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      events.push('background-1:end');
      return 'background-1';
    });
    await tick();

    const secondBackground = scheduler.run('background', 'finalization.slice.2', async () => {
      events.push('background-2:start');
      return 'background-2';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      backgroundInflight: 1,
      backgroundQueued: 1,
      normalReservedSlots: 1,
    });

    const normal = scheduler.run('normal', 'join-policy.validation', async () => {
      events.push('normal:start');
      return 'normal';
    });
    await expect(normal).resolves.toBe('normal');
    expect(events).toEqual(['background-1:start', 'normal:start']);

    releaseBackground();
    await expect(Promise.all([firstBackground, secondBackground])).resolves.toEqual([
      'background-1',
      'background-2',
    ]);
  });

  it('normalizes conflicting reserves so normal work can use idle capacity', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 4,
      ackReservedSlots: 1,
      healthReservedSlots: 0,
      normalReservedSlots: 2,
      backgroundReservedSlots: 2,
    });
    const events: string[] = [];
    let releaseBackground!: () => void;

    const firstBackground = scheduler.run('background', 'finalization.slice.1', async () => {
      events.push('background-1:start');
      await new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      return 'background-1';
    });
    const secondBackground = scheduler.run('background', 'finalization.slice.2', async () => {
      events.push('background-2:start');
      return 'background-2';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      normalReservedSlots: 2,
      backgroundReservedSlots: 1,
      backgroundInflight: 1,
      backgroundQueued: 1,
    });

    const normal = scheduler.run('normal', 'join-policy.validation', async () => {
      events.push('normal:start');
      return 'normal';
    });
    await expect(normal).resolves.toBe('normal');
    expect(events).toEqual(['background-1:start', 'normal:start']);

    releaseBackground();
    await expect(Promise.all([firstBackground, secondBackground])).resolves.toEqual([
      'background-1',
      'background-2',
    ]);
  });

  it('reads the normal reserve from DKG_STORE_NORMAL_RESERVED_SLOTS', async () => {
    const previous = process.env.DKG_STORE_NORMAL_RESERVED_SLOTS;
    let releaseBackground: (() => void) | undefined;
    const backgroundWork: Array<Promise<unknown>> = [];
    process.env.DKG_STORE_NORMAL_RESERVED_SLOTS = '2';
    try {
      const scheduler = new StorePriorityScheduler({
        maxConcurrent: 4,
        ackReservedSlots: 1,
        healthReservedSlots: 0,
        backgroundReservedSlots: 1,
      });
      const firstBackground = scheduler.run('background', 'env.background.1', async () => {
        await new Promise<void>((resolve) => {
          releaseBackground = resolve;
        });
      });
      const secondBackground = scheduler.run('background', 'env.background.2', async () => undefined);
      backgroundWork.push(firstBackground, secondBackground);
      await tick();

      expect(scheduler.snapshot).toMatchObject({
        normalReservedSlots: 2,
        backgroundInflight: 1,
        backgroundQueued: 1,
      });

      releaseBackground?.();
      await Promise.all([firstBackground, secondBackground]);
    } finally {
      releaseBackground?.();
      await Promise.allSettled(backgroundWork);
      if (previous === undefined) delete process.env.DKG_STORE_NORMAL_RESERVED_SLOTS;
      else process.env.DKG_STORE_NORMAL_RESERVED_SLOTS = previous;
    }
  });

  it('releases an inflight slot when work throws synchronously', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0 });
    const boom = () => {
      throw new Error('sync boom');
    };

    await expect(
      scheduler.run('ack', 'storage-ack.sync-throw', boom as unknown as () => Promise<string>),
    ).rejects.toThrow('sync boom');
    expect(scheduler.snapshot).toMatchObject({
      ackInflight: 0,
      ackQueued: 0,
    });

    await expect(
      scheduler.run('ack', 'storage-ack.after-throw', async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('reserves a non-ACK slot for queued background work behind normal traffic', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 2,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
    });
    const events: string[] = [];
    let releaseNormal1!: () => void;
    let releaseNormal2!: () => void;

    const normal1 = scheduler.run('normal', 'query.default.1', async () => {
      events.push('normal-1:start');
      await new Promise<void>((resolve) => {
        releaseNormal1 = resolve;
      });
      events.push('normal-1:end');
      return 'normal-1';
    });
    const normal2 = scheduler.run('normal', 'query.default.2', async () => {
      events.push('normal-2:start');
      await new Promise<void>((resolve) => {
        releaseNormal2 = resolve;
      });
      events.push('normal-2:end');
      return 'normal-2';
    });
    await tick();

    const background = scheduler.run('background', 'sync.catch-up', async () => {
      events.push('background:start');
      return 'background';
    });
    const normal3 = scheduler.run('normal', 'query.default.3', async () => {
      events.push('normal-3:start');
      return 'normal-3';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      normalInflight: 2,
      normalQueued: 1,
      backgroundQueued: 1,
      backgroundReservedSlots: 1,
    });

    releaseNormal1();
    await tick();

    expect(events).toEqual([
      'normal-1:start',
      'normal-2:start',
      'normal-1:end',
      'background:start',
      'normal-3:start',
    ]);

    releaseNormal2();
    await expect(Promise.all([normal1, normal2, background, normal3])).resolves.toEqual([
      'normal-1',
      'normal-2',
      'background',
      'normal-3',
    ]);
  });

  it('keeps health and ACK lanes available while background work is saturated', async () => {
    const scheduler = new StorePriorityScheduler(3, 1, undefined, 0, undefined, 1_000, 1);
    let release!: () => void;
    const background1 = scheduler.run('background', 'scan.1', async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });
    const background2 = scheduler.run('background', 'scan.2', async () => undefined);
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      backgroundInflight: 1,
      backgroundQueued: 1,
      healthReservedSlots: 1,
      ackReservedSlots: 1,
    });
    await expect(scheduler.run('health', 'status.count', async () => 'healthy')).resolves.toBe('healthy');
    await expect(scheduler.run('ack', 'ack.verify', async () => 'ack')).resolves.toBe('ack');

    release();
    await Promise.all([background1, background2]);
  });

  it('caps aggregate background producers while preserving normal-query capacity', async () => {
    const scheduler = new StorePriorityScheduler(4, 1, undefined, 0, undefined, 1_000, 1);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const producers = [
      'finalization.scan',
      'reconcile.scan',
      'sync.inbound',
      'sync.outbound',
      'promotion.read',
    ].map((source) => scheduler.run('background', source, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active -= 1;
    }));
    await tick();

    expect(maxActive).toBe(1);
    expect(scheduler.snapshot).toMatchObject({
      backgroundInflight: 1,
      backgroundQueued: 4,
      ackReservedSlots: 1,
      healthReservedSlots: 1,
      normalReservedSlots: 1,
    });
    while (producers.some(() => scheduler.snapshot.backgroundInflight > 0 || scheduler.snapshot.backgroundQueued > 0)) {
      const release = releases.shift();
      if (!release) break;
      release();
      await tick();
    }
    for (const release of releases.splice(0)) release();
    await Promise.all(producers);
    expect(maxActive).toBe(1);
  });

  it('does not reserve the only non-ACK slot for background work', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 1 });
    const events: string[] = [];
    let releaseAck!: () => void;
    let releaseBackground!: () => void;

    const ack = scheduler.run('ack', 'storage-ack.persist', async () => {
      events.push('ack:start');
      await new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      events.push('ack:end');
      return 'ack';
    });

    const background1 = scheduler.run('background', 'sync.catch-up.1', async () => {
      events.push('background-1:start');
      await new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      events.push('background-1:end');
      return 'background-1';
    });
    await tick();

    const background2 = scheduler.run('background', 'sync.catch-up.2', async () => {
      events.push('background-2:start');
      return 'background-2';
    });
    const normal = scheduler.run('normal', 'query.default', async () => {
      events.push('normal:start');
      return 'normal';
    });
    await tick();

    expect(scheduler.snapshot).toMatchObject({
      ackInflight: 1,
      backgroundInflight: 1,
      backgroundQueued: 1,
      normalQueued: 1,
      normalReservedSlots: 0,
      backgroundReservedSlots: 0,
    });

    releaseBackground();
    await tick();

    expect(events).toEqual([
      'ack:start',
      'background-1:start',
      'background-1:end',
      'normal:start',
      'background-2:start',
    ]);

    releaseAck();
    await expect(Promise.all([ack, background1, background2, normal])).resolves.toEqual([
      'ack',
      'background-1',
      'background-2',
      'normal',
    ]);
  });
});
