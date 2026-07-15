import { describe, expect, it } from 'vitest';
import { deterministicStartupJitterMs } from '../src/startup-jitter.js';

describe('deterministicStartupJitterMs', () => {
  it('is stable, bounded, and separates a four-peer cold rollout', () => {
    const max = 30_000;
    const first = ['peer-a', 'peer-b', 'peer-c', 'peer-d']
      .map((peer) => deterministicStartupJitterMs(`${peer}\0base:8453`, max));
    const second = ['peer-a', 'peer-b', 'peer-c', 'peer-d']
      .map((peer) => deterministicStartupJitterMs(`${peer}\0base:8453`, max));

    expect(second).toEqual(first);
    expect(first.every((delay) => delay >= 0 && delay <= max)).toBe(true);
    expect(new Set(first).size).toBe(4);
    expect(deterministicStartupJitterMs('peer-a', 0)).toBe(0);
  });
});
