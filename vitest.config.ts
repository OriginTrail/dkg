import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/storage',
      'packages/query',
      'packages/chain',
      'packages/publisher',
      'packages/agent',
      'packages/cli',
      'packages/mcp-dkg',
      'packages/mcp-server',
      'packages/node-ui',
      'packages/network-sim',
      'packages/graph-viz',
      'packages/attested-assets',
      'packages/epcis',
      'packages/adapter-openclaw',
      'packages/adapter-elizaos',
      'packages/adapter-hermes',
      'packages/adapter-autoresearch',
    ],
  },
});
