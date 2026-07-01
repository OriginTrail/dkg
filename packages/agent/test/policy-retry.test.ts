/**
 * #1404 — coverage for the resolver-level bounded retry primitive
 * `retryTransientPolicyStateRead` that the publish access-policy probe consumes.
 * A single CHAIN_POLICY_READ_TIMEOUT_MS miss on a slow chain RPC fails closed to
 * 'unknown'; this retry turns a TRANSIENT unknown/throw into a CONFIRMED policy
 * while preserving fail-closed on genuine unavailability. Without this, a
 * regression that stopped retrying, retried confirmed states, or stopped failing
 * closed after all attempts would pass silently.
 */
import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

type PolicyState = 0 | 1 | 'unregistered' | 'unknown';

// The primitive only touches `this.log.warn` (and only on the UNKNOWN-retry log
// path), so a minimal fake `this` is sufficient to exercise it in isolation.
function fakeAgent() {
  return { log: { warn: () => {} } } as unknown as DKGAgent;
}
const retry = (DKGAgent.prototype as unknown as {
  retryTransientPolicyStateRead: (
    this: unknown,
    read: () => Promise<PolicyState>,
    opCtx?: unknown,
    opts?: { attempts?: number; backoffMs?: (n: number) => number; logLabel?: string },
  ) => Promise<PolicyState>;
}).retryTransientPolicyStateRead;
// Collapse the backoff so the test never actually waits.
const fast = { attempts: 3, backoffMs: () => 0 };

describe('retryTransientPolicyStateRead — #1404 bounded transient-UNKNOWN retry', () => {
  it('recovers: transient UNKNOWN then confirmed PUBLIC (0) — read called twice', async () => {
    const read = vi.fn<[], Promise<PolicyState>>()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce(0);
    const state = await retry.call(fakeAgent(), read, undefined, fast);
    expect(state).toBe(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('recovers: transient THROW then confirmed PRIVATE (1) — read called twice', async () => {
    const read = vi.fn<[], Promise<PolicyState>>()
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce(1);
    const state = await retry.call(fakeAgent(), read, undefined, fast);
    expect(state).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('confirmed on the first read returns immediately — no extra attempts', async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockResolvedValue(0);
    const state = await retry.call(fakeAgent(), read, undefined, fast);
    expect(state).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("'unregistered' is a confirmed (non-retryable) state — one attempt", async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockResolvedValue('unregistered');
    const state = await retry.call(fakeAgent(), read, undefined, fast);
    expect(state).toBe('unregistered');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('all attempts UNKNOWN → stays UNKNOWN (caller fails closed); read called `attempts` times', async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockResolvedValue('unknown');
    // Pass a truthy opCtx to also exercise the retry-warn log branch.
    const state = await retry.call(fakeAgent(), read, { operationId: 'test' }, fast);
    expect(state).toBe('unknown');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('all attempts THROW → rejects on the final throw (caller catches → fails closed)', async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockRejectedValue(new Error('rpc down'));
    await expect(retry.call(fakeAgent(), read, undefined, fast)).rejects.toThrow('rpc down');
    expect(read).toHaveBeenCalledTimes(3);
  });
});
