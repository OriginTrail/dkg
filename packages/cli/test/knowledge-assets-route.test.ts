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
    finalize: vi.fn(async (_cg: string, name: string) => ({
      assertionUri: `urn:dkg:assertion:cg:agent:${name}`,
      merkleRoot: new Uint8Array([0xab, 0xcd]),
      authorAddress: '0x1111111111111111111111111111111111111111',
      schemeVersion: 1,
      chainId: 31337n,
      kav10Address: '0x2222222222222222222222222222222222222222',
      eip712Digest: '0xdig',
    })),
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
      assertionUri: 'urn:dkg:assertion:cg:agent:f',
      ual: 'did:dkg:hardhat:31337/0xabc/7',
      onChainResult: { txHash: '0xtx', blockNumber: 123 },
      publicQuads: [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }],
      kaManifest: [{ tokenId: 1n, rootEntity: 'ex:A', assertion: 'urn:dkg:assertion:cg:agent:f' }],
      seal: {
        assertionUri: 'urn:dkg:assertion:cg:agent:f',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        authorAddress: '0x1111111111111111111111111111111111111111',
      },
    })),
    listContextGraphs: vi.fn(async () => knownContextGraphs),
    contextGraphExists: vi.fn(async (id: string) => knownContextGraphs.some((row) => row.id === id)),
    getContextGraphOnChainId: vi.fn(async () => '7'),
    getStoredContextGraphRegistrationOptions: vi.fn(async () => ({})),
    registerContextGraph: vi.fn(async () => ({ contextGraphId: '7' })),
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
    expect(body(ctx)).toMatchObject({
      status: 'wm-sealed',
      assertionUri: 'urn:dkg:assertion:cg:agent:f',
      written: 1,
      merkleRoot: '0xabcd',
      authorAddress: '0x1111111111111111111111111111111111111111',
      schemeVersion: 1,
      chainId: '31337',
      kav10Address: '0x2222222222222222222222222222222222222222',
      eip712Digest: '0xdig',
    });
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

  it('atomic create returns partial success if write fails after create', async () => {
    const agent = makeAssertionAgent({
      assertion: {
        write: vi.fn(async () => { throw new Error('reserved namespace'); }),
      },
    });
    const quads = [{ subject: 'urn:dkg:file:x', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    expect(body(ctx)).toMatchObject({
      created: true,
      assertionUri: 'urn:dkg:assertion:cg:agent:f',
      status: 'draft-open',
    });
    expect((body(ctx).errors as any[])[0]).toMatchObject({ phase: 'wm-write' });
    expect(agent.assertion.create).toHaveBeenCalledOnce();
    expect(agent.assertion.finalize).not.toHaveBeenCalled();
  });

  it('atomic create returns partial success if finalize fails after write', async () => {
    const agent = makeAssertionAgent({
      assertion: {
        finalize: vi.fn(async () => { throw new Error('signer mismatch'); }),
      },
    });
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    expect(body(ctx)).toMatchObject({
      created: true,
      assertionUri: 'urn:dkg:assertion:cg:agent:f',
      status: 'wm-written',
      written: 1,
    });
    expect((body(ctx).errors as any[])[0]).toMatchObject({ phase: 'wm-finalize' });
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
    expect(body(ctx)).toMatchObject({
      assertionUri: 'urn:dkg:assertion:cg:agent:f',
      merkleRoot: '0xabcd',
      authorAddress: '0x1111111111111111111111111111111111111111',
      schemeVersion: 1,
      chainId: '31337',
      kav10Address: '0x2222222222222222222222222222222222222222',
      eip712Digest: '0xdig',
    });
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
    expect(body(ctx)).toMatchObject({
      kaId: '7',
      assertionUri: 'urn:dkg:assertion:cg:agent:f',
      authorAddress: '0x1111111111111111111111111111111111111111',
      merkleRoot: '0xabcd',
      blockNumber: 123,
      kas: [{ tokenId: '1', rootEntity: 'ex:A' }],
    });
    // The third arg also carries an `operationCtx` from the F22 tracker
    // helper; using `objectContaining` keeps the assertion pinned to the
    // publish-control coercion without coupling it to the tracker dance.
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledWith(
      'cg',
      'f',
      expect.objectContaining({ clearSharedMemoryAfter: true }),
    );
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

  it('GET /api/knowledge-assets/:name passes explicit agentAddress to history', async () => {
    const agent = makeAssertionAgent();
    const owner = '0x2222222222222222222222222222222222222222';
    const ctx = ctxFor('GET', `/api/knowledge-assets/f?contextGraphId=cg&agentAddress=${owner}`, undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.assertion.history).toHaveBeenCalledWith('cg', 'f', { agentAddress: owner });
  });

  it('GET /api/knowledge-assets/:name rejects malformed agentAddress', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f?contextGraphId=cg&agentAddress=bad%20actor', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(agent.assertion.history).not.toHaveBeenCalled();
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

  it('atomic create skips vm/publish when swm/share fails', async () => {
    const agent = makeAssertionAgent({
      assertion: {
        promote: vi.fn(async () => {
          throw new Error('CCL denied');
        }),
      },
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
    expect((body(ctx).errors as any[]).map((e) => e.phase)).toEqual(['swm-share']);
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
    expect(agent.registerContextGraph).not.toHaveBeenCalled();
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
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledWith(
      'cg',
      'f',
      expect.objectContaining({
        publishEpochs: 5, // number, not the JSON string "5"
        publisherNodeIdentityIdOverride: 9n, // bigint
      }),
    );
  });

  it('vm/publish accepts legacy top-level publish controls', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', clearAfter: true, publishEpochs: '6', publisherNodeIdentityIdOverride: '10' },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledWith(
      'cg',
      'f',
      expect.objectContaining({
        clearSharedMemoryAfter: true,
        publishEpochs: 6,
        publisherNodeIdentityIdOverride: 10n,
      }),
    );
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

  it('vm/publish surfaces a non-confirmed status as 207', async () => {
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
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    expect(body(ctx)).toMatchObject({ status: 'tentative' });
  });

  it('vm/publish does not emit published activity for partial-success results', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({
        kaId: 7n,
        status: 'tentative',
        ual: 'did:dkg:hardhat:31337/0xabc/7',
        publicQuads: [],
        kaManifest: [],
      })),
    });
    const emitMemoryGraphChanged = vi.fn();
    const insertNotification = vi.fn(() => 1);
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg' },
      agent,
      {
        emitMemoryGraphChanged,
        dashDb: { insertNotification } as unknown as RequestContext['dashDb'],
      },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    expect(emitMemoryGraphChanged).not.toHaveBeenCalled();
    expect(insertNotification).not.toHaveBeenCalled();
  });

  it('vm/publish auto-registers a local-only context graph before named publish', async () => {
    const agent = makeAssertionAgent({
      getContextGraphOnChainId: vi.fn(async () => null),
      getStoredContextGraphRegistrationOptions: vi.fn(async () => ({
        publishPolicy: 0,
        publishAuthorityAccountId: 99n,
      })),
      registerContextGraph: vi.fn(async () => ({ contextGraphId: '7' })),
    });
    const tracker = createTracker();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg' },
      agent,
      { tracker, requestAgentAddress: '0x0000000000000000000000000000000000000001' },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.registerContextGraph).toHaveBeenCalledWith('cg', {
      publishPolicy: 0,
      publishAuthorityAccountId: 99n,
    });
    expect((tracker as any).trackPhase.mock.calls.map((call: any[]) => call[1])).toContain('register-on-chain');
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
  });

  it('vm/publish forwards the token-scoped agent when auto-registering', async () => {
    const tokenAgent = '0x2222222222222222222222222222222222222222';
    const agent = makeAssertionAgent({
      getContextGraphOnChainId: vi.fn(async () => null),
      resolveAgentByToken: vi.fn(() => tokenAgent),
      registerContextGraph: vi.fn(async () => ({ contextGraphId: '7' })),
    });
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg' },
      agent,
      {
        requestToken: 'agent-token',
        requestAgentAddress: '0x0000000000000000000000000000000000000001',
      },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.registerContextGraph).toHaveBeenCalledWith('cg', {
      callerAgentAddress: tokenAgent,
    });
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
  });

  it('vm/publish maps auto-registration failures to a client error', async () => {
    const agent = makeAssertionAgent({
      getContextGraphOnChainId: vi.fn(async () => null),
      registerContextGraph: vi.fn(async () => {
        throw new Error('insufficient TRAC');
      }),
    });
    const tracker = createTracker();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg' },
      agent,
      { tracker },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('could not be auto-registered on-chain before publish');
    expect(body(ctx).error).toContain('insufficient TRAC');
    expect((tracker as any).fail).toHaveBeenCalledTimes(1);
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('atomic alsoPublishVm auto-registers a local-only context graph before named publish', async () => {
    const agent = makeAssertionAgent({
      getContextGraphOnChainId: vi.fn(async () => null),
      registerContextGraph: vi.fn(async () => ({ contextGraphId: '7' })),
    });
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true, alsoPublishVm: true },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(agent.registerContextGraph).toHaveBeenCalledWith('cg', expect.any(Object));
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
  });

  it('vm/publish rejects mis-typed clearAfter before publishing', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', options: { clearAfter: 'false' } },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('"clearAfter" must be a boolean');
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('unknown POST (layer, verb) shapes fall through to the daemon 404 without reading the body', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/foo/bar', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(ctx.res.writableEnded).toBe(false); // not handled → daemon 404
    expect(agent.assertion.create).not.toHaveBeenCalled();
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  // ── 34ae7dd1f re-review ─────────────────────────────────────────────────────

  it('atomic create rejects a non-boolean alsoShareSwm (truthiness footgun)', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: 'false' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('"alsoShareSwm" must be a boolean');
    expect(agent.assertion.create).not.toHaveBeenCalled();
  });

  it('atomic create rejects an alsoPublishVm that is neither boolean nor an options object', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true, alsoPublishVm: 'yes' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('"alsoPublishVm" must be a boolean or an inline publish-options object');
    expect(agent.assertion.create).not.toHaveBeenCalled();
  });

  it('atomic create accepts an inline alsoPublishVm options object and coerces it', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true, alsoPublishVm: { publishEpochs: '4' } },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledWith(
      'cg',
      'f',
      expect.objectContaining({ publishEpochs: 4 }),
    );
  });

  it('attributes the published activity row to the seal author, not the request token', async () => {
    const sealAuthor = '0xAAaAAaAAaAAAAAAAaaAAaAaAaaAAaAaaAaAAAAaa';
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({
        kaId: 7n,
        status: 'confirmed',
        ual: 'did:dkg:hardhat:31337/0xabc/7',
        onChainResult: { txHash: '0xtx' },
        publicQuads: [],
        kaManifest: [],
        seal: { authorAddress: sealAuthor },
      })),
    });
    const insertNotification = vi.fn(() => 1);
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true, alsoPublishVm: true },
      agent,
      {
        emitNotification: vi.fn(),
        dashDb: { insertNotification } as unknown as RequestContext['dashDb'],
        requestAgentAddress: '0x0000000000000000000000000000000000000001',
      },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    const publishedMeta = insertNotification.mock.calls
      .map(([row]: [any]) => JSON.parse(row.meta))
      .find((m: any) => m.kind === 'published');
    expect(publishedMeta).toBeTruthy();
    expect(String(publishedMeta.actorAgentDid).toLowerCase()).toContain(sealAuthor.toLowerCase());
  });

  it('attributes atomic created/promoted activities to the pre-signed author', async () => {
    const attestedAuthor = '0x3333333333333333333333333333333333333333';
    const agent = makeAssertionAgent();
    const insertNotification = vi.fn(() => 1);
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      {
        contextGraphId: 'cg',
        name: 'f',
        quads,
        alsoShareSwm: true,
        preSignedAuthorAttestation: {
          address: attestedAuthor,
          signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
        },
      },
      agent,
      {
        emitNotification: vi.fn(),
        dashDb: { insertNotification } as unknown as RequestContext['dashDb'],
        requestAgentAddress: '0x0000000000000000000000000000000000000001',
      },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    const activityMetas = insertNotification.mock.calls.map(([row]: [any]) => JSON.parse(row.meta));
    for (const kind of ['created', 'promoted']) {
      const meta = activityMetas.find((m: any) => m.kind === kind);
      expect(meta).toBeTruthy();
      expect(String(meta.actorAgentDid).toLowerCase()).toContain(attestedAuthor.toLowerCase());
    }
  });

  it('per-layer GET /:name/{wm,swm,vm} is unclaimed until per-layer mapping exists', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f/swm?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(0);
    expect((ctx.res as any).writableEnded).toBe(false);
    expect(agent.assertion.history).not.toHaveBeenCalled();
  });

  // ── 5fd83a15 / f1a6e0f6 follow-up review (codex round 6) ────────────────────

  it('POST with a known verb but trailing suffix segments falls through (F20: exact segment count)', async () => {
    // Pre-fix `isSupportedPostShape` only checked (layer, verb) and accepted
    // ANY segment count, so `/f/vm/publish/extra` matched (`vm`, `publish`)
    // and ran the publish side effect. The fix pins each known POST shape
    // to `segs.length === 3` (`<name>/<layer>/<verb>`).
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish/extra',
      { contextGraphId: 'cg' },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(ctx.res.writableEnded).toBe(false); // falls through to daemon 404
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('POST trailing suffix on other shapes also falls through (F20 coverage)', async () => {
    // Same regression for `wm/write` (the only quad-bearing verb) and
    // `swm/share` — every supported (layer, verb) MUST require an exact
    // 3-segment path.
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];

    const writeCtx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/wm/write/extra',
      { contextGraphId: 'cg', quads },
      agent,
    );
    await handleKnowledgeAssetsRoutes(writeCtx);
    expect(writeCtx.res.writableEnded).toBe(false);
    expect(agent.assertion.write).not.toHaveBeenCalled();

    const shareCtx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/swm/share/extra',
      { contextGraphId: 'cg' },
      agent,
    );
    await handleKnowledgeAssetsRoutes(shareCtx);
    expect(shareCtx.res.writableEnded).toBe(false);
    expect(agent.assertion.promote).not.toHaveBeenCalled();
  });

  it('control verbs reject oversize bodies (F21: SMALL_BODY_BYTES cap)', async () => {
    // `wm/finalize`, `wm/discard`, `swm/share`, `vm/publish` only carry
    // scalar control fields — they MUST inherit the legacy
    // `SMALL_BODY_BYTES` (256 KB) cap, not the 10 MB default. A 1 MB body
    // here is well above the small cap; `readBody` throws
    // `PayloadTooLargeError` which the daemon's outer error mapper
    // (not tested here) surfaces as 413. We assert the route never
    // reaches the storage layer.
    const agent = makeAssertionAgent();
    const oversize = 'x'.repeat(1024 * 1024); // 1 MB
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/wm/finalize',
      { contextGraphId: 'cg', filler: oversize },
      agent,
    );
    let caught: unknown;
    try {
      await handleKnowledgeAssetsRoutes(ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('PayloadTooLargeError');
    expect((caught as Error).message).toContain(String(256 * 1024));
    expect(agent.assertion.finalize).not.toHaveBeenCalled();
  });

  it('wm/write keeps the large body cap (F21: quad-bearing verbs)', async () => {
    // `wm/write` is the only sub-route that carries quads, so it MUST
    // retain the default `MAX_BODY_BYTES` cap — the same 1 MB body that
    // tripped finalize above goes through here.
    const agent = makeAssertionAgent();
    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
    // ~50 KB per quad × 30 = ~1.5 MB of quad payload — comfortably above
    // SMALL_BODY_BYTES (256 KB) and below MAX_BODY_BYTES (10 MB).
    const big = 'y'.repeat(50 * 1024);
    for (let i = 0; i < 30; i++) {
      quads.push({ subject: 'ex:A', predicate: 'ex:p', object: `"${big}-${i}"`, graph: '' });
    }
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/wm/write',
      { contextGraphId: 'cg', quads },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ written: 30 });
    expect(agent.assertion.write).toHaveBeenCalledOnce();
  });

  it('vm/publish records the operation through the tracker (F22)', async () => {
    const agent = makeAssertionAgent();
    const tracker = createTracker();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg' },
      agent,
      { tracker },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    // tracker.start fired with the contextGraph + source=api details
    expect((tracker as any).start).toHaveBeenCalledTimes(1);
    expect((tracker as any).start.mock.calls[0][1]).toMatchObject({
      contextGraphId: 'cg',
      details: { source: 'api', assertionName: 'f' },
    });
    // The publish call was wrapped in `trackPhase('read-shared-memory', ...)`
    expect((tracker as any).trackPhase).toHaveBeenCalledTimes(1);
    expect((tracker as any).trackPhase.mock.calls[0][1]).toBe('read-shared-memory');
    // Tx coordinates from the mock onChainResult landed on the operation row.
    expect((tracker as any).setTxHash).toHaveBeenCalledWith(expect.anything(), '0xtx', undefined);
    // Non-throwing publish ⇒ complete (not fail) — even when the HTTP
    // status ends up being 207 for a partial-success the operation itself
    // completed (mirrors the legacy memory.ts pattern).
    expect((tracker as any).complete).toHaveBeenCalledTimes(1);
    expect((tracker as any).fail).not.toHaveBeenCalled();
    // operationCtx threads into the publish call so the publisher's own
    // phase markers attach to the same operation row.
    const [, , publishOpts] = (agent.publishFromFinalizedAssertion as any).mock.calls[0];
    expect(publishOpts).toHaveProperty('operationCtx');
  });

  it('vm/publish rejects malformed options before publishing', async () => {
    const agent = makeAssertionAgent();
    const tracker = createTracker();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', options: 'bad' },
      agent,
      { tracker },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('"options" must be an object');
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
    expect((tracker as any).start).not.toHaveBeenCalled();
  });

  it('vm/publish rejects array options before publishing', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', options: [] },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('"options" must be an object');
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('vm/publish rejects author override fields before publishing', async () => {
    const agent = makeAssertionAgent();
    const tracker = createTracker();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      {
        contextGraphId: 'cg',
        authorAgentAddress: '0x1111111111111111111111111111111111111111',
      },
      agent,
      { tracker },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('cannot be combined with "assertionName"');
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
    expect((tracker as any).start).not.toHaveBeenCalled();
  });

  it('vm/publish rejects nested author override fields before publishing', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      {
        contextGraphId: 'cg',
        options: {
          preSignedAuthorAttestation: {
            address: '0x1111111111111111111111111111111111111111',
            signature: { r: '0x' + '11'.repeat(32), vs: '0x' + '22'.repeat(32) },
          },
        },
      },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('cannot be combined with "assertionName"');
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('vm/publish rejects selection overrides before publishing', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg', selection: { rootEntities: ['ex:A'] } },
      agent,
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('"selection" must be omitted or "all"');
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it.each([
    'Assertion f is not finalized',
    'seal binds chainId 1 but runtime chainId is 2',
    'seal binds KAv10 0xabc but runtime KAv10 is 0xdef',
    'expectedMerkleRoot mismatch',
    'precomputedAttestation signer mismatch',
  ])('vm/publish maps finalized assertion validation failure to 400: %s', async (message) => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => {
        throw new Error(message);
      }),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain(message);
  });

  it('vm/publish maps not-registered-on-chain failures to 400', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => {
        throw new Error('Context graph "cg" is not registered on-chain');
      }),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('not registered on-chain');
  });

  it('wm/finalize maps not-registered-on-chain failures to 400', async () => {
    const agent = makeAssertionAgent({
      assertion: {
        finalize: vi.fn(async () => {
          throw new Error('Context graph "cg" is not registered on-chain');
        }),
      },
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/finalize', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('not registered on-chain');
  });

  it('vm/publish records a tracker.fail when the publish throws (F22)', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => {
        throw new Error('chain down');
      }),
    });
    const tracker = createTracker();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/f/vm/publish',
      { contextGraphId: 'cg' },
      agent,
      { tracker },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    // Outer catch maps the throw to a 500 (no `routeError` match for
    // "chain down"); the operation row is still flushed via tracker.fail.
    expect(status(ctx)).toBe(500);
    expect((tracker as any).fail).toHaveBeenCalledTimes(1);
    expect((tracker as any).complete).not.toHaveBeenCalled();
  });

  it('atomic create publish tail also records through the tracker (F22)', async () => {
    const agent = makeAssertionAgent();
    const tracker = createTracker();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets',
      { contextGraphId: 'cg', name: 'f', quads, alsoShareSwm: true, alsoPublishVm: true },
      agent,
      { tracker },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect((tracker as any).start).toHaveBeenCalledTimes(1);
    expect((tracker as any).complete).toHaveBeenCalledTimes(1);
    expect((tracker as any).fail).not.toHaveBeenCalled();
  });
});
