import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * dRAG REASONING — release-gate integration suite (OT-RFC-55 + EYE).
 *
 * Publishes a multi-agent CODE context graph (code structure + two decisions with
 * reviews + a verifiable rule-KA) and asserts that EYE, over the VERIFIED facts,
 * DERIVES a governance conclusion: D1 violates the review policy (negation — no
 * senior review), D2 does NOT (senior review), and a change's transitive impact
 * ripples up the call graph — each derived conclusion carrying chain-verified
 * support. Requires the optional `eyereasoner` dependency.
 *
 * Run via: `pnpm test:devnet:drag-reason`
 * Preconditions: ./scripts/devnet.sh start 4
 */
export default defineConfig({
  test: {
    include: [resolve(import.meta.dirname, 'automated.test.ts')],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    pool: 'forks',
    sequence: { concurrent: false },
    globals: false,
  },
  resolve: {
    modules: [resolve(import.meta.dirname, '../../node_modules'), 'node_modules'],
  },
});
