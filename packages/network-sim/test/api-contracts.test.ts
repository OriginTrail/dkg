import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function transport(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  fetcher.mockRejectedValue(new Error('Unexpected extra request'));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const quads = [{ subject: 'urn:item', predicate: 'urn:name', object: 'café' },
  { subject: 'urn:item', predicate: 'urn:kind', object: 'urn:Thing', graph: 'urn:explicit' }];

describe('simulator publish lifecycle', () => {
  it('seals and shares before publishing the same asset, retaining its seal and original quads', async () => {
    let finishCreate!: (response: Response) => void;
    const fetcher = transport();
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve; }));
    fetcher.mockResolvedValueOnce(json({ kaId: 'ka-1', status: 'published', kas: [], txHash: '0x123' }));
    const original = structuredClone(quads);
    const pending = api.publishKA(3, 'team', quads);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [createUrl, createOptions] = fetcher.mock.calls[0];
    const create = JSON.parse(String(createOptions?.body));
    expect(createUrl).toBe('/node/3/api/knowledge-assets');
    expect(createOptions).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(create.name).toMatch(/^netsim-publish-\d+-[a-z0-9]+$/);
    expect(create).toEqual({ contextGraphId: 'team', name: create.name, finalize: true, alsoShareSwm: true,
      quads: [{ ...quads[0], graph: 'did:dkg:context-graph:team' }, quads[1]] });
    finishCreate(json({ assertionUri: 'urn:assertion', seal: { root: 'abc', signature: 'sig' } }));
    await expect(pending).resolves.toEqual({ kaId: 'ka-1', status: 'published', kas: [], txHash: '0x123',
      assertionUri: 'urn:assertion', seal: { root: 'abc', signature: 'sig' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(`/node/3/api/knowledge-assets/${encodeURIComponent(create.name)}/vm/publish`);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ contextGraphId: 'team' });
    expect(quads).toEqual(original);
  });

  it('stops after a rejected create instead of attempting an unsealed publish', async () => {
    const fetcher = transport(json({ error: 'signing failed' }, 409));
    await expect(api.publishKA(1, 'team', quads)).rejects.toThrow('signing failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces publish rejection without retrying or creating another asset', async () => {
    const fetcher = transport(json({ assertionUri: 'urn:sealed' }), json({ error: 'insufficient funds' }, 422));
    await expect(api.publishKA(1, 'team', quads)).rejects.toThrow('insufficient funds');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts an empty private-quads list and omits an absent seal', async () => {
    transport(json({ assertionUri: 'urn:sealed' }), json({ kaId: 'ka-1', status: 'published', kas: [] }));
    await expect(api.publishKA(1, 'team', quads, [])).resolves.toEqual({
      assertionUri: 'urn:sealed', kaId: 'ka-1', status: 'published', kas: [],
    });
  });

  it('rejects private content before any HTTP request', async () => {
    const fetcher = transport();
    await expect(api.publishKA(1, 'team', [], quads)).rejects.toThrow('privateQuads are not supported');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('creates a shared asset with the same returned name and no VM publish', async () => {
    const fetcher = transport(json({ status: 'swm-shared', sealed: true }));
    const result = await api.createSharedKnowledgeAsset(2, 'team', quads);
    expect(result).toEqual({ status: 'swm-shared', sealed: true, name: expect.stringMatching(/^netsim-share-/) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      contextGraphId: 'team', name: result.name, quads, finalize: true, alsoShareSwm: true,
    });
  });
});

describe('simulator HTTP boundaries', () => {
  it.each([
    [() => api.fetchDevnetConfig(), '/devnet/config'],
    [() => api.fetchNodeStatus(4), '/node/4/api/status'],
    [() => api.fetchConnections(4), '/node/4/api/connections'],
    [() => api.fetchAgents(4), '/node/4/api/agents'],
    [() => api.fetchContextGraphs(4), '/node/4/api/context-graph/list'],
    [() => api.fetchWalletBalances(4), '/node/4/api/wallets/balances'],
    [() => api.fetchNodeMetrics(4), '/node/4/api/metrics'],
    [() => api.fetchMessages(4), '/node/4/api/messages'],
    [() => api.fetchMessages(4, 'peer/a?x=1&y=2'), '/node/4/api/messages?peer=peer%2Fa%3Fx%3D1%26y%3D2'],
  ] as const)('routes a read to %s → %s and preserves its response', async (read, url) => {
    const fetcher = transport(json({ marker: 'daemon result' }));
    await expect(read()).resolves.toEqual({ marker: 'daemon result' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('serializes query scope and mutation payloads without dropping explicit false values', async () => {
    const fetcher = transport(...Array.from({ length: 5 }, () => json({ ok: true })));
    await api.queryNode(2, 'ASK { ?s ?p ?o }', 'team', { graphSuffix: '_shared_memory', includeSharedMemory: false });
    await api.sendChat(2, 'peer/one', 'hello\nworld');
    await api.createContextGraph(2, 'team', 'Team & friends');
    await api.subscribeContextGraph(2, 'team');
    await api.queryRemote(2, 'peer/one', { lookupType: 'sparql', sparql: 'ASK {}', contextGraphId: 'team' });
    expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
      ['/node/2/api/query', { sparql: 'ASK { ?s ?p ?o }', contextGraphId: 'team', graphSuffix: '_shared_memory', includeSharedMemory: false }],
      ['/node/2/api/chat', { to: 'peer/one', text: 'hello\nworld' }],
      ['/node/2/api/context-graph/create', { id: 'team', name: 'Team & friends' }],
      ['/node/2/api/subscribe', { contextGraphId: 'team' }],
      ['/node/2/api/query-remote', { peerId: 'peer/one', lookupType: 'sparql', sparql: 'ASK {}', contextGraphId: 'team' }],
    ]);
  });

  it('encodes metric windows and operation names as query parameters', async () => {
    const fetcher = transport(...Array.from({ length: 4 }, () => json({})));
    await api.fetchNodeMetricsHistory(5, 100, 200, 25);
    await api.fetchNodeMetricsHistory(5);
    await api.fetchOperationStats(5, 'publish & share', '7d');
    await api.fetchOperationStats(5);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/node/5/api/metrics/history?from=100&to=200&maxPoints=25', '/node/5/api/metrics/history?maxPoints=200',
      '/node/5/api/operation-stats?period=7d&name=publish+%26+share', '/node/5/api/operation-stats?period=24h',
    ]);
  });

  it.each(['read', 'write'] as const)('preserves useful %s errors for JSON and non-JSON failures', async mode => {
    const call = () => mode === 'read' ? api.fetchNodeStatus(2) : api.sendChat(2, 'peer', 'hello');
    transport(json({ error: 'daemon unavailable' }, 503));
    await expect(call()).rejects.toThrow('daemon unavailable');
    for (const body of ['{}', 'upstream unavailable']) {
      transport(new Response(body, { status: 502 }));
      await expect(call()).rejects.toThrow(`HTTP 502: /node/2/api/${mode === 'read' ? 'status' : 'chat'}`);
    }
    const fetcher = transport();
    fetcher.mockRejectedValue(new TypeError('connection refused'));
    await expect(call()).rejects.toThrow('connection refused');
  });
});
