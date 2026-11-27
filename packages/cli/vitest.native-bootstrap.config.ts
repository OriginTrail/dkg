import { defineConfig } from 'vitest/config';
export default defineConfig({ resolve: { alias: { '@origintrail-official/dkg-agent': new URL('../agent/src/index.ts', import.meta.url).pathname } }, test: { allowOnly: false,
  include: ['test-live/public-checkpoint-daemon.blazegraph.test.ts'], testTimeout: 30_000, maxWorkers: 1 } });
