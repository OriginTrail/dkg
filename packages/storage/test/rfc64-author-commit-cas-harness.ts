import type {
  Quad,
  Rfc64AuthorCommitCasInputV1,
  TripleStore,
} from '../src/index.js';

export const PROJECTION_GRAPH = 'did:dkg:context-graph:rfc64/_shared_memory';
export const SEAL_GRAPH = 'urn:test:rfc64:seals';
export const HEAD_GRAPH = 'urn:test:rfc64:heads';
export const STATE_GRAPH = 'urn:test:rfc64:state';
export const OTHER_GRAPH = 'urn:test:rfc64:unrelated';
export const AUTHOR = 'urn:test:rfc64:author:alice';
export const SEAL = 'urn:test:rfc64:seal:alice';
export const KA_STATE = 'urn:test:rfc64:ka-state';
export const MUTATION = 'urn:test:rfc64:mutation:subgraph';
export const CG_MUTATION = 'urn:test:rfc64:mutation:context-graph';
export const APPLIED_SET = 'urn:test:rfc64:applied-set';
export const INVALIDATED_SEAL = 'urn:test:rfc64:seal:stale';
export const P_VALUE = 'urn:test:rfc64:value';
export const P_HEAD = 'urn:test:rfc64:current-head';
export const P_GENERATION = 'urn:test:rfc64:generation';
export const P_APPLIED = 'urn:test:rfc64:applied';
export const OLD_HEAD = 'urn:test:rfc64:catalog:old';
export const NEW_HEAD = 'urn:test:rfc64:catalog:new';

export function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

export function authorCommitInput(
  overrides: Partial<Rfc64AuthorCommitCasInputV1> = {},
): Rfc64AuthorCommitCasInputV1 {
  return {
    sharedProjectionGraph: PROJECTION_GRAPH,
    sharedProjectionQuads: [
      quad('urn:test:rfc64:new:1', P_VALUE, '"new-1"', PROJECTION_GRAPH),
      quad('urn:test:rfc64:new:2', P_VALUE, '"new-2"', PROJECTION_GRAPH),
    ],
    authorSealGraph: SEAL_GRAPH,
    authorSealSubject: SEAL,
    authorSealQuads: [quad(SEAL, P_VALUE, '"new-seal"', SEAL_GRAPH)],
    currentHeadGraph: HEAD_GRAPH,
    currentHeadSubject: AUTHOR,
    currentHeadPredicate: P_HEAD,
    expectedCurrentHeadObject: OLD_HEAD,
    nextCurrentHeadObject: NEW_HEAD,
    kaStateDigest: {
      graphUri: STATE_GRAPH,
      subject: KA_STATE,
      predicate: P_VALUE,
      expectedObject: OLD_HEAD,
      quads: [quad(KA_STATE, P_VALUE, NEW_HEAD, STATE_GRAPH)],
    },
    subgraphMutationGeneration: {
      graphUri: STATE_GRAPH,
      subject: MUTATION,
      predicate: P_GENERATION,
      expectedObject: '"1"',
      quads: [quad(MUTATION, P_GENERATION, '"2"', STATE_GRAPH)],
    },
    contextGraphMutationGeneration: {
      graphUri: STATE_GRAPH,
      subject: CG_MUTATION,
      predicate: P_GENERATION,
      expectedObject: '"10"',
      quads: [quad(CG_MUTATION, P_GENERATION, '"11"', STATE_GRAPH)],
    },
    appliedSet: {
      graphUri: STATE_GRAPH,
      subject: APPLIED_SET,
      predicate: P_APPLIED,
      expectedObject: OLD_HEAD,
      quads: [quad(APPLIED_SET, P_APPLIED, NEW_HEAD, STATE_GRAPH)],
    },
    sealInvalidations: [],
    ...overrides,
  };
}

export async function seedOldState(store: TripleStore): Promise<void> {
  await store.insert([
    quad('urn:test:rfc64:old', P_VALUE, '"old"', PROJECTION_GRAPH),
    quad(SEAL, P_VALUE, '"old-seal"', SEAL_GRAPH),
    quad(AUTHOR, P_HEAD, OLD_HEAD, HEAD_GRAPH),
    quad(KA_STATE, P_VALUE, OLD_HEAD, STATE_GRAPH),
    quad(MUTATION, P_GENERATION, '"1"', STATE_GRAPH),
    quad(CG_MUTATION, P_GENERATION, '"10"', STATE_GRAPH),
    quad(APPLIED_SET, P_APPLIED, OLD_HEAD, STATE_GRAPH),
    quad('urn:test:rfc64:keep', P_VALUE, '"keep"', OTHER_GRAPH),
  ]);
}

export async function objectFor(
  store: TripleStore,
  graph: string,
  subject: string,
  predicate: string,
): Promise<string | undefined> {
  const result = await store.query(
    `SELECT ?o WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?o } }`,
  );
  if (result.type !== 'bindings') throw new Error('expected bindings result');
  return result.bindings[0]?.o;
}

export function overrideStore(base: TripleStore, overrides: Partial<TripleStore>): TripleStore {
  return new Proxy(base, {
    get(target, prop) {
      if (prop in overrides) return (overrides as Record<string | symbol, unknown>)[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TripleStore;
}
