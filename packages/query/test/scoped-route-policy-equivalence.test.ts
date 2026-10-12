// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions } from '../src/query-engine.js';

const ROOT = 'did:dkg:context-graph:route-equivalence';
const CODE = `${ROOT}/code`;
const WM = `${ROOT}/_working_memory/author/1`;
const CODE_WM = `${CODE}/_working_memory/author/1`;
const CHILD = `${ROOT}/child`;
const ROOT_CONTENT = [ROOT, `${ROOT}/_shared_memory`, WM,
  `${WM}/_named_graph/urn%3Adata`, `${ROOT}/_shared_memory/author/1`,
  `${ROOT}/_verifiable_memory/author/1`];
const CODE_CONTENT = [CODE, `${CODE}/_shared_memory`, CODE_WM,
  `${CODE_WM}/_named_graph/urn%3Adata`, `${CODE}/_shared_memory/author/1`,
  `${CODE}/_verifiable_memory/author/1`];
const DENIED = [`${ROOT}/unknown`, `${ROOT}/_working_memory/author/2`,
  `${ROOT}/_private`, `${ROOT}/_private/author/1`, `${ROOT}/_rules/rule`,
  `${ROOT}/_shared_memory/author/1/_private`, `${ROOT}/_shared_memory/staging/1`,
  `${ROOT}/_verifiable_memory/staging/1`, `${CODE}/_private/author/1`,
  CHILD, `${CHILD}/_shared_memory/author/1`, `${CHILD}/_meta`];
const METADATA = [`${ROOT}/_meta`, `${ROOT}/_shared_memory_meta`,
  `${CODE}/_meta`, `${CODE}/_shared_memory_meta`];
const CANDIDATES = [...ROOT_CONTENT, ...CODE_CONTENT, ...DENIED, ...METADATA];

const routes: { name: string; options: QueryOptions; expected: string[] }[] = [
  { name: 'root', options: { includeSharedMemory: true },
    expected: [...ROOT_CONTENT, ...CODE_CONTENT.filter(graph => graph !== `${CODE}/_shared_memory`), METADATA[0], METADATA[1]] },
  { name: 'subgraph', options: { subGraphName: 'code', includeSharedMemory: true },
    expected: [...CODE_CONTENT, METADATA[0], METADATA[2], METADATA[3]] },
  { name: 'root SWM-only with shared-memory flag', options: { graphSuffix: '_shared_memory', includeSharedMemory: true },
    expected: [`${ROOT}/_shared_memory`, `${ROOT}/_shared_memory/author/1`, METADATA[1]] },
  { name: 'subgraph SWM-only with shared-memory flag', options: { subGraphName: 'code', graphSuffix: '_shared_memory', includeSharedMemory: true },
    expected: [`${CODE}/_shared_memory`, `${CODE}/_shared_memory/author/1`, METADATA[3]] },
];

routes.push(...routes.map(route => ({
  name: `${route.name} without convenience shared-memory inclusion`,
  options: { ...route.options, includeSharedMemory: false },
  expected: route.options.graphSuffix === '_shared_memory' ? route.expected
    : route.expected.filter(graph => graph !== `${route.options.subGraphName ? CODE : ROOT}/_shared_memory`),
})));

describe('scoped route policy equivalence', () => {
  it.each(routes)('ordinary, inventory and exact reads agree for $name', async ({ options, expected }) => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...CANDIDATES.map(graph => ({ subject: 'urn:row', predicate: 'urn:p', object: '"content"', graph })),
        { subject: CODE, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: METADATA[0] },
        { subject: CODE, predicate: 'http://schema.org/name', object: '"code"', graph: METADATA[0] },
        // Even a registered subgraph cannot expose a canonical nested CG.
        { subject: CHILD, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: METADATA[0] },
        { subject: CHILD, predicate: 'http://schema.org/name', object: '"child"', graph: METADATA[0] },
        { subject: CHILD, predicate: 'https://dkg.network/ontology#registrationStatus', object: '"registered"', graph: `${CHILD}/_meta` },
        ...[WM, CODE_WM].map(graph => ({ subject: `urn:assertion:${graph}`, predicate: 'http://dkg.io/ontology/assertionGraph', object: graph, graph: METADATA[0] })),
      ]);
      const engine = new DKGQueryEngine(store);
      const scoped = { ...options, contextGraphId: 'route-equivalence', includeContextGraphPartitions: true };
      expect((await engine.listContextGraphQueryPartitions('route-equivalence', options)).sort()).toEqual([...expected].sort());
      const ordinary = await engine.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }', scoped);
      expect(ordinary.bindings.map(row => row.g).sort()).toEqual([...expected].sort());
      for (const graph of CANDIDATES) {
        const read = engine.query(`SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
          { ...scoped, exactContextGraphPartitions: true });
        if (expected.includes(graph)) expect((await read).bindings.length).toBeGreaterThan(0);
        else await expect(read).rejects.toThrow(/Scoped query violation/);
      }
      if (options.graphSuffix === '_shared_memory') {
        // The convenience inclusion flag cannot widen an explicit SWM-only route.
        const data = options.subGraphName ? CODE : ROOT;
        await expect(engine.query(`SELECT ?s WHERE { GRAPH <${data}> { ?s ?p ?o } }`, scoped))
          .rejects.toThrow(/Scoped query violation/);
      }
    } finally { await store.close(); }
  });
});
