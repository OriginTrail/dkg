import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBoundedOperationTimeoutError } from '../src/bounded-operation.js';
import { FinalizedAuthorityColdResolutionV1 } from
  '../src/finalized-authority-cold-resolution.js';

const REQUEST_MS = 2_500;
const COLD_MS = 20_000;

/**
 * A resolution that settles after `durationMs` unless its flight signal aborts
 * first; `Number.POSITIVE_INFINITY` never settles on its own.
 */
function slowResolution<T>(value: T, durationMs: number) {
  const signals: AbortSignal[] = [];
  let runs = 0;
  const start = (signal: AbortSignal): Promise<T> => {
    runs += 1;
    signals.push(signal);
    return new Promise<T>((resolve, reject) => {
      const timer = Number.isFinite(durationMs)
        ? setTimeout(() => resolve(value), durationMs)
        : undefined;
      signal.addEventListener('abort', () => {
        if (timer !== undefined) clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  };
  return { start, signals, runs: () => runs };
}

describe('finalized authority cold resolution single flight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds only the waiter and lets the flight complete for the next reader', async () => {
    vi.useFakeTimers();
    const coordinator = new FinalizedAuthorityColdResolutionV1({ coldTimeoutMs: () => COLD_MS });
    const resolution = slowResolution('snapshot', 10_000);

    const first = coordinator.read('graph:1', resolution.start, {
      label: 'readFinalizedContextGraphAuthority(1)',
      requestTimeoutMs: REQUEST_MS,
    }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(REQUEST_MS);
    const error = await first;
    expect(isBoundedOperationTimeoutError(error)).toBe(true);
    expect(error).toMatchObject({
      message: `readFinalizedContextGraphAuthority(1) timed out after ${REQUEST_MS}ms`,
    });
    // The request deadline never reached the flight.
    expect(resolution.signals[0]?.aborted).toBe(false);
    expect(coordinator.inFlightKeys).toEqual(['graph:1']);

    // A later reader attaches to the same flight instead of starting a scan.
    await vi.advanceTimersByTimeAsync(6_000);
    const second = coordinator.read('graph:1', resolution.start, {
      label: 'readFinalizedContextGraphAuthority(1)',
      requestTimeoutMs: REQUEST_MS,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(second).resolves.toBe('snapshot');
    expect(resolution.runs()).toBe(1);
    expect(coordinator.inFlightKeys).toEqual([]);
  });

  it('coalesces concurrent readers of one key and keeps keys independent', async () => {
    vi.useFakeTimers();
    const coordinator = new FinalizedAuthorityColdResolutionV1({ coldTimeoutMs: () => COLD_MS });
    const one = slowResolution('one', 1_000);
    const two = slowResolution('two', 1_000);

    const reads = Promise.all([
      coordinator.read('graph:1', one.start, { label: 'one', requestTimeoutMs: REQUEST_MS }),
      coordinator.read('graph:1', one.start, { label: 'one', requestTimeoutMs: REQUEST_MS }),
      coordinator.read('graph:2', two.start, { label: 'two', requestTimeoutMs: REQUEST_MS }),
    ]);
    expect(coordinator.inFlightKeys).toEqual(['graph:1', 'graph:2']);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reads).resolves.toEqual(['one', 'one', 'two']);
    expect(one.runs()).toBe(1);
    expect(two.runs()).toBe(1);
  });

  it('aborts the flight at the cold budget, never below the request deadline', async () => {
    vi.useFakeTimers();
    const coordinator = new FinalizedAuthorityColdResolutionV1({ coldTimeoutMs: () => COLD_MS });
    const hung = slowResolution('never', Number.POSITIVE_INFINITY);

    const first = coordinator.read('graph:1', hung.start, {
      label: 'cold',
      requestTimeoutMs: REQUEST_MS,
    }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(REQUEST_MS);
    expect(isBoundedOperationTimeoutError(await first)).toBe(true);
    await vi.advanceTimersByTimeAsync(COLD_MS - REQUEST_MS - 1);
    expect(hung.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hung.signals[0]?.aborted).toBe(true);
    expect(isBoundedOperationTimeoutError(hung.signals[0]?.reason)).toBe(true);
    expect(coordinator.inFlightKeys).toEqual([]);

    // A request explicitly allowed a long wait floors the flight budget.
    const patient = coordinator.read('graph:1', hung.start, {
      label: 'cold',
      requestTimeoutMs: COLD_MS * 2,
    }).catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(COLD_MS * 2 - 1);
    expect(hung.signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hung.signals[1]?.aborted).toBe(true);
    expect(isBoundedOperationTimeoutError(await patient)).toBe(true);
    expect(hung.runs()).toBe(2);
  });

  it('propagates a caller abort to that caller only', async () => {
    vi.useFakeTimers();
    const coordinator = new FinalizedAuthorityColdResolutionV1({ coldTimeoutMs: () => COLD_MS });
    const resolution = slowResolution('snapshot', 1_000);
    const controller = new AbortController();

    const aborted = coordinator.read('graph:1', resolution.start, {
      label: 'cold',
      requestTimeoutMs: REQUEST_MS,
      signal: controller.signal,
    }).catch((cause: unknown) => cause);
    controller.abort(new Error('caller stopped'));
    await expect(aborted).resolves.toMatchObject({ name: 'AbortError' });
    expect(resolution.signals[0]?.aborted).toBe(false);

    const other = coordinator.read('graph:1', resolution.start, {
      label: 'cold',
      requestTimeoutMs: REQUEST_MS,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(other).resolves.toBe('snapshot');
    expect(resolution.runs()).toBe(1);
    await expect(coordinator.read('graph:1', resolution.start, {
      label: 'cold',
      requestTimeoutMs: REQUEST_MS,
      signal: AbortSignal.abort(new Error('already gone')),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(resolution.runs()).toBe(1);
  });

  it('retires a failed flight so the next reader resolves afresh', async () => {
    const coordinator = new FinalizedAuthorityColdResolutionV1({ coldTimeoutMs: () => COLD_MS });
    let attempts = 0;
    const start = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('endpoints exhausted');
      return 'snapshot';
    };

    await expect(coordinator.read('graph:1', start, { label: 'cold', requestTimeoutMs: REQUEST_MS }))
      .rejects.toThrow('endpoints exhausted');
    await coordinator.whenIdle();
    await expect(coordinator.read('graph:1', start, { label: 'cold', requestTimeoutMs: REQUEST_MS }))
      .resolves.toBe('snapshot');
    expect(attempts).toBe(2);
  });

  it('closes every flight on shutdown and admits new flights only after reopen', async () => {
    vi.useFakeTimers();
    const coordinator = new FinalizedAuthorityColdResolutionV1({ coldTimeoutMs: () => COLD_MS });
    const resolution = slowResolution('snapshot', 5_000);

    const pending = coordinator.read('graph:1', resolution.start, {
      label: 'cold',
      requestTimeoutMs: REQUEST_MS,
    }).catch((cause: unknown) => cause);
    coordinator.close();
    expect(resolution.signals[0]?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
    await coordinator.whenIdle();
    await expect(coordinator.read('graph:1', resolution.start, {
      label: 'cold',
      requestTimeoutMs: REQUEST_MS,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(resolution.runs()).toBe(1);

    coordinator.reopen();
    const reopened = coordinator.read('graph:1', resolution.start, {
      label: 'cold',
      requestTimeoutMs: 6_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(reopened).resolves.toBe('snapshot');
    expect(resolution.runs()).toBe(2);
  });
});
