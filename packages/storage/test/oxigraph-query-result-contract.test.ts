import { describe, expect, it } from 'vitest';

import { OxigraphStore } from '../src/adapters/oxigraph.js';

describe('OxigraphStore query result contract', () => {
  it('preserves the query form for empty SELECT, CONSTRUCT, DESCRIBE, and ASK results', async () => {
    const store = new OxigraphStore();
    try {
      await expect(store.query(
        'SELECT ?s WHERE { GRAPH <urn:missing> { ?s ?p ?o } }',
      )).resolves.toEqual({ type: 'bindings', bindings: [] });
      await expect(store.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:missing> { ?s ?p ?o } }',
      )).resolves.toEqual({ type: 'quads', quads: [] });
      await expect(store.query(
        'DESCRIBE <urn:missing>',
      )).resolves.toEqual({ type: 'quads', quads: [] });
      await expect(store.query(
        'ASK { GRAPH <urn:missing> { ?s ?p ?o } }',
      )).resolves.toEqual({ type: 'boolean', value: false });
    } finally {
      await store.close();
    }
  });

  it('recognizes an empty graph query after comments and declarations', async () => {
    const store = new OxigraphStore();
    try {
      const result = await store.query(`
        # The operation keyword is intentionally not the first token.
        BASE <https://example.org/>
        PREFIX ex: <https://example.org/ns#>
        CONSTRUCT { ?s ex:value ?o }
        WHERE { GRAPH <urn:missing> { ?s ex:value ?o } }
      `);
      expect(result).toEqual({ type: 'quads', quads: [] });
    } finally {
      await store.close();
    }
  });

  it('keeps non-empty CONSTRUCT results as quads', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([{
        subject: 'urn:subject',
        predicate: 'urn:predicate',
        object: 'urn:object',
        graph: 'urn:graph',
      }]);
      const result = await store.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:graph> { ?s ?p ?o } }',
      );
      expect(result).toEqual({
        type: 'quads',
        quads: [{
          subject: 'urn:subject',
          predicate: 'urn:predicate',
          object: 'urn:object',
          graph: '',
        }],
      });
    } finally {
      await store.close();
    }
  });
});
