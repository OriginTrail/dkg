import { expect, it, vi } from 'vitest';
import { VmReconcileSweepPlanner, VmReconcileSweepSelector } from '../src/internal/vm-reconcile-sweep.js';
import { VmReconcileSchedulingRuntime } from '../src/vm-reconcile-dispatcher.js';

it('visits at most one rotation over already-classified candidates and returns admission count', () => {
  const selector = new VmReconcileSweepSelector();
  const admitted: string[] = [];
  expect(selector.admit(['a', 'b'], 8, (key) => { admitted.push(key); return true; })).toBe(2);
  expect(admitted).toEqual(['a', 'b']);
});

it('retries the first rejected candidate after queue capacity recovers', () => {
  const selector = new VmReconcileSweepSelector();
  const first: string[] = [], second: string[] = [];
  selector.admit(['a', 'b', 'c'], 3, (key) => { first.push(key); return key !== 'b'; });
  selector.admit(['a', 'b', 'c'], 2, (key) => { second.push(key); return true; });
  expect(first).toEqual(['a', 'b']);
  expect(second).toEqual(['b', 'c']);
});

it('retains its logical position when earlier keys disappear', () => {
  const selector = new VmReconcileSweepSelector();
  selector.admit(['a', 'b', 'c', 'd'], 2, () => true);
  const admitted: string[] = [];
  selector.admit(['b', 'c', 'd', 'e'], 2, (key) => { admitted.push(key); return true; });
  expect(admitted).toEqual(['c', 'd']);
});

it('uses its index when the exact next key is deleted and includes appended candidates', () => {
  const selector = new VmReconcileSweepSelector();
  selector.admit(['a', 'b', 'c', 'd'], 2, () => true);
  const admitted: string[] = [];
  selector.admit(['a', 'b', 'd', 'e'], 2, (key) => { admitted.push(key); return true; });
  expect(admitted).toEqual(['d', 'e']);
});

it.each(['explicit', 'empty'])('resets after %s lifecycle reset', (kind) => {
  const selector = new VmReconcileSweepSelector();
  selector.admit(['a', 'b', 'c'], 2, () => true);
  if (kind === 'explicit') selector.reset();
  else selector.admit([], 2, () => true);
  const admitted: string[] = [];
  selector.admit(['a', 'b', 'c'], 1, (key) => { admitted.push(key); return true; });
  expect(admitted).toEqual(['a']);
});

it('admits bound first, up to eight discovery candidates, then the rest of the bound rotation once', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 8 }, () => () => undefined);
  const admitted: string[] = [];
  planner.admit(['b0', 'b1', 'b2'], Array.from({ length: 10 }, (_, i) => `u${i}`), key => { admitted.push(key); return Promise.resolve(); });
  expect(admitted).toEqual(['b0', ...Array.from({ length: 8 }, (_, i) => `u${i}`), 'b1', 'b2']);
});

it('bounds timer admissions and rotates through historical graphs across ticks', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 2, periodicBoundBatchSize: 3 }, () => () => undefined);
  const keys = Array.from({ length: 10 }, (_, i) => `b${i}`);
  const turns: string[][] = [];
  for (let tick = 0; tick < 4; tick++) {
    const admitted: string[] = [];
    planner.admit(keys, [], (key) => {
      admitted.push(key);
      return Promise.resolve();
    });
    turns.push(admitted);
  }
  expect(turns).toEqual([
    ['b0', 'b1', 'b2'],
    ['b3', 'b4', 'b5'],
    ['b6', 'b7', 'b8'],
    ['b9', 'b0', 'b1'],
  ]);
});

it('does not accumulate historical timer work while a worker is slow', async () => {
  const started: string[] = [];
  const release = new Map<string, () => void>();
  const runtime = new VmReconcileSchedulingRuntime<void>(
    (key) => new Promise<void>((resolve) => {
      started.push(key);
      release.set(key, resolve);
    }),
    () => undefined,
    { concurrency: 1, discoveryBatchSize: 2, periodicBoundBatchSize: 8 },
  );
  const keys = ['b0', 'b1', 'b2', 'b3'];
  runtime.scheduleSweep(keys, [], () => true);
  await Promise.resolve();
  expect(started).toEqual(['b0']);
  expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 1 });

  runtime.scheduleSweep(keys, [], () => true);
  expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 1 });
  expect(runtime.isInFlight('b2')).toBe(false);

  release.get('b0')!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.scheduleSweep(keys, [], () => true);
  expect(runtime.isInFlight('b2')).toBe(true);

  for (const key of ['b1', 'b2']) {
    release.get(key)!();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await runtime.waitForIdle();
});

it('keeps unbound discovery admitting when the bound timer backlog is full', async () => {
  const releases: Array<() => void> = [];
  const started: string[] = [];
  const runtime = new VmReconcileSchedulingRuntime<void>(
    key => {
      started.push(key);
      return new Promise<void>((resolve) => { releases.push(resolve); });
    },
    () => undefined,
    { concurrency: 1, maxPending: 4, discoveryBatchSize: 1 },
  );
  try {
    runtime.scheduleSweep(['b0', 'b1', 'b2'], [], () => true);
    await Promise.resolve();
    expect(runtime.snapshot()).toMatchObject({ active: 1, queued: 1 });
    runtime.scheduleSweep(['b2'], ['u0'], () => true);
    expect(runtime.isInFlight('b2')).toBe(false);
    expect(runtime.isInFlight('u0')).toBe(true);
    for (let turn = 0; turn < 3 && !started.includes('u0'); turn++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()!();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(started).toContain('u0');
  } finally {
    const closing = runtime.close();
    for (const release of releases.splice(0)) release();
    await closing;
  }
});

it('uses non-default runtime batch sizes for bound work and discovery', async () => {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  const runtime = new VmReconcileSchedulingRuntime<void>(
    key => {
      started.push(key);
      return new Promise<void>((resolve) => { releases.push(resolve); });
    },
    () => undefined,
    { concurrency: 10, maxPending: 10, periodicBoundBatchSize: 2, discoveryBatchSize: 1 },
  );
  try {
    runtime.scheduleSweep(['b0', 'b1', 'b2', 'b3'], ['u0', 'u1', 'u2'], () => true);
    await Promise.resolve();
    expect(started.sort()).toEqual(['b0', 'b1', 'u0']);
    expect(runtime.isInFlight('b2')).toBe(false);
    expect(runtime.isInFlight('u1')).toBe(false);
  } finally {
    const closing = runtime.close();
    for (const release of releases.splice(0)) release();
    await closing;
  }
});

it('keeps a partial discovery turn ahead of bound fills, then resumes bound progress', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 2 }, () => () => undefined);
  const admitted: string[] = [];
  let capacity = 2;
  const admit = (key: string): Promise<void> | undefined => {
    if (capacity === 0) return undefined;
    capacity--;
    admitted.push(key);
    return Promise.resolve();
  };
  planner.admit(['b0', 'b1'], ['u0', 'u1', 'u2'], admit);
  expect(admitted).toEqual(['b0', 'u0']);
  capacity = 1;
  planner.admit(['b0', 'b1'], ['u0', 'u1', 'u2'], admit);
  expect(admitted).toEqual(['b0', 'u0', 'u1']);
  capacity = 1;
  planner.admit(['b0', 'b1'], ['u0', 'u1', 'u2'], admit);
  expect(admitted).toEqual(['b0', 'u0', 'u1', 'b1']);
});

it('does not repeat the leading bound graph when discovery finishes on a later call', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 2 }, () => () => undefined);
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => {
    if (admitted.length === 2) return undefined;
    admitted.push(key);
    return Promise.resolve();
  });
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => { admitted.push(key); return Promise.resolve(); });
  expect(admitted).toEqual(['b0', 'u0', 'u1', 'b1']);
});

it('resets an unfinished discovery turn on lifecycle restart', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 8 }, () => () => undefined);
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => key === 'b0' ? Promise.resolve() : undefined);
  planner.reset();
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => { admitted.push(key); return Promise.resolve(); });
  expect(admitted).toEqual(['b0', 'u0', 'u1', 'b1']);
});

it('handles disappearing discovery candidates and retains a rejected bound candidate', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 8 }, () => () => undefined);
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => key === 'b0' ? Promise.resolve() : undefined);
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], [], key => { admitted.push(key); return Promise.resolve(); });
  expect(admitted).toEqual(['b1']);
  planner.admit(['b0', 'b1'], [], () => undefined);
  admitted.length = 0;
  planner.admit(['b0', 'b1'], [], key => { admitted.push(key); return Promise.resolve(); });
  expect(admitted).toEqual(['b1', 'b0']);
});

it.each([
  { name: 'reordered', keys: ['b2', 'b0', 'b1', 'b3'], expected: ['b1', 'b2', 'b3'] },
  { name: 'removed', keys: ['b1', 'b2', 'b3'], expected: ['b1', 'b2', 'b3'] },
])('handles a $name leading bound key while discovery is paused', ({ keys, expected }) => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 2 }, () => () => undefined);
  let capacity = 2;
  planner.admit(['b0', 'b1', 'b2'], ['u0', 'u1'], () => capacity-- > 0 ? Promise.resolve() : undefined);
  const admitted: string[] = [];
  planner.admit(keys, ['u0', 'u1'], key => { admitted.push(key); return Promise.resolve(); });
  expect(admitted[0]).toBe('u1');
  expect(admitted.slice(1).sort()).toEqual(expected);
});

it('does not advance after rejection but advances accepted or coalesced work', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 2 }, () => () => undefined);
  const attempted: string[] = [];
  planner.admit(['b0', 'b1'], [], key => {
    attempted.push(key);
    return key === 'b0' ? Promise.resolve() : undefined;
  });
  expect(attempted).toEqual(['b0', 'b1']);
  attempted.length = 0;
  planner.admit(['b0', 'b1'], [], key => { attempted.push(key); return Promise.resolve(); });
  expect(attempted[0]).toBe('b1');
});

it('does not admit a discovery key twice when it binds before the retained tail resumes', () => {
  const planner = new VmReconcileSweepPlanner({ discoveryBatchSize: 2 }, () => () => undefined);
  const admitted: string[] = [];
  let capacity = 2;
  planner.admit(['b'], ['u0', 'u1'], key => {
    if (capacity-- <= 0) return undefined;
    admitted.push(key);
    return Promise.resolve();
  });

  planner.admit(['b', 'u0'], ['u1'], key => {
    admitted.push(key);
    return Promise.resolve();
  });

  expect(admitted).toEqual(['b', 'u0', 'u1']);
});
