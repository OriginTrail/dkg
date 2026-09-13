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
    }, () => undefined);
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

    expect(dispatcher.scheduleKeyed('responsibility\0cg', work, () => undefined)).toBe(true);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    dispatcher.scheduleKeyed('responsibility\0cg', work, () => undefined);
    dispatcher.scheduleKeyed('responsibility\0cg', work, () => undefined);
    release();
    await dispatcher.whenIdle();

    expect(work).toHaveBeenCalledTimes(2);
  });

  it('composes caller cancellation for awaited work without attaching it to detached work', async () => {
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    const caller = new AbortController();
    let awaitedSignal: AbortSignal | undefined;
    let detachedSignal: AbortSignal | undefined;

    await withRpcRequestContext({ signal: caller.signal }, async () => {
      await dispatcher.runAwaited(async (signal) => {
        awaitedSignal = signal;
      });
      await dispatcher.runBackground(async (signal) => {
        detachedSignal = signal;
      });
    });
    const reason = new Error('caller retired');
    caller.abort(reason);

    expect(awaitedSignal).toMatchObject({ aborted: true, reason });
    expect(detachedSignal?.aborted).toBe(false);
    await dispatcher.closeAndDrain();
    expect(detachedSignal?.aborted).toBe(true);
  });

  it('aborts queued owner work and drains without reporting cancellation as failure', async () => {
    const dispatcher = new Rfc64BackgroundWorkDispatcherV1();
    let observedSignal: AbortSignal | undefined;
    let rejected = 0;
    dispatcher.scheduleKeyed('responsibility\0cg', async (signal) => {
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }, () => { rejected += 1; });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await expect(dispatcher.closeAndDrain()).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(rejected).toBe(0);
  });
});
