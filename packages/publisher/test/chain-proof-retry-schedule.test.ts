/**
 * PR #2373 r2 (3879930153) — the chain-proof retry schedule tested DIRECTLY: pure timing
 * behavior (ladder growth, both ceilings, identity awareness, cleanup) no longer needs the full
 * publisher lifecycle to be provable. The dispatcher integration rows in
 * async-lift-chain-proof-dispatch-2270.test.ts keep proving the wiring.
 */
import { describe, expect, it } from 'vitest';
import {
  ChainProofRetrySchedule,
  chainProofScheduleIdentity,
} from '../src/chain-proof-retry-schedule.js';

function harness(rand: () => number = () => 0) {
  let now = 1_000_000;
  const schedule = new ChainProofRetrySchedule({ now: () => now, rand });
  return {
    schedule,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

const A = 'broadcast|recovery_lookup_timeout|500';
const B = 'broadcast|recovery_lookup_timeout|900';

describe('ChainProofRetrySchedule', () => {
  it('derives one identity per held-job incarnation from failure facts', () => {
    expect(chainProofScheduleIdentity({
      failure: { failedFromState: 'broadcast', code: 'recovery_lookup_timeout' },
      timestamps: { failedAt: 500 },
    })).toBe(A);
  });

  it('grows the default ladder 30s → 60s → 120s → 240s and caps at 10 minutes', () => {
    const h = harness();
    for (const [attempt, delay] of [[1, 30_000], [2, 60_000], [3, 120_000], [4, 240_000], [5, 480_000], [6, 600_000], [7, 600_000]] as const) {
      h.schedule.defer('job', A, 'default');
      h.advance(delay - 1);
      expect(h.schedule.isDue('job', A, h.now())).toBe(false);
      h.advance(1);
      expect(h.schedule.isDue('job', A, h.now())).toBe(true);
      void attempt;
    }
  });

  it('the awaiting-confirmations ceiling holds AFTER maximum jitter: never past 120s', () => {
    const h = harness(() => 1);
    // Attempt 3 hits the base cap (96s) + 25% jitter = exactly 120s.
    h.schedule.defer('job', A, 'awaiting-confirmations');
    h.advance(37_500);
    h.schedule.defer('job', A, 'awaiting-confirmations');
    h.advance(75_000);
    h.schedule.defer('job', A, 'awaiting-confirmations');
    h.advance(119_999);
    expect(h.schedule.isDue('job', A, h.now())).toBe(false);
    h.advance(1);
    expect(h.schedule.isDue('job', A, h.now())).toBe(true);
  });

  it('the attempt ladder is shared across cadences; the cadence changes only the ceiling', () => {
    const h = harness();
    h.schedule.defer('job', A, 'default');            // attempt 1: 30s
    h.advance(30_000);
    h.schedule.defer('job', A, 'awaiting-confirmations'); // attempt 2: 60s (below both caps)
    h.advance(60_000);
    h.schedule.defer('job', A, 'default');            // attempt 3: 120s (default cap far away)
    h.advance(119_999);
    expect(h.schedule.isDue('job', A, h.now())).toBe(false);
    h.advance(1);
    h.schedule.defer('job', A, 'awaiting-confirmations'); // attempt 4: min(240s, 96s cap) = 96s
    h.advance(95_999);
    expect(h.schedule.isDue('job', A, h.now())).toBe(false);
    h.advance(1);
    expect(h.schedule.isDue('job', A, h.now())).toBe(true);
  });

  it('a successor incarnation is due immediately, however far away the predecessor due time is', () => {
    const h = harness();
    h.schedule.defer('job', A, 'default');
    h.schedule.defer('job', A, 'default');
    h.schedule.defer('job', A, 'default'); // predecessor parked 120s out
    expect(h.schedule.isDue('job', A, h.now())).toBe(false);
    expect(h.schedule.isDue('job', B, h.now())).toBe(true);
  });

  it("a successor's first deferral starts the ladder at the base, not the predecessor's exponent", () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) h.schedule.defer('job', A, 'default'); // predecessor at attempt 4
    h.schedule.defer('job', B, 'default'); // successor's FIRST deferral
    h.advance(29_999);
    expect(h.schedule.isDue('job', B, h.now())).toBe(false);
    h.advance(1);
    expect(h.schedule.isDue('job', B, h.now())).toBe(true); // 30s, not 480s
  });

  it("a successor's own earned ladder is never clobbered — it continues on its own identity", () => {
    const h = harness();
    h.schedule.defer('job', A, 'default');
    h.schedule.defer('job', B, 'default'); // successor attempt 1
    h.advance(30_000);
    h.schedule.defer('job', B, 'default'); // successor attempt 2: 60s
    h.advance(59_999);
    expect(h.schedule.isDue('job', B, h.now())).toBe(false);
    h.advance(1);
    expect(h.schedule.isDue('job', B, h.now())).toBe(true);
  });

  it('a settled job leaves no schedule behind', () => {
    const h = harness();
    h.schedule.defer('job', A, 'default');
    h.schedule.settled('job');
    expect(h.schedule.isDue('job', A, h.now())).toBe(true);
  });
});
