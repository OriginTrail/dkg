import { afterEach, expect, it, vi } from 'vitest';
import { SwmExpiryCleanupWorker } from '../src/swm-expiry-cleanup-worker.js';
import type { SwmExpiryCleanupContinuation, SwmExpiryCleanupResult } from '../src/swm-expiry-cleanup.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

const continuation: SwmExpiryCleanupContinuation = { remainingTargets: [{
  contextGraphId: 'test',
  dataGraph: 'urn:pending:data',
  metaGraph: 'urn:pending:meta',
  ownershipKey: 'test',
}] };

it('automatically schedules cleanup when TTL is enabled and cancels it when disabled', async () => {
  vi.useFakeTimers();
  const pass = vi.fn().mockResolvedValue({ triplesDeleted: 0 });
  let ttlMs = 0;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 10);
  worker.start();
  await vi.advanceTimersByTimeAsync(20);
  expect(pass).not.toHaveBeenCalled();
  ttlMs = 100; worker.onTtlChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(pass).toHaveBeenCalledOnce();
  ttlMs = 0; worker.onTtlChanged();
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledOnce();
  await worker.stop();
});

it('joins manual and timer calls, then resumes periodic maintenance with the latest TTL', async () => {
  vi.useFakeTimers();
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockReturnValueOnce(blocked.promise)
    .mockResolvedValue({ triplesDeleted: 7 });
  let ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 10);
  worker.start();
  worker.start();
  const first = worker.runNow();
  expect(worker.runNow()).toBe(first);
  await vi.advanceTimersByTimeAsync(30);
  expect(pass).toHaveBeenCalledTimes(1);
  ttlMs = 200; worker.onTtlChanged();
  blocked.resolve({ triplesDeleted: 5 });
  expect(await first).toBe(12);
  expect(pass).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10);
  expect(pass).toHaveBeenLastCalledWith(200, expect.any(Function), undefined, undefined);
  expect(pass).toHaveBeenCalledTimes(3);
  ttlMs = 0; worker.onTtlChanged();
  expect(worker.running).toBe(false);
  expect(await worker.runNow()).toBe(0);
  await vi.advanceTimersByTimeAsync(50);
  expect(pass).toHaveBeenCalledTimes(3);
  ttlMs = 300; worker.onTtlChanged();
  await worker.runNow();
  expect(pass).toHaveBeenLastCalledWith(300, expect.any(Function), undefined, expect.any(Number));
  await worker.stop();
  ttlMs = 400; worker.onTtlChanged();
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledTimes(4);
});

it('fences stop immediately but joins physical work before allowing a restart', async () => {
  const blocked = deferred<SwmExpiryCleanupResult>();
  let isClosed!: () => boolean;
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockImplementationOnce(async (_ttl, closed) => { isClosed = closed; return blocked.promise; })
    .mockResolvedValue({ triplesDeleted: 0 });
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs);
  worker.start();
  const running = worker.runNow();
  await Promise.resolve();
  expect(isClosed()).toBe(false);
  let stopped = false;
  const stop = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(isClosed()).toBe(true);
  expect(worker.running).toBe(false);
  expect(await worker.runNow()).toBe(0);
  expect(() => worker.start()).toThrow('still stopping');
  blocked.resolve({ triplesDeleted: 1, continuation });
  expect(await running).toBe(1);
  await stop;
  worker.start();
  await worker.runNow();
  expect(pass).toHaveBeenLastCalledWith(100, expect.any(Function), undefined, expect.any(Number));
  await worker.stop();
});

it('does not start queued storage work after stop', async () => {
  const pass = vi.fn().mockResolvedValue({ triplesDeleted: 0 });
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs);
  const queued = worker.runNow();
  await worker.stop();
  expect(await queued).toBe(0);
  expect(pass).not.toHaveBeenCalled();
});

it('retires a rejected shared call and permits the next invocation to recover', async () => {
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn().mockReturnValueOnce(blocked.promise).mockResolvedValue({ triplesDeleted: 2 });
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs);
  const first = worker.runNow();
  expect(worker.runNow()).toBe(first);
  const rejected = expect(first).rejects.toThrow('unavailable');
  blocked.reject(new Error('unavailable'));
  await rejected;
  expect(await worker.runNow()).toBe(2);
  await worker.stop();
});

it('starts disabled and safely retires failures from scheduled and stopping work', async () => {
  vi.useFakeTimers();
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn().mockRejectedValueOnce(new Error('startup failure'))
    .mockRejectedValueOnce(new Error('periodic failure')).mockReturnValueOnce(blocked.promise);
  let ttlMs = 0;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 10);
  worker.start();
  expect(worker.running).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  expect(pass).not.toHaveBeenCalled();
  ttlMs = 100; worker.onTtlChanged();
  await expect(worker.runNow()).rejects.toThrow('startup failure');
  await vi.advanceTimersByTimeAsync(10);
  expect(pass).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10);
  const stop = worker.stop();
  blocked.reject(new Error('stopping failure'));
  await expect(stop).resolves.toBeUndefined();
  expect(worker.running).toBe(false);
  await vi.advanceTimersByTimeAsync(30);
  expect(pass).toHaveBeenCalledTimes(3);
});


it('automatically drains a backlog in yielding bounded passes before the maintenance interval', async () => {
  vi.useFakeTimers();
  let remaining = 1001;
  const pass = vi.fn(async () => {
    const deleted = Math.min(1000, remaining);
    remaining -= deleted;
    return { triplesDeleted: deleted, continuation: remaining > 0 ? continuation : undefined };
  });
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 900_000);
  worker.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(remaining).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(remaining).toBe(0);
    expect(pass).toHaveBeenCalledTimes(2);
  } finally { await worker.stop(); }
});


it.each(['disable', 'stop'])('cancels a pending backlog continuation on %s', async action => {
  vi.useFakeTimers();
  const pass = vi.fn().mockResolvedValue({ triplesDeleted: 1000, continuation });
  let ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 900_000);
  worker.start();
  await vi.advanceTimersByTimeAsync(0);
  if (action === 'disable') { ttlMs = 0; worker.onTtlChanged(); }
  else await worker.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledOnce();
  await worker.stop();
});

it('does not rearm a continuation when TTL is disabled during physical work', async () => {
  vi.useFakeTimers();
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn().mockReturnValueOnce(blocked.promise);
  let ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 900_000);
  const running = worker.runNow();
  await Promise.resolve();
  ttlMs = 0; worker.onTtlChanged();
  blocked.resolve({ triplesDeleted: 1000, continuation });
  await running;
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledOnce();
  await worker.stop();
});


it('joins a periodic pass then completes the manual cutoff without detached work', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockReturnValueOnce(blocked.promise)
    .mockResolvedValue({ triplesDeleted: 2 });
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 900_000);
  worker.start();
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 1000);
  const cutoff = Date.now() - 100;
  const manual = worker.runNow();
  blocked.resolve({ triplesDeleted: 3 });
  expect(await manual).toBe(5);
  expect(pass).toHaveBeenCalledTimes(2);
  expect(pass.mock.calls[1]![3]).toBe(cutoff);
  await worker.stop();
});

it('does not duplicate an identical manual request after promoting a queued periodic flight', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockReturnValueOnce(blocked.promise);
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 900_000);
  worker.start();
  vi.advanceTimersByTime(0);
  const first = worker.runNow();
  await Promise.resolve();
  expect(pass).toHaveBeenCalledOnce();
  const joined = worker.runNow();
  expect(joined).toBe(first);

  blocked.resolve({ triplesDeleted: 3 });
  expect(await joined).toBe(3);
  expect(pass).toHaveBeenCalledOnce();
  await worker.stop();
});

it('runs a fresh manual sweep when TTL shortens during an active manual drain', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockReturnValueOnce(blocked.promise)
    .mockResolvedValue({ triplesDeleted: 7 });
  let ttlMs = 48 * 60 * 60 * 1000;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs);
  const first = worker.runNow();
  await Promise.resolve();
  ttlMs = 60 * 60 * 1000; worker.onTtlChanged();
  const newerCutoff = Date.now() - 60 * 60 * 1000;
  const second = worker.runNow();
  expect(second).toBe(first);

  blocked.resolve({ triplesDeleted: 3 });

  expect(await second).toBe(10);
  expect(pass).toHaveBeenCalledTimes(2);
  expect(pass.mock.calls[1]![3]).toBe(newerCutoff);
  await worker.stop();
});

it('starts a fresh sweep when a manual request upgrades a queued periodic continuation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockResolvedValueOnce({ triplesDeleted: 1, continuation })
    .mockResolvedValue({ triplesDeleted: 2 });
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 900_000);
  worker.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledOnce();
    // Fire the timer synchronously, before its promised physical work starts.
    vi.advanceTimersByTime(10);
    expect(await worker.runNow()).toBe(2);
    expect(pass).toHaveBeenLastCalledWith(100, expect.any(Function), undefined, expect.any(Number));
  } finally { await worker.stop(); }
});

it('pins the public cutoff across yielding passes and does not schedule before start', async () => {
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockResolvedValueOnce({ triplesDeleted: 5, continuation })
    .mockResolvedValue({ triplesDeleted: 2 });
  const ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs);
  expect(await worker.runNow()).toBe(7);
  expect(pass.mock.calls[0]![3]).toBe(pass.mock.calls[1]![3]);
  expect(worker.running).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(pass).toHaveBeenCalledTimes(2);
  await worker.stop();
});

it.each(['manual', 'periodic'] as const)('fences TTL changes even when the value changes back during a %s pass', async mode => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const blocked = deferred<SwmExpiryCleanupResult>();
  const restarted = deferred<void>();
  let closed!: () => boolean;
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockImplementationOnce(async (_ttl, isClosed) => { closed = isClosed; return blocked.promise; })
    .mockImplementationOnce(async () => { restarted.resolve(); return { triplesDeleted: 2 }; });
  let ttlMs = 100;
  const worker = new SwmExpiryCleanupWorker(pass, () => ttlMs, 10);
  let completion: Promise<number> | undefined;
  if (mode === 'manual') { completion = worker.runNow(); await Promise.resolve(); }
  else { worker.start(); await vi.advanceTimersByTimeAsync(0); }
  try {
    expect(closed()).toBe(false);
    ttlMs = 200; worker.onTtlChanged();
    const conservativeCutoff = Date.now() - ttlMs;
    ttlMs = 100; worker.onTtlChanged();
    expect(closed()).toBe(true);
    // Neither the changed configuration nor repeated starts admit a second
    // physical pass while the cancelled storage work remains in flight.
    expect(pass).toHaveBeenCalledOnce();
    blocked.resolve({ triplesDeleted: 1, continuation });
    await restarted.promise;
    if (completion) expect(await completion).toBe(3);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(pass.mock.calls[1]!.slice(2)).toEqual([undefined, mode === 'manual' ? conservativeCutoff : undefined]);
  } finally { blocked.resolve({ triplesDeleted: 0 }); await worker.stop(); }
});
