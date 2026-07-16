import { describe, expect, it } from 'vitest';
import { isUserFacingSubGraph, RESERVED_SUB_GRAPH_SLUGS, ROOT_SLUG_SENTINEL } from '../src/ui/lib/subGraphs.js';
import { subGraphOf } from '../src/ui/hooks/useMemoryEntities.js';

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

describe('ROOT_SLUG_SENTINEL', () => {
  // S3 fold-in. The Root chip carries this sentinel as its
  // "selected" identifier — the daemon's slug guard rejects
  // underscore-prefixed segments, so this can never collide with a
  // real sub-graph slug. The double-underscore prefix is
  // load-bearing.
  it('is `__root__` (double-underscore prefix; collision-free with daemon slugs)', () => {
    expect(ROOT_SLUG_SENTINEL).toBe('__root__');
    // Daemon-side slugs are alphanumeric/-/_ but never start with `_`
    // (server-side filter). Anchor the contract here so a future
    // sentinel rename can't silently produce a colliding slug.
    expect(ROOT_SLUG_SENTINEL.startsWith('__')).toBe(true);
  });

  it('is excluded from the reserved-set membership rule', () => {
    // RESERVED_SUB_GRAPH_SLUGS governs *daemon-emitted* slug
    // suppression. ROOT_SLUG_SENTINEL is a client-only synthesized
    // slug — by construction the daemon can never emit it, so it
    // doesn't belong in the reserved set. `isUserFacingSubGraph`
    // would technically return true for it (irrelevant — daemon
    // never emits it), but the reserved set stays at {'meta'}.
    expect(RESERVED_SUB_GRAPH_SLUGS.has(ROOT_SLUG_SENTINEL)).toBe(false);
  });
});

describe('subGraphOf — reserved-bookkeeping slug guards (fold-in #5)', () => {
  // Phantom-slug repro. Pre-fix this URI emitted `'assertion'` as a
  // user-facing slug, which `SubGraphBadge` then rendered as a fake
  // "Assertion" pill on every WM entity detail's References /
  // Referenced By section. The fix admits `'assertion'` to the guard
  // alongside underscore-prefixed bookkeeping segments.
  it('returns undefined for WM assertion graphs (`<cg>/assertion/<addr>/<name>`)', () => {
    expect(subGraphOf('did:dkg:context-graph:cg-1/assertion/0xabc/notes', 'cg-1')).toBeUndefined();
  });

  it('keeps user-facing sub-graph slugs intact', () => {
    expect(subGraphOf('did:dkg:context-graph:cg-1/research/assertion/0xabc/notes', 'cg-1')).toBe('research');
    expect(subGraphOf('did:dkg:context-graph:cg-1/recipes', 'cg-1')).toBe('recipes');
  });

  it('returns undefined for underscore-prefixed bookkeeping graphs', () => {
    expect(subGraphOf('did:dkg:context-graph:cg-1/_shared_memory', 'cg-1')).toBeUndefined();
    expect(subGraphOf('did:dkg:context-graph:cg-1/_meta', 'cg-1')).toBeUndefined();
  });

  it('returns undefined for graphs outside the project prefix', () => {
    expect(subGraphOf('did:dkg:context-graph:other/research', 'cg-1')).toBeUndefined();
    expect(subGraphOf('urn:not-a-cg', 'cg-1')).toBeUndefined();
  });

  // GH #806 — pre-fix this URI emitted `'meta'` as the slug, so
  // entities whose only sub-graph membership came from a
  // `<cg>/meta/_shared_memory` write ended up with
  // `subGraphs = Set{'meta'}`. Downstream `RESERVED_SUB_GRAPH_SLUGS`
  // filtered the chip render but `SubGraphBar.entityScopedAllTotal`
  // and `rootEntityCount` both counted those entities incorrectly:
  // `All` included them (non-zero subGraphs in narrowed mode passes
  // the layer filter) while `Root` excluded them (`subGraphs.size > 0`
  // skip), producing the `Tuesday CG SWM 36 / 34` 2-entity gap. The
  // fix treats `meta` symmetrically to `assertion` — both are
  // internal bookkeeping prefixes, neither is a user-facing slug.
  it('returns undefined for `meta` bookkeeping graphs (GH #806)', () => {
    expect(subGraphOf('did:dkg:context-graph:cg-1/meta/_shared_memory', 'cg-1')).toBeUndefined();
    expect(subGraphOf('did:dkg:context-graph:cg-1/meta/_verifiable_memory', 'cg-1')).toBeUndefined();
    expect(subGraphOf('did:dkg:context-graph:cg-1/meta', 'cg-1')).toBeUndefined();
  });

  // Regression guard — the fix must not regress the
  // user-facing-slug + bookkeeping-tail pattern. Sub-graphs whose
  // NAME happens to be `meta` would never reach here in practice
  // (RESERVED_SUB_GRAPH_SLUGS rejects them downstream and the daemon
  // doesn't emit `meta` as a registered sub-graph), but a user-facing
  // slug containing `meta` as a path segment in some non-leading
  // position must survive: e.g. a hypothetical `recipes` sub-graph
  // with `<cg>/recipes/meta/...` keeps `'recipes'` as the slug.
  it('keeps user-facing sub-graph slugs intact when `meta` appears in a non-leading segment (GH #806 regression)', () => {
    expect(subGraphOf('did:dkg:context-graph:cg-1/recipes/_shared_memory', 'cg-1')).toBe('recipes');
    expect(subGraphOf('did:dkg:context-graph:cg-1/recipes/meta/anything', 'cg-1')).toBe('recipes');
  });
});
