import { describe, expect, it } from 'vitest';
import { DashboardLoginAttemptLimiter } from '../src/daemon/dashboard-session.js';

function expectReserved(limiter: DashboardLoginAttemptLimiter, key: string) {
  const reservation = limiter.reserveAttempt(key);
  expect(reservation.ok).toBe(true);
  if (!reservation.ok) throw new Error(`expected ${key} to be accepted`);
  return reservation;
}

describe('DashboardLoginAttemptLimiter', () => {
  it('bounds in-flight tracking and prunes idle failures', () => {
    let now = 1_000;
    const limiter = new DashboardLoginAttemptLimiter({
      maxFailures: 2,
      failureWindowMs: 60_000,
      lockoutMs: 60_000,
      maxTrackedKeys: 3,
      now: () => now,
    });

    for (let i = 0; i < 20; i += 1) {
      expectReserved(limiter, `127.0.0.1:user-${i}`).fail();
    }

    now += 60_001;
    expectReserved(limiter, '127.0.0.1:fresh-user').release();

    const activeA = expectReserved(limiter, '127.0.0.1:active-a');
    expectReserved(limiter, '127.0.0.1:active-b');
    expectReserved(limiter, '127.0.0.1:active-c');
    expect(limiter.reserveAttempt('127.0.0.1:active-d')).toEqual({ ok: false, retryAfterMs: 60_000 });

    activeA.release();
    expectReserved(limiter, '127.0.0.1:active-d');
  });

  it('locks after failed reservations but releases do not consume the budget', () => {
    const limiter = new DashboardLoginAttemptLimiter({ maxFailures: 2, lockoutMs: 60_000 });

    expectReserved(limiter, '127.0.0.1').fail();
    expectReserved(limiter, '127.0.0.1').release();
    expectReserved(limiter, '127.0.0.1').fail();

    expect(limiter.reserveAttempt('127.0.0.1')).toMatchObject({ ok: false });
  });

  it('success resets prior failures', () => {
    const limiter = new DashboardLoginAttemptLimiter({ maxFailures: 2, lockoutMs: 60_000 });

    expectReserved(limiter, '127.0.0.1').fail();
    expectReserved(limiter, '127.0.0.1').succeed();

    expectReserved(limiter, '127.0.0.1').fail();
    expectReserved(limiter, '127.0.0.1').release();
  });

  it('finalizes a reserved attempt only once', () => {
    const limiter = new DashboardLoginAttemptLimiter({ maxFailures: 2 });
    const reservation = expectReserved(limiter, '127.0.0.1');

    reservation.fail();
    reservation.release();
    reservation.succeed();

    const second = limiter.reserveAttempt('127.0.0.1');
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('second reservation should be accepted');
    second.fail();

    const locked = limiter.reserveAttempt('127.0.0.1');
    expect(locked).toMatchObject({ ok: false });
  });
});
