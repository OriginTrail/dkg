import { describe, expect, it } from 'vitest';

import {
  assertAgentProfileHeadObjectV1,
  computeAgentProfileHeadObjectDigestV1,
  EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
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
 * THE VERSION IS A PARAMETER, AND THAT IS THE WHOLE UNLOCK.
 *
 * `isTombstoneBoundToPredecessorV1` requires the tombstone's version to be
 * STRICTLY GREATER than its predecessor's -- not adjacent. Minting at
 * `predecessor.version + 1` reaches exactly one relation and makes the other two
 * look unconstructible; from the version-0 base, every relation against an
 * applied version-2 row is available.
 *
 * WHY A TOMBSTONE NAMING THE BASE MINTS AT ALL: the closure resolves the
 * predecessor through the tombstone's OWN `previousHeadDigest` against the
 * ancestry, while the mint graph supplies only the owned-subject TABLE. That
 * table is correct for either head because the current head is a spread of the
 * base with `version` and `previousHeadDigest` overridden, so the two share
 * `ownedSubjectTableDigest` and `rootSubject`. If those ever diverge this
 * construction breaks with a refusal phrased like a domain error rather than a
 * fixture one, which is why the coincidence is written down rather than relied on
 * silently.
 */
function tombstoneOfV1(
  predecessor: AgentProfileHeadObjectV1,
  version?: string,
  overrides: Record<string, unknown> = {},
): AgentProfileTombstoneHeadObjectV1 {
  const shaped: Record<string, unknown> = {
    ...structuredClone(predecessor),
    state: 'tombstone',
    version: version ?? String(BigInt((predecessor as { version: string }).version) + 1n),
    previousHeadDigest: computeAgentProfileHeadObjectDigestV1(predecessor),
    ownedSubjectTableDigest: EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1,
    ownedSubjectCount: '0',
    projectionBytes: '0',
    projectionQuads: '0',
    ...overrides,
  };
  for (const key of [
    'contentDigest', 'bundleDigest', 'graphScopedAuthorSeal', 'validUntil',
    'assertionCoordinate',
  ]) {
    delete shaped[key];
  }
  const built = Object.freeze(shaped) as unknown as AgentProfileHeadObjectV1;
  assertAgentProfileHeadObjectV1(built);
  if (built.state !== 'tombstone') {
    throw new Error(`fixture built a ${built.state} head where a tombstone was required`);
  }
  return built;
}

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
   * Every conjunct is attempted individually below and every one is refused
   * upstream of the classifier, by one of two gates -- the head codec, which
   * refuses four as malformed heads, or the closure, which refuses the rest at
   * mint. The bound control mints in the same run, so these refusals measure the
   * system rather than a broken construction.
   *
   * ONE CONJUNCT IS REASONED, NOT MEASURED, AND IS MARKED AS SUCH: version
   * strictly-greater. Against a version-zero predecessor the only non-greater
   * version is zero, and the codec refuses a version-zero head that carries a
   * previousHeadDigest -- a different rule pre-empting the one under test.
   * Reachability is not strictness, so it is recorded here rather than counted
   * as one of the nine.
   */
  it('refuses every unbound construction before the classifier is reached', async () => {
    const control = await mintStorageSummaryForHeadV1(tombstoneOfV1(predecessor, '1'));
    expect(control.minted).toBe(true);

    const p = predecessor as unknown as Record<string, string>;
    const levers: ReadonlyArray<readonly [string, Record<string, unknown>]> = Object.freeze([
      ['previousHeadDigest', {
        previousHeadDigest: flipLeadV1(computeAgentProfileHeadObjectDigestV1(predecessor)),
      }],
      ['networkId', { networkId: 'otp:9999' }],
      ['peerId', { peerId: flipLeadV1(p.peerId) }],
      ['peerPublicKey', { peerPublicKey: flipLeadV1(p.peerPublicKey) }],
      ['authoritySequence', { authoritySequence: '3' }],
      ['acceptedTransitionDigest', {
        acceptedTransitionDigest: flipLeadV1(p.acceptedTransitionDigest),
      }],
      ['evmIssuer', { evmIssuer: flipLeadV1(p.evmIssuer) }],
      ['rootSubject', { rootSubject: `${p.rootSubject}x` }],
      ['projectionSchemaDigest', {
        projectionSchemaDigest: flipLeadV1(p.projectionSchemaDigest),
      }],
    ]);

    const refusedAt: Record<string, string> = {};
    for (const [name, overrides] of levers) {
      let head: AgentProfileTombstoneHeadObjectV1;
      try {
        head = tombstoneOfV1(predecessor, '1', overrides);
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
    });
  });
});
