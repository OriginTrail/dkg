import { describe, expect, it, vi } from 'vitest';
import type {
  QueryOptions,
  QueryResult,
  TripleStore,
} from '@origintrail-official/dkg-storage';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  EXACT_GRAPH_QUERY_BATCH_SIZE,
  classifyMemoryGraph,
  readContextGraphNamedGraphStats,
  readMemoryLayers,
} from '../src/daemon/context-graph-read-model.js';

const CG = 'large-cg';
const ROOT = `did:dkg:context-graph:${CG}`;

function exactGraphs(sparql: string): string[] {
  return [...sparql.matchAll(/GRAPH <([^>]+)>/g)].map((match) => match[1]);
}

function mockStore(
  graphs: string[],
  queryImpl: (sparql: string, options?: QueryOptions) => Promise<QueryResult>,
): TripleStore {
  return {
    listGraphsByPrefix: vi.fn(async () => graphs),
    query: vi.fn(queryImpl),
  } as unknown as TripleStore;
}

describe('context-graph read model', () => {
  it('classifies the existing WM, SWM, and VM graph families without prefix collisions', () => {
    expect(classifyMemoryGraph(`${ROOT}/notes/assertion/0xabc/a`, CG)).toBe('wm');
    expect(classifyMemoryGraph(`${ROOT}/notes/_working_memory/a`, CG)).toBe('wm');
    expect(classifyMemoryGraph(`${ROOT}/notes/_shared_memory`, CG)).toBe('swm');
    expect(classifyMemoryGraph(`${ROOT}/notes/_shared_memory/ka-1`, CG)).toBe('swm');
    expect(classifyMemoryGraph(ROOT, CG)).toBe('vm');
    expect(classifyMemoryGraph(`${ROOT}/notes`, CG)).toBe('vm');
    expect(classifyMemoryGraph(`${ROOT}/notes/_verifiable_memory/ka-1`, CG)).toBe('vm');

    expect(classifyMemoryGraph(`${ROOT}/meta/assertion/0xabc/profile`, CG)).toBeUndefined();
    expect(classifyMemoryGraph(`${ROOT}/notes/_shared_memory/staging/ka-1`, CG)).toBeUndefined();
    expect(classifyMemoryGraph(`${ROOT}-other/notes`, CG)).toBeUndefined();
  });

  it('uses graph-index discovery and small exact-IRI batches instead of GRAPH variables or VALUES', async () => {
    const wmGraphs = Array.from(
      { length: EXACT_GRAPH_QUERY_BATCH_SIZE + 3 },
      (_, index) => `${ROOT}/notes/assertion/0xabc/a-${index}`,
    );
    const graphs = [
      ...wmGraphs,
      `${ROOT}/notes/_shared_memory`,
      `${ROOT}/notes`,
      `${ROOT}/meta/assertion/0xabc/profile`,
    ];
    const queries: Array<{ sparql: string; source?: string }> = [];
    const store = mockStore(graphs, async (sparql, options) => {
      queries.push({ sparql, source: options?.source });
      return {
        type: 'bindings',
        bindings: exactGraphs(sparql).map((graph) => ({
          s: `urn:entity:${graph.slice(-3)}`,
          p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
          o: 'http://schema.org/Thing',
          g: graph,
        })),
      };
    });

    const snapshot = await readMemoryLayers(store, CG);

    expect(store.listGraphsByPrefix).toHaveBeenCalledTimes(1);
    expect(snapshot.layers.wm.bindings).toHaveLength(wmGraphs.length);
    expect(snapshot.layers.swm.bindings).toHaveLength(1);
    expect(snapshot.layers.vm.bindings).toHaveLength(1);
    expect(queries.map((query) => query.source)).toEqual([
      'node-ui.memory-layers.wm',
      'node-ui.memory-layers.wm',
      'node-ui.memory-layers.swm',
      'node-ui.memory-layers.vm',
    ]);
    for (const { sparql } of queries) {
      expect(sparql).not.toMatch(/GRAPH\s+\?g/i);
      expect(sparql).not.toMatch(/\bVALUES\b/i);
      expect(exactGraphs(sparql).length).toBeLessThanOrEqual(EXACT_GRAPH_QUERY_BATCH_SIZE);
    }
    expect(queries.find((query) => query.source?.endsWith('.swm'))?.sparql)
      .toContain('FILTER(?p != <http://dkg.io/ontology/workspaceOwner>)');
  });

  it('contains a layer failure and continues with the remaining serial reads', async () => {
    const store = mockStore([
      `${ROOT}/notes/assertion/0xabc/a`,
      `${ROOT}/notes/_shared_memory`,
      `${ROOT}/notes`,
    ], async (sparql, options) => {
      if (options?.source === 'node-ui.memory-layers.swm') throw new Error('slow SWM read');
      const graph = exactGraphs(sparql)[0];
      return {
        type: 'bindings',
        bindings: [{ s: 'urn:s', p: 'urn:p', o: 'urn:o', g: graph }],
      };
    });

    const snapshot = await readMemoryLayers(store, CG);

    expect(snapshot.layers.wm.ok).toBe(true);
    expect(snapshot.layers.swm).toEqual({ bindings: [], ok: false, truncated: false });
    expect(snapshot.layers.vm.ok).toBe(true);
  });

  it('computes subgraph stats in exact-IRI batches', async () => {
    const graphs = Array.from(
      { length: EXACT_GRAPH_QUERY_BATCH_SIZE + 1 },
      (_, index) => `${ROOT}/sg-${index}`,
    );
    const queries: string[] = [];
    const store = mockStore(graphs, async (sparql) => {
      queries.push(sparql);
      return {
        type: 'bindings',
        bindings: exactGraphs(sparql).map((graph) => ({
          g: graph,
          entities: '"2"^^http://www.w3.org/2001/XMLSchema#integer',
          triples: '"3"^^http://www.w3.org/2001/XMLSchema#integer',
        })),
      };
    });

    const stats = await readContextGraphNamedGraphStats(store, CG);

    expect(stats).toHaveLength(graphs.length);
    expect(stats[0]).toEqual({ graph: graphs[0], entityCount: 2, tripleCount: 3 });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).not.toMatch(/GRAPH\s+\?g/i);
      expect(query).not.toMatch(/\bVALUES\b/i);
      expect(exactGraphs(query).length).toBeLessThanOrEqual(EXACT_GRAPH_QUERY_BATCH_SIZE);
    }
  });

  it('executes the exact-graph UNION reads against real Oxigraph', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        { subject: 'urn:wm', predicate: 'urn:type', object: 'urn:Thing', graph: `${ROOT}/notes/assertion/0xabc/a` },
        { subject: 'urn:swm', predicate: 'urn:type', object: 'urn:Thing', graph: `${ROOT}/notes/_shared_memory` },
        { subject: 'urn:swm', predicate: 'http://dkg.io/ontology/workspaceOwner', object: 'urn:owner', graph: `${ROOT}/notes/_shared_memory` },
        { subject: 'urn:vm', predicate: 'urn:type', object: 'urn:Thing', graph: `${ROOT}/notes` },
      ]);

      const snapshot = await readMemoryLayers(store, CG);
      expect(snapshot.layers.wm.bindings.map((row) => row.s)).toEqual(['urn:wm']);
      expect(snapshot.layers.swm.bindings.map((row) => row.p)).toEqual(['urn:type']);
      expect(snapshot.layers.vm.bindings.map((row) => row.s)).toEqual(['urn:vm']);

      const stats = await readContextGraphNamedGraphStats(store, CG);
      expect(stats.find((row) => row.graph === `${ROOT}/notes/_shared_memory`))
        .toMatchObject({ entityCount: 1, tripleCount: 2 });
    } finally {
      await store.close();
    }
  });
});
