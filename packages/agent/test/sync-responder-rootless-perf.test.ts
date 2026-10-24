import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  SparqlHttpStore,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  DKG_NS,
  linesFromNquads,
  registerTestSyncHandler,
  type CapturedSyncHandler,
} from './_helpers/sync-responder.js';

const describePerf = process.env.DKG_SYNC_RESPONDER_ROOTLESS_PERF === '1'
  ? describe
  : describe.skip;

const RUN_ID = (
  process.env.DKG_SYNC_RESPONDER_ROOTLESS_PERF_RUN_ID?.trim()
  || `${process.pid}-${Date.now().toString(36)}`
).replace(/[^A-Za-z0-9_-]/g, '-');
const CG_ID = `rootless-perf-${RUN_ID}`;
const AGENT_ADDRESS = '0x00000000000000000000000000000000000000ab';
const KA_COUNT = 50;
const ROWS_PER_KA = 1_000;
const TOTAL_ROWS = KA_COUNT * ROWS_PER_KA;
const PAGE_SIZE = 500;
const SESSION_ID = `rootless-perf-session-${RUN_ID}`;
const DEFAULT_SYNC_BUDGET_MS = 30_000;

function syncBudgetMs(): number {
  const configured = Number(process.env.DKG_SYNC_RESPONDER_ROOTLESS_PERF_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SYNC_BUDGET_MS;
}

function createPerfStore(): TripleStore {
  const queryEndpoint = process.env.DKG_SYNC_RESPONDER_PERF_QUERY_ENDPOINT?.trim();
  if (!queryEndpoint) {
    throw new Error(
      'DKG_SYNC_RESPONDER_ROOTLESS_PERF=1 requires ' +
      'DKG_SYNC_RESPONDER_PERF_QUERY_ENDPOINT pointing at a SPARQL 1.1 query endpoint',
    );
  }
  const timeout = Number(process.env.DKG_SYNC_RESPONDER_PERF_TIMEOUT_MS ?? 180_000);
  return new SparqlHttpStore({
    queryEndpoint,
    updateEndpoint: process.env.DKG_SYNC_RESPONDER_PERF_UPDATE_ENDPOINT?.trim()
      || queryEndpoint.replace(/\/query\/?$/, '/update'),
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000,
    managedByDkg: true,
  });
}

function graphForKa(index: number): string {
  return knowledgeAssetLayerGraphUri(
    CG_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(ualForKa(index), 1),
  );
}

function ualForKa(index: number): string {
  return `did:dkg:base:8453/${AGENT_ADDRESS}/${index + 1}`;
}

function manifestQuadsForKa(index: number, graph: string): Quad[] {
  const ual = ualForKa(index);
  const meta = contextGraphMetaGraphUri(CG_ID);
  const integer = (value: number) =>
    `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
  return [
    { graph: meta, subject: ual, predicate: `${DKG_NS}contentScopeVersion`, object: integer(GRAPH_KA_CONTENT_SCOPE_VERSION) },
    { graph: meta, subject: ual, predicate: `${DKG_NS}kaUal`, object: ual },
    { graph: meta, subject: ual, predicate: `${DKG_NS}assertionVersion`, object: integer(1) },
    { graph: meta, subject: ual, predicate: `${DKG_NS}assertionGraph`, object: graph },
    { graph: meta, subject: ual, predicate: `${DKG_NS}contextGraph`, object: contextGraphDataGraphUri(CG_ID) },
    { graph: meta, subject: ual, predicate: `${DKG_NS}publicTripleCount`, object: integer(ROWS_PER_KA) },
    { graph: meta, subject: ual, predicate: `${DKG_NS}privateTripleCount`, object: integer(0) },
    { graph: meta, subject: ual, predicate: `${DKG_NS}status`, object: '"confirmed"' },
  ];
}

describePerf('rootless exact-graph sync responder perf guard', () => {
  let store: TripleStore;
  let cap: CapturedSyncHandler;
  const seededGraphs: string[] = [];
  let exactGraphCounts = 0;
  let exactGraphSnapshotQueries = 0;
  let exactGraphPageQueries = 0;
  let largestExactGraphOffset = 0;

  beforeAll(async () => {
    store = createPerfStore();
    const originalCountQuads = store.countQuads.bind(store);
    store.countQuads = async (graph, options) => {
      if (graph?.includes('/_verifiable_memory/')) exactGraphCounts += 1;
      return originalCountQuads(graph, options);
    };

    const originalQuery = store.query.bind(store);
    store.query = async (sparql, options) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (
        normalized.startsWith('SELECT ?g ?s ?p ?o WHERE {')
        && normalized.includes('VALUES ?g')
        && normalized.includes('ORDER BY ?g ?s ?p ?o')
      ) {
        throw new Error(`rootless sync issued a global cross-graph page query: ${normalized}`);
      }
      if (
        normalized.startsWith('SELECT ?s ?p ?o WHERE {')
        && normalized.includes('/_verifiable_memory/')
        && !normalized.includes('ORDER BY')
        && !normalized.includes('OFFSET')
      ) {
        exactGraphSnapshotQueries += 1;
      }
      if (
        normalized.startsWith('SELECT ?s ?p ?o WHERE {')
        && normalized.includes('/_verifiable_memory/')
        && normalized.includes('ORDER BY ?s ?p ?o')
      ) {
        exactGraphPageQueries += 1;
        const offset = Number(/OFFSET (\d+)/.exec(normalized)?.[1] ?? 0);
        largestExactGraphOffset = Math.max(largestExactGraphOffset, offset);
      }
      return originalQuery(sparql, options);
    };

    let batch: Quad[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await store.insert(batch);
      batch = [];
    };
    for (let ka = 0; ka < KA_COUNT; ka += 1) {
      const graph = graphForKa(ka);
      seededGraphs.push(graph);
      batch.push(...manifestQuadsForKa(ka, graph));
      for (let row = 0; row < ROWS_PER_KA; row += 1) {
        const suffix = row.toString().padStart(4, '0');
        batch.push({
          graph,
          subject: `urn:rootless:perf:${ka.toString().padStart(2, '0')}:${suffix}`,
          predicate: `${DKG_NS}label`,
          object: `"rootless-${ka}-${suffix}"`,
        });
        if (batch.length >= 10_000) await flush();
      }
    }
    seededGraphs.push(contextGraphMetaGraphUri(CG_ID));
    for (let index = 0; index < 100; index += 1) {
      const graph = `did:dkg:context-graph:rootless-perf-decoy-${RUN_ID}-${index}`;
      seededGraphs.push(graph);
      batch.push({
        graph,
        subject: `urn:rootless:decoy:${index}`,
        predicate: `${DKG_NS}label`,
        object: '"decoy"',
      });
    }
    await flush();

    cap = registerTestSyncHandler(store, { syncPageSize: PAGE_SIZE });
  }, 180_000);

  afterAll(async () => {
    if (!store) return;
    for (const graph of seededGraphs) {
      await store.dropGraph(graph).catch(() => undefined);
    }
    await store.close();
  }, 60_000);

  it('syncs 50 manifest-backed immutable 1,000-triple KAs without counts, sorting, or offsets', async () => {
    const lines = new Set<string>();
    const startedAt = performance.now();
    for (let offset = 0; offset < TOTAL_ROWS; offset += PAGE_SIZE) {
      const page = await cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        offset,
        limit: PAGE_SIZE,
        syncSessionId: SESSION_ID,
      });
      const pageLines = linesFromNquads(page);
      expect(pageLines, `offset ${offset}`).toHaveLength(PAGE_SIZE);
      for (const line of pageLines) lines.add(line);
    }
    const elapsedMs = performance.now() - startedAt;

    expect(lines.size).toBe(TOTAL_ROWS);
    expect(exactGraphCounts).toBe(0);
    expect(exactGraphSnapshotQueries).toBe(KA_COUNT);
    expect(exactGraphPageQueries).toBe(0);
    expect(largestExactGraphOffset).toBe(0);
    expect(elapsedMs, `rootless exact-graph sync took ${elapsedMs.toFixed(1)}ms`)
      .toBeLessThan(syncBudgetMs());
  }, 120_000);
});
