// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3098 — ordered endpoint fallback, bounded retry, and cancellation at the
 * helper that produces the snapshot transport policy. Provider doubles prove
 * orchestration; rpc-provider-fallback-transport proves physical HTTP isolation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFirstProviderWithTransientRetry } from '../src/rpc-provider-fallback.js';
import { isContractViewRetryable } from '../src/rpc-failover-client.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import {
  activeRpcRequestContext,
  withRpcRequestContext,
} from '../src/rpc-request-transport.js';

const options = { retryDelayMs: 1, isRetryable: isContractViewRetryable };
const transient = () => Object.assign(new Error('temporary RPC failure'), { code: 'SERVER_ERROR' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A real signal ledger: removing a different callback cannot hide a leak. */
function ledgeredSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const registered = new Set<EventListenerOrEventListenerObject>();
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, opts) => {
    if (type === 'abort' && listener) registered.add(listener);
    return realAdd(type as 'abort', listener, opts);
  });
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, opts) => {
    if (type === 'abort' && listener && registered.has(listener)) registered.delete(listener);
    return realRemove(type as 'abort', listener, opts);
  });
  return { controller, signal, outstanding: () => registered.size };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readFirstProviderWithTransientRetry', () => {
  it('returns the primary result without starting either unused fallback', async () => {
    const attempts: string[] = [];
    const result = await readFirstProviderWithTransientRetry(
      ['primary', 'fallback1', 'fallback2'],
      async (provider) => { attempts.push(provider); return 'primary view'; },
      options,
    );
    expect({ result, attempts }).toEqual({ result: 'primary view', attempts: ['primary'] });
  });

  it.each([false, 0, ''])('accepts a non-null result %j without searching for a positive answer', async (value) => {
    const read = vi.fn(async () => value);
    await expect(readFirstProviderWithTransientRetry(['primary', 'fallback'], read, options))
      .resolves.toBe(value);
    expect(read).toHaveBeenCalledOnce();
  });

  it('waits for each failed endpoint before starting the next, in configured order', async () => {
    const primary = deferred<string | null>();
    const attempts: string[] = [];
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback1', 'fallback2'],
      async (provider) => {
        attempts.push(provider);
        return provider === 'primary' ? primary.promise : 'fallback view';
      },
      options,
    );
    await Promise.resolve();
    expect(attempts).toEqual(['primary']);
    primary.resolve(null);
    await expect(result).resolves.toBe('fallback view');
    expect(attempts).toEqual(['primary', 'fallback1']);
  });

  it.each(['CALL_EXCEPTION', 'BAD_DATA'])('does not retry deterministic %s before trying the next endpoint', async (code) => {
    const attempts: string[] = [];
    const result = await readFirstProviderWithTransientRetry(
      ['primary', 'fallback1', 'fallback2'],
      async (provider) => {
        attempts.push(provider);
        if (provider !== 'fallback2') throw Object.assign(new Error('unusable pinned state'), { code });
        return 'fallback2 view';
      },
      options,
    );
    expect({ result, attempts }).toEqual({
      result: 'fallback2 view', attempts: ['primary', 'fallback1', 'fallback2'],
    });
  });

  it('retries one transient blip in place and leaves the fallback untouched', async () => {
    vi.useFakeTimers();
    const attempts: string[] = [];
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback'],
      async (provider) => {
        attempts.push(provider);
        if (attempts.length === 1) throw transient();
        return 'recovered primary';
      },
      options,
    );
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('recovered primary');
    expect(attempts).toEqual(['primary', 'primary']);
  });

  it('exhausts exactly one transient retry on an endpoint before progressing', async () => {
    vi.useFakeTimers();
    const attempts: string[] = [];
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback1', 'fallback2'],
      async (provider) => {
        attempts.push(provider);
        if (provider === 'primary') throw transient();
        if (provider === 'fallback1') return null;
        return 'last view';
      },
      options,
    );
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('last view');
    expect(attempts).toEqual(['primary', 'primary', 'fallback1', 'fallback2']);
  });

  it('returns null when every configured endpoint has failed or returned no usable view', async () => {
    const attempts: string[] = [];
    const result = await readFirstProviderWithTransientRetry(
      ['primary', 'fallback1', 'fallback2'],
      async (provider) => {
        attempts.push(provider);
        if (provider === 'fallback1') throw Object.assign(new Error('bad tuple'), { code: 'BAD_DATA' });
        return null;
      },
      options,
    );
    expect({ result, attempts }).toEqual({
      result: null, attempts: ['primary', 'fallback1', 'fallback2'],
    });
  });

  it('returns null without invoking a reader when no endpoints are configured', async () => {
    const read = vi.fn(async () => 'view');
    await expect(readFirstProviderWithTransientRetry([], read, options)).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('stops the whole call on local capacity pressure without retrying or touching a backup', async () => {
    const read = vi.fn(async () => { throw new RpcRequestGovernorQueueFullError(1); });
    await expect(readFirstProviderWithTransientRetry(['primary', 'fallback'], read, options))
      .resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it('removes the exact caller abort listener after repeated successful reads', async () => {
    const { signal, outstanding } = ledgeredSignal();
    for (let i = 0; i < 5; i += 1) {
      await expect(readFirstProviderWithTransientRetry(
        ['primary', 'fallback'], async () => 'view', { ...options, signal },
      )).resolves.toBe('view');
      expect(outstanding()).toBe(0);
    }
  });

  it('an already-aborted caller starts no endpoint', async () => {
    const read = vi.fn(async () => 'view');
    await expect(readFirstProviderWithTransientRetry(
      ['primary', 'fallback'], read, { ...options, signal: AbortSignal.abort() },
    )).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('an already-aborted inherited signal starts no endpoint even without explicit options', async () => {
    const read = vi.fn(async () => 'view');
    const result = withRpcRequestContext({ signal: AbortSignal.abort() }, () =>
      readFirstProviderWithTransientRetry(['primary', 'fallback'], read, options));
    await expect(result).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('an in-flight caller abort settles a proven-started stalled read without starting a fallback', async () => {
    const { controller, signal, outstanding } = ledgeredSignal();
    const started = deferred<void>();
    const attempts: string[] = [];
    let attemptSignal: AbortSignal | undefined;
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback'],
      (provider, effectiveSignal) => {
        attempts.push(provider);
        attemptSignal = effectiveSignal;
        started.resolve();
        return new Promise<never>(() => {});
      },
      { ...options, signal },
    );
    await started.promise;
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(attemptSignal?.aborted).toBe(true);
    expect(attempts).toEqual(['primary']);
    expect(outstanding()).toBe(0);
  });

  it.each(['inherited', 'explicit'] as const)('composes %s cancellation into the attempt signal and transport context', async (cancel) => {
    const inherited = new AbortController();
    const explicit = new AbortController();
    const started = deferred<void>();
    let attemptSignal: AbortSignal | undefined;
    const attempts: string[] = [];
    const result = withRpcRequestContext({
      signal: inherited.signal, requestClass: 'background', admissionPriority: 'authority',
    }, () => readFirstProviderWithTransientRetry(
      ['primary', 'fallback'],
      (provider, effectiveSignal) => {
        attempts.push(provider);
        attemptSignal = effectiveSignal;
        expect(activeRpcRequestContext()).toMatchObject({
          signal: effectiveSignal, requestClass: 'background', admissionPriority: 'authority',
        });
        started.resolve();
        return new Promise<never>(() => {});
      },
      { ...options, signal: explicit.signal },
    ));
    await started.promise;
    (cancel === 'inherited' ? inherited : explicit).abort();
    await expect(result).resolves.toBeNull();
    expect(attemptSignal?.aborted).toBe(true);
    expect(attempts).toEqual(['primary']);
  });

  it('an abort during retry backoff prevents both the retry and every fallback', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempts: string[] = [];
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback'],
      async (provider) => { attempts.push(provider); throw transient(); },
      { ...options, retryDelayMs: 5_000, signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(attempts).toEqual(['primary']);
    controller.abort();
    await expect(result).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual(['primary']);
  });

  it('caps the whole hung multi-RPC endpoint at four seconds and aborts it before fallback', async () => {
    vi.useFakeTimers();
    const attempts: string[] = [];
    let primarySignal: AbortSignal | undefined;
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback'],
      (provider, signal) => {
        attempts.push(provider);
        if (provider === 'primary') {
          primarySignal = signal;
          return new Promise<never>(() => {});
        }
        expect(primarySignal?.aborted).toBe(true);
        return Promise.resolve('fallback view');
      },
      options,
    );
    await vi.advanceTimersByTimeAsync(3_999);
    expect(attempts).toEqual(['primary']);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('fallback view');
    expect(attempts).toEqual(['primary', 'fallback']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual(['primary', 'fallback']);
  });

  it('times out retry backoff as part of the endpoint budget, with no detached late retry', async () => {
    vi.useFakeTimers();
    const attempts: string[] = [];
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback'],
      async (provider) => {
        attempts.push(provider);
        if (provider === 'primary') throw transient();
        return 'fallback view';
      },
      { ...options, retryDelayMs: 5_000 },
    );
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(result).resolves.toBe('fallback view');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual(['primary', 'fallback']);
  });

  it('gives delayed endpoint stages the expired signal so they cannot issue late reads', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const lateReads: string[] = [];
    let primarySignal: AbortSignal | undefined;
    const result = readFirstProviderWithTransientRetry(
      ['primary', 'fallback'],
      async (provider, signal) => {
        if (provider === 'fallback') return 'fallback view';
        primarySignal = signal;
        await gate.promise;
        signal?.throwIfAborted();
        lateReads.push(provider);
        return 'late primary view';
      },
      options,
    );
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(result).resolves.toBe('fallback view');
    expect(primarySignal?.aborted).toBe(true);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lateReads).toEqual([]);
  });

  it('retains uncapped single-endpoint policy beyond the multi-RPC timeout', async () => {
    vi.useFakeTimers();
    const gate = deferred<string>();
    let settled = false;
    const result = readFirstProviderWithTransientRetry(
      ['only'], () => gate.promise, options,
    ).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(settled).toBe(false);
    gate.resolve('single view');
    await expect(result).resolves.toBe('single view');
  });
});
