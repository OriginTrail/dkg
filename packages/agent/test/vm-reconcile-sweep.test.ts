import { expect, it } from 'vitest';
import { VmReconcileSweepSelector } from '../src/vm-reconcile-sweep.js';

it('visits at most one rotation and spends the budget only on eligible candidates', () => {
  const selector = new VmReconcileSweepSelector();
  const visited: string[] = [], admitted: string[] = [];
  const keys = ['bound-a', 'a', 'bound-b', 'b'];
  selector.admit(keys, 8, (key) => { visited.push(key); return !key.startsWith('bound'); }, (key) => { admitted.push(key); return true; });
  expect(visited).toEqual(keys);
  expect(admitted).toEqual(['a', 'b']);
});

it('retries the first rejected candidate after queue capacity recovers', () => {
  const selector = new VmReconcileSweepSelector();
  const first: string[] = [], second: string[] = [];
  selector.admit(['a', 'b', 'c'], 3, () => true, (key) => { first.push(key); return key !== 'b'; });
  selector.admit(['a', 'b', 'c'], 2, () => true, (key) => { second.push(key); return true; });
  expect(first).toEqual(['a', 'b']);
  expect(second).toEqual(['b', 'c']);
});

it('retains its logical position when earlier keys disappear', () => {
  const selector = new VmReconcileSweepSelector();
  selector.admit(['a', 'b', 'c', 'd'], 2, () => true, () => true);
  const admitted: string[] = [];
  selector.admit(['b', 'c', 'd', 'e'], 2, () => true, (key) => { admitted.push(key); return true; });
  expect(admitted).toEqual(['c', 'd']);
});

it('uses its index when the exact next key is deleted and includes appended candidates', () => {
  const selector = new VmReconcileSweepSelector();
  selector.admit(['a', 'b', 'c', 'd'], 2, () => true, () => true);
  const admitted: string[] = [];
  selector.admit(['a', 'b', 'd', 'e'], 2, () => true, (key) => { admitted.push(key); return true; });
  expect(admitted).toEqual(['d', 'e']);
});

it.each(['explicit', 'empty'])('resets after %s lifecycle reset', (kind) => {
  const selector = new VmReconcileSweepSelector();
  selector.admit(['a', 'b', 'c'], 2, () => true, () => true);
  if (kind === 'explicit') selector.reset();
  else selector.admit([], 2, () => true, () => true);
  const admitted: string[] = [];
  selector.admit(['a', 'b', 'c'], 1, () => true, (key) => { admitted.push(key); return true; });
  expect(admitted).toEqual(['a']);
});
