import { describe, expect, it } from 'vitest';
import {
  bytesToHex,
  createFallbackPages,
  packNibblePrefix,
  setCommitment,
  verifyFallbackPages
} from '../src/index.js';
import { deterministicId, deterministicSet } from '../scripts/fixtures.js';

describe('16-way radix set commitment', () => {
  it('is deterministic, insertion-order independent, and change-sensitive', () => {
    const ids = deterministicSet('commitment', 300);
    const root = setCommitment(ids);
    expect(bytesToHex(root)).toHaveLength(64);
    expect(setCommitment([...ids].reverse())).toEqual(root);
    expect(setCommitment([...ids, deterministicId('extra')])).not.toEqual(root);
    expect(setCommitment([])).toEqual(setCommitment([]));
    expect(() => setCommitment([ids[0], ids[0]])).toThrow('duplicate');
    expect(() => setCommitment([new Uint8Array(31)])).toThrow('exactly 32');
  });

  it('packs odd prefixes into the high nibble and rejects invalid prefixes', () => {
    expect(packNibblePrefix([0xa, 0xb, 0xc])).toEqual(Uint8Array.of(0xab, 0xc0));
    expect(packNibblePrefix([])).toEqual(new Uint8Array());
    expect(() => packNibblePrefix([16])).toThrow('invalid nibble');
    expect(() => packNibblePrefix([-1])).toThrow('invalid nibble');
    expect(() => packNibblePrefix([1.5])).toThrow('invalid nibble');
    expect(() => packNibblePrefix(Array.from({ length: 65 }, () => 0))).toThrow('too long');
  });

  it('splits at odd and even nibble depths with sparse child bitmaps', () => {
    const ids = deterministicSet('deep-commitment', 300).map((id) => {
      const forced = new Uint8Array(id);
      forced[0] = 0xa0 | (forced[0] & 0x0f);
      return forced;
    });
    expect(bytesToHex(setCommitment(ids))).toHaveLength(64);
    expect(setCommitment([...ids].reverse())).toEqual(setCommitment(ids));
  });
});

describe('sorted paginated fallback', () => {
  it('round-trips exact sorted IDs and verifies count and root', () => {
    const ids = deterministicSet('fallback', 7).reverse();
    const pages = createFallbackPages(ids, 3);
    const verified = verifyFallbackPages(pages, ids.length, setCommitment(ids));
    expect(verified).toHaveLength(7);
    expect(pages.map((page) => page.offset)).toEqual([0, 3, 6]);
    expect(pages.map((page) => page.done)).toEqual([false, false, true]);
    expect(createFallbackPages([], 3)).toEqual([{ offset: 0, ids: [], done: true }]);
    expect(() => createFallbackPages(ids, 0)).toThrow('pageSize');
  });

  it('rejects page, count, ordering, and root corruption', () => {
    const ids = deterministicSet('fallback-corrupt', 4);
    const root = setCommitment(ids);
    const pages = createFallbackPages(ids, 2);
    expect(() => verifyFallbackPages([{ ...pages[0], offset: 1 }, pages[1]], 4, root)).toThrow('offset');
    expect(() => verifyFallbackPages([{ ...pages[0], done: true }, pages[1]], 4, root)).toThrow('done');
    expect(() => verifyFallbackPages(pages, 5, root)).toThrow('count');
    expect(() => verifyFallbackPages(pages, -1, root)).toThrow('expectedCount');
    const unordered = createFallbackPages(ids, 4);
    [unordered[0].ids[0], unordered[0].ids[1]] = [unordered[0].ids[1], unordered[0].ids[0]];
    expect(() => verifyFallbackPages(unordered, 4, root)).toThrow('strictly sorted');
    expect(() => verifyFallbackPages(pages, 4, deterministicId('wrong-root'))).toThrow('root');
  });
});
