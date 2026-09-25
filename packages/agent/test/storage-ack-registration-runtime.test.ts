import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageACKRegistrationRuntime } from '../src/p2p/storage-ack-registration-runtime.js';
import type { StorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';

function endpoint(): StorageACKEndpoint & { dispose: ReturnType<typeof vi.fn> } {
  return { dispatch: vi.fn(async () => new Uint8Array([1])), dispose: vi.fn() };
}

afterEach(() => vi.useRealTimers());

describe('StorageACK registration session', () => {
  it('blocks teardown after a non-cooperative registration exceeds the drain deadline', async () => {
    vi.useFakeTimers();
    const runtime = new StorageACKRegistrationRuntime();
    const session = runtime.begin();
    const staleEndpoint = endpoint();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const starting = session.start({
      attempt: async () => {
        entered();
        await gate;
        return { kind: 'registered', endpoint: staleEndpoint } as const;
      },
      retryDelayMs: 1_000,
      isStarted: () => true,
      onError: vi.fn(),
      onRetryScheduled: vi.fn(),
    });
    await inside;
    let finished = false;
    const drained = runtime.closeAndDrain().then(
      () => { finished = true; return undefined; },
      (error: unknown) => { finished = true; return error; },
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const drainError = await drained;
    expect(drainError).toBeInstanceOf(Error);
    expect((drainError as Error).message).toMatch(/teardown blocked/);
    expect(runtime.endpoint).toBeNull();
    release();
    await starting;
    expect(staleEndpoint.dispose).toHaveBeenCalledOnce();
    expect(runtime.endpoint).toBeNull();
  });

  it('fences an old sender and drains its non-cooperative work after a new session begins', async () => {
    const runtime = new StorageACKRegistrationRuntime();
    const firstSession = runtime.begin();
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const work = new Promise<Uint8Array>((resolve) => { release = () => resolve(new Uint8Array([1])); });
    firstSession.install({ dispatch: () => { entered(); return work; }, dispose: vi.fn() });
    const oldSend = runtime.createLocalSender();
    const first = oldSend('self', PROTOCOL_STORAGE_ACK, new Uint8Array([1]), 1_000)
      .catch((error: unknown) => error);
    await inside;
    runtime.begin();
    expect(() => oldSend('self', PROTOCOL_STORAGE_ACK, new Uint8Array([1]), 1_000))
      .toThrow(/transport is closed/);
    let drained = false;
    const stopping = runtime.closeAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(await first).toBeInstanceOf(Error);
    release();
    await stopping;
    expect(drained).toBe(true);
  });

  it('retries transient signer failover until one replacement owns the endpoint', async () => {
    vi.useFakeTimers();
    const runtime = new StorageACKRegistrationRuntime();
    const session = runtime.begin();
    const first = endpoint();
    const replacement = endpoint();
    const attempt = vi.fn(async (options: { repairWallets?: boolean }, phase: string) => {
      if (phase === 'initial') {
        return { kind: 'registered', endpoint: first } as const;
      }
      expect(options.repairWallets).toBe(false);
      if (phase === 'failover') throw new Error('chain temporarily unavailable');
      if (attempt.mock.calls.filter(([, callPhase]) => callPhase === 'retry').length === 1) {
        return { kind: 'retryable' } as const;
      }
      return { kind: 'registered', endpoint: replacement } as const;
    });
    const onError = vi.fn();
    const onRetryScheduled = vi.fn();
    await session.start({
      attempt,
      retryDelayMs: 1_000,
      isStarted: () => true,
      onError,
      onRetryScheduled,
    });
    expect(runtime.endpoint).toBe(first);
    expect(session.signerLost(first)).toBe(true);
    expect(session.signerLost(first)).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(runtime.endpoint).toBeNull();
    expect(onError).toHaveBeenCalledWith('failover', expect.any(Error));
    expect(onRetryScheduled).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.endpoint).toBeNull();
    expect(onRetryScheduled).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.endpoint).toBe(replacement);
    expect(attempt.mock.calls.map(([, phase]) => phase)).toEqual(['initial', 'failover', 'retry', 'retry']);
    expect(replacement.dispose).not.toHaveBeenCalled();
    await runtime.closeAndDrain();
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });
});
