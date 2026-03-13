import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

const SAMPLE_PARANETS = [
  { id: 'paranet-1', name: 'Research', subscribed: true, synced: true },
  { id: 'paranet-2', name: 'Testing', subscribed: false, synced: false },
];

function collectTools(plugin: DkgNodePlugin): OpenClawTool[] {
  const tools: OpenClawTool[] = [];
  const mockApi: OpenClawPluginApi = {
    config: {},
    registerTool: (tool) => tools.push(tool),
    registerHook: () => {},
    on: () => {},
    logger: {},
  };
  plugin.register(mockApi);
  return tools;
}

function findTool(name: string, daemonUrl = 'http://localhost:9200') {
  const plugin = new DkgNodePlugin({ daemonUrl });
  const tools = collectTools(plugin);
  return tools.find(t => t.name === name)!;
}

describe('dkg_list_paranets tool', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is present in the registered tools list', () => {
    const plugin = new DkgNodePlugin();
    const tools = collectTools(plugin);
    const tool = tools.find(t => t.name === 'dkg_list_paranets');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('paranets');
    expect(tool!.parameters.required).toEqual([]);
  });

  it('returns paranets array and count on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ paranets: SAMPLE_PARANETS }), { status: 200 }),
    );

    const tool = findTool('dkg_list_paranets');
    const result = await tool.execute('call-1', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.paranets).toEqual(SAMPLE_PARANETS);
    expect(parsed.count).toBe(2);
    expect(fetchSpy.mock.calls[1][0]).toBe('http://localhost:9200/api/paranet/list');
  });

  it('returns error when daemon request fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network failure'));

    const tool = findTool('dkg_list_paranets');
    const result = await tool.execute('call-2', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBe('network failure');
  });

  it('returns helpful error when daemon is not running', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    const tool = findTool('dkg_list_paranets');
    const result = await tool.execute('call-3', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('daemon is not reachable');
    expect(parsed.error).toContain('dkg start');
  });
});

describe('dkg_status tool', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges daemon status and wallet addresses', async () => {
    // getFullStatus + getWallets are called in parallel
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ peerId: '12D3KooW...', uptime: 42 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ wallets: ['0xABC', '0xDEF'] }), { status: 200 }),
      );

    const tool = findTool('dkg_status');
    const result = await tool.execute('call-1', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.peerId).toBe('12D3KooW...');
    expect(parsed.uptime).toBe(42);
    expect(parsed.walletAddresses).toEqual(['0xABC', '0xDEF']);
  });

  it('returns empty wallets when wallet endpoint fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ peerId: '12D3KooW...' }), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error('wallets endpoint down'));

    const tool = findTool('dkg_status');
    const result = await tool.execute('call-2', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.peerId).toBe('12D3KooW...');
    expect(parsed.walletAddresses).toEqual([]);
  });

  it('returns daemon error when status endpoint fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    const tool = findTool('dkg_status');
    const result = await tool.execute('call-3', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('daemon is not reachable');
  });
});

describe('dkg_publish tool', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses N-Quads and publishes to daemon', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ kcId: 'kc-123', kas: [{ tokenId: '1', rootEntity: 'urn:x' }] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const nquads = '<urn:alice> <https://schema.org/name> "Alice" .\n<urn:alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://schema.org/Person> .';
    const result = await tool.execute('call-1', { paranet_id: 'testing', nquads });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.kcId).toBe('kc-123');
    expect(parsed.kaCount).toBe(1);
    expect(parsed.triplesPublished).toBe(2);

    const body = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    expect(body.paranetId).toBe('testing');
    expect(body.quads).toHaveLength(2);
    expect(body.quads[0].subject).toBe('urn:alice');
  });

  it('returns error for invalid N-Quads', async () => {
    const tool = findTool('dkg_publish');
    const result = await tool.execute('call-2', { paranet_id: 'testing', nquads: 'not valid nquads at all' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('No valid N-Quads');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips comment and blank lines in N-Quads', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ kcId: 'kc-456', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const nquads = '# This is a comment\n\n<urn:x> <urn:y> "z" .\n';
    const result = await tool.execute('call-3', { paranet_id: 'testing', nquads });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.triplesPublished).toBe(1);
  });
});

describe('dkg_query tool', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends SPARQL query with optional paranet_id', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { bindings: [{ s: 'urn:x' }] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    const result = await tool.execute('call-1', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', paranet_id: 'testing' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.result.bindings).toHaveLength(1);

    const body = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    expect(body.sparql).toContain('SELECT');
    expect(body.paranetId).toBe('testing');
  });

  it('omits paranetId when not provided', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { bindings: [] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    await tool.execute('call-2', { sparql: 'SELECT * WHERE { ?s ?p ?o }' });

    const body = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    expect(body.paranetId).toBeUndefined();
  });
});

describe('dkg_read_messages tool', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes peer, limit, and since filters', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_read_messages');
    await tool.execute('call-1', { peer: 'agent-bob', limit: '10', since: '1710000000000' });

    const url = fetchSpy.mock.calls[1][0] as string;
    expect(url).toContain('peer=agent-bob');
    expect(url).toContain('limit=10');
    expect(url).toContain('since=1710000000000');
  });

  it('ignores non-numeric limit and since values', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_read_messages');
    await tool.execute('call-2', { limit: 'abc', since: '' });

    // Non-numeric values should not appear in URL
    const url = fetchSpy.mock.calls[1][0] as string;
    expect(url).not.toContain('limit=');
    expect(url).not.toContain('since=');
  });
});
