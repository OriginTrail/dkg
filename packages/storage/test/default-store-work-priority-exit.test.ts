import { describe, expect, it } from 'vitest';
import {
  StorePriorityScheduler,
  activeDefaultStoreWorkPriority,
  withDefaultStoreWorkPriority,
  withoutDefaultStoreWorkPriority,
} from '../src/store-priority-scheduler.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('withoutDefaultStoreWorkPriority', () => {
  it('hides the caller\'s ambient lane from the work it runs, including work that outlives the call', async () => {
    const seen: Array<string | undefined> = [];
    const background = withDefaultStoreWorkPriority('background', async () => {
      seen.push(activeDefaultStoreWorkPriority());
      const detached = withoutDefaultStoreWorkPriority(async () => {
        seen.push(activeDefaultStoreWorkPriority());
        await tick();
        seen.push(activeDefaultStoreWorkPriority());
      });
      await tick();
      seen.push(activeDefaultStoreWorkPriority());
      await detached;
    });
    await background;
    // The caller keeps its lane before and after; the detached work never had it, before or after an await.
    expect(seen).toEqual(['background', undefined, undefined, 'background']);
    expect(activeDefaultStoreWorkPriority()).toBeUndefined();
  });

  it('puts a store call made inside it in the default lane, not the caller\'s', async () => {
    const scheduler = new StorePriorityScheduler({
      maxConcurrent: 4, ackReservedSlots: 1, healthReservedSlots: 1, normalReservedSlots: 1, backgroundReservedSlots: 1,
      queueLimits: 64, queueWaitTimeoutMs: 1_000,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const scoped = withDefaultStoreWorkPriority('background', () => scheduler.run(undefined, 'caller.read', () => held));
    const exited = withDefaultStoreWorkPriority('background', () =>
      withoutDefaultStoreWorkPriority(() => scheduler.run(undefined, 'worker.read', () => held)));
    await tick();

    expect(scheduler.snapshot).toMatchObject({ backgroundInflight: 1, normalInflight: 1 });
    release();
    await Promise.all([scoped, exited]);
  });

  it('returns what the function returns and lets its error through', async () => {
    expect(withoutDefaultStoreWorkPriority(() => 42)).toBe(42);
    expect(() => withoutDefaultStoreWorkPriority(() => { throw new Error('boom'); })).toThrow('boom');
    await expect(withoutDefaultStoreWorkPriority(async () => { throw new Error('later'); })).rejects.toThrow('later');
  });
});
