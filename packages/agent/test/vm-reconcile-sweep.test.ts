import { expect, it } from 'vitest';
import { VmReconcileSweepPlanner, VmReconcileSweepSelector } from '../src/vm-reconcile-sweep.js';

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
  const planner = new VmReconcileSweepPlanner(8);
  const admitted: string[] = [];
  planner.admit(['b0', 'b1', 'b2'], Array.from({ length: 10 }, (_, i) => `u${i}`), key => { admitted.push(key); return 'admitted'; });
  expect(admitted).toEqual(['b0', ...Array.from({ length: 8 }, (_, i) => `u${i}`), 'b1', 'b2']);
});

it('keeps a partial discovery turn ahead of bound fills, then resumes bound progress', () => {
  const planner = new VmReconcileSweepPlanner(2);
  const admitted: string[] = [];
  let capacity = 2;
  const admit = (key: string): 'admitted' | 'full' => {
    if (capacity === 0) return 'full';
    capacity--;
    admitted.push(key);
    return 'admitted';
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
  const planner = new VmReconcileSweepPlanner(2);
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => {
    if (admitted.length === 2) return 'full';
    admitted.push(key);
    return 'admitted';
  });
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => { admitted.push(key); return 'admitted'; });
  expect(admitted).toEqual(['b0', 'u0', 'u1', 'b1']);
});

it('resets an unfinished discovery turn on lifecycle restart', () => {
  const planner = new VmReconcileSweepPlanner(8);
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => key === 'b0' ? 'admitted' : 'full');
  planner.reset();
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => { admitted.push(key); return 'admitted'; });
  expect(admitted).toEqual(['b0', 'u0', 'u1', 'b1']);
});

it('handles disappearing discovery candidates and retains a rejected bound candidate', () => {
  const planner = new VmReconcileSweepPlanner(8);
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => key === 'b0' ? 'admitted' : 'full');
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], [], key => { admitted.push(key); return 'admitted'; });
  expect(admitted).toEqual(['b1']);
  planner.admit(['b0', 'b1'], [], () => 'full');
  admitted.length = 0;
  planner.admit(['b0', 'b1'], [], key => { admitted.push(key); return 'admitted'; });
  expect(admitted).toEqual(['b1', 'b0']);
});

it.each([
  { name: 'reordered', keys: ['b2', 'b0', 'b1', 'b3'], expected: ['b1', 'b2', 'b3'] },
  { name: 'removed', keys: ['b1', 'b2', 'b3'], expected: ['b1', 'b2', 'b3'] },
])('handles a $name leading bound key while discovery is paused', ({ keys, expected }) => {
  const planner = new VmReconcileSweepPlanner(2);
  let capacity = 2;
  planner.admit(['b0', 'b1', 'b2'], ['u0', 'u1'], () => capacity-- > 0 ? 'admitted' : 'full');
  const admitted: string[] = [];
  planner.admit(keys, ['u0', 'u1'], key => { admitted.push(key); return 'admitted'; });
  expect(admitted[0]).toBe('u1');
  expect(admitted.slice(1).sort()).toEqual(expected);
});

it.each(['full', 'closed'] as const)('does not advance after %s but advances coalesced work', (rejection) => {
  const planner = new VmReconcileSweepPlanner(2);
  const attempted: string[] = [];
  planner.admit(['b0', 'b1'], [], key => {
    attempted.push(key);
    return key === 'b0' ? 'coalesced' : rejection;
  });
  expect(attempted).toEqual(['b0', 'b1']);
  attempted.length = 0;
  planner.admit(['b0', 'b1'], [], key => { attempted.push(key); return 'admitted'; });
  expect(attempted[0]).toBe('b1');
});
