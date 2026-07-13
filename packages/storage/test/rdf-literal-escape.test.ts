import { describe, expect, it } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import { formatSparqlJsonBindings } from '../src/adapters/sparql-json-results.js';

const lexical = 'line1\nline2\tcontrol:\u0001 del:\u007F quote:" slash:\\ café Δ';
const escaped = 'line1\\nline2\\tcontrol:\\u0001 del:\\u007F quote:\\" slash:\\\\ café Δ';
const expectedBindings = [{
  plain: `"${escaped}"`,
  language: `"${escaped}"@en`,
  typed: `"${escaped}"^^<urn:test:datatype>`,
}];

function selectResponse(): Response {
  return new Response(JSON.stringify({
    head: { vars: ['plain', 'language', 'typed'] },
    results: {
      bindings: [{
        plain: { type: 'literal', value: lexical },
        language: { type: 'literal', value: lexical, 'xml:lang': 'en' },
        typed: { type: 'typed-literal', value: lexical, datatype: 'urn:test:datatype' },
      }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/sparql-results+json' } });
}

describe('RDF binding literal escaping', () => {
  it('converts complete adapter SPARQL JSON SELECT bindings in one shared boundary', () => {
    expect(formatSparqlJsonBindings({
      head: { vars: ['uri', 'blank', 'missing', 'plain', 'language', 'typed', 'xsdString'] },
      results: {
        bindings: [{
          uri: { type: 'uri', value: 'urn:test:entity' },
          blank: { type: 'bnode', value: 'blank' },
          plain: { type: 'literal', value: lexical },
          language: { type: 'literal', value: lexical, 'xml:lang': 'en' },
          typed: { type: 'typed-literal', value: lexical, datatype: 'urn:test:datatype' },
          xsdString: {
            type: 'typed-literal',
            value: lexical,
            datatype: 'http://www.w3.org/2001/XMLSchema#string',
          },
        }],
      },
    })).toEqual([{
      uri: 'urn:test:entity',
      blank: '_:blank',
      plain: expectedBindings[0].plain,
      language: expectedBindings[0].language,
      typed: expectedBindings[0].typed,
      xsdString: expectedBindings[0].plain,
    }]);
    expect(formatSparqlJsonBindings({})).toEqual([]);
  });

  it('returns exact valid N-term bindings after an Oxigraph round trip', async () => {
    const store = new OxigraphStore();
    const object = expectedBindings[0].plain;
    await store.insert([{
      subject: 'urn:test:subject',
      predicate: 'http://schema.org/name',
      object,
      graph: 'urn:test:graph',
    }]);

    const result = await store.query(
      'SELECT ?o WHERE { GRAPH <urn:test:graph> { <urn:test:subject> <http://schema.org/name> ?o } }',
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') expect(result.bindings).toEqual([{ o: object }]);
  });

  it.each([
    ['SPARQL HTTP', () => new SparqlHttpStore({
      queryEndpoint: 'http://binding.test/query',
      updateEndpoint: 'http://binding.test/update',
    })],
    ['Blazegraph', () => new BlazegraphStore('http://binding.test/sparql')],
  ])('%s escapes plain, language-tagged, and typed result bindings', async (_name, makeStore) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => selectResponse()) as typeof fetch;
    try {
      const result = await makeStore().query('SELECT ?plain ?language ?typed WHERE {}');
      expect(result.type).toBe('bindings');
      if (result.type === 'bindings') expect(result.bindings).toEqual(expectedBindings);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
