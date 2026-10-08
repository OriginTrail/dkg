import { describe, expect, it } from 'vitest';
import { createDefaultPromoteBackoff, DEFAULT_PROMOTE_RETRY_TUNING, resolvePromoteRetryTuning } from '../src/index.js';

describe('publisher-owned promote retry tuning', () => {
  it('preserves default policy for absent and undefined operator fields', () => {
    expect(resolvePromoteRetryTuning()).toEqual(DEFAULT_PROMOTE_RETRY_TUNING);
    expect(resolvePromoteRetryTuning({ maxRetries: undefined, retryBaseMs: undefined, retryMaxMs: undefined, retryJitterRatio: undefined })).toEqual(DEFAULT_PROMOTE_RETRY_TUNING);
    expect(Object.isFrozen(resolvePromoteRetryTuning())).toBe(true);
    expect(createDefaultPromoteBackoff() (1)).toBeGreaterThanOrEqual(48_000);
  });
  it.each([0, 0.5, 0.99])('applies configured curve, jitter and cap at random=%s', (random) => {
    const tuning = resolvePromoteRetryTuning({ maxRetries: 3, retryBaseMs: 100, retryMaxMs: 500, retryJitterRatio: 0.5 });
    const backoff = createDefaultPromoteBackoff(() => random, tuning);
    expect(tuning.maxRetries).toBe(3);
    expect(backoff(1)).toBe(Math.round(100 * (0.5 + random)));
    expect(backoff(100)).toBe(Math.min(500, Math.round(500 * (0.5 + random))));
  });
  it('floors negative jitter at one millisecond and caps positive jitter', () => {
    const tuning = resolvePromoteRetryTuning({ retryBaseMs: 1, retryMaxMs: 1, retryJitterRatio: 1 });
    expect(createDefaultPromoteBackoff(() => 0, tuning)(1)).toBe(1);
    expect(createDefaultPromoteBackoff(() => 1, tuning)(1)).toBe(1);
  });
  it.each([
    { maxRetries: 0 }, { maxRetries: 2.5 }, { maxRetries: Infinity }, { retryBaseMs: -1 },
    { retryMaxMs: 0 }, { retryMaxMs: 100 }, { retryJitterRatio: NaN },
    { retryJitterRatio: -0.1 }, { retryJitterRatio: 1.1 },
  ])('rejects invalid tuning %j', (tuning) => {
    expect(() => resolvePromoteRetryTuning(tuning)).toThrow(/promoteQueue/);
  });
});
