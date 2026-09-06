import { createSortedUniqueStringCatalog } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';
import { GraphSetCatalogState } from '../src/graph-set-catalog-state.js';

vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return {
    ...actual,
    createSortedUniqueStringCatalog: vi.fn(actual.createSortedUniqueStringCatalog),
  };
});

describe('GraphSetCatalogState', () => {
  it('maintains an existing immutable sorted projection across singleton reconciliations', () => {
    const createSortedCatalog = vi.mocked(createSortedUniqueStringCatalog);
    createSortedCatalog.mockClear();
    const state = new GraphSetCatalogState();
    state.replace(new Set(['urn:d', 'urn:b']));
    const members = state.current!;
    const initial = state.sortedFor(members)!;

    expect(initial).toEqual(['urn:b', 'urn:d']);
    expect(Object.isFrozen(initial)).toBe(true);

    expect(state.reconcile([{ graph: 'urn:c', present: true }])).toEqual({
      added: ['urn:c'],
      removed: [],
    });
    expect(state.reconcile([{ graph: 'urn:a', present: true }])).toEqual({
      added: ['urn:a'],
      removed: [],
    });
    expect(state.reconcile([{ graph: 'urn:d', present: false }])).toEqual({
      added: [],
      removed: ['urn:d'],
    });
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

    expect(state.reconcile([{ graph: 'urn:\uE000', present: true }])).toEqual({
      added: ['urn:\uE000'],
      removed: [],
    });
    expect(state.sortedFor(members)).toEqual(['urn:a', 'urn:\uE000', 'urn:\u{10000}']);
    expect(state.reconcile([{ graph: 'urn:\uE000', present: false }])).toEqual({
      added: [],
      removed: ['urn:\uE000'],
    });
    expect(state.sortedFor(members)).toEqual(['urn:a', 'urn:\u{10000}']);
  });

  it('retains the cached projection on no-op mutations', () => {
    const state = new GraphSetCatalogState();
    state.replace(new Set(['urn:a']));
    const members = state.current!;
    const initial = state.sortedFor(members);

    expect(state.reconcile([{ graph: 'urn:a', present: true }])).toEqual({
      added: [],
      removed: [],
    });
    expect(state.reconcile([{ graph: 'urn:missing', present: false }])).toEqual({
      added: [],
      removed: [],
    });
    expect(state.sortedFor(members)).toBe(initial);
  });

  it('rebuilds an existing projection at most once for a large mixed reconciliation', () => {
    const createSortedCatalog = vi.mocked(createSortedUniqueStringCatalog);
    createSortedCatalog.mockClear();
    const state = new GraphSetCatalogState();
    state.replace(new Set(['urn:keep', 'urn:remove:a', 'urn:remove:b']));
    const members = state.current!;
    state.sortedFor(members);
    createSortedCatalog.mockClear();

    const additions = Array.from({ length: 1_000 }, (_, index) => `urn:add:${index}`);
    expect(state.reconcile([
      ...additions.map((graph) => ({ graph, present: true })),
      { graph: additions[0]!, present: true },
      { graph: 'urn:remove:a', present: false },
      { graph: 'urn:remove:b', present: false },
      { graph: 'urn:missing', present: false },
    ])).toEqual({ added: additions, removed: ['urn:remove:a', 'urn:remove:b'] });
    expect(createSortedCatalog).toHaveBeenCalledOnce();
    expect(state.sortedFor(members)).toEqual(['urn:keep', ...additions].sort());
  });
});
