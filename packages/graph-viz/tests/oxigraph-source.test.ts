import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initSync } from 'oxigraph/web';
import { OxigraphSource } from '../src/data-sources/oxigraph-source.js';

const sources: OxigraphSource[] = [];
function createSource() {
  const source = new OxigraphSource();
  sources.push(source);
  return source;
}
afterEach(() => { for (const source of sources.splice(0)) source.store?.free(); });

beforeAll(() => {
  // Run the browser WASM implementation itself, with local bytes instead of a network fetch.
  const require = createRequire(import.meta.url);
  initSync({ module: readFileSync(require.resolve('oxigraph/web_bg.wasm')) });
});

describe('Oxigraph source with real WASM', () => {
  it('rejects use before initialization', async () => {
    const source = createSource();
    expect(source.store).toBeNull();
    await expect(source.isReady()).resolves.toBe(false);
    for (const operation of [() => source.loadNTriples(''), () => source.loadTurtle(''),
      () => source.select('SELECT * WHERE {}'), () => source.construct('CONSTRUCT {} WHERE {}'), () => source.tripleCount()]) {
      await expect(operation()).rejects.toThrow('OxigraphSource not initialized');
    }
  });

  it('preserves SELECT variable names and corresponding RDF values', async () => {
    const source = createSource();
    await source.init();
    await source.loadNTriples('<urn:item> <urn:name> "Alice" .');
    expect(await source.select('SELECT ?s ?name WHERE { ?s <urn:name> ?name }')).toEqual({
      variables: ['s', 'name'], bindings: [{ s: 'urn:item', name: 'Alice' }],
    });
  });

  it('loads Turtle and N-Triples into the same store and preserves literal metadata in CONSTRUCT', async () => {
    const source = createSource();
    await source.init();
    const store = source.store;
    await source.loadTurtle('@prefix ex: <urn:> . ex:item ex:label "bonjour"@fr .');
    await source.loadNTriples('<urn:item> <urn:count> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .');
    await source.init();
    expect(source.store).toBe(store);
    await expect(source.isReady()).resolves.toBe(true);
    await expect(source.tripleCount()).resolves.toBe(2);
    const result = await source.construct('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }');
    expect(result.triples).toHaveLength(2);
    expect(result.triples).toEqual(expect.arrayContaining([
      { subject: 'urn:item', predicate: 'urn:label', object: 'bonjour', language: 'fr', datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString' },
      { subject: 'urn:item', predicate: 'urn:count', object: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer', language: undefined },
    ]));
    await expect(source.select('not valid SPARQL')).rejects.toThrow();
    await expect(source.tripleCount()).resolves.toBe(2);
  });
});
