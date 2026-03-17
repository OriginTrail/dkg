import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type DkgDaemonClientCtor = typeof import('../src/dkg-client.js').DkgDaemonClient;

describe('DkgDaemonClient', () => {
  let DkgDaemonClient: DkgDaemonClientCtor;
  let client: InstanceType<DkgDaemonClientCtor>;

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:os');
    vi.doUnmock('node:path');
    ({ DkgDaemonClient } = await import('../src/dkg-client.js'));
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Constructor & auth
  // ---------------------------------------------------------------------------

  it('should use default base URL', () => {
    const defaultClient = new DkgDaemonClient();
    expect(defaultClient.baseUrl).toBe('http://127.0.0.1:9200');
  });

  it('should strip trailing slashes from base URL', () => {
    const c = new DkgDaemonClient({ baseUrl: 'http://localhost:9200///' });
    expect(c.baseUrl).toBe('http://localhost:9200');
  });

  it('auto-loads the daemon auth token from ~/.dkg/auth.token', async () => {
    const readFileSync = vi.fn().mockReturnValue('# comment\nsecret-token\n');
    const homedir = vi.fn().mockReturnValue('/fake-home');
    vi.doMock('node:fs', () => ({ readFileSync }));
    vi.doMock('node:os', () => ({ homedir }));
    vi.resetModules();

    const { DkgDaemonClient: FreshClient } = await import('../src/dkg-client.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ peerId: '12D3auto' }), { status: 200 }),
    );

    const authedClient = new FreshClient({ baseUrl: 'http://localhost:9200' });
    await authedClient.getStatus();

    expect(readFileSync.mock.calls[0]?.[0]).toContain('fake-home');
    expect(readFileSync.mock.calls[0]?.[0]).toContain('.dkg');
    expect(readFileSync.mock.calls[0]?.[0]).toContain('auth.token');
    expect(readFileSync.mock.calls[0]?.[1]).toBe('utf-8');
    expect(homedir).toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer secret-token',
    });
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  it('getStatus should return ok:true on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ peerId: '12D3KooW...' }), { status: 200 }),
    );

    const status = await client.getStatus();
    expect(status.ok).toBe(true);
    expect(status.peerId).toBe('12D3KooW...');
  });

  it('getStatus should return ok:false on failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));

    const status = await client.getStatus();
    expect(status.ok).toBe(false);
    expect(status.error).toBe('Connection refused');
  });

  it('getFullStatus should GET /api/status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ peerId: '12D3...', uptime: 1234 }), { status: 200 }),
    );

    const result = await client.getFullStatus();
    expect(result.peerId).toBe('12D3...');
    expect(result.uptime).toBe(1234);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/status');
    expect(fetchSpy.mock.calls[0][1]?.method).toBe('GET');
  });

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  it('query should POST to /api/query', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 }),
    );

    await client.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/query');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.sparql).toContain('SELECT');
  });

  it('query should pass paranetId option', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await client.query('SELECT * WHERE { ?s ?p ?o }', { paranetId: 'agent-memory' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.paranetId).toBe('agent-memory');
  });

  it('semanticSearch should POST to /api/semantic-search', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ subject: 'urn:s', score: 0.9 }] }), { status: 200 }),
    );

    const results = await client.semanticSearch('washing machine', { paranetId: 'agent-memory', topK: 5 });

    expect(results).toHaveLength(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/semantic-search');
    const body = JSON.parse(opts?.body as string);
    expect(body).toEqual(expect.objectContaining({
      query: 'washing machine',
      paranetId: 'agent-memory',
      topK: 5,
    }));
  });

  // ---------------------------------------------------------------------------
  // Workspace write
  // ---------------------------------------------------------------------------

  it('writeToWorkspace should POST quads', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ workspaceOperationId: 'op-1' }), { status: 200 }),
    );

    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"hello"' }];
    await client.writeToWorkspace('agent-memory', quads);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.paranetId).toBe('agent-memory');
    expect(body.quads).toHaveLength(1);
    expect(body.localOnly).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Memory import
  // ---------------------------------------------------------------------------

  it('importMemories should POST to /api/memory/import', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ batchId: 'b1', memoryCount: 3, tripleCount: 12 }), { status: 200 }),
    );

    const result = await client.importMemories('Some memories', 'claude', { useLlm: true });
    expect(result.batchId).toBe('b1');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.text).toBe('Some memories');
    expect(body.source).toBe('claude');
    expect(body.useLlm).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Chat turn persistence
  // ---------------------------------------------------------------------------

  it('storeChatTurn should POST to /api/openclaw-channel/persist-turn', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await client.storeChatTurn('session-1', 'Hello', 'Hi there', { turnId: 'turn-1' });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/openclaw-channel/persist-turn');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.sessionId).toBe('session-1');
    expect(body.userMessage).toBe('Hello');
    expect(body.assistantReply).toBe('Hi there');
    expect(body.turnId).toBe('turn-1');
  });

  // ---------------------------------------------------------------------------
  // Memory stats
  // ---------------------------------------------------------------------------

  it('getMemoryStats should GET /api/memory/stats', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ initialized: true, messageCount: 5, totalTriples: 100 }), { status: 200 }),
    );

    const stats = await client.getMemoryStats();
    expect(stats.initialized).toBe(true);
    expect(stats.messageCount).toBe(5);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/memory/stats');
  });

  // ---------------------------------------------------------------------------
  // Agents & skills discovery
  // ---------------------------------------------------------------------------

  it('getAgents should GET /api/agents', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ agents: [{ name: 'agent-1', peerId: '12D3...' }] }), { status: 200 }),
    );

    const result = await client.getAgents();
    expect(result.agents).toHaveLength(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/agents');
  });

  it('getAgents passes framework and skill_type filters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ agents: [] }), { status: 200 }),
    );

    await client.getAgents({ framework: 'OpenClaw', skill_type: 'ImageAnalysis' });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('framework=OpenClaw');
    expect(url).toContain('skill_type=ImageAnalysis');
  });

  it('getSkills should GET /api/skills', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ skills: [{ uri: 'ImageAnalysis' }] }), { status: 200 }),
    );

    const result = await client.getSkills();
    expect(result.skills).toHaveLength(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/skills');
  });

  it('getSkills passes skillType filter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ skills: [] }), { status: 200 }),
    );

    await client.getSkills({ skillType: 'TextSummary' });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('skillType=TextSummary');
  });

  // ---------------------------------------------------------------------------
  // P2P messaging
  // ---------------------------------------------------------------------------

  it('sendChat should POST to /api/chat', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ sent: true }), { status: 200 }),
    );

    const result = await client.sendChat('12D3KooW...', 'Hello, agent!');
    expect(result.sent).toBe(true);

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/chat');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.to).toBe('12D3KooW...');
    expect(body.text).toBe('Hello, agent!');
  });

  it('getMessages should GET /api/messages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [{ from: 'peer1', text: 'Hi' }] }), { status: 200 }),
    );

    const result = await client.getMessages();
    expect(result.messages).toHaveLength(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/messages');
  });

  it('getMessages passes peer, limit, and since filters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    await client.getMessages({ peer: '12D3peer', limit: 10, since: 1710000000000 });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('peer=12D3peer');
    expect(url).toContain('limit=10');
    expect(url).toContain('since=1710000000000');
  });

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  it('publish should POST to /api/publish', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ kcId: 'kc-1' }), { status: 200 }),
    );

    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"value"' }];
    const result = await client.publish('testing', quads);
    expect(result.kcId).toBe('kc-1');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/publish');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.paranetId).toBe('testing');
    expect(body.quads).toHaveLength(1);
  });

  it('publish should pass privateQuads', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ kcId: 'kc-2' }), { status: 200 }),
    );

    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"public"' }];
    const privateQuads = [{ subject: 'urn:a', predicate: 'urn:c', object: '"secret"' }];
    await client.publish('testing', quads, privateQuads);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.privateQuads).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Paranets
  // ---------------------------------------------------------------------------

  it('listParanets should GET /api/paranet/list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ paranets: [{ id: 'p1' }, { id: 'p2' }] }), { status: 200 }),
    );

    const result = await client.listParanets();
    expect(result.paranets).toHaveLength(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/paranet/list');
  });

  // ---------------------------------------------------------------------------
  // Skill invocation
  // ---------------------------------------------------------------------------

  it('invokeSkill should POST to /api/invoke-skill', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, output: 'result data' }), { status: 200 }),
    );

    const result = await client.invokeSkill('12D3peer', 'ImageAnalysis', 'analyze this');
    expect(result.success).toBe(true);
    expect(result.output).toBe('result data');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/invoke-skill');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.peerId).toBe('12D3peer');
    expect(body.skillUri).toBe('ImageAnalysis');
    expect(body.input).toBe('analyze this');
  });

  // ---------------------------------------------------------------------------
  // Wallets
  // ---------------------------------------------------------------------------

  it('getWallets should GET /api/wallets', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ wallets: ['0xabc', '0xdef'] }), { status: 200 }),
    );

    const result = await client.getWallets();
    expect(result.wallets).toEqual(['0xabc', '0xdef']);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/wallets');
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('should throw on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(client.query('bad query')).rejects.toThrow('DKG daemon /api/query responded 500');
  });

  it('getAuthToken returns the loaded token or undefined', () => {
    // May be a real token if ~/.dkg/auth.token exists on this machine
    const token = client.getAuthToken();
    expect(token === undefined || typeof token === 'string').toBe(true);
  });
});
