import { describe, expect, it, vi } from 'vitest';
import {
  StorePriorityScheduler,
  StoreSchedulerBusyError,
  type StorePrioritySchedulerSnapshot,
} from '../src/store-priority-scheduler.js';
import type { StoreWorkPriority } from '../src/triple-store.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class SchedulerScenario {
  private readonly events: string[] = [];
  private readonly gates: Record<StoreWorkPriority, Array<ReturnType<typeof deferred>>> = {
    ack: [],
    normal: [],
    background: [],
  };
  private readonly work: Promise<string>[] = [];

  constructor(private readonly scheduler: StorePriorityScheduler) {}

  enqueueBlocked(
    priority: StoreWorkPriority,
    count: number,
    operationPrefix = priority,
  ): void {
    const laneGates = this.gates[priority];
    const firstIndex = laneGates.length;
    for (let offset = 0; offset < count; offset += 1) {
      const index = firstIndex + offset;
      const gate = deferred();
      const label = `${priority}-${index}`;
      const operation = count === 1 ? operationPrefix : `${operationPrefix}.${index}`;
      laneGates.push(gate);
      this.work.push(this.scheduler.run(priority, operation, async () => {
        this.events.push(`${label}:start`);
        await gate.promise;
        this.events.push(`${label}:end`);
        return label;
      }));
    }
  }

  release(priority: StoreWorkPriority, index: number): void {
    const gate = this.gates[priority][index];
    if (!gate) throw new Error(`No blocked ${priority} work at index ${index}`);
    gate.resolve();
  }

  expectEvents(expected: string[]): void {
    expect(this.events).toEqual(expected);
  }

  expectStarted(expected: string[]): void {
    expect(this.events.filter((event) => event.endsWith(':start')))
      .toEqual(expected.map((label) => `${label}:start`));
  }

  expectSnapshot(expected: Partial<StorePrioritySchedulerSnapshot>): void {
    expect(this.scheduler.snapshot).toMatchObject(expected);
  }

  async finish(): Promise<string[]> {
    for (const lane of Object.values(this.gates)) {
      for (const gate of lane) gate.resolve();
    }
    return Promise.all(this.work);
  }
}

describe('StorePriorityScheduler', () => {
  for (const priority of ['ack', 'normal', 'background'] as const satisfies readonly StoreWorkPriority[]) {
    it(`bounds the ${priority} queue and returns a typed retryable rejection`, async () => {
      const scheduler = new StorePriorityScheduler(1, 0, undefined, 0, {
        ack: 1,
        normal: 1,
        background: 1,
      }, 1_000);
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
      const scheduler = new StorePriorityScheduler(1, 0, undefined, 0, 2, 20);
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
      const scheduler = new StorePriorityScheduler(1, 0, undefined, 0, 1, 100);
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
      const scheduler = new StorePriorityScheduler(1, 0, undefined, 0, 1, 100);
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

  it('lets ACK work jump ahead of queued background work', async () => {
    const scheduler = new StorePriorityScheduler(2, 1);
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

  it('releases an inflight slot when work throws synchronously', async () => {
    const scheduler = new StorePriorityScheduler(1, 0);
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

  it('starts queued normal work while the ACK queue stays saturated', async () => {
    const scheduler = new StorePriorityScheduler(3, 1, undefined, 0);
    const scenario = new SchedulerScenario(scheduler);
    scenario.enqueueBlocked('ack', 6, 'storage-ack');
    scenario.enqueueBlocked('normal', 1, 'publish.clearPublishedSwmRoots');
    await tick();

    scenario.expectSnapshot({
      ackInflight: 3,
      ackQueued: 3,
      normalInflight: 0,
      normalQueued: 1,
    });

    scenario.release('ack', 0);
    await tick();

    scenario.expectEvents([
      'ack-0:start',
      'ack-1:start',
      'ack-2:start',
      'ack-0:end',
      'normal-0:start',
    ]);
    scenario.expectSnapshot({
      ackInflight: 2,
      ackQueued: 3,
      normalInflight: 1,
      normalQueued: 0,
    });

    await expect(scenario.finish()).resolves.toHaveLength(7);
  });

  it('preserves normal and background floors at the default-like concurrency', async () => {
    const scheduler = new StorePriorityScheduler(8, 1, undefined, 1);
    const scenario = new SchedulerScenario(scheduler);
    scenario.enqueueBlocked('ack', 10, 'storage-ack');
    scenario.enqueueBlocked('normal', 1, 'publish.lifecycle-tail');
    scenario.enqueueBlocked('background', 1, 'sync.catch-up');
    await tick();

    scenario.release('ack', 0);
    await tick();
    scenario.expectStarted([
      'ack-0',
      'ack-1',
      'ack-2',
      'ack-3',
      'ack-4',
      'ack-5',
      'ack-6',
      'ack-7',
      'background-0',
    ]);
    scenario.expectSnapshot({
      ackInflight: 7,
      ackQueued: 2,
      normalQueued: 1,
      backgroundInflight: 1,
      backgroundReservedSlots: 1,
    });

    scenario.release('ack', 1);
    await tick();
    scenario.expectStarted([
      'ack-0',
      'ack-1',
      'ack-2',
      'ack-3',
      'ack-4',
      'ack-5',
      'ack-6',
      'ack-7',
      'background-0',
      'normal-0',
    ]);
    scenario.expectSnapshot({
      ackInflight: 6,
      ackQueued: 2,
      normalInflight: 1,
      backgroundInflight: 1,
      ackReservedSlots: 1,
      backgroundReservedSlots: 1,
    });

    await expect(scenario.finish()).resolves.toHaveLength(12);
  });

  it('keeps the ACK reserve work-conserving when non-ACK capacity is full', async () => {
    const scheduler = new StorePriorityScheduler(3, 1, undefined, 1);
    const scenario = new SchedulerScenario(scheduler);
    scenario.enqueueBlocked('normal', 2, 'query');
    scenario.enqueueBlocked('background', 1, 'sync.catch-up');
    scenario.enqueueBlocked('ack', 1, 'storage-ack.persist');
    await tick();

    scenario.expectStarted(['normal-0', 'normal-1', 'ack-0']);
    scenario.expectSnapshot({
      ackInflight: 1,
      normalInflight: 2,
      backgroundInflight: 0,
      backgroundQueued: 1,
    });

    scenario.release('normal', 0);
    await tick();
    scenario.expectStarted(['normal-0', 'normal-1', 'ack-0', 'background-0']);

    await expect(scenario.finish()).resolves.toHaveLength(4);
  });

  it('alternates ACK and normal progress when only one slot exists', async () => {
    const scheduler = new StorePriorityScheduler(1, 1);
    const scenario = new SchedulerScenario(scheduler);
    scenario.enqueueBlocked('ack', 2, 'storage-ack');
    scenario.enqueueBlocked('normal', 2, 'publish.tail');
    await tick();

    scenario.expectStarted(['ack-0']);
    scenario.expectSnapshot({
      ackInflight: 1,
      ackQueued: 1,
      normalQueued: 2,
      ackReservedSlots: 0,
    });

    scenario.release('ack', 0);
    await tick();
    scenario.expectStarted(['ack-0', 'normal-0']);

    scenario.release('normal', 0);
    await tick();
    scenario.expectStarted(['ack-0', 'normal-0', 'ack-1']);

    scenario.release('ack', 1);
    await tick();
    scenario.expectStarted(['ack-0', 'normal-0', 'ack-1', 'normal-1']);

    await expect(scenario.finish()).resolves.toHaveLength(4);
  });

  it('reserves a non-ACK slot for queued background work behind normal traffic', async () => {
    const scheduler = new StorePriorityScheduler(2, 0);
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

  it('does not reserve the only non-ACK slot for background work', async () => {
    const scheduler = new StorePriorityScheduler(2, 1);
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
