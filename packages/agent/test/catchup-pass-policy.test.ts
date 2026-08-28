import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWM_CATCHUP_MAX_PASSES,
  DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS,
  SwmCatchupPassTracker,
  resolveSwmCatchupMaxPasses,
  resolveSwmCatchupPassConfig,
  resolveSwmCatchupPassBudgetMs,
  runSwmCatchupContinuations,
  shouldRunAnotherCatchupPass,
  type CatchupPassPolicyInput,
} from '../src/sync/catchup-pass-policy.js';

/**
 * An input on which EVERY continue condition holds, so each test below can
 * override exactly one field and know the stop it observes came from that field.
 * Without this the suite would be full of tests that pass for the wrong reason —
 * a "budget exhausted" case that actually stopped on a stalled coverage mark
 * still goes green if it only asserts `continue === false`. Every case therefore
 * asserts the `reason`, not just the boolean.
 */
function base(overrides: Partial<CatchupPassPolicyInput> = {}): CatchupPassPolicyInput {
  return {
    nowMs: 10_000,
    deadlineMs: 610_000,
    passesRun: 1,
    maxPasses: 4,
    coverageHighWaterMark: 0,
    lastPassCoverage: 178,
    planeProven: false,
    capablePeers: ['peer-a', 'peer-b'],
    ...overrides,
  };
}

describe('shouldRunAnotherCatchupPass', () => {
  it('continues over exactly the capable peers when every gate holds', () => {
    // Guards the whole suite: if this ever stops, every "stops when X" case below
    // becomes vacuous, because they would stop with or without their override.
    expect(shouldRunAnotherCatchupPass(base())).toEqual({
      continue: true,
      peers: ['peer-a', 'peer-b'],
      reason: 'continue',
    });
  });

  it('stops once a clean peer round has proven the plane and nobody is left to ask', () => {
    // r26's shape ends here on the pass that finally completes: coverage is still
    // advancing and budget remains, but there is nothing left to fetch. Note the
    // empty capable set is what makes this a stop — see the row below.
    expect(shouldRunAnotherCatchupPass(base({ planeProven: true, capablePeers: [] }))).toEqual({
      continue: false,
      peers: [],
      reason: 'plane-proven',
    });
  });

  it('keeps going for a capable peer even once another peer has proven the plane', () => {
    // The plane is proven by an aggregate over EVERY peer, so a member serving
    // its own shared-memory rows and no snapshot refs proves it — the ordinary
    // shape in a multi-member public CG. Letting that stop the walk abandons the
    // peer that declared a complete manifest with refs still outstanding, which
    // is the abandonment #2050 exists to remove: the repeat loop would contribute
    // zero passes in exactly the topology it was written for.
    expect(shouldRunAnotherCatchupPass(base({
      planeProven: true, capablePeers: ['peer-big'],
    }))).toEqual({
      continue: true,
      peers: ['peer-big'],
      reason: 'continue',
    });
  });

  it('stops when coverage did not advance, including when it went nowhere at all', () => {
    // Equal is not advancement, however large: 178 resolved twice running means
    // the second pass bought nothing and a third would buy nothing either.
    // `passesRun: 2` throughout: on pass 1 the mark is 0 only because nothing
    // has run, and a capable peer there earns its repeat (see the rows below).
    expect(shouldRunAnotherCatchupPass(
      base({ passesRun: 2, coverageHighWaterMark: 178, lastPassCoverage: 178 }),
    ).reason).toBe('coverage-stalled');
    expect(shouldRunAnotherCatchupPass(
      base({ passesRun: 2, coverageHighWaterMark: 178, lastPassCoverage: 120 }),
    ).reason).toBe('coverage-stalled');
  });

  it('gives a first pass that resolved nothing zero repeats when nobody is capable', () => {
    // This is the whole reason the high-water mark is initialised to 0 rather
    // than −1. At −1 a barren first pass would read as "advanced to 0" and earn
    // a repeat — for a peer that has just demonstrated it can deliver nothing.
    expect(shouldRunAnotherCatchupPass(
      base({ coverageHighWaterMark: 0, lastPassCoverage: 0, capablePeers: [] }),
    ).reason).toBe('coverage-stalled');
  });

  it('DOES repeat a first pass that materialized nothing while a capable peer remains', () => {
    // The counterpart, and the distinction the barren guard above cannot make on
    // its own: `resolved 0` is reported both by a peer with nothing to give and
    // by a peer holding 250 refs whose every write failed, or whose round
    // deadline was spent before the snapshot walk began. The second states it
    // holds what we lack — `capablePeersForNextPass` already filtered out the
    // barren (`0/0`, no record at all) and truncated-manifest peers, so a
    // non-empty capable set at the pass-1 boundary IS the evidence a repeat can
    // pay. Stopping here reported "more passes would not help" on a graph 250
    // Knowledge Assets short, with the blobs already cached.
    expect(shouldRunAnotherCatchupPass(base({
      passesRun: 1, coverageHighWaterMark: 0, lastPassCoverage: 0,
      capablePeers: ['peer-holding-250'],
    }))).toEqual({
      continue: true,
      peers: ['peer-holding-250'],
      reason: 'continue',
    });
  });

  it('still stalls on a LATER pass that made no progress, capable peers or not', () => {
    // The suppression is scoped to the pass-1 boundary, where the high-water
    // mark is 0 only because nothing has run yet. Once a pass has established a
    // baseline, a repeat that beats nobody's record is genuine evidence that
    // more passes would not help — which is exactly what the reason says.
    expect(shouldRunAnotherCatchupPass(base({
      passesRun: 2, coverageHighWaterMark: 190, lastPassCoverage: 190,
      capablePeers: ['peer-a'],
    })).reason).toBe('coverage-stalled');
  });

  it('stops when no peer admits to holding anything we lack', () => {
    // Barren, cleanly-empty, empty-and-timed-out and meta-truncation peers all
    // arrive here as an empty capable set — in r26 that was ~10 of the 12 peers.
    expect(shouldRunAnotherCatchupPass(base({ capablePeers: [] }))).toEqual({
      continue: false,
      peers: [],
      reason: 'no-capable-peers',
    });
  });

  it('stops at the pass cap even while coverage is still advancing', () => {
    expect(shouldRunAnotherCatchupPass(base({ passesRun: 4, maxPasses: 4 })).reason)
      .toBe('max-passes-reached');
    expect(shouldRunAnotherCatchupPass(base({ passesRun: 5, maxPasses: 4 })).reason)
      .toBe('max-passes-reached');
    // One below the cap still runs, so the cap is a bound rather than an off switch.
    expect(shouldRunAnotherCatchupPass(base({ passesRun: 3, maxPasses: 4 })).continue)
      .toBe(true);
  });

  it('stops at the budget, and treats the deadline instant itself as spent', () => {
    expect(shouldRunAnotherCatchupPass(base({ nowMs: 610_000, deadlineMs: 610_000 })).reason)
      .toBe('budget-exhausted');
    expect(shouldRunAnotherCatchupPass(base({ nowMs: 610_001, deadlineMs: 610_000 })).reason)
      .toBe('budget-exhausted');
    expect(shouldRunAnotherCatchupPass(base({ nowMs: 609_999, deadlineMs: 610_000 })).continue)
      .toBe(true);
  });

  it('runs no extra pass at all when the budget is zero', () => {
    // The operator kill switch. A zero budget makes the deadline equal the job
    // start, so it expires through the ordinary comparison — there is no separate
    // "disabled" branch that could rot.
    const startedAt = 10_000;
    expect(shouldRunAnotherCatchupPass(
      base({ nowMs: startedAt, deadlineMs: startedAt + 0 }),
    ).reason).toBe('budget-exhausted');
  });

  it('reports the most actionable stop when several hold at once', () => {
    // Precedence is a contract, not an accident: a stalled run that also ran out
    // of budget must not read as "raise the budget", because raising it buys
    // nothing. Each case below satisfies BOTH stops and pins which is reported.
    expect(shouldRunAnotherCatchupPass(base({
      planeProven: true, capablePeers: [], coverageHighWaterMark: 178, lastPassCoverage: 178,
    })).reason).toBe('plane-proven');
    // Same two stops, but a capable peer is left: plane-proven no longer applies
    // at all, so the honest reason is the one that actually held.
    expect(shouldRunAnotherCatchupPass(base({
      planeProven: true, passesRun: 2, coverageHighWaterMark: 178, lastPassCoverage: 178,
    })).reason).toBe('coverage-stalled');
    expect(shouldRunAnotherCatchupPass(base({
      passesRun: 2, coverageHighWaterMark: 178, lastPassCoverage: 178, nowMs: 999_999,
    })).reason).toBe('coverage-stalled');
    expect(shouldRunAnotherCatchupPass(base({
      coverageHighWaterMark: 178, lastPassCoverage: 178, passesRun: 4,
    })).reason).toBe('coverage-stalled');
    expect(shouldRunAnotherCatchupPass(base({
      capablePeers: [], passesRun: 4, nowMs: 999_999,
    })).reason).toBe('no-capable-peers');
    expect(shouldRunAnotherCatchupPass(base({
      passesRun: 4, nowMs: 999_999,
    })).reason).toBe('max-passes-reached');
  });

  it('hands back a copy of the capable set', () => {
    // The caller walks the returned list while recomputing capability for the
    // next pass; aliasing the input would let one mutate the other.
    const capablePeers = ['peer-a'];
    const decision = shouldRunAnotherCatchupPass(base({ capablePeers }));
    decision.peers.push('peer-z');
    expect(capablePeers).toEqual(['peer-a']);
  });
});

describe('SwmCatchupPassTracker', () => {
  it('owns last-round capability and monotone per-peer progress', () => {
    const tracker = new SwmCatchupPassTracker();
    tracker.recordPeerRound('peer-a', {
      snapshotsResolved: 2,
      snapshotsTotal: 5,
      manifestComplete: true,
    }, false);

    expect(tracker.capablePeers()).toEqual(['peer-a']);
    expect(tracker.progress()).toBe(2);
    expect(tracker.startContinuationPass()).toBe(2);

    tracker.recordPeerRound('peer-a', {
      snapshotsResolved: 1,
      snapshotsTotal: 5,
      manifestComplete: true,
    }, false);
    expect(tracker.progress()).toBe(2);

    tracker.recordPeerRound('peer-a', undefined, true);
    expect(tracker.capablePeers()).toEqual([]);
    expect(tracker.progress()).toBe(2);
  });
});

describe('runSwmCatchupContinuations', () => {
  it('owns selection, pass counting and terminal reasons across independent units', async () => {
    const complete = new SwmCatchupPassTracker();
    const incomplete = new SwmCatchupPassTracker();
    complete.recordPeerRound('peer-a', {
      snapshotsResolved: 2,
      snapshotsTotal: 2,
      manifestComplete: true,
    }, true);
    incomplete.recordPeerRound('peer-b', {
      snapshotsResolved: 1,
      snapshotsTotal: 3,
      manifestComplete: true,
    }, false);
    const stops: Array<{ key: string; reason: string; continuationPasses: number }> = [];
    const runs: string[][] = [];

    const summary = await runSwmCatchupContinuations({
      units: [
        { key: 'complete', tracker: complete, planeProven: () => true },
        { key: 'incomplete', tracker: incomplete, planeProven: () => false },
      ],
      config: { maxPasses: 4, budgetMs: 1_000 },
      nowMs: () => 10,
      runPass: async (candidates) => {
        runs.push(candidates.map(({ key }) => key));
        for (const candidate of candidates) {
          const started = await candidate.runStarted(async (pass) => {
            expect(pass.progressBefore).toBe(1);
            expect(pass.continuationPass).toBe(1);
            incomplete.recordPeerRound('peer-b', {
              snapshotsResolved: 3,
              snapshotsTotal: 3,
              manifestComplete: true,
            }, true);
          });
          expect(started.started).toBe(true);
        }
      },
      onStop: (stop) => stops.push(stop),
    });

    expect(runs).toEqual([['incomplete']]);
    expect(summary.continuationPasses).toBe(1);
    expect(stops).toEqual([
      { key: 'complete', reason: 'plane-proven', continuationPasses: 0 },
      { key: 'incomplete', reason: 'no-capable-peers', continuationPasses: 1 },
    ]);
  });

  it('does not count a selected pass when the runner declines all work before I/O', async () => {
    const tracker = new SwmCatchupPassTracker();
    tracker.recordPeerRound('peer-a', {
      snapshotsResolved: 1,
      snapshotsTotal: 2,
      manifestComplete: true,
    }, false);

    const summary = await runSwmCatchupContinuations({
      units: [{ key: 'queued', tracker, planeProven: () => false }],
      config: { maxPasses: 4, budgetMs: 1_000 },
      nowMs: () => 10,
      runPass: async () => undefined,
    });

    expect(summary.continuationPasses).toBe(0);
    expect(tracker.continuationPasses()).toBe(0);
  });

  it('publishes budget exhaustion when admission expires before work starts', async () => {
    const tracker = new SwmCatchupPassTracker();
    tracker.recordPeerRound('peer-a', {
      snapshotsResolved: 1,
      snapshotsTotal: 2,
      manifestComplete: true,
    }, false);
    const stops: Array<{ reason: string; continuationPasses: number }> = [];
    let now = 10;

    const summary = await runSwmCatchupContinuations({
      units: [{ key: 'queued', tracker, planeProven: () => false }],
      config: { maxPasses: 4, budgetMs: 5 },
      nowMs: () => now,
      runPass: async ([candidate]) => {
        now = 15;
        const started = await candidate!.runStarted(async () => {
          throw new Error('expired work must not run');
        });
        expect(started).toEqual({ started: false, reason: 'budget-exhausted' });
      },
      onStop: (stop) => stops.push(stop),
    });

    expect(summary.continuationPasses).toBe(0);
    expect(stops).toEqual([{
      key: 'queued',
      reason: 'budget-exhausted',
      continuationPasses: 0,
    }]);
  });
});

describe('pass budget and cap env contract', () => {
  it('resolves both operator levers into one explicit job config', () => {
    expect(resolveSwmCatchupPassConfig({
      DKG_SWM_CATCHUP_PASS_BUDGET_MS: '0',
      DKG_SWM_CATCHUP_MAX_PASSES: '2',
    })).toEqual({ budgetMs: 0, maxPasses: 2 });
  });

  it('treats a blank assignment as unset, not as zero', () => {
    // `DKG_SWM_CATCHUP_PASS_BUDGET_MS=` is the normal docker-compose/.env shape
    // for "not set", and `Number('')` is 0 — which would silently leave the node
    // with exactly the #2050 behaviour the operator was trying to configure away.
    expect(resolveSwmCatchupPassBudgetMs(undefined)).toBe(DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS);
    expect(resolveSwmCatchupPassBudgetMs('')).toBe(DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS);
    expect(resolveSwmCatchupPassBudgetMs('   ')).toBe(DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS);
  });

  it('honours an explicit zero budget as the kill switch', () => {
    expect(resolveSwmCatchupPassBudgetMs('0')).toBe(0);
  });

  it('falls back on values no operator meant', () => {
    expect(resolveSwmCatchupPassBudgetMs('-1')).toBe(DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS);
    expect(resolveSwmCatchupPassBudgetMs('abc')).toBe(DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS);
    expect(resolveSwmCatchupPassBudgetMs('1.5')).toBe(DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS);
    // An integer by IEEE-754, and an effectively unbounded loop in practice.
    expect(resolveSwmCatchupPassBudgetMs('1e308')).toBe(DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS);
    expect(resolveSwmCatchupPassBudgetMs('300000')).toBe(300_000);
  });

  it('floors the pass cap at 1, because zero passes would skip the walk itself', () => {
    // Unlike the budget, `0` here is a misconfiguration rather than a switch:
    // it would mean catch-up fetches nothing at all. Disabling repeats is the
    // budget's job, so this falls back instead.
    expect(resolveSwmCatchupMaxPasses('0')).toBe(DEFAULT_SWM_CATCHUP_MAX_PASSES);
    expect(resolveSwmCatchupMaxPasses('')).toBe(DEFAULT_SWM_CATCHUP_MAX_PASSES);
    expect(resolveSwmCatchupMaxPasses('-3')).toBe(DEFAULT_SWM_CATCHUP_MAX_PASSES);
    expect(resolveSwmCatchupMaxPasses('1')).toBe(1);
    expect(resolveSwmCatchupMaxPasses('7')).toBe(7);
  });
});
