import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import { daemonState } from '../src/daemon/state.js';

const CANONICAL_CG = '0xE5B8896800000000000000000000000000000000/tuesday-cg';
const CANONICAL_URI = `did:dkg:context-graph:${CANONICAL_CG}`;
const BARE_CG = 'tuesday-cg';
const BARE_URI = `did:dkg:context-graph:${BARE_CG}`;
const CALLER = '0x0000000000000000000000000000000000000001';

type ContextGraphRow = {
  id: string;
  uri: string;
  name?: string;
  accessPolicy?: string;
  subscribed?: boolean;
  synced?: boolean;
  hasLocalContent?: boolean;
  exists?: boolean;
  declarationFound?: boolean;
  callerAuthorized?: boolean;
  persistedSubscribed?: boolean;
  persistedSynced?: boolean;
};

describe('context graph write-path validation', () => {
  let server: Server | undefined;
  let baseUrl = '';

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  function makeAgent(
    rows: ContextGraphRow[] = [{ id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true }],
    options: { exactPreflight?: boolean } = {},
  ) {
    const create = vi.fn(async (contextGraphId: string, name: string) =>
      `did:dkg:context-graph:${contextGraphId}/assertion/${CALLER}/${name}`);
    const write = vi.fn(async () => undefined);
    // wm/write gates create() on a missing-only existence check; null = the
    // 'draft' KA these tests write to doesn't exist yet, so create() fires.
    const history = vi.fn(async () => null);
    const promote = vi.fn(async () => ({ promotedCount: 1 }));
    const promoteAsync = vi.fn(async () => ({ jobId: 'job-1' }));
    const discard = vi.fn(async () => undefined);
    const query = vi.fn(async () => []);
    const share = vi.fn(async () => ({ shareOperationId: 'share-1' }));
    const conditionalShare = vi.fn(async () => ({ shareOperationId: 'share-cas-1' }));
    const publishFromSharedMemory = vi.fn(async () => ({
      kaId: 1n,
      status: 'confirmed',
      kaManifest: [],
    }));
    const publishFromFinalizedAssertion = vi.fn(async () => ({
      kaId: 1n,
      status: 'confirmed',
      assertionUri: 'did:dkg:context-graph:test/assertion/test/draft',
      seal: {
        authorAddress: CALLER,
        merkleRoot: new Uint8Array(32),
      },
      kaManifest: [],
    }));
    const createSubGraph = vi.fn(async () => undefined);
    const listSubGraphs = vi.fn(async () => []);
    const registerContextGraph = vi.fn(async () => ({ onChainId: '5' }));
    const inviteToContextGraph = vi.fn(async () => undefined);
    const inviteAgentToContextGraph = vi.fn(async () => undefined);
    const removeAgentFromContextGraph = vi.fn(async () => undefined);
    const renameContextGraph = vi.fn(async () => undefined);
    const approveJoinRequest = vi.fn(async () => undefined);
    const rejectJoinRequest = vi.fn(async () => undefined);
    const assertContextGraphOwner = vi.fn(async () => undefined);
    const storeInsert = vi.fn(async () => undefined);

    const probeContextGraphWritePreflight = vi.fn(async (contextGraphId: string, probeOpts?: { callerAgentAddress?: string | null }) => {
      const row = rows.find((candidate) =>
        candidate.id === contextGraphId || candidate.uri === `did:dkg:context-graph:${contextGraphId}`,
      );
      if (!row) {
        return {
          exists: false,
          hasLocalContent: false,
          declarationFound: false,
        };
      }
      return {
        exists: row.exists !== false,
        hasLocalContent: row.hasLocalContent === true,
        ...((row.subscribed !== undefined || row.synced !== undefined)
          ? { inMemorySubscription: {
              subscribed: row.subscribed === true,
              synced: row.synced === true,
            } }
          : {}),
        ...((row.persistedSubscribed !== undefined || row.persistedSynced !== undefined)
          ? { persistedSubscription: {
              subscribed: row.persistedSubscribed === true,
              synced: row.persistedSynced === true,
            } }
          : {}),
        declarationFound: row.declarationFound ?? row.exists !== false,
        ...(row.accessPolicy === 'private' || row.accessPolicy === 'public'
          ? { accessPolicy: row.accessPolicy }
          : {}),
        ...(probeOpts?.callerAgentAddress && row.accessPolicy === 'public'
          ? { callerAuthorized: true }
          : {}),
        ...(probeOpts?.callerAgentAddress && row.accessPolicy === 'private'
          ? { callerAuthorized: row.callerAuthorized === true }
          : {}),
      };
    });

    return {
      listContextGraphs: vi.fn(async () => rows),
      ...(options.exactPreflight ? { probeContextGraphWritePreflight } : {}),
      getDefaultAgentAddress: vi.fn(() => undefined),
      contextGraphHasLocalContent: vi.fn(async (contextGraphId: string) =>
        rows.some((row) => row.id === contextGraphId && row.hasLocalContent === true),
      ),
      resolveAgentByToken: vi.fn(() => undefined),
      peerId: 'peer-test',
      query,
      assertion: {
        create,
        write,
        history,
        promote,
        promoteAsync,
        discard,
        query,
      },
      share,
      conditionalShare,
      publishFromSharedMemory,
      publishFromFinalizedAssertion,
      getContextGraphOnChainId: vi.fn(async () => null),
      hasPendingSharedMemoryWrites: vi.fn(() => false),
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({})),
      registerContextGraph,
      inviteToContextGraph,
      inviteAgentToContextGraph,
      removeAgentFromContextGraph,
      renameContextGraph,
      approveJoinRequest,
      rejectJoinRequest,
      assertContextGraphOwner,
      contextGraphExists: vi.fn(async (contextGraphId: string) =>
        rows.some((row) =>
          row.exists !== false &&
          (row.id === contextGraphId || row.uri === `did:dkg:context-graph:${contextGraphId}`),
        ),
      ),
      createSubGraph,
      listSubGraphs,
      store: {
        insert: storeInsert,
      },
      calls: {
        create,
        write,
        history,
        promote,
        promoteAsync,
        discard,
        query,
        share,
        conditionalShare,
        publishFromSharedMemory,
        publishFromFinalizedAssertion,
        registerContextGraph,
        inviteToContextGraph,
        inviteAgentToContextGraph,
        removeAgentFromContextGraph,
        renameContextGraph,
        approveJoinRequest,
        rejectJoinRequest,
        assertContextGraphOwner,
        createSubGraph,
        listSubGraphs,
        storeInsert,
      },
    };
  }

  async function startRoutes(
    agent: ReturnType<typeof makeAgent>,
    requestAgentAddress = CALLER,
    requestToken: string | undefined = undefined,
  ) {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const tracker = {
        start: vi.fn(),
        trackPhase: vi.fn((_ctx, _phase, fn: () => Promise<unknown>) => fn()),
        complete: vi.fn(),
        fail: vi.fn(),
      };
      const ctx = {
        req,
        res,
        agent,
        publisherControl: {},
        publisherRuntime: null,
        config: {},
        startedAt: Date.now(),
        dashDb: {},
        opWallets: {},
        network: {},
        tracker,
        memoryManager: {},
        bridgeAuthToken: undefined,
        nodeVersion: 'test',
        nodeCommit: 'test',
        catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
        extractionRegistry: {},
        fileStore: {
          put: vi.fn(async () => ({ keccak256: 'hash' })),
        },
        extractionStatus: new Map(),
        assertionImportLocks: new Map(),
        vectorStore: {},
        embeddingProvider: null,
        validTokens: new Set(),
        apiHost: '127.0.0.1',
        apiPortRef: { value: 0 },
        routePlugins: [],
        url,
        path: url.pathname,
        requestToken,
        requestAgentAddress,
        emitMemoryGraphChanged: vi.fn(),
      } as any;

      try {
        await handleKnowledgeAssetsRoutes(ctx);
        if (!res.writableEnded) await handleMemoryRoutes(ctx);
        if (!res.writableEnded) await handleContextGraphRoutes(ctx);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unhandled: ${err?.message ?? err}` }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  it('accepts an exact existing canonical id for assertion create', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: CANONICAL_CG,
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.calls.create).toHaveBeenCalledWith(CANONICAL_CG, 'draft', { subGraphName: undefined });
  });

  it('sub-graph list opts into same-CG partition counts', async () => {
    const agent = makeAgent();
    agent.calls.listSubGraphs.mockResolvedValueOnce([
      {
        name: 'code',
        uri: `${CANONICAL_URI}/code`,
        description: 'Code sub-graph',
        createdBy: CALLER,
      },
    ]);
    agent.calls.query.mockResolvedValueOnce({
      bindings: [
        {
          g: `${CANONICAL_URI}/code/_shared_memory`,
          entities: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
          triples: '"5"^^<http://www.w3.org/2001/XMLSchema#integer>',
        },
      ],
    });
    await startRoutes(agent);

    const result = await get(`/api/sub-graph/list?contextGraphId=${encodeURIComponent(CANONICAL_CG)}`);

    expect(result.status).toBe(200);
    expect(agent.calls.query).toHaveBeenCalledWith(
      expect.stringContaining('GRAPH ?g'),
      {
        contextGraphId: CANONICAL_CG,
        includeContextGraphPartitions: true,
      },
    );
    expect(result.body.subGraphs).toEqual([
      expect.objectContaining({
        name: 'code',
        entityCount: 2,
        tripleCount: 5,
      }),
    ]);
  });

  it('accepts a full context graph DID and passes the canonical id downstream', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets/draft/wm/write', {
      contextGraphId: CANONICAL_URI,
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(200);
    expect(agent.calls.write).toHaveBeenCalledWith(
      CANONICAL_CG,
      'draft',
      [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
      { subGraphName: undefined },
    );
  });

  it('accepts an exact full DID for an existing bare id instead of treating it as a suffix-only slug', async () => {
    const agent = makeAgent([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      {
        id: BARE_CG,
        uri: BARE_URI,
        name: 'Tuesday public CG',
        accessPolicy: 'public',
        subscribed: true,
        synced: true,
      },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets/draft/wm/write', {
      contextGraphId: BARE_URI,
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(200);
    expect(agent.calls.write).toHaveBeenCalledWith(
      BARE_CG,
      'draft',
      [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
      { subGraphName: undefined },
    );
  });

  it('rejects a full DID for a shadow-like bare id when a curated suffix match exists', async () => {
    const agent = makeAgent([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: BARE_CG, uri: BARE_URI },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets/draft/wm/write', {
      contextGraphId: BARE_URI,
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: 'CONTEXT_GRAPH_ID_NOT_CANONICAL',
      canonicalContextGraphId: CANONICAL_CG,
    });
    expect(agent.calls.write).not.toHaveBeenCalled();
  });

  it('accepts an exact legitimate bare id even when a curated suffix match exists', async () => {
    const agent = makeAgent([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      {
        id: BARE_CG,
        uri: BARE_URI,
        name: 'Tuesday public CG',
        accessPolicy: 'public',
        subscribed: true,
        synced: true,
      },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: BARE_CG,
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.calls.create).toHaveBeenCalledWith(BARE_CG, 'draft', { subGraphName: undefined });
  });

  it('normalizes full context graph DIDs on assertion read helpers', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await get(
      `/api/knowledge-assets/draft/wm/quads?contextGraphId=${encodeURIComponent(CANONICAL_URI)}`,
    );

    expect(result.status).toBe(200);
    expect(agent.calls.query).toHaveBeenCalledWith(CANONICAL_CG, 'draft', undefined);
  });

  it('rejects a bare suffix match before assertion create and returns the canonical id', async () => {
    const agent = makeAgent([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: 'tuesday-cg', uri: 'did:dkg:context-graph:tuesday-cg' },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'tuesday-cg',
      name: 'draft',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: 'CONTEXT_GRAPH_ID_NOT_CANONICAL',
      canonicalContextGraphId: CANONICAL_CG,
    });
    expect(agent.calls.create).not.toHaveBeenCalled();
  });

  it('rejects exact context graphs that are visible but not locally synced', async () => {
    const agent = makeAgent([
      {
        id: 'definition-only-cg',
        uri: 'did:dkg:context-graph:definition-only-cg',
        name: 'Definition Only CG',
        accessPolicy: 'public',
        subscribed: true,
        synced: false,
      },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'definition-only-cg',
      name: 'draft',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_WRITABLE' });
    expect(agent.contextGraphHasLocalContent).toHaveBeenCalledWith('definition-only-cg');
    expect(agent.calls.create).not.toHaveBeenCalled();
  });

  it('accepts exact locally defined context graphs before their first content write', async () => {
    const agent = makeAgent([
      {
        id: 'fresh-local-cg',
        uri: 'did:dkg:context-graph:fresh-local-cg',
        name: 'Fresh Local CG',
        accessPolicy: 'public',
        subscribed: false,
        synced: false,
      },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'fresh-local-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.contextGraphHasLocalContent).toHaveBeenCalledWith('fresh-local-cg');
    expect(agent.contextGraphExists).toHaveBeenCalledWith('fresh-local-cg');
    expect(agent.calls.create).toHaveBeenCalledWith('fresh-local-cg', 'draft', { subGraphName: undefined });
  });

  it('accepts exact visible context graphs with local content even when not subscribed', async () => {
    const agent = makeAgent([
      {
        id: 'local-content-cg',
        uri: 'did:dkg:context-graph:local-content-cg',
        name: 'Local Content CG',
        accessPolicy: 'public',
        subscribed: false,
        synced: false,
        hasLocalContent: true,
      },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'local-content-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.calls.create).toHaveBeenCalledWith('local-content-cg', 'draft', { subGraphName: undefined });
  });

  it('does not pass legacy peer ids as callerAgentAddress when listing write targets', async () => {
    const agent = makeAgent([{
      id: 'legacy-cg',
      uri: 'did:dkg:context-graph:legacy-cg',
      name: 'Legacy CG',
      subscribed: true,
      synced: true,
    }]);
    await startRoutes(agent, '12D3KooWLegacyPeer');

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'legacy-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.listContextGraphs).toHaveBeenCalledWith();
    expect(agent.calls.create).toHaveBeenCalledWith('legacy-cg', 'draft', { subGraphName: undefined });
  });

  it('does not fall back to the default agent when listing write targets without an explicit caller', async () => {
    const agent = makeAgent([{
      id: 'admin-cg',
      uri: 'did:dkg:context-graph:admin-cg',
      name: 'Admin CG',
      subscribed: true,
      synced: true,
    }]);
    agent.getDefaultAgentAddress.mockReturnValue(CALLER);
    await startRoutes(agent, CALLER);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'admin-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.getDefaultAgentAddress).not.toHaveBeenCalled();
    expect(agent.listContextGraphs).toHaveBeenCalledWith();
    expect(agent.calls.create).toHaveBeenCalledWith('admin-cg', 'draft', { subGraphName: undefined });
  });

  it('does not scope write-target listing for node-level tokens that resolve to no agent', async () => {
    const agent = makeAgent([{
      id: 'node-token-cg',
      uri: 'did:dkg:context-graph:node-token-cg',
      name: 'Node Token CG',
      subscribed: true,
      synced: true,
    }]);
    agent.resolveAgentByToken.mockReturnValue(undefined);
    await startRoutes(agent, CALLER, 'node-token');

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'node-token-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.resolveAgentByToken).toHaveBeenCalledWith('node-token');
    expect(agent.listContextGraphs).toHaveBeenCalledWith();
    expect(agent.calls.create).toHaveBeenCalledWith('node-token-cg', 'draft', { subGraphName: undefined });
  });

  it('scopes write-target listing when an explicit agent token resolves to an EVM address', async () => {
    const agent = makeAgent([{
      id: 'agent-scoped-cg',
      uri: 'did:dkg:context-graph:agent-scoped-cg',
      name: 'Agent Scoped CG',
      subscribed: true,
      synced: true,
    }]);
    agent.resolveAgentByToken.mockReturnValue(CALLER);
    await startRoutes(agent, CALLER, 'agent-token');

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'agent-scoped-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.resolveAgentByToken).toHaveBeenCalledWith('agent-token');
    expect(agent.listContextGraphs).toHaveBeenCalledWith({ callerAgentAddress: CALLER });
    expect(agent.calls.create).toHaveBeenCalledWith('agent-scoped-cg', 'draft', { subGraphName: undefined });
  });

  it('accepts an exact bare context graph with local content when a curated suffix also exists', async () => {
    const agent = makeAgent([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      {
        id: BARE_CG,
        uri: BARE_URI,
        name: BARE_CG,
        subscribed: false,
        synced: false,
        hasLocalContent: true,
      },
    ]);
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: BARE_CG,
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.contextGraphHasLocalContent).toHaveBeenCalledWith(BARE_CG);
    expect(agent.calls.create).toHaveBeenCalledWith(BARE_CG, 'draft', { subGraphName: undefined });
  });

  it('rejects unknown assertion write targets before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets/draft/wm/write', {
      contextGraphId: 'missing-cg',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.write).not.toHaveBeenCalled();
  });

  it('allows node-level write preflight to exact local context graphs hidden from unscoped lists', async () => {
    const agent = makeAgent([]);
    agent.contextGraphExists.mockResolvedValueOnce(true);
    await startRoutes(agent, CALLER, 'node-token');

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'private-local-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.resolveAgentByToken).toHaveBeenCalledWith('node-token');
    expect(agent.listContextGraphs).toHaveBeenCalledWith();
    expect(agent.contextGraphExists).toHaveBeenCalledWith('private-local-cg');
    expect(agent.calls.create).toHaveBeenCalledWith('private-local-cg', 'draft', { subGraphName: undefined });
  });

  it('does not accept context graphs hidden from an explicit caller-visible list through an existence fallback', async () => {
    const agent = makeAgent([]);
    agent.resolveAgentByToken.mockReturnValue(CALLER);
    agent.contextGraphExists.mockResolvedValueOnce(true);
    await startRoutes(agent, CALLER, 'agent-token');

    const result = await post('/api/shared-memory/write', {
      contextGraphId: 'private-hidden-cg',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.listContextGraphs).toHaveBeenCalledWith({ callerAgentAddress: CALLER });
    expect(agent.contextGraphExists).not.toHaveBeenCalled();
    expect(agent.calls.share).not.toHaveBeenCalled();
  });

  it('accepts exact synced owner targets through the preflight probe when list is down', async () => {
    const agent = makeAgent([
      {
        id: 'fast-owner-cg',
        uri: 'did:dkg:context-graph:fast-owner-cg',
        subscribed: true,
        synced: true,
        declarationFound: true,
      },
    ], { exactPreflight: true });
    agent.listContextGraphs.mockRejectedValueOnce(new Error('list timeout'));
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'fast-owner-cg',
      name: 'draft',
    });

    expect(result.status).toBe(201);
    expect(agent.probeContextGraphWritePreflight).toHaveBeenCalledWith('fast-owner-cg', {
      callerAgentAddress: null,
    });
    expect(agent.listContextGraphs).not.toHaveBeenCalled();
    expect(agent.calls.create).toHaveBeenCalledWith('fast-owner-cg', 'draft', { subGraphName: undefined });
  });

  it('denies stale subscribed rows instead of creating shadow context graphs', async () => {
    const agent = makeAgent([
      {
        id: 'stale-cg',
        uri: 'did:dkg:context-graph:stale-cg',
        subscribed: true,
        synced: true,
        exists: false,
        hasLocalContent: false,
        declarationFound: false,
      },
    ], { exactPreflight: true });
    agent.listContextGraphs.mockRejectedValueOnce(new Error('list timeout'));
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'stale-cg',
      name: 'draft',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.listContextGraphs).not.toHaveBeenCalled();
    expect(agent.calls.create).not.toHaveBeenCalled();
  });

  it('denies non-member bearer writes to private exact targets from the live probe', async () => {
    const agent = makeAgent([
      {
        id: 'private-cg',
        uri: 'did:dkg:context-graph:private-cg',
        subscribed: true,
        synced: true,
        accessPolicy: 'private',
        declarationFound: true,
        callerAuthorized: false,
      },
    ], { exactPreflight: true });
    agent.resolveAgentByToken.mockReturnValue(CALLER);
    agent.listContextGraphs.mockRejectedValueOnce(new Error('list timeout'));
    await startRoutes(agent, CALLER, 'agent-token');

    const result = await post('/api/shared-memory/write', {
      contextGraphId: 'private-cg',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.listContextGraphs).not.toHaveBeenCalled();
    expect(agent.calls.share).not.toHaveBeenCalled();
  });

  it('accepts bearer writes to exact private targets when the probe authorizes the caller', async () => {
    const agent = makeAgent([
      {
        id: 'member-private-cg',
        uri: 'did:dkg:context-graph:member-private-cg',
        subscribed: true,
        synced: true,
        accessPolicy: 'private',
        declarationFound: true,
        callerAuthorized: true,
      },
    ], { exactPreflight: true });
    agent.resolveAgentByToken.mockReturnValue(CALLER);
    agent.listContextGraphs.mockRejectedValueOnce(new Error('list timeout'));
    await startRoutes(agent, CALLER, 'agent-token');

    const result = await post('/api/shared-memory/write', {
      contextGraphId: 'member-private-cg',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(200);
    expect(agent.listContextGraphs).not.toHaveBeenCalled();
    expect(agent.calls.share).toHaveBeenCalledWith(
      'member-private-cg',
      [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
      expect.objectContaining({ callerAgentAddress: CALLER }),
    );
  });

  it('does not bearer-fast-accept exact declarations without explicit access policy', async () => {
    const agent = makeAgent([
      {
        id: 'unknown-policy-cg',
        uri: 'did:dkg:context-graph:unknown-policy-cg',
        subscribed: true,
        synced: true,
        declarationFound: true,
      },
    ], { exactPreflight: true });
    agent.resolveAgentByToken.mockReturnValue(CALLER);
    agent.listContextGraphs.mockRejectedValueOnce(new Error('list timeout'));
    await startRoutes(agent, CALLER, 'agent-token');

    const result = await post('/api/shared-memory/write', {
      contextGraphId: 'unknown-policy-cg',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    expect(agent.calls.share).not.toHaveBeenCalled();
  });

  it('returns a bounded unavailable response when list validation is down and no exact fast path applies', async () => {
    const agent = makeAgent([], { exactPreflight: true });
    agent.listContextGraphs.mockRejectedValueOnce(new Error('list timeout'));
    await startRoutes(agent);

    const result = await post('/api/knowledge-assets', {
      contextGraphId: 'missing-cg',
      name: 'draft',
    });

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_VALIDATION_UNAVAILABLE' });
    expect(result.body.error).toContain('Failed to validate contextGraphId against known context graphs: list timeout');
    expect(agent.calls.create).not.toHaveBeenCalled();
  });

  it('rejects sub-graph creation for unknown context graphs before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/sub-graph/create', {
      contextGraphId: 'missing-cg',
      subGraphName: 'tasks',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.createSubGraph).not.toHaveBeenCalled();
  });

  it('accepts a full context graph DID for registration and passes the canonical id downstream', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/context-graph/register', {
      id: CANONICAL_URI,
    });

    expect(result.status).toBe(200);
    expect(agent.calls.registerContextGraph).toHaveBeenCalledWith(
      CANONICAL_CG,
      expect.objectContaining({ callerAgentAddress: CALLER }),
    );
    expect(result.body).toMatchObject({ registered: CANONICAL_CG });
  });

  it('rejects context graph invite bare suffixes before mutation', async () => {
    const agent = makeAgent([
      { id: CANONICAL_CG, uri: CANONICAL_URI, subscribed: true, synced: true },
      { id: 'tuesday-cg', uri: 'did:dkg:context-graph:tuesday-cg' },
    ]);
    await startRoutes(agent);

    const result = await post('/api/context-graph/invite', {
      contextGraphId: 'tuesday-cg',
      peerId: '12D3KooWTestPeer',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({
      code: 'CONTEXT_GRAPH_ID_NOT_CANONICAL',
      canonicalContextGraphId: CANONICAL_CG,
    });
    expect(agent.calls.inviteToContextGraph).not.toHaveBeenCalled();
  });

  it('rejects context graph rename for unknown ids before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/context-graph/rename', {
      id: 'missing-cg',
      name: 'Missing',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.renameContextGraph).not.toHaveBeenCalled();
  });

  it('rejects join approval for unknown context graphs before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/context-graph/missing-cg/approve-join', {
      agentAddress: CALLER,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.approveJoinRequest).not.toHaveBeenCalled();
  });

  it('rejects join rejection for unknown context graphs before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/context-graph/missing-cg/reject-join', {
      agentAddress: CALLER,
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.rejectJoinRequest).not.toHaveBeenCalled();
  });

  it('rejects manifest publish for unknown context graphs before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/context-graph/missing-cg/manifest/publish', {});

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.assertContextGraphOwner).not.toHaveBeenCalled();
  });

  it('rejects shared-memory writes for unknown context graphs before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/shared-memory/write', {
      contextGraphId: 'missing-cg',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.share).not.toHaveBeenCalled();
  });

  it('rejects shared-memory publish for unknown context graphs before mutation', async () => {
    const agent = makeAgent();
    await startRoutes(agent);

    const result = await post('/api/shared-memory/publish', {
      contextGraphId: 'missing-cg',
      selection: 'all',
    });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ code: 'CONTEXT_GRAPH_NOT_FOUND' });
    expect(agent.calls.publishFromSharedMemory).not.toHaveBeenCalled();
    expect(agent.calls.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });
});
