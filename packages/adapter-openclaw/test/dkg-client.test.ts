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

  it('should throw on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(client.query('bad query')).rejects.toThrow('DKG daemon /api/query responded 500');
  });

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
});
