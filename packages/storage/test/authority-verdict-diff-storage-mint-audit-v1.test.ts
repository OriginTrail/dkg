import { describe, expect, it } from 'vitest';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import { CORE_CURRENT_HEAD_V1 } from './helpers/authority-verdict-diff-core-heads-v1.js';
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
});
