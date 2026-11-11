import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test-live/blazegraph-prefix.test.ts', 'test-live/read-graph-statements.blazegraph.test.ts', 'test-live/read-graph-layer.blazegraph.test.ts'], maxWorkers: 1 } });
