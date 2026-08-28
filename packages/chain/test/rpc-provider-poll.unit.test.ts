// SPDX-License-Identifier: Apache-2.0

/**
 * PR #2373 r4 (3881841032 / 3881841018) — the all-provider polling primitive's own lifecycle:
 * transient retry policy, deterministic fast path, and the abort-listener hygiene that repeated
 * polls against ONE long-lived signal depend on. The unanimity/currency decisions it feeds are
 * proven where they live (ka-version-snapshot.unit.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { readAllProvidersWithTransientRetry } from '../src/rpc-provider-poll.js';
import { isContractViewRetryable } from '../src/rpc-failover-client.js';

function countingSignal() {
  let listeners = 0;
  const signal = {
    aborted: false,
    addEventListener: () => { listeners += 1; },
    removeEventListener: () => { listeners -= 1; },
  } as unknown as AbortSignal;
  return { signal, count: () => listeners };
}

describe('readAllProvidersWithTransientRetry', () => {
  it('a successful poll leaves NO listener on the caller-owned signal — across repeated polls', async () => {
    const { signal, count } = countingSignal();
    for (let i = 0; i < 5; i += 1) {
      const result = await readAllProvidersWithTransientRetry(
        [{} as never],
        async () => 'view',
        { retryDelayMs: 1, isRetryable: isContractViewRetryable, signal },
      );
      expect(result).toEqual(['view']);
    }
    expect(count()).toBe(0);
  });

  it('retries a transient failure once per endpoint and settles the slot null past the budget', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const transient = () => Object.assign(new Error('blip'), { code: 'SERVER_ERROR' });
    const result = await readAllProvidersWithTransientRetry(
      [{ id: 1 } as never, { id: 2 } as never],
      async (provider) => {
        if ((provider as { id: number }).id === 1) {
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
      [{} as never],
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
      [{} as never],
      async () => { calls += 1; return 'view'; },
      { retryDelayMs: 1, isRetryable: isContractViewRetryable, signal: AbortSignal.abort() },
    );
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});
