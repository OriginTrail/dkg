import { describe, expect, it } from 'vitest';

import { evaluateAgentProfileHeadAdvanceV1 } from '@origintrail-official/dkg-core/system-record-v1';

import type { VerdictDiffCellV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import {
  buildCoreAcceptedStateV1,
  buildCoreEvidenceV1,
} from './helpers/authority-verdict-diff-core-evidence-v1.js';
import { buildCoreCandidateHeadV1 } from './helpers/authority-verdict-diff-core-heads-v1.js';

/**
 * EVIDENCE IS SELECTED BY THE BRANCH THAT READS IT.
 *
 * Axis J's `acceptedTransition` is not one object. Core's LOWER-sequence
 * tombstone arm takes `retained = lineage[candidateSequence]` and demands the
 * supplied transition match it -- the rotation OUT of the candidate's sequence.
 * Its NEXT-sequence arm compares the supplied transition's digest to the
 * candidate's own `acceptedTransitionDigest` -- the rotation INTO it. A fixture
 * serving one value to both branches manufactures a refusal on whichever branch
 * it is not serving, and records it as core's.
 *
 * This suite is the fail-before for that. Both assertions FAIL under the two
 * previous versions of the selection rule:
 *   - the original single constant (always the 1->2 transition) fails the
 *     next-sequence case;
 *   - sequence-keyed selection (the rotation INTO the candidate's sequence)
 *     fails the lower-sequence tombstone case.
 * Only branch-keyed selection satisfies both, which is what makes this a test of
 * the rule rather than of one of its instances.
 */
describe('verdict-diff: acceptedTransition evidence is branch-selected', () => {
  function verdict(cell: VerdictDiffCellV1): string {
    const head = buildCoreCandidateHeadV1(cell);
    if (!head.built) return `REFUSED|${head.ruleId}`;
    const decision = evaluateAgentProfileHeadAdvanceV1(
      buildCoreAcceptedStateV1(cell) as never,
      head.candidate,
      buildCoreEvidenceV1(cell, new Map()) as never,
    ) as { decision: string; reason?: string };
    return decision.reason === undefined ? decision.decision : `${decision.decision}|${decision.reason}`;
  }

  const base = {
    snapshot: 'present',
    appliedStatus: 'active',
    storageOperation: 'active',
    coreDisposition: 'discoverable',
    candidateForkResolutionDigest: 'absent',
    clock: 'valid',
  } as const;

  it('satisfies the retained-transition check on a LOWER-sequence tombstone', () => {
    const cell = {
      ...base,
      id: 'branch-lower-tombstone',
      candidateHeadState: 'tombstone',
      sequenceRelation: 'below',
      storageOperation: 'tombstone',
      // Both members the branch reads: the predecessor gate comes first, and the
      // retained-transition comparison is only reachable once it passes.
      evidence: ['tombstonePredecessor', 'acceptedTransition'],
    } as unknown as VerdictDiffCellV1;

    // The branch must get PAST the retained-transition comparison. Asserting the
    // absence of that specific reject rather than a particular success verdict:
    // what this pins is that the fixture stopped manufacturing the refusal, not
    // what core then decides, which is the table's business and not this test's.
    expect(verdict(cell))
      .not.toBe('reject|late tombstone requires the exact retained resurrection transition');
  });

  it('satisfies the named-transition check on a NEXT-sequence candidate', () => {
    const cell = {
      ...base,
      id: 'branch-next-sequence',
      candidateHeadState: 'active',
      sequenceRelation: 'plusOne',
      evidence: ['acceptedTransition', 'verifiedAuthoritySummary'],
    } as unknown as VerdictDiffCellV1;

    // The mirror-image refusal: the next-sequence arm compares the supplied
    // transition against the candidate's OWN named digest, so a lower-sequence
    // style selection lands here instead.
    expect(verdict(cell)).not.toBe('reject|exact accepted authority transition is missing');
  });
});
