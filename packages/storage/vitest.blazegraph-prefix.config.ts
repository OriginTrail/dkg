import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test-live/blazegraph-prefix.test.ts'], maxWorkers: 1 } });
