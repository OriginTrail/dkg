import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLayer } from '@origintrail-official/dkg-core';
import { SparqlHttpStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  DKG_NS,
  linesFromNquads,
  registerTestSyncHandler,
  workspaceOpQuads,
  type CapturedSyncHandler,
} from './_helpers/sync-responder.js';

function perfBudget(name: string, fallbackMs: number): number {
  const value = Number(process.env[`DKG_SYNC_RESPONDER_PERF_${name}_BUDGET_MS`]);
  return Number.isFinite(value) && value > 0 ? value : fallbackMs;
}

const PERF_RUN_ID = (process.env.DKG_SYNC_RESPONDER_PERF_RUN_ID?.trim() || `${process.pid}-${Date.now().toString(36)}`)
  .replace(/[^A-Za-z0-9_-]/g, '-');
const CG_ID = `perf-cg-${PERF_RUN_ID}`;
const CG_PREFIX = `did:dkg:context-graph:${CG_ID}`;
const DATA_GRAPH = CG_PREFIX;
const META_GRAPH = `${CG_PREFIX}/_meta`;
const SWM_GRAPH = `${CG_PREFIX}/_shared_memory`;
const SWM_META_GRAPH = `${CG_PREFIX}/_shared_memory_meta`;
const DURABLE_SESSION_ID = `perf-durable-data-${PERF_RUN_ID}`;
const PAGE_SIZE = 500;
const DATA_ROWS = 150_000;
const META_LIFECYCLES = 1_000;
const SWM_OPS = 120;
const SWM_ROWS_PER_OP = 50;
const DURABLE_COLD_BUDGET_MS = perfBudget('DURABLE_COLD', 45_000);
const DURABLE_WARM_BUDGET_MS = perfBudget('DURABLE_WARM', 500);
const DURABLE_META_BUDGET_MS = perfBudget('DURABLE_META', 500);
const SWM_DATA_BUDGET_MS = perfBudget('SWM_DATA', 500);
const SWM_META_BUDGET_MS = perfBudget('SWM_META', 300);
const describePerf = process.env.DKG_SYNC_RESPONDER_PERF === '1' ? describe : describe.skip;

function createPerfStore(): TripleStore {
  const queryEndpoint = process.env.DKG_SYNC_RESPONDER_PERF_QUERY_ENDPOINT?.trim();
  if (!queryEndpoint) {
    throw new Error(
      'DKG_SYNC_RESPONDER_PERF=1 requires DKG_SYNC_RESPONDER_PERF_QUERY_ENDPOINT ' +
      'pointing at an oxigraph-server /query endpoint. Set ' +
      'DKG_SYNC_RESPONDER_PERF_UPDATE_ENDPOINT as well when /update differs.',
    );
  }
  const timeout = Number(process.env.DKG_SYNC_RESPONDER_PERF_TIMEOUT_MS ?? 180_000);
  return new SparqlHttpStore({
    queryEndpoint,
    updateEndpoint: process.env.DKG_SYNC_RESPONDER_PERF_UPDATE_ENDPOINT?.trim() || queryEndpoint.replace(/\/query\/?$/, '/update'),
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 180_000,
    managedByDkg: true,
  });
}

function q(graph: string, subject: string, predicate: string, object: string): Quad {
  return { graph, subject, predicate, object };
}

async function expectWithinBudget(
  label: string,
  budgetMs: number,
  action: () => Promise<string>,
): Promise<string> {
  const startedAt = performance.now();
  const out = await action();
  const elapsed = performance.now() - startedAt;
  expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(budgetMs);
  return out;
}

describePerf('sync responder perf guard', () => {
  let store: TripleStore | null = null;
  let cap: CapturedSyncHandler;

  beforeAll(async () => {
    store = createPerfStore();
    let batch: Quad[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await store!.insert(batch);
      batch = [];
    };
    const push = async (quad: Quad) => {
      batch.push(quad);
      if (batch.length >= 10_000) await flush();
    };

    for (let i = 0; i < DATA_ROWS; i++) {
      const suffix = i.toString().padStart(6, '0');
      await push(q(DATA_GRAPH, `urn:perf:data:${suffix}`, `${DKG_NS}label`, `urn:perf:data-value:${suffix}`));
    }

    for (let i = 0; i < 150; i++) {
      await push(q(`did:dkg:context-graph:perf-decoy-${i}`, `urn:perf:decoy:${i}`, `${DKG_NS}label`, '"decoy"'));
    }

    await push(q(META_GRAPH, CG_PREFIX, `${DKG_NS}createdAt`, '"2026-06-01T00:00:00Z"'));
    for (let i = 0; i < META_LIFECYCLES; i++) {
      const suffix = i.toString().padStart(4, '0');
      const lifecycle = `urn:perf:lifecycle:${suffix}`;
      const assertion = `${CG_PREFIX}/assertion/perf/a${suffix}`;
      const event = `urn:perf:event:${suffix}`;
      await push(q(META_GRAPH, lifecycle, `${DKG_NS}memoryLayer`, `"${MemoryLayer.VerifiableMemory}"`));
      await push(q(META_GRAPH, lifecycle, `${DKG_NS}assertionGraph`, assertion));
      await push(q(META_GRAPH, lifecycle, `${DKG_NS}assertionName`, `"a${suffix}"`));
      await push(q(META_GRAPH, assertion, `${DKG_NS}merkleRoot`, `"root-${suffix}"`));
      await push(q(META_GRAPH, event, 'http://www.w3.org/ns/prov#generated', lifecycle));
    }

    const fresh = new Date(Date.now() - 1_000).toISOString();
    for (let op = 0; op < SWM_OPS; op++) {
      const root = `urn:perf:swm:${op.toString().padStart(4, '0')}`;
      for (let row = 0; row < SWM_ROWS_PER_OP; row++) {
        const subject = row === 0 ? root : `${root}/.well-known/genid/${row.toString().padStart(3, '0')}`;
        await push(q(SWM_GRAPH, subject, `${DKG_NS}label`, `"swm-${op}-${row}"`));
      }
      for (const quad of workspaceOpQuads(CG_ID, `perf-${op}`, root, SWM_META_GRAPH, fresh)) {
        await push(quad);
      }
    }

    await push(q(META_GRAPH, `${CG_PREFIX}/wm`, `${DKG_NS}memoryLayer`, `"${MemoryLayer.WorkingMemory}"`));
    await push(q(META_GRAPH, `${CG_PREFIX}/wm`, `${DKG_NS}assertionGraph`, `${CG_PREFIX}/assertion/perf/wm`));
    await push(q(`${CG_PREFIX}/assertion/perf/wm`, 'urn:perf:wm', `${DKG_NS}label`, '"wm-noise"'));
    await push(q(`${CG_PREFIX}/_private/noise`, 'urn:perf:private', `${DKG_NS}label`, '"private-noise"'));
    await flush();

    cap = registerTestSyncHandler(store, {
      syncPageSize: PAGE_SIZE,
      sharedMemoryTtlMs: 60 * 60 * 1000,
    });
  }, 300_000);

  afterAll(async () => {
    await store?.close();
  });

  it('builds durable-data snapshot once and serves warm pages under budget', async () => {
    const cold = await expectWithinBudget('durable-data cold snapshot', DURABLE_COLD_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        offset: 0,
        limit: PAGE_SIZE,
        syncSessionId: DURABLE_SESSION_ID,
      }),
    );
    expect(linesFromNquads(cold)).toHaveLength(PAGE_SIZE);

    const warmRetry = await expectWithinBudget('durable-data warm offset 0 retry', DURABLE_WARM_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        offset: 0,
        limit: PAGE_SIZE,
        syncSessionId: DURABLE_SESSION_ID,
      }),
    );
    expect(warmRetry).toBe(cold);

    const deepest = await expectWithinBudget('durable-data warm deepest page', DURABLE_WARM_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'data',
        offset: DATA_ROWS - PAGE_SIZE,
        limit: PAGE_SIZE,
        syncSessionId: DURABLE_SESSION_ID,
      }),
    );
    expect(linesFromNquads(deepest)).toHaveLength(PAGE_SIZE);
    expect(deepest).toContain('urn:perf:data-value:149999');
  }, 120_000);

  it('serves durable-meta offset 0 and deepest page under budget', async () => {
    const first = await expectWithinBudget('durable-meta offset 0', DURABLE_META_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'meta',
        offset: 0,
        limit: PAGE_SIZE,
      }),
    );
    expect(linesFromNquads(first)).toHaveLength(PAGE_SIZE);

    const deepest = await expectWithinBudget('durable-meta deepest page', DURABLE_META_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: false,
        phase: 'meta',
        offset: 4_500,
        limit: PAGE_SIZE,
      }),
    );
    expect(linesFromNquads(deepest)).toHaveLength(PAGE_SIZE);
  }, 60_000);

  it('serves SWM TTL data and meta pages under budget', async () => {
    const dataFirst = await expectWithinBudget('SWM data offset 0', SWM_DATA_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: true,
        phase: 'data',
        offset: 0,
        limit: PAGE_SIZE,
      }),
    );
    expect(linesFromNquads(dataFirst)).toHaveLength(PAGE_SIZE);

    const dataDeep = await expectWithinBudget('SWM data deepest page', SWM_DATA_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: true,
        phase: 'data',
        offset: SWM_OPS * SWM_ROWS_PER_OP - PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    );
    expect(linesFromNquads(dataDeep)).toHaveLength(PAGE_SIZE);

    const metaFirst = await expectWithinBudget('SWM meta offset 0', SWM_META_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: true,
        phase: 'meta',
        offset: 0,
        limit: PAGE_SIZE,
      }),
    );
    expect(linesFromNquads(metaFirst)).toHaveLength(PAGE_SIZE);

    const metaDeep = await expectWithinBudget('SWM meta deepest page', SWM_META_BUDGET_MS, () =>
      cap.invoke({
        contextGraphId: CG_ID,
        includeSharedMemory: true,
        phase: 'meta',
        offset: PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    );
    expect(linesFromNquads(metaDeep)).toHaveLength(SWM_OPS * 5 - PAGE_SIZE);
  }, 60_000);
});
