import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  it('getAgentIdentity uses constructor auth headers', async () => {
    const authedClient = new DkgDaemonClient({
      baseUrl: 'http://localhost:9200',
      apiToken: 'node-token',
    });

    fetchResponses.push(
      new Response(JSON.stringify({
        agentAddress: '0x1234567890123456789012345678901234567890',
        agentDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
        name: 'default-agent',
        peerId: '12D3KooWPeer',
        nodeIdentityId: '7',
      }), { status: 200 }),
    );

    const result = await authedClient.getAgentIdentity();

    expect(result.ok).toBe(true);
    expect(result.identity?.agentAddress).toBe('0x1234567890123456789012345678901234567890');
    expect(fetchCalls[0]?.[0]).toBe('http://localhost:9200/api/agent/identity');
    expect(fetchCalls[0]?.[1]?.method).toBe('GET');
    expect(fetchCalls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer node-token',
    });
  });

  it('getAgentIdentity works without Authorization when daemon auth is disabled', async () => {
    const noAuthClient = new DkgDaemonClient({
      baseUrl: 'http://localhost:9200',
      apiToken: '',
    });

    fetchResponses.push(
      new Response(JSON.stringify({
        agentAddress: '12D3KooWPeerFallback',
        agentDid: 'did:dkg:agent:12D3KooWPeerFallback',
        name: 'default-agent',
        peerId: '12D3KooWPeerFallback',
        nodeIdentityId: '0',
      }), { status: 200 }),
    );

    const result = await noAuthClient.getAgentIdentity();

    expect(result.ok).toBe(true);
    expect(result.identity?.agentAddress).toBe('12D3KooWPeerFallback');
    expect(fetchCalls[0]?.[0]).toBe('http://localhost:9200/api/agent/identity');
    expect(fetchCalls[0]?.[1]?.headers).toMatchObject({ Accept: 'application/json' });
    expect(fetchCalls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
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

    await client.query('SELECT * WHERE { ?s ?p ?o }', { contextGraphId: 'agent-context' });

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.contextGraphId).toBe('agent-context');
  });

  it('writeQueryCatalog sends catalog quads to the dedicated endpoint', async () => {
    fetchResponses.push(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const quads = [{ subject: 'urn:q', predicate: 'urn:p', object: '"value"', graph: '' }];

    await client.writeQueryCatalog('agent-context', quads);

    expect(fetchCalls[0]?.[0]).toBe('http://localhost:9200/api/profile/query-catalog/write');
    expect(JSON.parse(fetchCalls[0]?.[1]?.body as string)).toEqual({
      contextGraphId: 'agent-context',
      quads,
    });
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

  it('getChatTurnStoreStatus queries chat-turn WM status and returns matching sessions', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({
        agentAddress: '0x1234567890123456789012345678901234567890',
        agentDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
        name: 'default-agent',
        peerId: '12D3KooWPeer',
        nodeIdentityId: '7',
      }), { status: 200 }),
      new Response(JSON.stringify({
        result: { bindings: [{ c: '"8"^^<http://www.w3.org/2001/XMLSchema#integer>' }] },
      }), { status: 200 }),
      new Response(JSON.stringify({
        result: { bindings: [{ sid: '"openclaw:tg:::sk-1"' }] },
      }), { status: 200 }),
    );

    const status = await client.getChatTurnStoreStatus([
      'openclaw:tg:::sk-1',
      'openclaw:tg:::missing',
    ]);

    expect(status).toEqual({
      hasAnyChatTurnData: true,
      existingSessionIds: ['openclaw:tg:::sk-1'],
    });
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[0][0]).toBe('http://localhost:9200/api/agent/identity');
    const countBody = JSON.parse(fetchCalls[1][1]?.body as string);
    expect(countBody).toMatchObject({
      contextGraphId: 'agent-context',
      view: 'working-memory',
      assertionName: 'chat-turns',
      agentAddress: '0x1234567890123456789012345678901234567890',
    });
    expect(countBody.sparql).toContain('COUNT(*) AS ?c');
    const sessionBody = JSON.parse(fetchCalls[2][1]?.body as string);
    expect(sessionBody).toMatchObject({
      contextGraphId: 'agent-context',
      view: 'working-memory',
      assertionName: 'chat-turns',
      agentAddress: '0x1234567890123456789012345678901234567890',
    });
    expect(sessionBody.sparql).toContain('VALUES ?sid');
    expect(sessionBody.sparql).toContain('"openclaw:tg:::sk-1"');
    expect(sessionBody.sparql).toContain('"openclaw:tg:::missing"');
  });

  it('getChatTurnStoreStatus returns empty status when chat-turn assertion has no data', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({
        agentAddress: '0x1234567890123456789012345678901234567890',
        agentDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
        name: 'default-agent',
        peerId: '12D3KooWPeer',
        nodeIdentityId: '7',
      }), { status: 200 }),
      new Response(JSON.stringify({
        results: { bindings: [{ c: { value: '0' } }] },
      }), { status: 200 }),
    );

    const status = await client.getChatTurnStoreStatus(['openclaw:tg:::sk']);

    expect(status).toEqual({ hasAnyChatTurnData: false, existingSessionIds: [] });
    expect(fetchCalls).toHaveLength(2);
  });

  it('getChatTurnStoreStatus returns empty status for missing chat-turn assertion/context', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({
        agentAddress: '0x1234567890123456789012345678901234567890',
        agentDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
        name: 'default-agent',
        peerId: '12D3KooWPeer',
        nodeIdentityId: '7',
      }), { status: 200 }),
      new Response(JSON.stringify({ error: 'Assertion chat-turns not found' }), { status: 404 }),
    );

    const status = await client.getChatTurnStoreStatus(['openclaw:tg:::sk']);

    expect(status).toEqual({ hasAnyChatTurnData: false, existingSessionIds: [] });
  });

  it('getChatTurnStoreStatus propagates unexpected daemon failures', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({
        agentAddress: '0x1234567890123456789012345678901234567890',
        agentDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
        name: 'default-agent',
        peerId: '12D3KooWPeer',
        nodeIdentityId: '7',
      }), { status: 200 }),
      new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
    );

    await expect(client.getChatTurnStoreStatus(['openclaw:tg:::sk']))
      .rejects
      .toThrow('responded 500');
  });

  it('getChatTurnStoreStatus propagates unrelated 404s instead of swallowing them as "no chat data"', async () => {
    // Regression: an early matcher accepted any 404 whose message mentioned
    // generic words like "context" or "graph", which would silently clear
    // local cursor state for unrelated daemon failures. The not-found check
    // must require the chat-turns assertion name specifically.
    fetchResponses.push(
      new Response(JSON.stringify({
        agentAddress: '0x1234567890123456789012345678901234567890',
        agentDid: 'did:dkg:agent:0x1234567890123456789012345678901234567890',
        name: 'default-agent',
        peerId: '12D3KooWPeer',
        nodeIdentityId: '7',
      }), { status: 200 }),
      new Response(JSON.stringify({ error: 'Context graph some-other-graph not found' }), { status: 404 }),
    );

    await expect(client.getChatTurnStoreStatus(['openclaw:tg:::sk']))
      .rejects
      .toThrow('responded 404');
  });

  // ---------------------------------------------------------------------------
  // Working Memory assertion lifecycle
  // ---------------------------------------------------------------------------

  it('createAssertion should POST to /api/knowledge-assets', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ assertionUri: 'urn:test:assertion:1' }), { status: 200 }),
    );

    const result = await client.createAssertion('agent-context', 'chat-turns');

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets');
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

  it('writeAssertion should POST to /api/knowledge-assets/:name/wm/write with URL-encoded name', async () => {
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
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/chat-turns/wm/write');
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
  // Parameter-name drift guards for the new assertion lifecycle + sub-graph
  // client methods. Each test asserts the daemon receives the exact camelCase
  // body / query-string keys the route handlers in packages/cli/src/daemon.ts
  // destructure, plus URL-encodes the assertion name.
  // ---------------------------------------------------------------------------

  it('promoteAssertion atomically shares without root selectors', async () => {
    fetchResponses.push(new Response(JSON.stringify({ swmShared: true, promotedCount: 1 }), { status: 200 }));

    await client.promoteAssertion('ctx', 'chat-turns', {
      subGraphName: 'protocols',
    });

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/chat-turns/swm/share');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body).toEqual({
      contextGraphId: 'ctx',
      subGraphName: 'protocols',
    });
  });

  it('promoteAssertion rejects root selection before HTTP', async () => {
    await expect(
      client.promoteAssertion('ctx', 'chat-turns', { entities: ['urn:a'] }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    await expect(
      client.promoteAssertion('ctx', 'chat-turns', { entities: 'urn:not-all' as any }),
    ).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('promoteAssertion URL-encodes assertion names containing slashes or spaces', async () => {
    fetchResponses.push(new Response(JSON.stringify({}), { status: 200 }));
    await client.promoteAssertion('ctx', 'weird name/with slash');
    expect(String(fetchCalls[0][0])).toBe('http://localhost:9200/api/knowledge-assets/weird%20name%2Fwith%20slash/swm/share');
  });

  it('discardAssertion hits /api/knowledge-assets/:name/wm/discard with camelCase body', async () => {
    fetchResponses.push(new Response(JSON.stringify({ discarded: true }), { status: 200 }));

    await client.discardAssertion('ctx', 'draft', { subGraphName: 'scratch' });

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/draft/wm/discard');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body).toEqual({ contextGraphId: 'ctx', subGraphName: 'scratch' });
  });

  it('queryAssertion hits /api/knowledge-assets/:name/wm/quads as GET with { contextGraphId, subGraphName } query params', async () => {
    fetchResponses.push(new Response(JSON.stringify({ quads: [], count: 0 }), { status: 200 }));

    await client.queryAssertion('ctx', 'chat-turns', { subGraphName: 'protocols' });

    const [url, opts] = fetchCalls[0];
    expect(opts?.method ?? 'GET').toBe('GET');
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/knowledge-assets/chat-turns/wm/quads');
    expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
    expect(parsed.searchParams.get('subGraphName')).toBe('protocols');
    expect(parsed.searchParams.get('sparql')).toBeNull();
    expect(opts?.body).toBeUndefined();
  });

  it('resolveImportArtifact POSTs the completed ref to the resolver route', async () => {
    fetchResponses.push(new Response(JSON.stringify({ artifact: { assertionUri: 'urn:assertion' } }), { status: 200 }));

    await client.resolveImportArtifact({
      contextGraphId: 'ctx',
      assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
      fileHash: `sha256:${'a'.repeat(64)}`,
      subGraphName: 'protocols',
    });

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/import-artifact/resolve');
    expect(opts?.method).toBe('POST');
    expect(JSON.parse(opts?.body as string)).toEqual({
      contextGraphId: 'ctx',
      assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
      fileHash: `sha256:${'a'.repeat(64)}`,
      subGraphName: 'protocols',
    });
  });

  it('readImportArtifactMarkdown POSTs maxBytes to the safe markdown read route', async () => {
    fetchResponses.push(new Response(JSON.stringify({ markdown: '# Doc' }), { status: 200 }));

    await client.readImportArtifactMarkdown({
      contextGraphId: 'ctx',
      assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
      maxBytes: 4096,
    });

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/import-artifact/read-markdown');
    expect(opts?.method).toBe('POST');
    expect(JSON.parse(opts?.body as string)).toEqual({
      contextGraphId: 'ctx',
      assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
      maxBytes: 4096,
    });
  });

  it('writeSemanticEnrichment POSTs semantic quads without promotion flags', async () => {
    fetchResponses.push(new Response(JSON.stringify({ promoted: false, published: false }), { status: 200 }));

    await client.writeSemanticEnrichment({
      contextGraphId: 'ctx',
      assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
      semanticQuads: [
        { subject: 'urn:doc:1', predicate: 'http://schema.org/about', object: '"Topic"' },
      ],
      generationMethod: 'test-model',
      agentIdentity: 'did:dkg:agent:test',
      generatedAt: '2026-05-11T00:00:00.000Z',
    });

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/semantic-enrichment/write');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body).toEqual({
      contextGraphId: 'ctx',
      assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
      semanticQuads: [
        { subject: 'urn:doc:1', predicate: 'http://schema.org/about', object: '"Topic"' },
      ],
      generationMethod: 'test-model',
      agentIdentity: 'did:dkg:agent:test',
      generatedAt: '2026-05-11T00:00:00.000Z',
    });
    expect(body).not.toHaveProperty('name');
    expect(body).not.toHaveProperty('semanticAssertionName');
    expect(body).not.toHaveProperty('promote');
    expect(body).not.toHaveProperty('publish');
  });

  it('getAssertionHistory hits /api/knowledge-assets/:name as GET with camelCase query params', async () => {
    fetchResponses.push(new Response(JSON.stringify({ createdAt: 't' }), { status: 200 }));

    await client.getAssertionHistory('ctx', 'chat-turns', {
      agentAddress: '0xabc',
      subGraphName: 'protocols',
    });

    const [url, opts] = fetchCalls[0];
    expect(opts?.method ?? 'GET').toBe('GET');
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/knowledge-assets/chat-turns');
    expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
    expect(parsed.searchParams.get('agentAddress')).toBe('0xabc');
    expect(parsed.searchParams.get('subGraphName')).toBe('protocols');
    expect(opts?.body).toBeUndefined();
  });

  it('importAssertionFile hits /api/knowledge-assets/:name/wm/import-file as POST multipart with camelCase form fields', async () => {
    fetchResponses.push(new Response(JSON.stringify({ assertionUri: 'urn:x' }), { status: 200 }));

    const buf = new Uint8Array([1, 2, 3, 4]);
    await client.importAssertionFile('ctx', 'notes', buf, 'doc.md', {
      contentType: 'text/markdown',
      ontologyRef: 'urn:onto',
      subGraphName: 'protocols',
    });

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/wm/import-file');
    expect(opts?.method).toBe('POST');
    // `body` must be a FormData -- Node's fetch sets the multipart boundary automatically.
    expect(opts?.body).toBeInstanceOf(FormData);
    const form = opts?.body as FormData;
    expect(form.get('contextGraphId')).toBe('ctx');
    expect(form.get('contentType')).toBe('text/markdown');
    expect(form.get('ontologyRef')).toBe('urn:onto');
    expect(form.get('subGraphName')).toBe('protocols');
    const filePart = form.get('file');
    expect(filePart).toBeInstanceOf(Blob);
    expect((filePart as File).name).toBe('doc.md');
  });

  it('importAssertionFile omits optional form fields when not supplied', async () => {
    fetchResponses.push(new Response(JSON.stringify({}), { status: 200 }));

    await client.importAssertionFile('ctx', 'notes', new Uint8Array([1]), 'x.bin');

    const form = fetchCalls[0][1]?.body as FormData;
    expect(form.get('contextGraphId')).toBe('ctx');
    expect(form.has('contentType')).toBe(false);
    expect(form.has('ontologyRef')).toBe(false);
    expect(form.has('subGraphName')).toBe(false);
  });

  it('createSubGraph hits /api/sub-graph/create with camelCase body', async () => {
    fetchResponses.push(new Response(JSON.stringify({ created: 'protocols', contextGraphId: 'ctx' }), { status: 200 }));

    await client.createSubGraph('ctx', 'protocols');

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/sub-graph/create');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body).toEqual({ contextGraphId: 'ctx', subGraphName: 'protocols' });
  });

  it('listSubGraphs hits /api/sub-graph/list as GET with contextGraphId query param', async () => {
    fetchResponses.push(new Response(JSON.stringify({ contextGraphId: 'ctx', subGraphs: [] }), { status: 200 }));

    await client.listSubGraphs('ctx');

    const [url, opts] = fetchCalls[0];
    expect(opts?.method ?? 'GET').toBe('GET');
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/api/sub-graph/list');
    expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
    expect(opts?.body).toBeUndefined();
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

/**
   * Exact query-entry map — substring assertions are spoofable (a URL holding
   * `badconnectionStatus=connected` CONTAINS `connectionStatus=connected`),
   * and the wire parameter NAMES are the load-bearing contract here.
   */
  const queryEntries = (url: string): Record<string, string> =>
    Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));

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

    await client.getAgents({ framework: 'OpenClaw', skillType: 'ImageAnalysis' });
    expect(queryEntries(fetchCalls[0][0] as string)).toEqual({
      framework: 'OpenClaw',
      skill_type: 'ImageAnalysis',
    });
  });

  it('getAgents passes the GH#310 connection/local/pagination filters', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ agents: [], nextCursor: 'n1' }), { status: 200 }),
    );

    const result = await client.getAgents({
      connectionStatus: 'connected',
      local: true,
      limit: 10,
      cursor: 'cur-1',
    });
    // Exact entries: the camelCase/snake_case parameter NAMES are the contract.
    expect(queryEntries(fetchCalls[0][0] as string)).toEqual({
      connectionStatus: 'connected',
      local: 'true',
      limit: '10',
      cursor: 'cur-1',
    });
    expect(result.nextCursor).toBe('n1');
  });

  it('getAgentsUnvalidated serializes raw args verbatim AND surfaces the daemon 400', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ error: '"limit" must be a positive integer' }), { status: 400 }),
    );
    // The rejection IS the contract: if the client swallowed the 400 into
    // {agents: []}, malformed filters would look like successful empty
    // queries and the whole validation chain would be silent.
    await expect(client.getAgentsUnvalidated({
      framework: 'OpenClaw',
      skill_type: 'ImageAnalysis',
      connection_status: 'onnected',
      limit: '10junk',
      local: 'ture',
    })).rejects.toThrow(/responded 400.*positive integer/);
    // The pre-existing filters go through the SAME boundary as the new ones;
    // exact entries so a prefixed or renamed key cannot sneak past.
    expect(queryEntries(fetchCalls[0][0] as string)).toEqual({
      framework: 'OpenClaw',
      skill_type: 'ImageAnalysis',
      connectionStatus: 'onnected',
      limit: '10junk',
      local: 'ture',
    });
  });

  it('legacy skill_type callers keep working, and a conflicting pair is loud', async () => {
    fetchResponses.push(new Response(JSON.stringify({ agents: [] }), { status: 200 }));
    // Pre-GH#310 spelling, unchanged behavior on the wire.
    await client.getAgents({ skill_type: 'ImageAnalysis' });
    expect(queryEntries(fetchCalls[0][0] as string)).toEqual({ skill_type: 'ImageAnalysis' });
    // Both spellings with different values cannot silently pick one.
    await expect(client.getAgents({ skillType: 'A', skill_type: 'B' }))
      .rejects.toThrow(/Conflicting skill filters/);
  });

  it('a misspelled key and an empty cursor REACH the daemon instead of widening the query', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ error: 'Unknown query parameter "limt"' }), { status: 400 }),
    );
    // The whole point of the unvalidated path: nothing supplied may vanish.
    // A dropped `limt` would silently return the full ~150 KB registry; a
    // dropped empty cursor would silently serve page one.
    await expect(client.getAgentsUnvalidated({ limt: 5, cursor: '' }))
      .rejects.toThrow(/responded 400/);
    expect(queryEntries(fetchCalls[0][0] as string)).toEqual({
      limt: '5',
      cursor: '',
    });
  });

  it('typed and tool-originated requests share one wire mapping', async () => {
    fetchResponses.push(new Response(JSON.stringify({ agents: [] }), { status: 200 }));
    fetchResponses.push(new Response(JSON.stringify({ agents: [] }), { status: 200 }));
    await client.getAgents({ skillType: 'X', connectionStatus: 'connected', local: false, limit: 5 });
    await client.getAgentsUnvalidated({ skill_type: 'X', connection_status: 'connected', local: false, limit: 5 });
    const typedQs = (fetchCalls[0][0] as string).split('?')[1];
    const rawQs = (fetchCalls[1][0] as string).split('?')[1];
    expect(typedQs).toBe(rawQs);
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

  it('does not expose the retired direct explicit-quads publish helper', () => {
    expect((client as any).publish).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // ContextGraphs
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
    // No accessPolicy/allowedAgents passed when caller omits opts -- the
    // tool handler decides the default privacy-mode. The client itself
    // is parameter-passing only.
    expect(body.accessPolicy).toBeUndefined();
    expect(body.allowedAgents).toBeUndefined();
  });

  it('createContextGraph should pass accessPolicy when caller provides it', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ created: 'curated', uri: 'did:dkg:context-graph:curated' }), { status: 200 }),
    );

    await client.createContextGraph('curated', 'Curated', undefined, { accessPolicy: 1 });

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.accessPolicy).toBe(1);
    expect(body.allowedAgents).toBeUndefined();
  });

  it('createContextGraph should pass allowedAgents when caller provides them', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ created: 'team', uri: 'did:dkg:context-graph:team' }), { status: 200 }),
    );

    await client.createContextGraph('team', 'Team CG', undefined, {
      accessPolicy: 1,
      allowedAgents: ['0xAlice', '0xBob'],
    });

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.accessPolicy).toBe(1);
    expect(body.allowedAgents).toEqual(['0xAlice', '0xBob']);
  });

  it('createContextGraph should omit allowedAgents when array is empty', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({ created: 'solo', uri: 'did:dkg:context-graph:solo' }), { status: 200 }),
    );

    await client.createContextGraph('solo', 'Solo', undefined, {
      accessPolicy: 1,
      allowedAgents: [],
    });

    const body = JSON.parse(fetchCalls[0][1]?.body as string);
    expect(body.accessPolicy).toBe(1);
    // Empty array is dropped -- daemon distinguishes "no allowlist" from
    // "empty allowlist". Sending [] would unhelpfully pin an empty
    // allowlist when the agent's creator-auto-include logic should
    // populate it.
    expect(body.allowedAgents).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  it('subscribe should POST to /api/subscribe', async () => {
    fetchResponses.push(
      new Response(JSON.stringify({
        subscribed: 'my-contextGraph',
        catchup: { jobId: 'job-1', status: 'queued', includeSharedMemory: true },
      }), { status: 200 }),
    );

    const result = await client.subscribe('my-contextGraph');
    expect(result.subscribed).toBe('my-contextGraph');
    expect(result.catchup.jobId).toBe('job-1');

    const [url, opts] = fetchCalls[0];
    expect(url).toBe('http://localhost:9200/api/subscribe');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.contextGraphId).toBe('my-contextGraph');
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

  // -- OT-RFC-43 Section 10.5 -- GitHub-shaped Knowledge Asset client --------------
  describe('knowledge-assets surface', () => {
    const ok = (body: unknown = {}) =>
      fetchResponses.push(new Response(JSON.stringify(body), { status: 200 }));
    const url = (i = 0) => String(fetchCalls[i][0]);
    const body = (i = 0) => JSON.parse(String(fetchCalls[i][1]!.body));

    it('createKnowledgeAsset POSTs to /api/knowledge-assets with normalized cg + name', async () => {
      ok({ name: 'f' });
      await client.createKnowledgeAsset('cg-1', 'f', {
        quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
        alsoShareSwm: true,
      });
      expect(url()).toBe('http://localhost:9200/api/knowledge-assets');
      expect(fetchCalls[0][1]!.method).toBe('POST');
      expect(body()).toMatchObject({ contextGraphId: 'cg-1', name: 'f', alsoShareSwm: true });
    });

    it('createKnowledgeAsset forwards finalize:false for a draft-only write', async () => {
      ok({ name: 'f', written: 1, status: 'draft-open' });
      await client.createKnowledgeAsset('cg-1', 'f', {
        finalize: false,
        quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
      });
      expect(url()).toBe('http://localhost:9200/api/knowledge-assets');
      expect(body()).toMatchObject({ contextGraphId: 'cg-1', name: 'f', finalize: false });
    });

    it('createKnowledgeAsset omits finalize when unspecified, but defaults alsoShareSwm:true (seal+share)', async () => {
      // #1116 D5: quads present + finalize unspecified => the draft seals (server
      // default), so the combined CLIENT function also defaults alsoShareSwm to
      // true. `finalize` is still omitted (the server defaults it to seal).
      ok({ name: 'f', status: 'swm-shared' });
      await client.createKnowledgeAsset('cg-1', 'f', {
        quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
      });
      expect(body()).not.toHaveProperty('finalize');
      expect(body().alsoShareSwm).toBe(true);
    });

    it('createKnowledgeAsset does NOT default alsoShareSwm when finalize:false (no seal => no share)', async () => {
      // #1116 D5: an unsealed draft can't be shared, so the client must NOT
      // default-on alsoShareSwm -- the route guard would otherwise reject it.
      ok({ name: 'f', status: 'draft-open' });
      await client.createKnowledgeAsset('cg-1', 'f', {
        finalize: false,
        quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
      });
      expect(body()).not.toHaveProperty('alsoShareSwm');
    });

    it('createKnowledgeAsset does NOT default alsoShareSwm without quads', async () => {
      // No quads => nothing to seal => no auto-share default.
      ok({ name: 'f', status: 'draft-open' });
      await client.createKnowledgeAsset('cg-1', 'f');
      expect(body()).not.toHaveProperty('alsoShareSwm');
    });

    it('createKnowledgeAsset honors an explicit alsoShareSwm:false over the seal-default', async () => {
      // An explicit false must win -- stop at a sealed WM draft.
      ok({ name: 'f', status: 'wm-sealed' });
      await client.createKnowledgeAsset('cg-1', 'f', {
        quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
        alsoShareSwm: false,
      });
      expect(body().alsoShareSwm).toBe(false);
    });

    it('createKnowledgeAsset rejects finalize-only fields when finalize:false (parity with daemon)', async () => {
      await expect(client.createKnowledgeAsset('cg-1', 'f', {
        authorAgentAddress: '0xauthor',
        finalize: false,
        quads: [{ subject: 's', predicate: 'p', object: 'o', graph: '' }],
      })).rejects.toThrow(/require non-empty quads and finalize !== false/);
      expect(fetchCalls).toHaveLength(0);
    });

    it('knowledgeAssetWrite URL-encodes the name and POSTs to .../wm/write', async () => {
      ok({ written: 2 });
      await client.knowledgeAssetWrite('cg-1', 'meeting notes', [
        { subject: 's', predicate: 'p', object: 'o', graph: '' },
      ]);
      expect(url()).toBe('http://localhost:9200/api/knowledge-assets/meeting%20notes/wm/write');
      expect(body().quads).toHaveLength(1);
    });

    it('knowledgeAssetWrite strips any per-quad `graph` at the client (CONTRACT Section A)', async () => {
      ok({ written: 1 });
      // Even a NON-EMPTY graph must be dropped before the POST -- the daemon pins
      // every quad to the per-KA WM graph, so the write wire shape is
      // {subject,predicate,object} only. Stripping at the client (not just the
      // tool schema) defends a hand-built or normalizer-emitted `graph`.
      await client.knowledgeAssetWrite('cg-1', 'notes', [
        { subject: 's', predicate: 'p', object: 'o', graph: 'urn:my-graph:forged' },
      ]);
      const quads = body().quads as Array<Record<string, unknown>>;
      expect(quads).toHaveLength(1);
      expect(quads[0]).not.toHaveProperty('graph');
      expect(quads[0]).toEqual({ subject: 's', predicate: 'p', object: 'o' });
    });

    it('knowledgeAssetPullFrom sends layer + onConflict to .../wm/pull-from', async () => {
      ok({ seeded: 3 });
      await client.knowledgeAssetPullFrom('cg-1', 'f', 'swm', { onConflict: 'replace' });
      expect(url()).toBe('http://localhost:9200/api/knowledge-assets/f/wm/pull-from');
      expect(body()).toMatchObject({ layer: 'swm', onConflict: 'replace' });
    });

    it('share + publish target swm/share and vm/publish', async () => {
      ok({ swmShared: true, promotedCount: 1 });
      ok({ ual: 'did:dkg:x' });
      await client.knowledgeAssetShare('cg-1', 'f');
      await client.knowledgeAssetPublish('cg-1', 'f');
      expect(url(0)).toBe('http://localhost:9200/api/knowledge-assets/f/swm/share');
      expect(url(1)).toBe('http://localhost:9200/api/knowledge-assets/f/vm/publish');
    });

    it('knowledgeAssetShare rejects retired modes before HTTP and omits safe legacy defaults', async () => {
      await expect(client.knowledgeAssetShare('cg-1', 'f', { entities: ['urn:x'] }))
        .rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
      await expect(client.knowledgeAssetShare('cg-1', 'f', { skipSeal: true }))
        .rejects.toMatchObject({ code: 'UNSEALED_SHARE_BLOCKED' });
      expect(fetchCalls).toHaveLength(0);

      ok({ swmShared: true, promotedCount: 1, sealed: true, publishReady: true });
      await client.knowledgeAssetShare('cg-1', 'f', { entities: 'all', skipSeal: false });
      expect(body()).toEqual({ contextGraphId: 'cg-1' });
    });

    it('knowledgeAssetPublish nests finalized-publish controls under `options`', async () => {
      ok({ ual: 'did:dkg:x' });
      await client.knowledgeAssetPublish('cg-1', 'f', {
        subGraphName: 'sg',
        clearAfter: true,
        publishEpochs: 3,
        publisherNodeIdentityIdOverride: 42n,
      });
      expect(url()).toBe('http://localhost:9200/api/knowledge-assets/f/vm/publish');
      // `clearAfter` is the SDK spelling; the daemon expects `clearSharedMemoryAfter`.
      // bigint overrides serialize as decimal strings (JSON has no bigint).
      expect(body()).toMatchObject({
        contextGraphId: 'cg-1',
        subGraphName: 'sg',
        options: {
          clearSharedMemoryAfter: true,
          publishEpochs: 3,
          publisherNodeIdentityIdOverride: '42',
        },
      });
    });

    it('knowledgeAssetPublish omits `options` when no controls are passed', async () => {
      ok({ ual: 'did:dkg:x' });
      await client.knowledgeAssetPublish('cg-1', 'f', { subGraphName: 'sg' });
      expect(body()).toEqual({ contextGraphId: 'cg-1', subGraphName: 'sg' });
    });

    it('knowledgeAssetPublish rejects unsupported option keys before HTTP serialization', async () => {
      await expect(client.knowledgeAssetPublish('cg-1', 'f', {
        publishEpoch: 3,
      } as any)).rejects.toThrow('Unsupported finalized publish option(s): publishEpoch');
      expect(fetchCalls).toHaveLength(0);
    });

    it('knowledgeAssetFinalize forwards authorAgentAddress', async () => {
      ok({ merkleRoot: '0xroot', eip712Digest: '0xdig' });
      await client.knowledgeAssetFinalize('cg-1', 'f', {
        authorAgentAddress: '0xauthor',
        schemeVersion: 1,
      });
      expect(url()).toBe('http://localhost:9200/api/knowledge-assets/f/wm/finalize');
      expect(body()).toMatchObject({
        contextGraphId: 'cg-1',
        authorAgentAddress: '0xauthor',
        schemeVersion: 1,
      });
    });

    it('knowledgeAssetFinalize forwards preSignedAuthorAttestation', async () => {
      ok({ merkleRoot: '0xroot', eip712Digest: '0xdig' });
      const preSignedAuthorAttestation = { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } };
      await client.knowledgeAssetFinalize('cg-1', 'f', {
        preSignedAuthorAttestation: { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } },
        schemeVersion: 1,
      });
      expect(url()).toBe('http://localhost:9200/api/knowledge-assets/f/wm/finalize');
      expect(body()).toMatchObject({
        contextGraphId: 'cg-1',
        preSignedAuthorAttestation,
        schemeVersion: 1,
      });
    });

    it('knowledgeAssetFinalize rejects mutually exclusive authorship fields before HTTP serialization', async () => {
      await expect(client.knowledgeAssetFinalize('cg-1', 'f', {
        authorAgentAddress: '0xauthor',
        preSignedAuthorAttestation: { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } },
      })).rejects.toThrow('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
      expect(fetchCalls).toHaveLength(0);
    });

    it('knowledgeAssetFinalize rejects SWM before HTTP and omits neutral layer:wm', async () => {
      await expect(client.knowledgeAssetFinalize('cg-1', 'f', { layer: 'swm' }))
        .rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
      expect(fetchCalls).toHaveLength(0);

      ok({ merkleRoot: '0xroot', eip712Digest: '0xdig' });
      await client.knowledgeAssetFinalize('cg-1', 'f', { layer: 'wm' });
      expect(body()).toEqual({ contextGraphId: 'cg-1' });
    });

    it('createKnowledgeAsset rejects mutually exclusive authorship fields before HTTP serialization', async () => {
      await expect(client.createKnowledgeAsset('cg-1', 'f', {
        authorAgentAddress: '0xauthor',
        preSignedAuthorAttestation: { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } },
      })).rejects.toThrow('authorAgentAddress and preSignedAuthorAttestation are mutually exclusive');
      expect(fetchCalls).toHaveLength(0);
    });

    it('createKnowledgeAsset rejects finalized publish fields without quads before HTTP serialization', async () => {
      await expect(client.createKnowledgeAsset('cg-1', 'f', {
        authorAgentAddress: '0xauthor',
      })).rejects.toThrow('authorAgentAddress, preSignedAuthorAttestation, and schemeVersion require non-empty quads');
      expect(fetchCalls).toHaveLength(0);
    });

    it('createKnowledgeAsset translates an alsoPublishVm options object', async () => {
      ok({ name: 'f' });
      await client.createKnowledgeAsset('cg-1', 'f', {
        alsoPublishVm: { clearAfter: true, publishEpochs: 2, publisherNodeIdentityIdOverride: 7n },
      });
      expect(body().alsoPublishVm).toEqual({
        clearSharedMemoryAfter: true,
        publishEpochs: 2,
        publisherNodeIdentityIdOverride: '7',
      });
    });

    it('createKnowledgeAsset treats empty alsoPublishVm options as default publish', async () => {
      ok({ name: 'f' });
      await client.createKnowledgeAsset('cg-1', 'f', { alsoPublishVm: {} });
      expect(body().alsoPublishVm).toEqual({});
    });

    it('createKnowledgeAsset rejects unsupported alsoPublishVm options before HTTP serialization', async () => {
      await expect(client.createKnowledgeAsset('cg-1', 'f', {
        alsoPublishVm: { publishEpoch: 3 },
      } as any)).rejects.toThrow('Unsupported finalized publish option(s): publishEpoch');
      expect(fetchCalls).toHaveLength(0);
    });

    it('createKnowledgeAsset rejects array alsoPublishVm before HTTP serialization', async () => {
      await expect(client.createKnowledgeAsset('cg-1', 'f', {
        alsoPublishVm: [],
      } as any)).rejects.toThrow('alsoPublishVm must be a boolean or publish-options object');
      expect(fetchCalls).toHaveLength(0);
    });
  });
});
