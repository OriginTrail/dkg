import { syncBuiltinESMExports } from 'node:module';
import timersPromises, { setTimeout as nativeDelay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeRpcRequestContext,
  EVMChainAdapter,
  RpcRequestGovernor,
} from '@origintrail-official/dkg-chain';
import { PublisherStartupAdmission } from '../src/publisher-startup-admission.js';

describe('transaction-free publisher startup admission', () => {
  const budgets: PublisherStartupAdmission[] = [];
  const adapters: EVMChainAdapter[] = [];
  afterEach(() => {
    for (const budget of budgets.splice(0)) budget.dispose();
    for (const adapter of adapters.splice(0)) adapter.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
    syncBuiltinESMExports();
  });
  function budget(parent?: AbortSignal) {
    const result = new PublisherStartupAdmission(parent);
    budgets.push(result);
    return result;
  }

  /**
   * A wallet's chain adapter before its first use, with the Hub boundary
   * scripted: every binding the adapter resolves is one `hubRead`. The
   * initialization the wallet read waits for is production code.
   */
  function uninitializedAdapter(hubRead: () => Promise<void>) {
    const address = '0x0000000000000000000000000000000000000001';
    const adapter: any = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      hubAddress: address,
      chainId: 'evm:31337',
      allowNoAdminSigner: true,
    });
    adapters.push(adapter);
    const binding = async () => {
      await hubRead();
      return { target: address, getAddress: async () => address };
    };
    vi.spyOn(adapter, 'resolveContract').mockImplementation(binding);
    vi.spyOn(adapter, 'resolveAssetStorage').mockImplementation(binding);
    vi.spyOn(adapter, 'resolveAndAssignRandomSamplingPair').mockImplementation(binding);
    vi.spyOn(adapter, 'readContract').mockResolvedValue(7n);
    vi.spyOn(adapter, 'startChainIndexRuntime').mockImplementation(() => {});
    vi.spyOn(adapter, 'startHubRotationListener').mockResolvedValue(undefined);
    adapter.tokenAddress = address;
    return adapter as EVMChainAdapter;
  }

  function usePromiseFakeClock() {
    vi.useFakeTimers();
    // Vitest's global clock does not drive this worker's native promise timer.
    // Bridge only the API used here, then refresh production's static ESM import.
    // Native-timer tests below separately pin real retry and AbortError behavior.
    vi.spyOn(timersPromises, 'setTimeout').mockImplementation(
      <T = void>(ms = 1, value?: T, options: { signal?: AbortSignal; ref?: boolean } = {}) =>
        new Promise<T>((resolve, reject) => {
          const { signal } = options;
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(Object.assign(new Error('The operation was aborted', { cause: signal?.reason }), {
              name: 'AbortError', code: 'ABORT_ERR',
            }));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve(value as T);
          }, ms);
          if (options.ref === false) timer.unref?.();
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        }),
    );
    syncBuiltinESMExports();
  }

  it.each([
    new Error('wrong chain'),
    { code: 'RPC_TIMEOUT' },
    { code: 'RPC_ENDPOINTS_EXHAUSTED' },
    { code: 'INSUFFICIENT_FUNDS' },
    { cause: { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' } },
  ])('does not retry errors outside the exact local-capacity boundary: %o', async (error) => {
    const read = vi.fn().mockRejectedValue(error);
    await expect(budget().readIdentity(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('permits serial wallets to exceed a minute while each keeps progressing', async () => {
    vi.useFakeTimers();
    const startup = budget();
    for (let wallet = 1; wallet <= 3; wallet++) {
      const pending = startup.readIdentity(() => new Promise<bigint>((resolve) => {
        setTimeout(() => resolve(BigInt(wallet)), 40_000);
      }));
      const resolved = expect(pending).resolves.toBe(BigInt(wallet));
      await vi.advanceTimersByTimeAsync(40_000);
      await resolved;
    }
  });

  it('permits a valid low-rate small-burst wallet read that progresses beyond a minute', async () => {
    vi.useFakeTimers();
    const governor = new RpcRequestGovernor({ maxRequestsPerSecond: 0.1, burstRequests: 1 });
    const pending = budget().readIdentity(async () => {
      for (let request = 0; request < 9; request++) {
        await governor.acquireActiveRequest();
        activeRpcRequestContext().onProgress?.();
      }
      return 1n;
    });
    const resolved = expect(pending).resolves.toBe(1n);
    await vi.advanceTimersByTimeAsync(80_000);
    await resolved;
    expect(governor.snapshot().foregroundAdmitted).toBe(9);
    expect(governor.snapshot().maxRequestsPerSecond).toBe(0.1);
  });

  it('permits a wallet read that waits for a low-rate adapter initialization progressing beyond a minute', async () => {
    vi.useFakeTimers();
    const governor = new RpcRequestGovernor({ maxRequestsPerSecond: 0.1, burstRequests: 1 });
    const adapter = uninitializedAdapter(async () => {
      // One governed request for each binding, reported as the transport
      // reports a request that has succeeded.
      await governor.acquireActiveRequest();
      activeRpcRequestContext().onProgress?.();
    });
    const pending = budget().readIdentity(() => adapter.getIdentityId());
    const resolved = expect(pending).resolves.toBe(7n);
    await vi.advanceTimersByTimeAsync(300_000);
    await resolved;
    // More requests than one inactivity bound admits at this rate.
    expect(governor.snapshot().foregroundAdmitted).toBeGreaterThan(7);
  });

  it('bounds inactivity while the adapter initialization it waits for stalls, and ends that initialization', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let ended: unknown;
    const adapter = uninitializedAdapter(() => new Promise<void>((resolve, reject) => {
      const { signal, onProgress } = activeRpcRequestContext();
      // Three bindings answer 20 seconds apart. The fourth never does.
      if (++reads <= 3) {
        setTimeout(() => { onProgress?.(); resolve(); }, 20_000);
        return;
      }
      signal!.addEventListener('abort', () => {
        ended = signal!.reason;
        reject(signal!.reason);
      }, { once: true });
    }));
    const startup = budget();
    const pending = startup.readIdentity(() => adapter.getIdentityId());
    const rejected = expect(pending).rejects.toThrow('60000ms');
    // The last answer came at 60 seconds: the bound runs from there.
    await vi.advanceTimersByTimeAsync(119_999);
    expect(startup.assertActive()).toBeUndefined();
    expect(ended).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(4);
    // Nobody waits for the initialization any more: it was ended too.
    expect(ended).toBeInstanceOf(Error);
    expect((ended as Error).message).toContain('no active waiters');
  });

  it('bounds inactivity after earlier progress and cancels the queued read', async () => {
    vi.useFakeTimers();
    const startup = budget();
    const read = vi.fn(() => new Promise<bigint>((_resolve, reject) => {
      const { signal, onProgress } = activeRpcRequestContext();
      setTimeout(() => onProgress?.(), 30_000);
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const pending = startup.readIdentity(read);
    const rejected = expect(pending).rejects.toThrow('60000ms');
    await vi.advanceTimersByTimeAsync(89_999);
    expect(startup.assertActive()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each(['inactivity', 'shutdown'] as const)('settles a signal-ignoring read on %s and observes late rejection', async (cause) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const startup = budget(parent.signal);
    const shutdownReason = new Error('stop the publisher bootstrap');
    let rejectRead!: (error: Error) => void;
    const read = vi.fn(() => new Promise<bigint>((_resolve, reject) => { rejectRead = reject; }));
    let outcome: unknown;
    const pending = startup.readIdentity(read).catch(error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(0);
    if (cause === 'shutdown') parent.abort(shutdownReason);
    else await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    try {
      if (cause === 'shutdown') expect(outcome).toBe(shutdownReason);
      else expect(outcome).toBeInstanceOf(Error);
      if (cause === 'inactivity') expect((outcome as Error).message).toContain('60000ms');
      expect(read).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      // Release the deliberately noncooperating operation even on the red run.
      rejectRead(new Error('late physical read failure'));
      await pending;
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds persistent capacity refusal and cancels the backoff without another read', async () => {
    usePromiseFakeClock();
    const read = vi.fn().mockRejectedValue({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const startup = budget();
    const outcome = startup.readIdentity(read).catch(error => error as Error);
    try {
      await vi.advanceTimersByTimeAsync(999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(await outcome).toMatchObject({
        message: 'Publisher wallet bootstrap made no RPC progress for 60000ms',
      });
      expect(read).toHaveBeenCalledTimes(60);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(read).toHaveBeenCalledTimes(60);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      startup.dispose();
      await outcome;
    }
  });

  it('retries once after one second and hands off the successful identity', async () => {
    usePromiseFakeClock();
    const read = vi.fn()
      .mockRejectedValueOnce({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' })
      .mockResolvedValue(7n);
    const pending = budget().readIdentity(read);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toBe(7n);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also retries using the unmodified native promise timer', async () => {
    const read = vi.fn()
      .mockRejectedValueOnce({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' })
      .mockResolvedValue(9n);
    const pending = budget().readIdentity(read);
    await nativeDelay(0);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe(9n);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('ignores a retired wallet progress callback while the next wallet stalls', async () => {
    vi.useFakeTimers();
    const startup = budget();
    let oldProgress: (() => void) | undefined;
    await startup.readIdentity(async () => {
      oldProgress = activeRpcRequestContext().onProgress;
      return 1n;
    });
    const pending = startup.readIdentity(() => new Promise<bigint>((_resolve, reject) => {
      const signal = activeRpcRequestContext().signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const rejected = expect(pending).rejects.toThrow('60000ms');
    await vi.advanceTimersByTimeAsync(50_000);
    oldProgress!();
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    oldProgress!();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts backoff immediately on shutdown', async () => {
    const parent = new AbortController();
    const reason = new Error('shutdown');
    const read = vi.fn().mockRejectedValue({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const pending = budget(parent.signal).readIdentity(read);
    const rejected = expect(pending).rejects.toBe(reason);
    // Use a real event-loop turn: the rejection must already have entered the
    // native promise delay, whose AbortError differs from fake-timer behavior.
    await nativeDelay(0);
    parent.abort(reason);
    await rejected;
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not invoke a read when startup was already cancelled', async () => {
    const parent = new AbortController();
    const reason = new Error('shutdown');
    parent.abort(reason);
    const read = vi.fn();
    await expect(budget(parent.signal).readIdentity(read)).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not invoke a scheduled read after synchronous shutdown', async () => {
    const parent = new AbortController();
    const reason = new Error('shutdown before the read microtask');
    const read = vi.fn().mockResolvedValue(1n);
    const pending = budget(parent.signal).readIdentity(read);
    parent.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
  });

  it('disposes the transient signal and timer after bootstrap handoff', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const startup = budget(parent.signal);
    let inherited: AbortSignal | undefined;
    await startup.readIdentity(async () => {
      inherited = activeRpcRequestContext().signal;
      return 1n;
    });
    startup.dispose();
    parent.abort(new Error('later shutdown is owned by runtime.stop'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(inherited).toBeDefined();
    expect(inherited!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
