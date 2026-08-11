import { describe, expect, it } from 'vitest';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
  evaluateAgentProfileHeadAdvanceV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import {
  readCitedSourceLineV1,
  SAME_PREDICATE_CITATIONS_V1,
} from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  makeAuthenticTerminalReplacementFixtureV1,
  makeNonGenesisTerminalPairV1,
  mintAgentProfileTombstoneClosureV1,
  TERMINAL_FIXTURE_NOW_MS_V1,
} from './helpers/system-record-terminal-replacement-fixture.js';

/**
 * THE DRIVER THE AXIS-G DEMOTION OWES.
 *
 * Gating axis G on snapshot presence demoted the candidate-vs-predecessor
 * `acceptedTransitionDigest` relation from an AXIS to a FIXTURE OBLIGATION. A
 * demotion can SHADOW a refusal the same way a new guard can: the pin arithmetic
 * reconciles perfectly while the coverage that was driving the refusal quietly
 * falls, and nothing goes red. So the ruling attached a driver obligation -- both
 * a correctly-bound and a mis-bound predecessor, the mis-bound one SHOWN REFUSED.
 *
 * THE DRIVER'S FIRST VERSION HAD THE DEFECT IT EXISTS TO PREVENT, and that is
 * worth stating plainly rather than quietly fixing. It perturbed
 * `projectionSchemaDigest` on a GENESIS pair, where both heads sit at authority
 * sequence 0 and the head codec forbids `acceptedTransitionDigest` there (:194).
 * The field was therefore ABSENT on both heads, so the predicate's conjunct
 * comparing it held vacuously on every run of both arms -- the driver for the
 * `acceptedTransitionDigest` demotion never touched `acceptedTransitionDigest`,
 * and could not have. Deleting that conjunct left the suite green.
 *
 * The mechanism is worth remembering: the fields tried and rejected as
 * discriminators were recorded (`evmIssuer`, `rootSubject`, `networkId`,
 * `peerId`, `version`) and the ONE field the demotion was about was not among
 * them. A probe set that silently omits its own subject yields a confident and
 * wrong isolation claim.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);

/**
 * The absent-snapshot accepted state. `current` is omitted rather than set to
 * `undefined`: `snapshotAcceptedAuthorityStateV1` is an exact-record check, and a
 * non-discoverable disposition or a non-empty lineage would divert to :219's
 * reject before the tombstone branch is ever reached.
 */
const ABSENT_ACCEPTED = {
  disposition: 'discoverable' as const,
  transitionLineage: [],
  historicalRoots: [],
};

/**
 * The refusal a mint actually returns, or 'MINTS'. Collected as a value so a
 * construction and the layer that refuses it can be asserted as a PAIR -- an
 * expectation that merely rejects would pass on any refusal at all, including
 * the fixture being broken.
 */
async function refusalOfMint(
  mint: Parameters<typeof mintAgentProfileTombstoneClosureV1>[0],
): Promise<string> {
  try {
    await mintAgentProfileTombstoneClosureV1(mint);
    return 'MINTS';
  } catch (error) {
    return String((error as { message?: string }).message);
  }
}

describe('absent-path tombstone evidence binding', () => {
  // THE POSITIVE CONTROL, and it is not optional. Without it the refusals below
  // are equally consistent with a closure builder that refuses every pair -- in
  // which case the "obligation" would be discharged by a fixture defect, and the
  // demoted axis would look covered while nothing was being exercised.
  it('mints and accepts a correctly-bound genesis tombstone predecessor', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const closure = await mintAgentProfileTombstoneClosureV1({
      tombstone: fixture.tombstone.head,
      predecessor: fixture.active.head,
      ownedSubjectTable: fixture.active.ownedSubjectTable,
    });

    // The minted summary really does carry the deletion proof the absent path
    // consumes -- otherwise `accept` below could be reached without it.
    expect(closure.authoritySummary.tombstonePredecessor).toBeDefined();
    expect(closure.authoritySummary.deletionTableDigest)
      .toBe(fixture.active.head.ownedSubjectTableDigest);

    expect(evaluateAgentProfileHeadAdvanceV1(
      ABSENT_ACCEPTED,
      fixture.tombstone.head,
      {
        nowMs: TERMINAL_FIXTURE_NOW_MS_V1,
        verifiedAuthoritySummary: closure.authoritySummary,
      },
    )).toEqual({ decision: 'accept' });
  });

  // THE GENESIS PAIR CANNOT CARRY THE DEMOTED FIELD AT ALL, pinned so the reason
  // the non-genesis pair below exists is a measurement rather than a comment.
  // Without this, someone reasonably assumes the genesis arms cover the relation.
  it('pins that a genesis pair holds the compared transition digest vacuously', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    expect(fixture.active.head.authoritySequence).toBe('0');
    expect(fixture.active.head.acceptedTransitionDigest).toBeUndefined();
    expect(fixture.tombstone.head.acceptedTransitionDigest).toBeUndefined();
  });

  // THE NON-GENESIS POSITIVE CONTROL. The mis-binding arm below is only evidence
  // if the same pair mints and accepts when correctly bound.
  it('mints and accepts a correctly-bound non-genesis tombstone predecessor', async () => {
    const pair = makeNonGenesisTerminalPairV1();
    expect(pair.predecessor.authoritySequence).toBe('1');
    expect(pair.predecessor.acceptedTransitionDigest).toBeDefined();
    expect(pair.tombstone.acceptedTransitionDigest)
      .toBe(pair.predecessor.acceptedTransitionDigest);

    const closure = await mintAgentProfileTombstoneClosureV1(pair);
    expect(closure.authoritySummary.tombstonePredecessor).toBeDefined();
    // A non-genesis closure carries the lineage its sequence claims, so the
    // evaluator's completeness gate at :242 is satisfied by real history rather
    // than by an empty one.
    expect(closure.authoritySummary.transitionLineage).toHaveLength(1);
    expect(closure.authoritySummary.historicalRoots).toHaveLength(1);

    expect(evaluateAgentProfileHeadAdvanceV1(
      ABSENT_ACCEPTED,
      pair.tombstone,
      {
        nowMs: TERMINAL_FIXTURE_NOW_MS_V1,
        verifiedAuthoritySummary: closure.authoritySummary,
      },
    )).toEqual({ decision: 'accept' });
  });

  /**
   * THE ARM THE DEMOTION OWED -- AND THE FINDING THAT IT CANNOT BE WRITTEN.
   *
   * The obligation was to perturb `acceptedTransitionDigest` ALONE and show the
   * binding refusal fire. Built rather than assumed, it refuses: every way of
   * making a tombstone and its predecessor disagree on that field is caught by an
   * EARLIER layer, so the conjunct is unreachable through the closure builder.
   *
   * The reason is structural, not incidental. A tombstone shares its
   * predecessor's authority sequence, so both heads must name THE single
   * transition into that sequence. Disagreeing therefore requires one of them to
   * name a transition that is missing, or absent, or not the one into their
   * sequence -- and each of those is refused before any field comparison runs.
   *
   * This is recorded as a fired measurement rather than as prose, because
   * "we could not construct it" and "we did not try" are indistinguishable in
   * notes. Each construction below is paired with the refusal it actually
   * received, and the positive control shows the same instrument minting -- so
   * the four refusals cannot be a fixture that refuses everything.
   *
   * CONSEQUENCE, which is a disposition question rather than a test one: the
   * `acceptedTransitionDigest` conjunct of `isTombstoneBoundToPredecessorV1` is a
   * re-check of an invariant the lineage walk already enforces. Whether it stays
   * is decided by whether that precondition is stable and pinned or in motion --
   * not by its unreachability alone.
   */
  it('pins the demoted transition digest as undrivable through the closure builder', async () => {
    const pair = makeNonGenesisTerminalPairV1(2);
    const otherTransition = pair.transitions[0];
    expect(otherTransition).toBeDefined();
    const otherDigest = computeAgentProfileAuthorityTransitionDigestV1(otherTransition as never);
    // The two transitions really are distinct, or "naming the other one" is not
    // a perturbation at all and every refusal below would be about something else.
    expect(otherDigest).not.toBe(pair.predecessor.acceptedTransitionDigest);

    const withPredecessor = (predecessor: Record<string, unknown>) => ({
      ...pair,
      predecessor: predecessor as never,
      tombstone: {
        ...(pair.tombstone as unknown as Record<string, unknown>),
        previousHeadDigest: computeAgentProfileHeadObjectDigestV1(predecessor as never),
      } as never,
    });

    const droppedOnPredecessor = { ...(pair.predecessor as unknown as Record<string, unknown>) };
    delete droppedOnPredecessor.acceptedTransitionDigest;

    // Dropping the field never reaches a closure at all: the head codec refuses
    // to canonicalize the predecessor, so this one is quoted from the throw.
    expect(() => withPredecessor(droppedOnPredecessor))
      .toThrow('nonzero authority sequence requires acceptedTransitionDigest');

    const refusals = await Promise.all([
      // Tombstone names a digest that resolves to nothing.
      refusalOfMint({
        ...pair,
        tombstone: {
          ...(pair.tombstone as unknown as Record<string, unknown>),
          acceptedTransitionDigest: `0x${'99'.repeat(32)}`,
        } as never,
      }),
      // Tombstone names the OTHER real transition, which resolves fine.
      refusalOfMint({
        ...pair,
        tombstone: {
          ...(pair.tombstone as unknown as Record<string, unknown>),
          acceptedTransitionDigest: otherDigest,
        } as never,
      }),
      // Predecessor names the OTHER real transition instead.
      refusalOfMint(withPredecessor({
        ...(pair.predecessor as unknown as Record<string, unknown>),
        acceptedTransitionDigest: otherDigest,
      })),
    ]);

    expect(refusals[0]).toContain('verification closure is missing');
    expect(refusals[1]).toContain('has incomplete authority/root lineage');
    expect(refusals[2]).toContain('has incomplete authority/root lineage');
    // NONE of them is the binding refusal -- that is the finding.
    for (const refusal of refusals) {
      expect(refusal).not.toContain('tombstone predecessor is not the exact prior active');
    }

    // THE CONTROL. Without it the three refusals are equally consistent with an
    // instrument that refuses every two-step pair.
    expect(await refusalOfMint(pair)).toBe('MINTS');
  });

  // A SECOND, DIFFERENT MUTATION CLASS, kept rather than replaced. This one
  // perturbs a field that is structurally free on the GENESIS pair, so the two
  // arms fire the same predicate through different conjuncts: deleting either
  // comparison leaves exactly one arm red. Dropping this one because the arm
  // above is "the real one" would surrender that separation.
  it('refuses a predecessor mis-bound on the projection schema digest', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const predecessor = {
      ...(fixture.active.head as unknown as Record<string, unknown>),
      projectionSchemaDigest: `0x${'11'.repeat(32)}`,
    };
    const tombstone = {
      ...(fixture.tombstone.head as unknown as Record<string, unknown>),
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(predecessor as never),
    };

    await expect(mintAgentProfileTombstoneClosureV1({
      tombstone: tombstone as never,
      predecessor: predecessor as never,
      ownedSubjectTable: fixture.active.ownedSubjectTable,
    })).rejects.toThrow('tombstone predecessor is not the exact prior active authority state');
  });

  it('pins the same binding predicate at both the minting and evaluating sites', () => {
    for (const citation of SAME_PREDICATE_CITATIONS_V1) {
      expect(readCitedSourceLineV1(citation.site, REPO_ROOT)).toContain(citation.contains);
    }
  });
});
