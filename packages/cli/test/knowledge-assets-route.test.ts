import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';

function createResponse() {
  return {
    statusCode: 0,
    headers: undefined as Record<string, string> | undefined,
    body: '',
    writableEnded: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? '';
      this.writableEnded = true;
      return this;
    },
  };
}

function createRequest(method: string, path: string, body?: unknown): RequestContext['req'] {
  const request = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body))]);
  Object.assign(request, { method, url: path, headers: { host: '127.0.0.1' } });
  return request as RequestContext['req'];
}

function createTracker(): RequestContext['tracker'] {
  return {
    start: vi.fn(),
    trackPhase: vi.fn((_c, _p, fn: () => Promise<unknown>) => fn()),
    complete: vi.fn(),
    fail: vi.fn(),
    setCost: vi.fn(),
    setTxHash: vi.fn(),
  } as unknown as RequestContext['tracker'];
}

function ctxFor(
  method: string,
  path: string,
  body: unknown,
  agent: Record<string, unknown>,
  overrides: Partial<RequestContext> = {},
): RequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = {
    req: createRequest(method, path, method === 'GET' ? undefined : body),
    res: createResponse() as unknown as ServerResponse,
    agent: agent as RequestContext['agent'],
    publisherControl: {} as RequestContext['publisherControl'],
    publisherRuntime: null,
    config: {} as RequestContext['config'],
    startedAt: 0,
    dashDb: { insertNotification: vi.fn() } as unknown as RequestContext['dashDb'],
    opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RequestContext['opWallets'],
    network: null as RequestContext['network'],
    tracker: createTracker(),
    memoryManager: {} as RequestContext['memoryManager'],
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: {} as RequestContext['catchupTracker'],
    extractionRegistry: {} as RequestContext['extractionRegistry'],
    fileStore: {} as RequestContext['fileStore'],
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {} as RequestContext['vectorStore'],
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    routePlugins: [],
    url,
    path: url.pathname,
    requestToken: undefined,
    requestAgentAddress: '0x0000000000000000000000000000000000000001',
  } as RequestContext;
  return { ...ctx, ...overrides } as RequestContext;
}

function body(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}
function status(ctx: RequestContext): number {
  return (ctx.res as unknown as { statusCode: number }).statusCode;
}

function makeAssertionAgent(over: Record<string, any> = {}) {
  const { assertion: assertionOver, ...restOver } = over;
  const knownContextGraphs = [
    { id: 'cg', uri: 'did:dkg:context-graph:cg', isSystem: true, subscribed: true, synced: true },
    {
      id: 'canonical-cg',
      uri: 'did:dkg:context-graph:canonical-cg',
      isSystem: true,
      subscribed: true,
      synced: true,
    },
  ];
  const assertion = {
    create: vi.fn(async (_cg: string, name: string) => `urn:dkg:assertion:cg:agent:${name}`),
    write: vi.fn(async () => undefined),
    finalize: vi.fn(async () => ({ merkleRoot: new Uint8Array([0xab, 0xcd]), eip712Digest: '0xdig' })),
    promote: vi.fn(async () => ({ promotedCount: 3 })),
    discard: vi.fn(async () => undefined),
    history: vi.fn(async () => ({ state: 'created', memoryLayer: 'WorkingMemory' })),
    ...(assertionOver ?? {}),
  };
  return {
    assertion,
    publishFromFinalizedAssertion: vi.fn(async () => ({
      kaId: 7n,
      status: 'confirmed',
      ual: 'did:dkg:hardhat:31337/0xabc/7',
      onChainResult: { txHash: '0xtx' },
      publicQuads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }],
      kaManifest: [{ assertion: 'urn:dkg:assertion:cg:agent:f' }],
    })),
    listContextGraphs: vi.fn(async () => knownContextGraphs),
    contextGraphExists: vi.fn(async (id: string) => knownContextGraphs.some((row) => row.id === id)),
    resolveAgentByToken: vi.fn(),
    ...restOver,
  };
}

describe('GitHub-shaped /api/knowledge-assets routes (OT-RFC-43 §10.5)', () => {
  it('POST /api/knowledge-assets creates a KA + opens a WM draft', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'meeting-notes' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(body(ctx)).toMatchObject({ name: 'meeting-notes', status: 'draft-open' });
    expect(agent.assertion.create).toHaveBeenCalledWith('cg', 'meeting-notes', undefined);
    expect(agent.assertion.write).not.toHaveBeenCalled();
  });

  it('POST /api/knowledge-assets with quads auto-writes + auto-finalizes (sealed assertion v1)', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(body(ctx)).toMatchObject({ status: 'wm-sealed', written: 1, merkleRoot: '0xabcd' });
    expect(agent.assertion.write).toHaveBeenCalledWith('cg', 'f', quads, undefined);
    expect(agent.assertion.finalize).toHaveBeenCalledWith('cg', 'f', {});
  });

  it('POST /api/knowledge-assets resolves DID-form context graph ids before writing', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'did:dkg:context-graph:canonical-cg', name: 'f' },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(agent.assertion.create).toHaveBeenCalledWith('canonical-cg', 'f', undefined);
  });

  it('atomic create passes pre-signed author attestation and scheme version to finalize', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const attestation = {
      address: '0x1111111111111111111111111111111111111111',
      signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
    };
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'cg', name: 'f', quads, preSignedAuthorAttestation: attestation, schemeVersion: 2 },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(agent.assertion.finalize).toHaveBeenCalledWith(
      'cg',
      'f',
      expect.objectContaining({
        preSignedAuthorAttestation: {
          address: attestation.address,
          signature: { r: expect.any(Uint8Array), vs: expect.any(Uint8Array) },
        },
        schemeVersion: 2,
      }),
    );
    expect(agent.assertion.finalize.mock.calls[0][2]).not.toHaveProperty('authorAgentAddress');
  });

  it('atomic create rejects mutually exclusive finalize author inputs', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      {
        contextGraphId: 'cg',
        name: 'f',
        quads,
        authorAgentAddress: '0x1111111111111111111111111111111111111111',
        preSignedAuthorAttestation: {
          address: '0x2222222222222222222222222222222222222222',
          signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
        },
      },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('mutually exclusive');
    expect(agent.assertion.create).not.toHaveBeenCalled();
  });

  it('POST /api/knowledge-assets emits legacy side effects through publish', async () => {
    const agent = makeAssertionAgent();
    const emitMemoryGraphChanged = vi.fn();
    const emitNotification = vi.fn();
    const insertNotification = vi.fn();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true, alsoPublishVm: true },
      agent,
      {
        emitMemoryGraphChanged,
        emitNotification,
        dashDb: { insertNotification } as unknown as RequestContext['dashDb'],
      },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(emitMemoryGraphChanged.mock.calls.map(([event]) => event.operation)).toEqual([
      'assertion_created',
      'assertion_written',
      'assertion_finalized',
      'assertion_promoted',
      'shared_memory_published',
    ]);
    expect(emitMemoryGraphChanged.mock.calls.at(-1)?.[0]).toMatchObject({ clearSharedMemoryAfter: false });
    expect(insertNotification).toHaveBeenCalledTimes(3);
    expect(emitNotification).toHaveBeenCalledTimes(3);
  });

  it('atomic create with also* tails returns 207 when a tail fails', async () => {
    const agent = makeAssertionAgent({
      assertion: { promote: vi.fn(async () => { throw new Error('CCL denied'); }) },
    });
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    const b = body(ctx);
    expect(b.created).toBe(true);
    expect(b.merkleRoot).toBe('0xabcd'); // the sealed assertion is a real artifact
    expect(Array.isArray(b.errors)).toBe(true);
    expect((b.errors as any[])[0]).toMatchObject({ phase: 'swm-share' });
  });

  it('POST .../:name/wm/write appends quads', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/write', { contextGraphId: 'cg', quads }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ written: 1 });
    expect(agent.assertion.write).toHaveBeenCalledWith('cg', 'f', quads, undefined);
  });

  it('POST .../:name/wm/write reports malformed percent-encoding as a 400', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets/%E0%A4%A/wm/write', { contextGraphId: 'cg', quads }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx)).toMatchObject({ error: 'Malformed percent-encoding in URL path' });
    expect(agent.assertion.write).not.toHaveBeenCalled();
  });

  it('POST .../:name/wm/finalize seals the draft', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/finalize', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ merkleRoot: '0xabcd', eip712Digest: '0xdig' });
  });

  it('POST .../:name/wm/discard emits the WM discard side effect', async () => {
    const agent = makeAssertionAgent();
    const emitMemoryGraphChanged = vi.fn();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/wm/discard',
      { contextGraphId: 'cg' },
      agent,
      { emitMemoryGraphChanged },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith(
      expect.objectContaining({ contextGraphId: 'cg', operation: 'assertion_discarded' }),
    );
  });

  it('POST .../:name/swm/share advances the SWM pointer (promote→share)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/swm/share', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ swmShared: true, promotedCount: 3 });
    expect(agent.assertion.promote).toHaveBeenCalledOnce();
  });

  it('POST .../:name/vm/publish mints/updates on chain', async () => {
    const agent = makeAssertionAgent();
    const emitMemoryGraphChanged = vi.fn();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', options: { clearAfter: true } },
      agent,
      { emitMemoryGraphChanged },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ status: 'confirmed', ual: 'did:dkg:hardhat:31337/0xabc/7', txHash: '0xtx' });
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledWith('cg', 'f', { clearSharedMemoryAfter: true });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'shared_memory_published',
        clearSharedMemoryAfter: true,
      }),
    );
  });

  it('GET /api/knowledge-assets/:name returns lifecycle state', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ state: 'created', memoryLayer: 'WorkingMemory' });
  });

  it('GET /api/knowledge-assets/:name normalizes DID-form context graph ids for history', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f?contextGraphId=did:dkg:context-graph:cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.assertion.history).toHaveBeenCalledWith('cg', 'f', undefined);
  });

  it('GET /api/knowledge-assets/:name validates history query params before dispatch', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f?contextGraphId=cg&subGraphName=_bad', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(agent.assertion.history).not.toHaveBeenCalled();
  });

  it('POST .../:name/wm/pull-from is 501 (net-new, follow-up)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/pull-from', { contextGraphId: 'cg', layer: 'vm' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(501);
  });

  it('ignores non-/api/knowledge-assets paths', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/assertion/create', { contextGraphId: 'cg', name: 'f' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(ctx.res.writableEnded).toBe(false); // not handled here
  });

  // ── Review follow-ups (88ab898 re-review) ──────────────────────────────────

  it('atomic create rejects also* tails without quads (nothing to finalize)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', alsoShareSwm: true }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('require "quads"');
    expect(agent.assertion.create).not.toHaveBeenCalled();
  });

  it('atomic create rejects alsoPublishVm without alsoShareSwm (publish reads from SWM)', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads, alsoPublishVm: true }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('requires "alsoShareSwm"');
    expect(agent.assertion.create).not.toHaveBeenCalled();
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('atomic create reports the real VM status (207) when publish is not confirmed', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({
        kaId: 7n,
        status: 'tentative',
        ual: 'did:dkg:hardhat:31337/0xabc/7',
        onChainResult: { txHash: '0xtx' },
        publicQuads: [],
        kaManifest: [],
      })),
    });
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true, alsoPublishVm: true },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    const b = body(ctx);
    expect(b.status).toBe('vm-tentative'); // NOT a false "vm-confirmed"
    expect(b.vmStatus).toBe('tentative');
    expect((b.errors as any[]).some((e) => e.phase === 'vm-publish')).toBe(true);
  });

  it('vm/publish coerces publishEpochs / publisherNodeIdentityIdOverride before publishing', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', options: { publishEpochs: '5', publisherNodeIdentityIdOverride: '9' } },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledWith('cg', 'f', {
      publishEpochs: 5, // number, not the JSON string "5"
      publisherNodeIdentityIdOverride: 9n, // bigint
    });
  });

  it('vm/publish rejects an invalid publishEpochs with a 400 (not a 500)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', options: { publishEpochs: 'abc' } },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('publishEpochs');
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('vm/publish surfaces a non-throwing contextGraphError as 207', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({
        kaId: 7n,
        status: 'confirmed',
        ual: 'did:dkg:hardhat:31337/0xabc/7',
        onChainResult: { txHash: '0xtx' },
        publicQuads: [],
        kaManifest: [],
        contextGraphError: 'context graph not subscribed',
      })),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    expect(body(ctx).contextGraphError).toBe('context graph not subscribed');
  });

  it('unknown POST (layer, verb) shapes fall through to the daemon 404 without reading the body', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/foo/bar', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(ctx.res.writableEnded).toBe(false); // not handled → daemon 404
    expect(agent.assertion.create).not.toHaveBeenCalled();
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });
});
