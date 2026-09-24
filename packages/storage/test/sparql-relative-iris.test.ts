/**
 * The storage absolute-IRI rule on every adapter write: a relative or RFC
 * 3987-invalid IRI is counted once, under the operation that writes it, and
 * the write goes out byte for byte as before (observe mode).
 *
 * The sparql-http insert renders its terms through the statement builders.
 * The N-Quads inserts and the atomic-replace and RFC-64 writes do not, so
 * each adapter checks their quads with `checkIris` instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlazegraphStore,
  OxigraphStore,
  SparqlHttpStore,
  UnsupportedTripleStoreCapabilityError,
  type TripleStore,
} from '../src/index.js';
import { buildAtomicGraphReplaceUpdate } from '../src/atomic-graph-replace.js';
import {
  authorCommitInput,
  P_VALUE,
  PROJECTION_GRAPH,
  quad,
} from './rfc64-author-commit-cas-harness.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

const G = 'http://ex.org/g';
const META = 'http://ex.org/meta';
const S = 'http://ex.org/s';
const P = 'http://ex.org/p';
// oxigraph-server stores this object as "42"^^<http://127.0.0.1:7920/integer>.
const RELATIVE_DATATYPE = '"42"^^<integer>';

interface SentRequest {
  url: string;
  contentType: string;
  body: string;
}

/** Stub fetch as a SPARQL endpoint: writes succeed, ASK is true, counts are zero. */
function stubSparqlEndpoint(): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = {
      url: String(input),
      contentType: new Headers(init?.headers).get('content-type') ?? '',
      body: String(init?.body ?? ''),
    };
    sent.push(request);
    if (!request.contentType.startsWith('application/sparql-query')) {
      return new Response(null, { status: 204 });
    }
    const results = request.body.startsWith('ASK')
      ? { boolean: true }
      : { head: { vars: ['c'] }, results: { bindings: [{ c: { type: 'literal', value: '0' } }] } };
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    });
  });
  return sent;
}

/** One write of a quad whose object has a relative datatype, per write method. */
const WRITES: Array<[string, (store: TripleStore) => Promise<unknown>]> = [
  ['insert', (store) => store.insert([{ subject: S, predicate: P, object: RELATIVE_DATATYPE, graph: G }])],
  ['replaceGraph', (store) => store.replaceGraph!(G, [{ subject: S, predicate: P, object: RELATIVE_DATATYPE, graph: G }])],
  [
    'replaceGraphAndSubject',
    (store) => store.replaceGraphAndSubject!(
      G,
      [{ subject: S, predicate: P, object: '"v"', graph: G }],
      META,
      S,
      [{ subject: S, predicate: P, object: RELATIVE_DATATYPE, graph: META }],
    ),
  ],
  ['replaceSubject', (store) => store.replaceSubject!(G, S, [{ subject: S, predicate: P, object: RELATIVE_DATATYPE, graph: G }])],
  [
    'rfc64AuthorCommitCasV1',
    (store) => store.rfc64AuthorCommitCasV1!(authorCommitInput({
      sharedProjectionQuads: [quad('urn:test:rfc64:new:1', P_VALUE, RELATIVE_DATATYPE, PROJECTION_GRAPH)],
    })),
  ],
];

const counted = (adapter: string, operation: string) => ({
  value: 1,
  adapter,
  operation,
  position: 'datatype',
  kind: 'relative-iri',
  enforcement: 'observe',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('each adapter write counts a relative datatype once, under its own operation', () => {
  it.each(WRITES)('sparql-http %s', async (operation, write) => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://terms.test/query',
      updateEndpoint: 'http://terms.test/update',
      consistencyProfile: 'atomic-readback',
    });
    try {
      await write(store);
    } finally {
      await store.close();
    }
    expect(observed.counted).toEqual([counted('sparql-http', operation)]);
    expect(sent.some((request) => request.body.includes(RELATIVE_DATATYPE))).toBe(true);
  });

  it.each(WRITES)('blazegraph %s', async (operation, write) => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new BlazegraphStore('http://blaze.test/sparql');
    try {
      await write(store);
    } finally {
      await store.close();
    }
    expect(observed.counted).toEqual([counted('blazegraph', operation)]);
    expect(sent.some((request) => request.body.includes(RELATIVE_DATATYPE))).toBe(true);
  });

  it.each(WRITES)('embedded oxigraph %s, which then fails the write', async (operation, write) => {
    const observed = observeInvalidSparqlTerms();
    const store = new OxigraphStore();
    try {
      // Unlike an HTTP endpoint, embedded Oxigraph has no base IRI to resolve
      // a relative IRI against, so its parser rejects the write.
      await expect(write(store)).rejects.toThrow(/No scheme found in an absolute IRI|IRI parsing failed/);
      expect(await store.countQuads()).toBe(0);
    } finally {
      await store.close();
    }
    expect(observed.counted).toEqual([counted('oxigraph', operation)]);
  });
});

describe('the writes go out byte for byte as before', () => {
  it('sparql-http insert sends the relative IRIs unchanged', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({ queryEndpoint: 'http://terms.test/query', updateEndpoint: 'http://terms.test/update' });
    try {
      await store.insert([
        { subject: 'rel-s', predicate: P, object: RELATIVE_DATATYPE, graph: G },
        { subject: S, predicate: P, object: 'http://ex.org/%zz', graph: G },
      ]);
    } finally {
      await store.close();
    }
    expect(sent.map((request) => request.body)).toEqual([
      'INSERT DATA {\n  GRAPH <http://ex.org/g> {\n' +
        '    <rel-s> <http://ex.org/p> "42"^^<integer> .\n' +
        '    <http://ex.org/s> <http://ex.org/p> <http://ex.org/%zz> .\n  }\n}',
    ]);
    expect(observed.counted.map((point) => [point.position, point.kind])).toEqual([
      ['subject', 'relative-iri'],
      ['datatype', 'relative-iri'],
      ['object', 'rfc3987-iri'],
    ]);
  });

  it('sparql-http replaceGraph sends exactly the atomic builder\'s update', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://terms.test/query',
      updateEndpoint: 'http://terms.test/update',
      consistencyProfile: 'atomic-update',
    });
    const quads = [{ subject: S, predicate: P, object: 'rel-o', graph: G }];
    try {
      await store.replaceGraph(G, quads);
    } finally {
      await store.close();
    }
    // The staging graph name is random; everything else must match.
    const unstaged = (update: string) => update.replace(/atomic-graph-replace:[0-9a-f-]{36}/g, 'atomic-graph-replace:*');
    expect(sent.map((request) => unstaged(request.body))).toEqual([unstaged(buildAtomicGraphReplaceUpdate(G, quads).update)]);
    expect(sent[0].body).toContain('<http://ex.org/s> <http://ex.org/p> <rel-o> .');
    expect(observed.counted.map((point) => [point.operation, point.position, point.kind])).toEqual([
      ['replaceGraph', 'object', 'relative-iri'],
    ]);
  });

  it('blazegraph insert posts the N-Quads unchanged', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new BlazegraphStore('http://blaze.test/sparql');
    try {
      await store.insert([
        { subject: S, predicate: P, object: RELATIVE_DATATYPE, graph: G },
        { subject: S, predicate: P, object: 'http://user@@example.org/', graph: G },
      ]);
    } finally {
      await store.close();
    }
    expect(sent).toEqual([{
      url: 'http://blaze.test/sparql',
      contentType: 'text/x-nquads',
      body: '<http://ex.org/s> <http://ex.org/p> "42"^^<integer> <http://ex.org/g> .\n' +
        '<http://ex.org/s> <http://ex.org/p> <http://user@@example.org/> <http://ex.org/g> .\n',
    }]);
    expect(observed.counted.map((point) => [point.operation, point.position, point.kind])).toEqual([
      ['insert', 'datatype', 'relative-iri'],
      ['insert', 'object', 'rfc3987-iri'],
    ]);
  });

  it('counts nothing for a replace a generic endpoint refuses before sending it', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({ queryEndpoint: 'http://terms.test/query', updateEndpoint: 'http://terms.test/update' });
    const quads = [{ subject: S, predicate: P, object: RELATIVE_DATATYPE, graph: G }];
    try {
      // The caller then takes its delete-then-insert fallback, whose insert is counted.
      await expect(store.replaceGraph(G, quads)).rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
      await expect(store.replaceSubject(G, S, quads)).rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
    } finally {
      await store.close();
    }
    expect(sent).toEqual([]);
    expect(observed.counted).toEqual([]);
  });
});
