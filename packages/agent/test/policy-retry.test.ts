/**
 * #1404 — coverage for the publish access-policy retry, in TWO layers:
 *
 *  1. `retryTransientPolicyState` — the small PURE module-level retry helper. A
 *     single CHAIN_POLICY_READ_TIMEOUT_MS miss on a slow chain RPC fails closed
 *     to 'unknown'; this turns a TRANSIENT unknown/throw into a CONFIRMED policy
 *     while preserving fail-closed on genuine unavailability. Tested directly
 *     (no `this`) so a regression that stopped retrying, retried confirmed
 *     states, or stopped failing closed after all attempts fails here.
 *
 *  2. `resolvePublishAccessPolicyState` — THE canonical policy operation publish
 *     calls. It owns read-SELECTION (raw on-chain slot vs the tri-state resolver)
 *     AND applies the retry, so publish can neither pick the wrong read nor skip
 *     the retry. Pinned so a refactor that split those apart (the old public
 *     higher-order retry primitive) can't silently return.
 *
 * These deliberately DO NOT override `attempts`: they run on the real
 * `POLICY_STATE_RETRY_ATTEMPTS` (only `backoffMs` is collapsed), so lowering the
 * production retry count is caught here — e.g. setting it to 1 makes the
 * transient-recovery cases fail (a single 'unknown' would no longer retry into a
 * confirmed 0/1, exactly the production publish regression we guard against).
 */
import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import { retryTransientPolicyState } from '../src/dkg-agent-crypto.js';
import { POLICY_STATE_RETRY_ATTEMPTS } from '../src/dkg-agent-constants.js';

type PolicyState = 0 | 1 | 'unregistered' | 'unknown';

// Only collapse the backoff — attempts stays at the PRODUCTION default so the
// real publish retry count is what's under test.
const noWait = { backoffMs: () => 0 };

describe('retryTransientPolicyState — #1404 bounded transient-UNKNOWN retry (pure helper, production attempts)', () => {
  it('recovers: transient UNKNOWN then confirmed PUBLIC (0) — read called twice (needs attempts >= 2)', async () => {
    const read = vi.fn<[], Promise<PolicyState>>()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce(0);
    expect(await retryTransientPolicyState(read, noWait)).toBe(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('recovers: transient THROW then confirmed PRIVATE (1) — read called twice (needs attempts >= 2)', async () => {
    const read = vi.fn<[], Promise<PolicyState>>()
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce(1);
    expect(await retryTransientPolicyState(read, noWait)).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('confirmed on the first read returns immediately — no extra attempts', async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockResolvedValue(0);
    expect(await retryTransientPolicyState(read, noWait)).toBe(0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("'unregistered' is a confirmed (non-retryable) state — one attempt", async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockResolvedValue('unregistered');
    expect(await retryTransientPolicyState(read, noWait)).toBe('unregistered');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('all attempts UNKNOWN → stays UNKNOWN (fails closed); read + retry-warn fire the PRODUCTION count', async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockResolvedValue('unknown');
    const onRetryUnknown = vi.fn();
    expect(await retryTransientPolicyState(read, { ...noWait, onRetryUnknown })).toBe('unknown');
    expect(read).toHaveBeenCalledTimes(POLICY_STATE_RETRY_ATTEMPTS);
    // warns between attempts, not after the last
    expect(onRetryUnknown).toHaveBeenCalledTimes(POLICY_STATE_RETRY_ATTEMPTS - 1);
  });

  it('all attempts THROW → rejects on the final throw after the PRODUCTION count (caller fails closed)', async () => {
    const read = vi.fn<[], Promise<PolicyState>>().mockRejectedValue(new Error('rpc down'));
    await expect(retryTransientPolicyState(read, noWait)).rejects.toThrow('rpc down');
    expect(read).toHaveBeenCalledTimes(POLICY_STATE_RETRY_ATTEMPTS);
  });
});

// `resolvePublishAccessPolicyState` only touches `this.log.warn`,
// `this.readLiveOnChainAccessPolicy` and `this.resolveOnChainAccessPolicyState`,
// so a minimal fake `this` exercises the read-selection + retry composition.
const resolvePublishAccessPolicyState = (DKGAgent.prototype as unknown as {
  resolvePublishAccessPolicyState: (
    this: unknown,
    cgId: string,
    opCtx?: unknown,
    opts?: { rawOnChainSlot?: boolean; logLabel?: string; attempts?: number; backoffMs?: (n: number) => number },
  ) => Promise<PolicyState>;
}).resolvePublishAccessPolicyState;

function fakeThis(over: {
  readLive?: (id: string) => Promise<0 | 1 | null>;
  resolveState?: (cgId: string) => Promise<PolicyState>;
} = {}) {
  return {
    log: { warn: () => {} },
    readLiveOnChainAccessPolicy: vi.fn(over.readLive ?? (async () => null)),
    resolveOnChainAccessPolicyState: vi.fn(over.resolveState ?? (async () => 'unknown' as PolicyState)),
  };
}

describe('resolvePublishAccessPolicyState — #1404 canonical publish policy op (read-select + production retry)', () => {
  it('rawOnChainSlot + numeric id: reads the RAW on-chain slot (readLiveOnChainAccessPolicy), NOT the resolver', async () => {
    const self = fakeThis({ readLive: async () => 1 });
    const state = await resolvePublishAccessPolicyState.call(self, '123', undefined, {
      rawOnChainSlot: true,
      backoffMs: () => 0,
    });
    expect(state).toBe(1);
    expect(self.readLiveOnChainAccessPolicy).toHaveBeenCalledTimes(1);
    expect(self.resolveOnChainAccessPolicyState).not.toHaveBeenCalled();
  });

  it('default (no rawOnChainSlot): reads via the shared tri-state resolver', async () => {
    const self = fakeThis({ resolveState: async () => 0 });
    const state = await resolvePublishAccessPolicyState.call(self, 'sports', undefined, { backoffMs: () => 0 });
    expect(state).toBe(0);
    expect(self.resolveOnChainAccessPolicyState).toHaveBeenCalledTimes(1);
    expect(self.readLiveOnChainAccessPolicy).not.toHaveBeenCalled();
  });

  it('applies the transient-UNKNOWN retry through the canonical op on the PRODUCTION path (resolver unknown → confirmed private)', async () => {
    const resolveState = vi.fn<[string], Promise<PolicyState>>()
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce(1);
    const self = fakeThis();
    self.resolveOnChainAccessPolicyState = resolveState as any;
    // NOTE: no `attempts` override — this is the real publish retry config.
    const state = await resolvePublishAccessPolicyState.call(self, 'sports', { operationId: 't' }, {
      backoffMs: () => 0,
    });
    expect(state).toBe(1);
    expect(resolveState).toHaveBeenCalledTimes(2);
  });

  it('rawOnChainSlot that never proves live (null → UNKNOWN) stays UNKNOWN after the PRODUCTION attempt count → caller fails closed', async () => {
    const self = fakeThis({ readLive: async () => null });
    const state = await resolvePublishAccessPolicyState.call(self, '999', { operationId: 't' }, {
      rawOnChainSlot: true,
      backoffMs: () => 0,
    });
    expect(state).toBe('unknown');
    expect(self.readLiveOnChainAccessPolicy).toHaveBeenCalledTimes(POLICY_STATE_RETRY_ATTEMPTS);
  });
});
