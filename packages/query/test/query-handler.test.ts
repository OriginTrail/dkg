import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';
import type { QueryRequest, QueryAccessConfig } from '../src/query-types.js';

const CONTEXT_GRAPH = 'test-contextGraph';
const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const ENTITY_A = 'did:dkg:entity:alice';
const ENTITY_B = 'did:dkg:entity:bob';
const SCHEMA_NAME = 'https://schema.org/name';
const SCHEMA_PERSON = 'https://schema.org/Person';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const DKG_CONTEXT_GRAPH = 'https://dkg.network/ontology#ContextGraph';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function makeRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    operationId: 'test-op-1',
    lookupType: 'ENTITY_TRIPLES',
    contextGraphId: CONTEXT_GRAPH,
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

    it('requires contextGraphId for non-UAL lookups', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
          contextGraphId: undefined,
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('contextGraphId is required');
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
        contextGraphs: {
          [CONTEXT_GRAPH]: {
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

    it('denies unconfigured contextGraphs', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: ENTITY_A,
          contextGraphId: 'other-contextGraph',
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

  describe('with allowList policy', () => {
    let handler: QueryHandler;

    beforeEach(() => {
      handler = new QueryHandler(engine, {
        defaultPolicy: 'deny',
        contextGraphs: {
          [CONTEXT_GRAPH]: {
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

  describe('ENTITY_BY_UAL lookup', () => {
    it('serves graph-scoped assets through the graph-aware resolver', async () => {
      const ual = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
      const assertionVersion = '1';
      const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
      const assertionGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const metadataGraph = `${GRAPH}/_meta`;
      const blankSubject = '_:graph-aware';
      const blankObject = '_:related';
      await store.insert([
        q(GRAPH, RDF_TYPE, DKG_CONTEXT_GRAPH, 'did:dkg:context-graph:ontology'),
        q(blankSubject, SCHEMA_NAME, '"Graph aware"', assertionGraph),
        q('urn:asset:iri', 'urn:related', blankObject, assertionGraph),
        q(ual, `${DKG}contentScopeVersion`, `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, metadataGraph),
        q(ual, `${DKG}kaUal`, ual, metadataGraph),
        q(ual, `${DKG}assertionVersion`, `"${assertionVersion}"^^<${XSD_INTEGER}>`, metadataGraph),
        q(ual, `${DKG}publicTripleCount`, `"2"^^<${XSD_INTEGER}>`, metadataGraph),
        q(ual, `${DKG}privateTripleCount`, `"0"^^<${XSD_INTEGER}>`, metadataGraph),
        q(ual, `${DKG}assertionGraph`, assertionGraph, metadataGraph),
        q(ual, `${DKG}contextGraph`, GRAPH, metadataGraph),
      ]);
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        makeRequest({ lookupType: 'ENTITY_BY_UAL', contextGraphId: undefined, ual }),
        'peer-1',
      );

      expect(response.status).toBe('OK');
      expect(response.resultCount).toBe(2);
      expect(response.ntriples).toMatch(
        /^_:[A-Za-z0-9]+ <https:\/\/schema\.org\/name> "Graph aware" \.$/m,
      );
      expect(response.ntriples).toMatch(
        /^<urn:asset:iri> <urn:related> _:[A-Za-z0-9]+ \.$/m,
      );
      expect(response.ntriples).not.toContain('<_:');
    });

    it('returns error when ual is missing', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_BY_UAL',
          contextGraphId: undefined,
          ual: undefined,
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('missing ual');
    });

    it('does not require contextGraphId', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_BY_UAL',
          contextGraphId: undefined,
          ual: 'did:dkg:ual:nonexistent',
        }),
        'peer-1',
      );

      // Will fail to resolve but should NOT error on missing contextGraphId
      expect(response.status).toBe('ERROR');
      expect(response.error).not.toContain('contextGraphId is required');
      expect(response.error).toContain('Failed to resolve UAL');
    });

    it('returns error when UAL cannot be resolved', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_BY_UAL',
          contextGraphId: undefined,
          ual: 'did:dkg:ual:unknown',
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('Failed to resolve UAL');
    });
  });

  // PR #1107 review fixes (Codex on the #1105 public-CG resolver):
  // 🔴 1 — rate limiting must run BEFORE the (potentially chain-hitting)
  //        access check, and resolver verdicts must be cached.
  // 🔴 2 — ENTITY_BY_UAL must enforce the RESOLVED context graph's policy,
  //        including the on-chain public resolver.
  describe('PR #1107 review: resolver DoS + UAL access enforcement', () => {
    const PUBLIC_CG = 'cg-onchain-public';
    const PRIVATE_CG = 'cg-onchain-private';

    /** Engine stub whose resolveKA lands the UAL in a chosen context graph. */
    function fakeEngine(resolvedCg: string) {
      return {
        query: async () => ({ bindings: [] }),
        resolveKA: async () => ({
          rootEntity: ENTITY_A,
          rootEntities: [ENTITY_A],
          contextGraphId: resolvedCg,
          quads: [{ subject: ENTITY_A, predicate: SCHEMA_NAME, object: '"Alice"', graph: 'g' }],
        }),
      } as any;
    }

    it('rate-limits BEFORE the access check — throttled traffic never reaches the chain resolver (🔴 1)', async () => {
      let resolverCalls = 0;
      const handler = new QueryHandler(
        engine,
        { defaultPolicy: 'deny', rateLimitPerMinute: 1 },
        {
          isContextGraphPublic: async () => {
            resolverCalls++;
            return false;
          },
        },
      );

      const r1 = await handler.handle(makeRequest({ entityUri: ENTITY_A, contextGraphId: 'cg-a' }), 'peer-dos');
      expect(r1.status).toBe('ACCESS_DENIED');
      expect(resolverCalls).toBe(1);

      // Everything past the budget is throttled WITHOUT touching the resolver.
      for (let i = 0; i < 5; i++) {
        const r = await handler.handle(
          makeRequest({ entityUri: ENTITY_A, contextGraphId: `cg-${i}` }),
          'peer-dos',
        );
        expect(r.status).toBe('RATE_LIMITED');
      }
      expect(resolverCalls).toBe(1);
    });

    it('caches resolver verdicts — repeated queries for the same CG cost one chain lookup (🔴 1)', async () => {
      let resolverCalls = 0;
      const handler = new QueryHandler(
        engine,
        { defaultPolicy: 'deny', rateLimitPerMinute: 100 },
        {
          isContextGraphPublic: async () => {
            resolverCalls++;
            return true;
          },
        },
      );

      for (let i = 0; i < 4; i++) {
        const r = await handler.handle(makeRequest({ entityUri: ENTITY_A }), 'peer-1');
        expect(r.status).toBe('OK');
      }
      expect(resolverCalls).toBe(1);
    });

    it('ENTITY_BY_UAL against an on-chain-public CG is allowed on a default-deny config (🔴 2)', async () => {
      const handler = new QueryHandler(
        fakeEngine(PUBLIC_CG),
        { defaultPolicy: 'deny' },
        { isContextGraphPublic: async (cg) => cg === PUBLIC_CG },
      );

      const response = await handler.handle(
        makeRequest({ lookupType: 'ENTITY_BY_UAL', contextGraphId: undefined, ual: 'did:dkg:ual:ka-1' }),
        'peer-1',
      );
      expect(response.status).toBe('OK');
      expect(response.ntriples).toContain(ENTITY_A);
    });

    it('ENTITY_BY_UAL resolving into a non-public CG stays denied (🔴 2, fail closed)', async () => {
      const handler = new QueryHandler(
        fakeEngine(PRIVATE_CG),
        { defaultPolicy: 'deny' },
        { isContextGraphPublic: async (cg) => cg === PUBLIC_CG },
      );

      const response = await handler.handle(
        makeRequest({ lookupType: 'ENTITY_BY_UAL', contextGraphId: undefined, ual: 'did:dkg:ual:ka-2' }),
        'peer-1',
      );
      expect(response.status).toBe('ACCESS_DENIED');
      expect(response.ntriples).toBeUndefined();
    });

    it('ENTITY_BY_UAL no longer leaks THROUGH an explicitly denied CG when another public CG exists (🔴 2)', async () => {
      // Pre-fix: the blanket hasAnyPublicContextGraph() pre-check allowed any
      // UAL lookup as long as SOME public CG was configured — even when the
      // UAL's own CG was explicitly denied by the operator.
      const handler = new QueryHandler(fakeEngine(PRIVATE_CG), {
        defaultPolicy: 'deny',
        contextGraphs: {
          [PRIVATE_CG]: { policy: 'deny' },
          'cg-other-public': { policy: 'public' },
        },
      });

      const response = await handler.handle(
        makeRequest({ lookupType: 'ENTITY_BY_UAL', contextGraphId: undefined, ual: 'did:dkg:ual:ka-3' }),
        'peer-1',
      );
      expect(response.status).toBe('ACCESS_DENIED');
    });

    it('ENTITY_BY_UAL fast-deny is preserved when no resolver is wired and nothing is public', async () => {
      const handler = new QueryHandler(fakeEngine(PUBLIC_CG), { defaultPolicy: 'deny' });

      const response = await handler.handle(
        makeRequest({ lookupType: 'ENTITY_BY_UAL', contextGraphId: undefined, ual: 'did:dkg:ual:ka-4' }),
        'peer-1',
      );
      expect(response.status).toBe('ACCESS_DENIED');
      expect(response.error).toContain('No context graphs are queryable');
    });
  });

  describe('SPARQL security', () => {
    let handler: QueryHandler;

    beforeEach(() => {
      handler = new QueryHandler(engine, { defaultPolicy: 'public' });
    });

    it('rejects GRAPH clauses in SPARQL queries', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          sparql: 'SELECT ?s WHERE { GRAPH <http://evil.com> { ?s ?p ?o } }',
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('GRAPH');
    });

    it('rejects FROM clauses in SPARQL queries', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          sparql: 'SELECT ?s FROM <http://evil.com> WHERE { ?s ?p ?o }',
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('FROM');
    });

    it('rejects empty sparql string', async () => {
      const response = await handler.handle(
        makeRequest({
          lookupType: 'SPARQL_QUERY',
          sparql: '',
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('missing sparql');
    });
  });

  describe('edge cases', () => {
    it('returns error for missing lookupType', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        { operationId: 'test', contextGraphId: CONTEXT_GRAPH } as any,
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('missing lookupType');
    });

    it('returns UNSUPPORTED_LOOKUP for unknown lookup type', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        makeRequest({ lookupType: 'UNKNOWN_TYPE' as any }),
        'peer-1',
      );

      expect(response.status).toBe('UNSUPPORTED_LOOKUP');
    });

    it('returns error for ENTITIES_BY_TYPE with missing rdfType', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITIES_BY_TYPE',
          rdfType: undefined,
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('missing rdfType');
    });

    it('returns error for ENTITY_TRIPLES with missing entityUri', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });

      const response = await handler.handle(
        makeRequest({
          lookupType: 'ENTITY_TRIPLES',
          entityUri: undefined,
        }),
        'peer-1',
      );

      expect(response.status).toBe('ERROR');
      expect(response.error).toContain('missing entityUri');
    });
  });

  describe('stream handler', () => {
    it('encodes/decodes JSON over the wire', async () => {
      const handler = new QueryHandler(engine, { defaultPolicy: 'public' });
      const streamHandler = handler.handler;

      const request: QueryRequest = {
        operationId: 'wire-test',
        lookupType: 'ENTITY_TRIPLES',
        contextGraphId: CONTEXT_GRAPH,
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
