// SPDX-License-Identifier: Apache-2.0

/**
 * PR #2373 r4/r5 (3881841032 / 3881841018 / 3882010456 / 3882010461 / 3882010465) — the
 * all-provider polling primitive's own lifecycle: transient retry policy, deterministic fast
 * path, the IN-FLIGHT abort race (a stalled provider must not hold the caller), and abort-
 * listener hygiene proven against a REAL AbortController signal with identity-checked
 * add/remove delegation — a count-balancing fake would accept removing the wrong listener.
 * The unanimity/currency decisions this feeds are proven where they live
 * (ka-version-snapshot.unit.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { readAllProvidersWithTransientRetry } from '../src/rpc-provider-poll.js';
import { isContractViewRetryable } from '../src/rpc-failover-client.js';

/**
 * A REAL AbortController signal whose add/removeEventListener are spied but fully delegated,
 * plus an identity ledger: removal only balances the ledger when it receives the EXACT callback
 * that was registered (EventTarget matching semantics — a wrapper function would leak).
 */
function ledgeredSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const registered = new Set<EventListenerOrEventListenerObject>();
  const realAdd = signal.addEventListener.bind(signal);
  const realRemove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, 'addEventListener').mockImplementation((type, listener, opts) => {
    if (type === 'abort' && listener) registered.add(listener);
    return realAdd(type as 'abort', listener, opts);
  });
  vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, opts) => {
    // Identity semantics: only a listener we actually hold is removed from the ledger.
    if (type === 'abort' && listener && registered.has(listener)) registered.delete(listener);
    return realRemove(type as 'abort', listener, opts);
  });
  return { controller, signal, outstanding: () => registered.size };
}

describe('readAllProvidersWithTransientRetry', () => {
  it('a successful poll removes EXACTLY the abort listener it registered — across repeated polls', async () => {
    const { signal, outstanding } = ledgeredSignal();
    for (let i = 0; i < 5; i += 1) {
      const result = await readAllProvidersWithTransientRetry(
        ['endpoint'],
        async () => 'view',
        { retryDelayMs: 1, isRetryable: isContractViewRetryable, signal },
      );
      expect(result).toEqual(['view']);
    }
    expect(outstanding()).toBe(0);
  });

  it('an abort AFTER polling has begun completes the call promptly, stalled provider and all', async () => {
    // r5 (3882010456) — the primary cancellation guarantee, non-vacuously: the provider is
    // proven STARTED and never resolves; the abort alone must complete the poll with null.
    // Deleting the Promise.race would leave this call pending forever.
    const { controller, signal, outstanding } = ledgeredSignal();
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const poll = readAllProvidersWithTransientRetry(
      ['stalled'],
      () => {
        started();
        return new Promise<never>(() => {});
      },
      { retryDelayMs: 1, isRetryable: isContractViewRetryable, signal },
    );
    await startedGate;
    controller.abort();
    await expect(poll).resolves.toBeNull();
    // The aborted completion path cleans its listener too ({once:true} fired it; the finally
    // removal of an already-fired listener must not corrupt the ledger).
    expect(outstanding()).toBe(0);
  });

  it('retries a transient failure once per endpoint and settles the slot null past the budget', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const transient = () => Object.assign(new Error('blip'), { code: 'SERVER_ERROR' });
    const result = await readAllProvidersWithTransientRetry(
      [{ id: 1 }, { id: 2 }],
      async (provider) => {
        if (provider.id === 1) {
          firstCalls += 1;
          if (firstCalls === 1) throw transient();
          return 'recovered-view';
        }
        secondCalls += 1;
        throw transient();
      },
      { retryDelayMs: 1, isRetryable: isContractViewRetryable },
    );
    expect(result).toEqual(['recovered-view', null]);
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(2);
  });

  it('a deterministic failure gets NO second ask', async () => {
    let calls = 0;
    const result = await readAllProvidersWithTransientRetry(
      ['endpoint'],
      async () => {
        calls += 1;
        throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
      },
      { retryDelayMs: 1, isRetryable: isContractViewRetryable },
    );
    expect(result).toEqual([null]);
    expect(calls).toBe(1);
  });

  it('an already-aborted signal never starts the poll', async () => {
    let calls = 0;
    const result = await readAllProvidersWithTransientRetry(
      ['endpoint'],
      async () => { calls += 1; return 'view'; },
      { retryDelayMs: 1, isRetryable: isContractViewRetryable, signal: AbortSignal.abort() },
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});
