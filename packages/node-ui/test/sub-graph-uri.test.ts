import { describe, expect, it } from 'vitest';
import { subGraphFromAssertionGraphUri } from '../src/ui/lib/sub-graph-uri.js';

// Mirror of `contextGraphAssertionUri` in `packages/core/src/constants.ts`.
// PR #839 sweep 1 — restored as a migration fallback for pre-#770
// scoped lifecycle events that carry `dkg:assertionGraph` but not the
// `dkg:subGraphName` predicate added by PR #770. The hook prefers the
// new predicate when present and falls back here for legacy rows.
describe('subGraphFromAssertionGraphUri — slug parse (pre-#770 migration fallback)', () => {
  it('returns the slug for sub-graph-scoped assertions', () => {
    const uri = 'did:dkg:context-graph:cg-1/research/assertion/0xabc/notes';
    expect(subGraphFromAssertionGraphUri(uri, 'cg-1')).toBe('research');
  });

  it('returns undefined for root-bucket assertions', () => {
    const uri = 'did:dkg:context-graph:cg-1/assertion/0xabc/notes';
    expect(subGraphFromAssertionGraphUri(uri, 'cg-1')).toBeUndefined();
  });

  it('returns undefined when the prefix does not match the contextGraphId', () => {
    const uri = 'did:dkg:context-graph:cg-2/research/assertion/0xabc/notes';
    expect(subGraphFromAssertionGraphUri(uri, 'cg-1')).toBeUndefined();
  });

  it('returns undefined for malformed URIs that lack the assertion segment', () => {
    expect(subGraphFromAssertionGraphUri('did:dkg:context-graph:cg-1/research', 'cg-1')).toBeUndefined();
    expect(subGraphFromAssertionGraphUri('did:dkg:context-graph:cg-1/research/other/0xabc/notes', 'cg-1')).toBeUndefined();
    expect(subGraphFromAssertionGraphUri('', 'cg-1')).toBeUndefined();
  });
});
