import { describe, expect, it, vi } from 'vitest';
import { UnsupportedTripleStoreCapabilityError } from '@origintrail-official/dkg-storage';
import { createObservedStoreMutation, observeStoreMutations } from '../src/internal/observed-store-mutation.js';

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


describe('operation-scoped mutation observation', () => {
  it('distinguishes changed writes from read-only and unchanged work', async () => {
    const execute = createObservedStoreMutation(() => {});
    await expect(observeStoreMutations(() => execute(async () => 0, n => n > 0)))
      .resolves.toEqual({ result: 0, mutated: false });
    await expect(observeStoreMutations(() => execute(async () => 1, n => n > 0)))
      .resolves.toEqual({ result: 1, mutated: true });
  });
  it('keeps indeterminate writes dirty even when their error is handled', async () => {
    const execute = createObservedStoreMutation(() => {});
    const result = await observeStoreMutations(async () => {
      await execute(async () => { throw new Error('response lost'); }, Boolean, { everything: true }, 'update').catch(() => {});
    });
    expect(result.mutated).toBe(true);
  });
  it('isolates concurrent operations and propagates nested writes to their parent', async () => {
    const execute = createObservedStoreMutation(() => {});
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const clean = observeStoreMutations(async () => { await held; return 'read-only'; });
    const dirty = await observeStoreMutations(() => observeStoreMutations(() => execute(async () => true, Boolean)));
    release();
    expect(dirty.mutated).toBe(true);
    expect((await clean).mutated).toBe(false);
  });
});
