/**
 * The storage absolute-IRI rule on every adapter write: a relative or RFC
 * 3987-invalid IRI is counted once, under the operation that writes it, and
 * the write is refused before anything is sent (reject mode).
 *
 * The sparql-http insert renders its terms through the statement builders.
 * The N-Quads inserts and the atomic-replace and RFC-64 writes do not, so
 * each adapter checks their quads with `checkIris` instead.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SparqlTermValidationError } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore,
  OxigraphStore,
  SparqlHttpStore,
  UnsupportedTripleStoreCapabilityError,
  type TripleStore,
} from '../src/index.js';
import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../src/atomic-graph-replace.js';
import { buildRfc64AuthorCommitCasUpdateV1 } from '../src/rfc64-author-commit-cas.js';
import {
  AUTHOR,
  authorCommitInput,
  HEAD_GRAPH,
  legacyAuthorCommitInput,
  P_HEAD,
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
  enforcement: 'reject',
});

/** Whether any request carried the relative datatype: a refused write sends none. */
const carried = (sent: SentRequest[]) => sent.some((request) => request.body.includes(RELATIVE_DATATYPE));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('each adapter write refuses a relative datatype, counted once under its own operation', () => {
  it.each(WRITES)('sparql-http %s', async (operation, write) => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://terms.test/query',
      updateEndpoint: 'http://terms.test/update',
      consistencyProfile: 'atomic-readback',
    });
    try {
      await expect(write(store)).rejects.toThrow(SparqlTermValidationError);
    } finally {
      await store.close();
    }
    expect(observed.counted).toEqual([counted('sparql-http', operation)]);
    expect(carried(sent)).toBe(false);
  });

  it.each(WRITES)('blazegraph %s', async (operation, write) => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new BlazegraphStore('http://blaze.test/sparql');
    try {
      await expect(write(store)).rejects.toThrow(SparqlTermValidationError);
    } finally {
      await store.close();
    }
    expect(observed.counted).toEqual([counted('blazegraph', operation)]);
    expect(carried(sent)).toBe(false);
  });

  it.each(WRITES)('embedded oxigraph %s', async (operation, write) => {
    const observed = observeInvalidSparqlTerms();
    const store = new OxigraphStore();
    try {
      await expect(write(store)).rejects.toThrow(SparqlTermValidationError);
      expect(await store.countQuads()).toBe(0);
    } finally {
      await store.close();
    }
    expect(observed.counted).toEqual([counted('oxigraph', operation)]);
  });
});

describe('each adapter write counts the terms it names outside its quads', () => {
  const ADAPTERS: Array<[string, () => TripleStore]> = [
    ['sparql-http', () => new SparqlHttpStore({
      queryEndpoint: 'http://terms.test/query',
      updateEndpoint: 'http://terms.test/update',
      consistencyProfile: 'atomic-readback',
    })],
    ['blazegraph', () => new BlazegraphStore('http://blaze.test/sparql')],
    ['oxigraph', () => new OxigraphStore()],
  ];

  async function refused(create: () => TripleStore, write: (store: TripleStore) => Promise<unknown>) {
    stubSparqlEndpoint();
    const store = create();
    try {
      await expect(write(store)).rejects.toThrow(SparqlTermValidationError);
    } finally {
      await store.close();
    }
  }

  it.each(ADAPTERS)('%s: an empty replaceGraph of a relative graph', async (adapter, create) => {
    const observed = observeInvalidSparqlTerms();
    await refused(create, (store) => store.replaceGraph!('rel-g', []));
    expect(observed.counted).toEqual([{
      value: 1, adapter, operation: 'replaceGraph', position: 'graph', kind: 'relative-iri', enforcement: 'reject',
    }]);
  });

  it.each(ADAPTERS)('%s: a relative guard value of an RFC-64 author commit', async (adapter, create) => {
    const observed = observeInvalidSparqlTerms();
    const input = authorCommitInput();
    // Only the current-head guard names `rel-old-head`; the first check refuses it.
    await refused(create, (store) => store.rfc64AuthorCommitCasV1!(authorCommitInput({
      currentHead: {
        ...input.currentHead,
        expectedObject: 'rel-old-head',
        expectedQuads: [quad(AUTHOR, P_HEAD, 'rel-old-head', HEAD_GRAPH)],
      },
    })));
    expect(observed.counted).toEqual([{
      value: 1,
      adapter,
      operation: 'rfc64AuthorCommitCasV1',
      position: 'object',
      kind: 'relative-iri',
      enforcement: 'reject',
    }]);
  });

  it.each([
    ['semantic', authorCommitInput()],
    ['legacy', legacyAuthorCommitInput()],
  ] as const)('the %s RFC-64 update interpolates no IRI outside its semantic quads and control terms', (_name, input) => {
    const plan = buildRfc64AuthorCommitCasUpdateV1(input);
    const irisOf = (term: string): string[] => {
      if (term.startsWith('_:')) return [];
      if (term.startsWith('"')) return [...term.matchAll(/\^\^<([^>]+)>$/g)].map(([, datatype]) => datatype!);
      return [term.startsWith('<') ? term.slice(1, -1) : term];
    };
    const checked = new Set([
      ...plan.semanticQuads.flatMap((q) => [q.subject, q.predicate, q.object, q.graph].flatMap(irisOf)),
      ...plan.controlTerms.flatMap(({ term }) => irisOf(term)),
    ]);
    const interpolated = [...plan.update.matchAll(/<([^<>\s]+)>/g)].map(([, iri]) => iri!);
    const unchecked = interpolated.filter((iri) =>
      !checked.has(iri)
      && !iri.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX)
      && iri !== 'urn:dkg:sync:authorCommitApplied'
      && iri !== 'http://www.w3.org/2001/XMLSchema#boolean');
    expect(interpolated.length).toBeGreaterThan(0);
    expect(unchecked).toEqual([]);
    // Each referenced graph is a control term once.
    const graphTerms = plan.controlTerms.filter(({ position }) => position === 'graph').map(({ term }) => term);
    expect(new Set(graphTerms).size).toBe(graphTerms.length);
    expect(graphTerms).toContain(HEAD_GRAPH);
  });
});

describe('the writes are refused before anything is sent', () => {
  it('sparql-http insert sends nothing', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({ queryEndpoint: 'http://terms.test/query', updateEndpoint: 'http://terms.test/update' });
    try {
      await expect(store.insert([
        { subject: S, predicate: P, object: 'http://ex.org/%zz', graph: G },
      ])).rejects.toThrow(SparqlTermValidationError);
    } finally {
      await store.close();
    }
    expect(sent).toEqual([]);
    expect(observed.counted.map((point) => [point.position, point.kind, point.enforcement])).toEqual([
      ['object', 'rfc3987-iri', 'reject'],
    ]);
  });

  it('sparql-http replaceGraph sends nothing', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({
      queryEndpoint: 'http://terms.test/query',
      updateEndpoint: 'http://terms.test/update',
      consistencyProfile: 'atomic-update',
    });
    try {
      await expect(store.replaceGraph(G, [{ subject: S, predicate: P, object: 'rel-o', graph: G }]))
        .rejects.toThrow(SparqlTermValidationError);
    } finally {
      await store.close();
    }
    expect(sent).toEqual([]);
    expect(observed.counted.map((point) => [point.operation, point.position, point.kind])).toEqual([
      ['replaceGraph', 'object', 'relative-iri'],
    ]);
  });

  it('blazegraph insert posts nothing', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new BlazegraphStore('http://blaze.test/sparql');
    try {
      await expect(store.insert([
        { subject: S, predicate: P, object: '"v"', graph: G },
        { subject: S, predicate: P, object: 'http://user@@example.org/', graph: G },
      ])).rejects.toThrow(SparqlTermValidationError);
    } finally {
      await store.close();
    }
    expect(sent).toEqual([]);
    expect(observed.counted.map((point) => [point.operation, point.position, point.kind])).toEqual([
      ['insert', 'object', 'rfc3987-iri'],
    ]);
  });

  it('counts nothing for a replace a generic endpoint refuses before sending it', async () => {
    const observed = observeInvalidSparqlTerms();
    const sent = stubSparqlEndpoint();
    const store = new SparqlHttpStore({ queryEndpoint: 'http://terms.test/query', updateEndpoint: 'http://terms.test/update' });
    const quads = [{ subject: S, predicate: P, object: RELATIVE_DATATYPE, graph: G }];
    try {
      // The caller then takes its delete-then-insert fallback, whose insert refuses the term.
      await expect(store.replaceGraph(G, quads)).rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
      await expect(store.replaceSubject(G, S, quads)).rejects.toBeInstanceOf(UnsupportedTripleStoreCapabilityError);
    } finally {
      await store.close();
    }
    expect(sent).toEqual([]);
    expect(observed.counted).toEqual([]);
  });
});
