// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { readRpcTuple, withRpcResponseStallScope } from '../src/rpc-read-lifecycle.js';
import { readFirstProviderWithTransientRetry } from '../src/rpc-provider-fallback.js';
import {
  activeRpcRequestAbortSignal,
  activeRpcRequestContext,
  withRpcRequestContext,
  type RpcRequestContext,
} from '../src/rpc-request-transport.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const failure = () => Object.assign(new Error('pinned call refused'), { code: 'CALL_EXCEPTION' });
const capacity = () => Object.assign(new Error('local queue is full'), { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
const outcome = <T>(promise: Promise<T>) => promise.then(
  value => ({ value }),
  (error: unknown) => ({ error }),
);
function untilAborted(contexts: RpcRequestContext[], cancelled: unknown[]): Promise<never> {
  const context = activeRpcRequestContext(), signal = activeRpcRequestAbortSignal()!;
  contexts.push(context);
  return new Promise<never>((_resolve, reject) => {
    const onAbort = () => { cancelled.push(signal.reason); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

describe('RPC read lifecycle', () => {
  it('settles a typed tuple in slot order and retires only its child owner', async () => {
    const caller = new AbortController(), policy = { timeoutMs: 100 };
    const onProgress = vi.fn(), contexts: RpcRequestContext[] = [];
    const first = deferred<string>(), second = deferred<number>();
    const pending = withRpcRequestContext({
      signal: caller.signal, requestClass: 'background', admissionPriority: 'authority',
      onProgress, responseStallPolicy: policy,
    }, () => readRpcTuple<[string, number]>([
      () => { contexts.push(activeRpcRequestContext()); return first.promise; },
      () => { contexts.push(activeRpcRequestContext()); return second.promise; },
    ]));
    await Promise.resolve();
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({
      requestClass: 'background', admissionPriority: 'authority', onProgress, responseStallPolicy: policy,
    });
    expect(contexts[0].signal).toBe(contexts[1].signal);
    expect(contexts[0].signal).not.toBe(caller.signal);
    second.resolve(7); first.resolve('root');
    await expect(pending).resolves.toEqual(['root', 7]);
    expect(contexts[0].signal!.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(activeRpcRequestContext().responseStallPolicy).toBeUndefined();
  });

  it('owns later siblings after a synchronous getter failure and waits for ordinary settlement', async () => {
    const error = failure(), sibling = deferred<string>();
    const read = vi.fn(() => sibling.promise);
    let settled = false;
    const pending = outcome(readRpcTuple<[string, string]>([
      () => { throw error; }, read,
    ])).then(result => { settled = true; return result; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    sibling.resolve('author');
    await expect(pending).resolves.toEqual({ error });
  });

  it('prioritizes original pressure over an earlier deterministic error and cancels all siblings', async () => {
    const error = failure(), pressure = capacity(), caller = new AbortController();
    const contexts: RpcRequestContext[] = [], cancelled: unknown[] = [];
    const pending = withRpcRequestContext({ signal: caller.signal }, () => readRpcTuple<[string, string, string]>([
      () => { throw error; },
      () => { throw pressure; },
      () => untilAborted(contexts, cancelled),
    ]));
    await expect(pending).rejects.toBe(pressure);
    expect(cancelled).toEqual([pressure]);
    expect(contexts[0].signal!.reason).toBe(pressure);
    expect(caller.signal.aborted).toBe(false);
  });

  it('pressure ends the provider pass even with a permissive transient retry classifier', async () => {
    const pressure = capacity(), caller = new AbortController();
    const attempts: string[] = [], observed: unknown[] = [];
    const contexts: RpcRequestContext[] = [], cancelled: unknown[] = [];
    const result = await readFirstProviderWithTransientRetry(['primary', 'fallback'], async (provider) => {
      attempts.push(provider);
      try {
        return await readRpcTuple<[string, string, string]>([
          () => { throw failure(); },
          () => { throw pressure; },
          () => untilAborted(contexts, cancelled),
        ]);
      } catch (error) { observed.push(error); throw error; }
    }, { signal: caller.signal, retryDelayMs: 1, isRetryable: () => true });
    expect(result).toBeNull();
    expect(attempts).toEqual(['primary']);
    expect(observed).toEqual([pressure]);
    expect(cancelled).toEqual([pressure]);
    expect(caller.signal.aborted).toBe(false);
  });

  it.each(['direct', 'nested'] as const)('invokes no lazy getter from an already-aborted %s caller context', async (entry) => {
    const caller = new AbortController(), reason = new Error('caller already left');
    caller.abort(reason);
    const getter = vi.fn(async () => 'root');
    const run = () => readRpcTuple<[string]>([getter]);
    const pending = withRpcRequestContext({ signal: caller.signal }, () => (
      entry === 'direct' ? run() : withRpcRequestContext({}, run)
    ));
    await expect(pending).rejects.toBe(reason);
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not invoke a scheduled lazy getter after inherited cancellation', async () => {
    const caller = new AbortController(), reason = new Error('caller left before getter invocation');
    const getter = vi.fn(async () => 'root');
    const pending = withRpcRequestContext({ signal: caller.signal }, () => readRpcTuple<[string]>([getter]));
    caller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(getter).not.toHaveBeenCalled();
  });

  it('propagates inherited in-flight cancellation and settles siblings before returning', async () => {
    const caller = new AbortController(), reason = new Error('caller left in flight');
    const contexts: RpcRequestContext[] = [], cancelled: unknown[] = [];
    const pending = outcome(withRpcRequestContext({ signal: caller.signal }, () => (
      withRpcRequestContext({}, () => readRpcTuple<[string, string]>([
        () => untilAborted(contexts, cancelled), () => untilAborted(contexts, cancelled),
      ]))
    )));
    await Promise.resolve();
    expect(contexts).toHaveLength(2);
    caller.abort(reason);
    await expect(pending).resolves.toEqual({ error: reason });
    expect(cancelled).toEqual([reason, reason]);
  });

  it('checks inherited cancellation before invoking a response-scope callback', async () => {
    const caller = new AbortController(), reason = new Error('response waiter already left');
    caller.abort(reason);
    const read = vi.fn(async () => 'view');
    const pending = withRpcRequestContext({ signal: caller.signal }, () => withRpcResponseStallScope(100, read));
    await expect(pending).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
  });

  it('a response stall retires endpoint and tuple siblings while preserving its caller', async () => {
    const caller = new AbortController();
    const timeout = Object.assign(new Error('physical response stalled'), { code: 'RPC_TIMEOUT' });
    const contexts: RpcRequestContext[] = [], cancelled: unknown[] = [];
    let trigger!: () => void;
    const pending = outcome(withRpcRequestContext({ signal: caller.signal }, () => withRpcResponseStallScope(100, async () => {
      const policy = activeRpcRequestContext().responseStallPolicy!;
      trigger = () => policy.onTimeout!(timeout);
      return readRpcTuple<[string, string]>([
        () => untilAborted(contexts, cancelled), () => untilAborted(contexts, cancelled),
      ]);
    })));
    await Promise.resolve();
    expect(contexts).toHaveLength(2);
    trigger();
    await expect(pending).resolves.toEqual({ error: timeout });
    expect(cancelled).toEqual([timeout, timeout]);
    expect(caller.signal.aborted).toBe(false);
  });
});
