import { defineConfig } from 'vitest/config';

const runsDaemonHttpBehavior = process.argv.some((arg) =>
  arg.includes('daemon-http-behavior-extra.test.ts'),
);

if (runsDaemonHttpBehavior) {
  process.env.HARDHAT_PORT = '9548';
}

export default defineConfig({
  test: {
    include: runsDaemonHttpBehavior
      ? ['test/daemon-http-behavior-extra.test.ts']
      : [
          'test/api-client.test.ts',
          'test/memory-graph-events.test.ts',
          'test/trust-endpoint-validation.test.ts',
          'test/daemon/plugin-loader.test.ts',
          'test/daemon/routes/plugins.test.ts',
          'test/auth.test.ts',
          // Pure logic — no hardhat needed. Adding to the unit config means
          // contributors can run it via `pnpm test:unit` in ~2s instead of
          // paying the 2-minute hardhat-boot tax of the default config.
          'test/resolve-standalone-install.test.ts',
          'test/migrate-to-npm.test.ts',
          'test/nat-status.test.ts',
          'test/core-prereq-check.test.ts',
          'test/relay-status-block.test.ts',
          'test/supervisor-liveness.test.ts',
          'test/promote-async-routes.test.ts',
          'test/promote-async-daemon-lifecycle.test.ts',
          'test/async-promote-worker.test.ts',
          'test/async-promote-queue-e2e.test.ts',
          'test/import-artifact-routes.test.ts',
          'test/skill-endpoint.test.ts',
          'test/context-graph-write-path-validation.test.ts',
        ],
    testTimeout: runsDaemonHttpBehavior ? 120_000 : 60_000,
    globalSetup: runsDaemonHttpBehavior ? ['../chain/test/hardhat-global-setup.ts'] : [],
    env: runsDaemonHttpBehavior ? { HARDHAT_PORT: '9548' } : undefined,
    maxWorkers: 1,
  },
});
