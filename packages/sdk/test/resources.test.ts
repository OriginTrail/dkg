import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDKG } from '../src/index.js';

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

describe('SDK resources request mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps node.status to GET /api/status', async () => {
    const fetchMock = vi.fn(async () => okJson({ peerId: '12D3', multiaddrs: [], name: 'n', uptimeMs: 1, connectedPeers: 0, relayConnected: false }));
    vi.stubGlobal('fetch', fetchMock);

    const dkg = createDKG({ baseUrl: 'http://127.0.0.1:9200/' });
    await dkg.node.status();

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:9200/api/status', expect.objectContaining({ method: 'GET' }));
  });

  it('maps paranet resource methods to expected endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ paranets: [] }))
      .mockResolvedValueOnce(okJson({ created: 'dev', uri: 'did:dkg:paranet:dev' }))
      .mockResolvedValueOnce(okJson({ id: 'dev', exists: true }))
      .mockResolvedValueOnce(okJson({ subscribed: 'dev' }))
      .mockResolvedValueOnce(okJson({ jobId: 'j1', paranetId: 'dev', includeWorkspace: false, status: 'done', queuedAt: Date.now() }));
    vi.stubGlobal('fetch', fetchMock);

    const dkg = createDKG({ baseUrl: 'http://127.0.0.1:9200' });
    await dkg.paranet.list();
    await dkg.paranet.create({ id: 'dev', name: 'Dev' });
    await dkg.paranet.exists('dev');
    await dkg.paranet.subscribe('dev', { includeWorkspace: true });
    await dkg.paranet.catchupStatus('dev');

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:9200/api/paranet/list', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:9200/api/paranet/create', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:9200/api/paranet/exists?id=dev', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://127.0.0.1:9200/api/subscribe', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, 'http://127.0.0.1:9200/api/sync/catchup-status?paranetId=dev', expect.objectContaining({ method: 'GET' }));
  });

  it('maps publish methods and passes contextGraphId in enshrine', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ kcId: '1', status: 'confirmed', kas: [] }))
      .mockResolvedValueOnce(okJson({ workspaceOperationId: 'op1', paranetId: 'dev', graph: 'g', triplesWritten: 1 }))
      .mockResolvedValueOnce(okJson({ kcId: '2', status: 'confirmed', kas: [], contextGraphId: '77' }));
    vi.stubGlobal('fetch', fetchMock);

    const dkg = createDKG({ baseUrl: 'http://127.0.0.1:9200' });
    await dkg.publish.quads({ paranetId: 'dev', quads: [] });
    await dkg.publish.workspaceWrite({ paranetId: 'dev', quads: [] });
    await dkg.publish.workspaceEnshrine({ paranetId: 'dev', contextGraphId: 77n });

    const enshrineCall = fetchMock.mock.calls[2];
    expect(enshrineCall).toBeDefined();
    const body = JSON.parse(String((enshrineCall as any)[1].body));
    expect(body.contextGraphId).toBe('77');
    expect(body.clearAfter).toBe(true);
    expect(body.selection).toBe('all');
  });

  it('maps context.create and stringifies participant ids', async () => {
    const fetchMock = vi.fn(async () => okJson({ contextGraphId: '9', success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const dkg = createDKG({ baseUrl: 'http://127.0.0.1:9200' });
    await dkg.context.create({ participantIdentityIds: [101, '202', 303n], requiredSignatures: 2 });

    const createCall = fetchMock.mock.calls[0];
    expect(createCall).toBeDefined();
    const body = JSON.parse(String((createCall as any)[1].body));
    expect(body.participantIdentityIds).toEqual(['101', '202', '303']);
  });

  it('maps query methods to /api/query and /api/query-remote', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ result: { bindings: [] } }))
      .mockResolvedValueOnce(okJson({ operationId: 'op', status: 'done', truncated: false, resultCount: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const dkg = createDKG({ baseUrl: 'http://127.0.0.1:9200' });
    await dkg.query.sparql('SELECT * WHERE { ?s ?p ?o }', { paranetId: 'dev' });
    await dkg.query.remote({ peerId: '12D3', lookupType: 'sparql', sparql: 'SELECT * WHERE { ?s ?p ?o }' });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:9200/api/query', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:9200/api/query-remote', expect.objectContaining({ method: 'POST' }));
  });

  it('maps agent methods and query parameters', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ agents: [] }))
      .mockResolvedValueOnce(okJson({ skills: [] }))
      .mockResolvedValueOnce(okJson({ success: true }))
      .mockResolvedValueOnce(okJson({ delivered: true }))
      .mockResolvedValueOnce(okJson({ messages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const dkg = createDKG({ baseUrl: 'http://127.0.0.1:9200' });
    await dkg.agent.list({ framework: 'OpenClaw', skillType: 'chat' });
    await dkg.agent.skills({ skillType: 'chat' });
    await dkg.agent.invokeSkill({ peerId: '12D3', skillUri: 'urn:skill:1' });
    await dkg.agent.chat({ to: 'agent-1', text: 'hello' });
    await dkg.agent.messages({ peer: 'agent-1', since: 10, limit: 5 });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:9200/api/agents?framework=OpenClaw&skill_type=chat', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:9200/api/skills?skillType=chat', expect.objectContaining({ method: 'GET' }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'http://127.0.0.1:9200/api/invoke-skill', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://127.0.0.1:9200/api/chat', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, 'http://127.0.0.1:9200/api/messages?peer=agent-1&since=10&limit=5', expect.objectContaining({ method: 'GET' }));

    const invokeCall = fetchMock.mock.calls[2];
    expect(invokeCall).toBeDefined();
    const invokeBody = JSON.parse(String((invokeCall as any)[1].body));
    expect(invokeBody.input).toBe('');
  });
});
