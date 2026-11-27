import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async () => ({ ...await vi.importActual('node:os'), availableParallelism: () => 4 }));
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

afterEach(() => vi.unstubAllEnvs());

describe('external-store capacity policy', () => {
  it.each([undefined, 'cpu', 'misspelled'])('keeps the CPU ceiling for policy %s', policy => {
    vi.stubEnv('DKG_STORE_CONCURRENCY_POLICY', policy);
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '6');
    expect(new StorePriorityScheduler().snapshot).toMatchObject({
      maxConcurrent: 4, normalInflightLimit: 2, ackReservedSlots: 1, healthReservedSlots: 1,
    });
  });

  it('requires an explicit budget as well as the configured policy to increase capacity', () => {
    vi.stubEnv('DKG_STORE_CONCURRENCY_POLICY', 'configured');
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', undefined);
    expect(new StorePriorityScheduler().snapshot.maxConcurrent).toBe(4);
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '2');
    expect(new StorePriorityScheduler().snapshot.maxConcurrent).toBe(2);
    for (const value of ['invalid', '1e100']) {
      vi.stubEnv('DKG_STORE_MAX_CONCURRENT', value);
      expect(new StorePriorityScheduler().snapshot.maxConcurrent).toBe(4);
    }
  });

  it('preserves immediate ACK and health admission with four ordinary operations on four CPUs', async () => {
    vi.stubEnv('DKG_STORE_CONCURRENCY_POLICY', 'configured');
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '6');
    const scheduler = new StorePriorityScheduler();
    const holds = Array.from({ length: 4 }, gate);
    const running = holds.map((hold, i) => scheduler.run('normal', `normal.${i}`, () => hold.promise));
    const extra = gate();
    const queued = scheduler.run('normal', 'normal.queued', () => extra.promise);
    const ack = gate(), health = gate();
    const ackJob = scheduler.run('ack', 'ack', () => ack.promise);
    const healthJob = scheduler.run('health', 'health', () => health.promise);
    try {
      expect(scheduler.snapshot).toMatchObject({
        maxConcurrent: 6, normalInflightLimit: 4, normalInflight: 4,
        normalQueued: 1, ackInflight: 1, ackQueued: 0, healthInflight: 1, healthQueued: 0,
      });
    } finally {
      holds.forEach(hold => hold.release());
      extra.release(); ack.release(); health.release();
      await Promise.all([...running, queued, ackJob, healthJob]);
    }
  });

  it('retains pre-dispatch cancellation when a larger configured budget is full', async () => {
    vi.stubEnv('DKG_STORE_CONCURRENCY_POLICY', 'configured');
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '6');
    const scheduler = new StorePriorityScheduler();
    const holds = Array.from({ length: 4 }, gate);
    const running = holds.map(hold => scheduler.run('normal', 'held', () => hold.promise));
    const controller = new AbortController(), cause = new Error('caller cancelled');
    const work = vi.fn(async () => undefined);
    const waiting = scheduler.run('normal', 'cancelled', work, controller.signal);
    controller.abort(cause);
    try { await expect(waiting).rejects.toBe(cause); expect(work).not.toHaveBeenCalled(); }
    finally { holds.forEach(hold => hold.release()); await Promise.all(running); }
  });

  it('keeps constructor capacity authoritative for library consumers', () => {
    vi.stubEnv('DKG_STORE_CONCURRENCY_POLICY', 'configured');
    vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '6');
    expect(new StorePriorityScheduler({ maxConcurrent: 3 }).snapshot.maxConcurrent).toBe(3);
  });
});

it('retains normal progress when background work fills its larger shared allowance', async () => {
  vi.stubEnv('DKG_STORE_CONCURRENCY_POLICY', 'configured');
  vi.stubEnv('DKG_STORE_MAX_CONCURRENT', '6');
  const scheduler = new StorePriorityScheduler();
  const background = Array.from({ length: 3 }, gate);
  const jobs = background.map(hold => scheduler.run('background', 'background', () => hold.promise));
  const normal = gate();
  const normalJob = scheduler.run('normal', 'normal', () => normal.promise);
  try {
    expect(scheduler.snapshot).toMatchObject({
      normalInflight: 1, backgroundInflight: 3, normalReservedSlots: 1, backgroundReservedSlots: 1,
    });
  } finally { background.forEach(hold => hold.release()); normal.release(); await Promise.all([...jobs, normalJob]); }
});
