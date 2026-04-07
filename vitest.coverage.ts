/**
 * Tier-based coverage targets and per-package ratchet floors for `dkg-v9`.
 *
 * **Targets** (aspirational — from `dkgv10-spec/CRITICALITY_CATEGORIZATION.md`):
 * - TORNADO: ~100% lines / max review
 * - BURA: ≥80% lines
 * - KOSAVA: ≥60% lines
 *
 * **Ratchet** values below are measured floors (2026-04-06). CI fails if coverage
 * drops below them. Raise them over time toward the tier targets; never lower
 * without team agreement.
 */

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

export const tornadoCoreCoverage: CoverageThresholds = {
  lines: 87,
  functions: 84,
  branches: 78,
  statements: 86,
};

export const tornadoChainCoverage: CoverageThresholds = {
  lines: 30,
  functions: 40,
  branches: 22,
  statements: 29,
};

export const tornadoPublisherCoverage: CoverageThresholds = {
  lines: 82,
  functions: 86,
  branches: 70,
  statements: 82,
};

export const tornadoStorageCoverage: CoverageThresholds = {
  lines: 57,
  functions: 52,
  branches: 39,
  statements: 53,
};

export const tornadoAgentCoverage: CoverageThresholds = {
  lines: 79,
  functions: 78,
  branches: 66,
  statements: 78,
};

export const buraQueryCoverage: CoverageThresholds = {
  lines: 63,
  functions: 62,
  branches: 54,
  statements: 62,
};

export const buraCliCoverage: CoverageThresholds = {
  lines: 43,
  functions: 44,
  branches: 31,
  statements: 43,
};

export const buraAttestedAssetsCoverage: CoverageThresholds = {
  lines: 65,
  functions: 71,
  branches: 58,
  statements: 62,
};

export const kosavaNodeUiCoverage: CoverageThresholds = {
  lines: 67,
  functions: 63,
  branches: 55,
  statements: 65,
};

export const kosavaNetworkSimCoverage: CoverageThresholds = {
  lines: 30,
  functions: 32,
  branches: 30,
  statements: 30,
};

export const kosavaGraphVizCoverage: CoverageThresholds = {
  lines: 82,
  functions: 78,
  branches: 68,
  statements: 82,
};

/**
 * Covers all `src/` files. `connection.ts` is well-tested (~96%);
 * `index.ts` (stdio MCP entrypoint with tool registrations) is at 0%
 * because it requires a running MCP transport. Raise thresholds as
 * tool-registration tests are added.
 */
export const kosavaMcpServerCoverage: CoverageThresholds = {
  lines: 18,
  functions: 34,
  branches: 14,
  statements: 17,
};

export const kosavaAdapterOpenclawCoverage: CoverageThresholds = {
  lines: 53,
  functions: 59,
  branches: 47,
  statements: 52,
};

export const kosavaAdapterElizaosCoverage: CoverageThresholds = {
  lines: 5,
  functions: 0,
  branches: 0,
  statements: 5,
};

export const kosavaAdapterAutoresearchCoverage: CoverageThresholds = {
  lines: 90,
  functions: 99,
  branches: 77,
  statements: 91,
};

/** Engine / server-side tests only; UI component tests (`vitest.ui.config.ts`) run separately. */
export const kosavaOriginTrailGameCoverage: CoverageThresholds = {
  lines: 75,
  functions: 74,
  branches: 60,
  statements: 71,
};

export const kosavaEpcisCoverage: CoverageThresholds = {
  lines: 97,
  functions: 95,
  branches: 90,
  statements: 97,
};

/**
 * @deprecated Import a tier-specific export (e.g. `kosavaNodeUiCoverage`).
 * Kept for any external tooling that still references the old name.
 */
export const coverageThresholds: CoverageThresholds = criticalityTargets.kosava;
