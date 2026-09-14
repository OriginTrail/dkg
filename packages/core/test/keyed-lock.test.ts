import { describe, expect, it } from 'vitest';
import { withKeyedLocks } from '../src/keyed-lock.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('withKeyedLocks', () => {
  it('serializes overlapping key sets without deadlocking reversed callers', async () => {
    const locks = new Map<string, Promise<void>>();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withKeyedLocks(locks, ['b', 'a', 'a'], async () => {
      order.push('first:start');
      firstEntered.resolve();
      await releaseFirst.promise;
      order.push('first:end');
    });
    await firstEntered.promise;

    const second = withKeyedLocks(locks, ['a', 'b'], async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(locks.size).toBe(0);
  });

  it('does not poison successors when a callback rejects', async () => {
    const locks = new Map<string, Promise<void>>();

    await expect(withKeyedLocks(locks, ['scope'], async () => {
      throw new Error('failed mutation');
    })).rejects.toThrow('failed mutation');

    await expect(withKeyedLocks(locks, ['scope'], async () => 'ok')).resolves.toBe('ok');
    expect(locks.size).toBe(0);
  });
});
