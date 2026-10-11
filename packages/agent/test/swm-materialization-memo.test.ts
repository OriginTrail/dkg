import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { createSwmMaterializationMemo } from '../src/sync/requester/swm-materialization-memo.js';

const version = { assertionGraph: 'urn:ka:graph', publicQuadsDigest: 'first', publicQuadsCount: 2 };
const stable = { generation: 1, stable: true };
function memo() {
  return createSwmMaterializationMemo({
    writeRevisionCoverage: 'all-writers', getWriteRevision: () => stable,
  } as unknown as TripleStore);
}
afterEach(() => vi.useRealTimers());

describe('graph-keyed SWM materialization memo', () => {
  it('keeps only the latest admitted version of one graph', () => {
    const cache = memo();
    cache.admit(version, stable, stable);
    expect(cache.has(version)).toBe(true);
    const next = { ...version, publicQuadsDigest: 'second' };
    cache.admit(next, stable, stable);
    expect(cache.has(version)).toBe(false);
    expect(cache.has(next)).toBe(true);
    cache.invalidate(version.assertionGraph);
    expect(cache.has(next)).toBe(false);
  });

  it('requires a matching stable revision around validation and a nonempty projection', () => {
    const cache = memo();
    for (const [before, after] of [
      [stable, { generation: 2, stable: true }],
      [null, stable], [stable, null],
      [{ ...stable, stable: false }, stable], [stable, { ...stable, stable: false }],
    ] as const) {
      cache.admit(version, before, after);
      expect(cache.has(version)).toBe(false);
    }
    cache.admit({ ...version, publicQuadsCount: 0 }, stable, stable);
    expect(cache.has({ ...version, publicQuadsCount: 0 })).toBe(false);
  });

  it('expires successful validation after thirty seconds', () => {
    vi.useFakeTimers();
    const cache = memo();
    cache.admit(version, stable, stable);
    vi.advanceTimersByTime(29_999);
    expect(cache.has(version)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(cache.has(version)).toBe(false);
  });
});
