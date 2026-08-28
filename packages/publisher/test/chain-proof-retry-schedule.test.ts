/**
 * PR #2373 r2 (3879930153) — the chain-proof retry schedule tested DIRECTLY: pure timing
 * behavior (ladder growth, both ceilings, ownership, recency, cleanup) no longer needs the
 * full publisher lifecycle to be provable. The dispatcher integration rows in
 * async-lift-chain-proof-cadence.test.ts keep proving the wiring. Every row models passes
 * explicitly: `beginPass()` issues the ordering token a real dispatch pass obtains at its
 * inventory snapshot (PR #2380 r3 — tokens, not millisecond timestamps, order ownership).
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
    /** One healthy pass turn: observe (asserting dueness) and defer in the same pass. */
    turn(jobId: string, identity: string, cadence: 'default' | 'awaiting-confirmations' = 'default') {
      const token = schedule.beginPass();
      expect(schedule.isDue(jobId, identity, now, token)).toBe(true);
      schedule.defer(jobId, identity, cadence, token);
    },
    /** Observe only, on a fresh pass token. */
    due(jobId: string, identity: string) {
      const token = schedule.beginPass();
      return schedule.isDue(jobId, identity, now, token);
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

  it('a settled job leaves no schedule behind', () => {
    const h = harness();
    h.turn('job', A);
    h.schedule.settled('job', A);
    expect(h.schedule.retainedEntryCount()).toBe(0);
    expect(h.due('job', A)).toBe(true);
  });

  it('stale echoes are DROPPED, not retained: the map stays bounded at one entry per job', () => {
    // r8 (🔴 3882533655) — retention is the observable, not just the successor's cadence.
    const h = harness();
    const staleToken = h.schedule.beginPass();
    h.turn('job', B);
    for (let i = 0; i < 5; i += 1) {
      h.schedule.defer('job', `broadcast|recovery_lookup_timeout|${100 + i}|fp1`, 'default', staleToken);
    }
    expect(h.schedule.retainedEntryCount()).toBe(1); // only B's entry stands
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false); // and it is B's, untouched
    h.schedule.settled('job', B);
    expect(h.schedule.retainedEntryCount()).toBe(0);
  });

  it('a stale echo cannot claim the slot — even from a COMPLETELY EMPTY schedule', () => {
    // PR #2380 r3 (🔴 3882984347 / 🟡 3882984707) — first contact must install ownership too:
    // overlapping first passes observe A then B before either completes; the late A deferral
    // is rejected, B's first backoff lands, and settlement leaves no A leak behind.
    const h = harness();
    const tokenA = h.schedule.beginPass(); // stale pass (older inventory: incarnation A)
    const tokenB = h.schedule.beginPass(); // newer pass (incarnation B)
    expect(h.schedule.isDue('job', A, h.now(), tokenA)).toBe(true); // installs ready(A)
    expect(h.schedule.isDue('job', B, h.now(), tokenB)).toBe(true); // newer: ready(B)
    h.schedule.defer('job', A, 'default', tokenA); // stale completion: foreign-dropped
    h.schedule.defer('job', B, 'default', tokenB); // B's first backoff LANDS
    expect(h.schedule.retainedEntryCount()).toBe(1);
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false); // B's 30s intact
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
    h.schedule.settled('job', B);
    expect(h.schedule.retainedEntryCount()).toBe(0); // no stale-A residue possible
  });

  it('a repeat observation of the current owner REFRESHES recency — a stale pass cannot slip between', () => {
    // PR #2380 r3 (🔴 3882984503) — without the refresh, B's entry keeps its original token and
    // a stale pass issued later than that (but earlier than B's newest observation) reclaims.
    const h = harness();
    h.turn('job', B); // B deferred with token t1
    const staleTokenA = h.schedule.beginPass(); // t2: stale pass for A
    const freshTokenB = h.schedule.beginPass(); // t3: newer pass observing B again
    expect(h.schedule.isDue('job', B, h.now(), freshTokenB)).toBe(false); // refreshes to t3
    expect(h.schedule.isDue('job', A, h.now(), staleTokenA)).toBe(false); // t2 < t3: refused
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false); // B's backoff intact
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a STALE due check cannot reclaim ownership from a newer incarnation — token order, no clock needed', () => {
    // PR #2380 r2 (🔴 3882793685) + r3 (🟡 3882984696): the ordering authority is the token, so
    // the same-millisecond tie the clock allowed cannot occur — this row never advances the
    // clock at all.
    const h = harness();
    h.turn('job', A); // the slot is A's
    const staleToken = h.schedule.beginPass();
    const newerToken = h.schedule.beginPass();
    expect(h.schedule.isDue('job', B, h.now(), newerToken)).toBe(true); // B takes ownership
    expect(h.schedule.isDue('job', A, h.now(), staleToken)).toBe(false); // stale pass refused
    h.schedule.defer('job', B, 'default', newerToken); // B's deferral is NOT foreign-dropped
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
    expect(h.schedule.retainedEntryCount()).toBe(1);
  });
});
