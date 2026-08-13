import { describe, expect, it } from 'vitest';

import {
  computeAgentProfileHeadObjectDigestV1,
  evaluateAgentProfileSameSequenceTombstoneAdvanceV1,
  type AgentProfileHeadObjectV1,
  type AgentProfileSameSequenceAppliedRowV1,
  type AgentProfileTombstoneHeadObjectV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  CORE_CHAIN_V1,
  CORE_CURRENT_DIGEST_V1,
  CORE_CURRENT_HEAD_V1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  mintStorageSummaryForHeadV1,
  prepareStorageDriverV1,
  requireStorageSummaryForHeadV1,
} from './helpers/authority-verdict-diff-storage-driver-v1.js';
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
 * sequence to equal the applied lineage length; only two sequence-2 active heads
 * exist; and the other one IS the applied row, which lands in the short-circuit
 * by construction. There is no second arrangement to cross-check against.
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
const APPLIED_ROW_V1: AgentProfileSameSequenceAppliedRowV1 = Object.freeze({
  status: 'active',
  authoritySequence: CORE_CURRENT_HEAD_V1.authoritySequence,
  version: CORE_CURRENT_HEAD_V1.version,
  headDigest: CORE_CURRENT_DIGEST_V1,
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
