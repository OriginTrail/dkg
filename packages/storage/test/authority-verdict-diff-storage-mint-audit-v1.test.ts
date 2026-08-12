import { describe, expect, it } from 'vitest';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
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
});
