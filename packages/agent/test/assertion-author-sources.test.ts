import { describe, expect, it } from 'vitest';
import { ASSERTION_SEAL_PREDICATES, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import {
  resolveFinalizedAssertionAuthor,
  type AssertionAuthorQueryStore,
} from '../src/finalized-assertion-author.js';

// RFC-73 P1b: the two pre-queue reads of the author scan carry their own `source` labels, so a
// store-scheduler rejection on the async VM publish route names the read that was refused.
describe('finalized assertion author scan source labels', () => {
  const CG = 'author-scan-cg';
  const NAME = 'asset';
  const SUBJECT = `${contextGraphMetaUri(CG)}/seal-subject`;

  function recordingStore() {
    const calls: Array<{ sparql: string; options: unknown }> = [];
    const store: AssertionAuthorQueryStore = {
      async query(sparql, options) {
        calls.push({ sparql, options });
        if (sparql.startsWith('SELECT DISTINCT ?s')) {
          return { type: 'bindings', bindings: [{ s: SUBJECT }] };
        }
        return { type: 'quads', quads: [] };
      },
    };
    return { store, calls };
  }

  it('labels the candidate scan and the per-subject seal read separately', async () => {
    const { store, calls } = recordingStore();

    // The stubbed seal has no rows, so it is not a complete candidate and nothing resolves.
    expect(await resolveFinalizedAssertionAuthor(store, { contextGraphId: CG, name: NAME })).toBeUndefined();

    expect(calls.map((c) => c.options)).toEqual([
      { source: 'agent.assertionAuthor.scan' },
      { source: 'agent.assertionAuthor.seal' },
    ]);
    expect(calls[0]!.sparql).toContain(ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT);
    expect(calls[1]!.sparql).toContain('CONSTRUCT');
  });

  it('issues no seal read when the scan finds no candidate subject', async () => {
    const calls: unknown[] = [];
    const store: AssertionAuthorQueryStore = {
      async query(_sparql, options) {
        calls.push(options);
        return { type: 'bindings', bindings: [] };
      },
    };

    expect(await resolveFinalizedAssertionAuthor(store, { contextGraphId: CG, name: NAME })).toBeUndefined();

    expect(calls).toEqual([{ source: 'agent.assertionAuthor.scan' }]);
  });
});
