/**
 * The chain-proof retry schedule tested DIRECTLY through its pass protocol: rows model
 * dispatch passes exactly as the publisher runs them — `beginPass` at the inventory snapshot,
 * one `observeSnapshot` admission per pass, and only turns mutating. Stale passes and stale
 * turns are real objects held across takeovers, so every concurrency claim is exercised with
 * the same handles production code would hold. The dispatcher integration rows in
 * async-lift-chain-proof-cadence.test.ts keep proving the wiring.
 */
import { describe, expect, it } from 'vitest';
import { ChainProofRetrySchedule } from '../src/chain-proof-retry-schedule.js';
import type { ChainProofSchedulePass } from '../src/chain-proof-retry-schedule.js';

/** One-candidate admission through the real snapshot API: the turn when due, else null. */
function obs(pass: ChainProofSchedulePass, jobId: string, identity: string) {
  return pass.observeSnapshot([{ jobId, identity }]).get(jobId) ?? null;
}

function harness(rand: () => number = () => 0) {
  let now = 1_000_000;
  const schedule = new ChainProofRetrySchedule({ now: () => now, rand });
  return {
    schedule,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    /** One healthy pass turn: admit (asserting dueness) and defer in the same pass. */
    turn(jobId: string, identity: string, cadence: 'default' | 'awaiting-confirmations' = 'default') {
      const turn = obs(schedule.beginPass(now), jobId, identity);
      expect(turn).not.toBeNull();
      turn!.defer(cadence);
    },
    /** Admission on a fresh pass: true when a turn was admitted (due). */
    due(jobId: string, identity: string) {
      return obs(schedule.beginPass(now), jobId, identity) !== null;
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
    const turn = obs(h.schedule.beginPass(h.now()), 'job', A);
    turn!.defer('default');
    h.advance(30_000);
    const next = obs(h.schedule.beginPass(h.now()), 'job', A);
    next!.settled();
    expect(h.schedule.retainedEntryCount()).toBe(0);
    expect(h.due('job', A)).toBe(true);
  });

  it('stale turns held across a takeover can neither reset nor retain — the map stays bounded', () => {
    // Retention is the observable, not just the successor's cadence: five stale turns, each
    // from its own old pass (one snapshot admission per pass, as production runs), all defer
    // late; the count stays at one and B's backoff is untouched.
    const h = harness();
    const staleTurns = [A, `${A}x1`, `${A}x2`, `${A}x3`, `${A}x4`]
      .map((id) => obs(h.schedule.beginPass(h.now()), 'job', id));
    h.turn('job', B); // B takes ownership and defers
    for (const turn of staleTurns) turn?.defer('default');
    expect(h.schedule.retainedEntryCount()).toBe(1);
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.schedule.beginPass(h.now()); // no-op pass; B still owns
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a pass admits its snapshot EXACTLY ONCE — split admission fails loudly, not silently', () => {
    // PR #2380 r11 (🟡 3884194251) — a split admission would sweep the omitted job's entry on
    // the first call and reinstall it immediately-ready on the second, resetting its earned
    // backoff without any error. The single-use guard turns that into a local failure.
    const h = harness();
    h.turn('b', B); // b deferred with an earned 30s
    const pass = h.schedule.beginPass(h.now());
    pass.observeSnapshot([{ jobId: 'a', identity: A }]);
    expect(() => pass.observeSnapshot([{ jobId: 'b', identity: B }])).toThrow(/exactly once/);
  });

  it('a stale settlement cannot clear a schedule the successor earned', () => {
    // PR #2380 r4 (🟡 3883088122) — the restored foreign-settlement regression: a turn admitted
    // for the predecessor settles AFTER the successor took over and deferred. The write-time
    // identity check drops it whole: entry retained, B's due time intact.
    const h = harness();
    const staleTurn = obs(h.schedule.beginPass(h.now()), 'job', A);
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
    // is rejected and B's first backoff lands. (The post-settlement variant — the owner settles
    // and THEN the stale turn defers — is the next row.)
    const h = harness();
    const stalePass = h.schedule.beginPass(h.now()); // older inventory: incarnation A
    const newerPass = h.schedule.beginPass(h.now()); // newer inventory: incarnation B
    const staleTurn = obs(stalePass, 'job', A);
    expect(staleTurn).not.toBeNull(); // first contact installs ready(A)
    const newerTurn = obs(newerPass, 'job', B);
    expect(newerTurn).not.toBeNull(); // newer token: ready(B)
    staleTurn!.defer('default'); // stale completion: foreign-dropped
    newerTurn!.defer('default'); // B's first backoff LANDS
    expect(h.schedule.retainedEntryCount()).toBe(1);
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a stale deferral cannot resurrect a slot the owner already settled', () => {
    // PR #2380 r5 (🔴 3883196852) — the owner resolves the job (settlement deletes the entry),
    // then a stale turn from an older pass defers. A defer into the emptied slot must be a
    // no-op, not an install: a resurrected entry for a done job would be retained forever.
    const h = harness();
    const stalePass = h.schedule.beginPass(h.now());
    const newerPass = h.schedule.beginPass(h.now());
    const staleTurn = obs(stalePass, 'job', A);
    expect(staleTurn).not.toBeNull();
    const newerTurn = obs(newerPass, 'job', B);
    expect(newerTurn).not.toBeNull();
    newerTurn!.settled(); // the owner resolves the job; the slot is gone
    staleTurn!.defer('default'); // late echo into the emptied slot
    expect(h.schedule.retainedEntryCount()).toBe(0);
  });

  it("a stale pass's first contact AFTER a settlement is admitted, but the next pass SWEEPS the residue", () => {
    // PR #2380 r6 (🔴 3883453613) — the schedule keeps no settlement history, so an older pass
    // observing a settled job's gone incarnation for the first time installs ready() again.
    // Boundedness comes from the sweep half of snapshot admission: the newest snapshot no
    // longer holds the job, so its admission collects the residue entry.
    const h = harness();
    const oldPass = h.schedule.beginPass(h.now());
    const freshPass = h.schedule.beginPass(h.now());
    const freshTurn = obs(freshPass, 'job', B);
    expect(freshTurn).not.toBeNull();
    freshTurn!.settled(); // the job is resolved; the map is empty
    const lateTurn = obs(oldPass, 'job', A); // stale first contact: admitted (no history)
    expect(lateTurn).not.toBeNull();
    expect(h.schedule.retainedEntryCount()).toBe(1);
    h.schedule.beginPass(h.now()).observeSnapshot([]); // newest snapshot holds no jobs
    expect(h.schedule.retainedEntryCount()).toBe(0);
  });

  it('the sweep spares live jobs and entries from passes at least as new as the sweeper', () => {
    // The two sweep guards, each load-bearing: a job in the sweeper's snapshot keeps its earned
    // ladder, and an entry installed by a NEWER overlapping pass (whose snapshot the sweeper's
    // cannot outrank) is kept even though the sweeper's older snapshot does not know the job.
    const h = harness();
    h.turn('live', A); // deferred under an older pass, still held: must survive with its ladder
    const sweeper = h.schedule.beginPass(h.now());
    const newerPass = h.schedule.beginPass(h.now());
    // The newer pass declares its WHOLE snapshot (both jobs): 'fresh' is admitted, 'live' is
    // deferred-not-due (its ladder untouched, its entry recognized so the sweep spares it).
    const newerTurn = newerPass.observeSnapshot([
      { jobId: 'live', identity: A },
      { jobId: 'fresh', identity: B },
    ]).get('fresh') ?? null;
    expect(newerTurn).not.toBeNull();
    sweeper.observeSnapshot([{ jobId: 'live', identity: A }]); // sweeper's OLDER snapshot: live only
    expect(h.schedule.retainedEntryCount()).toBe(2);
    newerTurn!.defer('default'); // the kept entry is still owned: the deferral lands
    h.advance(29_999);
    // Both ladders intact — one combined snapshot per check, as a real pass would carry.
    const fullSnapshot = [
      { jobId: 'live', identity: A },
      { jobId: 'fresh', identity: B },
    ];
    expect(h.schedule.beginPass(h.now()).observeSnapshot(fullSnapshot).size).toBe(0);
    h.advance(1);
    expect(h.schedule.beginPass(h.now()).observeSnapshot(fullSnapshot).size).toBe(2);
  });

  it('a repeat observation of the current owner REFRESHES recency — a stale pass cannot slip between', () => {
    const h = harness();
    h.turn('job', B); // B deferred under token t1
    const stalePass = h.schedule.beginPass(h.now()); // t2: stale pass for A
    const freshPass = h.schedule.beginPass(h.now()); // t3: newer pass observing B again
    expect(obs(freshPass, 'job', B)).toBeNull(); // not due, but recency refreshed to t3
    expect(obs(stalePass, 'job', A)).toBeNull(); // t2 < t3: refused
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false); // B's backoff intact
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
  });

  it('a late same-owner deferral cannot roll recency BACK — the intermediate stale pass stays refused', () => {
    // PR #2380 r8 (🟡 3883811952) — deferTurn keeps max(turn token, entry token): B's turn from
    // t1 defers AFTER a newer pass refreshed B's recency at t3. Writing the turn's own token
    // would regress recency to t1 and let the intermediate stale pass t2 reclaim the slot,
    // resetting B's earned ladder.
    const h = harness();
    const t1 = h.schedule.beginPass(h.now());
    const turnB = obs(t1, 'job', B);
    expect(turnB).not.toBeNull();
    const t2 = h.schedule.beginPass(h.now()); // stale pass for A, opened between B's turns
    const t3 = h.schedule.beginPass(h.now());
    expect(obs(t3, 'job', B)).not.toBeNull(); // recency refreshed to t3
    turnB!.defer('default'); // late deferral from t1: must not regress recency below t3
    expect(obs(t2, 'job', A)).toBeNull(); // t2 < t3: still refused
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false); // B's ladder intact on its own entry
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
    const newerTurn = obs(newerPass, 'job', B);
    expect(newerTurn).not.toBeNull(); // B takes ownership
    expect(obs(stalePass, 'job', A)).toBeNull(); // stale pass refused
    newerTurn!.defer('default'); // B's deferral is NOT foreign-dropped
    h.advance(29_999);
    expect(h.due('job', B)).toBe(false);
    h.advance(1);
    expect(h.due('job', B)).toBe(true);
    expect(h.schedule.retainedEntryCount()).toBe(1);
  });
});
