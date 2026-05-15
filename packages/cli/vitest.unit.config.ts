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
      : ['test/api-client.test.ts', 'test/memory-graph-events.test.ts', 'test/trust-endpoint-validation.test.ts'],
    testTimeout: runsDaemonHttpBehavior ? 120_000 : 60_000,
    globalSetup: runsDaemonHttpBehavior ? ['../chain/test/hardhat-global-setup.ts'] : [],
    env: runsDaemonHttpBehavior ? { HARDHAT_PORT: '9548' } : undefined,
    maxWorkers: 1,
  },
});
