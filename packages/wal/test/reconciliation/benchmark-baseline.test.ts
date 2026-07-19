import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Baseline {
  eachSideDifference: number;
  maximumTotalTimeRegressionRatio: number;
  results: Array<{
    setSize: number;
    differenceSize: number;
    canonicalWireBytes: number;
  }>;
}

const baseline = JSON.parse(
  readFileSync(new URL('../../benchmarks/reconciliation-baseline.json', import.meta.url), 'utf8')
) as Baseline;

describe('tracked fixed-delta byte bound', () => {
  it('keeps fixed k and b within the RFC 50% reconciliation-byte growth bound', () => {
    expect(baseline.eachSideDifference).toBe(16);
    expect(baseline.maximumTotalTimeRegressionRatio).toBe(1.5);
    expect(baseline.results.map((result) => result.setSize)).toEqual([10_000, 100_000, 1_000_000]);
    expect(new Set(baseline.results.map((result) => result.differenceSize))).toEqual(new Set([32]));
    const tenThousand = baseline.results[0].canonicalWireBytes;
    const oneMillion = baseline.results[2].canonicalWireBytes;
    expect(oneMillion / tenThousand).toBeLessThanOrEqual(1.5);
  });
});
