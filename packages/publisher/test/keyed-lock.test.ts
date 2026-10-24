// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { tryWithKeyedLocks, withKeyedLocks } from '../src/keyed-lock.js';

it('installs all gates synchronously and refuses overlap without queuing work', async () => {
  const locks = new Map<string, Promise<void>>();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = tryWithKeyedLocks(locks, ['b', 'a', 'a'], async () => { await held; return 42; });
  expect([...locks.keys()]).toEqual(['a', 'b']);
  expect(locks.get('a')).toBe(locks.get('b'));
  const gates = [...locks]; const callback = vi.fn(async () => 0);
  try {
    expect(await tryWithKeyedLocks(locks, ['c', 'b'], callback)).toEqual({ acquired: false });
    expect([...locks]).toEqual(gates);
    expect(await tryWithKeyedLocks(locks, ['c'], async () => 'independent'))
      .toEqual({ acquired: true, value: 'independent' });
  } finally { release(); }
  expect(await first).toEqual({ acquired: true, value: 42 });
  expect(callback).not.toHaveBeenCalled(); expect(locks.size).toBe(0);
});

it('releases a failing acquisition and lets an ordinary queued writer proceed', async () => {
  const locks = new Map<string, Promise<void>>(); const failure = new Error('writer failed');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = tryWithKeyedLocks(locks, ['asset'], async () => { await held; throw failure; });
  const failed = expect(first).rejects.toBe(failure);
  let entered = false;
  const next = withKeyedLocks(locks, ['asset'], async () => { entered = true; return 'next'; });
  await Promise.resolve(); expect(entered).toBe(false);
  release(); await failed; expect(await next).toBe('next'); expect(locks.size).toBe(0);
  expect(await tryWithKeyedLocks(locks, ['asset'], async () => 'retry'))
    .toEqual({ acquired: true, value: 'retry' });
});
