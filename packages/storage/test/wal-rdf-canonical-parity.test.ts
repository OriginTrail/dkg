import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeNQuadsV1 } from '../../wal/src/rdf/nquads.js';
import { BlazegraphStore, OxigraphStore, quadsToNQuads, type Quad } from '../src/index.js';

const vectors = JSON.parse(await readFile(
  resolve(process.cwd(), '../../conformance/wal-v1/vectors/protocol-v1.json'),
  'utf8',
));
const fixture = vectors.rdfAdapter.canonicalization;
const parsed = canonicalizeNQuadsV1(fixture.canonicalBytes
  ? new Uint8Array(Buffer.from(fixture.canonicalBytes, 'hex'))
  : fixture.canonical);
const storageQuads: Quad[] = parsed.quads.map(quad => ({
  subject: quad.subject,
  predicate: quad.predicate,
  object: quad.object.startsWith('<') ? quad.object.slice(1, -1) : quad.object,
  graph: quad.graph,
}));

function canonicalStoreOutput(quads: readonly Quad[]): ReturnType<typeof canonicalizeNQuadsV1> {
  return canonicalizeNQuadsV1(quadsToNQuads(quads));
}

describe('WAL RDF canonicalization parity across supported stores', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips the frozen bytes through embedded Oxigraph independent of result order', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([...storageQuads].reverse());
      const result = await store.query(
        'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:g> { ?s ?p ?o } }',
      );
      expect(result.type).toBe('quads');
      const quads = result.type === 'quads'
        ? result.quads.map(quad => ({ ...quad, graph: 'urn:g' }))
        : [];
      const canonical = canonicalStoreOutput(quads);
      expect(Buffer.from(canonical.bytes).toString('hex')).toBe(fixture.canonicalBytes);
      expect(Buffer.from(canonical.stateDigest).toString('hex')).toBe(fixture.stateDigest);
    } finally {
      await store.close();
    }
  });

  it('round-trips the same frozen bytes through the Blazegraph HTTP N-Quads adapter', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(String((init?.headers as Record<string, string>)?.['Content-Type']))
        .toContain('application/sparql-query');
      expect(String(init?.body).trimStart().toUpperCase()).toMatch(/^CONSTRUCT/);
      return new Response(fixture.canonical, {
        status: 200,
        headers: { 'Content-Type': 'application/n-quads; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql');
    const result = await store.query(
      'CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:g> { ?s ?p ?o } }',
    );
    expect(result.type).toBe('quads');
    const canonical = canonicalStoreOutput(result.type === 'quads' ? result.quads : []);
    expect(Buffer.from(canonical.bytes).toString('hex')).toBe(fixture.canonicalBytes);
    expect(Buffer.from(canonical.stateDigest).toString('hex')).toBe(fixture.stateDigest);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
