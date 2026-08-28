/**
 * The chain-proof retry schedule tested DIRECTLY through its pass/turn protocol: rows model
 * dispatch passes exactly as the publisher runs them — `beginPass` at the inventory snapshot,
 * `observe` admitting turns, and only turns mutating. Stale passes and stale turns are real
 * objects held across takeovers, so every concurrency claim is exercised with the same handles
 * production code would hold. The dispatcher integration rows in
 * async-lift-chain-proof-cadence.test.ts keep proving the wiring.
 */
import { describe, expect, it } from 'vitest';
import { ChainProofRetrySchedule } from '../src/chain-proof-retry-schedule.js';

function harness(rand: () => number = () => 0) {
  let now = 1_000_000;
  const schedule = new ChainProofRetrySchedule({ now: () => now, rand });
  return {
    schedule,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    /** One healthy pass turn: observe (asserting admission) and defer in the same pass. */
    turn(jobId: string, identity: string, cadence: 'default' | 'awaiting-confirmations' = 'default') {
      const turn = schedule.beginPass(now).observe(jobId, identity);
      expect(turn).not.toBeNull();
      turn!.defer(cadence);
    },
    /** Observe on a fresh pass: true when a turn was admitted (due). */
    due(jobId: string, identity: string) {
      return schedule.beginPass(now).observe(jobId, identity) !== null;
    },
  };
}

const A = 'broadcast|recovery_lookup_timeout|500|fp1';
const B = 'broadcast|recovery_lookup_timeout|900|fp1';

describe('ChainProofRetrySchedule', () => {
  it('grows the default ladder 30s → 60s → 120s → 240s and caps at 10 minutes', () => {
    const h = harness();
    for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
      h.turn('job', A);
      h.advance(delay - 1);
      expect(h.due('job', A)).toBe(false);
      h.advance(1);
      expect(h.due('job', A)).toBe(true);
    }
  });

  it('the awaiting-confirmations ceiling holds AFTER maximum jitter: never past 120s', () => {
    const h = harness(() => 1);
    // Attempt 3 hits the base cap (96s) + 25% jitter = exactly 120s.
    h.turn('job', A, 'awaiting-confirmations');
    h.advance(37_500);
    h.turn('job', A, 'awaiting-confirmations');
    h.advance(75_000);
    h.turn('job', A, 'awaiting-confirmations');
    h.advance(119_999);
    expect(h.due('job', A)).toBe(false);
    h.advance(1);
    expect(h.due('job', A)).toBe(true);
  });

  it('the attempt ladder is shared across cadences; the cadence changes only the ceiling', () => {
    const h = harness();
    h.turn('job', A, 'default');            // attempt 1: 30s
    h.advance(30_000);
    h.turn('job', A, 'awaiting-confirmations'); // attempt 2: 60s (below both caps)
    h.advance(60_000);
    h.turn('job', A, 'default');            // attempt 3: 120s (default cap far away)
    h.advance(120_000);
    h.turn('job', A, 'awaiting-confirmations'); // attempt 4: min(240s, 96s cap) = 96s
    h.advance(95_999);
    expect(h.due('job', A)).toBe(false);
    h.advance(1);
    expect(h.due('job', A)).toBe(true);
  });

  it('a successor incarnation is due immediately and takes ownership, however far away the predecessor due time is', () => {
    const h = harness();
    h.turn('job', A);
    h.advance(30_000);
    h.turn('job', A);
    h.advance(60_000);
    h.turn('job', A); // predecessor parked 120s out
    expect(h.due('job', A)).toBe(false);
    expect(h.due('job', B)).toBe(true); // successor: immediate dueness, ownership replaced
    expect(h.schedule.retainedEntryCount()).toBe(1); // ownership is never vacant
  });

  it("a successor's first deferral starts the ladder at the base, not the predecessor's exponent", () => {
    const h = harness();
    for (const wait of [30_000, 60_000, 120_000]) {
      h.turn('job', A);
      h.advance(wait);
    }
    h.turn('job', A); // predecessor at attempt 4 (parked 240s out)
    h.turn('job', B); // successor observed + FIRST deferral
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.advance(1);
    expect(h.due('job', B)).toBe(true); // 30s, not 480s
  });

  it("a successor's own earned ladder is never clobbered — it continues on its own identity", () => {
    const h = harness();
    h.turn('job', A);
    h.turn('job', B); // successor attempt 1
    h.advance(30_000);
    h.turn('job', B); // successor attempt 2: 60s
    h.advance(59_999);
    expect(h.due('job', B)).toBe(false);
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a settled turn leaves no schedule behind', () => {
    const h = harness();
    const turn = h.schedule.beginPass(h.now()).observe('job', A);
    turn!.defer('default');
    h.advance(30_000);
    const next = h.schedule.beginPass(h.now()).observe('job', A);
    next!.settled();
    expect(h.schedule.retainedEntryCount()).toBe(0);
    expect(h.due('job', A)).toBe(true);
  });

  it('stale turns held across a takeover can neither reset nor retain — the map stays bounded', () => {
    // Retention is the observable, not just the successor's cadence: five stale turns from an
    // old pass all defer late; the count stays at one and B's backoff is untouched.
    const h = harness();
    const stalePass = h.schedule.beginPass(h.now());
    const staleTurns = [A, `${A}x1`, `${A}x2`, `${A}x3`, `${A}x4`].map((id) => {
      const turn = stalePass.observe('job', id);
      return turn;
    });
    h.turn('job', B); // B takes ownership and defers
    for (const turn of staleTurns) turn?.defer('default');
    expect(h.schedule.retainedEntryCount()).toBe(1);
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.schedule.beginPass(h.now()); // no-op pass; B still owns
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a stale settlement cannot clear a schedule the successor earned', () => {
    // PR #2380 r4 (🟡 3883088122) — the restored foreign-settlement regression: a turn admitted
    // for the predecessor settles AFTER the successor took over and deferred. The write-time
    // identity check drops it whole: entry retained, B's due time intact.
    const h = harness();
    const staleTurn = h.schedule.beginPass(h.now()).observe('job', A);
    expect(staleTurn).not.toBeNull();
    h.turn('job', B); // successor takes ownership and earns its 30s
    staleTurn!.settled(); // predecessor's late settlement: no-op
    expect(h.schedule.retainedEntryCount()).toBe(1);
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false); // B still deferred
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a stale echo cannot claim the slot — even from a COMPLETELY EMPTY schedule', () => {
    // Overlapping first passes observe A then B before either completes; the late A deferral
    // is rejected, B's first backoff lands, and settlement leaves no residue.
    const h = harness();
    const stalePass = h.schedule.beginPass(h.now()); // older inventory: incarnation A
    const newerPass = h.schedule.beginPass(h.now()); // newer inventory: incarnation B
    const staleTurn = stalePass.observe('job', A);
    expect(staleTurn).not.toBeNull(); // first contact installs ready(A)
    const newerTurn = newerPass.observe('job', B);
    expect(newerTurn).not.toBeNull(); // newer token: ready(B)
    staleTurn!.defer('default'); // stale completion: foreign-dropped
    newerTurn!.defer('default'); // B's first backoff LANDS
    expect(h.schedule.retainedEntryCount()).toBe(1);
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a repeat observation of the current owner REFRESHES recency — a stale pass cannot slip between', () => {
    const h = harness();
    h.turn('job', B); // B deferred under token t1
    const stalePass = h.schedule.beginPass(h.now()); // t2: stale pass for A
    const freshPass = h.schedule.beginPass(h.now()); // t3: newer pass observing B again
    expect(freshPass.observe('job', B)).toBeNull(); // not due, but recency refreshed to t3
    expect(stalePass.observe('job', A)).toBeNull(); // t2 < t3: refused
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false); // B's backoff intact
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a STALE due check cannot reclaim ownership from a newer incarnation — token order, no clock needed', () => {
    // The ordering authority is the token, so the same-millisecond tie a clock would allow
    // cannot occur — this row never advances the clock at all.
    const h = harness();
    h.turn('job', A); // the slot is A's
    const stalePass = h.schedule.beginPass(h.now());
    const newerPass = h.schedule.beginPass(h.now());
    const newerTurn = newerPass.observe('job', B);
    expect(newerTurn).not.toBeNull(); // B takes ownership
    expect(stalePass.observe('job', A)).toBeNull(); // stale pass refused
    newerTurn!.defer('default'); // B's deferral is NOT foreign-dropped
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
    expect(h.schedule.retainedEntryCount()).toBe(1);
  });
});
