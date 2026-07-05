import { describe, expect, it } from 'vitest';
import { DashboardLoginAttemptLimiter } from '../src/daemon/dashboard-session.js';

describe('DashboardLoginAttemptLimiter', () => {
  it('bounds dashboard login attempt tracking for many unique usernames', () => {
    let now = 1_000;
    const limiter = new DashboardLoginAttemptLimiter({
      maxFailures: 2,
      failureWindowMs: 60_000,
      lockoutMs: 60_000,
      maxTrackedKeys: 3,
      now: () => now,
    });

    for (let i = 0; i < 20; i += 1) {
      limiter.recordFailure(`127.0.0.1:user-${i}`);
    }
    expect((limiter as any).attempts.size).toBeLessThanOrEqual(3);

    now += 60_001;
    expect(limiter.reserve('127.0.0.1:fresh-user')).toEqual({ ok: true });
    expect((limiter as any).attempts.size).toBe(1);
    limiter.releaseReservation('127.0.0.1:fresh-user');
    expect((limiter as any).attempts.size).toBe(0);

    expect(limiter.reserve('127.0.0.1:active-a')).toEqual({ ok: true });
    expect(limiter.reserve('127.0.0.1:active-b')).toEqual({ ok: true });
    expect(limiter.reserve('127.0.0.1:active-c')).toEqual({ ok: true });
    expect(limiter.reserve('127.0.0.1:active-d')).toEqual({ ok: false, retryAfterMs: 60_000 });
    expect((limiter as any).attempts.size).toBe(3);
  });
});
