import { describe, expect, it, vi } from 'vitest';
import { DkgClient, DkgHttpError } from '../src/client.js';
import { makeConfig } from './harness.js';

const contextGraphId = ' did:dkg:context-graph:team/a ';
const name = 'notes/a & b';
const assertionUri = 'urn:assertion:notes';
const semanticQuads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"value"' }];
const extra = { assertionName: name, subGraphName: 'notes & plans', fileHash: 'hash' };
function harness() {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ receipt: 'preserved' }));
  return { fetcher, client: new DkgClient({ config: makeConfig(), fetcher }) };
}
interface Contract {
  label: string;
  method: string;
  route: string;
  invoke(client: DkgClient, full: boolean): Promise<unknown>;
  body?(full: boolean): Record<string, unknown>;
  query?(full: boolean): Record<string, string>;
}
const contracts: Contract[] = [
  {
    label: 'assertion quads',
    method: 'GET',
    route: `/api/knowledge-assets/${encodeURIComponent(name)}/wm/quads`,
    invoke: (c, full) =>
      c.queryAssertion({
        contextGraphId,
        assertionName: name,
        ...(full ? { subGraphName: extra.subGraphName } : {}),
      }),
    query: (full) => ({
      contextGraphId: 'team/a',
      ...(full ? { subGraphName: extra.subGraphName } : {}),
    }),
  },
  {
    label: 'assertion history',
    method: 'GET',
    route: `/api/knowledge-assets/${encodeURIComponent(name)}`,
    invoke: (c, full) =>
      c.getAssertionHistory({
        contextGraphId,
        assertionName: name,
        ...(full ? { agentAddress: '0xabc', subGraphName: extra.subGraphName } : {}),
      }),
    query: (full) => ({
      contextGraphId: 'team/a',
      ...(full ? { agentAddress: '0xabc', subGraphName: extra.subGraphName } : {}),
    }),
  },
  {
    label: 'asset state',
    method: 'GET',
    route: `/api/knowledge-assets/${encodeURIComponent(name)}`,
    invoke: (c, full) =>
      c.getKnowledgeAsset({
        contextGraphId,
        name,
        ...(full ? { subGraphName: extra.subGraphName } : {}),
      }),
    query: (full) => ({
      contextGraphId: 'team/a',
      ...(full ? { subGraphName: extra.subGraphName } : {}),
    }),
  },
  {
    label: 'asset discard',
    method: 'POST',
    route: `/api/knowledge-assets/${encodeURIComponent(name)}/wm/discard`,
    invoke: (c, full) =>
      c.knowledgeAssetDiscard({
        contextGraphId,
        name,
        ...(full ? { subGraphName: extra.subGraphName } : {}),
      }),
    body: (full) => ({
      contextGraphId: 'team/a',
      ...(full ? { subGraphName: extra.subGraphName } : {}),
    }),
  },
  {
    label: 'asset pull',
    method: 'POST',
    route: `/api/knowledge-assets/${encodeURIComponent(name)}/wm/pull-from`,
    invoke: (c, full) =>
      c.knowledgeAssetPullFrom({
        contextGraphId,
        name,
        layer: full ? 'vm' : 'swm',
        ...(full ? { subGraphName: extra.subGraphName, onConflict: 'replace' as const } : {}),
      }),
    body: (full) => ({
      contextGraphId: 'team/a',
      layer: full ? 'vm' : 'swm',
      ...(full ? { subGraphName: extra.subGraphName, onConflict: 'replace' } : {}),
    }),
  },
  {
    label: 'import resolution',
    method: 'POST',
    route: '/api/knowledge-assets/import-artifact/resolve',
    invoke: (c, full) =>
      c.resolveImportArtifact({ contextGraphId, assertionUri, ...(full ? extra : {}) }),
    body: (full) => ({ contextGraphId: 'team/a', assertionUri, ...(full ? extra : {}) }),
  },
  {
    label: 'import markdown',
    method: 'POST',
    route: '/api/knowledge-assets/import-artifact/read-markdown',
    invoke: (c, full) =>
      c.readImportArtifactMarkdown({
        contextGraphId,
        assertionUri,
        ...(full ? { ...extra, maxBytes: 0 } : {}),
      }),
    body: (full) => ({
      contextGraphId: 'team/a',
      assertionUri,
      ...(full ? { ...extra, maxBytes: 0 } : {}),
    }),
  },
  {
    label: 'semantic enrichment',
    method: 'POST',
    route: '/api/knowledge-assets/semantic-enrichment/write',
    invoke: (c, full) =>
      c.writeSemanticEnrichment({
        contextGraphId,
        assertionUri,
        semanticQuads,
        ...(full
          ? {
              ...extra,
              generationMethod: 'model',
              agentIdentity: 'urn:agent',
              generatedAt: '2026-01-01',
            }
          : {}),
      }),
    body: (full) => ({
      contextGraphId: 'team/a',
      assertionUri,
      semanticQuads,
      ...(full
        ? {
            ...extra,
            generationMethod: 'model',
            agentIdentity: 'urn:agent',
            generatedAt: '2026-01-01',
          }
        : {}),
    }),
  },
  {
    label: 'subscription',
    method: 'POST',
    route: '/api/subscribe',
    invoke: (c, full) =>
      c.subscribe({ contextGraphId, ...(full ? { includeSharedMemory: false } : {}) }),
    body: (full) => ({ contextGraphId: 'team/a', ...(full ? { includeSharedMemory: false } : {}) }),
  },
  {
    label: 'host-mode subscription',
    method: 'POST',
    route: '/api/shared-memory/host-mode/subscribe',
    invoke: (c) => c.requestHostMode({ contextGraphId }),
    body: () => ({ contextGraphId: 'team/a' }),
  },
  {
    label: 'chat send',
    method: 'POST',
    route: '/api/chat',
    invoke: (c, full) =>
      c.sendChat({ to: 'peer & one', text: 'hello', ...(full ? { contextGraphId } : {}) }),
    body: (full) => ({
      to: 'peer & one',
      text: 'hello',
      ...(full ? { contextGraphId: 'team/a' } : {}),
    }),
  },
  {
    label: 'messages',
    method: 'GET',
    route: '/api/messages',
    invoke: (c, full) =>
      c.getMessages(
        full
          ? { peer: 'peer & one', since: 0, sinceId: 0, limit: 0, direction: 'out', order: 'asc' }
          : undefined,
      ),
    query: (full): Record<string, string> =>
      full
        ? {
            peer: 'peer & one',
            since: '0',
            sinceId: '0',
            limit: '0',
            direction: 'out',
            order: 'asc',
          }
        : {},
  },
  {
    label: 'agent identity',
    method: 'GET',
    route: '/api/agent/identity',
    invoke: (c) => c.getAgentIdentity(),
  },
  {
    label: 'peer diagnostics',
    method: 'GET',
    route: '/api/peer-info',
    invoke: (c) => c.getPeerInfo('peer & one'),
    query: () => ({ peerId: 'peer & one' }),
  },
  {
    label: 'wallet balances',
    method: 'GET',
    route: '/api/wallets/balances',
    invoke: (c) => c.getWalletBalances(),
  },
];

describe.each([false, true])('daemon lifecycle contract (optional fields: %s)', (full) => {
  it.each(contracts)(
    '$label preserves the response and serializes only the correct route fields',
    async (contract) => {
      const { client, fetcher } = harness();
      const result = await contract.invoke(client, full);
      expect(result).toEqual({ receipt: 'preserved' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [raw, init] = fetcher.mock.calls[0];
      const url = new URL(String(raw));
      expect(url.pathname).toBe(contract.route);
      expect(Object.fromEntries(url.searchParams)).toEqual(contract.query?.(full) ?? {});
      expect(init?.method).toBe(contract.method);
      expect(init?.headers).toEqual({
        Authorization: 'Bearer test-token',
        ...(contract.body ? { 'Content-Type': 'application/json' } : {}),
      });
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(
        contract.body?.(full),
      );
    },
  );
});

describe('idempotent creation distinguishes duplicates from transport failures', () => {
  it.each([{}, { assertionUri: 'urn:created', alreadyExists: true }])(
    'normalizes optional assertion creation fields: %j',
    async (response) => {
      const { client, fetcher } = harness();
      fetcher.mockResolvedValue(Response.json(response));
      expect(
        await client.createAssertion({
          contextGraphId,
          assertionName: name,
          subGraphName: 'notes',
        }),
      ).toEqual({
        assertionUri: 'assertionUri' in response ? 'urn:created' : null,
        alreadyExists: 'alreadyExists' in response,
      });
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
        contextGraphId: 'team/a',
        name,
        subGraphName: 'notes',
      });
    },
  );
  it.each(['subgraph', 'assertion'] as const)(
    'accepts a legacy duplicate %s response but propagates other failures',
    async (kind) => {
      const { client, fetcher } = harness();
      const run = () =>
        kind === 'subgraph'
          ? client.ensureSubGraph(contextGraphId, 'notes')
          : client.createAssertion({ contextGraphId, assertionName: name });
      fetcher.mockImplementationOnce(async () =>
        Response.json({ error: 'already exists' }, { status: 409 }),
      );
      expect(await run()).toEqual(
        kind === 'subgraph' ? undefined : { assertionUri: null, alreadyExists: true },
      );
      fetcher.mockImplementationOnce(async () =>
        Response.json({ error: 'permission denied' }, { status: 403 }),
      );
      await expect(run()).rejects.toBeInstanceOf(DkgHttpError);
      const failure = new Error('already exists on a broken connection');
      fetcher.mockRejectedValueOnce(failure);
      await expect(run()).rejects.toBe(failure);
    },
  );
  it.each(['already exists', 'duplicate', 'CONFLICT'])(
    'recognizes a context-graph 409 with %s',
    async (error) => {
      const { client, fetcher } = harness();
      fetcher.mockResolvedValue(Response.json({ error }, { status: 409 }));
      expect(await client.createContextGraph({ id: 'team', name: 'Team' })).toEqual({
        created: 'team',
        uri: 'did:dkg:context-graph:team',
        alreadyExists: true,
      });
    },
  );
  it('preserves explicit zero policies when creating a context graph', async () => {
    const { client, fetcher } = harness();
    fetcher.mockResolvedValue(Response.json({ created: 'team', uri: 'urn:team' }));
    expect(
      await client.createContextGraph({
        id: 'team',
        name: 'Team',
        description: 'Notes',
        accessPolicy: 0,
        publishPolicy: 0,
      }),
    ).toEqual({ created: 'team', uri: 'urn:team', alreadyExists: false });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      id: 'team',
      name: 'Team',
      description: 'Notes',
      accessPolicy: 0,
      publishPolicy: 0,
    });
  });
  it.each([
    { status: 409, error: 'unrelated refusal' },
    { status: 503, error: 'conflict' },
  ])('does not convert $status / $error into success', async ({ status, error }) => {
    const { client, fetcher } = harness();
    fetcher.mockResolvedValue(Response.json({ error }, { status }));
    await expect(client.createContextGraph({ id: 'team', name: 'Team' })).rejects.toMatchObject({
      status,
    });
  });
  it('preserves network failure identity when creating a context graph', async () => {
    const { client, fetcher } = harness();
    const failure = new Error('offline');
    fetcher.mockRejectedValue(failure);
    await expect(client.createContextGraph({ id: 'team', name: 'Team' })).rejects.toBe(failure);
  });
});

describe('query compatibility and explicit lifecycle options', () => {
  it.each([
    [
      'ASK { ?s ?p ?o }',
      { bindings: [{ result: { type: 'literal', value: 'TRUE' } }] },
      { type: 'boolean', value: true },
    ],
    ['ASK { ?s ?p ?o }', {}, { type: 'boolean', value: false }],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', {}, { type: 'quads', quads: [] }],
  ] as Array<[string, unknown, Record<string, unknown>]>)(
    'normalizes legacy %s responses',
    async (sparql, payload, expected) => {
      const { client, fetcher } = harness();
      fetcher.mockResolvedValueOnce(Response.json({ result: payload }));
      expect(await client.query({ sparql })).toMatchObject(expected);
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ sparql });
    },
  );
  it('preserves explicit query scope controls including zero trust and an empty verified graph', async () => {
    const { client, fetcher } = harness();
    const args = {
      sparql: 'SELECT * WHERE { ?s ?p ?o }',
      verifiedGraph: '',
      assertionName: name,
      minTrust: 0 as const,
    };
    await client.query(args);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(args);
  });
  it('normalizes an absent registry page to an empty list and preserves a next cursor', async () => {
    const { client, fetcher } = harness();
    fetcher.mockResolvedValueOnce(Response.json({ nextCursor: 'next' }));
    expect(await client.listAgentsPage()).toEqual({ agents: [], nextCursor: 'next' });
  });
  it('strips complete RDF brackets from legacy writes without altering literals or incomplete wrappers', async () => {
    const { client, fetcher } = harness();
    await client.writeAssertion({
      contextGraphId,
      assertionName: name,
      triples: [
        { subject: '<urn:subject>', predicate: '<urn:predicate>', object: '"<literal>"' },
        { subject: '<incomplete', predicate: 'urn:predicate', object: '<urn:object>' },
      ],
    });
    await client.discardAssertion({ contextGraphId, assertionName: name });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      contextGraphId: 'team/a',
      quads: [
        { subject: 'urn:subject', predicate: 'urn:predicate', object: '"<literal>"' },
        { subject: '<incomplete', predicate: 'urn:predicate', object: '<urn:object>' },
      ],
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      contextGraphId: 'team/a',
    });
  });
  it.each(['author', 'attestation'] as const)(
    'forwards %s and scheme options when creating a scoped sealed draft',
    async (mode) => {
      const { client, fetcher } = harness();
      const author =
        mode === 'author'
          ? { authorAgentAddress: '0xauthor' }
          : {
              preSignedAuthorAttestation: {
                address: '0xauthor',
                reservedKaId: '1',
                signature: { r: '0xr', vs: '0xvs' },
              },
            };
      const quads = [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: '' }];
      await client.createKnowledgeAsset({
        contextGraphId,
        name,
        subGraphName: 'notes',
        quads,
        schemeVersion: 0,
        ...author,
      });
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
        contextGraphId: 'team/a',
        name,
        subGraphName: 'notes',
        quads,
        schemeVersion: 0,
        ...author,
        alsoShareSwm: true,
      });
    },
  );
  it('keeps subgraph scope on writes and finalization', async () => {
    const { client, fetcher } = harness();
    await client.knowledgeAssetWrite({
      contextGraphId,
      name,
      subGraphName: 'notes',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'untrusted' }],
    });
    await client.knowledgeAssetFinalize({ contextGraphId, name, subGraphName: 'notes' });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      contextGraphId: 'team/a',
      subGraphName: 'notes',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"' }],
    });
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      contextGraphId: 'team/a',
      subGraphName: 'notes',
    });
  });
  it('rejects invalid JavaScript lifecycle values before sending a mutation', async () => {
    const { client, fetcher } = harness();
    // Runtime callers need the same protection as TypeScript callers.
    await expect(
      client.knowledgeAssetFinalize({ contextGraphId, name, layer: 'vm' as 'wm' }),
    ).rejects.toThrow('Only Working Memory finalization is supported');
    await expect(
      client.createKnowledgeAsset({
        contextGraphId,
        name,
        alsoPublishVm: { clearAfter: undefined },
      }),
    ).rejects.toThrow('must include at least one supported option');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
