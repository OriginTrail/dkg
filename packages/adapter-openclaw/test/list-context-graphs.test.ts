import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

const SAMPLE_CONTEXT_GRAPHS = [
  { id: 'contextGraph-1', name: 'Research', subscribed: true, synced: true },
  { id: 'contextGraph-2', name: 'Testing', subscribed: false, synced: false },
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

  it('passes view=shared-working-memory through to the daemon body (context_graph_id required with view)', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ result: { bindings: [] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    await tool.execute('call-3', {
      sparql: 'SELECT * WHERE { ?s ?p ?o }',
      context_graph_id: 'my-cg',
      view: 'shared-working-memory',
    });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.view).toBe('shared-working-memory');
    expect(body.contextGraphId).toBe('my-cg');
  });

  it('omits view on the wire when not set (daemon then routes via the legacy data-graph path)', async () => {
    // When `view` is absent, the daemon's DKGQueryEngine.query takes the
    // "Legacy routing (V9 compat)" branch (see the `if (options?.view)`
    // skip path), NOT working-memory semantics. The tool MUST forward
    // the absence faithfully — a silent default here would change
    // semantics for every caller that omits `view`.
    ft.addResponses(
      new Response(JSON.stringify({ result: { bindings: [] } }), { status: 200 }),
    );

    const tool = findTool('dkg_query');
    await tool.execute('call-4', { sparql: 'SELECT * WHERE { ?s ?p ?o }' });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.view).toBeUndefined();
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
      new Response(JSON.stringify({ created: 'my-research-context-graph', uri: 'did:dkg:context-graph:my-research-context-graph' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-auto', { name: 'My Research Context Graph' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.created).toBe('my-research-context-graph');

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.id).toBe('my-research-context-graph');
    expect(body.name).toBe('My Research Context Graph');
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
    const result = await tool.execute('call-4', { id: 'My-ContextGraph', name: 'Test' });
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
    const result = await tool.execute('call-7', { id: 'x', name: 'X ContextGraph' });
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

  it('defaults to curated/private (accessPolicy: 1) when public is not specified', async () => {
    // Privacy-by-default: omitting `public` produces a curated CG.
    // The agent's createContextGraph flow auto-includes the creator
    // in DKG_ALLOWED_AGENT (see packages/agent/src/dkg-agent.ts:3962),
    // so the creator can immediately read/write without a self-invite.
    ft.addResponses(
      new Response(JSON.stringify({ created: 'private', uri: 'did:dkg:context-graph:private' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    await tool.execute('call-default-private', { id: 'private', name: 'Private CG' });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.accessPolicy).toBe(1);
    expect(body.allowedAgents).toBeUndefined();
  });

  it('creates an open/discoverable CG when public:true is passed', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ created: 'open', uri: 'did:dkg:context-graph:open' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    await tool.execute('call-public', { id: 'open', name: 'Open CG', public: true });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    // public:true → no accessPolicy sent → daemon's "open" default takes over.
    expect(body.accessPolicy).toBeUndefined();
    expect(body.allowedAgents).toBeUndefined();
  });

  it('passes allowed_agents to the daemon when provided alongside curated default', async () => {
    ft.addResponses(
      new Response(JSON.stringify({ created: 'team', uri: 'did:dkg:context-graph:team' }), { status: 200 }),
    );

    const validAddr1 = '0x' + 'a'.repeat(40);
    const validAddr2 = '0x' + 'B'.repeat(40);
    const tool = findTool('dkg_context_graph_create');
    await tool.execute('call-allowed', {
      id: 'team',
      name: 'Team CG',
      allowed_agents: [validAddr1, validAddr2],
    });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.accessPolicy).toBe(1);
    expect(body.allowedAgents).toEqual([validAddr1, validAddr2]);
  });

  it('ignores allowed_agents when public:true is passed', async () => {
    // Curation parameters are meaningless on a public CG; the handler
    // drops them rather than sending a contradictory mix to the daemon.
    ft.addResponses(
      new Response(JSON.stringify({ created: 'open-2', uri: 'did:dkg:context-graph:open-2' }), { status: 200 }),
    );

    const validAddr = '0x' + 'a'.repeat(40);
    const tool = findTool('dkg_context_graph_create');
    await tool.execute('call-public-with-allowed', {
      id: 'open-2',
      name: 'Open',
      public: true,
      allowed_agents: [validAddr],
    });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.accessPolicy).toBeUndefined();
    expect(body.allowedAgents).toBeUndefined();
  });

  it('trims whitespace-padded valid allowed_agents entries', async () => {
    // Whitespace padding around an otherwise valid address is trimmed
    // before validation. Empty, whitespace-only, and non-string entries
    // are NOT silently dropped — they fail validation (see fail-fast
    // tests below). LLM-generated bad args should produce a clear tool
    // error so the agent can correct, not silently lose collaborators.
    ft.addResponses(
      new Response(JSON.stringify({ created: 'trimmed', uri: 'did:dkg:context-graph:trimmed' }), { status: 200 }),
    );

    const validAddr1 = '0x' + 'a'.repeat(40);
    const validAddr2 = '0x' + 'B'.repeat(40);
    const tool = findTool('dkg_context_graph_create');
    await tool.execute('call-trim', {
      id: 'trimmed',
      name: 'Trim',
      allowed_agents: [`  ${validAddr1}  `, validAddr2],
    });

    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.allowedAgents).toEqual([validAddr1, validAddr2]);
  });

  it('returns a tool error when allowed_agents contains a malformed address', async () => {
    // Validation is at the tool layer so a malformed input surfaces as a
    // user-correctable tool error rather than bubbling up as a daemon 500.
    // Mirrors the agent-layer regex at `packages/agent/src/dkg-agent.ts:3918`.
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-bad-addr', {
      id: 'bad-addr',
      name: 'Bad',
      allowed_agents: ['0x' + 'a'.repeat(40), 'not-an-address'],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('Invalid Ethereum address');
    expect(parsed.error).toContain('allowed_agents[1]');
    expect(parsed.error).toContain('not-an-address');
    expect(ft.calls).toHaveLength(0);
  });

  it('returns a tool error when allowed_agents has a too-short hex value', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-short-addr', {
      id: 'short-addr',
      name: 'Short',
      allowed_agents: ['0xabc'],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('Invalid Ethereum address');
    expect(ft.calls).toHaveLength(0);
  });

  it('round 2: fails fast when allowed_agents contains a non-string entry', async () => {
    // LLMs sometimes emit numbers / nulls / dicts in tool args; if we
    // silently drop them, the agent thinks the participant was added
    // when it wasn't. Fail with a precise index-scoped error.
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-non-string', {
      id: 'non-string',
      name: 'NonString',
      allowed_agents: ['0x' + 'a'.repeat(40), 42 as unknown as string, '0x' + 'b'.repeat(40)],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('allowed_agents[1]');
    expect(parsed.error).toContain('must be a string');
    expect(ft.calls).toHaveLength(0);
  });

  it('round 2: fails fast when allowed_agents contains an empty / whitespace-only entry', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-empty-entry', {
      id: 'empty-entry',
      name: 'EmptyEntry',
      allowed_agents: ['0x' + 'a'.repeat(40), '   '],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('allowed_agents[1]');
    expect(parsed.error).toMatch(/empty|whitespace/i);
    expect(ft.calls).toHaveLength(0);
  });

  it('round 2: fails fast when allowed_agents contains null', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-null', {
      id: 'null-entry',
      name: 'Null',
      allowed_agents: ['0x' + 'a'.repeat(40), null as unknown as string],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('allowed_agents[1]');
    expect(ft.calls).toHaveLength(0);
  });

  it('round 2: fails fast when allowed_agents is not an array', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-not-array', {
      id: 'not-array',
      name: 'NotArray',
      allowed_agents: '0x1234' as unknown as string[],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('"allowed_agents"');
    expect(parsed.error).toContain('array');
    expect(ft.calls).toHaveLength(0);
  });

  it('round 2: fails fast when public is a non-boolean value', async () => {
    // An LLM emitting `public: "yes"` or `public: 1` should NOT
    // silently produce a curated CG (which is the opposite of intent).
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-public-string', {
      id: 'public-string',
      name: 'PublicString',
      public: 'yes' as unknown as boolean,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('"public"');
    expect(parsed.error).toContain('boolean');
    expect(ft.calls).toHaveLength(0);
  });

  it('round 2: fails fast when public is a number', async () => {
    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-public-number', {
      id: 'public-number',
      name: 'PublicNumber',
      public: 1 as unknown as boolean,
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toContain('"public"');
    expect(ft.calls).toHaveLength(0);
  });

  it('skips allowed_agents validation entirely when public:true is passed', async () => {
    // Curation parameters are dropped on public CGs, so even malformed
    // entries do not produce an error — they're simply ignored.
    ft.addResponses(
      new Response(JSON.stringify({ created: 'open-skip', uri: 'did:dkg:context-graph:open-skip' }), { status: 200 }),
    );

    const tool = findTool('dkg_context_graph_create');
    const result = await tool.execute('call-public-malformed', {
      id: 'open-skip',
      name: 'Open Skip',
      public: true,
      allowed_agents: ['not-an-address'],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeUndefined();
    const body = JSON.parse(ft.calls[0][1]?.body as string);
    expect(body.allowedAgents).toBeUndefined();
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
        subscribed: 'my-contextGraph',
        catchup: { jobId: 'job-1', status: 'queued', includeSharedMemory: true },
      }), { status: 200 }),
    );

    const tool = findTool('dkg_subscribe');
    const result = await tool.execute('call-1', { context_graph_id: 'my-contextGraph' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.subscribed).toBe('my-contextGraph');
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
    await tool.execute('call-3', { context_graph_id: 'p1', include_shared_memory: false });

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
      new Response(JSON.stringify({ assertionUri: 'urn:assertion:test' }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-1', kas: [] }), { status: 200 }),
    );

    const tool = findTool('dkg_publish');
    const result = await tool.execute('call-1', { context_graph_id: 'testing', quads: VALID_QUADS });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.kcId).toBe('kc-1');
    expect(parsed.quadsPublished).toBe(1);

    // V10 assertion lifecycle: the publish flow now creates a finalized
    // assertion (`/api/assertion/create` with `finalize: true`) and then
    // promotes it via `/api/shared-memory/publish`. The legacy
    // `/api/shared-memory/write` route was removed in Phase B-1.
    expect(ft.calls).toHaveLength(2);
    const createUrl = ft.calls[0][0] as string;
    expect(createUrl).toContain('/api/assertion/create');
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
