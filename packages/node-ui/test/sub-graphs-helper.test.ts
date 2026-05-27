import { describe, expect, it } from 'vitest';
import { isUserFacingSubGraph, RESERVED_SUB_GRAPH_SLUGS } from '../src/ui/lib/subGraphs.js';

describe('isUserFacingSubGraph (Codex review issue M)', () => {
  it('rejects the reserved `meta` slug', () => {
    expect(isUserFacingSubGraph({ name: 'meta' })).toBe(false);
  });

  it('accepts any non-reserved slug', () => {
    expect(isUserFacingSubGraph({ name: 'recipes' })).toBe(true);
    expect(isUserFacingSubGraph({ name: 'reviews' })).toBe(true);
    expect(isUserFacingSubGraph({ name: 'docs' })).toBe(true);
  });

  it('accepts the `assertion` slug — it is a user-facing sub-graph', () => {
    // Earlier S2 commit (Issue K) had accidentally filtered `assertion`
    // in the Overview path, undercounting vs SubGraphBar/Grid. The
    // canonical contract is `meta`-only.
    expect(isUserFacingSubGraph({ name: 'assertion' })).toBe(true);
  });

  it('exposes RESERVED_SUB_GRAPH_SLUGS as the single source of truth', () => {
    expect(RESERVED_SUB_GRAPH_SLUGS.has('meta')).toBe(true);
    expect(RESERVED_SUB_GRAPH_SLUGS.has('assertion')).toBe(false);
    expect(RESERVED_SUB_GRAPH_SLUGS.size).toBe(1);
  });
});
