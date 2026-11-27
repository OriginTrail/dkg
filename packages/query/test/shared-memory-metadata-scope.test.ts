import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const ID = 'attribution/parent';
const ROOT = `did:dkg:context-graph:${ID}`;
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG = 'http://dkg.io/ontology/';
const QUERY = `SELECT ?g ?agent WHERE { GRAPH ?g { ?op a <${DKG}WorkspaceOperation> ;
  <http://www.w3.org/ns/prov#wasAttributedTo> ?agent } } ORDER BY ?agent`;
const OPTIONS = { contextGraphId: ID, includeContextGraphPartitions: true };

describe('CG-wide shared-memory attribution', () => {
  it('includes all five registered contributors while excluding child CGs and unregistered partitions', async () => {
    const store = new OxigraphStore();
    const graphs = ['', 'code', 'notes', 'research', 'decisions'].map(sub =>
      `${ROOT}/${sub ? `${sub}/` : ''}_shared_memory_meta`);
    const excluded = ['child/_shared_memory_meta', 'child/nested/_shared_memory_meta',
      'unregistered/_shared_memory_meta', '_private/_shared_memory_meta',
      '_verifiable_memory/staging/_shared_memory_meta', 'code/_shared_memory_meta/nested'];
    try {
      await store.insert(['code', 'notes', 'research', 'decisions', 'child'].flatMap(sub => [
        { graph: `${ROOT}/_meta`, subject: `urn:sub:${sub}`, predicate: TYPE, object: `${DKG}SubGraph` },
        { graph: `${ROOT}/_meta`, subject: `urn:sub:${sub}`, predicate: 'http://schema.org/name', object: `"${sub}"` },
      ]));
      await store.insert([{ graph: `${ROOT}/child/_meta`, subject: `${ROOT}/child`, predicate: TYPE,
        object: 'https://dkg.network/ontology#ContextGraph' }]);
      await store.insert([...graphs, ...excluded.map(tail => `${ROOT}/${tail}`)].flatMap((graph, index) => [
        { graph, subject: `urn:op:${index}`, predicate: TYPE, object: `${DKG}WorkspaceOperation` },
        { graph, subject: `urn:op:${index}`, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `urn:agent:${index}` },
      ]));
      const engine = new DKGQueryEngine(store);
      const before = await engine.query(QUERY, OPTIONS);
      const scoped = await engine.query(QUERY, { ...OPTIONS, includeSharedMemoryMeta: true });
      expect(scoped.bindings.map(row => row.g)).toEqual(graphs);
      expect(scoped.bindings.map(row => row.agent)).toEqual([0, 1, 2, 3, 4].map(i => `urn:agent:${i}`));
      // The opt-in must not contaminate a memoized inventory's default policy.
      expect(await engine.query(QUERY, OPTIONS)).toEqual(before);
      expect(before.bindings.map(row => row.g)).toEqual([graphs[0]]); // Existing root metadata access.
      const named = await engine.query(QUERY, { ...OPTIONS, subGraphName: 'code', includeSharedMemoryMeta: true });
      expect(named.bindings.map(row => row.g)).toEqual([graphs[1]]);
      const swmOnly = await engine.query(QUERY, { ...OPTIONS, graphSuffix: '_shared_memory', includeSharedMemoryMeta: true });
      expect(swmOnly.bindings.map(row => row.g)).toEqual([graphs[0]]);
    } finally { await store.close(); }
  });
});
