/**
 * Tests for I-004 (query default deny) and I-009 (SPARQL graph scope bypass).
 *
 * Verifies that:
 * - Default query access is deny (not public)
 * - Explicit GRAPH clauses in remote SPARQL are rejected
 * - FROM/FROM NAMED clauses in remote SPARQL are rejected
 * - Standard paranet-scoped queries still work correctly
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';
import type { QueryRequest, QueryAccessConfig } from '../src/query-types.js';

const PARANET = 'test-security';
const OTHER_PARANET = 'other-secret';
const GRAPH = `did:dkg:paranet:${PARANET}`;
const OTHER_GRAPH = `did:dkg:paranet:${OTHER_PARANET}`;
const ENTITY_A = 'did:dkg:entity:alice';
const ENTITY_SECRET = 'did:dkg:entity:secret-data';
const SCHEMA_NAME = 'https://schema.org/name';
const SCHEMA_PERSON = 'https://schema.org/Person';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

function q(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function makeRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    operationId: 'security-test',
    lookupType: 'SPARQL_QUERY',
    paranetId: PARANET,
    ...overrides,
  };
}

describe('I-004: Default query access should be deny', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);
    await store.insert([
      q(ENTITY_A, RDF_TYPE, SCHEMA_PERSON, GRAPH),
      q(ENTITY_A, SCHEMA_NAME, '"Alice"', GRAPH),
    ]);
  });

  it('deny-by-default blocks queries to unconfigured paranets', async () => {
    const handler = new QueryHandler(engine, {
      defaultPolicy: 'deny',
    });

    const response = await handler.handle(
      makeRequest({
        lookupType: 'ENTITY_TRIPLES',
        entityUri: ENTITY_A,
      }),
      'peer-1',
    );

    expect(response.status).toBe('ACCESS_DENIED');
  });

  it('deny-by-default with explicit paranet allows queries', async () => {
    const handler = new QueryHandler(engine, {
      defaultPolicy: 'deny',
      paranets: {
        [PARANET]: { policy: 'public' },
      },
    });

    const response = await handler.handle(
      makeRequest({
        lookupType: 'ENTITY_TRIPLES',
        entityUri: ENTITY_A,
      }),
      'peer-1',
    );

    expect(response.status).toBe('OK');
    expect(response.resultCount).toBe(2);
  });

  it('public policy allows queries without explicit paranet config', async () => {
    const handler = new QueryHandler(engine, {
      defaultPolicy: 'public',
    });

    const response = await handler.handle(
      makeRequest({
        lookupType: 'ENTITY_TRIPLES',
        entityUri: ENTITY_A,
      }),
      'peer-1',
    );

    expect(response.status).toBe('OK');
    expect(response.resultCount).toBe(2);
  });
});

describe('I-009: SPARQL graph scope bypass prevention', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;
  let handler: QueryHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    // Insert data into two different paranets
    await store.insert([
      q(ENTITY_A, SCHEMA_NAME, '"Alice"', GRAPH),
      q(ENTITY_SECRET, SCHEMA_NAME, '"TopSecret"', OTHER_GRAPH),
    ]);

    handler = new QueryHandler(engine, {
      defaultPolicy: 'deny',
      paranets: {
        [PARANET]: { policy: 'public', sparqlEnabled: true },
      },
    });
  });

  it('rejects SPARQL with explicit GRAPH clause', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s ?name WHERE { GRAPH <${OTHER_GRAPH}> { ?s <${SCHEMA_NAME}> ?name } }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('GRAPH clauses are not allowed');
  });

  it('rejects SPARQL with GRAPH variable pattern (bypass via ?var)', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('GRAPH clauses are not allowed');
  });

  it('rejects SPARQL with GRAPH clause targeting the allowed paranet too', async () => {
    // Even queries targeting the "correct" graph should not use explicit GRAPH
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?name WHERE { GRAPH <${GRAPH}> { ?s <${SCHEMA_NAME}> ?name } }`,
      }),
      'peer-1',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('GRAPH clauses are not allowed');
  });

  it('rejects SPARQL with FROM clause', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?name FROM <${OTHER_GRAPH}> WHERE { ?s <${SCHEMA_NAME}> ?name }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('FROM');
  });

  it('rejects SPARQL with FROM NAMED clause', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?name FROM NAMED <${OTHER_GRAPH}> WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
  });

  it('allows normal paranet-scoped SPARQL without GRAPH clause', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?name WHERE { ?s <${SCHEMA_NAME}> ?name }`,
      }),
      'peer-1',
    );

    expect(response.status).toBe('OK');
    const bindings = JSON.parse(response.bindings!);
    // Should only see data from the allowed paranet, not the secret one
    const names = bindings.map((b: Record<string, string>) => b['name']);
    expect(names.some((n: string) => n.includes('Alice'))).toBe(true);
    expect(names.some((n: string) => n.includes('TopSecret'))).toBe(false);
  });

  it('prevents cross-paranet data access via case-variant GRAPH', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?name WHERE { graph <${OTHER_GRAPH}> { ?s <${SCHEMA_NAME}> ?name } }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('GRAPH clauses are not allowed');
  });

  it('rejects SPARQL with prefixed IRI in GRAPH clause', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `PREFIX ex: <${OTHER_GRAPH}/> SELECT ?name WHERE { GRAPH ex:data { ?s <${SCHEMA_NAME}> ?name } }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('GRAPH clauses are not allowed');
  });

  it('rejects SPARQL with prefixed IRI in FROM clause', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `PREFIX ex: <${OTHER_GRAPH}/> SELECT ?name FROM ex:data WHERE { ?s <${SCHEMA_NAME}> ?name }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('FROM');
  });

  it('rejects SPARQL with prefixed IRI in FROM NAMED clause', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `PREFIX ex: <${OTHER_GRAPH}/> SELECT ?name FROM NAMED ex:data WHERE { ?s <${SCHEMA_NAME}> ?name }`,
      }),
      'peer-attacker',
    );

    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('FROM');
  });
});

describe('I-009: SPARQL keyword detection — no false positives on literals/comments', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;
  let handler: QueryHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    await store.insert([
      q(ENTITY_A, SCHEMA_NAME, '"Alice"', GRAPH),
    ]);

    handler = new QueryHandler(engine, {
      defaultPolicy: 'deny',
      paranets: {
        [PARANET]: { policy: 'public', sparqlEnabled: true },
      },
    });
  });

  it('allows GRAPH keyword inside a string literal (not a real GRAPH clause)', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s WHERE { ?s <${SCHEMA_NAME}> "This describes a GRAPH structure" }`,
      }),
      'peer-1',
    );
    expect(response.status).toBe('OK');
  });

  it('allows FROM keyword inside a string literal (not a real FROM clause)', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s WHERE { ?s <${SCHEMA_NAME}> "data FROM multiple sources" }`,
      }),
      'peer-1',
    );
    expect(response.status).toBe('OK');
  });

  it('allows SERVICE keyword inside a string literal', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s WHERE { ?s <${SCHEMA_NAME}> "runs a SERVICE endpoint" }`,
      }),
      'peer-1',
    );
    expect(response.status).toBe('OK');
  });

  it('allows GRAPH keyword inside a SPARQL comment', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s WHERE {
# This comment mentions GRAPH and FROM clauses
  ?s <${SCHEMA_NAME}> ?name
}`,
      }),
      'peer-1',
    );
    expect(response.status).toBe('OK');
  });

  it('still rejects real GRAPH clause even when literals are present', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s WHERE { ?s <${SCHEMA_NAME}> "some text" . GRAPH <${OTHER_GRAPH}> { ?s ?p ?o } }`,
      }),
      'peer-attacker',
    );
    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('GRAPH');
  });

  it('still rejects real FROM clause even when string literals are present', async () => {
    const response = await handler.handle(
      makeRequest({
        sparql: `SELECT ?s FROM <${OTHER_GRAPH}> WHERE { ?s <${SCHEMA_NAME}> "mentions FROM in text" }`,
      }),
      'peer-attacker',
    );
    expect(response.status).toBe('ERROR');
    expect(response.error).toContain('FROM');
  });
});
