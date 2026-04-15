import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DkgDaemonClient } from '../src/dkg-client.js';

describe('DkgDaemonClient', () => {
  let client: DkgDaemonClient;
  let originalFetch: typeof fetch;
  let fetchCalls: Array<[RequestInfo | URL, RequestInit | undefined]>;
  let fetchResponses: Array<Response | Error>;
  let fetchIdx: number;

  beforeEach(() => {
    client = new DkgDaemonClient({ baseUrl: 'http://localhost:9200' });
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    fetchResponses = [];
    fetchIdx = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push([input, init]);
      const r = fetchResponses[fetchIdx++];
      if (r instanceof Error) throw r;
      return r;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

  it('uses an explicit API token in authorization headers', async () => {
    const authedClient = new DkgDaemonClient({
      baseUrl: 'http://localhost:9200',
      apiToken: 'secret-token',
    });

    fetchResponses.push(
      new Response(JSON.stringify({ peerId: '12D3auto' }), { status: 200 }),
    );

    await authedClient.getStatus();

    expect(fetchCalls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer secret-token',
    });
  });

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  it('getStatus should return ok:true on success', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ peerId: '12D3KooW...' }), { status: 200 }),
    );

    const status = await client.getStatus();
    expect(status.ok).toBe(true);
    expect(status.peerId).toBe('12D3KooW...');
  });

  it('getStatus should return ok:false on failure', async () => {
    fetchResponses.push(new Error('Connection refused'));

    const status = await client.getStatus();
    expect(status.ok).toBe(false);
    expect(status.error).toBe('Connection refused');
  });

  it('getFullStatus should GET /api/status', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ peerId: '12D3...', uptime: 1234 }), { status: 200 }),
    );

    const result = await client.getFullStatus();
    expect(result.peerId).toBe('12D3...');
    expect(result.uptime).toBe(1234);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/status');
    expect(fetchCalls[0][1]?.method).toBe('GET');
  });

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  it('query should POST to /api/query', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 }),
    );

    await client.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1');

    expect(fetchCalls).toHaveLength(1);
    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/query');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.sparql).toContain('SELECT');
  });

  it('query should pass contextGraphId option', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await client.query('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'agent-memory' });

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.contextGraphId).toBe('agent-memory');
  });

  // ---------------------------------------------------------------------------
  // Workspace write
  // ---------------------------------------------------------------------------

  it('share should POST quads', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ shareOperationId: 'op-1' }), { status: 200 }),
    );

    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"hello"' }];
    await client.share('agent-memory', quads);

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.contextGraphId).toBe('agent-memory');
    expect(body.quads).toHaveLength(1);
    expect(body.localOnly).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Memory import
  // ---------------------------------------------------------------------------

  it('importMemories should POST to /api/memory/import', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ batchId: 'b1', memoryCount: 3, tripleCount: 12 }), { status: 200 }),
    );

    const result = await client.importMemories('Some memories', 'claude', { useLlm: true });
    expect(result.batchId).toBe('b1');

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.text).toBe('Some memories');
    expect(body.source).toBe('claude');
    expect(body.useLlm).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Chat turn persistence
  // ---------------------------------------------------------------------------

  it('storeChatTurn should POST to /api/openclaw-channel/persist-turn', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await client.storeChatTurn('session-1', 'Hello', 'Hi there', { turnId: 'turn-1' });

    const [url, opts] = fetchCalls[0];
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
    fetchResponses.push(
      new Response(JSON.stringify({ initialized: true, messageCount: 5, totalTriples: 100 }), { status: 200 }),
    );

    const stats = await client.getMemoryStats();
    expect(stats.initialized).toBe(true);
    expect(stats.messageCount).toBe(5);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/memory/stats');
  });

  // ---------------------------------------------------------------------------
  // Agents & skills discovery
  // ---------------------------------------------------------------------------

  it('getAgents should GET /api/agents', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ agents: [{ name: 'agent-1', peerId: '12D3...' }] }), { status: 200 }),
    );

    const result = await client.getAgents();
    expect(result.agents).toHaveLength(1);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/agents');
  });

  it('getAgents passes framework and skill_type filters', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ agents: [] }), { status: 200 }),
    );

    await client.getAgents({ framework: 'OpenClaw', skill_type: 'ImageAnalysis' });
    const url = fetchCalls[0][0] as string;
    expect(url).toContain('framework=OpenClaw');
    expect(url).toContain('skill_type=ImageAnalysis');
  });

  it('getSkills should GET /api/skills', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ skills: [{ uri: 'ImageAnalysis' }] }), { status: 200 }),
    );

    const result = await client.getSkills();
    expect(result.skills).toHaveLength(1);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/skills');
  });

  it('getSkills passes skillType filter', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ skills: [] }), { status: 200 }),
    );

    await client.getSkills({ skillType: 'TextSummary' });
    const url = fetchCalls[0][0] as string;
    expect(url).toContain('skillType=TextSummary');
  });

  // ---------------------------------------------------------------------------
  // P2P messaging
  // ---------------------------------------------------------------------------

  it('sendChat should POST to /api/chat', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ sent: true }), { status: 200 }),
    );

    const result = await client.sendChat('12D3KooW...', 'Hello, agent!');
    expect(result.sent).toBe(true);

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/chat');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.to).toBe('12D3KooW...');
    expect(body.text).toBe('Hello, agent!');
  });

  it('getMessages should GET /api/messages', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ messages: [{ from: 'peer1', text: 'Hi' }] }), { status: 200 }),
    );

    const result = await client.getMessages();
    expect(result.messages).toHaveLength(1);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/messages');
  });

  it('getMessages passes peer, limit, and since filters', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    );

    await client.getMessages({ peer: '12D3peer', limit: 10, since: 1710000000000 });
    const url = fetchCalls[0][0] as string;
    expect(url).toContain('peer=12D3peer');
    expect(url).toContain('limit=10');
    expect(url).toContain('since=1710000000000');
  });

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------

  it('publish should write to SWM then publish from SWM', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ triplesWritten: 1 }), { status: 200 }),
      new Response(JSON.stringify({ kcId: 'kc-1' }), { status: 200 }),
    );

    const quads = [{ subject: 'urn:a', predicate: 'urn:b', object: '"value"' }];
    const result = await client.publish('testing', quads);
    expect(result.kcId).toBe('kc-1');

    expect(fetchCalls).toHaveLength(2);
    const [writeUrl, writeOpts] = fetchCalls[0];
    expect(writeUrl).toBe('http://localhost:9200/api/shared-memory/write');
    expect(writeOpts?.method).toBe('POST');
    const writeBody = JSON.parse(writeOpts?.body as string);
    expect(writeBody.contextGraphId).toBe('testing');
    expect(writeBody.quads).toHaveLength(1);

    const [pubUrl, pubOpts] = fetchCalls[1];
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
    fetchResponses.push(
      new Response(JSON.stringify({ contextGraphs: [{ id: 'p1' }, { id: 'p2' }] }), { status: 200 }),
    );

    const result = await client.listContextGraphs();
    expect(result.contextGraphs).toHaveLength(2);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/context-graph/list');
  });

  it('createContextGraph should POST to /api/context-graph/create', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ created: 'my-research', uri: 'did:dkg:context-graph:my-research' }), { status: 200 }),
    );

    const result = await client.createContextGraph('my-research', 'My Research', 'A research context graph');
    expect(result.created).toBe('my-research');
    expect(result.uri).toBe('did:dkg:context-graph:my-research');

    const [url, opts] = fetchCalls[0];
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
    fetchResponses.push(
      new Response(JSON.stringify({
        subscribed: 'my-paranet',
        catchup: { jobId: 'job-1', status: 'queued', includeSharedMemory: true },
      }), { status: 200 }),
    );

    const result = await client.subscribe('my-paranet');
    expect(result.subscribed).toBe('my-paranet');
    expect(result.catchup.jobId).toBe('job-1');

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/subscribe');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.contextGraphId).toBe('my-paranet');
  });

  it('subscribe passes includeSharedMemory option', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ subscribed: 'p1', catchup: { jobId: 'j', status: 'queued', includeSharedMemory: false } }), { status: 200 }),
    );

    await client.subscribe('p1', { includeSharedMemory: false });

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.includeSharedMemory).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Wallet balances
  // ---------------------------------------------------------------------------

  it('getWalletBalances should GET /api/wallets/balances', async () => {
    fetchResponses.push(
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
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/wallets/balances');
    expect(fetchCalls[0][1]?.method).toBe('GET');
  });

  // ---------------------------------------------------------------------------
  // Skill invocation
  // ---------------------------------------------------------------------------

  it('invokeSkill should POST to /api/invoke-skill', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ success: true, output: 'result data' }), { status: 200 }),
    );

    const result = await client.invokeSkill('12D3peer', 'ImageAnalysis', 'analyze this');
    expect(result.success).toBe(true);
    expect(result.output).toBe('result data');

    const [url, opts] = fetchCalls[0];
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
    fetchResponses.push(
      new Response(JSON.stringify({ wallets: ['0xabc', '0xdef'] }), { status: 200 }),
    );

    const result = await client.getWallets();
    expect(result.wallets).toEqual(['0xabc', '0xdef']);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/wallets');
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('should throw on non-ok response', async () => {
    fetchResponses.push(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(client.query('bad query')).rejects.toThrow('DKG daemon /api/query responded 500');
  });

  it('getAuthToken returns the loaded token or undefined', () => {
    const token = client.getAuthToken();
    expect(token === undefined || typeof token === 'string').toBe(true);
  });
});
