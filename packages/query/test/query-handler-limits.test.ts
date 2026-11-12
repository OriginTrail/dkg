import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, StoreResponseTooLargeError } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler, REMOTE_SPARQL_MAX_RESULT_BYTES } from '../src/query-handler.js';
import { QueryResultTooLargeError } from '../src/query-result-size-error.js';
import { QueryMaterializationTooLargeError } from '../src/query-materialization-error.js';
import type { QueryRequest } from '../src/query-types.js';
import { CONTEXT_GRAPH, ENTITY_A, SCHEMA_NAME, SCHEMA_PERSON, insertPeople, makeRequest, q } from './helpers/query-handler-fixture.js';

describe('QueryHandler limits', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);
    await insertPeople(store);
  });

  describe('SPARQL policy limits', () => {
    it('caps SPARQL results using the context-graph sparqlMaxResults policy', async () => {
      const handler = new QueryHandler(engine, {
        defaultPolicy: 'deny',
        contextGraphs: {
          [CONTEXT_GRAPH]: {
            policy: 'public',
            allowedLookupTypes: ['SPARQL_QUERY'],
            sparqlEnabled: true,
            sparqlMaxResults: 1,
          },
        },
      });

      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          limit: 100,
          sparql: `SELECT ?name WHERE { ?s <${SCHEMA_NAME}> ?name } ORDER BY ?name`,
        }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
      expect(JSON.parse(response.bindings!)).toHaveLength(1);
      expect(response.resultCount).toBe(2);
      expect(response.truncated).toBe(true);
    });

    it('caps SPARQL execution time using the context-graph sparqlTimeout policy', async () => {
      const slowEngine = {
        query: () => new Promise((resolve) => {
          setTimeout(() => resolve({ bindings: [{ s: 'late' }] }), 50);
        }),
      } as unknown as DKGQueryEngine;
      const handler = new QueryHandler(slowEngine, {
        defaultPolicy: 'deny',
        contextGraphs: {
          [CONTEXT_GRAPH]: {
            policy: 'public',
            allowedLookupTypes: ['SPARQL_QUERY'],
            sparqlEnabled: true,
            sparqlTimeout: 1,
          },
        },
      });

      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          timeout: 30_000,
          sparql: `SELECT ?name WHERE { ?s <${SCHEMA_NAME}> ?name }`,
        }),
        'peer-1',
      );

      expect(response.status).toBe('GAS_LIMIT_EXCEEDED');
      expect(response.error).toContain('time limit');
    });
  });

  describe('the result budget of remote lookups', () => {
    const LOOKUPS: ReadonlyArray<{
      readonly lookupType: QueryRequest['lookupType'];
      readonly request: Partial<QueryRequest>;
      readonly scope: Readonly<Record<string, string>>;
    }> = [
      { lookupType: 'SPARQL_QUERY', request: { sparql: `SELECT ?name WHERE { ?s <${SCHEMA_NAME}> ?name }` }, scope: { contextGraphId: CONTEXT_GRAPH } },
      { lookupType: 'ENTITY_TRIPLES', request: { entityUri: ENTITY_A }, scope: { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' } },
      { lookupType: 'ENTITIES_BY_TYPE', request: { rdfType: SCHEMA_PERSON }, scope: { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' } },
    ];
    const OVER_BUDGET = [
      { kind: 'one store response', error: () => new QueryResultTooLargeError(new StoreResponseTooLargeError(10, 11)) },
      { kind: 'the materialized total', error: () => new QueryMaterializationTooLargeError(10, 11) },
    ];

    it.each(LOOKUPS)('gives a remote $lookupType lookup the result budget of the HTTP query route', async ({ lookupType, request, scope }) => {
      const query = vi.fn(async () => ({ bindings: [] }));
      const handler = new QueryHandler({ query } as unknown as DKGQueryEngine, { defaultPolicy: 'public' });
      const response = await handler.handle(makeRequest({ lookupType, ...request }), 'peer-1');
      expect(response.status).toBe('OK');
      expect(REMOTE_SPARQL_MAX_RESULT_BYTES).toBe(10 * 1024 * 1024);
      expect(query).toHaveBeenCalledTimes(1);
      // A remote SPARQL lookup's text reaches the engine as sent; the other two build their own.
      expect(query).toHaveBeenCalledWith(lookupType === 'SPARQL_QUERY' ? request.sparql : expect.any(String), {
        ...scope,
        maxResponseBytes: REMOTE_SPARQL_MAX_RESULT_BYTES,
        maxMaterializedBytes: REMOTE_SPARQL_MAX_RESULT_BYTES,
      });
    });

    it.each(LOOKUPS.flatMap(lookup => OVER_BUDGET.map(over => ({ ...lookup, ...over }))))(
      'answers ERROR when a remote $lookupType result passes the budget in $kind',
      async ({ lookupType, request, error }) => {
        const engine = { query: async () => { throw error(); } } as unknown as DKGQueryEngine;
        const handler = new QueryHandler(engine, { defaultPolicy: 'public' });
        const response = await handler.handle(makeRequest({ lookupType, ...request }), 'peer-1');
        expect(response).toMatchObject({
          status: 'ERROR', error: 'Query result exceeds byte limit (11 > 10)', resultCount: 0, truncated: false,
        });
        expect(response.bindings).toBeUndefined();
        expect(response.ntriples).toBeUndefined();
        expect(response.entityUris).toBeUndefined();
      },
    );

    it.each(LOOKUPS)('answers an unrelated remote $lookupType failure as an internal error, not as a byte limit', async ({ lookupType, request }) => {
      const engine = { query: async () => { throw new Error('store unavailable'); } } as unknown as DKGQueryEngine;
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });
      const response = await handler.handle(makeRequest({ lookupType, ...request }), 'peer-1');
      expect(response).toMatchObject({ status: 'ERROR', error: 'Internal error processing query' });
    });

    it('answers ERROR for an entity whose triples pass the budget on a real store', async () => {
      // Each literal stays under the store's literal size limit; together they pass the 10 MiB budget.
      const value = 'x'.repeat(60_000);
      await store.insert(Array.from({ length: 200 }, (_, i) => q(ENTITY_A, `urn:test:p${i}`, `"${value}${i}"`)));
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });
      const response = await handler.handle(makeRequest({ lookupType: 'ENTITY_TRIPLES', entityUri: ENTITY_A }), 'peer-1');
      expect(response.status).toBe('ERROR');
      expect(response.error).toMatch(new RegExp(`^Query result exceeds byte limit \\(\\d+ > ${REMOTE_SPARQL_MAX_RESULT_BYTES}\\)$`));
      expect(response.ntriples).toBeUndefined();
    });
  });
});
