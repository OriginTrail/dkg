import { describe, expect, it, vi } from 'vitest';
import {
  AbortableStoreWorkLifecycle,
  composeAbortSignals,
  raceStoreWorkAgainstAbort,
  type StoreWorkContext,
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
        timeout: {
          timeoutMs: 5,
          timeoutError: () => timeout,
        },
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

  // The raw close signal that `run()` used to hand to its callback is gone on
  // purpose: work that has to outlive its caller-facing promise now goes
  // through `context.runDetached`, which keeps it in the drain set. These tests
  // replace the one that asserted the raw close signal.
  describe('detached work', () => {
    /** A detached job that only stops when told to, and settles when released. */
    function slowDetached() {
      let release!: () => void;
      let closeSignal!: AbortSignal;
      const started = vi.fn();
      const start = (signal: AbortSignal) => {
        started();
        closeSignal = signal;
        return new Promise<string>((resolve) => { release = () => resolve('done'); });
      };
      return { start, started, release: () => release(), signal: () => closeSignal };
    }

    it('is not cancelled by the caller, and is aborted by close', async () => {
      const caller = new AbortController();
      const lifecycle = new AbortableStoreWorkLifecycle();
      const job = slowDetached();
      let context!: StoreWorkContext;
      let combined: AbortSignal | undefined;
      let finishOperation!: () => void;
      const operation = lifecycle.run(caller.signal, (signal, ctx) => {
        combined = signal;
        context = ctx;
        return new Promise<string>((resolve) => { finishOperation = () => resolve('caller-facing'); });
      });
      expect(context.callerSignal).toBe(caller.signal);

      const detached = context.runDetached(job.start);
      caller.abort(new Error('caller left'));
      // The operation's own signal follows its caller; the detached work does not.
      expect(combined?.aborted).toBe(true);
      expect(job.signal().aborted).toBe(false);
      finishOperation();
      await expect(operation).resolves.toBe('caller-facing');
      expect(job.signal().aborted).toBe(false);

      const closing = lifecycle.close(new Error('store closed'));
      expect(job.signal().aborted).toBe(true);
      expect((job.signal().reason as Error).message).toBe('store closed');
      job.release();
      await expect(detached).resolves.toBe('done');
      await closing;
    });

    it('keeps close pending until the detached work settles, though the operation already did', async () => {
      const lifecycle = new AbortableStoreWorkLifecycle();
      const job = slowDetached();
      let context!: StoreWorkContext;
      await lifecycle.run(undefined, (_signal, ctx) => {
        context = ctx;
        return Promise.resolve();
      });
      void context.runDetached(job.start);

      let closed = false;
      const closing = lifecycle.close(new Error('store closed')).then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(job.signal().aborted).toBe(true);
      expect(closed).toBe(false);

      job.release();
      await closing;
      expect(closed).toBe(true);
    });

    it('drops finished and failed detached work from the drain set', async () => {
      const lifecycle = new AbortableStoreWorkLifecycle();
      let context!: StoreWorkContext;
      await lifecycle.run(undefined, (_signal, ctx) => {
        context = ctx;
        return Promise.resolve();
      });
      await expect(context.runDetached(async () => 'ok')).resolves.toBe('ok');
      await expect(context.runDetached(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      // A synchronous throw is the same failure, delivered as a rejection.
      await expect(context.runDetached(() => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');

      // Nothing is left to wait for.
      await lifecycle.close(new Error('store closed'));
    });

    it('is refused, without starting, once the lifecycle is closing', async () => {
      const lifecycle = new AbortableStoreWorkLifecycle();
      const job = slowDetached();
      let context!: StoreWorkContext;
      let finishOperation!: () => void;
      const operation = lifecycle.run(undefined, (_signal, ctx) => {
        context = ctx;
        return new Promise<void>((resolve) => { finishOperation = resolve; });
      });
      const closing = lifecycle.close(new Error('store closed'));
      await expect(context.runDetached(job.start)).rejects.toThrow('store closed');
      expect(job.started).not.toHaveBeenCalled();
      finishOperation();
      await operation;
      await closing;
    });

    it('names a non-Error close reason when refusing', async () => {
      const lifecycle = new AbortableStoreWorkLifecycle();
      let context!: StoreWorkContext;
      await lifecycle.run(undefined, (_signal, ctx) => {
        context = ctx;
        return Promise.resolve();
      });
      await lifecycle.close('plain string reason' as unknown as Error);
      await expect(context.runDetached(async () => 'late')).rejects.toThrow('plain string reason');
    });
  });
});
