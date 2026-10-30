import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { main } from '../src/index.js';
import { loadConfig } from '../src/config.js';
import { makeConfig } from './harness.js';
const bridge = vi.hoisted(() => ({ server: undefined as unknown }));
vi.mock('../src/bounded-stdio-transport.js', () => ({
  BoundedStdioServerTransport: class {
    constructor() {
      return bridge.server as object;
    }
  },
}));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<typeof import('../src/config.js')>()),
  loadConfig: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(loadConfig).mockReturnValue(makeConfig());
  vi.stubEnv('DKG_ADAPTERS', '');
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('boots the real MCP server, advertises its tool families, and serves a daemon-backed request', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  bridge.server = serverTransport;
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ contextGraphs: [{ id: 'team', name: 'Shared knowledge' }] }),
  );
  vi.stubGlobal('fetch', fetcher);
  const client = new Client({ name: 'startup-contract-test', version: '1.0.0' });
  try {
    await main(['node', 'umbrella-cli']);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      'dkg_query',
      'dkg_memory_search',
      'dkg_knowledge_asset_create',
      'dkg_status',
      'dkg_send_message',
      'dkg_query_catalog_list',
    ])
      expect(tools).toContain(name);
    expect(new Set(tools).size).toBe(tools.length);
    const result = await client.callTool({ name: 'dkg_list_context_graphs', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('Shared knowledge') },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'http://localhost:9200/api/context-graph/list',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }),
    );
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('token=[set]'));
    expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('test-token'));
  } finally {
    await client.close();
    await serverTransport.close();
  }
});

it('dispatches the supplied CLI arguments and exits without starting an MCP transport', async () => {
  const exit = new Error('intercepted process exit');
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exit;
  });
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await expect(main(['node', 'umbrella-cli', 'help'])).rejects.toBe(exit);
  expect(process.exit).toHaveBeenCalledWith(0);
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('USAGE'));
  expect(loadConfig).not.toHaveBeenCalled();
});

it('does not self-start when imported by an evaluator without a script argument', async () => {
  vi.resetModules();
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node']);
  const config = await import('../src/config.js');
  vi.mocked(config.loadConfig).mockClear();
  await import('../src/index.js');
  expect(config.loadConfig).not.toHaveBeenCalled();
});

it.each(['stack', 'message', 'string'] as const)(
  'direct entrypoint reports fatal %s failures and exits nonzero',
  async (kind) => {
    vi.resetModules();
    vi.spyOn(process, 'argv', 'get').mockReturnValue([
      'node',
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    ]);
    const failure = kind === 'string' ? 'configuration failed' : new Error('configuration failed');
    if (kind === 'message' && failure instanceof Error) failure.stack = undefined;
    const config = await import('../src/config.js');
    vi.mocked(config.loadConfig).mockImplementation(() => {
      throw failure;
    });
    // In production exit terminates the process; returning here lets us inspect
    // the terminal error handler, whose final action is exit(1).
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await import('../src/index.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('[dkg-mcp] fatal:'));
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('configuration failed'),
    );
  },
);
