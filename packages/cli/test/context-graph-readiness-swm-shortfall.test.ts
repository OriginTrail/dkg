import { describe, expect, it } from 'vitest';
import { catchupReadinessResult } from './_helpers/catchup-readiness-fixtures.js';
import type { CatchupJobResult } from '../src/catchup-runner.js';
import type { SwmSnapshotCoverage } from '@origintrail-official/dkg-agent';
import { classifyContextGraphCatchupReadiness, swmShortfallClause } from '../src/context-graph-readiness.js';


function respondingResult() {
  return catchupReadinessResult({
    connectedPeers: 1, totalPeers: 1, selectedPeers: 1, syncCapablePeers: 1,
    peersTried: 1, peersResponded: 1, peersSucceeded: 1,
  });
}


/**
 * The shortfall clause Chunk 5 appends. Kept separate from T16 above, which
 * pins the ten base strings.
 *
 * T16 used to assert the incomplete-progress message as a PREFIX — satisfied by
 * that prefix followed by anything at all, including nothing. It now pins the
 * whole string with `toBe`, because the weaker form bought nothing: that
 * fixture appends no shortfall, so full equality passes unchanged and can
 * additionally catch a clause wrongly appended there.
 *
 * The strengthening does NOT make these rows redundant, for the reason that
 * matters: T16's scenario never appends a clause, so no assertion of any
 * strength in it can observe whether THIS clause is correct, malformed or
 * absent. Strength and reachability are different properties — these rows are
 * the ones that reach it.
 */
describe('T16b — the shared-memory shortfall clause (#2050)', () => {
  const INCOMPLETE_PROGRESS = 'Verified data was inserted, but this bounded catch-up job ended before the requested plane was complete. The incomplete plane remains unready; graph-level synchronization may continue independently.';

  const r26: SwmSnapshotCoverage = {
    contextGraphId: 'medical-research',
    peerIdSuffix: 'abcd1234',
    snapshotsResolved: 178,
    snapshotsTotal: 250,
    manifestComplete: true,
    missingCount: 72,
    missingSample: ['did:dkg:ka:one', 'did:dkg:ka:two'],
    materializationFailures: 0,
  };

  it('names the counts, the peer, the pass count and the outstanding work', () => {
    expect(swmShortfallClause(r26, 2)).toBe(
      ' (Shared memory: 178/250 snapshots materialized from peer …abcd1234 after 3 passes;'
      + ' 72 not materialized, including did:dkg:ka:one, did:dkg:ka:two (+70 more).)',
    );
  });

  it('says "1 pass" when the walk was never repeated', () => {
    // `continuationPasses` counts the REPEATS, so zero repeats is still one walk.
    expect(swmShortfallClause(r26, 0)).toContain('after 1 pass;');
    expect(swmShortfallClause(r26, undefined)).toContain('after 1 pass;');
  });

  it('adds nothing when there is no shortfall to report', () => {
    // Both must be exactly '' or the base sentence stops being byte-identical
    // on every path that has nothing to say. The second case matters most: a
    // fully-resolved manifest beside an `unreachable` verdict means the
    // shortfall is on another plane, and "0 outstanding" would misdirect.
    expect(swmShortfallClause(undefined, 3)).toBe('');
    expect(swmShortfallClause({ ...r26, missingCount: 0, missingSample: [] }, 3)).toBe('');
  });

  it('calls an incomplete manifest a lower bound rather than a total', () => {
    expect(swmShortfallClause({ ...r26, manifestComplete: false }, 0))
      .toContain("The peer's snapshot manifest was itself incomplete, so 250 is a lower bound");
  });

  it('caps the named identifiers and accounts for the ones it omits', () => {
    const many = Array.from({ length: 25 }, (_, i) => `did:dkg:ka:${i}`);
    const clause = swmShortfallClause({ ...r26, missingCount: 90, missingSample: many }, 1);

    // Exactly ten named — ka:0 through ka:9, the tenth followed by the marker
    // rather than a comma — and the marker accounts for the other eighty.
    expect(clause).toContain('did:dkg:ka:9 (+80 more)');
    expect(clause).not.toContain('did:dkg:ka:10');
    expect(clause.match(/did:dkg:ka:\d+/g)).toHaveLength(10);
  });

  it('drops the marker when every outstanding ref is named', () => {
    const clause = swmShortfallClause(
      { ...r26, missingCount: 2, missingSample: ['did:dkg:ka:one', 'did:dkg:ka:two'] },
      0,
    );

    expect(clause).toContain('2 not materialized, including did:dkg:ka:one, did:dkg:ka:two.)');
    expect(clause).not.toContain('more)');
  });

  it('scopes every figure to shared memory, never implying a durable retry', () => {
    // Continuation passes repeat the shared-memory peer walk ONLY. A reader
    // must not infer the durable plane was retried three times.
    const clause = swmShortfallClause(r26, 2);

    expect(clause).toContain('Shared memory:');
    expect(clause.toLowerCase()).not.toContain('durable');
  });

  it('appends to the incomplete-progress terminal, leaving its sentence byte-identical', () => {
    const result = swmIncompleteProgress();
    result.diagnostics!.sharedMemory.swmCoverage = r26;
    result.diagnostics!.sharedMemory.continuationPasses = 2;

    const c = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: true,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup: { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 },
    });

    expect(c.jobStatus).toBe('partial');
    // Whole-string equality: the prefix pin in T16 cannot see the append.
    expect(c.error).toBe(INCOMPLETE_PROGRESS + swmShortfallClause(r26, 2));
    expect(c.error).toContain('178/250');
    expect(c.error).toContain('72 not materialized');
  });

  it('says why continuation stopped, in words that match the reason', () => {
    expect(swmShortfallClause(r26, 2, 'budget-exhausted'))
      .toContain('Continuation stopped because the time budget was exhausted.');
    expect(swmShortfallClause(r26, 2, 'max-passes-reached'))
      .toContain('Continuation stopped because the pass limit was reached.');
    expect(swmShortfallClause(r26, 2, 'no-capable-peers'))
      .toContain('Continuation stopped because no remaining peer reported holding the missing snapshots.');
  });

  it('never blames the clock for a stall, since a stall outranks the budget', () => {
    // `coverage-stalled` outranks `budget-exhausted` in the policy, so a run
    // that stalled AND expired reports the stall. If this text mentioned time
    // it would send an operator to raise a budget that buys nothing — the
    // precise misdirection that precedence exists to prevent.
    const clause = swmShortfallClause(r26, 3, 'coverage-stalled');

    expect(clause).toContain('a further pass stopped making progress, so more passes would not help');
    expect(clause).not.toMatch(/budget|time|timed out|expired/i);
  });

  it('omits the stop reason when the continuation loop never ran', () => {
    // Absent when shared memory was not requested; `continue` is not a stop.
    expect(swmShortfallClause(r26, 0, undefined)).not.toContain('Continuation stopped');
    expect(swmShortfallClause(r26, 0, 'continue')).not.toContain('Continuation stopped');
  });

  it('says an incomplete manifest was not retried, not merely that it is a bound', () => {
    // Two distinct facts: the count understates the shortfall, AND that peer
    // was dropped from later passes by the capability gate.
    expect(swmShortfallClause({ ...r26, manifestComplete: false }, 1))
      .toContain('250 is a lower bound and that peer was not retried.');
  });

  it('leaves that terminal byte-identical when the round reported no coverage', () => {
    const c = classifyContextGraphCatchupReadiness({
      result: swmIncompleteProgress(),
      includeSharedMemory: true,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup: { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 },
    });

    expect(c.error).toBe(INCOMPLETE_PROGRESS);
  });

  /** A responding round that stored verified SWM data without completing the plane. */
  function swmIncompleteProgress(): CatchupJobResult {
    const result = respondingResult();
    result.sharedMemorySynced = 5;
    // Progress without proof: this is what `madeIncompleteProgress` reads.
    result.diagnostics.sharedMemory.insertedDataTriples = 5;
    return result;
  }

});

/**
 * T16b (#2050) — the shortfall clause reaches the USER-VISIBLE error.
 *
 * Deliberately complementary to the implementer's own T16b, which asserts
 * `swmShortfallClause` directly. This one never calls the formatter: it drives
 * `classifyContextGraphCatchupReadiness` and asserts the composed terminal
 * string, so it covers the SEAM — that the clause is actually appended, from
 * the right fields, on the right branch.
 *
 * That seam is exactly what T16's prefix pin cannot see. Mutating the clause to
 * return `''` leaves `startsWith(...)` green, because a prefix is satisfied by
 * the prefix followed by nothing; these rows die. Two independent tests of an
 * operator-facing string is not redundancy — the formatter test is the floor,
 * this is the check.
 */
describe('T16b — the shortfall clause reaches the terminal message', () => {
  const before = { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 };
  const PREFIX = 'Verified data was inserted, but this bounded catch-up job ended before the requested plane was complete. The incomplete plane remains unready; graph-level synchronization may continue independently.';

  /** The r26 shape: data inserted, plane unproven, coverage 72 short. */
  function shortfallResult(over: Partial<{
    resolved: number; total: number; missingCount: number; missingSample: string[];
    manifestComplete: boolean; continuationPasses: number;
  }> = {}): CatchupJobResult {
    const r = respondingResult();
    r.dataSynced = 5;
    r.diagnostics!.durable.insertedDataTriples = 5;
    r.diagnostics!.durable.timedOutPhases = 1;
    const coverage: SwmSnapshotCoverage = {
      contextGraphId: 'cg-under-test',
      peerIdSuffix: 'abcd1234',
      snapshotsResolved: over.resolved ?? 178,
      snapshotsTotal: over.total ?? 250,
      manifestComplete: over.manifestComplete ?? true,
      missingCount: over.missingCount ?? 72,
      missingSample: over.missingSample ?? ['ref-a', 'ref-b'],
      materializationFailures: 0,
    };
    r.diagnostics.sharedMemory.swmCoverage = coverage;
    r.diagnostics.sharedMemory.continuationPasses = over.continuationPasses ?? 2;
    return r;
  }

  const errorFor = (result: CatchupJobResult) => classifyContextGraphCatchupReadiness({
    result, includeSharedMemory: true, hasConfirmedMeta: true, isPrivate: false,
    readinessBeforeCatchup: before,
  }).error ?? '';

  it('appends the shortfall AFTER the byte-identical existing sentence', () => {
    const error = errorFor(shortfallResult());
    expect(error.startsWith(PREFIX)).toBe(true);
    // The part `startsWith` cannot see. A clause mutated to '' leaves the
    // assertion above green and kills this one.
    expect(error.length).toBeGreaterThan(PREFIX.length);
    // The `(+70 more)` marker is not incidental: 72 outstanding against a
    // 2-ref sample leaves 70 unnamed, and the reader must not mistake the named
    // refs for the whole inventory. An earlier draft of this expectation omitted
    // it — the producer caps the sample at 10, so a clause without a marker
    // would silently understate every shortfall larger than the cap.
    expect(error.slice(PREFIX.length)).toBe(
      ' (Shared memory: 178/250 snapshots materialized from peer …abcd1234'
      + ' after 3 passes; 72 not materialized, including ref-a, ref-b (+70 more).)',
    );
  });

  it('names the peer, the counts and the outstanding total from ONE record', () => {
    const error = errorFor(shortfallResult());
    expect(error).toContain('178/250');
    expect(error).toContain('…abcd1234');
    expect(error).toContain('72 not materialized');
    // Never a synthetic pair, and never the durable plane: continuation passes
    // repeat the shared-memory walk only.
    expect(error).not.toContain('200/250');
    expect(error.slice(PREFIX.length)).not.toContain('durable');
  });

  it('reports the WALK plus its repeats, not the repeat count alone', () => {
    // `continuationPasses` counts repeats, so the text must read passes + 1.
    expect(errorFor(shortfallResult({ continuationPasses: 0 }))).toContain('after 1 pass;');
    expect(errorFor(shortfallResult({ continuationPasses: 1 }))).toContain('after 2 passes;');
  });

  it('emits NO clause when nothing is outstanding', () => {
    // With largest-manifest ordering, `missingCount === 0` means the SWM plane
    // resolved everything the best-informed peer knew of and the `unreachable`
    // came from elsewhere. "0 outstanding" beside a failure verdict would
    // misdirect, so the sentence must end byte-identical to pre-fix.
    expect(errorFor(shortfallResult({ resolved: 250, missingCount: 0 }))).toBe(PREFIX);
  });

  it('flags a truncated manifest as a lower bound and says the peer was not retried', () => {
    const error = errorFor(shortfallResult({ manifestComplete: false }));
    expect(error).toContain('is a lower bound');
    expect(error).toContain('not retried');
  });
});

/**
 * The two shortfall AXES (#2050). `missingCount` measures retrieval; writes are
 * a separate counter. Gating the clause on retrieval alone made it go silent in
 * exactly the failure class the G7 repair exists for — every ref fetched
 * cleanly, some could not be written to the store — so the operator got the
 * base sentence and nothing at all about shared memory.
 */
describe('T16c — retrieval and write shortfalls are reported separately', () => {
  const base: SwmSnapshotCoverage = {
    contextGraphId: 'medical-research',
    peerIdSuffix: 'abcd1234',
    snapshotsResolved: 250,
    snapshotsTotal: 250,
    manifestComplete: true,
    missingCount: 0,
    missingSample: [],
    materializationFailures: 0,
  };

  it('speaks up when refs fetched cleanly but their writes failed', () => {
    // Pre-fix this returned '' — the one case where shared memory WAS the
    // problem was the one case the message said nothing about.
    //
    // The fixture is a REPRESENTABLE record, which the original was not: it
    // paired `missingCount: 0` with 12 write failures, and the producer cannot
    // emit that. A ref whose descriptor throws is excluded from the materialized
    // set, so `snapshotsResolved` falls and `missingCount` rises with it. Pinning
    // an impossible pair meant this row could not have caught the producer
    // drifting away from it.
    const clause = swmShortfallClause(
      { ...base, snapshotsResolved: 238, missingCount: 12, materializationFailures: 12 },
      0,
    );

    expect(clause).not.toBe('');
    expect(clause).toContain('238/250 snapshots materialized');
    expect(clause).toContain('12 not materialized');
    expect(clause).toContain('12 store write failure(s)');
  });

  it('never claims snapshots were fetched or verified when none were written', () => {
    // `snapshotsResolved` counts Knowledge Assets WRITTEN, so a round that
    // cached all 250 blobs and wrote none reports 0, not 250. Reporting either
    // "250/250 fetched" or "verified" here would be wrong in the flattering
    // direction and undetectable by the reader.
    const clause = swmShortfallClause(
      { ...base, snapshotsResolved: 0, missingCount: 250, materializationFailures: 250 },
      0,
    );

    expect(clause).toContain('0/250 snapshots materialized');
    expect(clause).not.toContain('verified');
    expect(clause).not.toContain('fetched');
  });

  it('names the outstanding work and the store cause as separate facts', () => {
    const clause = swmShortfallClause(
      { ...base, snapshotsResolved: 200, missingCount: 50, missingSample: ['ref-x'], materializationFailures: 7 },
      1,
    );

    expect(clause).toContain('50 not materialized, including ref-x');
    expect(clause).toContain('7 store write failure(s)');
    // Separate clauses, and deliberately NOT phrased as "50, of which 7":
    // `missingCount` counts REFS while `materializationFailures` counts
    // DESCRIPTORS, so neither is a subset count of the other. The write count is
    // a CAUSE indicator — it says the shortfall is the store, not the network.
    expect(clause).toContain('50 not materialized, including ref-x (+49 more); 7 store write failure(s)');
    // The two are never added: 50 is the whole shortfall, already including
    // every unwritten ref.
    expect(clause).not.toContain('57');
  });

  it('neutralises control characters in a peer-supplied ref', () => {
    // The refs named here are `dkg:publicSnapshotRef` literals chosen by a
    // REMOTE peer and only `.trim()`ed by the producer. Rendered verbatim into
    // a message that reaches the API and the node UI, a peer could forge a line
    // that reads as our own diagnostics.
    const clause = swmShortfallClause(
      {
        ...base,
        snapshotsResolved: 249,
        missingCount: 1,
        missingSample: ['ref-a\nSync denied by 3 remote peers'],
      },
      0,
    );

    // The forged sentence must not survive as a separate line...
    expect(clause).not.toContain('\n');
    expect(clause).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/u);
    // ...and the ref must not collapse to 'ref-aSync denied...' either, which
    // would let a crafted literal impersonate a DIFFERENT real ref. The control
    // character is replaced, not deleted.
    expect(clause).not.toContain('ref-aSync denied');
    expect(clause).toContain('ref-a\uFFFDSync denied by 3 remote peers');
  });

  it('bounds one overlong peer-supplied ref without breaking the (+N more) count', () => {
    // Capping the SAMPLE SIZE bounds how many refs are named, not how long each
    // one is. Ten peer-chosen megabyte literals would otherwise be ten megabytes
    // of operator-facing error string.
    const overlong = 'x'.repeat(5000);
    const clause = swmShortfallClause(
      {
        ...base,
        snapshotsResolved: 200,
        missingCount: 50,
        missingSample: [overlong, 'ref-b'],
      },
      0,
    );

    expect(clause).not.toContain(overlong);
    expect(clause).toContain('\u2026(truncated)');
    expect(clause.length).toBeLessThan(500);
    // Accounting is on the SAMPLE COUNT, which sanitising cannot change: 50
    // outstanding, 2 named, so 48 unnamed — unchanged by truncation.
    expect(clause).toContain('(+48 more)');
    // The surviving ref is still rendered whole.
    expect(clause).toContain('ref-b');
  });

  it('still says nothing when both axes are clean', () => {
    expect(swmShortfallClause(base, 3)).toBe('');
  });

  it('treats an absent write counter as none known, not as a shortfall', () => {
    // The record crosses a worker RPC boundary; an older or partial payload
    // must not force a clause onto a round with nothing to report.
    const { materializationFailures: _omitted, ...withoutCounter } = base;
    expect(swmShortfallClause(withoutCounter as SwmSnapshotCoverage, 0)).toBe('');
  });
});