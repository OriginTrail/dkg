import { createSortedUniqueStringCatalog } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';
import { GraphSetCatalogState } from '../src/graph-set-catalog-state.js';

describe('GraphSetCatalogState', () => {
  it('maintains an existing immutable sorted projection across point mutations', () => {
    const createSortedCatalog = vi.fn(createSortedUniqueStringCatalog);
    const state = new GraphSetCatalogState(createSortedCatalog);
    state.replace(new Set(['urn:d', 'urn:b']));
    const members = state.current!;
    const initial = state.sortedFor(members)!;

    expect(initial).toEqual(['urn:b', 'urn:d']);
    expect(Object.isFrozen(initial)).toBe(true);

    expect(state.add('urn:c')).toBe(true);
    expect(state.add('urn:a')).toBe(true);
    expect(state.remove('urn:d')).toBe(true);
    const updated = state.sortedFor(members)!;

    expect(updated).toEqual(['urn:a', 'urn:b', 'urn:c']);
    expect(updated).not.toBe(initial);
    expect(Object.isFrozen(updated)).toBe(true);
    expect(createSortedCatalog).toHaveBeenCalledTimes(1);
  });

  it('preserves Unicode code-point order rather than UTF-16 code-unit order', () => {
    const state = new GraphSetCatalogState();
    state.replace(new Set(['urn:a', 'urn:\u{10000}']));
    const members = state.current!;
    expect(state.sortedFor(members)).toEqual(['urn:a', 'urn:\u{10000}']);

    state.add('urn:\uE000');
    expect(state.sortedFor(members)).toEqual(['urn:a', 'urn:\uE000', 'urn:\u{10000}']);
    state.remove('urn:\uE000');
    expect(state.sortedFor(members)).toEqual(['urn:a', 'urn:\u{10000}']);
  });

  it('retains the cached projection on no-op mutations', () => {
    const state = new GraphSetCatalogState();
    state.replace(new Set(['urn:a']));
    const members = state.current!;
    const initial = state.sortedFor(members);

    expect(state.add('urn:a')).toBe(false);
    expect(state.remove('urn:missing')).toBe(false);
    expect(state.sortedFor(members)).toBe(initial);
  });
});
