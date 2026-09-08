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
  planner.admit(['b0', 'b1', 'b2'], Array.from({ length: 10 }, (_, i) => `u${i}`), key => { admitted.push(key); return true; });
  expect(admitted).toEqual(['b0', ...Array.from({ length: 8 }, (_, i) => `u${i}`), 'b1', 'b2']);
});

it('keeps a partial discovery turn ahead of bound fills, then resumes bound progress', () => {
  const planner = new VmReconcileSweepPlanner(2);
  const admitted: string[] = [];
  let capacity = 2;
  const admit = (key: string) => {
    if (capacity === 0) return false;
    capacity--;
    admitted.push(key);
    return true;
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

it('resets an unfinished discovery turn on lifecycle restart', () => {
  const planner = new VmReconcileSweepPlanner(8);
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => key === 'b0');
  planner.reset();
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => { admitted.push(key); return true; });
  expect(admitted).toEqual(['b0', 'u0', 'u1', 'b1']);
});

it('handles disappearing discovery candidates and retains a rejected bound candidate', () => {
  const planner = new VmReconcileSweepPlanner(8);
  planner.admit(['b0', 'b1'], ['u0', 'u1'], key => key === 'b0');
  const admitted: string[] = [];
  planner.admit(['b0', 'b1'], [], key => { admitted.push(key); return true; });
  expect(admitted).toEqual(['b1', 'b0']);
  planner.admit(['b0', 'b1'], [], () => false);
  admitted.length = 0;
  planner.admit(['b0', 'b1'], [], key => { admitted.push(key); return true; });
  expect(admitted).toEqual(['b1', 'b0']);
});
