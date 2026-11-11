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

/** The caller's own pattern: every query without it is a read the node makes for itself. */
const CALLER_PATTERN = /\?s\s+<http:\/\/schema\.org\/name>\s+\?name/;

/**
 * The store as the engine sees it. A query is the caller's when its text holds the caller's
 * pattern, whatever options it carries; every other query is internal. Each read records the
 * limit it was given, and each discovery the slice it returns.
 */
function recordingStore(inner: TripleStore) {
  const slices: number[] = [];
  const results: Array<{ bytes: number; limit?: number }> = [];
  const internal: Array<{ bytes: number; limit?: number }> = [];
  const store = new Proxy(inner, { get(target, key) {
    if (key === 'listGraphsByPrefix') return async (prefix: string) => {
      const graphs = (await target.listGraphs()).filter(graph => graph.startsWith(prefix));
      slices.push(bytes(graphs));
      return graphs;
    };
    if (key === 'query') return async (sparql: string, options: Parameters<TripleStore['query']>[1]) => {
      const result = await target.query(sparql, options);
      (CALLER_PATTERN.test(sparql) ? results : internal).push({ bytes: bytes(result), limit: options?.maxResponseBytes });
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
      // Every internal read keeps the node's bound, and every caller query the caller's limit.
      expect(internal.length).toBeGreaterThan(0);
      expect(internal.map(read => read.limit)).toEqual(internal.map(() => QUERY_CATALOG_MAX_RESPONSE_BYTES));
      expect(results.length).toBeGreaterThan(0);
      expect(results.map(read => read.limit)).toEqual(results.map(() => CALLER_LIMIT));
      // The caller pays for its slices and its results; no internal answer is in its charges.
      expect(sum(charges)).toBe(sum(slices) + sum(results.map(read => read.bytes)));
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
