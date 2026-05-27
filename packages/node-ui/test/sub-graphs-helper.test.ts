import { describe, expect, it } from 'vitest';
import { isUserFacingSubGraph, RESERVED_SUB_GRAPH_SLUGS } from '../src/ui/lib/subGraphs.js';

describe('isUserFacingSubGraph', () => {
  it('rejects the reserved `meta` slug', () => {
    expect(isUserFacingSubGraph({ name: 'meta' })).toBe(false);
  });

  it('accepts any non-reserved slug', () => {
    expect(isUserFacingSubGraph({ name: 'recipes' })).toBe(true);
    expect(isUserFacingSubGraph({ name: 'reviews' })).toBe(true);
    expect(isUserFacingSubGraph({ name: 'docs' })).toBe(true);
  });

  it('exposes RESERVED_SUB_GRAPH_SLUGS as the single source of truth', () => {
    expect(RESERVED_SUB_GRAPH_SLUGS.has('meta')).toBe(true);
    expect(RESERVED_SUB_GRAPH_SLUGS.size).toBe(1);
  });
});
