/** Unit rows for the one lazy abort boundary (beside its module, r7 3877794566). */
import { describe, expect, it } from 'vitest';
import { resolveWithinAbort } from '../src/abort-boundary.js';

describe('resolveWithinAbort', () => {
  it('resolveWithinAbort: an already-aborted signal never launches the work', async () => {
    // r4 (3877695872) - the boundary is LAZY: pre-aborted means the resolver is not invoked at
    // all, not merely that its result is discarded.
    const controller = new AbortController();
    controller.abort();
    let launched = false;
    const out = await resolveWithinAbort(async () => { launched = true; return 'x'; }, controller.signal);
    expect(out).toBeNull();
    expect(launched).toBe(false);
  });

  it('resolveWithinAbort: the abort listener is removed when the work wins', async () => {
    // r4 (3877695872) - callers loop many candidates under one shared controller; a winner
    // must not leave its listener behind.
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const fakeSignal = {
      aborted: false,
      addEventListener: (_type: string, listener: unknown) => { added.push(listener); },
      removeEventListener: (_type: string, listener: unknown) => { removed.push(listener); },
    } as unknown as AbortSignal;
    const out = await resolveWithinAbort(async () => 'won', fakeSignal);
    expect(out).toBe('won');
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });
});
