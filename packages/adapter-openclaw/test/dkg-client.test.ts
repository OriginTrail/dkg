import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DkgDaemonClient } from '../src/dkg-client.js';

describe('DkgDaemonClient', () => {
  let client: DkgDaemonClient;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
  });

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.doUnmock('node:os');
    vi.doUnmock('node:path');
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
    const existsSync = vi.fn().mockReturnValue(true);
    const homedir = vi.fn().mockReturnValue('/fake-home');
    vi.doMock('node:fs', () => ({ readFileSync, existsSync }));
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

  it('query should pass contextGraphId option', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await client.query('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'agent-context' });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.contextGraphId).toBe('agent-context');
  });

  it('query should forward view + agentAddress + assertionName for WM reads', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await client.query('SELECT * WHERE { ?s ?p ?o }', {
      contextGraphId: 'agent-context',
      view: 'working-memory',
      agentAddress: 'did:dkg:agent:test',
      assertionName: 'chat-turns',
      subGraphName: 'protocols',
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.view).toBe('working-memory');
    expect(body.agentAddress).toBe('did:dkg:agent:test');
    expect(body.assertionName).toBe('chat-turns');
    expect(body.subGraphName).toBe('protocols');
  });

  // ---------------------------------------------------------------------------
  // Workspace write
  // ---------------------------------------------------------------------------

  it('share should POST quads to /api/shared-memory/write with localOnly defaulted to true', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ shareOperationId: 'op-1' }), { status: 200 }),
    );

    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"hello"' }];
    await client.share('research-x', quads);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.contextGraphId).toBe('research-x');
    expect(body.quads).toHaveLength(1);
    expect(body.localOnly).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Working Memory assertion lifecycle
  // ---------------------------------------------------------------------------

  it('createAssertion should POST to /api/assertion/create', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ assertionUri: 'urn:test:assertion:1' }), { status: 200 }),
    );

    const result = await client.createAssertion('agent-context', 'chat-turns');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/assertion/create');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.contextGraphId).toBe('agent-context');
    expect(body.name).toBe('chat-turns');
    expect(body.subGraphName).toBeUndefined();
    expect(result).toEqual({ assertionUri: 'urn:test:assertion:1', alreadyExists: false });
  });

  it('createAssertion should swallow 400 "already exists" into alreadyExists:true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Assertion "chat-turns" already exists in context graph "agent-context"' }), { status: 400 }),
    );

    const result = await client.createAssertion('agent-context', 'chat-turns');
    expect(result.alreadyExists).toBe(true);
    expect(result.assertionUri).toBeNull();
  });

  it('createAssertion should propagate non-"already exists" errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid "name": contains reserved characters' }), { status: 400 }),
    );

    await expect(client.createAssertion('agent-context', 'bad name')).rejects.toThrow(/Invalid/);
  });

  it('createAssertion should forward subGraphName when supplied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ assertionUri: 'urn:test:assertion:2' }), { status: 200 }),
    );

    await client.createAssertion('research-x', 'memory', { subGraphName: 'protocols' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.subGraphName).toBe('protocols');
  });

  it('writeAssertion should POST to /api/assertion/:name/write with URL-encoded name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ written: 3 }), { status: 200 }),
    );

    const quads = [
      { subject: 'urn:a', predicate: 'urn:b', object: '"c"' },
      { subject: 'urn:a', predicate: 'urn:d', object: '"e"' },
      { subject: 'urn:a', predicate: 'urn:f', object: '"g"' },
    ];
    const result = await client.writeAssertion('agent-context', 'chat-turns', quads);

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/assertion/chat-turns/write');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.contextGraphId).toBe('agent-context');
    expect(body.quads).toHaveLength(3);
    expect(body.subGraphName).toBeUndefined();
    expect(result).toEqual({ written: 3 });
  });

  it('writeAssertion should forward subGraphName when supplied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ written: 1 }), { status: 200 }),
    );

    await client.writeAssertion('research-x', 'memory', [
      { subject: 'urn:m', predicate: 'urn:p', object: '"v"' },
    ], { subGraphName: 'protocols' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.subGraphName).toBe('protocols');
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

  it('storeChatTurn preserves an explicit false semantic-enrichment runtime header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    client.setLocalAgentRequestContext({
      integrationId: 'openclaw',
      semanticEnrichmentSupported: false,
    });

    await client.storeChatTurn('session-2', 'Hello', 'Hi there', { turnId: 'turn-2' });

    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-DKG-Local-Agent-Integration': 'openclaw',
      'X-DKG-Local-Agent-Semantic-Enrichment': 'false',
    });
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

  it('publish should write to SWM then publish from SWM', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ triplesWritten: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kcId: 'kc-1' }), { status: 200 }));

    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"value"' }];
    const result = await client.publish('testing', quads);
    expect(result.kcId).toBe('kc-1');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [writeUrl, writeOpts] = fetchSpy.mock.calls[0];
    expect(writeUrl).toBe('http://localhost:9200/api/shared-memory/write');
    expect(writeOpts?.method).toBe('POST');
    const writeBody = JSON.parse(writeOpts?.body as string);
    expect(writeBody.contextGraphId).toBe('testing');
    expect(writeBody.quads).toHaveLength(1);

    const [pubUrl, pubOpts] = fetchSpy.mock.calls[1];
    expect(pubUrl).toBe('http://localhost:9200/api/shared-memory/publish');
    expect(pubOpts?.method).toBe('POST');
    const pubBody = JSON.parse(pubOpts?.body as string);
    expect(pubBody.contextGraphId).toBe('testing');
    expect(pubBody.selection).toBe('all');
  });

  it('publish should reject privateQuads', async () => {
    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"public"' }];
    const privateQuads = [{ subject: 'urn:a', predicate: 'urn:c', object: '"secret"' }];
    await expect(client.publish('testing', quads, privateQuads)).rejects.toThrow(
      /not supported in V10/,
    );
  });

  it('publish should reject accessPolicy and allowedPeers', async () => {
    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"val"' }];
    await expect(
      client.publish('testing', quads, undefined, {
        accessPolicy: 'allowList',
        allowedPeers: ['12D3peer1', '12D3peer2'],
      }),
    ).rejects.toThrow(/not supported in V10/);
  });

  // ---------------------------------------------------------------------------
  // Paranets
  // ---------------------------------------------------------------------------

  it('listContextGraphs should GET /api/context-graph/list', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ contextGraphs: [{ id: 'p1' }, { id: 'p2' }] }), { status: 200 }),
    );

    const result = await client.listContextGraphs();
    expect(result.contextGraphs).toHaveLength(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/context-graph/list');
  });

  it('createContextGraph should POST to /api/context-graph/create', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ created: 'my-research', uri: 'did:dkg:context-graph:my-research' }), { status: 200 }),
    );

    const result = await client.createContextGraph('my-research', 'My Research', 'A research context graph');
    expect(result.created).toBe('my-research');
    expect(result.uri).toBe('did:dkg:context-graph:my-research');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/context-graph/create');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.id).toBe('my-research');
    expect(body.name).toBe('My Research');
    expect(body.description).toBe('A research context graph');
  });

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  it('subscribe should POST to /api/subscribe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        subscribed: 'my-paranet',
        catchup: { jobId: 'job-1', status: 'queued', includeSharedMemory: true },
      }), { status: 200 }),
    );

    const result = await client.subscribe('my-paranet');
    expect(result.subscribed).toBe('my-paranet');
    expect(result.catchup.jobId).toBe('job-1');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/subscribe');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.contextGraphId).toBe('my-paranet');
  });

  it('subscribe passes includeSharedMemory option', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ subscribed: 'p1', catchup: { jobId: 'j', status: 'queued', includeSharedMemory: false } }), { status: 200 }),
    );

    await client.subscribe('p1', { includeSharedMemory: false });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.includeSharedMemory).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Wallet balances
  // ---------------------------------------------------------------------------

  it('getWalletBalances should GET /api/wallets/balances', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        wallets: ['0xabc'],
        balances: [{ address: '0xabc', eth: '1.5', trac: '1000.0', symbol: 'TRAC' }],
        chainId: '31337',
        rpcUrl: 'http://localhost:8545',
      }), { status: 200 }),
    );

    const result = await client.getWalletBalances();
    expect(result.wallets).toEqual(['0xabc']);
    expect(result.balances).toHaveLength(1);
    expect(result.balances[0].trac).toBe('1000.0');
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:9200/api/wallets/balances');
    expect(fetchSpy.mock.calls[0][1]?.method).toBe('GET');
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
