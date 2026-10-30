import { Store } from 'oxigraph';
import { describe, expect, it } from 'vitest';
import { createManagedOxigraphSparqlStoreV1 } from '../src/index.js';
import { decodeSparqlJsonQueryResult } from '../src/sparql-json-query-result.js';

describe('managed SELECT compatibility with Oxigraph serializers', () => {
  it('streams actual Oxigraph TSV with the same public bindings as its JSON output', async () => {
    const database = new Store();
    database.load('<urn:subject> <urn:blank> _:stable .', { format: 'application/n-triples' });
    const query = String.raw`
      SELECT ?id ?iri ?blank ?plain ?language ?typed ?number ?boolean ?optional WHERE {
        <urn:subject> <urn:blank> ?blank .
        BIND(<urn:item> AS ?iri)
        VALUES (?id ?plain ?language ?typed ?number ?boolean ?optional) {
          (1 "tabs\tlines\nquotes\"slash\\ Živjo 🌍" "colour"@en-GB "custom"^^<urn:type> 42 true UNDEF)
          (2 "" "farbe"@de "5"^^<http://www.w3.org/2001/XMLSchema#integer> 1.25 false "present")
        }
      } ORDER BY ?id
    `.trim();
    const json = database.query(query, { results_format: 'application/sparql-results+json' });
    if (typeof json !== 'string') throw new Error('Oxigraph did not serialize JSON');
    const expected = decodeSparqlJsonQueryResult(json, 'select');
    if (expected.type !== 'bindings') throw new Error('Oxigraph did not return SELECT bindings');
    expect(expected.bindings).toHaveLength(2);
    expect(expected.bindings[0]).not.toHaveProperty('optional');
    expect(expected.bindings[1]).toHaveProperty('optional', '"present"');

    const originalFetch = globalThis.fetch;
    const accepts: string[] = [];
    let serializedTsv: string | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get('Accept') ?? '';
      accepts.push(accept);
      expect(accept).toBe('text/tab-separated-values');
      expect(init?.body).toBe(query);
      const body = database.query(String(init?.body), { results_format: accept });
      if (typeof body !== 'string') throw new Error('Oxigraph did not serialize TSV');
      serializedTsv = body;
      const bytes = new TextEncoder().encode(body);
      let offset = 0;
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          const end = Math.min(offset + 7, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }), { headers: { 'Content-Type': 'text/tab-separated-values; charset=utf-8' } });
      response.text = async () => { throw new Error('TSV must use the streaming path'); };
      return response;
    }) as typeof fetch;
    const managed = createManagedOxigraphSparqlStoreV1({
      queryEndpoint: 'http://127.0.0.1:7878/query',
    });
    try {
      await expect(managed.query(query)).resolves.toEqual(expected);
      expect(accepts).toEqual(['text/tab-separated-values']);
      expect(serializedTsv).toMatch(/^\?id\t\?iri\t\?blank\t/);
      expect(serializedTsv).toContain('\\t');
      expect(serializedTsv).toContain('\\n');
      expect(serializedTsv).toContain('@en-gb');
      expect(serializedTsv).toContain('^^<urn:type>');
    } finally {
      globalThis.fetch = originalFetch;
      await managed.close();
    }
  });
});
