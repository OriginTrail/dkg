import { describe, expect, it } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { createQueryStoreReadContext } from '../src/query-store-read-context.js';

describe('query store-read materialization budget', () => {
  it('charges graph enumeration even when no SPARQL result is materialized', async () => {
    const graphs = Array.from(
      { length: 8 },
      (_, index) => `did:dkg:context-graph:test/_verifiable_memory/${index}-${'x'.repeat(80)}`,
    );
    const store = {
      async listGraphsByPrefix() { return graphs; },
    } as unknown as TripleStore;
    const reads = createQueryStoreReadContext(store, { maxMaterializedBytes: 128 });

    await expect(reads.listGraphsByPrefix('did:dkg:context-graph:test/'))
      .rejects.toMatchObject({
        code: 'QUERY_MATERIALIZATION_TOO_LARGE',
        maxBytes: 128,
        actualBytes: expect.any(Number),
      });
  });

  it('uses one cumulative budget for graph enumeration and query results', async () => {
    const graphs = [`urn:graph:${'x'.repeat(48)}`];
    const queryResult = { type: 'bindings' as const, bindings: [{ value: '"ok"' }] };
    const graphBytes = Buffer.byteLength(JSON.stringify(graphs), 'utf8');
    const resultBytes = Buffer.byteLength(JSON.stringify(queryResult), 'utf8');
    const store = {
      async listGraphsByPrefix() { return graphs; },
      async query() { return queryResult; },
    } as unknown as TripleStore;
    const reads = createQueryStoreReadContext(store, {
      maxMaterializedBytes: Math.max(graphBytes, resultBytes),
    });

    await expect(reads.listGraphsByPrefix('urn:graph:')).resolves.toEqual(graphs);
    await expect(reads.query('SELECT ?value WHERE { ?s ?p ?value }'))
      .rejects.toMatchObject({
        code: 'QUERY_MATERIALIZATION_TOO_LARGE',
        actualBytes: graphBytes + resultBytes,
      });
  });
});
