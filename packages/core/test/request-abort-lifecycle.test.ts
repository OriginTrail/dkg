import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startRequestAbortLifecycle } from '../src/request-abort-lifecycle.js';

/** Size of Node's internal `AbortSignal.any` dependant set on `signal` (0 if absent). */
function dependantCount(signal: AbortSignal): number {
  const symbol = Object.getOwnPropertySymbols(signal).find((s) => s.description === 'kDependantSignals');
  const set = symbol ? (signal as unknown as Record<symbol, Set<unknown> | undefined>)[symbol] : undefined;
  return set?.size ?? 0;
}

describe('startRequestAbortLifecycle (#2812)', () => {
  it('aborts the request signal and the deadline with a TimeoutError when the deadline passes', async () => {
    const lifecycle = startRequestAbortLifecycle(20, []);
    expect(lifecycle.signal.aborted).toBe(false);

    await vi.waitFor(() => expect(lifecycle.signal.aborted).toBe(true), { timeout: 1_000, interval: 5 });

    expect(lifecycle.deadline.aborted).toBe(true);
    expect((lifecycle.signal.reason as Error).name).toBe('TimeoutError');
    expect(lifecycle.signal.reason).toBe(lifecycle.deadline.reason);
    lifecycle.release();
  });

  it('follows a linked signal with its reason, without touching the deadline', () => {
    const caller = new AbortController();
    const lifecycle = startRequestAbortLifecycle(60_000, [caller.signal]);
    const reason = new Error('caller cancelled');

    caller.abort(reason);

    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.signal.reason).toBe(reason);
    expect(lifecycle.deadline.aborted).toBe(false);
    lifecycle.release();
  });

  it('adds one listener per linked signal, no AbortSignal.any dependants, and removes them on release', () => {
    const caller = new AbortController();
    const stop = new AbortController();
    const lifecycle = startRequestAbortLifecycle(60_000, [caller.signal, undefined, stop.signal]);

    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(1);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(1);
    expect(dependantCount(caller.signal) + dependantCount(stop.signal)).toBe(0);

    lifecycle.release();
    lifecycle.release();

    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    stop.abort(new Error('node stopping'));
    expect(lifecycle.signal.aborted).toBe(false);
  });

  it('keeps its deadline after release, as AbortSignal.timeout did', async () => {
    const stop = new AbortController();
    const lifecycle = startRequestAbortLifecycle(20, [stop.signal]);

    lifecycle.release();

    await vi.waitFor(() => expect(lifecycle.signal.aborted).toBe(true), { timeout: 1_000, interval: 5 });
    expect((lifecycle.signal.reason as Error).name).toBe('TimeoutError');
  });

  it('aborts at once for an already-aborted linked signal, and the first such signal wins', () => {
    const caller = new AbortController();
    const stop = new AbortController();
    const callerReason = new Error('caller cancelled');
    caller.abort(callerReason);
    stop.abort(new Error('node stopping'));

    const lifecycle = startRequestAbortLifecycle(60_000, [caller.signal, stop.signal]);

    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.signal.reason).toBe(callerReason);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
    lifecycle.release();
  });
});
