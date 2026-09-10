import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'bench/**', '**/*.bench.ts'],
    projects: [
      'packages/random-sampling',
      'packages/kafka-plugin',
      'packages/local-llm',
      'packages/okf',
      'packages/rdf-utils',
      'packages/core',
      'packages/http-utils',
      'packages/storage',
      'packages/query',
      'packages/chain',
      'packages/publisher',
      'packages/agent',
      'packages/cli',
      'packages/mcp-dkg',
      'packages/node-ui',
      'packages/network-sim',
      'packages/graph-viz',
      'packages/epcis',
      'packages/adapter-openclaw',
      'packages/adapter-elizaos',
      'packages/adapter-hermes',
      'packages/adapter-prime-agent',
    ],
  },
});
