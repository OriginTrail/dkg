import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/endorse.test.ts',
      'test/e2e-dht-dial.test.ts',
      'test/generic-sql-source.test.ts',
      'test/query-min-trust-alias.test.ts',
      'test/swm/host-catchup-sign.test.ts',
      'test/swm/host-catchup-wire.test.ts',
      'test/swm/host-mode-store.test.ts',
      'test/swm/host-mode-key-canonicalization.test.ts',
      'test/profile-fix-verify.test.ts',
      // G1 reject-join curator authz regression (notifications-pane redesign).
      // Uses MockChainAdapter + DKGAgent.create (no network start, no hardhat).
      'test/reject-join-authz.test.ts',
    ],
    testTimeout: 60_000,
    maxWorkers: 1,
  },
});
