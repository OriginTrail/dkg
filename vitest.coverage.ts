/**
 * Shared coverage thresholds for the monorepo.
 * CI runs `pnpm test:coverage`; if any package is below these percentages, the run fails and the PR is blocked.
 * Raise these over time as coverage improves (e.g. 50 → 80).
 */
export const coverageThresholds = {
  lines: 20,
  functions: 20,
  branches: 20,
  statements: 20,
} as const;
