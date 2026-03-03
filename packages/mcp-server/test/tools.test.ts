import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const mockStatus = {
  name: 'test-node',
  peerId: '12D3KooW...',
  uptimeMs: 60000,
  connectedPeers: 3,
  relayConnected: true,
  multiaddrs: ['/ip4/127.0.0.1/tcp/9000'],
};

const mockParanets = [
  { id: 'dev-coordination', uri: 'urn:paranet:dev-coordination', name: 'Dev Coordination', isSystem: false },
];

const mockAgents = [
  { agentUri: 'urn:agent:claude-1', name: 'claude-code', peerId: '12D3KooW...abc', framework: 'claude-code' },
];

const mockQueryResult = {
  result: { bindings: [{ s: 'urn:session:1', summary: 'Fixed tests' }] },
};

const mockPublishResult = {
  kcId: 'kc-123',
  status: 'confirmed',
  kas: [{ tokenId: '1', rootEntity: 'urn:session:1' }],
};

vi.mock('../src/connection.js', () => ({
  DkgClient: {
    connect: vi.fn().mockResolvedValue({
      status: vi.fn().mockResolvedValue(mockStatus),
      query: vi.fn().mockResolvedValue(mockQueryResult),
      publish: vi.fn().mockResolvedValue(mockPublishResult),
      listParanets: vi.fn().mockResolvedValue({ paranets: mockParanets }),
      createParanet: vi.fn().mockResolvedValue({ created: 'dev-coordination', uri: 'urn:paranet:dev-coordination' }),
      agents: vi.fn().mockResolvedValue({ agents: mockAgents }),
      subscribe: vi.fn().mockResolvedValue({ subscribed: 'dev-coordination' }),
    }),
  },
}));

function createTestServer(): McpServer {
  const server = new McpServer({ name: 'dkg-test', version: '9.0.0' });

  server.registerTool('dkg_status', {
    title: 'DKG Node Status',
    description: 'Get the status of the local DKG node.',
  }, async () => {
    const { DkgClient } = await import('../src/connection.js');
    const client = await DkgClient.connect();
    const status = await client.status();
    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
  });

  server.registerTool('dkg_query', {
    title: 'DKG SPARQL Query',
    description: 'Execute a SPARQL query.',
    inputSchema: {
      sparql: z.string(),
      paranetId: z.string().optional(),
    },
  }, async ({ sparql, paranetId }) => {
    const { DkgClient } = await import('../src/connection.js');
    const client = await DkgClient.connect();
    const result = await client.query(sparql, paranetId);
    return { content: [{ type: 'text', text: JSON.stringify(result.result, null, 2) }] };
  });

  server.registerTool('dkg_publish', {
    title: 'DKG Publish',
    description: 'Publish RDF quads to a paranet.',
    inputSchema: {
      paranetId: z.string(),
      quads: z.array(z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        graph: z.string(),
      })),
    },
  }, async ({ paranetId, quads }) => {
    const { DkgClient } = await import('../src/connection.js');
    const client = await DkgClient.connect();
    const result = await client.publish(paranetId, quads);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('dkg_list_paranets', {
    title: 'DKG List Paranets',
    description: 'List all paranets.',
  }, async () => {
    const { DkgClient } = await import('../src/connection.js');
    const client = await DkgClient.connect();
    const result = await client.listParanets();
    return { content: [{ type: 'text', text: JSON.stringify(result.paranets, null, 2) }] };
  });

  server.registerTool('dkg_create_paranet', {
    title: 'DKG Create Paranet',
    description: 'Create a new paranet.',
    inputSchema: {
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
    },
  }, async ({ id, name, description }) => {
    const { DkgClient } = await import('../src/connection.js');
    const client = await DkgClient.connect();
    const result = await client.createParanet(id, name, description);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('dkg_find_agents', {
    title: 'DKG Find Agents',
    description: 'Discover agents on the network.',
  }, async () => {
    const { DkgClient } = await import('../src/connection.js');
    const client = await DkgClient.connect();
    const result = await client.agents();
    return { content: [{ type: 'text', text: JSON.stringify(result.agents, null, 2) }] };
  });

  server.registerTool('dkg_subscribe', {
    title: 'DKG Subscribe',
    description: 'Subscribe to a paranet.',
    inputSchema: { paranetId: z.string() },
  }, async ({ paranetId }) => {
    const { DkgClient } = await import('../src/connection.js');
    const client = await DkgClient.connect();
    const result = await client.subscribe(paranetId);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  return server;
}

describe('DKG MCP Server Tools', () => {
  let client: Client;
  let mcpServer: McpServer;

  beforeEach(async () => {
    mcpServer = createTestServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  it('lists all 7 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([
      'dkg_create_paranet',
      'dkg_find_agents',
      'dkg_list_paranets',
      'dkg_publish',
      'dkg_query',
      'dkg_status',
      'dkg_subscribe',
    ]);
  });

  it('dkg_status returns node info', async () => {
    const result = await client.callTool({ name: 'dkg_status', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    const parsed = JSON.parse(content[0].text);
    expect(parsed.name).toBe('test-node');
    expect(parsed.connectedPeers).toBe(3);
  });

  it('dkg_query executes SPARQL', async () => {
    const result = await client.callTool({
      name: 'dkg_query',
      arguments: { sparql: 'SELECT ?s WHERE { ?s a devgraph:Session }' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.bindings).toHaveLength(1);
    expect(parsed.bindings[0].summary).toBe('Fixed tests');
  });

  it('dkg_publish publishes quads', async () => {
    const result = await client.callTool({
      name: 'dkg_publish',
      arguments: {
        paranetId: 'dev-coordination',
        quads: [{
          subject: '<urn:session:1>',
          predicate: '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>',
          object: '<https://ontology.dkg.io/devgraph#Session>',
          graph: '<urn:paranet:dev-coordination>',
        }],
      },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.kcId).toBe('kc-123');
    expect(parsed.status).toBe('confirmed');
  });

  it('dkg_list_paranets returns paranets', async () => {
    const result = await client.callTool({ name: 'dkg_list_paranets', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('dev-coordination');
  });

  it('dkg_create_paranet creates a paranet', async () => {
    const result = await client.callTool({
      name: 'dkg_create_paranet',
      arguments: { id: 'dev-coordination', name: 'Dev Coordination' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.created).toBe('dev-coordination');
  });

  it('dkg_find_agents discovers agents', async () => {
    const result = await client.callTool({ name: 'dkg_find_agents', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('claude-code');
  });

  it('dkg_subscribe subscribes to a paranet', async () => {
    const result = await client.callTool({
      name: 'dkg_subscribe',
      arguments: { paranetId: 'dev-coordination' },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.subscribed).toBe('dev-coordination');
  });
});
