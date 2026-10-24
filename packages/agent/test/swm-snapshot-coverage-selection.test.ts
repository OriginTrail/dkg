import { describe, expect, it } from 'vitest';
import { selectSwmSnapshotCoverage } from '../src/sync/requester/shared-memory-sync.js';
import type { SwmSnapshotCoverage } from '../src/dkg-agent-types.js';

/** Ranking operates on whole records: counts and missing samples must stay together. */
describe('SWM snapshot coverage selection', () => {
  const shortfall: SwmSnapshotCoverage = {
    contextGraphId: 'coverage-swm', peerIdSuffix: 'aaaa1111',
    snapshotsResolved: 178, snapshotsTotal: 250, manifestComplete: true,
    missingCount: 72, missingSample: ['did:dkg:ka:from-the-large-manifest'], materializationFailures: 0,
  };
  const smaller: SwmSnapshotCoverage = {
    ...shortfall, peerIdSuffix: 'bbbb2222', snapshotsResolved: 200, snapshotsTotal: 200,
    missingCount: 0, missingSample: [],
  };
  const tiny: SwmSnapshotCoverage = { ...smaller, peerIdSuffix: 'cccc3333', snapshotsResolved: 1, snapshotsTotal: 1 };
  const truncated: SwmSnapshotCoverage = {
    ...shortfall, peerIdSuffix: 'dddd4444', snapshotsResolved: 250, snapshotsTotal: 400,
    manifestComplete: false, missingCount: 150,
  };
  const authority: SwmSnapshotCoverage = {
    ...tiny, peerIdSuffix: '9999cccc', snapshotsResolved: 5, snapshotsTotal: 5, fromAuthority: true,
  };
  const behind: SwmSnapshotCoverage = { ...shortfall, peerIdSuffix: 'eeee5555', snapshotsResolved: 12, missingCount: 238 };
  const later: SwmSnapshotCoverage = { ...shortfall, peerIdSuffix: 'zzzz9999' };
  const cases: { name: string; a: SwmSnapshotCoverage | undefined; b: SwmSnapshotCoverage | undefined; expected: SwmSnapshotCoverage | undefined }[] = [
    { name: 'largest manifest over a better fraction', a: shortfall, b: smaller, expected: shortfall },
    { name: 'large partial manifest over a tiny complete one', a: shortfall, b: tiny, expected: shortfall },
    { name: 'authority evidence before manifest size', a: authority, b: shortfall, expected: authority },
    { name: 'complete manifest before a larger lower bound', a: shortfall, b: truncated, expected: shortfall },
    { name: 'most resolved within the same manifest size', a: shortfall, b: behind, expected: shortfall },
    { name: 'deterministic peer suffix on a tie', a: shortfall, b: later, expected: shortfall },
    { name: 'known record with an absent operand', a: shortfall, b: undefined, expected: shortfall },
    { name: 'both operands absent', a: undefined, b: undefined, expected: undefined },
  ];
  it.each(cases)('$name', ({ a, b, expected }) => {
    for (const [first, second] of [[a, b], [b, a]]) {
      // Identity pins the entire input record; synthesized counts cannot pass.
      expect(selectSwmSnapshotCoverage(first, second)).toBe(expected);
    }
  });

  it('is order-independent across the distinct peer suffixes in the original matrix', () => {
    const records = [shortfall, smaller, tiny, truncated];
    for (const a of records) {
      for (const b of records) {
        expect(selectSwmSnapshotCoverage(a, b)).toBe(selectSwmSnapshotCoverage(b, a));
      }
    }
  });
});
