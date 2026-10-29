import { describe, expect, it } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { resolveFactsFromSnapshot } from '../src/ccl-fact-resolution.js';

const CCL_ARG = 'https://example.org/ccl-fact#arg';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** A store that answers the snapshot fact query with `rows`, and every other query with none. */
function storeAnswering(rows: Record<string, string>[]): TripleStore {
  return {
    query: async (sparql: string) => ({ type: 'bindings', bindings: sparql.includes('?argVal') ? rows : [] }),
  } as unknown as TripleStore;
}

describe('resolveFactsFromSnapshot literal values', () => {
  it('reads plain, typed and language-tagged literal values', async () => {
    const fact = {
      fact: 'urn:fact:1',
      predicate: `"owner"^^<${XSD}string>`,
      snapshotId: `"snap-literals"^^<${XSD}string>`,
      view: '"accepted"',
      scopeUal: '"ual:dkg:example:literals"',
    };
    const store = storeAnswering([
      { ...fact, argPred: `<${CCL_ARG}0>`, argVal: `"42"^^<${XSD}integer>` },
      { ...fact, argPred: `<${CCL_ARG}1>`, argVal: '"line one\\nline two"@en' },
    ]);

    const resolved = await resolveFactsFromSnapshot(store, {
      contextGraphId: 'ops-literals',
      policyName: 'owner_assertion',
      snapshotId: 'snap-literals',
      view: 'accepted',
      scopeUal: 'ual:dkg:example:literals',
    });

    expect(resolved.facts).toEqual([['owner', 42, 'line one\nline two']]);
  });
});
