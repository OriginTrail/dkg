import { describe, expect, it } from 'vitest';
import { OxigraphStore, StoreResponseTooLargeError, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { assertionLifecycleUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions } from '../src/query-engine.js';
import {
  QUERY_CATALOG_LIMIT_NAME,
  QUERY_CATALOG_MAX_RESPONSE_BYTES,
  QueryMaterializationBudget,
  readWithinCatalogLimit,
} from '../src/query-store-read-context.js';

const ID = 'internal-budget', ROOT = `did:dkg:context-graph:${ID}`, NAME = 'http://schema.org/name';
const AGENT = '0x00000000000000000000000000000000000000a1';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'http://dkg.io/ontology/';
const CALLER_LIMIT = 1024 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const quad = (graph: string, subject: string, predicate: string, object: string): Quad =>
  ({ graph, subject, predicate, object });

/** Registry, authority, key and metadata facts, so every internal read has an answer. */
function fixture(): Quad[] {
  const meta = `${ROOT}/_meta`;
  return [
    ...['alpha', 'beta', 'gamma'].flatMap(sub => [
      quad(meta, `${ROOT}/${sub}`, RDF_TYPE, `${DKG}SubGraph`),
      quad(meta, `${ROOT}/${sub}`, 'http://schema.org/name', `"${sub}"`),
      quad(`${ROOT}/${sub}/_verifiable_memory/0xabc/1`, `urn:${sub}`, NAME, `"${sub}"`),
    ]),
    ...['one', 'two'].map(child => quad(`${ROOT}/child-${child}/_meta`, `${ROOT}/child-${child}`,
      RDF_TYPE, 'https://dkg.network/ontology#ContextGraph')),
    quad(`${ROOT}/_verifiable_memory/0xabc/1`, 'urn:vm', NAME, '"vm"'),
    quad(`${ROOT}/context/7`, 'urn:per-id', NAME, '"per-id"'),
    quad(meta, assertionLifecycleUri(ID, AGENT, 'draft'), `${DKG}kaId`, '"5"'),
    quad(contextGraphLayerUri(ID, MemoryLayer.WorkingMemory, AGENT, 5), 'urn:draft', NAME, '"draft"'),
    ...['contentScopeVersion', 'assertionVersion', 'privateTripleCount'].map(predicate =>
      quad(meta, 'urn:private-ka', `${DKG}${predicate}`, '"1"')),
    quad(meta, 'urn:private-ka', `${DKG}kaUal`, 'urn:private-ka'),
    quad(meta, 'urn:private-ka', `${DKG}assertionGraph`, `${ROOT}/_verifiable_memory/0xabc/1`),
    quad(meta, 'urn:private-ka', `${DKG}status`, '"confirmed"'),
  ];
}

/**
 * The store as the engine sees it. A read under the node's catalog bound is internal; one
 * under the caller's limit is the caller's own query. Discoveries record the slice they return.
 */
function recordingStore(inner: TripleStore) {
  const slices: number[] = [], results: number[] = [], internal: number[] = [];
  const store = new Proxy(inner, { get(target, key) {
    if (key === 'listGraphsByPrefix') return async (prefix: string) => {
      const graphs = (await target.listGraphs()).filter(graph => graph.startsWith(prefix));
      slices.push(bytes(graphs));
      return graphs;
    };
    if (key === 'query') return async (sparql: string, options: Parameters<TripleStore['query']>[1]) => {
      const result = await target.query(sparql, options);
      (options?.maxResponseBytes === QUERY_CATALOG_MAX_RESPONSE_BYTES ? internal : results).push(bytes(result));
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { store, slices, results, internal };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe('internal reads leave the caller budget', () => {
  it.each<[string, string, QueryOptions]>([
    ['a view across registered sub-graphs and child context graphs', `SELECT ?name WHERE { ?s <${NAME}> ?name }`,
      { view: 'verifiable-memory' }],
    ['a working-memory read by assertion name', `SELECT ?name WHERE { ?s <${NAME}> ?name }`,
      { view: 'working-memory', agentAddress: AGENT, assertionName: 'draft' }],
    ['a scoped read with private data', `SELECT ?name WHERE { ?s <${NAME}> ?name }`, { includePrivate: true }],
    ['a scoped read across partitions', `SELECT ?name WHERE { GRAPH ?g { ?s <${NAME}> ?name } }`,
      { includeContextGraphPartitions: true }],
  ])('charges %s for its slices and results only', async (_shape, sparql, shape) => {
    const inner = new OxigraphStore();
    await inner.insert(fixture());
    const { store, slices, results, internal } = recordingStore(inner);
    const charges: number[] = [];
    class RecordingBudget extends QueryMaterializationBudget {
      override consumeBytes(value: number): void { charges.push(value); super.consumeBytes(value); }
    }
    try {
      const answer = await new DKGQueryEngine(store).query(sparql, {
        ...shape, contextGraphId: ID, maxResponseBytes: CALLER_LIMIT,
        materializationBudget: new RecordingBudget(CALLER_LIMIT),
      });
      expect(answer.bindings.length).toBeGreaterThan(0);
      expect(sum(internal)).toBeGreaterThan(0);
      expect(sum(charges)).toBe(sum(slices) + sum(results));
    } finally { await inner.close(); }
  });

  it('answers an authority read over the node bound as a node-side limit', async () => {
    await expect(readWithinCatalogLimit(async () => {
      throw new StoreResponseTooLargeError(QUERY_CATALOG_MAX_RESPONSE_BYTES, QUERY_CATALOG_MAX_RESPONSE_BYTES + 1);
    })).rejects.toMatchObject({
      code: 'STORE_INTERNAL_LIMIT', limitName: QUERY_CATALOG_LIMIT_NAME,
      limitBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES, actualBytes: QUERY_CATALOG_MAX_RESPONSE_BYTES + 1,
    });
    const other = new Error('store unavailable');
    await expect(readWithinCatalogLimit(async () => { throw other; })).rejects.toBe(other);
    await expect(readWithinCatalogLimit(async () => 'ok')).resolves.toBe('ok');
  });
});
