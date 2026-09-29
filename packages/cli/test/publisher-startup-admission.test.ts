import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeRpcRequestContext } from '@origintrail-official/dkg-chain';
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

  it('shares one deadline across wallets and cancels a queued read', async () => {
    vi.useFakeTimers();
    const startup = budget();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(startup.readIdentity(async () => 1n)).resolves.toBe(1n);
    const read = vi.fn(() => new Promise<bigint>((_resolve, reject) => {
      const signal = activeRpcRequestContext().signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const pending = startup.readIdentity(read);
    const rejected = expect(pending).rejects.toThrow('60000ms budget');
    await vi.advanceTimersByTimeAsync(30_000);
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

  it('removes the successful deadline without poisoning inherited poller context', async () => {
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
    expect(inherited!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
