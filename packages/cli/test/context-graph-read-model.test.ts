import { describe, expect, it, vi } from 'vitest';
import type {
  QueryOptions,
  QueryResult,
  TripleStore,
} from '@origintrail-official/dkg-storage';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { QueryMethods } from '../../agent/src/dkg-agent-query.js';
import {
  EXACT_GRAPH_QUERY_BATCH_SIZE,
  MEMORY_LAYER_LIMITS,
  type ContextGraphReader,
  classifyMemoryGraph,
  readContextGraphNamedGraphStats,
  readMemoryLayers,
} from '../src/daemon/context-graph-read-model.js';

const CG = 'large-cg';
const ROOT = `did:dkg:context-graph:${CG}`;

function exactGraphs(sparql: string): string[] {
  return [...sparql.matchAll(/GRAPH <([^>]+)>/g)].map((match) => match[1]);
}

function mockReader(
  graphs: string[],
  queryImpl: (sparql: string, options?: QueryOptions) => Promise<QueryResult>,
): ContextGraphReader {
  return {
    listGraphs: vi.fn(async () => graphs),
    query: vi.fn(queryImpl),
  };
}

function oxigraphReader(store: TripleStore): ContextGraphReader {
  return { listGraphs: options => store.listGraphs(options), query: (sparql, options) => store.query(sparql, options) };
}

describe('context-graph read model', () => {
  it.each([false, true])('settles every batch and layer before starting another query (SWM rejection=%s)', async rejectSwm => {
    const pending: Array<{ source: string | undefined; resolve: (value: QueryResult) => void; reject: (error: Error) => void }> = [];
    let outstanding = 0;
    let peakOutstanding = 0;
    const reader = mockReader([
      ...Array.from({ length: EXACT_GRAPH_QUERY_BATCH_SIZE + 1 }, (_, i) => `${ROOT}/notes/assertion/0xabc/a-${i}`),
      `${ROOT}/notes/_shared_memory`, `${ROOT}/notes`,
    ], (_sparql, options) => {
      outstanding++;
      peakOutstanding = Math.max(peakOutstanding, outstanding);
      return new Promise<QueryResult>((resolve, reject) => pending.push({ source: options?.source, resolve, reject }))
        .finally(() => { outstanding--; });
    });
    const read = readMemoryLayers(reader, CG);
    const expected = ['wm', 'wm', 'swm', 'vm'];
    for (let i = 0; i < expected.length; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(pending).toHaveLength(i + 1);
      expect(outstanding).toBe(1);
      expect(pending[i].source).toBe(`node-ui.memory-layers.${expected[i]}`);
      if (rejectSwm && expected[i] === 'swm') pending[i].reject(new Error('selected layer failed'));
      else pending[i].resolve({ type: 'bindings', bindings: [] });
    }
    const snapshot = await read;
    expect(peakOutstanding).toBe(1);
    expect(outstanding).toBe(0);
    expect(snapshot.layers.wm.ok).toBe(true);
    expect(snapshot.layers.swm.ok).toBe(!rejectSwm);
    expect(snapshot.layers.vm.ok).toBe(true);
  });

  it.each([false, true])('gates catalog SWM graph counts through canonical shared-memory authority (%s)', async allowed => {
    const store = new OxigraphStore();
    const catalogGraph = `${ROOT}/meta/_shared_memory/0xabc/1`;
    try {
      await store.insert([
        { subject: `${ROOT}/meta`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: `${ROOT}/meta`, predicate: 'http://schema.org/name', object: '"meta"', graph: `${ROOT}/_meta` },
        { subject: 'urn:catalog', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/profile/QueryCatalog', graph: catalogGraph },
        { subject: 'urn:ordinary', predicate: 'urn:p', object: 'urn:o', graph: ROOT },
      ]);
      const queryEngine = new DKGQueryEngine(store);
      const sharedGate = vi.fn(async () => allowed);
      const agent = { log: { info() {} }, queryEngine,
        resolveContextGraphReadAuthority: async () => ({ outcome: 'allowed' }),
        canUseSharedMemoryForContextGraph: sharedGate };
      const stats = await readContextGraphNamedGraphStats({
        listGraphs: options => queryEngine.listContextGraphQueryPartitions(CG, options),
        query: async (sparql, options, policy) => {
          const result = await QueryMethods.prototype.query.call(agent as never, sparql, {
            ...options, contextGraphId: CG, includeContextGraphPartitions: true,
            exactContextGraphPartitions: true, includeSharedMemory: policy.includeSharedMemory,
            callerAgentAddress: '0xpublic-reader',
          });
          return { type: 'bindings', bindings: result.bindings };
        },
      }, CG, { source: 'changed-diagnostic-label' });
      expect(stats.find(row => row.graph === ROOT)).toMatchObject({ tripleCount: 1 });
      expect(sharedGate).toHaveBeenCalled();
      expect(stats.find(row => row.graph === catalogGraph)?.tripleCount ?? 0).toBe(allowed ? 1 : 0);
    } finally { await store.close(); }
  });

  it('preserves QueryCatalog opt-in through the admitted registered partition inventory', async () => {
    const store = new OxigraphStore();
    const catalogGraph = `${ROOT}/meta/_working_memory/0xabc/1`;
    try {
      await store.insert([
        { subject: `${ROOT}/meta`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: `${ROOT}/meta`, predicate: 'http://schema.org/name', object: '"meta"', graph: `${ROOT}/_meta` },
        { subject: 'urn:assertion:catalog', predicate: 'http://dkg.io/ontology/assertionGraph', object: catalogGraph, graph: `${ROOT}/_meta` },
        { subject: 'urn:catalog', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/profile/QueryCatalog', graph: catalogGraph },
        { subject: 'urn:catalog', predicate: 'http://schema.org/name', object: '"queries"', graph: catalogGraph },
      ]);
      const engine = new DKGQueryEngine(store);
      const reader: ContextGraphReader = {
        listGraphs: () => engine.listContextGraphQueryPartitions(CG),
        query: async (sparql: string) => ({ type: 'bindings' as const, bindings: (await engine.query(sparql, {
          contextGraphId: CG, includeContextGraphPartitions: true, exactContextGraphPartitions: true,
        })).bindings }),
      };
      expect((await readMemoryLayers(reader, CG)).layers.wm.bindings).toEqual([]);
      const included = await readMemoryLayers(reader, CG, { includeQueryCatalog: true });
      expect(included.layers.wm.ok).toBe(true);
      expect(included.layers.wm.bindings).toHaveLength(2);
      expect(included.layers.wm.bindings.every(row => row.s === 'urn:catalog')).toBe(true);
    } finally { await store.close(); }
  });

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
    const reader = mockReader(graphs, async (sparql, options) => {
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

    const snapshot = await readMemoryLayers(reader, CG);

    expect(reader.listGraphs).toHaveBeenCalledTimes(1);
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
    const reader = mockReader([
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

    const snapshot = await readMemoryLayers(reader, CG);

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
    const reader = mockReader(graphs, async (sparql) => {
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

    const stats = await readContextGraphNamedGraphStats(reader, CG);

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

      const snapshot = await readMemoryLayers(oxigraphReader(store), CG);
      expect(snapshot.layers.wm.bindings.map((row) => row.s)).toEqual(['urn:wm']);
      expect(snapshot.layers.swm.bindings.map((row) => row.p)).toEqual(['urn:type']);
      expect(snapshot.layers.vm.bindings.map((row) => row.s)).toEqual(['urn:vm']);

      const stats = await readContextGraphNamedGraphStats(oxigraphReader(store), CG);
      expect(stats.find((row) => row.graph === `${ROOT}/notes/_shared_memory`))
        .toMatchObject({ entityCount: 1, tripleCount: 2 });
    } finally {
      await store.close();
    }
  });

  it.each([-1, 0, 1])('bounds SWM rows across batches at the actual limit %+i', async delta => {
    const limit = MEMORY_LAYER_LIMITS.swm;
    const graphs = Array.from({ length: EXACT_GRAPH_QUERY_BATCH_SIZE * 2 + 1 }, (_, i) => `${ROOT}/notes/_shared_memory/ka-${i}`);
    const queries: string[] = [];
    const reader: ContextGraphReader = {
      listGraphs: async () => graphs,
      query: async (sparql, _options, policy) => {
        expect(policy.includeSharedMemory).toBe(true);
        queries.push(sparql);
        const rows = queries.length === 1 ? limit - 1 : queries.length === 2 ? delta + 1 : 0;
        return { type: 'bindings', bindings: Array.from({ length: rows }, (_, i) => ({
          s: `urn:entity:${queries.length}:${i}`, p: 'urn:p', o: 'urn:o', g: exactGraphs(sparql)[0],
        })) };
      },
    };
    const snapshot = await readMemoryLayers(reader, CG);
    expect(snapshot.layers.swm.bindings).toHaveLength(Math.min(limit, limit + delta));
    expect(snapshot.layers.swm.truncated).toBe(delta >= 0);
    expect(snapshot.layers.swm.ok).toBe(true);
    expect(queries).toHaveLength(delta < 0 ? 3 : 2);
    expect(queries[1]).toContain('LIMIT 2');
  });
});
