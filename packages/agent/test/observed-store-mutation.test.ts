import { describe, expect, it, vi } from 'vitest';
import { UnsupportedTripleStoreCapabilityError } from '@origintrail-official/dkg-storage';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';

describe('shared observed mutation exception ordering', () => {
  it('does not dispatch if begin throws', async () => {
    const failure = new Error('begin'); const work = vi.fn(async () => true);
    const execute = createObservedStoreMutation(() => {}, { begin: () => { throw failure; } });
    await expect(execute(work, Boolean, { everything: true }, 'update')).rejects.toBe(failure);
    expect(work).not.toHaveBeenCalled();
  });
  it('preserves invalidate-before-settle, including an invalidation exception', async () => {
    const failure = new Error('invalidate'); const settle = vi.fn();
    const execute = createObservedStoreMutation(() => { throw failure; }, { begin: () => settle });
    await expect(execute(async () => true, Boolean, { everything: true }, 'update')).rejects.toBe(failure);
    expect(settle).not.toHaveBeenCalled();
  });
  it('propagates one settlement exception without replay', async () => {
    const failure = new Error('settle'); const work = vi.fn(async () => true); const invalidate = vi.fn();
    const settle = vi.fn(() => { throw failure; });
    const execute = createObservedStoreMutation(invalidate, { begin: () => settle });
    await expect(execute(work, Boolean, { everything: true }, 'update')).rejects.toBe(failure);
    expect(work).toHaveBeenCalledOnce(); expect(invalidate).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith('changed');
  });
  it.each([true, false])('preserves unchanged/indeterminate error ordering (notStarted=%s)', async notStarted => {
    const failure = notStarted ? new UnsupportedTripleStoreCapabilityError('update', 'test') : new Error('response lost');
    const calls: string[] = [];
    const execute = createObservedStoreMutation(() => { calls.push('invalidate'); }, {
      begin: () => { calls.push('begin'); return outcome => { calls.push(outcome); }; },
    });
    await expect(execute(async () => { calls.push('work'); throw failure; }, Boolean, { everything: true }, 'update')).rejects.toBe(failure);
    expect(calls).toEqual(notStarted ? ['begin', 'work', 'unchanged'] : ['begin', 'work', 'invalidate', 'indeterminate']);
  });
});
