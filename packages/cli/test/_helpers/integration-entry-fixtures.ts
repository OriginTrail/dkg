import type { IntegrationEntry } from '../../src/integrations/schema.js';

export const baseIntegrationEntry = {
  slug: 'dkg-hello-world',
  name: 'DKG Hello World',
  description: 'Test fixture',
  maintainer: { github: '@OriginTrail/core-developers' },
  repo: 'https://github.com/OriginTrail/dkg-hello-world',
  commit: '0000000000000000000000000000000000000000',
  license: 'Apache-2.0',
  memoryLayers: ['WM'],
  v10PrimitivesUsed: ['ContextGraph', 'Assertion'],
  publicInterfacesUsed: ['http-api'],
  install: {
    kind: 'cli',
    package: '@origintrail/dkg-hello-world',
    version: '0.1.0',
    binary: 'dkg-hello-world',
    envRequired: ['DKG_API_URL', 'DKG_AUTH_TOKEN'],
    usageHint: 'dkg-hello-world greet "first post"\ndkg-hello-world list',
  },
  security: {},
  trustTier: 'featured',
} satisfies IntegrationEntry;

export const argsLessMcpEntry = {
  ...baseIntegrationEntry,
  slug: 'mcp-no-args',
  name: 'MCP No Args',
  install: {
    kind: 'mcp',
    command: 'my-mcp-server',
    supportedClients: ['cursor'],
  },
  trustTier: 'verified',
} satisfies IntegrationEntry;
