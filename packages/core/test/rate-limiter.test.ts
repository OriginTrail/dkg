import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first request for a new key', () => {
    const rl = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
    expect(rl.allow('peer-a')).toBe(true);
    rl.destroy();
  });

  it('allows up to maxPerWindow requests within the window', () => {
    const rl = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(true);
    rl.destroy();
  });

  it('blocks the request that exceeds maxPerWindow', () => {
    const rl = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
    rl.allow('k');
    rl.allow('k');
    expect(rl.allow('k')).toBe(false);
    rl.destroy();
  });

  it('re-allows requests after the window expires', () => {
    const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
    expect(rl.allow('k')).toBe(true);
    expect(rl.allow('k')).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(rl.allow('k')).toBe(true);
    rl.destroy();
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('b')).toBe(true);
    expect(rl.allow('a')).toBe(false);
    expect(rl.allow('b')).toBe(false);
    rl.destroy();
  });

  describe('wouldAllow', () => {
    it('returns true for an unknown key', () => {
      const rl = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
      expect(rl.wouldAllow('new-key')).toBe(true);
      rl.destroy();
    });

    it('returns false when the bucket is full without consuming a slot', () => {
      const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
      rl.allow('k');
      expect(rl.wouldAllow('k')).toBe(false);
      // Still blocked because wouldAllow doesn't free a slot
      expect(rl.remaining('k')).toBe(0);
      rl.destroy();
    });

    it('does not record an event', () => {
      const rl = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
      rl.wouldAllow('k');
      rl.wouldAllow('k');
      rl.wouldAllow('k');
      expect(rl.remaining('k')).toBe(2);
      rl.destroy();
    });
  });

  describe('remaining', () => {
    it('returns maxPerWindow for an unknown key', () => {
      const rl = new RateLimiter({ maxPerWindow: 5, windowMs: 1000 });
      expect(rl.remaining('x')).toBe(5);
      rl.destroy();
    });

    it('decrements as requests are made', () => {
      const rl = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
      rl.allow('k');
      expect(rl.remaining('k')).toBe(2);
      rl.allow('k');
      expect(rl.remaining('k')).toBe(1);
      rl.allow('k');
      expect(rl.remaining('k')).toBe(0);
      rl.destroy();
    });

    it('never goes below zero', () => {
      const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 1000 });
      rl.allow('k');
      rl.allow('k'); // blocked
      expect(rl.remaining('k')).toBe(0);
      rl.destroy();
    });
  });

  describe('cleanup', () => {
    it('removes stale entries after the cleanup interval fires', () => {
      const rl = new RateLimiter({ maxPerWindow: 5, windowMs: 1000 });
      rl.allow('stale-key');
      expect(rl.size).toBe(1);

      // Advance past window + cleanup interval (2× windowMs, min 60s)
      vi.advanceTimersByTime(61_000);

      expect(rl.size).toBe(0);
      rl.destroy();
    });
  });

  describe('destroy', () => {
    it('clears all buckets and stops the timer', () => {
      const rl = new RateLimiter({ maxPerWindow: 3, windowMs: 1000 });
      rl.allow('a');
      rl.allow('b');
      expect(rl.size).toBe(2);

      rl.destroy();
      expect(rl.size).toBe(0);
    });
  });

  describe('size', () => {
    it('reflects the number of tracked keys', () => {
      const rl = new RateLimiter({ maxPerWindow: 10, windowMs: 5000 });
      expect(rl.size).toBe(0);
      rl.allow('a');
      expect(rl.size).toBe(1);
      rl.allow('b');
      expect(rl.size).toBe(2);
      rl.allow('a'); // same key, no new entry
      expect(rl.size).toBe(2);
      rl.destroy();
    });
  });
});
