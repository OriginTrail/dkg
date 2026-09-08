import { afterEach, expect, it, vi } from 'vitest';
import { SwmExpiryCleanupWorker } from '../src/swm-expiry-cleanup-worker.js';
import type { SwmExpiryCleanupResult } from '../src/swm-expiry-cleanup.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());

it('joins manual and timer calls, then resumes with the latest TTL and continuation', async () => {
  vi.useFakeTimers();
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockReturnValueOnce(blocked.promise)
    .mockResolvedValue({ triplesDeleted: 7, budgetExhausted: false, nextMetaGraph: 'urn:third' });
  const worker = new SwmExpiryCleanupWorker(pass, 100, 10);
  worker.start();
  worker.start();
  const first = worker.runNow();
  expect(worker.runNow()).toBe(first);
  await vi.advanceTimersByTimeAsync(30);
  expect(pass).toHaveBeenCalledTimes(1);
  worker.setTtl(200);
  blocked.resolve({ triplesDeleted: 5, budgetExhausted: false, nextMetaGraph: 'urn:second' });
  expect(await first).toBe(5);
  await vi.advanceTimersByTimeAsync(10);
  expect(pass).toHaveBeenLastCalledWith(200, expect.any(Function), 'urn:second');
  expect(pass).toHaveBeenCalledTimes(2);
  worker.setTtl(0);
  expect(worker.running).toBe(false);
  expect(await worker.runNow()).toBe(0);
  await vi.advanceTimersByTimeAsync(50);
  expect(pass).toHaveBeenCalledTimes(2);
  worker.setTtl(300);
  await worker.runNow();
  expect(pass).toHaveBeenLastCalledWith(300, expect.any(Function), 'urn:third');
  await worker.stop();
  worker.setTtl(400);
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledTimes(3);
});

it('fences stop immediately but joins physical work before allowing a restart', async () => {
  const blocked = deferred<SwmExpiryCleanupResult>();
  let isClosed!: () => boolean;
  const pass = vi.fn<ConstructorParameters<typeof SwmExpiryCleanupWorker>[0]>()
    .mockImplementationOnce(async (_ttl, closed) => { isClosed = closed; return blocked.promise; })
    .mockResolvedValue({ triplesDeleted: 0, budgetExhausted: false });
  const worker = new SwmExpiryCleanupWorker(pass, 100);
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
  blocked.resolve({ triplesDeleted: 1, budgetExhausted: false, nextMetaGraph: 'urn:stale' });
  expect(await running).toBe(1);
  await stop;
  worker.start();
  await worker.runNow();
  expect(pass).toHaveBeenLastCalledWith(100, expect.any(Function), undefined);
  await worker.stop();
});

it('does not start queued storage work after stop', async () => {
  const pass = vi.fn().mockResolvedValue({ triplesDeleted: 0, budgetExhausted: false });
  const worker = new SwmExpiryCleanupWorker(pass, 100);
  const queued = worker.runNow();
  await worker.stop();
  expect(await queued).toBe(0);
  expect(pass).not.toHaveBeenCalled();
});

it('retires a rejected shared call and permits the next invocation to recover', async () => {
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn().mockReturnValueOnce(blocked.promise).mockResolvedValue({ triplesDeleted: 2, budgetExhausted: false });
  const worker = new SwmExpiryCleanupWorker(pass, 100);
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
  const worker = new SwmExpiryCleanupWorker(pass, 0, 10);
  worker.start();
  expect(worker.running).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  expect(pass).not.toHaveBeenCalled();
  worker.setTtl(100);
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
    return { triplesDeleted: deleted, budgetExhausted: remaining > 0 };
  });
  const worker = new SwmExpiryCleanupWorker(pass, 100, 900_000);
  worker.start();
  try {
    expect(await worker.runNow()).toBe(1000);
    expect(remaining).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(remaining).toBe(0);
    expect(pass).toHaveBeenCalledTimes(2);
  } finally { await worker.stop(); }
});


it.each(['disable', 'stop'])('cancels a pending backlog continuation on %s', async action => {
  vi.useFakeTimers();
  const pass = vi.fn().mockResolvedValue({ triplesDeleted: 1000, budgetExhausted: true });
  const worker = new SwmExpiryCleanupWorker(pass, 100, 900_000);
  worker.start();
  await worker.runNow();
  if (action === 'disable') worker.setTtl(0);
  else await worker.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledOnce();
  await worker.stop();
});

it('does not rearm a continuation when TTL is disabled during physical work', async () => {
  vi.useFakeTimers();
  const blocked = deferred<SwmExpiryCleanupResult>();
  const pass = vi.fn().mockReturnValueOnce(blocked.promise);
  const worker = new SwmExpiryCleanupWorker(pass, 100, 900_000);
  const running = worker.runNow();
  await Promise.resolve();
  worker.setTtl(0);
  blocked.resolve({ triplesDeleted: 1000, budgetExhausted: true });
  await running;
  await vi.advanceTimersByTimeAsync(100);
  expect(pass).toHaveBeenCalledOnce();
  await worker.stop();
});
