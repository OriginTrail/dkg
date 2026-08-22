import { describe, expect, it } from 'vitest';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  evaluateAgentProfileHeadAdvanceV1,
  evaluateAgentProfileSameSequenceTombstoneAdvanceV1,
  type AgentProfileAuthorityTransitionV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileSameSequenceAppliedRowV1,
  type AgentProfileTombstoneHeadObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  CORE_ACCEPTED_LINEAGE_V1,
  CORE_CLOCK_MS_V1,
  CORE_HISTORICAL_ROOTS_V1,
} from './helpers/authority-verdict-diff-core-evidence-v1.js';
import {
  CORE_CHAIN_V1,
  CORE_CURRENT_DIGEST_V1,
  CORE_CURRENT_HEAD_V1,
  CORE_MINT_GRAPH_V1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  mintStorageSummaryForHeadV1,
  prepareStorageDriverV1,
  requireStorageSummaryForHeadV1,
} from './helpers/authority-verdict-diff-storage-driver-v1.js';
import { rotatedActiveHeadV1 } from './helpers/system-record-active-replacement-fixture.js';
import { mintAgentProfileTombstoneClosureV1 } from './helpers/system-record-terminal-replacement-fixture.js';
import { buildTombstoneHeadFromPredecessorV1 } from './helpers/tombstone-head-fixture-v1.js';

/**
 * THE SAME-SEQUENCE TOMBSTONE DISJUNCT.
 *
 * ADR 0002 :112-114 makes a tombstone dominate every active head in its
 * sequence "regardless of delivery order OR VERSION", and :126 resolves
 * active/tombstone conflicts to the tombstone. Core implements that clause for
 * clause. Storage answered the same question from two integers and returned
 * `stale` -- and `stale` is SETTLED, so the revocation was discarded permanently
 * rather than retried.
 *
 * THE ARRANGEMENT MATTERS, AND GETTING IT WRONG LOOKS LIKE AN ABSENT FIXTURE.
 * The predecessor must NOT be the applied row: when it is, the derivation
 * short-circuits to `advance` upstream at the exact-match conjunction, which is
 * the ordinary tombstone apply and a different population entirely. The chain's
 * BASE head (sequence 2, version 0) is the predecessor; the applied row is the
 * current head (sequence 2, version 2); the candidates sit at versions 1, 2 and
 * 3 against it.
 *
 * THE ARRANGEMENT IS FORCED, NOT CHOSEN, and a reader asking "why this
 * predecessor?" deserves the answer, because the obvious alternative silently
 * measures the ordinary apply instead. The disjunct requires the candidate's
 * sequence to equal the applied lineage length; of the sequence-2 active heads
 * THIS FIXTURE SHIPS, the only other one IS the applied row, which lands in the
 * short-circuit by construction.
 *
 * THAT USED TO READ "only two sequence-2 active heads exist... there is no
 * second arrangement to cross-check against", AND IT WAS FALSE IN BOTH CLAUSES.
 * A disagreeing sequence-2 active head is constructible from one field, it is
 * built a few blocks below, and the identity rows drive it. The true and
 * narrower statement is the one worth having: every sequence-2 head this fixture
 * ships agrees on issuer, root and accepted-transition digest, so no cell in the
 * band varies record identity -- which is exactly how the identity precondition
 * could go missing here without a single one of them noticing.
 *
 * SO REPRESENTATIVENESS COMES FROM THE BRANCH'S NARROWNESS, NOT THE FIXTURE'S
 * REALISM. The comparison consults exactly two things -- sequence equality and
 * the version relation -- while these rows vary the version across all three
 * relations and the applied status across all three values. The arrangement's
 * peculiarities (which predecessor, the shared owned-subject table, the specific
 * sequence) cannot influence the answer because the branch never reads them.
 * Measured rather than argued: disabling the version comparison moves ALL THREE
 * lower cells and leaves the other six untouched, so these states reach this
 * branch and are not being answered by an upstream gate.
 *
 * THESE ROWS ARE THE AFTER-HALF. They were first written asserting the
 * pre-routing behaviour, measured green against it, and changed only by the
 * routing landing -- the before column is kept in the movement table below so
 * the change is legible rather than merely claimed.
 */
/**
 * WHY A TOMBSTONE NAMING THE CHAIN BASE MINTS AT ALL, which is this suite's own
 * load-bearing coincidence rather than the shared builder's.
 *
 * The closure resolves the predecessor through the tombstone's OWN
 * `previousHeadDigest` against the ancestry, while the mint graph supplies only
 * the owned-subject TABLE. That table is correct for either head because the
 * current head is a spread of the base with `version` and `previousHeadDigest`
 * overridden, so the two share `ownedSubjectTableDigest` and `rootSubject`. If
 * those ever diverge this construction breaks with a refusal phrased like a
 * domain error rather than a fixture one, which is why the coincidence is
 * written down rather than relied on silently.
 *
 * The builder itself is shared with the late-tombstone suite; the version being
 * a PARAMETER is the unlock, and its reasoning lives with the builder.
 */
const tombstoneOfV1 = buildTombstoneHeadFromPredecessorV1;

/** Flips the leading character, which unbinds a field without reshaping it. */
function flipLeadV1(value: string): string {
  const prefixed = value.startsWith('0x');
  const body = prefixed ? value.slice(2) : value;
  return `${prefixed ? '0x' : ''}${body[0] === '0' ? '1' : '0'}${body.slice(1)}`;
}

/**
 * The applied row the seam hands core, built from the SAME constants the driver
 * materialises its row from.
 *
 * The placement pin below asserts those constants (sequence 2, version 2), so
 * the correspondence is checked rather than assumed -- which matters because
 * this object is what makes the pair-pin's first element mean anything.
 */
/**
 * The applied row every cell below decides against.
 *
 * The identity operands are taken FROM THE APPLIED HEAD rather than written as
 * literals, because that is what a receiver supplies and what makes the cells
 * same-record by construction: the whole locked band is one authority branch, so
 * every row here satisfies the identity conjuncts and none of them is what these
 * cells measure. A cell that wanted an identity MISMATCH has to say so, and the
 * rows that do are grouped separately below.
 */
const APPLIED_ROW_V1: AgentProfileSameSequenceAppliedRowV1 = Object.freeze({
  status: 'active',
  authoritySequence: CORE_CURRENT_HEAD_V1.authoritySequence,
  version: CORE_CURRENT_HEAD_V1.version,
  headDigest: CORE_CURRENT_DIGEST_V1,
  currentRoot: CORE_CURRENT_HEAD_V1.rootSubject,
  acceptedTransitionDigest: CORE_CURRENT_HEAD_V1.acceptedTransitionDigest,
});

describe('the same-sequence tombstone disjunct (ADR 0002 :112-114, :126)', () => {
  const predecessor = CORE_CHAIN_V1.base as unknown as AgentProfileHeadObjectV1;

  it('places the construction where the routed population actually lives', () => {
    const candidate = tombstoneOfV1(predecessor);
    expect({
      predecessorSequence: predecessor.authoritySequence,
      predecessorVersion: predecessor.version,
      candidateSequence: candidate.authoritySequence,
      candidateVersion: candidate.version,
      appliedSequence: CORE_CURRENT_HEAD_V1.authoritySequence,
      appliedVersion: CORE_CURRENT_HEAD_V1.version,
      // The predecessor is NOT the applied row, which is what keeps this out of
      // the exact-match short-circuit.
      predecessorIsAppliedRow:
        computeAgentProfileHeadObjectDigestV1(predecessor)
          === computeAgentProfileHeadObjectDigestV1(
            CORE_CURRENT_HEAD_V1 as unknown as AgentProfileHeadObjectV1,
          ),
    }).toStrictEqual({
      predecessorSequence: '2',
      predecessorVersion: '0',
      candidateSequence: '2',
      candidateVersion: '1',
      appliedSequence: '2',
      appliedVersion: '2',
      predecessorIsAppliedRow: false,
    });
  });

  /**
   * ALL THREE APPLIED STATUSES, because the discard did not read status.
   *
   * The upstream gate screens `quarantined` plus conflict evidence, slots and
   * overflow -- nothing else -- so a tombstoned or shadow-dirty row reached that
   * comparison exactly as an active one did and was discarded the same way. The
   * routing changes all nine, and for two different reasons: the active row
   * gains core's verdict, while the other six stop being decided here at all.
   *
   * THE MOVEMENT, PINNED BEFORE THE ROUTING EXISTED. These exact nine cells were
   * measured green against the pre-routing tree asserting the BEFORE column, and
   * only the routing changed them.
   *
   *   cell             BEFORE                              AFTER
   *   lower/active     stale                               ready (advance)
   *   lower/tombstone  stale                               deferred|same-sequence-tombstone-conflict
   *   lower/dirty      stale                               deferred|undecided-authority-classification
   *   equal/active     deferred|authority-history-mismatch UNCHANGED
   *   equal/tombstone  deferred|authority-history-mismatch deferred|same-sequence-tombstone-conflict
   *   equal/dirty      deferred|authority-history-mismatch deferred|undecided-authority-classification
   *   higher/active    deferred|authority-history-mismatch ready (advance)
   *   higher/tombstone deferred|authority-history-mismatch deferred|same-sequence-tombstone-conflict
   *   higher/dirty     deferred|authority-history-mismatch deferred|undecided-authority-classification
   *
   * = 1 stale->advance, 1 deferred->advance, 2 stale->deferred, 4 reason-only,
   * 1 unchanged.
   *
   * `ready` RATHER THAN `advance` IS A LAYER DIFFERENCE, NOT A DISAGREEMENT. The
   * classifier returns `advance`; the derivation this driver observes turns that
   * into a `ready` plan. Both are true at their own layer, and this row asserts
   * the one it can actually see.
   *
   * THE TWO ADVANCING CELLS DELETE A PROJECTION, which is the point rather than
   * a side effect: ADR :112-114 licenses both regardless of version, and each
   * candidate arrives verified and bound to its exact predecessor. Only the
   * arithmetic was refusing them.
   */
  it('routes the whole disjunct through core, over all nine cells', async () => {
    const driver = await prepareStorageDriverV1();
    const statuses = ['active', 'tombstone', 'dirty'] as const;
    // Applied row is the current head at version 2; every candidate is built off
    // the version-0 base, so the relation is set by the candidate's version.
    const relations = { lower: '1', equal: '2', higher: '3' } as const;

    const measured: Record<string, string> = {};
    for (const [relation, version] of Object.entries(relations)) {
      const candidate = tombstoneOfV1(predecessor, version);
      // eslint-disable-next-line no-await-in-loop
      const summary = await requireStorageSummaryForHeadV1(candidate);
      for (const appliedStatus of statuses) {
        const outcome = driver.drive({
          snapshotForm: { kind: 'present', appliedStatus },
          operation: 'tombstone',
          candidate,
          summary,
        } as never) as { readonly verdict?: string; readonly reason?: string };
        measured[`${relation}/${appliedStatus}`] =
          outcome.reason === undefined ? String(outcome.verdict) : `${outcome.verdict}|${outcome.reason}`;
      }
    }

    const tombstoneConflict = 'deferred|same-sequence-tombstone-conflict';
    const undecidedRow = 'deferred|undecided-authority-classification';
    expect(measured).toStrictEqual({
      // THE REVOCATION, HONOURED. This is the cell the finding was about: a
      // verified tombstone below the applied version, discarded as settled.
      'lower/active': 'ready',
      // The other two statuses stop being decided here at all, and they defer
      // under DIFFERENT reasons because the two gaps are different -- one is an
      // honest unknown, the other a choice with a named cost.
      'lower/tombstone': tombstoneConflict,
      'lower/dirty': undecidedRow,
      // THE UNCHANGED CELL. Its mechanism is pinned as a pair below, because
      // this value alone cannot witness it.
      'equal/active': 'deferred|authority-history-mismatch',
      'equal/tombstone': tombstoneConflict,
      'equal/dirty': undecidedRow,
      // The second cell that deletes a projection, licensed by the same ADR
      // clause and scoped to the applied-head-is-not-the-predecessor shape.
      'higher/active': 'ready',
      'higher/tombstone': tombstoneConflict,
      'higher/dirty': undecidedRow,
    });
  });

  /**
   * THE UNCHANGED CELL, PINNED AS A PAIR, BECAUSE ONE VALUE CANNOT WITNESS ITS
   * MECHANISM.
   *
   * `deferred|authority-history-mismatch` is also the classifier's general
   * fall-through, with several producers. A single-value pin would therefore
   * read "unchanged, mechanism intact" in exactly the two cases that would
   * matter most: the cell no longer being routed at all, or falling through for
   * an unrelated reason. So the pin is the PAIR the verdict-diff table is
   * natively shaped in -- core's answer beside storage's.
   *
   * What it enforces: the cell is unchanged BECAUSE the fallback fired on core's
   * `quarantine | head-fork`, not because nothing asked core. When the filed ADR
   * question moves core's answer for an equal-version active/tombstone conflict,
   * this pair's FIRST element moves and this test fails naming the reason, which
   * is what an instrument is for.
   */
  it('holds the equal-version cell by declining a verdict, not by never asking', async () => {
    const candidate = tombstoneOfV1(predecessor, '2');
    const summary = await requireStorageSummaryForHeadV1(candidate);
    const driver = await prepareStorageDriverV1();
    const storage = driver.drive({
      snapshotForm: { kind: 'present', appliedStatus: 'active' },
      operation: 'tombstone',
      candidate,
      summary,
    } as never) as { readonly verdict?: string; readonly reason?: string };

    const core = evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
      candidate,
      Object.freeze({ tombstonePredecessor: summary.tombstonePredecessor }) as never,
      APPLIED_ROW_V1,
    );

    expect({
      core: 'reason' in core ? `${core.decision}|${core.reason}` : core.decision,
      storage: `${storage.verdict}|${storage.reason}`,
    }).toStrictEqual({
      core: 'quarantine|head-fork',
      storage: 'deferred|authority-history-mismatch',
    });
  });

  /**
   * THE ENTRY'S PINNED CONTRACT: BINDINGNESS IS DECIDED BEFORE ANY VERSION IS
   * READ.
   *
   * The seam calls the entry for every routed cell and maps its answer, which is
   * sound only if the entry answers the binding question itself rather than
   * leaving the caller to model when it runs. That ordering is stated as an
   * invariant on the rule and asserted here: an unbound candidate answers with
   * the SAME reject at every version relation, so the version axis collapses on
   * that row instead of producing three answers a caller would have to tell
   * apart.
   *
   * The unbinding is the `previousHeadDigest` conjunct -- the candidate names the
   * chain base while the predecessor supplied is the current head. Both objects
   * are individually well-formed, so this is a genuine binding failure rather
   * than a malformed operand, which is the distinction that keeps it a `reject`
   * rather than a throw.
   */
  it('answers an unbound candidate identically at every version relation', () => {
    const answers = ['1', '2', '3'].map((version) => {
      const decision = evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        tombstoneOfV1(predecessor, version),
        Object.freeze({ tombstonePredecessor: CORE_CURRENT_HEAD_V1 }) as never,
        APPLIED_ROW_V1,
      );
      return 'reason' in decision ? `${decision.decision}|${decision.reason}` : decision.decision;
    });

    expect(answers).toStrictEqual([
      'reject|tombstone lacks its exact verified active predecessor',
      'reject|tombstone lacks its exact verified active predecessor',
      'reject|tombstone lacks its exact verified active predecessor',
    ]);
    // Stated as the property rather than left to a reader of three equal
    // strings: ONE answer, not three that happen to agree.
    expect(new Set(answers).size).toBe(1);
  });

  /**
   * THE ENTRY REFUSES WHAT ITS NAME DOES NOT COVER, AND EACH REFUSAL IS ITS OWN
   * ROW.
   *
   * Every one of these is unreachable from the seam -- the facts assert pins the
   * candidate to a tombstone, the applied sequence handed to core is the string
   * the caller's own guard matched, and the classification gate leaves only rows
   * the entry decides against. That is exactly why they are tested HERE: a guard
   * whose only justification is that its caller is careful is a guard nothing
   * proves, and a caller can always cast.
   *
   * They are `reject`s rather than throws because each operand is well-formed;
   * the question is only whether this rule answers for it. A malformed operand
   * still throws.
   */
  it('refuses a candidate or an applied row its rule does not answer for', () => {
    const answer = (
      candidate: AgentProfileHeadObjectV1,
      applied: AgentProfileSameSequenceAppliedRowV1,
    ): string => {
      const decision = evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        candidate as never,
        Object.freeze({ tombstonePredecessor: predecessor }) as never,
        applied,
      );
      return 'reason' in decision ? `${decision.decision}|${decision.reason}` : decision.decision;
    };
    const tombstone = tombstoneOfV1(predecessor, '1');

    expect({
      activeCandidate: answer(
        CORE_CURRENT_HEAD_V1 as unknown as AgentProfileHeadObjectV1,
        APPLIED_ROW_V1,
      ),
      sequenceMismatch: answer(
        tombstone,
        Object.freeze({ ...APPLIED_ROW_V1, authoritySequence: '3' }),
      ),
      quarantinedRow: answer(
        tombstone,
        Object.freeze({ ...APPLIED_ROW_V1, status: 'quarantined' }),
      ),
      dirtyRow: answer(tombstone, Object.freeze({ ...APPLIED_ROW_V1, status: 'dirty' })),
    }).toStrictEqual({
      activeCandidate: 'reject|same-sequence tombstone entry requires a tombstone candidate',
      sequenceMismatch:
        'reject|same-sequence tombstone entry requires a candidate at the applied sequence',
      quarantinedRow:
        'reject|same-sequence tombstone entry requires an active or tombstone applied row',
      dirtyRow: 'reject|same-sequence tombstone entry requires an active or tombstone applied row',
    });
  });

  /**
   * THE OPERAND BOUNDARY REFUSES AT RUN TIME, NOT ONLY IN THE TYPE CHECKER.
   *
   * The compiled export lane pins the two operand shapes, and that protects a
   * TypeScript caller. It does nothing for a JavaScript one, and nothing for a
   * TypeScript one arriving through a cast -- which every driver in this suite
   * does. So the exact-record snapshots are only a boundary if something proves
   * they refuse.
   *
   * THE FIRST CASE IS THE ONE WORTH HAVING. Two entries now take evidence, and
   * their shapes differ by a single optional key, so the confusable mistake is
   * not an invented field -- it is passing the OTHER entry's evidence object. It
   * would compile at every cast boundary and hand this rule an operand it does
   * not read.
   *
   * These are THROWS, and the distinction from the reject row above is
   * load-bearing: a malformed operand throws, while a well-formed operand this
   * rule does not answer for returns a `reject`. Collapsing the two would either
   * crash on a legitimate "not my rule" or hand a verdict to malformed input.
   */
  it('refuses operands that are not its own, at run time', () => {
    const candidate = tombstoneOfV1(predecessor, '1');
    const evidence = Object.freeze({ tombstonePredecessor: predecessor });
    const refusalOf = (call: () => unknown): string => {
      try {
        call();
        return 'ACCEPTED';
      } catch (error) {
        return (error as Error).message;
      }
    };

    expect({
      otherEntrysEvidence: refusalOf(() => evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        candidate,
        {
          tombstonePredecessor: predecessor,
          retainedTransition: { transition: {}, nowMs: 1 },
        } as never,
        APPLIED_ROW_V1,
      )),
      topLevelClock: refusalOf(() => evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        candidate,
        { tombstonePredecessor: predecessor, nowMs: 1 } as never,
        APPLIED_ROW_V1,
      )),
      appliedRowExtraKey: refusalOf(() => evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        candidate,
        evidence as never,
        { ...APPLIED_ROW_V1, head: candidate } as never,
      )),
      appliedRowMissingKey: refusalOf(() => evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        candidate,
        evidence as never,
        { status: 'active', authoritySequence: '2', version: '2' } as never,
      )),
      appliedRowUnknownStatus: refusalOf(() => evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        candidate,
        evidence as never,
        { ...APPLIED_ROW_V1, status: 'retired' } as never,
      )),
    }).toStrictEqual({
      otherEntrysEvidence: 'same-sequence tombstone evidence has unknown or missing fields',
      topLevelClock: 'same-sequence tombstone evidence has unknown or missing fields',
      appliedRowExtraKey: 'same-sequence applied row has unknown or missing fields',
      appliedRowMissingKey: 'same-sequence applied row has unknown or missing fields',
      appliedRowUnknownStatus: '[system-record-schema] same-sequence applied row status is invalid',
    });
  });

  /**
   * ADR :127-128 AGAINST A TOMBSTONED APPLIED ROW -- THE ARM THE SEAM DEFERS.
   *
   * The three-population form, stated by construction. The seam's classification
   * precondition defers every applied-tombstone cell, so `stale` and this
   * `accept` are unreachable through storage today; at the entry they are
   * ordinary calls, and leaving them untested would mean the arm the seam writes
   * for the day that gap closes has never been run.
   *
   * The lowest tombstone wins and the head digest breaks a tie. The equal-version
   * expectation is DERIVED from the digest ordering rather than looked up, so it
   * asserts the tie-break rule instead of recording whichever way this fixture's
   * two digests happen to sort.
   */
  it('resolves a tombstone against a tombstoned applied row by lowest-then-digest', () => {
    const appliedTombstoneRow: AgentProfileSameSequenceAppliedRowV1 = Object.freeze({
      ...APPLIED_ROW_V1,
      status: 'tombstone',
    });
    const answer = (version: string): string => {
      const decision = evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        tombstoneOfV1(predecessor, version),
        Object.freeze({ tombstonePredecessor: predecessor }) as never,
        appliedTombstoneRow,
      );
      return 'reason' in decision ? `${decision.decision}|${decision.reason}` : decision.decision;
    };
    const equalCandidateDigest = computeAgentProfileHeadObjectDigestV1(
      tombstoneOfV1(predecessor, '2'),
    );

    expect({
      lower: answer('1'),
      equal: answer('2'),
      higher: answer('3'),
    }).toStrictEqual({
      lower: 'accept',
      equal: equalCandidateDigest < CORE_CURRENT_DIGEST_V1 ? 'accept' : 'stale',
      higher: 'stale',
    });
    // The tie-break only means something if the two digests actually differ.
    expect(equalCandidateDigest).not.toBe(CORE_CURRENT_DIGEST_V1);
  });

  /**
   * WHY THE REJECT ARM CANNOT FIRE THROUGH STORAGE TODAY, AS A RUN RATHER THAN
   * AN ARGUMENT.
   *
   * The seam maps core's `reject` onto `deferred | tombstone-predecessor-unbound`
   * and no cell reaches it, because an unbound tombstone cannot carry the
   * verified authority summary this package requires. That is not an absence of
   * search: the verification closure runs THE SAME
   * `isTombstoneBoundToPredecessorV1` predicate over the heads it parses before
   * it will mint a summary at all, so the producer of the evidence storage
   * demands enforces exactly the conjunction core's rule tests.
   *
   * ALL TEN CONJUNCTS ARE ATTEMPTED INDIVIDUALLY BELOW, across ELEVEN rows --
   * the version conjunct needs two, for the reason given under the mutant
   * heading -- and every one is refused upstream of the classifier by one of two
   * gates: the head codec, which refuses four as malformed heads, or the
   * closure, which refuses the other seven at mint. The bound control mints in
   * the same run, so these refusals measure the system rather than a broken
   * construction.
   *
   * THE PREDICATE HAS TEN CONJUNCTS AND THIS SUITE SAID NINE FOR SEVERAL ROUNDS.
   * The count was taken by listing the field comparisons and missing that the
   * version relation is a conjunct too -- the same omission that then let it be
   * argued out of the enumeration. A count stated in prose is not asserted by
   * anything, so this one is derived instead: nine `&&` operators in the
   * predicate means ten conjuncts, and the map below covers all ten.
   *
   * THE VERSION ROW ALMOST SHIPPED AS "REASONED, NOT MEASURED", AND THAT WOULD
   * HAVE BEEN WRONG IN AN INSTRUCTIVE WAY. The argument was: against a
   * version-zero predecessor the only non-greater version is zero, and the codec
   * refuses a version-zero head carrying a `previousHeadDigest`, so a different
   * rule pre-empts the one under test. Every clause of that is true and it is
   * scoped to the PREDECESSOR THAT WAS CHOSEN, not to the conjunct. Pick a
   * predecessor above zero -- the version-2 active head -- and a version-1
   * tombstone violates strictly-greater with neither head at zero. The codec
   * accepts it and the closure refuses it with the same predecessor-not-exact
   * message as the other four. Reachability is not strictness, but neither is a
   * sound argument about one construction a statement about the population.
   *
   * THE MUTANT THAT ROW WAS ADDED FOR SURVIVED IT, AND THAT IS WHY THERE ARE
   * TWO. Relaxing `>` to `>=` in the binding predicate is the one-character edit
   * that would let a tombstone bind a predecessor at its OWN version -- the
   * equal-version confusion the open ADR question turns on. The row above was
   * justified by that mutant and does not kill it: it violates strictly-greater
   * FROM BELOW, where the two operators agree, so with `>=` applied in src and
   * in the rebuilt dist the enumeration stayed GREEN on all ten rows. The
   * equal-version row is the discriminator, and it was proven to be one: under
   * the same mutant it alone moves, from `closure-mint` to REACHED THE
   * CLASSIFIER, while every other row holds.
   *
   * The general form is worth more than the instance. A row justified by a
   * mutant has to be RUN against that mutant, because a construction chosen to
   * violate a conjunct is not automatically a construction that separates the
   * operator expressing it.
   *
   * AND THIS TEST IS A TRIPWIRE FOR ANOTHER MODULE'S GATE, not only a record of
   * today's behaviour. The unconstructibility it proves rests on the verification
   * closure applying the binding predicate before it mints. If that gate is ever
   * relaxed, these heads begin to mint and every refusal below turns red at once.
   */
  it('refuses every unbound construction before the classifier is reached', async () => {
    const control = await mintStorageSummaryForHeadV1(tombstoneOfV1(predecessor, '1'));
    expect(control.minted).toBe(true);

    const p = predecessor as unknown as Record<string, string>;
    const unbound = (overrides: Record<string, unknown>) =>
      () => tombstoneOfV1(predecessor, '1', overrides);
    // A THUNK PER LEVER, because one conjunct cannot be reached by perturbing a
    // field: strictly-greater is violated by the PREDECESSOR CHOICE, not by an
    // override, so it needs to build its own head.
    const levers: ReadonlyArray<readonly [string, () => AgentProfileTombstoneHeadObjectV1]> =
      Object.freeze([
        ['previousHeadDigest', unbound({
          previousHeadDigest: flipLeadV1(computeAgentProfileHeadObjectDigestV1(predecessor)),
        })],
        ['networkId', unbound({ networkId: 'otp:9999' })],
        ['peerId', unbound({ peerId: flipLeadV1(p.peerId) })],
        ['peerPublicKey', unbound({ peerPublicKey: flipLeadV1(p.peerPublicKey) })],
        ['authoritySequence', unbound({ authoritySequence: '3' })],
        ['acceptedTransitionDigest', unbound({
          acceptedTransitionDigest: flipLeadV1(p.acceptedTransitionDigest),
        })],
        ['evmIssuer', unbound({ evmIssuer: flipLeadV1(p.evmIssuer) })],
        ['rootSubject', unbound({ rootSubject: `${p.rootSubject}x` })],
        ['projectionSchemaDigest', unbound({
          projectionSchemaDigest: flipLeadV1(p.projectionSchemaDigest),
        })],
        // A version-1 tombstone under the version-2 ACTIVE head: strictly-greater
        // violated with NEITHER head at zero, so the version-zero codec rule
        // cannot pre-empt the conjunct under test.
        ['version-not-strictly-greater', () => tombstoneOfV1(
          CORE_CURRENT_HEAD_V1 as unknown as AgentProfileHeadObjectV1,
          '1',
        )],
        // AND THE EQUAL-VERSION ROW, WHICH IS THE ONE THAT WATCHES THE OPERATOR.
        // The row above violates strictly-greater FROM BELOW, and there `>` and
        // `>=` agree -- 1 is neither greater than nor equal to 2 -- so relaxing
        // the operator leaves it refused and the mutant it was added for
        // SURVIVES. Measured that way before this row existed, not reasoned:
        // with `>=` in place the enumeration stayed green on ten rows. Only a
        // tombstone at its predecessor's OWN version separates the two
        // operators, which is also the equal-version case the open ADR question
        // turns on.
        ['version-equal-to-predecessor', () => tombstoneOfV1(
          CORE_CURRENT_HEAD_V1 as unknown as AgentProfileHeadObjectV1,
          CORE_CURRENT_HEAD_V1.version,
        )],
      ]);

    const refusedAt: Record<string, string> = {};
    for (const [name, build] of levers) {
      let head: AgentProfileTombstoneHeadObjectV1;
      try {
        head = build();
      } catch {
        refusedAt[name] = 'head-codec';
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const mint = await mintStorageSummaryForHeadV1(head);
      refusedAt[name] = mint.minted ? 'REACHED THE CLASSIFIER' : 'closure-mint';
    }

    expect(refusedAt).toStrictEqual({
      previousHeadDigest: 'closure-mint',
      networkId: 'closure-mint',
      peerId: 'head-codec',
      peerPublicKey: 'head-codec',
      authoritySequence: 'closure-mint',
      acceptedTransitionDigest: 'closure-mint',
      evmIssuer: 'head-codec',
      rootSubject: 'head-codec',
      projectionSchemaDigest: 'closure-mint',
      'version-not-strictly-greater': 'closure-mint',
      'version-equal-to-predecessor': 'closure-mint',
    });
  });
});

/**
 * RECORD IDENTITY: THE PRECONDITION THE EXTRACTION LOST.
 *
 * Every row above is one authority branch, which is why none of them measures
 * this. The rule answers "does this tombstone dominate its sequence"; inside the
 * full evaluator that question is only ever reached after the adapter has
 * established that the candidate and the applied row ARE the same record --
 * `same-sequence authority changed` on issuer and root, then
 * `transition-equivocation` on the accepted transition digest. The extracted
 * entry inherited the rule and not the conditional, and its four-field operand
 * could not express either question.
 *
 * THE CONSEQUENCE WAS NOT THEORETICAL. Driven through the real receiver path --
 * closure mint, driver, derivation -- a verified tombstone whose predecessor
 * accepted a DIFFERENT transition into this sequence returned `ready`: the
 * applied projection deleted on another rotation's revocation. The same-branch
 * control returned `ready` too, so storage could not tell them apart.
 *
 * THE COMPETING ROTATION IS ONE FIELD AWAY, AND THAT IS THE THREAT MODEL RATHER
 * THAN A FIXTURE TRICK. `issuedAt` is inside the transition's canonical digest
 * field list, so moving it alone yields a second, differently-digested rotation
 * into the same sequence with every binding intact -- same network, same peer,
 * same prior and next issuer. The transition validator constrains the issuer
 * only against the transition's OWN prior, and the closure's equivocation key
 * carries no issuer at all. So a peer signs two rotations out of one sequence
 * with its own keys and equivocates; nothing is forged and no third party is
 * involved.
 *
 * THAT ALSO EXPLAINS THE WALL FOUR SEATS HIT. The fixture's ready-made
 * equivocating transitions rotate the ROOT, which drags the issuer with it
 * through the codec weld (`rootSubject` must equal `did:dkg:agent:${evmIssuer}`)
 * and therefore obliges a rebuilt author seal -- refused, in domain wording, as
 * `graph-scoped seal author must equal evmIssuer`. That refusal is a fixture
 * choice, not a system property: an equivocation needs no new issuer at all.
 */
describe('record identity is established before the same-sequence rule runs', () => {
  /**
   * A second rotation into sequence 2, differing from the real one ONLY in
   * `issuedAt` -- inside the canonical digest, outside every binding.
   */
  const competingTransition = Object.freeze({
    ...structuredClone(CORE_CHAIN_V1.transitions[1] as AgentProfileAuthorityTransitionV1),
    issuedAt: '2026-08-05T12:03:00Z',
  }) as unknown as AgentProfileAuthorityTransitionV1;
  const competingDigest = computeAgentProfileAuthorityTransitionDigestV1(competingTransition);

  /**
   * The alternate sequence-2 ACTIVE head: the fixture's own base head, having
   * accepted the competing rotation instead. Issuer and root never move, so
   * every seal weld holds untouched and no re-sealing is needed.
   */
  const alternateBranchHead = Object.freeze({
    ...structuredClone(CORE_CHAIN_V1.base),
    acceptedTransitionDigest: competingDigest,
  }) as unknown as AgentProfileHeadObjectV1;

  /**
   * A head that moves the ROOT while accepting the applied row's own transition.
   *
   * IT EXISTS BECAUSE THE REALISTIC CELL CANNOT SEPARATE THE TWO CONJUNCTS. Any
   * head that differs in root also differs in the transition that rotated to
   * that root, so deleting either conjunct alone leaves the other catching it,
   * and both solo-removal mutants would SURVIVE against a row that violates
   * both -- reading as "something else covers this" when it means "this row
   * cannot see it". The discriminating rows are therefore built one field apart
   * each: this one moves only the root, `alternateBranchHead` only the
   * transition digest. Neither models traffic; they separate operators.
   *
   * It goes through the fixture's own rotation because moving a root obliges
   * five derived rewrites -- root subject, owned-subject table digest,
   * projection quads, content digest and four seal fields -- each refused one
   * layer deeper in domain wording if skipped.
   */
  const otherRootSameTransition = rotatedActiveHeadV1(
    CORE_CHAIN_V1.base,
    `0x${'99'.repeat(20)}`,
    CORE_CURRENT_HEAD_V1.authoritySequence,
    '0',
    { acceptedTransitionDigest: CORE_CURRENT_HEAD_V1.acceptedTransitionDigest },
  );

  /**
   * The REASON is rendered for quarantine as well as reject, and that is not
   * cosmetic: `quarantine | head-fork` leaking onto a foreign-branch cell is the
   * precise failure the ordering below exists to prevent, and a renderer that
   * printed a bare `quarantine` would hide it behind a word that looks fine.
   */
  const answer = (predecessor: AgentProfileHeadObjectV1, version = '1'): string => {
    const decision = evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
      buildTombstoneHeadFromPredecessorV1(predecessor, version),
      Object.freeze({ tombstonePredecessor: predecessor }) as never,
      APPLIED_ROW_V1,
    );
    const reason = (decision as { reason?: string }).reason;
    return reason === undefined ? decision.decision : `${decision.decision}|${reason}`;
  };

  /**
   * BOTH FAMILIES, EACH SEPARATED, AND THE CONTROL THAT MAKES THEM MEASUREMENTS.
   *
   * The control is not decoration: it is what shows the refusals are caused by
   * identity rather than by anything else the construction changed. Same
   * builder, same applied row, one field apart.
   */
  it('refuses a candidate from another branch and one that accepted another transition', () => {
    expect({
      control: answer(CORE_CHAIN_V1.base as unknown as AgentProfileHeadObjectV1),
      rootOnly: answer(otherRootSameTransition as unknown as AgentProfileHeadObjectV1),
      transitionOnly: answer(alternateBranchHead),
    }).toStrictEqual({
      control: 'accept',
      rootOnly: 'reject|same-sequence tombstone belongs to another authority branch',
      transitionOnly:
        'reject|same-sequence tombstone accepted a different authority transition',
    });
  });

  /**
   * THE VERSION AXIS COLLAPSES ON A FOREIGN BRANCH, AND IT HAS TO.
   *
   * The routing this PR added made TWO version relations advance -- lower and
   * higher -- so the identity hole rode both of them, not just the one the first
   * construction happened to use. Testing identity at the lower relation alone
   * would leave the second data-destroying advance unproven while looking
   * covered.
   *
   * Identity is decided BEFORE any version is read, so all three relations must
   * give one answer per family. That collapse is the property: if a version ever
   * reappears in these answers, identity has moved below the version branch.
   *
   * AND BEFORE THE FORK BRANCH, WHICH IS A SECOND ORDERING OBLIGATION. The
   * equal-version cell is the one the open ADR fork question is about -- but that
   * question presupposes two heads OF ONE RECORD at one sequence and version. A
   * foreign-branch candidate is not that cell and never was in its scope, so
   * holding it as `quarantine | head-fork` would answer a question it does not
   * pose. The discriminator is exact: a surviving `head-fork` on either
   * equal-version row below means identity is still being decided after the fork
   * branch rather than before it.
   */
  /**
   * THE APPLIED-STATUS AXIS, which storage cannot reach and this entry can.
   *
   * Storage's disposition precondition defers every applied-tombstone row before
   * core is consulted, so no storage cell exercises this. The entry has no such
   * precondition -- it decides against a tombstoned applied row under ADR
   * :126-128 -- which means the guard keeping that combination unreachable lives
   * in the SEAM, protecting today's caller rather than the published export.
   *
   * Identity runs before the rule, so applied-tombstone rows are identity-checked
   * on exactly the same path as applied-active ones. THE CONTROL HALF IS THE
   * LOAD-BEARING ONE: refusals alone do not discriminate, because an entry that
   * simply stopped deciding against tombstoned rows would produce identical
   * refusals. The controls are what prove :126-128 still runs underneath.
   */
  it('checks identity against a tombstoned applied row without disabling the rule', () => {
    const tombstoneRow = Object.freeze({ ...APPLIED_ROW_V1, status: 'tombstone' });
    const against = (predecessor: AgentProfileHeadObjectV1, version: string): string => {
      const decision = evaluateAgentProfileSameSequenceTombstoneAdvanceV1(
        buildTombstoneHeadFromPredecessorV1(predecessor, version),
        Object.freeze({ tombstonePredecessor: predecessor }) as never,
        tombstoneRow as never,
      );
      const reason = (decision as { reason?: string }).reason;
      return reason === undefined ? decision.decision : `${decision.decision}|${reason}`;
    };
    const control = CORE_CHAIN_V1.base as unknown as AgentProfileHeadObjectV1;
    // ADR :126-128 resolves an EQUAL-version pair by digest, so the control's
    // equal cell is pinned to the RULE rather than to an outcome: the branch this
    // fixture happens to take is computed here and asserted alongside the
    // verdict, so a fixture change that flips the comparison fails this row
    // instead of silently swapping the answer under it.
    const equalTakesTheLowerDigest =
      computeAgentProfileHeadObjectDigestV1(
        buildTombstoneHeadFromPredecessorV1(control, CORE_CURRENT_HEAD_V1.version),
      ) < CORE_CURRENT_DIGEST_V1;
    expect({
      foreignRootLower: against(
        otherRootSameTransition as unknown as AgentProfileHeadObjectV1, '1',
      ),
      foreignRootHigher: against(
        otherRootSameTransition as unknown as AgentProfileHeadObjectV1, '3',
      ),
      foreignTransitionLower: against(alternateBranchHead, '1'),
      foreignTransitionHigher: against(alternateBranchHead, '3'),
      // THE EQUAL RELATION IS WHERE THIS ROW EARNS ITS KEEP. It is the cell the
      // open ADR fork question is about, so it is the one place a foreign
      // candidate could plausibly be held under a question it does not pose --
      // and it is where the fork-shadowing concern lived. Covering only lower
      // and higher would leave exactly that cell unwitnessed on this axis.
      foreignRootEqual: against(
        otherRootSameTransition as unknown as AgentProfileHeadObjectV1,
        CORE_CURRENT_HEAD_V1.version,
      ),
      foreignTransitionEqual: against(alternateBranchHead, CORE_CURRENT_HEAD_V1.version),
      controlLower: against(control, '1'),
      controlHigher: against(control, '3'),
      controlEqualFollowsTheDigestRule:
        against(control, CORE_CURRENT_HEAD_V1.version)
        === (equalTakesTheLowerDigest ? 'accept' : 'stale'),
    }).toStrictEqual({
      foreignRootLower: 'reject|same-sequence tombstone belongs to another authority branch',
      foreignRootHigher: 'reject|same-sequence tombstone belongs to another authority branch',
      foreignTransitionLower:
        'reject|same-sequence tombstone accepted a different authority transition',
      foreignTransitionHigher:
        'reject|same-sequence tombstone accepted a different authority transition',
      // The version axis collapses here exactly as it does against an ACTIVE
      // applied row: identity is decided before any version is read, so the
      // equal cell is refused rather than held under the fork question.
      foreignRootEqual: 'reject|same-sequence tombstone belongs to another authority branch',
      foreignTransitionEqual:
        'reject|same-sequence tombstone accepted a different authority transition',
      // ADR :127-128, the lowest tombstone winning: a LOWER tombstone is accepted
      // over the applied one, a HIGHER one is stale.
      controlLower: 'accept',
      controlHigher: 'stale',
      controlEqualFollowsTheDigestRule: true,
    });
  });

  it('answers foreign-branch cells identically at every version relation', () => {
    const relations = ['1', CORE_CURRENT_HEAD_V1.version, '3'] as const;
    const across = (predecessor: AgentProfileHeadObjectV1) =>
      Object.fromEntries(relations.map((version) => [version, answer(predecessor, version)]));

    expect({
      rootOnly: across(otherRootSameTransition as unknown as AgentProfileHeadObjectV1),
      transitionOnly: across(alternateBranchHead),
      control: across(CORE_CHAIN_V1.base as unknown as AgentProfileHeadObjectV1),
    }).toStrictEqual({
      rootOnly: {
        1: 'reject|same-sequence tombstone belongs to another authority branch',
        2: 'reject|same-sequence tombstone belongs to another authority branch',
        3: 'reject|same-sequence tombstone belongs to another authority branch',
      },
      transitionOnly: {
        1: 'reject|same-sequence tombstone accepted a different authority transition',
        2: 'reject|same-sequence tombstone accepted a different authority transition',
        3: 'reject|same-sequence tombstone accepted a different authority transition',
      },
      // The same-branch control keeps the band's own answers, so the collapse
      // above is a property of foreign identity rather than of this entry
      // having stopped reading versions at all.
      control: { 1: 'accept', 2: 'quarantine|head-fork', 3: 'accept' },
    });
  });

  /**
   * A head that trips BOTH conjuncts, pinned for its ORDER rather than its
   * refusal -- and this is the only realistically mintable competitor, so it is
   * also the cell a reader is most likely to meet.
   *
   * WHY THE ORDER IS WORTH A ROW. Which reason this returns is decided purely by
   * which conjunct the shared classifier asks first. At the storage layer that
   * is invisible, because both core reasons map to one deferral. At the entry it
   * is a published export's answer on the realistic cell. And it is the one
   * observable that makes "one implementation, both callers" CHECKABLE: the full
   * evaluator asks issuer/root before transition-equivocation, so a classifier
   * genuinely shared with it must answer with the ROOT reason here. If this row
   * ever reports the transition reason, the extraction has drifted from the
   * evaluator it was extracted from -- which is exactly the divergence sharing
   * exists to prevent, and it would otherwise be invisible from either layer.
   */
  const bothConjunctsDiffer = rotatedActiveHeadV1(
    CORE_CHAIN_V1.base,
    `0x${'99'.repeat(20)}`,
    CORE_CURRENT_HEAD_V1.authoritySequence,
    '0',
    { acceptedTransitionDigest: competingDigest },
  );

  it('answers the both-conjuncts cell in the full evaluator\'s own conjunct order', () => {
    expect(answer(bothConjunctsDiffer as unknown as AgentProfileHeadObjectV1))
      .toBe('reject|same-sequence tombstone belongs to another authority branch');
  });

  /**
   * THE ENTRY AND THE FULL EVALUATOR DIVERGE HERE, DELIBERATELY AND ONCE.
   *
   * The evaluator holds the record's disposition and the conflicting transition
   * OBJECTS, so it can name an equivocation. This entry holds two digests. "The
   * candidate's accepted transition is not this record's" is what its operands
   * ground; "this record's authority equivocated" is a conclusion equally
   * consistent with a fork the receiver already resolved or a chain it has never
   * seen. So the entry REFUSES and does not classify, and its reason names the
   * observation rather than the conclusion. Declared here so the divergence is a
   * documented decision rather than a surprise in someone's comparison table.
   */
  it('declares the one cell where the entry and the full evaluator differ', () => {
    const candidate = buildTombstoneHeadFromPredecessorV1(alternateBranchHead, '1');
    const full = evaluateAgentProfileHeadAdvanceV1(
      Object.freeze({
        current: CORE_CURRENT_HEAD_V1,
        disposition: 'discoverable',
        transitionLineage: CORE_ACCEPTED_LINEAGE_V1,
        historicalRoots: CORE_HISTORICAL_ROOTS_V1,
      }) as never,
      candidate as never,
      Object.freeze({
        tombstonePredecessor: alternateBranchHead,
        nowMs: CORE_CLOCK_MS_V1.valid,
      }) as never,
    );
    expect({
      entry: answer(alternateBranchHead),
      fullEvaluator: `${full.decision}|${(full as { reason?: string }).reason ?? ''}`,
    }).toStrictEqual({
      entry: 'reject|same-sequence tombstone accepted a different authority transition',
      fullEvaluator: 'quarantine|transition-equivocation',
    });
  });

  /**
   * THE ROW THE DEFECT WAS ACTUALLY ABOUT: the real receiver path, end to end.
   *
   * `ready` means the projection is deleted. Before the identity conjuncts the
   * foreign cell returned `ready`, and the same-branch control still does -- so
   * this row fails in BOTH directions: if identity stops being established it
   * goes back to deleting, and if the conjuncts overreach it takes the
   * legitimate revocation down with it.
   *
   * EVERY CELL GATES ON `unresolved === []`. An artifact the closure asked for
   * and this graph did not hold produces a refusal phrased exactly like a domain
   * refusal, and reading one as the other is how three earlier attempts reported
   * a system limit that was a short artifact list.
   *
   * THE THIRD CELL IS A PATH DISCRIMINATOR, not a third behaviour. The
   * equal-version pre-filter exists ONLY inside the routing this PR added, so a
   * candidate that reaches identity refusal at the applied version proves the
   * cell traverses the new path rather than being answered by an upstream
   * short-circuit -- causation without a mutation.
   */
  it('does not advance a foreign-branch tombstone through the real storage entry', async () => {
    const driver = await prepareStorageDriverV1();
    const drive = async (predecessor: AgentProfileHeadObjectV1, version: string) => {
      const candidate = buildTombstoneHeadFromPredecessorV1(predecessor, version);
      const unresolved: string[] = [];
      const minted = await mintAgentProfileTombstoneClosureV1({
        tombstone: candidate,
        predecessor,
        ownedSubjectTable: [(predecessor as unknown as { rootSubject: string }).rootSubject],
        ancestors: [...CORE_MINT_GRAPH_V1.ancestry, predecessor],
        transitions: [...CORE_MINT_GRAPH_V1.transitions, competingTransition],
        onUnresolvedArtifact: (reference: string) => unresolved.push(reference),
      } as never);
      const outcome = driver.drive({
        candidate: candidate as never,
        summary: (minted as { authoritySummary: unknown }).authoritySummary as never,
        operation: 'tombstone',
        snapshotForm: { kind: 'present', appliedStatus: 'active' },
      } as never);
      return { unresolved, outcome };
    };

    const foreign = await drive(alternateBranchHead, '1');
    const control = await drive(
      CORE_CHAIN_V1.base as unknown as AgentProfileHeadObjectV1,
      '1',
    );
    const atAppliedVersion = await drive(alternateBranchHead, CORE_CURRENT_HEAD_V1.version);
    // THE SECOND DATA-DESTROYING ADVANCE. The routing made lower AND higher
    // advance, so the identity hole rode both; a fix witnessed only at the lower
    // relation leaves the other one unproven while looking covered.
    const foreignHigher = await drive(alternateBranchHead, '3');
    const controlHigher = await drive(
      CORE_CHAIN_V1.base as unknown as AgentProfileHeadObjectV1,
      '3',
    );

    const appliedState = (driver.buildSnapshot({
      kind: 'present',
      appliedStatus: 'active',
    } as never) as unknown as {
      snapshot: { appliedState: Record<string, unknown> };
    }).snapshot.appliedState;
    const appliedLineage = appliedState.transitionLineage as readonly {
      transitionDigest: string;
    }[];
    const appliedRoot = appliedState.currentRoot as string;

    expect({
      foreignUnresolved: foreign.unresolved,
      foreign: foreign.outcome,
      controlUnresolved: control.unresolved,
      control: control.outcome,
      pathDiscriminator: atAppliedVersion.outcome,
      foreignHigher: foreignHigher.outcome,
      controlHigher: controlHigher.outcome,
      // THE APPLIED ROW IS READ FROM THE DRIVER, NOT INFERRED FROM SETUP.
      //
      // Comparing the two constants this file itself built would assert what the
      // fixture was ASKED for, never what the driver APPLIED -- and it would pass
      // unchanged if the snapshot were built from the candidate's own branch,
      // which is the single arrangement that would make this whole row
      // meaningless. So the applied lineage is located inside the driver's own
      // snapshot: the record's real transition must be PRESENT and the competing
      // one ABSENT. Both directions, because presence alone cannot tell a
      // same-branch row from one carrying both.
      appliedCarriesTheRealTransition:
        appliedLineage.some((entry) =>
          entry.transitionDigest === CORE_CURRENT_HEAD_V1.acceptedTransitionDigest),
      appliedDoesNotCarryTheCompetingTransition:
        !appliedLineage.some((entry) => entry.transitionDigest === competingDigest),
      appliedRootIsTheRecordsOwn: appliedRoot === CORE_CURRENT_HEAD_V1.rootSubject,
      sequencesMatch:
        (alternateBranchHead as unknown as { authoritySequence: string }).authoritySequence
        === CORE_CURRENT_HEAD_V1.authoritySequence,
    }).toStrictEqual({
      foreignUnresolved: [],
      foreign: {
        kind: 'derivation',
        verdict: 'deferred',
        reason: 'same-sequence-authority-branch-mismatch',
      },
      controlUnresolved: [],
      control: { kind: 'derivation', verdict: 'ready' },
      pathDiscriminator: {
        kind: 'derivation',
        verdict: 'deferred',
        reason: 'same-sequence-authority-branch-mismatch',
      },
      foreignHigher: {
        kind: 'derivation',
        verdict: 'deferred',
        reason: 'same-sequence-authority-branch-mismatch',
      },
      controlHigher: { kind: 'derivation', verdict: 'ready' },
      appliedCarriesTheRealTransition: true,
      appliedDoesNotCarryTheCompetingTransition: true,
      appliedRootIsTheRecordsOwn: true,
      sequencesMatch: true,
    });
  });

  /**
   * THE WELD THE SINGLE ROOT COMPARISON RESTS ON.
   *
   * The full evaluator tests issuer OR root; the entry compares only the root,
   * which is faithful ONLY because the head codec refuses any head whose
   * `rootSubject` is not `did:dkg:agent:${evmIssuer}`. That is another module's
   * invariant, so it is pinned rather than trusted: if it is relaxed, the root
   * comparison silently stops covering the issuer, and this row is what says so.
   */
  it('pins the codec weld that lets one root comparison cover the issuer', () => {
    const base = CORE_CHAIN_V1.base as unknown as Record<string, unknown>;
    const otherIssuer = `0x${'99'.repeat(20)}`;
    const refusalFor = (patch: Record<string, unknown>): string => {
      try {
        buildTombstoneHeadFromPredecessorV1(
          Object.freeze({ ...base, ...patch }) as never,
          '1',
        );
        return 'BUILT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect({
      issuerAlone: refusalFor({ evmIssuer: otherIssuer }),
      rootAlone: refusalFor({ rootSubject: `did:dkg:agent:${otherIssuer}` }),
    }).toStrictEqual({
      issuerAlone: '[system-record-binding] agent root does not match its EVM issuer',
      rootAlone: '[system-record-binding] agent root does not match its EVM issuer',
    });
  });
});
