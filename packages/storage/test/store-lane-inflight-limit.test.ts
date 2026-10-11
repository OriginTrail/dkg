import { describe, expect, it } from 'vitest';

import {
  StorePriorityScheduler,
  storeLaneInflightLimit,
  withDefaultStoreWorkPriority,
  type StorePrioritySchedulerOptions,
} from '../src/store-priority-scheduler.js';
import type { StorePressureSnapshot, StoreWorkPriority } from '../src/triple-store.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The most operations of one lane that ran together when `count` were submitted at once. */
async function admittedTogether(
  scheduler: StorePriorityScheduler,
  priority: StoreWorkPriority,
  count: number,
): Promise<number> {
  const releases: Array<() => void> = [];
  let active = 0;
  let mostActive = 0;
  const work = Array.from({ length: count }, (_, index) => (
    scheduler.run(priority, `lane-limit.${priority}.${index}`, async () => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active -= 1;
    })
  ));
  await tick();
  while (releases.length > 0) {
    releases.shift()!();
    await tick();
  }
  await Promise.all(work);
  return mostActive;
}

function storeWith(snapshot: Partial<StorePressureSnapshot> | undefined) {
  return { getPressureSnapshot: () => snapshot as StorePressureSnapshot | undefined };
}

describe('store lane in-flight limits', () => {
  // The shipped reserves, stated here so the process environment cannot change them.
  const reserves: StorePrioritySchedulerOptions = {
    ackReservedSlots: 1, healthReservedSlots: 1, normalReservedSlots: 1, backgroundReservedSlots: 1,
  };
  const configurations: ReadonlyArray<readonly [string, StorePrioritySchedulerOptions, number, number]> = [
    ['the default four slots', { ...reserves, maxConcurrent: 4 }, 2, 1],
    ['eight slots', { ...reserves, maxConcurrent: 8 }, 6, 5],
    ['two slots', { ...reserves, maxConcurrent: 2 }, 1, 1],
    ['no normal reserve', { ...reserves, maxConcurrent: 6, normalReservedSlots: 0 }, 4, 4],
    ['a three-slot normal reserve', { ...reserves, maxConcurrent: 8, normalReservedSlots: 3 }, 6, 3],
  ];

  it.each(configurations)(
    'reports what each shared lane admits at once with %s',
    async (_label, options, normal, background) => {
      const scheduler = new StorePriorityScheduler({ ...options, queueWaitTimeoutMs: 60_000 });

      expect(scheduler.snapshot).toMatchObject({
        normalInflightLimit: normal,
        backgroundInflightLimit: background,
      });
      // The report is what admission does, not a second copy of its arithmetic.
      expect(await admittedTogether(scheduler, 'background', background + 3)).toBe(background);
      expect(await admittedTogether(scheduler, 'normal', normal + 3)).toBe(normal);
    },
  );

  it('answers for the lane that unprioritised work started here runs in', () => {
    const scheduler = new StorePriorityScheduler({ ...reserves, maxConcurrent: 8 });
    const store = storeWith(scheduler.snapshot);

    expect(storeLaneInflightLimit(store)).toBe(6);
    expect(withDefaultStoreWorkPriority('background', () => storeLaneInflightLimit(store))).toBe(5);
    expect(withDefaultStoreWorkPriority('background', () => storeLaneInflightLimit(store, 'normal')))
      .toBe(6);
    expect(storeLaneInflightLimit(store, 'background')).toBe(5);
  });

  it('has no answer for a store that does not schedule admission or does not say', () => {
    expect(storeLaneInflightLimit({})).toBeUndefined();
    expect(storeLaneInflightLimit(storeWith(undefined))).toBeUndefined();
    expect(storeLaneInflightLimit(storeWith({ maxConcurrent: 4, ackReservedSlots: 1 }), 'background'))
      .toBeUndefined();
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(storeLaneInflightLimit(storeWith({ backgroundInflightLimit: limit }), 'background'))
        .toBeUndefined();
    }
  });

  it('has no answer for the reserved lanes, whose capacity is not a fan-out width', () => {
    const store = storeWith(new StorePriorityScheduler({ ...reserves, maxConcurrent: 8 }).snapshot);

    expect(storeLaneInflightLimit(store, 'ack')).toBeUndefined();
    expect(storeLaneInflightLimit(store, 'health')).toBeUndefined();
    expect(withDefaultStoreWorkPriority('ack', () => storeLaneInflightLimit(store))).toBeUndefined();
  });
});
