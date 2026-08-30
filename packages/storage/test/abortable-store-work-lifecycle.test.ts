import { describe, expect, it, vi } from 'vitest';
import {
  AbortableStoreWorkLifecycle,
  composeAbortSignals,
  raceStoreWorkAgainstAbort,
} from '../src/abortable-store-work-lifecycle.js';

function abortCalls(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([type]) => type === 'abort').length;
}

describe('AbortableStoreWorkLifecycle signal ownership', () => {
  it('races store work against abort and always removes its listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(raceStoreWorkAgainstAbort(Promise.resolve('done'), controller.signal))
      .resolves.toBe('done');
    expect(abortCalls(remove)).toBe(1);

    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(raceStoreWorkAgainstAbort(Promise.resolve('late'), controller.signal))
      .rejects.toBe(reason);
  });

  it('forwards the first abort reason and unlinks both source signals', () => {
    const caller = new AbortController();
    const generation = new AbortController();
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const generationRemove = vi.spyOn(generation.signal, 'removeEventListener');
    const scope = composeAbortSignals(caller.signal, generation.signal);
    const reason = new Error('caller disconnected');

    caller.abort(reason);

    expect(scope.signal?.aborted).toBe(true);
    expect(scope.signal?.reason).toBe(reason);
    expect(abortCalls(callerRemove)).toBe(1);
    expect(abortCalls(generationRemove)).toBe(1);
    scope.dispose();
    expect(abortCalls(callerRemove)).toBe(1);
    expect(abortCalls(generationRemove)).toBe(1);
  });

  it('balances listeners when completed operations dispose against a long-lived signal', () => {
    const generation = new AbortController();
    const generationAdd = vi.spyOn(generation.signal, 'addEventListener');
    const generationRemove = vi.spyOn(generation.signal, 'removeEventListener');

    for (let index = 0; index < 1_000; index++) {
      const caller = new AbortController();
      const scope = composeAbortSignals(caller.signal, generation.signal);
      expect(scope.signal?.aborted).toBe(false);
      scope.dispose();
    }

    expect(abortCalls(generationAdd)).toBe(1_000);
    expect(abortCalls(generationRemove)).toBe(1_000);
  });

  it('disposes the composed scope when tracked work settles', async () => {
    const caller = new AbortController();
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const lifecycle = new AbortableStoreWorkLifecycle();

    await expect(lifecycle.run(caller.signal, async () => 'done')).resolves.toBe('done');
    await Promise.resolve();

    expect(abortCalls(callerRemove)).toBe(1);
  });
});
