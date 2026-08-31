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
  it('shares one abort race for pre-abort, registration races, rejection, and late cleanup', async () => {
    const preAborted = new AbortController();
    const preAbortReason = new Error('already stopped');
    preAborted.abort(preAbortReason);
    const lateCleanup = vi.fn();
    await expect(raceStoreWorkAgainstAbort(
      Promise.resolve('late'),
      preAborted.signal,
      { onLateResult: lateCleanup },
    )).rejects.toBe(preAbortReason);
    await Promise.resolve();
    expect(lateCleanup).toHaveBeenCalledWith('late');

    const registrationRace = new AbortController();
    const registrationRemove = vi.spyOn(registrationRace.signal, 'removeEventListener');
    const add = registrationRace.signal.addEventListener.bind(registrationRace.signal);
    vi.spyOn(registrationRace.signal, 'addEventListener').mockImplementation((...args) => {
      add(...args);
      registrationRace.abort(new Error('registration race'));
    });
    await expect(raceStoreWorkAgainstAbort(
      new Promise<string>(() => {}),
      registrationRace.signal,
    )).rejects.toThrow('registration race');
    expect(abortCalls(registrationRemove)).toBe(1);

    const normal = new AbortController();
    const normalRemove = vi.spyOn(normal.signal, 'removeEventListener');
    await expect(raceStoreWorkAgainstAbort(
      Promise.resolve('done'),
      normal.signal,
    )).resolves.toBe('done');
    expect(abortCalls(normalRemove)).toBe(1);

    const rejected = new AbortController();
    const rejectedRemove = vi.spyOn(rejected.signal, 'removeEventListener');
    const failure = new Error('backend failed');
    await expect(raceStoreWorkAgainstAbort(
      Promise.reject(failure),
      rejected.signal,
    )).rejects.toBe(failure);
    expect(abortCalls(rejectedRemove)).toBe(1);

    let resolveLate!: (value: string) => void;
    const lateWork = new Promise<string>((resolve) => { resolveLate = resolve; });
    const cancelled = new AbortController();
    const cancelledRemove = vi.spyOn(cancelled.signal, 'removeEventListener');
    const cleanup = vi.fn();
    const raced = raceStoreWorkAgainstAbort(lateWork, cancelled.signal, {
      onLateResult: cleanup,
    });
    cancelled.abort(new Error('cancelled'));
    await expect(raced).rejects.toThrow('cancelled');
    resolveLate('owned-resource');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanup).toHaveBeenCalledWith('owned-resource');
    expect(abortCalls(cancelledRemove)).toBe(1);
  });

  it('observes a late work rejection after pre-abort', async () => {
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    let rejectWork!: (cause: unknown) => void;
    const work = new Promise<never>((_resolve, reject) => {
      rejectWork = reject;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (cause: unknown) => unhandled.push(cause);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(raceStoreWorkAgainstAbort(work, controller.signal)).rejects.toBe(reason);
      rejectWork(new Error('late store failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('consumes synchronous and asynchronous late-result cleanup failures', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (cause: unknown) => unhandled.push(cause);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const onLateResult of [
        () => { throw new Error('synchronous cleanup failure'); },
        async () => { throw new Error('asynchronous cleanup failure'); },
      ]) {
        let resolveWork!: (value: string) => void;
        const work = new Promise<string>((resolve) => { resolveWork = resolve; });
        const controller = new AbortController();
        const reason = new Error('cancelled');
        const raced = raceStoreWorkAgainstAbort(work, controller.signal, { onLateResult });
        controller.abort(reason);
        await expect(raced).rejects.toBe(reason);
        resolveWork('late resource');
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('owns deadline cleanup and consumes work that settles after timeout', async () => {
    let rejectWork!: (cause: unknown) => void;
    const work = new Promise<never>((_resolve, reject) => {
      rejectWork = reject;
    });
    const timeout = new Error('bounded wait expired');
    const unhandled: unknown[] = [];
    const onUnhandled = (cause: unknown) => unhandled.push(cause);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(raceStoreWorkAgainstAbort(work, undefined, {
        timeoutMs: 5,
        timeoutError: () => timeout,
      })).rejects.toBe(timeout);
      rejectWork(new Error('late store failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
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
