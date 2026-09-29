import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeRpcRequestContext, RpcRequestGovernor } from '@origintrail-official/dkg-chain';
import { PublisherStartupAdmission } from '../src/publisher-startup-admission.js';

describe('transaction-free publisher startup admission', () => {
  const budgets: PublisherStartupAdmission[] = [];
  afterEach(() => {
    for (const budget of budgets.splice(0)) budget.dispose();
    vi.useRealTimers();
  });
  function budget(parent?: AbortSignal) {
    const result = new PublisherStartupAdmission(parent);
    budgets.push(result);
    return result;
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

  it('bounds persistent capacity refusal and cancels the backoff without another read', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const pending = budget().readIdentity(read);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(read).toHaveBeenCalledTimes(1);
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
    const read = vi.fn().mockRejectedValue({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const pending = budget(parent.signal).readIdentity(read);
    const rejected = expect(pending).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    parent.abort(new Error('shutdown'));
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
