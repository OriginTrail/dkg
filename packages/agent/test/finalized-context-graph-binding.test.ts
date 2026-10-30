// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { finalizedContextGraphSnapshotMismatchV1 } from
  '../src/internal/context-graph-authority/finalized-context-graph-binding.js';

const NAME_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_NAME_HASH = `0x${'cd'.repeat(32)}`;
const BOUND = Object.freeze({ active: true, contextGraphId: '7', nameHash: NAME_HASH });

describe('finalized Context Graph snapshot binding', () => {
  it('binds an active snapshot of the named slot and commitment, case-insensitively', () => {
    expect(finalizedContextGraphSnapshotMismatchV1(BOUND, {
      onChainId: 7n,
      nameHash: NAME_HASH,
    })).toBeUndefined();
    expect(finalizedContextGraphSnapshotMismatchV1(
      { ...BOUND, nameHash: `0x${'AB'.repeat(32)}` },
      { onChainId: 7n, nameHash: NAME_HASH },
    )).toBeUndefined();
  });

  it('reports the first failed fact: liveness, then slot, then commitment', () => {
    const expected = { onChainId: 7n, nameHash: NAME_HASH };
    const wrong = { active: false, contextGraphId: '8', nameHash: OTHER_NAME_HASH };
    expect(finalizedContextGraphSnapshotMismatchV1(wrong, expected)).toBe('inactive');
    expect(finalizedContextGraphSnapshotMismatchV1({ ...wrong, active: true }, expected))
      .toBe('context-graph-id');
    expect(finalizedContextGraphSnapshotMismatchV1(
      { ...wrong, active: true, contextGraphId: '7' },
      expected,
    )).toBe('name-hash');
  });

  it('never binds a commitment that is not bytes32 hex, even to itself', () => {
    for (const nameHash of ['cleartext-name', '0x1234', '']) {
      expect(finalizedContextGraphSnapshotMismatchV1(
        { ...BOUND, nameHash },
        { onChainId: 7n, nameHash },
      )).toBe('name-hash');
    }
  });

  it('binds a request for the numeric slot itself without a commitment', () => {
    expect(finalizedContextGraphSnapshotMismatchV1(
      { ...BOUND, nameHash: OTHER_NAME_HASH },
      { onChainId: 7n },
    )).toBeUndefined();
  });
});
