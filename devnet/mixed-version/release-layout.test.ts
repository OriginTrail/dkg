import { expect, it } from 'vitest';
import { releaseLayoutFailures } from './release-layout.js';

const oldCommit = 'a'.repeat(40);
const candidateCommit = 'b'.repeat(40);
const expected = { coreCommit: candidateCommit, edgeCommit: oldCommit };

it('accepts cores on the candidate and edges on the exact prior release', () => {
  expect(releaseLayoutFailures([
    { num: 1, role: 'core', commit: candidateCommit },
    { num: 2, role: 'core', commit: candidateCommit.toUpperCase() },
    { num: 3, role: 'edge', commit: oldCommit },
  ], expected)).toEqual([]);
});

it('rejects a single-build cluster even if its version labels claim skew', () => {
  expect(releaseLayoutFailures([
    { num: 1, role: 'core', commit: candidateCommit },
    { num: 2, role: 'edge', commit: candidateCommit },
  ], expected)).toEqual([
    `node2 (edge) reports commit ${candidateCommit}; expected ${oldCommit}`,
  ]);
});

it('fails when a role or build identity is absent', () => {
  expect(releaseLayoutFailures([], expected)).toEqual(['no core node observed', 'no edge node observed']);
  expect(releaseLayoutFailures([
    { num: 1, role: 'core', commit: null },
    { num: 2, role: 'edge', commit: oldCommit },
  ], expected)).toEqual([`node1 (core) reports commit <missing>; expected ${candidateCommit}`]);
});

it('requires distinct full expected commits', () => {
  expect(releaseLayoutFailures([], { coreCommit: oldCommit, edgeCommit: oldCommit }))
    .toContain('release core and edge commits must differ');
  expect(releaseLayoutFailures([], { coreCommit: 'v10.0.18', edgeCommit: oldCommit }))
    .toContain('DKG_EXPECTED_CORE_COMMIT must be a full 40-character commit SHA');
});
