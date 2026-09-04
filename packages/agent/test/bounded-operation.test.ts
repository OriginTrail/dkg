import { describe, expect, it, vi } from 'vitest';
import {
  BoundedOperationTimeoutError,
  runBoundedOperation,
} from '../src/bounded-operation.js';

describe('runBoundedOperation', () => {
  it('does not start work when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    const start = vi.fn(async () => 'unreachable');

    await expect(runBoundedOperation(start, {
      label: 'pre-aborted read',
      timeoutMs: 100,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError', message: 'caller stopped' });
    expect(start).not.toHaveBeenCalled();
  });

  it('bounds non-cooperative work with a typed timeout', async () => {
    vi.useFakeTimers();
    try {
      let operationSignal: AbortSignal | undefined;
      const result = runBoundedOperation(
        (signal) => {
          operationSignal = signal;
          return new Promise<string>(() => undefined);
        },
        { label: 'hung read', timeoutMs: 25 },
      );
      const assertion = expect(result).rejects.toEqual(
        new BoundedOperationTimeoutError('hung read', 25),
      );
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(operationSignal?.aborted).toBe(true);
      expect(operationSignal?.reason).toEqual(
        new BoundedOperationTimeoutError('hung read', 25),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a caller abort while work is pending', async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const result = runBoundedOperation(
      (signal) => {
        operationSignal = signal;
        return new Promise<string>(() => undefined);
      },
      { label: 'aborted read', timeoutMs: 1_000, signal: controller.signal },
    );
    controller.abort('cancelled');

    await expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled' });
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBe('cancelled');
  });

  it('preserves dependency rejections', async () => {
    const dependencyError = new Error('RPC rejected');
    await expect(runBoundedOperation(
      async () => { throw dependencyError; },
      { label: 'failed read', timeoutMs: 100 },
    )).rejects.toBe(dependencyError);
  });
});
