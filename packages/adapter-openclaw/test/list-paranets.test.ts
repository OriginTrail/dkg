import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

const SAMPLE_CONTEXT_GRAPHS = [
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

function setupFetchOverride() {
  const original = globalThis.fetch;
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const responses: Array<Response | Error> = [];
  let idx = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    const r = responses[idx++];
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;

  return {
    calls,
    addResponses(...resps: Array<Response | Error>) { responses.push(...resps); },
    restore() { globalThis.fetch = original; },
  };
}

describe('dkg_list_context_graphs tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('is present in the registered tools list', () => {
    const plugin = new DkgNodePlugin();
    const tools = collectTools(plugin);
    const tool = tools.find(t => t.name === 'dkg_list_context_graphs');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('contextGraphs');
    expect(tool!.parameters.required).toEqual([]);
  });

  it('returns contextGraphs array and count on success', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ contextGraphs: SAMPLE_CONTEXT_GRAPHS }), { status: 200 }),
    );

    const tool = findTool('dkg_list_context_graphs');
    const result = await tool.execute('call-1', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.contextGraphs).toEqual(SAMPLE_CONTEXT_GRAPHS);
    expect(parsed.count).toBe(2);
    expect(ft.calls[0][0]).toBe('http://localhost:9200/api/context-graph/list');
  });

  it('returns error when daemon request fails', async () => {
    ft.addResponses(new Error('network failure'));

    const tool = findTool('dkg_list_context_graphs');
    const result = await tool.execute('call-2', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBe('network failure');
  });

  it('returns helpful error when daemon is not running', async () => {
    ft.addResponses(new Error('fetch failed: ECONNREFUSED'));

    const tool = findTool('dkg_list_context_graphs');
    const result = await tool.execute('call-3', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('daemon is not reachable');
    expect(parsed.error).toContain('dkg start');
  });
});

describe('dkg_status tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('merges daemon status and wallet addresses', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ peerId: '12D3KooW...', uptime: 42 }), { status: 200 }),
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
    ft.addResponses(
      new Response(JSON.stringify({ peerId: '12D3KooW...' }), { status: 200 }),
      new Error('wallets endpoint down'),
    );

    const tool = findTool('dkg_status');
    const result = await tool.execute('call-2', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.peerId).toBe('12D3KooW...');
    expect(parsed.walletAddresses).toEqual([]);
  });

  it('returns daemon error when status endpoint fails', async () => {
    ft.addResponses(new Error('fetch failed: ECONNREFUSED'));

    const tool = findTool('dkg_status');
    const result = await tool.execute('call-3', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('daemon is not reachable');
  });
});

describe('dkg_publish tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('publishes quads array with literal objects', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ triplesWritten: 2 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-123', kas: [{ tokenId: '1', rootEntity: 'urn:x' }] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const quads = [
      { subject: 'https://example.org/wine', predicate: 'https://schema.org/name', object: 'Cabernet Sauvignon' },
      { subject: 'https://example.org/wine', predicate: 'https://schema.org/description', object: 'Full-bodied red wine' },
    ];
    const result = await tool.execute('call-1', { context_graph_id: 'testing', quads });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.kcId).toBe('kc-123');
    expect(parsed.kaCount).toBe(1);
    expect(parsed.quadsPublished).toBe(2);

    const writeBody = JSON.parse(ft.calls[0][1]?.body as string);
    expect(writeBody.contextGraphId).toBe('testing');
    expect(writeBody.quads).toHaveLength(2);
    expect(writeBody.quads[0].subject).toBe('https://example.org/wine');
    expect(writeBody.quads[0].object).toBe('"Cabernet Sauvignon"');
  });

  it('publishes quads array with URI objects (auto-detected)', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ triplesWritten: 1 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-uri', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const quads = [
      { subject: 'https://example.org/wine', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://schema.org/Product' },
    ];
    const result = await tool.execute('call-uri', { context_graph_id: 'testing', quads });

    const writeBody = JSON.parse(ft.calls[0][1]?.body as string);
    expect(writeBody.quads[0].object).toBe('https://schema.org/Product');
  });

  it('handles mixed URI and literal objects', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ triplesWritten: 3 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-mix', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const quads = [
      { subject: 'https://example.org/wine', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://schema.org/Product' },
      { subject: 'https://example.org/wine', predicate: 'https://schema.org/name', object: 'Cabernet' },
      { subject: 'https://example.org/wine', predicate: 'https://schema.org/knows', object: 'urn:winemaker:alice' },
    ];
    const result = await tool.execute('call-mix', { context_graph_id: 'testing', quads });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.quadsPublished).toBe(3);

    const writeBody = JSON.parse(ft.calls[0][1]?.body as string);
    expect(writeBody.quads[0].object).toBe('https://schema.org/Product');
    expect(writeBody.quads[1].object).toBe('"Cabernet"');
    expect(writeBody.quads[2].object).toBe('urn:winemaker:alice');
  });

  it('returns error for empty quads array', async () => {
    const tool = findTool('dkg_publish');
    const result = await tool.execute('call-empty', { context_graph_id: 'testing', quads: [] });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('non-empty array');
    expect(ft.calls).toHaveLength(0);
  });

  it('returns error for missing quads', async () => {
    const tool = findTool('dkg_publish');
    const result = await tool.execute('call-missing', { context_graph_id: 'testing' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('non-empty array');
  });

  it('escapes quotes in literal object values', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ triplesWritten: 1 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-esc', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const quads = [
      { subject: 'urn:a', predicate: 'urn:b', object: 'She said "hello"' },
    ];
    const result = await tool.execute('call-esc', { context_graph_id: 'testing', quads });

    const writeBody = JSON.parse(ft.calls[0][1]?.body as string);
    expect(writeBody.quads[0].object).toBe('"She said \\"hello\\""');
  });

  it('passes optional graph field', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ triplesWritten: 1 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-graph', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const quads = [
      { subject: 'urn:a', predicate: 'urn:b', object: 'hello', graph: 'urn:my-graph' },
    ];
    const result = await tool.execute('call-graph', { context_graph_id: 'testing', quads });

    const writeBody = JSON.parse(ft.calls[0][1]?.body as string);
    expect(writeBody.quads[0].graph).toBe('urn:my-graph');
  });
});

describe('dkg_query tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('sends SPARQL query with optional context_graph_id', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ result: { bindings: [{ s: 'urn:x' }] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    const result = await tool.execute('call-1', { sparql: 'SELECT ?s WHERE { ?s ?p ?o }', context_graph_id: 'testing' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.result.bindings).toHaveLength(1);

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.sparql).toContain('SELECT');
    expect(body.contextGraphId).toBe('testing');
  });

  it('omits contextGraphId when not provided', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ result: { bindings: [] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    await tool.execute('call-2', { sparql: 'SELECT * WHERE { ?s ?p ?o }' });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.contextGraphId).toBeUndefined();
  });

  it('passes includeSharedMemory when include_shared_memory is "true"', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ result: { bindings: [] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    await tool.execute('call-3', { sparql: 'SELECT * WHERE { ?s ?p ?o }', include_shared_memory: 'true' });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.includeSharedMemory).toBe(true);
  });

  it('omits includeSharedMemory when include_shared_memory is not set', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ result: { bindings: [] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    await tool.execute('call-4', { sparql: 'SELECT * WHERE { ?s ?p ?o }' });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.includeSharedMemory).toBeUndefined();
  });
});

describe('dkg_context_graph_create tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('is present with required param name only', () => {
    const plugin = new DkgNodePlugin();
    const tools = collectTools(plugin);
    const tool = tools.find(t => t.name === 'dkg_context_graph_create');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toEqual(['name']);
  });

  it('creates a context graph with explicit id', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ created: 'my-research', uri: 'did:dkg:context-graph:my-research' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-1', { id: 'my-research', name: 'My Research', description: 'A context graph' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.created).toBe('my-research');
    expect(parsed.uri).toBe('did:dkg:context-graph:my-research');

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.id).toBe('my-research');
    expect(body.name).toBe('My Research');
    expect(body.description).toBe('A context graph');
  });

  it('auto-generates id from name when id is omitted', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ created: 'my-research-paranet', uri: 'did:dkg:context-graph:my-research-paranet' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-auto', { name: 'My Research Paranet' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.created).toBe('my-research-paranet');

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.id).toBe('my-research-paranet');
    expect(body.name).toBe('My Research Paranet');
  });

  it('strips special characters when auto-generating id', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ created: 'alice-s-data-2024', uri: 'did:dkg:context-graph:alice-s-data-2024' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    await tool.execute('call-special', { name: "Alice's Data (2024)" });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.id).toBe('alice-s-data-2024');
  });

  it('returns error when name is missing', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-3', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('required');
  });

  it('returns error when name produces empty slug and no explicit id', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-empty-slug', { name: '!!@#$%' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('Could not derive');
  });

  it('falls back to auto-generate when explicit id is whitespace-only', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ created: 'test', uri: 'did:dkg:context-graph:test' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-ws-id', { id: '   ', name: 'Test' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.created).toBe('test');
    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.id).toBe('test');
  });

  it('returns error for invalid explicit ID format (uppercase)', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-4', { id: 'My-Paranet', name: 'Test' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('Invalid context graph ID');
  });

  it('returns error for explicit ID starting with hyphen', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-6', { id: '-bad-id', name: 'Test' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('Invalid context graph ID');
  });

  it('accepts single-character explicit ID', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ created: 'x', uri: 'did:dkg:context-graph:x' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-7', { id: 'x', name: 'X Paranet' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.created).toBe('x');
  });

  it('returns daemon error on failure', async () => {
    ft.addResponses(new Error('fetch failed: ECONNREFUSED'));

    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-8', { name: 'Test' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('daemon is not reachable');
  });
});

describe('dkg_subscribe tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('is present with required param context_graph_id', () => {
    const plugin = new DkgNodePlugin();
    const tools = collectTools(plugin);
    const tool = tools.find(t => t.name === 'dkg_subscribe');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toEqual(['context_graph_id']);
  });

  it('subscribes and returns catchup job info', async () => {
    ft.addResponses(
      new Response(JSON.stringify({
        subscribed: 'my-paranet',
        catchup: { jobId: 'job-1', status: 'queued', includeSharedMemory: true },
      }), { status: 200 }),
    );

    const tool = findTool('dkg_subscribe');
    const result = await tool.execute('call-1', { context_graph_id: 'my-paranet' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.subscribed).toBe('my-paranet');
    expect(parsed.catchup.jobId).toBe('job-1');
  });

  it('returns error when context_graph_id is missing', async () => {
    const tool = findTool('dkg_subscribe');
    const result = await tool.execute('call-2', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('context_graph_id');
  });

  it('passes includeSharedMemory false when specified', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ subscribed: 'p1', catchup: { jobId: 'j', status: 'queued', includeSharedMemory: false } }), { status: 200 }),
    );

    const tool = findTool('dkg_subscribe');
    await tool.execute('call-3', { context_graph_id: 'p1', include_shared_memory: 'false' });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.includeSharedMemory).toBe(false);
  });
});

describe('dkg_wallet_balances tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('is present with no required params', () => {
    const plugin = new DkgNodePlugin();
    const tools = collectTools(plugin);
    const tool = tools.find(t => t.name === 'dkg_wallet_balances');
    expect(tool).toBeDefined();
    expect(tool!.parameters.required).toEqual([]);
  });

  it('returns wallet balances from daemon', async () => {
    ft.addResponses(
      new Response(JSON.stringify({
        wallets: ['0xabc'],
        balances: [{ address: '0xabc', eth: '1.5', trac: '1000.0', symbol: 'TRAC' }],
        chainId: '31337',
        rpcUrl: 'http://localhost:8545',
      }), { status: 200 }),
    );

    const tool = findTool('dkg_wallet_balances');
    const result = await tool.execute('call-1', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.wallets).toEqual(['0xabc']);
    expect(parsed.balances[0].trac).toBe('1000.0');
  });

  it('returns daemon error gracefully', async () => {
    ft.addResponses(new Error('fetch failed: ECONNREFUSED'));

    const tool = findTool('dkg_wallet_balances');
    const result = await tool.execute('call-2', {});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('daemon is not reachable');
  });
});

describe('dkg_publish SWM-first flow', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  const VALID_QUADS = [{ subject: 'urn:a', predicate: 'urn:b', object: 'c' }];

  it('writes to SWM then publishes from SWM', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ triplesWritten: 1 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-1', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const result = await tool.execute('call-1', { context_graph_id: 'testing', quads: VALID_QUADS });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.kcId).toBe('kc-1');
    expect(parsed.quadsPublished).toBe(1);

    expect(ft.calls).toHaveLength(2);
    const writeUrl = ft.calls[0][0] as string;
    expect(writeUrl).toContain('/api/shared-memory/write');
    const pubUrl = ft.calls[1][0] as string;
    expect(pubUrl).toContain('/api/shared-memory/publish');
  });

  it('ignores unknown access_policy parameter gracefully', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ triplesWritten: 1 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-2', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const result = await tool.execute('call-2', { context_graph_id: 'testing', quads: VALID_QUADS, access_policy: 'public' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.kcId).toBe('kc-2');
  });
});

describe('dkg_read_messages tool', () => {
  let ft: ReturnType<typeof setupFetchOverride>;

  beforeEach(() => { ft = setupFetchOverride(); });
  afterEach(() => { ft.restore(); });

  it('passes peer, limit, and since filters', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_read_messages');
    await tool.execute('call-1', { peer: 'agent-bob', limit: '10', since: '1710000000000' });

    const url = ft.calls[0][0] as string;
    expect(url).toContain('peer=agent-bob');
    expect(url).toContain('limit=10');
    expect(url).toContain('since=1710000000000');
  });

  it('ignores non-numeric limit and since values', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_read_messages');
    await tool.execute('call-2', { limit: 'abc', since: '' });

    const url = ft.calls[0][0] as string;
    expect(url).not.toContain('limit=');
    expect(url).not.toContain('since=');
  });
});
