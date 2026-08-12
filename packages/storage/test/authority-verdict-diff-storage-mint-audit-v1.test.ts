import { describe, expect, it } from 'vitest';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  buildCoreCandidateHeadV1,
  CORE_CURRENT_HEAD_V1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import { mintStorageSummaryForHeadV1 } from './helpers/authority-verdict-diff-storage-driver-v1.js';
import { runStorageSweepV1 } from './helpers/authority-verdict-diff-storage-sweep-v1.js';

/**
 * THE AUDIT THE STORAGE MINTER DID NOT HAVE, AND THE ESCAPE THAT PROVED IT NEEDED ONE.
 *
 * A verification closure resolves every digest a head names. When the fixture
 * cannot answer one of those lookups the builder refuses with
 * '[system-record-closure] verification closure is missing 0x...' -- wording
 * indistinguishable from a domain refusal, produced entirely by the harness's own
 * omission. Pinning such a refusal retires cells against a gap in the fixture
 * while every count conserves, every message is real, and the suite stays green.
 * That is the failure this whole slice keeps meeting, and it has now been met
 * five times.
 *
 * The CORE minter has carried an `onUnresolvedArtifact` hook since the first
 * instance, and the core sweep pins the result at zero. The STORAGE minter did
 * not, and that is precisely where the next instance hid: every sequence-relative
 * tombstone was minted against the CURRENT head's owned-subject table, asking for
 * a deletion-table digest no artifact supplies. It survived a full lane run with
 * perfect conservation and was caught only because an independently derived cell
 * count disagreed with the run by exactly the three affected head shapes.
 *
 * SO THE PROPERTY IS NOT "the messages look right". It is that NO LOOKUP WENT
 * UNANSWERED -- a fact about mechanism, which no amount of reading the message
 * recovers. A guard installed on one of two minters is not installed.
 */
describe('verdict-diff: storage mint artifact audit', () => {
  it('answers every artifact lookup its own mint walk makes', async () => {
    const unresolved = new Set<string>();
    const cells = resolveConstructibilityV1(enumerateVerdictDiffCellsV1());
    await runStorageSweepV1(cells.constructible, (reference) => unresolved.add(reference));

    // Named rather than counted: a bare count says a gap exists, the sorted
    // references say WHICH object the fixture failed to supply, which is the
    // difference between a red test and a diagnosis.
    expect([...unresolved].sort()).toStrictEqual([]);
  }, 600_000);

  /**
   * THE POSITIVE CONTROL, WITHOUT WHICH THE ASSERTION ABOVE CANNOT FAIL.
   *
   * An empty unresolved set has two possible causes and the test above cannot
   * tell them apart: the fixture answered every lookup, or the hook was never
   * wired through the sweep/minter/resolver stack and nothing was ever reported.
   * A silent hook and a clean run are the same observation. That is the
   * check-that-cannot-fail shape, and pointing at a mutation run recorded in a
   * commit message does not repair it -- a proof that ran once, elsewhere, is
   * not a control this suite carries.
   *
   * So: mint a head that NAMES an artifact the map does not hold, and require
   * the hook to say so. The head is otherwise real and the omission is one
   * field, which keeps the control close to the failure it guards against --
   * every instance of that failure has been a real head naming one object this
   * fixture did not supply.
   */
  it('reports an unanswered lookup when one exists, so the empty set above means something', async () => {
    const seen: string[] = [];
    // A well-formed digest no artifact in this fixture carries. Deliberately
    // invented HERE, which is the one place inventing a digest is correct: the
    // point is to be unresolvable.
    const absent = `0x${'ab'.repeat(32)}`;
    const namesMissingTransition = {
      ...CORE_CURRENT_HEAD_V1,
      acceptedTransitionDigest: absent,
    } as unknown as Parameters<typeof mintStorageSummaryForHeadV1>[0];

    const result = await mintStorageSummaryForHeadV1(
      namesMissingTransition,
      (reference) => seen.push(reference),
    );

    // The hook fired, and it NAMED the object rather than merely counting.
    expect(seen).toContain(`authority-transition:${absent}`);
    // And the mint refused, so the control exercises the same path a real
    // fixture omission takes rather than a branch reached only by this test.
    expect(result.minted).toBe(false);
  }, 120_000);

  /**
   * THE SAME CONTROL ON THE TOMBSTONE BRANCH, because the one above proves the
   * hook only on the path the defect was NOT on.
   *
   * `mintStorageSummaryForHeadV1` forks on the candidate's state: a tombstone
   * goes through `mintAgentProfileTombstoneClosureV1`, everything else through
   * the verification-closure builder. Each arm passes `onUnresolvedArtifact`
   * SEPARATELY. The control above drives the ACTIVE arm — so deleting the hook
   * from the tombstone arm leaves it green, while the audit loses exactly the
   * omission it was written to catch: the tombstone owned-subject-table defect
   * that survived a full lane with perfect conservation.
   *
   * A guard whose positive control exercises a different branch than the defect
   * is a check that cannot fail for the thing it names. That this one shipped
   * INSIDE the fix for a previous check-that-cannot-fail is the reason it is
   * spelled out here rather than quietly corrected.
   */
  it('reports an unanswered lookup on the TOMBSTONE path too', async () => {
    const seen: string[] = [];
    const absent = `0x${'cd'.repeat(32)}`;

    // A real built tombstone candidate, not a hand-shaped object: the arm is
    // selected by `state`, and a fabricated head would let the control pass
    // while the real tombstone path stayed unexercised.
    const tombstoneCell = {
      id: 'audit-tombstone',
      snapshot: 'present',
      appliedStatus: 'active',
      candidateHeadState: 'tombstone',
      sequenceRelation: 'equal',
      versionRelation: 'above',
      storageOperation: 'tombstone',
      coreDisposition: 'discoverable',
      evidence: [],
      candidateForkResolutionDigest: 'absent',
      clock: 'valid',
    } as unknown as Parameters<typeof buildCoreCandidateHeadV1>[0];

    const build = buildCoreCandidateHeadV1(tombstoneCell);
    expect(build.built).toBe(true);
    if (!build.built) return;
    expect((build.candidate as { state: string }).state).toBe('tombstone');

    const result = await mintStorageSummaryForHeadV1(
      { ...build.candidate, acceptedTransitionDigest: absent } as never,
      (reference) => seen.push(reference),
    );

    expect(seen).toContain(`authority-transition:${absent}`);
    expect(result.minted).toBe(false);
  }, 120_000);
});
