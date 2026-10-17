import { describe, expect, it } from 'vitest';
import { FinalizedPrivateRepairRetryV1, PRIVATE_REPAIR_MAX_BACKOFF_MS, parsePrivatePlacementFailureStateV1 } from '../src/internal/finalized-private-repair-retry.js';

describe('exact private placement retry scheduling', () => {
  it('parks repeated deterministic failures and fences a stale failure after operator retry', () => {
    const retry = new FinalizedPrivateRepairRetryV1();
    retry.observe({ scopeIdentity: 'private', headRevision: 'active' });
    for (const now of [1000, 6000, 16000]) expect(retry.fail(0, now, 5000, 'signer_mismatch')).toBe(true);
    expect(retry.parked).toBe(true); expect(retry.eligible(1e9)).toBe(false);
    const state = retry.snapshot(); expect(state).toMatchObject({ firstFailedAtMs: 1000, sameKindFailures: 3 });
    const reopened = new FinalizedPrivateRepairRetryV1(); reopened.restore(state, 1e6);
    expect(reopened.parked).toBe(true); expect(reopened.consecutiveFailures).toBe(3);
    reopened.retryNow(); expect(reopened.eligible(1e6)).toBe(true);
    expect(reopened.fail(0, 1e6, 5000, 'signer_mismatch')).toBe(false);
    expect(reopened.parked).toBe(false);
  });
  it('keeps unknown/transient conditions retryable with a finite thirty-minute cap', () => {
    const retry = new FinalizedPrivateRepairRetryV1();
    let now = 1000;
    for (let i = 0; i < 30; i++) {
      retry.fail(0, now, 5000, 'unknown');
      expect(retry.parked).toBe(false);
      expect(retry.nextAttemptAtMs! - now).toBeLessThanOrEqual(PRIVATE_REPAIR_MAX_BACKOFF_MS);
      now = retry.nextAttemptAtMs!;
    }
    expect(retry.nextAttemptAtMs).toBe(now);
    retry.fail(0, now, 5000, 'transport');
    expect(retry.sameKindFailures).toBe(1); expect(retry.nextAttemptAtMs).toBe(now + 5000);
  });
  it('does not use a malformed or unknown-kind hint to park, and bounds backwards-clock recovery', () => {
    const retry = new FinalizedPrivateRepairRetryV1(); retry.fail(0, 1e6, 5000, 'unknown');
    const state = retry.snapshot()!;
    for (const bad of [{ ...state, kind: 'secret', parked: true }, { ...state, parked: true },
      { ...state, firstFailedAtMs: NaN }, { ...state, nextAttemptAtMs: Number.MAX_SAFE_INTEGER }]) {
      expect(parsePrivatePlacementFailureStateV1(bad)).toBeNull();
      const current = new FinalizedPrivateRepairRetryV1(); current.restore(bad, 0); expect(current.eligible(0)).toBe(true);
    }
    const reopened = new FinalizedPrivateRepairRetryV1(); reopened.restore(state, 0);
    expect(reopened.nextAttemptAtMs).toBeLessThanOrEqual(PRIVATE_REPAIR_MAX_BACKOFF_MS);
  });
});


it('reads each untrusted hint field once and retains a valid state after wall-clock rollback', () => {
  const retry = new FinalizedPrivateRepairRetryV1(); retry.fail(0, 10000, 5000, 'unknown');
  const hint = retry.snapshot()!; let reads = 0;
  const hostile = { ...hint, get kind() { return ++reads === 1 ? 'unknown' : 'secret'; } };
  expect(parsePrivatePlacementFailureStateV1(hostile)?.kind).toBe('unknown'); expect(reads).toBe(1);
  retry.fail(0, 1000, 5000, 'unknown');
  expect(parsePrivatePlacementFailureStateV1(retry.snapshot())).toEqual(retry.snapshot());
});
