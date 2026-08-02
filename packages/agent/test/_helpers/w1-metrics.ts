// SPDX-License-Identifier: Apache-2.0
/**
 * In-memory collector for the W1 instruments (I1–I6).
 *
 * Reads the REAL exported points rather than a spy on the record helpers, so a
 * test cannot pass while the instrument name, the attribute keys, or the
 * clamping are wrong. Every assertion in the W1 suites goes through here.
 */
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { rebuildMetrics } from '@origintrail-official/dkg-core';

export const I1 = 'dkg.sync.attempt.total';
export const I2 = 'dkg.sync.attempt.request_bytes';
export const I3 = 'dkg.sync.attempt.response_bytes';
export const I4 = 'dkg.sync.operation.duration_ms';
export const I5 = 'dkg.sync.operation.rejected_total';
export const I6 = 'dkg.sync.singleflight.joins_total';

export interface CounterPoint {
  attributes: Record<string, unknown>;
  value: number;
}

export interface HistogramPoint {
  attributes: Record<string, unknown>;
  count: number;
  sum: number;
  max: number;
}

export class W1MetricsHarness {
  private provider: MeterProvider | null = null;
  private exporter: InMemoryMetricExporter | null = null;

  install(): void {
    this.exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    this.provider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({
        exporter: this.exporter,
        // Long enough that only the explicit flushes below produce a batch, so
        // a background tick can never add a second CUMULATIVE copy.
        exportIntervalMillis: 600_000,
      })],
    });
    metrics.setGlobalMeterProvider(this.provider);
    rebuildMetrics();
  }

  /**
   * Reset BEFORE flushing, every time.
   *
   * The exporter appends each batch to one array while the temporality is
   * CUMULATIVE, so a test that queries twice would otherwise read the union of
   * two full snapshots and see every count doubled — and a helper that flushed
   * only once would answer a later query from a STALE snapshot, silently
   * reporting zero for work done after the first read. Both failure modes are
   * "the assertion cannot fail for the right reason", so neither is acceptable.
   */
  private async rawPoints(name: string): Promise<Array<{ attributes: Record<string, unknown>; value: unknown }>> {
    this.exporter!.reset();
    await this.provider!.forceFlush();
    const out: Array<{ attributes: Record<string, unknown>; value: unknown }> = [];
    for (const resourceMetrics of this.exporter!.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name !== name) continue;
          for (const dataPoint of metric.dataPoints) {
            out.push({
              attributes: dataPoint.attributes as Record<string, unknown>,
              value: dataPoint.value,
            });
          }
        }
      }
    }
    return out;
  }

  async counter(name: string): Promise<CounterPoint[]> {
    const points = await this.rawPoints(name);
    return points.map((point) => ({ attributes: point.attributes, value: point.value as number }));
  }

  async histogram(name: string): Promise<HistogramPoint[]> {
    const points = await this.rawPoints(name);
    return points.map((point) => {
      const value = point.value as { count: number; sum?: number; max?: number };
      return {
        attributes: point.attributes,
        count: value.count,
        sum: value.sum ?? 0,
        max: value.max ?? 0,
      };
    });
  }

  /** Total across every attribute combination — the "how many points" question. */
  async total(name: string): Promise<number> {
    const points = await this.counter(name);
    return points.reduce((sum, point) => sum + point.value, 0);
  }

  /** Points whose attributes include every entry of `match`. */
  async matching(name: string, match: Record<string, unknown>): Promise<CounterPoint[]> {
    const points = await this.counter(name);
    return points.filter((point) =>
      Object.entries(match).every(([key, value]) => point.attributes[key] === value));
  }

  /** The distinct attribute-key set of an instrument — the cardinality contract. */
  async attributeKeys(name: string): Promise<string[]> {
    const points = await this.rawPoints(name);
    return [...new Set(points.flatMap((point) => Object.keys(point.attributes)))].sort();
  }

  async dispose(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown().catch(() => {});
      this.provider = null;
    }
    this.exporter = null;
    metrics.disable();
    rebuildMetrics();
  }
}
