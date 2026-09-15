import { describe, expect, it, vi } from 'vitest';
import {
  RpcRequestGovernor,
  withRpcRequestContext,
} from '@origintrail-official/dkg-chain';
import { Rfc64BackgroundWorkDispatcherV1 } from
  '../src/rfc64/background-work-dispatcher-v1.js';

describe('Rfc64BackgroundWorkDispatcherV1', () => {
  it('preserves foreground priority for awaited work and owns scheduled background priority', async () => {
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    const governor = new RpcRequestGovernor({
      maxRequestsPerSecond: 100,
      foregroundReservePercent: 50,
      burstRequests: 2,
      maxQueueSize: 8,
      startupJitterMs: 0,
    });

    await dispatcher.runAwaited(async () => {
      await governor.acquireActiveRequest();
    });
    dispatcher.scheduleKeyed('responsibility\0cg', async () => {
      await governor.acquireActiveRequest();
    });
    await dispatcher.whenIdle();

    expect(governor.snapshot()).toMatchObject({
      foregroundAdmitted: 1,
      backgroundAdmitted: 1,
    });
  });

  it('coalesces repeated keyed notifications into one follow-up pass', async () => {
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = vi.fn(async () => gate);

    expect(dispatcher.scheduleKeyed('responsibility\0cg', work)).toBe(true);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    dispatcher.scheduleKeyed('responsibility\0cg', work);
    dispatcher.scheduleKeyed('responsibility\0cg', work);
    release();
    await dispatcher.whenIdle();

    expect(work).toHaveBeenCalledTimes(2);
  });

  it('starts a successor for a notification accepted at runner settlement', async () => {
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const work = vi.fn(async () => {
      if (work.mock.calls.length === 1) await gate;
    });

    expect(dispatcher.scheduleKeyed('responsibility\0cg', work)).toBe(true);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    gate.then(() => {
      expect(dispatcher.scheduleKeyed('responsibility\0cg', work)).toBe(true);
    });
    release();
    await dispatcher.whenIdle();

    expect(work).toHaveBeenCalledTimes(2);
  });

  it('does not return idle before a settled keyed entry is released', async () => {
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    const work = vi.fn(async () => undefined);

    expect(dispatcher.scheduleKeyed('responsibility\0cg', work)).toBe(true);
    // Enter the deterministic gap where the work body has settled but its
    // keyed owner has not yet run cleanup.
    await Promise.resolve();
    await Promise.resolve();
    expect(work).toHaveBeenCalledOnce();

    // This accepted notification belongs to the successor handoff. The idle
    // fence must observe and drain that successor before returning.
    expect(dispatcher.scheduleKeyed('responsibility\0cg', work)).toBe(true);
    await dispatcher.whenIdle();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('reports an ordinary keyed failure once and remains schedulable', async () => {
    const onError = vi.fn();
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1(onError);
    const failure = new Error('responsibility failed');

    dispatcher.scheduleKeyed('responsibility\0cg', async () => {
      throw failure;
    });
    await dispatcher.whenIdle();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('responsibility\0cg', failure);

    const recovered = vi.fn(async () => undefined);
    dispatcher.scheduleKeyed('responsibility\0cg', recovered);
    await dispatcher.whenIdle();
    expect(recovered).toHaveBeenCalledOnce();
  });

  it('composes caller cancellation for awaited work without attaching it to keyed detached work', async () => {
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    const caller = new AbortController();
    let awaitedSignal: AbortSignal | undefined;
    let detachedSignal: AbortSignal | undefined;

    await withRpcRequestContext({ signal: caller.signal }, async () => {
      await dispatcher.runAwaited(async (signal) => {
        awaitedSignal = signal;
      });
      dispatcher.scheduleKeyed('responsibility\0detached', async (signal) => {
        detachedSignal = signal;
      });
      await vi.waitFor(() => expect(detachedSignal).toBeDefined());
    });
    const reason = new Error('caller retired');
    caller.abort(reason);

    expect(awaitedSignal).toMatchObject({ aborted: true, reason });
    expect(detachedSignal?.aborted).toBe(false);
    await dispatcher.closeAndDrain();
    expect(detachedSignal?.aborted).toBe(true);
  });

  it('aborts queued owner work and drains without reporting cancellation as failure', async () => {
    const onError = vi.fn();
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1(onError);
    let observedSignal: AbortSignal | undefined;
    dispatcher.scheduleKeyed('responsibility\0cg', async (signal) => {
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await expect(dispatcher.closeAndDrain()).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
