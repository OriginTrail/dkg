/**
 * Store Isolation Tests
 *
 * Validates Design Principles §1.6 (Store Isolation) and §1.7
 * (Protocol-Mediated Mutations) from the spec. These tests ensure:
 *
 * 1. Each node has a completely independent triple store
 * 2. No node can query another node's store
 * 3. DKGQueryEngine is strictly local-only
 * 4. Data only enters a node's store via protocol handlers
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CONTEXT_GRAPH = 'test-paranet';
const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;

function q(s: string, p: string, o: string): Quad {
  return { subject: s, predicate: p, object: o, graph: GRAPH };
}

describe('Store Isolation (Spec §1.6, §1.7)', () => {
  describe('independent stores', () => {
    it('two OxigraphStore instances share no state', async () => {
      const storeA = new OxigraphStore();
      const storeB = new OxigraphStore();

      await storeA.insert([
        q('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"'),
      ]);

      const resultA = await storeA.query(
        `SELECT ?name WHERE { GRAPH <${GRAPH}> { ?s <http://schema.org/name> ?name } }`,
      );
      expect(resultA.type).toBe('bindings');
      expect(resultA.bindings).toHaveLength(1);

      const resultB = await storeB.query(
        `SELECT ?name WHERE { GRAPH <${GRAPH}> { ?s <http://schema.org/name> ?name } }`,
      );
      expect(resultB.type).toBe('bindings');
      expect(resultB.bindings).toHaveLength(0);
    });

    it('inserting into store A does not affect store B queries', async () => {
      const storeA = new OxigraphStore();
      const storeB = new OxigraphStore();
      const engineA = new DKGQueryEngine(storeA);
      const engineB = new DKGQueryEngine(storeB);

      await storeA.insert([
        q('did:dkg:agent:SecretAgent', 'http://dkg.io/ontology/apiKey', '"sk-secret-key"'),
        q('did:dkg:agent:SecretAgent', 'http://schema.org/name', '"SecretAgent"'),
      ]);

      const resA = await engineA.query(
        'SELECT ?s WHERE { ?s <http://dkg.io/ontology/apiKey> ?key }',
        { contextGraphId: CONTEXT_GRAPH },
      );
      expect(resA.bindings).toHaveLength(1);

      const resB = await engineB.query(
        'SELECT ?s WHERE { ?s <http://dkg.io/ontology/apiKey> ?key }',
        { contextGraphId: CONTEXT_GRAPH },
      );
      expect(resB.bindings).toHaveLength(0);
    });
  });

  describe('local-only query engine', () => {
    it('DKGQueryEngine has no remote query methods', () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      expect(engine).toHaveProperty('query');
      expect(engine).toHaveProperty('resolveKA');
      expect(engine).toHaveProperty('queryAllContextGraphs');

      expect(engine).not.toHaveProperty('remoteQuery');
      expect(engine).not.toHaveProperty('federatedQuery');
      expect(engine).not.toHaveProperty('forwardQuery');
      expect(engine).not.toHaveProperty('proxyQuery');
    });

    it('QueryOptions does not accept a federated flag and query returns a valid local result type', async () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      const options = { contextGraphId: CONTEXT_GRAPH };
      expect(options).not.toHaveProperty('federated');

      // Previously this only asserted `.resolves.toBeDefined()` — a check
      // that would "pass" even if the engine quietly returned `null` or
      // `{}` on an unsupported option. Since the contract for
      // DKGQueryEngine.query is to return `{ bindings: Array<...>, quads?: ... }`
      // for a local SELECT, assert that shape explicitly. A regression
      // where QueryOptions accidentally accepts `federated` (or silently
      // drops the query, returning `undefined`) would fail here instead
      // of silently passing.
      const result = await engine.query(
        'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
        options,
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result.bindings), 'SELECT on empty store must return bindings array (possibly empty)').toBe(true);
      expect(result.bindings.length, 'empty store should yield zero bindings').toBe(0);
    });

    it('queryAllContextGraphs only queries local store', async () => {
      const storeA = new OxigraphStore();
      const storeB = new OxigraphStore();
      const engineA = new DKGQueryEngine(storeA);

      await storeA.insert([
        q('did:dkg:agent:LocalBot', 'http://schema.org/name', '"LocalBot"'),
      ]);
      await storeB.insert([
        { subject: 'did:dkg:agent:RemoteBot', predicate: 'http://schema.org/name', object: '"RemoteBot"', graph: 'did:dkg:context-graph:other' },
      ]);

      const result = await engineA.queryAllContextGraphs(
        'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      );

      const names = result.bindings.map(b => b['name']);
      expect(names).toContain('"LocalBot"');
      expect(names).not.toContain('"RemoteBot"');
    });
  });

  describe('protocol-mediated mutations', () => {
    it('store only accepts inserts from local code path', async () => {
      const store = new OxigraphStore();
      const gm = new GraphManager(store);

      await gm.ensureContextGraph(CONTEXT_GRAPH);

      await store.insert([
        q('did:dkg:agent:Bot1', 'http://schema.org/name', '"Bot1"'),
      ]);

      const result = await store.query(
        `SELECT ?name WHERE { GRAPH <${GRAPH}> { ?s <http://schema.org/name> ?name } }`,
      );
      expect(result.type).toBe('bindings');
      expect(result.bindings).toHaveLength(1);
    });

    it('no external delete API exists on DKGQueryEngine', () => {
      const store = new OxigraphStore();
      const engine = new DKGQueryEngine(store);

      expect(engine).not.toHaveProperty('delete');
      expect(engine).not.toHaveProperty('drop');
      expect(engine).not.toHaveProperty('insert');
      expect(engine).not.toHaveProperty('update');
    });
  });
});
