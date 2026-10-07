import { describe, expect, it } from 'vitest';
import { resolveDaemonPromoteQueueConfig } from '../src/daemon/promote-queue-config.js';

describe('daemon promote queue policy', () => {
  it('preserves five attempts and the current default retry curve', () => {
    const config = resolveDaemonPromoteQueueConfig(undefined, () => 0.5);
    expect(config.maxRetries).toBe(5);
    expect([1, 2, 3, 4, 5, 10].map(config.backoff!)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });
  it('applies explicit budget, delay and jitter configuration', () => {
    const config = resolveDaemonPromoteQueueConfig({ maxRetries: 3, retryBaseMs: 100, retryMaxMs: 500, retryJitterRatio: 0.5 }, () => 0);
    expect(config.maxRetries).toBe(3);
    expect(config.backoff!(1)).toBe(50);
    expect(config.backoff!(100)).toBe(250);
  });
  it.each([
    { maxRetries: 0 }, { maxRetries: 2.5 }, { retryBaseMs: -1 }, { retryMaxMs: 100 },
    { retryJitterRatio: -0.1 }, { retryJitterRatio: Infinity }, { retryJitterRatio: 1.1 },
  ])('rejects invalid policy %j', (config) => {
    expect(() => resolveDaemonPromoteQueueConfig(config)).toThrow(/promoteQueue/);
  });
});
