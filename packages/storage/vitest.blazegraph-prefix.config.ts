import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test-live/blazegraph-prefix.test.ts', 'test-live/read-graph-statements.blazegraph.test.ts', 'test-live/read-graph-layer.blazegraph.test.ts', 'test-live/read-graph-check.blazegraph.test.ts', 'test-live/read-graph-qualification.blazegraph.test.ts', 'test-live/read-graph-kill-at-commit.blazegraph.test.ts', 'test-live/read-graph-builder.blazegraph.test.ts', 'test-live/read-graph-builder-qualification.blazegraph.test.ts', 'test-live/read-graph-builder-restart.blazegraph.test.ts'], maxWorkers: 1 } });
