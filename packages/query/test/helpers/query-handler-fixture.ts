import type { OxigraphStore, Quad } from '@origintrail-official/dkg-storage';
import type { QueryRequest } from '../../src/query-types.js';

export const CONTEXT_GRAPH = 'test-contextGraph';
export const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
export const ENTITY_A = 'did:dkg:entity:alice';
export const ENTITY_B = 'did:dkg:entity:bob';
export const SCHEMA_NAME = 'https://schema.org/name';
export const SCHEMA_PERSON = 'https://schema.org/Person';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

export function makeRequest(overrides: Partial<QueryRequest> = {}): QueryRequest {
  return {
    operationId: 'test-op-1',
    lookupType: 'ENTITY_TRIPLES',
    contextGraphId: CONTEXT_GRAPH,
    ...overrides,
  };
}

/** Alice and Bob, each a person with a name, in the test context graph. */
export async function insertPeople(store: OxigraphStore): Promise<void> {
  await store.insert([
    q(ENTITY_A, RDF_TYPE, SCHEMA_PERSON),
    q(ENTITY_A, SCHEMA_NAME, '"Alice"'),
    q(ENTITY_B, RDF_TYPE, SCHEMA_PERSON),
    q(ENTITY_B, SCHEMA_NAME, '"Bob"'),
  ]);
}
