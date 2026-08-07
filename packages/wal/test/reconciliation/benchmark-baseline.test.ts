import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Baseline {
  schema: string;
  executionModel: string;
  sizes: number[];
  repetitions: number;
  eachSideDifference: number;
  maximumTotalTimeRegressionRatio: number;
  results: Array<{
    setSize: number;
    differenceSize: number;
    inputMode: string;
    encoderSetupMs: number;
    decoderSetupMs: number;
    streamMs: number;
    totalMs: number;
    canonicalWireBytes: number;
    memory: { maxRssBytes: number };
  }>;
  summaries: Array<{ setSize: number; samples: number }>;
}

const baseline = JSON.parse(
  readFileSync(new URL('../../benchmarks/reconciliation-baseline.json', import.meta.url), 'utf8')
) as Baseline;

describe('tracked fixed-delta byte bound', () => {
  it('keeps fixed k and b within the RFC 50% reconciliation-byte growth bound', () => {
    expect(baseline.schema).toBe('dkg-wal-reconciliation-benchmark-v2');
    expect(baseline.executionModel).toBe('fresh-process-per-size');
    expect(baseline.repetitions).toBe(1);
    expect(baseline.eachSideDifference).toBe(16);
    expect(baseline.maximumTotalTimeRegressionRatio).toBe(1.5);
    expect(baseline.sizes).toEqual([10_000, 100_000, 1_000_000, 10_000_000]);
    expect(baseline.results.map((result) => result.setSize)).toEqual(baseline.sizes);
    expect(baseline.summaries.map(({ setSize, samples }) => ({ setSize, samples }))).toEqual(
      baseline.sizes.map((setSize) => ({ setSize, samples: 1 }))
    );
    expect(new Set(baseline.results.map((result) => result.differenceSize))).toEqual(new Set([32]));
    expect(new Set(baseline.results.map((result) => result.inputMode))).toEqual(new Set(['sorted-stream']));
    for (const result of baseline.results) {
      expect(result.encoderSetupMs).toBeGreaterThan(0);
      expect(result.decoderSetupMs).toBeGreaterThan(0);
      expect(result.streamMs).toBeGreaterThan(0);
      expect(result.totalMs).toBeGreaterThan(result.streamMs);
      expect(result.memory.maxRssBytes).toBeGreaterThan(0);
    }
    const tenThousand = baseline.results[0].canonicalWireBytes;
    const tenMillion = baseline.results[3].canonicalWireBytes;
    expect(tenMillion / tenThousand).toBeLessThanOrEqual(1.5);
  });
});
