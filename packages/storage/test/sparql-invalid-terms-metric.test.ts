import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { rebuildMetrics } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/index.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

interface CounterPoint { metric: string; value: number; attributes?: Record<string, unknown> }

/**
 * Capture counter points by published instrument NAME through a stand-in meter
 * provider, as packages/core/test/backpressure-observability.test.ts does. With
 * no provider every instrument is one shared no-op, so only a bound provider
 * pins the name a dashboard queries.
 */
async function captureCounters(run: () => Promise<void>): Promise<CounterPoint[]> {
  const points: CounterPoint[] = [];
  const instrument = (metric: string) => ({
    add: (value: number, attributes?: Record<string, unknown>) => {
      points.push({ metric, value, attributes });
    },
    record: () => {},
  });
  const meter = {
    createCounter: instrument,
    createGauge: instrument,
    createHistogram: instrument,
    createUpDownCounter: instrument,
  };
  otelMetrics.setGlobalMeterProvider({ getMeter: () => meter } as never);
  rebuildMetrics();
  try {
    await run();
  } finally {
    otelMetrics.disable();
    rebuildMetrics();
  }
  return points;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dkg.store.sparql_invalid_terms_total', () => {
  it('publishes an invalid term under the documented name and labels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new OxigraphStore();
    const points = await captureCounters(async () => {
      await store.dropGraph('urn:graph{x}');
    });
    await store.close();

    expect(points.filter((point) => point.metric === 'dkg.store.sparql_invalid_terms_total')).toEqual([{
      metric: 'dkg.store.sparql_invalid_terms_total',
      value: 1,
      attributes: {
        adapter: 'oxigraph',
        operation: 'dropGraph',
        position: 'graph',
        kind: 'iri',
        enforcement: 'observe',
      },
    }]);
    expect(points.filter((point) => point.attributes && 'enforcement' in point.attributes)).toHaveLength(1);
  });

  it('publishes a relative datatype under kind relative-iri and position datatype', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new OxigraphStore();
    const points = await captureCounters(async () => {
      // The N-Quads load rejects it, but only after the insert has counted it.
      await expect(store.insert([{
        subject: 'http://ex.org/s',
        predicate: 'http://ex.org/p',
        object: '"42"^^<integer>',
        graph: 'http://ex.org/g',
      }])).rejects.toThrow(/No scheme found in an absolute IRI/);
    });
    await store.close();

    expect(points.filter((point) => point.metric === 'dkg.store.sparql_invalid_terms_total')).toEqual([{
      metric: 'dkg.store.sparql_invalid_terms_total',
      value: 1,
      attributes: {
        adapter: 'oxigraph',
        operation: 'insert',
        position: 'datatype',
        kind: 'relative-iri',
        enforcement: 'observe',
      },
    }]);
  });

  it('labels every embedded Oxigraph call site', async () => {
    const observed = observeInvalidSparqlTerms();
    const store = new OxigraphStore();
    let counted: typeof observed.counted;
    try {
      await store.dropGraph('urn:graph^x');
      await store.deleteBySubjectPrefix('urn:graph^x', 'urn:bad prefix');
      counted = observed.counted;
    } finally {
      observed.restore();
      await store.close();
    }
    const point = (operation: string, position: string) => ({
      value: 1, adapter: 'oxigraph', operation, position, kind: 'iri', enforcement: 'observe',
    });
    expect(counted).toEqual([
      point('dropGraph', 'graph'),
      point('deleteBySubjectPrefix', 'graph'),
      point('deleteBySubjectPrefix', 'subject-prefix'),
    ]);
  });
});
