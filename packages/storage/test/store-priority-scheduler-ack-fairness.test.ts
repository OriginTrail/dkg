import { describe, expect, it } from 'vitest';
import { StorePriorityScheduler, type StorePrioritySchedulerSnapshot } from '../src/store-priority-scheduler.js';
import type { StoreWorkPriority } from '../src/triple-store.js';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

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
    health: [],
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

describe('ACK saturation fairness', () => {
  it('gives queued ACKs a bounded turn when ordinary floors fill all unreserved capacity', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 2, ackReservedSlots: 0,
      healthReservedSlots: 0, normalReservedSlots: 1, backgroundReservedSlots: 1 });
    const scenario = new SchedulerScenario(scheduler);
    scenario.enqueueBlocked('normal', 1);
    scenario.enqueueBlocked('background', 1);
    scenario.enqueueBlocked('ack', 1);
    scenario.enqueueBlocked('normal', 10);
    scenario.enqueueBlocked('background', 10);
    try {
      await tick();
      scenario.expectSnapshot({ normalInflight: 1, backgroundInflight: 1, ackQueued: 1 });
      scenario.release('normal', 0); await tick();
      scenario.release('background', 0); await tick();
      scenario.release('normal', 1); await tick();
      scenario.expectStarted(['normal-0', 'background-0', 'normal-1', 'background-1', 'ack-0']);
      scenario.expectSnapshot({ ackInflight: 1, ackQueued: 0, normalQueued: 9, backgroundQueued: 9 });
    } finally { await scenario.finish(); }
  });

  it('starts queued normal work while the ACK queue stays saturated', async () => {
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 3, ackReservedSlots: 1, healthReservedSlots: 0, backgroundReservedSlots: 0 });
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
    const scheduler = new StorePriorityScheduler({ maxConcurrent: 3, ackReservedSlots: 1, healthReservedSlots: 0, backgroundReservedSlots: 1 });
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

});
