import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * dRAG V1 — release-gate integration suite (OT-RFC-55).
 *
 * Exercises the whole dRAG stack against a live devnet, one canonical scenario
 * each:
 *   1. P2 single-node — a grounded answer whose every citation verifies
 *      (author-sig + merkle + on-chain), re-checked client-side.
 *   2. P1 verifiability — tampering a citation's triple makes verifyCitationProof
 *      reject it (the audit guarantee).
 *   3. P3 cross-node — an asker holding NONE of the CG assembles a verified
 *      answer from remote serving nodes, re-verified against its own chain.
 *   4. P4 payments — priced answers are FREE by default (off), and a configured
 *      price drives 402 → pay → 200 + receipt (covered by unit tests; the
 *      default-off behaviour is asserted here).
 *   5. Phase 1 retrieval — keyword misses a paraphrase the vector path finds;
 *      semantic (MiniLM) is asserted when the optional model is installed.
 *
 * Run via: `pnpm test:devnet:drag-v1`
 *
 * Preconditions:
 *   ./scripts/devnet.sh start 4
 *   (optional, for the semantic assertion: npm i @huggingface/transformers)
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
