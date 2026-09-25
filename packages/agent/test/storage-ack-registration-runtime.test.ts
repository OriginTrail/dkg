import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StorageACKRegistrationRuntime,
  shouldRepairACKWallets,
  type StorageACKRegistrationAttempt,
} from '../src/p2p/storage-ack-registration-runtime.js';
import type { StorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';

function endpoint(): StorageACKEndpoint & { dispose: ReturnType<typeof vi.fn> } {
  return { dispatch: vi.fn(() => {
    const response = Promise.resolve(new Uint8Array([1]));
    return { response, completion: response };
  }), dispose: vi.fn() };
}

afterEach(() => vi.useRealTimers());

describe('StorageACK registration session', () => {
  it('blocks teardown after a non-cooperative registration exceeds the drain deadline', async () => {
    vi.useFakeTimers();
    const runtime = new StorageACKRegistrationRuntime();
    const staleEndpoint = endpoint();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const starting = runtime.startGeneration({
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
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const work = new Promise<Uint8Array>((resolve) => { release = () => resolve(new Uint8Array([1])); });
    runtime.installFixtureEndpoint({ dispatch: () => { entered(); return { response: work, completion: work }; }, dispose: vi.fn() });
    const oldSend = runtime.createLocalSender();
    const localWork = (endpoint: StorageACKEndpoint, signal: AbortSignal) => endpoint.dispatch({
        protocol: PROTOCOL_STORAGE_ACK, data: new Uint8Array([1]), peerId: 'self', signal,
      });
    const first = oldSend(1_000, localWork)
      .catch((error: unknown) => error);
    await inside;
    runtime.retireCurrentGeneration();
    expect(() => oldSend(1_000, localWork))
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
    const first = endpoint();
    const replacement = endpoint();
    let firstSignerLost!: () => boolean;
    const attempt = vi.fn(async (command: StorageACKRegistrationAttempt,
      context: { signerLost(): boolean }) => {
      const phase = command.kind;
      if (phase === 'initial') {
        firstSignerLost = context.signerLost;
        return { kind: 'registered', endpoint: first } as const;
      }
      expect(shouldRepairACKWallets(command)).toBe(false);
      if (phase === 'failover') throw new Error('chain temporarily unavailable');
      if (attempt.mock.calls.filter(([call]) => call.kind === 'retry-failover').length === 1) {
        return { kind: 'retryable' } as const;
      }
      return { kind: 'registered', endpoint: replacement } as const;
    });
    const onError = vi.fn();
    const onRetryScheduled = vi.fn();
    await runtime.startGeneration({
      attempt,
      retryDelayMs: 1_000,
      isStarted: () => true,
      onError,
      onRetryScheduled,
    });
    expect(runtime.endpoint).toBe(first);
    expect(firstSignerLost()).toBe(true);
    expect(firstSignerLost()).toBe(false);
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
    expect(attempt.mock.calls.map(([call]) => call.kind))
      .toEqual(['initial', 'failover', 'retry-failover', 'retry-failover']);
    expect(replacement.dispose).not.toHaveBeenCalled();
    await runtime.closeAndDrain();
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });
});
