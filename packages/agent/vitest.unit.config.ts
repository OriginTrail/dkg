import { defineConfig } from "vitest/config";

// generic-sql-source.test.ts uses `import('node:sqlite')`, which is
// `--experimental-sqlite`-gated on Node 22.5–23.x. The flag is a
// process-level toggle, so mirror `vitest.config.ts`: switch to the
// `forks` pool and pass execArgv there. See the long comment in
// `vitest.config.ts` for the full rationale.
const SQLITE_EXEC_ARGV = [
  "--experimental-sqlite",
  "--no-warnings=ExperimentalWarning",
];

export default defineConfig({
  test: {
    include: [
      "test/endorse.test.ts",
      "test/ack-candidate-pool.test.ts",
      "test/e2e-dht-dial.test.ts",
      "test/generic-sql-source.test.ts",
      "test/imported-artifact.test.ts",
      "test/publish-finalized-agent-lane.test.ts",
      "test/promote-async-default-agent.test.ts",
      "test/query-min-trust-alias.test.ts",
      "test/sync-envelope-cursor.test.ts",
      "test/swm/host-catchup-sign.test.ts",
      "test/swm/host-catchup-wire.test.ts",
      "test/swm/host-mode-store.test.ts",
      "test/swm/host-mode-key-canonicalization.test.ts",
      "test/profile-fix-verify.test.ts",
      "test/pca-v10-facade.test.ts",
      "test/ensure-registered-for-publish.test.ts",
      "test/sync-verify-collapsed.test.ts",
      "test/durable-sync-since-threading.test.ts",
      "test/oversize-filter.test.ts",
      "test/cg-registration-oversize-guard.test.ts",
      "test/sync-responder-concurrent-interleaving.test.ts",
      "test/sync-fetch-coalescing.test.ts",
      "test/sync-on-connect-churn.test.ts",
      "test/sync-requester-bailout.test.ts",
      "test/swm-catchup-peer-selection.test.ts",
      "test/swm-fanout-peer-selection.test.ts",
      "test/publish-literal-size.test.ts",
      "test/verify-batch.test.ts",
      "test/chain-cursor-wiring.test.ts",
      "test/chain-reconciler.test.ts",
      "test/finalization-lifecycle-logger.test.ts",
      "test/ka-lifecycle-asset-ual-timeout.test.ts",
      "test/storage-ack-lifecycle-identity.test.ts",
      "test/v10-ack-provider-wiring.test.ts",
      "test/agents-meta-policy.test.ts",
      "test/agents-meta-sync-wiring.test.ts",
      "test/network-identity-proof.test.ts",
      "test/sync-responder-agents-meta-serve-skip.test.ts",
    ],
    testTimeout: 60_000,
    maxWorkers: 1,
    pool: "forks",
    execArgv: SQLITE_EXEC_ARGV,
  },
});
