import { describe, expect, it } from 'vitest';
import { decodeSharedMemoryExpiredOperations } from '../src/swm-expiry-operation.js';

describe('decodeSharedMemoryExpiredOperations', () => {
  it('decodes legacy and graph-v2 projections while deduplicating repeated roots', () => {
    expect(decodeSharedMemoryExpiredOperations({
      type: 'bindings',
      bindings: [
        { op: 'urn:legacy', re: 'urn:root:a' },
        { op: 'urn:legacy', re: 'urn:root:a' },
        {
          op: 'urn:v2',
          re: 'urn:root:b',
          scopeVersion: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
        },
        {
          op: 'urn:v2',
          re: 'urn:root:c',
          scopeVersion: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
          kaUal: 'did:dkg:test/1',
          snapshotGraph: 'urn:snapshot',
        },
      ],
    })).toEqual([
      { uri: 'urn:legacy', roots: ['urn:root:a'], scope: { kind: 'legacy' } },
      {
        uri: 'urn:v2',
        roots: ['urn:root:b', 'urn:root:c'],
        scope: { kind: 'graph-v2', kaUal: 'did:dkg:test/1', snapshotGraph: 'urn:snapshot' },
      },
    ]);
  });

  it('returns no candidates for non-binding query results', () => {
    expect(decodeSharedMemoryExpiredOperations({ type: 'boolean', value: false })).toEqual([]);
  });
});
