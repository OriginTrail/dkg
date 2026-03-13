import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';
import type { QueryRequest, QueryAccessConfig } from '../src/query-types.js';

const PARANET = 'test-paranet';
const GRAPH = `did:dkg:paranet:${PARANET}`;
const ENTITY_A = 'did:dkg:entity:alice';
const ENTITY_B = 'did:dkg:entity:bob';
const SCHEMA_NAME = 'https://schema.org/name';
const SCHEMA_PERSON = 'https://schema.org/Person';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function makeRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    operationId: 'test-op-1',
    lookupType: 'ENTITY_TRIPLES',
    paranetId: PARANET,
    ...overrides,
  };
}

describe('QueryHandler', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    await store.insert([
      q(ENTITY_A, RDF_TYPE, SCHEMA_PERSON),
      q(ENTITY_A, SCHEMA_NAME, '"Alice"'),
      q(ENTITY_B, RDF_TYPE, SCHEMA_PERSON),
      q(ENTITY_B, SCHEMA_NAME, '"Bob"'),
    ]);
  });

  describe('with public access policy', () => {
    let handler: QueryHandler;

    beforeEach(() => {
      handler = new QueryHandler(engine, {
        defaultPolicy: 'public',
      });
    });

    it('handles ENTITY_TRIPLES lookup', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
        }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
      expect(response.resultCount).toBe(2);
      expect(response.ntriples).toContain(ENTITY_A);
      expect(response.ntriples).toContain('Alice');
      expect(response.truncated).toBe(false);
    });

    it('handles ENTITIES_BY_TYPE lookup', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITIES_BY_TYPE',
          rdfType: SCHEMA_PERSON,
        }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
      expect(response.entityUris).toBeDefined();
      expect(response.entityUris!.length).toBe(2);
      expect(response.entityUris).toContain(ENTITY_A);
      expect(response.entityUris).toContain(ENTITY_B);
    });

    it('handles SPARQL_QUERY lookup', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          sparql: `SELECT ?name WHERE { ?s <${SCHEMA_NAME}> ?name }`,
        }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
      expect(response.bindings).toBeDefined();
      const bindings = JSON.parse(response.bindings!);
      expect(bindings.length).toBe(2);
    });

    it('returns OK with empty results for unknown entity', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: 'did:dkg:entity:nonexistent',
        }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
      expect(response.resultCount).toBe(0);
    });

    it('requires paranetId for non-UAL lookups', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
          paranetId: undefined,
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('paranetId is required');
    });

    it('rejects mutating SPARQL', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          sparql: 'INSERT DATA { <s> <p> <o> }',
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('SPARQL rejected');
    });

    it('rejects SERVICE clauses', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          sparql: 'SELECT ?s WHERE { SERVICE <http://evil.com> { ?s ?p ?o } }',
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('SERVICE');
    });

    it('limits ENTITIES_BY_TYPE results', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITIES_BY_TYPE',
          rdfType: SCHEMA_PERSON,
          limit: 1,
        }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
      expect(response.entityUris!.length).toBe(1);
      expect(response.truncated).toBe(true);
    });
  });

  describe('with deny-by-default access policy', () => {
    let handler: QueryHandler;

    beforeEach(() => {
      handler = new QueryHandler(engine, {
        defaultPolicy: 'deny',
        paranets: {
          [PARANET]: {
            policy: 'public',
            allowedLookupTypes: ['ENTITY_TRIPLES', 'ENTITIES_BY_TYPE'],
            sparqlEnabled: false,
          },
        },
      });
    });

    it('allows configured lookup types', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
        }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
    });

    it('denies unconfigured paranets', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
          paranetId: 'other-paranet',
        }),
        'peer-1',
      );

      expect(response.status).toBe('ACCESS_DENIED');
    });

    it('denies disallowed lookup types', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          sparql: 'SELECT ?s WHERE { ?s ?p ?o }',
        }),
        'peer-1',
      );

      expect(response.status).toBe('UNSUPPORTED_LOOKUP');
    });
  });

  describe('with allowList policy', () => {
    let handler: QueryHandler;

    beforeEach(() => {
      handler = new QueryHandler(engine, {
        defaultPolicy: 'deny',
        paranets: {
          [PARANET]: {
            policy: 'allowList',
            allowedPeers: ['peer-trusted'],
            allowedLookupTypes: ['ENTITY_TRIPLES'],
          },
        },
      });
    });

    it('allows trusted peers', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
        }),
        'peer-trusted',
      );

      expect(response.status).toBe('OK');
    });

    it('denies untrusted peers', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
        }),
        'peer-untrusted',
      );

      expect(response.status).toBe('ACCESS_DENIED');
    });
  });

  describe('rate limiting', () => {
    it('blocks after exceeding rate limit', async () => {
      const handler = new QueryHandler(engine, {
        defaultPolicy: 'public',
        rateLimitPerMinute: 2,
      });

      // First two should succeed
      const r1 = await handler.handle(makeRequest({ entityUri: ENTITY_A }), 'peer-spammer');
      const r2 = await handler.handle(makeRequest({ entityUri: ENTITY_A }), 'peer-spammer');
      expect(r1.status).toBe('OK');
      expect(r2.status).toBe('OK');

      // Third should be rate limited
      const r3 = await handler.handle(makeRequest({ entityUri: ENTITY_A }), 'peer-spammer');
      expect(r3.status).toBe('RATE_LIMITED');
      expect(r3.error).toContain('Retry after');
    });

    it('does not rate limit different peers', async () => {
      const handler = new QueryHandler(engine, {
        defaultPolicy: 'public',
        rateLimitPerMinute: 1,
      });

      const r1 = await handler.handle(makeRequest({ entityUri: ENTITY_A }), 'peer-a');
      const r2 = await handler.handle(makeRequest({ entityUri: ENTITY_A }), 'peer-b');
      expect(r1.status).toBe('OK');
      expect(r2.status).toBe('OK');
    });
  });

  describe('stream handler', () => {
    it('encodes/decodes JSON over the wire', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });
      const streamHandler = handler.handler;

      const request: QueryRequest = {
        operationId: 'wire-test',
        lookupType: 'ENTITY_TRIPLES',
        paranetId: PARANET,
        entityUri: ENTITY_A,
      };

      const requestBytes = new TextEncoder().encode(JSON.stringify(request));
      const peerId = { toString: () => 'peer-1', toBytes: () => new Uint8Array() };
      const responseBytes = await streamHandler(requestBytes, peerId);
      const response = JSON.parse(new TextDecoder().decode(responseBytes));

      expect(response.operationId).toBe('wire-test');
      expect(response.status).toBe('OK');
      expect(response.resultCount).toBe(2);
    });

    it('returns error for malformed JSON', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });
      const streamHandler = handler.handler;

      const garbage = new TextEncoder().encode('not json at all');
      const peerId = { toString: () => 'peer-1', toBytes: () => new Uint8Array() };
      const responseBytes = await streamHandler(garbage, peerId);
      const response = JSON.parse(new TextDecoder().decode(responseBytes));

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('malformed JSON');
    });
  });
});
