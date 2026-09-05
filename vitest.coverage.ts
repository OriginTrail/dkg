/** Full production-source coverage and measured package-specific ratchets. */
import { COVERAGE_SOURCE_GLOBS } from './scripts/lib/coverage-scope.mjs';
import coveragePolicy from './test-policy/coverage-baselines.json';

export const sourceCoverage = {
  provider: 'v8' as const,
  include: COVERAGE_SOURCE_GLOBS,
  exclude: ['**/*.d.ts', '**/*.json'],
  excludeAfterRemap: true,
  reportOnFailure: true,
  reporter: ['text', 'json-summary', 'json', 'lcov'] as ('text' | 'json-summary' | 'json' | 'lcov')[],
  reportsDirectory: './coverage',
};

export const criticalityTargets = {
  tornado: {
    lines: 95,
    functions: 95,
    branches: 90,
    statements: 95,
  },
  bura: {
    lines: 80,
    functions: 80,
    branches: 75,
    statements: 80,
  },
  kosava: {
    lines: 60,
    functions: 60,
    branches: 50,
    statements: 60,
  },
} as const;

export type CoverageThresholds = {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
};

/** A new package can be measured before a floor exists; the independent CI
 * validator rejects any package without a checked-in measured policy. */
export function coverageForPackage(name: string) {
  const entry = (coveragePolicy.packages as Record<string, { thresholds: CoverageThresholds }>)[name];
  return { ...sourceCoverage, ...(entry ? { thresholds: entry.thresholds } : {}) };
}
