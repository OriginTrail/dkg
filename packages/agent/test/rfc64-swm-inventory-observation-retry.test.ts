import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rfc64SwmInventoryObservationRetryV1 } from '../src/rfc64/swm-inventory-observation-retry-v1.js';
import { Rfc64SwmInventoryShadowRuntimeV1, rfc64SwmInventoryAssetKeyV1 } from '../src/rfc64/swm-inventory-shadow-runtime-v1.js';

const write = { contextGraphId: 'cg', authorAddress: 'author', assertionCoordinate: 'asset' };
afterEach(() => vi.useRealTimers());

describe('process-owned inventory observation retry', () => {
  it('coalesces the exact operation synchronously but admits a different share', async () => {
    vi.useFakeTimers();
    const owner = new Rfc64SwmInventoryObservationRetryV1([10]);
    const signal = new AbortController().signal;
    const exhausted = vi.fn();
    const duplicate = vi.fn(async () => undefined);
    const first = vi.fn(async () => {
      owner.schedule('asset/share1', duplicate, signal, exhausted);
      return first.mock.calls.length === 1 ? 'retry-preparation-read' as const : undefined;
    });
    owner.schedule('asset/share1', first, signal, exhausted);
    owner.schedule('asset/share2', duplicate, signal, exhausted);
    expect(first).toHaveBeenCalledOnce();
    expect(duplicate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    await owner.drain();
    expect(first).toHaveBeenCalledTimes(2);
    expect(duplicate).toHaveBeenCalledOnce();
    expect(exhausted).not.toHaveBeenCalled();
    expect(owner.size).toBe(0);
  });

  it('bounds retries and reports exhaustion once, even when the diagnostic throws', async () => {
    vi.useFakeTimers();
    const owner = new Rfc64SwmInventoryObservationRetryV1([10, 20]);
    const attempt = vi.fn(async () => 'retry-preparation-read' as const);
    const exhausted = vi.fn(() => { throw new Error('logger failed'); });
    owner.schedule('a', attempt, new AbortController().signal, exhausted);
    await vi.advanceTimersByTimeAsync(30);
    await owner.drain();
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledExactlyOnceWith('attempts');
    expect(owner.size).toBe(0);
  });

  it('caps retry ownership without dropping an initial observation', async () => {
    vi.useFakeTimers();
    const owner = new Rfc64SwmInventoryObservationRetryV1([10], 1);
    const abort = new AbortController();
    const attempts = [vi.fn(async () => 'retry-preparation-read' as const), vi.fn(async () => 'retry-preparation-read' as const)];
    const exhausted = vi.fn();
    owner.schedule('a', attempts[0]!, abort.signal, exhausted);
    owner.schedule('b', attempts[1]!, abort.signal, exhausted);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.map((attempt) => attempt.mock.calls.length)).toEqual([1, 1]);
    expect(exhausted).toHaveBeenCalledExactlyOnceWith('capacity');
    abort.abort();
    await owner.drain();
    expect(owner.size).toBe(0);
  });

  it('does not retry an unexpected rejection', async () => {
    vi.useFakeTimers();
    const owner = new Rfc64SwmInventoryObservationRetryV1([10]);
    const attempt = vi.fn(async () => { throw new Error('indeterminate mutation'); });
    const exhausted = vi.fn();
    owner.schedule('a', attempt, new AbortController().signal, exhausted);
    await owner.drain();
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toHaveBeenCalledOnce();
    expect(exhausted).not.toHaveBeenCalled();
  });

  it('releases the asset, author barrier and all 16 execution slots during backoff', async () => {
    vi.useFakeTimers();
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    const attempt = vi.fn(async () => attempt.mock.calls.length === 1 ? 'retry-preparation-read' as const : undefined);
    runtime.scheduleInventoryObservation(write, 'share', attempt, vi.fn());
    expect(runtime.hasInventoryWrites(write)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.hasInventoryWrites(write)).toBe(false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered: number[] = [];
    const all = Array.from({ length: 16 }, (_, i) => runtime.runExclusive(
      i === 0 ? rfc64SwmInventoryAssetKeyV1(write) : `other-${i}`,
      async () => { entered.push(i); await gate; },
    ));
    expect(entered).toHaveLength(16);
    release();
    await Promise.all(all);
    await vi.advanceTimersByTimeAsync(100);
    await runtime.drain();
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(runtime.inFlightCount).toBe(0);
  });

  it('close cancels backoff, drains admitted work, and reopen cannot replay the old operation', async () => {
    vi.useFakeTimers();
    const runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    const attempt = vi.fn(async () => 'retry-preparation-read' as const);
    runtime.scheduleInventoryObservation(write, 'share', attempt, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    await runtime.closeAndDrain();
    expect(runtime.inFlightCount).toBe(0);
    expect(runtime.scheduleInventoryObservation(write, 'share', attempt, vi.fn())).toBe(false);
    runtime.reopen();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempt).toHaveBeenCalledOnce();
    const fresh = vi.fn(async () => undefined);
    expect(runtime.scheduleInventoryObservation(write, 'share', fresh, vi.fn())).toBe(true);
    await runtime.drain();
    expect(fresh).toHaveBeenCalledOnce();
  });
});
