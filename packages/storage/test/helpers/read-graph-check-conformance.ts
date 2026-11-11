import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint } from '../../src/blazegraph-namespace-manager.js';
import { STORE_GRAPH_CATALOG_MAX_BYTES_ENV } from '../../src/graph-catalog-internal-limit.js';
import { checkReadGraph, type ReadGraphCheckResult } from '../../src/read-graph/check.js';
import { parseReadGraphStateRows, readGraphStateCompareAndSet, readGraphStateRowsQuery } from '../../src/read-graph/state.js';
import type { TripleStoreConfig } from '../../src/triple-store-composition.js';
import type { TripleStore } from '../../src/triple-store.js';
import { AGENT, layerFixture, layeredStore, q, readyRow, type LayerFixture } from './read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './read-graph-planning-store.js';

export interface Recorded { readonly metric: string; readonly value: number; readonly attributes: Record<string, unknown> }

/** Capture instruments by name through a stand-in meter provider. */
export async function captureMetrics<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly recorded: Recorded[] }> {
  const recorded: Recorded[] = [];
  const instrument = (metric: string) => {
    const note = (value: number, attributes?: Record<string, unknown>) => { recorded.push({ metric, value, attributes: attributes ?? {} }); };
    return { add: note, record: note };
  };
  const meter = { createGauge: instrument, createCounter: instrument, createHistogram: instrument, createUpDownCounter: instrument };
  otelMetrics.setGlobalMeterProvider({ getMeter: () => meter } as never);
  rebuildMetrics();
  try {
    return { value: await run(), recorded };
  } finally {
    otelMetrics.disable();
    rebuildMetrics();
  }
}

export interface CheckedStore {
  readonly adapter: TripleStore;
  readonly store: TripleStore;
  readonly fixture: LayerFixture;
  readonly layer: Awaited<ReturnType<typeof layeredStore>>['layer'];
  readonly alerts: string[];
  readonly check: (readGraph: string, mode: 'sampled' | 'full') => Promise<ReadGraphCheckResult>;
  readonly stored: () => Promise<Record<string, string>>;
  readonly close: () => Promise<void>;
}

/** The read-graph checks on one engine, against the layer fixture of `./read-graph-layer-conformance.ts`. */
export function readGraphCheckConformance(backend: 'oxigraph' | 'blazegraph') {
  describe(`read-graph checks (${backend})`, () => {
    let manager: BlazegraphNamespaceManager | undefined;
    let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> | undefined;
    let shared: { readonly adapter: TripleStore; readonly config: TripleStoreConfig } | undefined;
    const run = `check${randomUUID().slice(0, 8)}`;
    let sequence = 0;

    /** A store with every read graph built, ready in the mirror and in the store. */
    const open = async (): Promise<CheckedStore> => {
      const fixture = layerFixture(`${run}-${sequence += 1}`);
      const { adapter, config } = shared ?? { adapter: new PlanningOxigraphStore(), config: { backend: 'oxigraph' } as TripleStoreConfig };
      const { layer, store } = await layeredStore(adapter, config, fixture);
      for (const readGraph of Object.values(fixture.readGraphs)) await adapter.update!(readGraphStateCompareAndSet(undefined, readyRow(readGraph)));
      const alerts: string[] = [];
      return {
        adapter, store, fixture, layer, alerts,
        // Every member graph is sampled: the fixture is small.
        check: (readGraph, mode) => checkReadGraph(store, readGraph, mode, { sampleGraphs: 100, sampleSubjects: 100, chunkGraphs: 2, alert: (message) => alerts.push(message) }),
        stored: async () => {
          const result = await adapter.query(readGraphStateRowsQuery());
          const rows = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows
            .filter((row) => row.readGraph.startsWith(fixture.root));
          return Object.fromEntries(rows.map((row) => [row.readGraph, `${row.state}@${row.generation}`]));
        },
        close: shared ? async () => {} : () => adapter.close(),
      };
    };

    beforeAll(async () => {
      if (backend !== 'blazegraph') return;
      if (!process.env.BLAZEGRAPH_TEST_URL) throw new Error('The live Blazegraph lane requires BLAZEGRAPH_TEST_URL');
      manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(process.env.BLAZEGRAPH_TEST_URL) });
      handles = await manager.acquireMany([`read-graph-check-${randomUUID()}`]);
      const url = handles[0]!.sparqlUrl;
      shared = { adapter: new BlazegraphStore(url, { timeout: 60_000 }), config: { backend: 'blazegraph', options: { url } } };
    }, 120_000);

    afterAll(async () => {
      await shared?.adapter.close();
      if (manager && handles) await manager.disposeAll(handles);
    }, 60_000);

    it('finds every read graph of a maintained store consistent, in both modes', async () => {
      const opened = await open();
      try {
        const { value, recorded } = await captureMetrics(async () => {
          const results: ReadGraphCheckResult[] = [];
          for (const readGraph of Object.values(opened.fixture.readGraphs)) {
            results.push(await opened.check(readGraph, 'sampled'), await opened.check(readGraph, 'full'));
          }
          return results;
        });
        expect(value.map((result) => result.outcome)).toEqual(Array(8).fill('consistent'));
        expect(opened.alerts).toEqual([]);
        const checks = recorded.filter((entry) => entry.metric === 'dkg.store.read_graph_checks_total');
        expect(checks).toHaveLength(8);
        expect(new Set(checks.map((entry) => entry.attributes.layer))).toEqual(new Set(['vm', 'swm', 'wm']));
        for (const entry of recorded) expect(JSON.stringify(entry.attributes)).not.toContain(opened.fixture.contextGraphId);
      } finally { await opened.close(); }
    });

    it('lists a full check\'s member graphs within its context graph, under a catalog ceiling the store\'s graph list exceeds', async () => {
      const opened = await open();
      try {
        const { wholeVm } = opened.fixture.readGraphs;
        // A context graph whose ID extends this one's, with graph names that alone are over the ceiling set below.
        const other = `${opened.fixture.root}-bulk`;
        await opened.adapter.insert(Array.from({ length: 200 }, (_, n) => q(`urn:s:bulk${n}`, '"bulk"', `${other}/_verifiable_memory/${AGENT}/${n}`)));
        vi.stubEnv(STORE_GRAPH_CATALOG_MAX_BYTES_ENV, String(8 * 1024));
        try {
          expect(await opened.check(wholeVm, 'full')).toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'consistent' });
        } finally {
          vi.unstubAllEnvs();
        }
      } finally { await opened.close(); }
    });

    it('finds a triple that a member graph holds and the read graph lacks, and marks the read graph dirty', async () => {
      const opened = await open();
      try {
        const { wholeVm, codeVm } = opened.fixture.readGraphs;
        // Written below the layer, so no read graph learns of it.
        await opened.adapter.insert([q('urn:s:new', '"new"', opened.fixture.graphs[1]!)]);
        const { value, recorded } = await captureMetrics(() => opened.check(wholeVm, 'full'));
        expect(value).toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'mismatch', direction: 'missing' });
        expect(opened.layer.runtime.mirror.get(wholeVm)).toMatchObject({ state: 'dirty', generation: 2 });
        expect((await opened.stored())[wholeVm]).toBe('dirty@2');
        expect(opened.alerts).toHaveLength(1);
        expect(opened.alerts[0]).toContain(`<${wholeVm}>`);
        expect(recorded.filter((entry) => entry.metric === 'dkg.store.read_graph_mismatches_total'))
          .toEqual([{ metric: 'dkg.store.read_graph_mismatches_total', value: 1, attributes: { mode: 'full', direction: 'missing', layer: 'vm' } }]);
        // A dirty read graph is not checked again; the others stay ready.
        expect((await opened.check(wholeVm, 'sampled')).outcome).toBe('skipped');
        expect((await opened.check(codeVm, 'full')).outcome).toBe('consistent');
      } finally { await opened.close(); }
    });

    it('finds the same with a sample that covers the member graph', async () => {
      const opened = await open();
      try {
        const { wholeSwm } = opened.fixture.readGraphs;
        await opened.adapter.insert([q('urn:s:new', '"new"', opened.fixture.graphs[6]!)]);
        expect(await opened.check(wholeSwm, 'sampled')).toEqual({ readGraph: wholeSwm, mode: 'sampled', outcome: 'mismatch', direction: 'missing' });
        expect((await opened.stored())[wholeSwm]).toBe('dirty@2');
      } finally { await opened.close(); }
    });

    it('finds a triple that the read graph holds and no member graph holds, by count and by sample', async () => {
      const opened = await open();
      try {
        const { wholeVm, agentWm } = opened.fixture.readGraphs;
        // Removed below the layer from the only graph that held it; urn:s:1 keeps another triple there.
        await opened.adapter.delete([q('urn:s:1', '"v1"', opened.fixture.graphs[1]!)]);
        expect(await opened.check(wholeVm, 'full')).toEqual({ readGraph: wholeVm, mode: 'full', outcome: 'mismatch', direction: 'unheld' });
        await opened.adapter.delete([q('urn:s:7', '"v7"', opened.fixture.graphs[7]!)]);
        expect(await opened.check(agentWm, 'sampled')).toEqual({ readGraph: agentWm, mode: 'sampled', outcome: 'mismatch', direction: 'unheld' });
        expect(await opened.stored()).toMatchObject({ [wholeVm]: 'dirty@2', [agentWm]: 'dirty@2' });
      } finally { await opened.close(); }
    });
  });
}
