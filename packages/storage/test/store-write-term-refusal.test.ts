/**
 * Every adapter refuses a write holding a term the RDF grammar does not
 * allow before anything is sent or loaded, and writes nothing. The error
 * carries a code, so a caller can tell a refused term from a store outage,
 * also after it crossed the embedded worker's boundary.
 *
 * The HTTP adapters talk to an in-process endpoint that runs the Oxigraph
 * engine; native Blazegraph runs the publisher's live suite.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSparqlTermValidationError,
  SPARQL_TERM_VALIDATION_ERROR_CODE,
  SparqlTermValidationError,
} from '@origintrail-official/dkg-core';
import {
  BlazegraphStore,
  OxigraphStore,
  OxigraphWorkerStore,
  SparqlHttpStore,
  type Quad,
  type TripleStore,
} from '../src/index.js';
import { deserializeWorkerErrorV1, serializeWorkerErrorV1 } from '../src/worker-error-protocol.js';
import { startOxigraphSparqlEndpoint, type OxigraphSparqlEndpoint } from './helpers/oxigraph-sparql-endpoint.js';

const MALFORMED_OBJECTS = [
  ['a language tag with a character a tag may not hold', '"refused value"@en_GB'],
  ['a blank-node label with a character a label may not hold', '_:node!refused'],
] as const;

let endpoint: OxigraphSparqlEndpoint;
beforeAll(async () => { endpoint = await startOxigraphSparqlEndpoint(); });
afterAll(async () => { await endpoint?.close(); });
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

const STORES: ReadonlyArray<{ name: string; open: () => TripleStore }> = [
  { name: 'embedded Oxigraph', open: () => new OxigraphStore() },
  { name: 'the embedded Oxigraph worker', open: () => new OxigraphWorkerStore() },
  { name: 'the Blazegraph adapter', open: () => new BlazegraphStore(endpoint.queryEndpoint) },
  {
    name: 'the SPARQL HTTP adapter',
    open: () => new SparqlHttpStore({ queryEndpoint: endpoint.queryEndpoint, updateEndpoint: endpoint.updateEndpoint }),
  },
];

async function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(() => undefined, (error: unknown) => error);
}

describe.each(STORES)('$name', ({ open }) => {
  it.each(MALFORMED_OBJECTS)('refuses an insert holding %s, and writes nothing', async (_label, object) => {
    const store = open();
    const graph = `urn:term-refusal:${randomUUID()}`;
    const kept: Quad = { subject: 'urn:term-refusal:s', predicate: 'urn:term-refusal:p', object: '"kept"', graph };
    try {
      const error = await refusal(store.insert([kept, { ...kept, object }]));
      expect(isSparqlTermValidationError(error)).toBe(true);
      expect(error).toMatchObject({ name: 'SparqlTermValidationError', code: SPARQL_TERM_VALIDATION_ERROR_CODE });
      expect(await store.countQuads(graph)).toBe(0);

      // Control: the well-formed quad alone is stored.
      await store.insert([kept]);
      expect(await store.countQuads(graph)).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('refuses a graph drop or prefix delete holding a malformed term, and deletes nothing', async () => {
    const store = open();
    const graph = `urn:term-refusal:${randomUUID()}`;
    const kept: Quad = { subject: 'urn:term-refusal:s', predicate: 'urn:term-refusal:p', object: '"kept"', graph };
    try {
      await store.insert([kept]);
      expect(isSparqlTermValidationError(await refusal(store.dropGraph(`${graph}^x`)))).toBe(true);
      expect(isSparqlTermValidationError(await refusal(
        store.deleteBySubjectPrefix(graph, 'urn:term-refusal:s refused'),
      ))).toBe(true);
      expect(await store.countQuads(graph)).toBe(1);
    } finally {
      await store.close();
    }
  });
});

describe('the worker error protocol', () => {
  it('keeps a refused term\'s name and code across the worker boundary', () => {
    const restored = deserializeWorkerErrorV1(serializeWorkerErrorV1(
      new SparqlTermValidationError('oxigraph.insert: invalid literal in SPARQL object position', 'literal'),
    ));
    expect(restored).not.toBeInstanceOf(SparqlTermValidationError);
    expect(restored).toMatchObject({ name: 'SparqlTermValidationError', code: SPARQL_TERM_VALIDATION_ERROR_CODE });
    expect(isSparqlTermValidationError(restored)).toBe(true);
  });
});
