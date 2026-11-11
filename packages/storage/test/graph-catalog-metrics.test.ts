import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { Logger, rebuildMetrics, type LogRecord } from '@origintrail-official/dkg-core';
import {
  GraphSetIndexStore,
  OxigraphStore,
  QUERY_CATALOG_LIMIT_NAME,
  STORE_GRAPH_CATALOG_LIMIT_NAME,
  STORE_GRAPH_CATALOG_MAX_BYTES_ENV,
  StoreInternalLimitError,
  StoreOperationTimeoutError,
  StoreSchedulerBusyError,
  recordStoreInternalLimit,
} from '../src/index.js';
import { createGraphCatalogSizeRecorder, timeGraphCatalogRefresh } from '../src/graph-catalog-metrics.js';
import { measureGraphCatalogBytes } from '../src/graph-catalog-response-limit.js';
import { deserializeWorkerErrorV1, serializeWorkerErrorV1 } from '../src/worker-error-protocol.js';
import { CountingStore, q } from './graph-set-index-store-harness.js';

interface Recorded { metric: string; value: number; attributes: Record<string, unknown> }

/** Capture instruments by name through a stand-in meter provider. */
async function captureMetrics(run: () => Promise<void> | void): Promise<Recorded[]> {
  const recorded: Recorded[] = [];
  const instrument = (metric: string) => {
    const note = (value: number, attributes?: Record<string, unknown>) => {
      recorded.push({ metric, value, attributes: attributes ?? {} });
    };
    return { add: note, record: note };
  };
  const meter = { createGauge: instrument, createCounter: instrument, createHistogram: instrument, createUpDownCounter: instrument };
  otelMetrics.setGlobalMeterProvider({ getMeter: () => meter } as never);
  rebuildMetrics();
  try {
    await run();
    return recorded;
  } finally {
    otelMetrics.disable();
    rebuildMetrics();
  }
}

const named = (recorded: Recorded[], metric: string) => recorded.filter(entry => entry.metric === metric);
const CG = 'did:dkg:context-graph:';

afterEach(() => vi.unstubAllEnvs());

describe('graph catalog metrics', () => {
  it('records the size and scan time of a published catalog without a context-graph label', async () => {
    const graphs = [`${CG}a/1`, `${CG}b/2`];
    const inner = new OxigraphStore();
    await inner.insert(graphs.map(graph => q(graph)));
    const store = new GraphSetIndexStore(inner);
    try {
      const recorded = await captureMetrics(async () => {
        expect(await store.listGraphsByPrefix(`${CG}a/`)).toEqual([`${CG}a/1`]);
      });
      const bytes = measureGraphCatalogBytes(graphs);
      expect(named(recorded, 'dkg.store.graph_catalog_graphs')).toEqual([{ metric: 'dkg.store.graph_catalog_graphs', value: 2, attributes: {} }]);
      expect(named(recorded, 'dkg.store.graph_catalog_bytes')).toEqual([{ metric: 'dkg.store.graph_catalog_bytes', value: bytes, attributes: {} }]);
      expect(named(recorded, 'dkg.store.graphs_total')).toEqual([{ metric: 'dkg.store.graphs_total', value: 2, attributes: {} }]);
      const [scan] = named(recorded, 'dkg.store.graph_catalog_refresh_ms');
      expect(scan).toMatchObject({ attributes: { kind: 'seed', outcome: 'ok' } });
      expect(scan!.value).toBeGreaterThanOrEqual(0);
      expect(named(recorded, 'dkg.store.graph_catalog_refresh_failures_total')).toEqual([]);
      for (const entry of recorded.filter(({ metric }) => metric.startsWith('dkg.store.graph'))) {
        expect(JSON.stringify(entry.attributes)).not.toContain(CG);
      }
    } finally { await store.close(); }
  });

  it('counts a warm scan over the ceiling as a failure and as a node-side limit, and fails the read closed', async () => {
    let now = 1_000;
    const inner = new OxigraphStore();
    await inner.insert([q(`${CG}small/a`)]);
    const store = new GraphSetIndexStore(new CountingStore(inner), { revalidateMs: 100, revalidate: 'blocking', now: () => now });
    try {
      await store.listGraphsByPrefix(`${CG}small/`);
      vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, String(measureGraphCatalogBytes([`${CG}small/a`])));
      await inner.insert([q(`${CG}${'large'.repeat(30)}`)]);
      now += 100;
      const recorded = await captureMetrics(async () => {
        await expect(store.listGraphsByPrefix(`${CG}small/`)).rejects.toMatchObject({ code: 'STORE_INTERNAL_LIMIT' });
      });
      expect(named(recorded, 'dkg.store.graph_catalog_refresh_failures_total')).toEqual([{
        metric: 'dkg.store.graph_catalog_refresh_failures_total', value: 1,
        attributes: { kind: 'revalidate', reason: 'internal_limit' },
      }]);
      expect(named(recorded, 'dkg.store.graph_catalog_refresh_ms')).toMatchObject([{ attributes: { kind: 'revalidate', outcome: 'error' } }]);
      expect(named(recorded, 'dkg.query.internal_limit_total')).toEqual([{
        metric: 'dkg.query.internal_limit_total', value: 1, attributes: { limit: STORE_GRAPH_CATALOG_LIMIT_NAME },
      }]);
    } finally { await store.close(); }
  });

  it('labels a failed scan with a bounded reason and kind', async () => {
    const failures: Array<[unknown, string]> = [
      [new StoreInternalLimitError(STORE_GRAPH_CATALOG_LIMIT_NAME, 1, 2), 'internal_limit'],
      [new StoreOperationTimeoutError({ backend: 'blazegraph', operation: 'listGraphs', timeoutMs: 1 }), 'timeout'],
      [new StoreSchedulerBusyError('queue_full', 'normal', 'graph-set-index'), 'busy'],
      [new DOMException('stopped', 'AbortError'), 'aborted'],
      [new Error('backend detail that must not become a label'), 'error'],
    ];
    const recorded = await captureMetrics(async () => {
      for (const [failure] of failures) {
        await expect(timeGraphCatalogRefresh('rebuild', async () => { throw failure; })).rejects.toBe(failure);
      }
    });
    expect(named(recorded, 'dkg.store.graph_catalog_refresh_failures_total').map(entry => entry.attributes))
      .toEqual(failures.map(([, reason]) => ({ kind: 'rebuild', reason })));
  });

  it('counts each node-side limit hit once, including one raised behind the worker boundary', async () => {
    const error = new StoreInternalLimitError(STORE_GRAPH_CATALOG_LIMIT_NAME, 1, 2);
    const envelope = serializeWorkerErrorV1(error);
    const recorded = await captureMetrics(() => {
      expect(deserializeWorkerErrorV1(envelope)).toBeInstanceOf(StoreInternalLimitError);
      expect(deserializeWorkerErrorV1({ ...envelope, limitName: 'UNLISTED_LIMIT' } as never)).toBeInstanceOf(StoreInternalLimitError);
    });
    expect(named(recorded, 'dkg.query.internal_limit_total').map(entry => entry.attributes)).toEqual([
      { limit: STORE_GRAPH_CATALOG_LIMIT_NAME }, { limit: 'other' },
    ]);
  });

  it('labels a refusal by the query package\'s catalog bound with that bound\'s name', async () => {
    const recorded = await captureMetrics(() => { recordStoreInternalLimit(QUERY_CATALOG_LIMIT_NAME); });
    expect(named(recorded, 'dkg.query.internal_limit_total')).toEqual([{
      metric: 'dkg.query.internal_limit_total', value: 1, attributes: { limit: 'QUERY_CATALOG_MAX_RESPONSE_BYTES' },
    }]);
  });
});

describe('graph catalog size warnings', () => {
  it('warns at 50 % and at 80 % of the ceiling, once per level per hour', async () => {
    vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '1000');
    let now = 0;
    const warnings: string[] = [];
    const record = createGraphCatalogSizeRecorder({ now: () => now, warn: message => { warnings.push(message); } });
    record(null);
    record({ graphs: 1, bytes: 499 });
    expect(warnings).toEqual([]);
    record({ graphs: 2, bytes: 500 });
    record({ graphs: 2, bytes: 600 });
    expect(warnings).toEqual([
      'The graph catalog has reached 50% of its internal limit STORE_GRAPH_CATALOG_MAX_BYTES: 500 of 1000 bytes, 2 graphs. At the limit, catalog reads fail with STORE_INTERNAL_LIMIT; raise store.graphCatalog.maxBytes or DKG_STORE_GRAPH_CATALOG_MAX_BYTES before then.',
    ]);
    record({ graphs: 3, bytes: 800 });
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('reached 80%');
    now += 60 * 60_000 - 1;
    record({ graphs: 3, bytes: 800 });
    expect(warnings).toHaveLength(2);
    now += 1;
    record({ graphs: 3, bytes: 800 });
    expect(warnings).toHaveLength(3);
    record({ graphs: 1, bytes: 100 });
    record({ graphs: 2, bytes: 500 });
    expect(warnings).toHaveLength(4);
    expect(warnings[3]).toContain('reached 50%');
  });

  it('logs the warning through the node logger at WARN, from the graph-catalog module', () => {
    vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, '1000');
    const records: LogRecord[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    Logger.setSink(record => { records.push(record); });
    try {
      createGraphCatalogSizeRecorder()({ graphs: 3, bytes: 800 });
    } finally {
      Logger.setSink(null);
      stderr.mockRestore();
    }
    expect(records).toEqual([expect.objectContaining({
      level: 'warn', module: 'graph-catalog',
      message: expect.stringMatching(/^The graph catalog has reached 80% of its internal limit STORE_GRAPH_CATALOG_MAX_BYTES: 800 of 1000 bytes, 3 graphs\./),
    })]);
  });
});
