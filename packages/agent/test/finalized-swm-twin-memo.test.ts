import { describe, expect, it } from 'vitest';
import { FinalizedSwmTwinMemoV1 } from '../src/sync/requester/finalized-swm-twin-memo.js';

const asset = {
  kaUal: 'did:dkg:hardhat:31337/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/7',
  assertionVersion: '1',
  publicQuadsDigest: 'digest-a',
  publicQuadsCount: 2,
} as const;
const version = (n: number) => ({ ...asset, assertionVersion: String(n) });

describe('the finalized shared-memory twins this node retired', () => {
  it('remembers exactly the snapshot whose retirement it was told of', () => {
    const memo = new FinalizedSwmTwinMemoV1();
    memo.remember('cg-a', asset);

    expect(memo.retired('cg-a', asset)).toBe(true);
    expect(memo.retired('cg-b', asset)).toBe(false);
    expect(memo.retired('cg-a', { ...asset, subGraphName: 'notes' })).toBe(false);
    expect(memo.retired('cg-a', version(2))).toBe(false);
    expect(memo.retired('cg-a', { ...asset, publicQuadsDigest: 'digest-b' })).toBe(false);
    expect(memo.retired('cg-a', { ...asset, publicQuadsCount: 3 })).toBe(false);
    expect(memo.retired('cg-a', { ...asset, privateMerkleRoot: '0x01' })).toBe(false);
  });

  it('forgets a retirement once its entry expires', () => {
    let now = 0;
    const memo = new FinalizedSwmTwinMemoV1({ ttlMs: 1_000, now: () => now });
    memo.remember('cg', asset);

    now = 999;
    expect(memo.retired('cg', asset)).toBe(true);
    now = 1_000;
    expect(memo.retired('cg', asset)).toBe(false);
    // The expired entry is gone, not only hidden.
    now = 0;
    expect(memo.retired('cg', asset)).toBe(false);
  });

  it('keeps at most its bound, letting the least recently used go', () => {
    const memo = new FinalizedSwmTwinMemoV1({ maxEntries: 2 });
    memo.remember('cg', version(1));
    memo.remember('cg', version(2));
    expect(memo.retired('cg', version(1))).toBe(true);

    memo.remember('cg', version(3));
    expect(memo.retired('cg', version(2))).toBe(false);
    expect(memo.retired('cg', version(1))).toBe(true);
    expect(memo.retired('cg', version(3))).toBe(true);
  });
});
