import { describe, expect, it } from 'vitest';
import { subGraphFromAssertionGraphUri } from '../src/ui/lib/sub-graph-uri.js';

// Mirror of `contextGraphAssertionUri` in `packages/core/src/constants.ts`.
// The writer's URI shape is the authoritative source for the slug; the
// lifecycle metadata never emits `dkg:subGraphName` directly. PR #710 —
// helper relocated from `useAssertionLifecycleEvents.ts` into `lib/` so
// `api.ts` and the lifecycle hook can both consume it without forming
// a module cycle.
describe('subGraphFromAssertionGraphUri — slug parse', () => {
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
