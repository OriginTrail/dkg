import { describe, expect, it } from 'vitest';
import { catchupReadinessResult } from './_helpers/catchup-readiness-fixtures.js';
import type { CatchupJobResult } from '../src/catchup-runner.js';
import type { CatchupPassDecisionReason, SwmSnapshotCoverage } from '@origintrail-official/dkg-agent';
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

  const many = Array.from({ length: 25 }, (_, i) => `did:dkg:ka:${i}`);
  const formatterCases: readonly {
    readonly name: string;
    readonly coverage: SwmSnapshotCoverage | undefined;
    readonly continuationPasses: number | undefined;
    readonly stopReason?: CatchupPassDecisionReason;
    readonly exact?: string;
    readonly contains?: readonly string[];
    readonly excludes?: readonly (string | RegExp)[];
    readonly namedRefCount?: number;
  }[] = [
    {
      name: 'renders the canonical counts, peer, passes and outstanding work',
      coverage: r26,
      continuationPasses: 2,
      exact: ' (Shared memory: 178/250 snapshots materialized from peer …abcd1234 after 3 passes;'
        + ' 72 not materialized, including did:dkg:ka:one, did:dkg:ka:two (+70 more).)',
      contains: ['Shared memory:'],
      excludes: ['durable'],
    },
    {
      name: 'counts the initial walk as one pass when repeats are zero',
      coverage: r26,
      continuationPasses: 0,
      contains: ['after 1 pass;'],
    },
    {
      name: 'counts the initial walk as one pass when repeats are absent',
      coverage: r26,
      continuationPasses: undefined,
      contains: ['after 1 pass;'],
    },
    {
      name: 'adds nothing when no coverage was observed',
      coverage: undefined,
      continuationPasses: 3,
      exact: '',
    },
    {
      name: 'adds nothing when the selected manifest is fully resolved',
      coverage: { ...r26, snapshotsResolved: 250, missingCount: 0, missingSample: [] },
      continuationPasses: 3,
      exact: '',
    },
    {
      name: 'calls an incomplete manifest a lower bound and says it was not retried',
      coverage: { ...r26, manifestComplete: false },
      continuationPasses: 1,
      contains: ['250 is a lower bound and that peer was not retried.'],
    },
    {
      name: 'caps named identifiers and accounts for omitted refs',
      coverage: { ...r26, missingCount: 90, missingSample: many },
      continuationPasses: 1,
      contains: ['did:dkg:ka:9 (+80 more)'],
      excludes: ['did:dkg:ka:10'],
      namedRefCount: 10,
    },
    {
      name: 'drops the omitted-ref marker when every outstanding ref is named',
      coverage: { ...r26, missingCount: 2, missingSample: ['did:dkg:ka:one', 'did:dkg:ka:two'] },
      continuationPasses: 0,
      contains: ['2 not materialized, including did:dkg:ka:one, did:dkg:ka:two.)'],
      excludes: ['more)'],
    },
    {
      name: 'explains budget exhaustion',
      coverage: r26,
      continuationPasses: 2,
      stopReason: 'budget-exhausted',
      contains: ['Continuation stopped because the time budget was exhausted.'],
    },
    {
      name: 'explains the pass limit',
      coverage: r26,
      continuationPasses: 2,
      stopReason: 'max-passes-reached',
      contains: ['Continuation stopped because the pass limit was reached.'],
    },
    {
      name: 'explains that no capable peers remain',
      coverage: r26,
      continuationPasses: 2,
      stopReason: 'no-capable-peers',
      contains: ['Continuation stopped because no remaining peer reported holding the missing snapshots.'],
    },
    {
      name: 'reports a coverage stall without blaming the clock',
      coverage: r26,
      continuationPasses: 3,
      stopReason: 'coverage-stalled',
      contains: ['a further pass stopped making progress, so more passes would not help'],
      excludes: [/budget|time|timed out|expired/i],
    },
    {
      name: 'omits a stop reason when none was observed',
      coverage: r26,
      continuationPasses: 0,
      excludes: ['Continuation stopped'],
    },
    {
      name: 'omits continue because it is not a stop reason',
      coverage: r26,
      continuationPasses: 0,
      stopReason: 'continue',
      excludes: ['Continuation stopped'],
    },
  ];

  it.each(formatterCases)('$name', ({
    coverage,
    continuationPasses,
    stopReason,
    exact,
    contains,
    excludes,
    namedRefCount,
  }) => {
    const clause = swmShortfallClause(coverage, continuationPasses, stopReason);
    if (exact !== undefined) expect(clause).toBe(exact);
    for (const fragment of contains ?? []) expect(clause).toContain(fragment);
    for (const fragment of excludes ?? []) {
      if (typeof fragment === 'string') expect(clause).not.toContain(fragment);
      else expect(clause).not.toMatch(fragment);
    }
    if (namedRefCount !== undefined) {
      expect(clause.match(/did:dkg:ka:\d+/g)).toHaveLength(namedRefCount);
    }
  });

  it('composes the exact shortfall onto the incomplete-progress terminal', () => {
    const result = swmIncompleteProgress();
    result.diagnostics.sharedMemory.swmCoverage = r26;
    result.diagnostics.sharedMemory.continuationPasses = 2;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: true,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup: { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 },
    });

    expect(classification.jobStatus).toBe('partial');
    expect(classification.error).toBe(INCOMPLETE_PROGRESS + swmShortfallClause(r26, 2));
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
