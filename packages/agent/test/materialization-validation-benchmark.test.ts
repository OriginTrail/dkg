import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface BenchmarkQueryMetrics {
  countQueries: number;
  constructQueries: number;
}

interface BenchmarkQueryValidation {
  constructReduction: number;
  countReduction: number;
  requiredReduction: number;
}

const require = createRequire(import.meta.url);
const { validateBenchmarkQueryWorkload } = require(
  '../scripts/swm-materialization-validation-benchmark.cjs',
) as {
  validateBenchmarkQueryWorkload(input: {
    baseline: BenchmarkQueryMetrics;
    memoized: BenchmarkQueryMetrics;
    graphCount: number;
    passes: number;
  }): BenchmarkQueryValidation;
};

describe('#1963 materialization validation benchmark', () => {
  it('accepts the exact attainable reduction for a one-pass smoke run', () => {
    expect(validateBenchmarkQueryWorkload({
      baseline: { countQueries: 1, constructQueries: 1 },
      memoized: { countQueries: 1, constructQueries: 1 },
      graphCount: 1,
      passes: 1,
    })).toEqual({
      constructReduction: 0,
      countReduction: 0,
      requiredReduction: 0,
    });
  });

  it('fails closed when a query denominator is zero', () => {
    expect(() => validateBenchmarkQueryWorkload({
      baseline: { countQueries: 0, constructQueries: 0 },
      memoized: { countQueries: 0, constructQueries: 0 },
      graphCount: 1,
      passes: 1,
    })).toThrow('baseline countQueries must be a positive safe integer');
  });

  it('retains the 70% gate for the default four-pass workload', () => {
    const validated = validateBenchmarkQueryWorkload({
      baseline: { countQueries: 4, constructQueries: 4 },
      memoized: { countQueries: 1, constructQueries: 1 },
      graphCount: 1,
      passes: 4,
    });
    expect(validated.requiredReduction).toBe(0.7);
    expect(validated.countReduction).toBe(0.75);
    expect(validated.constructReduction).toBe(0.75);
  });
});
