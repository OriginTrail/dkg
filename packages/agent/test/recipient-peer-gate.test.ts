// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import { peerGateStayedCurrent, sameStringSet } from '../src/internal/recipient-peer-gate.js';

describe('sameStringSet', () => {
  it('compares members, not order or repeats', () => {
    expect(sameStringSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameStringSet(['a', 'a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameStringSet([], [])).toBe(true);
    expect(sameStringSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameStringSet(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});

describe('peerGateStayedCurrent', () => {
  const steady = () => 'rev';

  it.each([
    ['the same members', ['a', 'b'], ['b', 'a'], true],
    ['one member fewer', ['a', 'b'], ['a'], false],
    ['one member swapped', ['a', 'b'], ['a', 'c'], false],
    ['no gate on both sides', null, null, true],
    ['a gate that appeared', null, ['a'], false],
    ['a gate that went away', ['a'], null, false],
  ] as const)('compares %s by content', async (_label, resolvedWith, current, expected) => {
    await expect(peerGateStayedCurrent(resolvedWith, async () => current, steady)).resolves.toBe(expected);
  });

  it('does not trust a read that overlapped an invalidation, and uses the one that did not', async () => {
    let revision = 0;
    let calls = 0;
    const readGate = vi.fn(async () => {
      calls += 1;
      // A removal landed during the first read, which still returned what it began with.
      if (calls === 1) { revision += 1; return ['a', 'b']; }
      return ['a'];
    });

    await expect(peerGateStayedCurrent(['a', 'b'], readGate, () => String(revision))).resolves.toBe(false);
    expect(readGate).toHaveBeenCalledTimes(2);
  });

  it('accepts the settled read when it matches', async () => {
    let revision = 0;
    let calls = 0;
    const readGate = async () => {
      calls += 1;
      if (calls === 1) { revision += 1; return ['a', 'b']; }
      return ['a'];
    };
    await expect(peerGateStayedCurrent(['a'], readGate, () => String(revision))).resolves.toBe(true);
    expect(calls).toBe(2);
  });

  it('ignores an invalidation that landed before the read began', async () => {
    let revision = 0;
    const readGate = vi.fn(async () => ['a']);
    revision += 5;
    await expect(peerGateStayedCurrent(['a'], readGate, () => String(revision))).resolves.toBe(true);
    expect(readGate).toHaveBeenCalledTimes(1);
  });

  it('is not current when it never settles, after exactly the attempts allowed', async () => {
    let revision = 0;
    const readGate = vi.fn(async () => { revision += 1; return ['a']; });
    await expect(peerGateStayedCurrent(['a'], readGate, () => String(revision))).resolves.toBe(false);
    expect(readGate).toHaveBeenCalledTimes(3);
    readGate.mockClear();
    await expect(peerGateStayedCurrent(['a'], readGate, () => String(revision), 5)).resolves.toBe(false);
    expect(readGate).toHaveBeenCalledTimes(5);
  });
});
