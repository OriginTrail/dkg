import { describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { handleAssertionRoutes } from '../src/daemon/routes/assertion.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';

function createResponse() {
  const response = {
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
  return response;
}

function createPostRequest(path: string, body: unknown): RequestContext['req'] {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(request, {
    method: 'POST',
    url: path,
    headers: { host: '127.0.0.1' },
  });
  return request as RequestContext['req'];
}

function createTracker(): RequestContext['tracker'] {
  return {
    start: vi.fn(),
    trackPhase: vi.fn((_ctx, _phase, fn: () => Promise<unknown>) => fn()),
    complete: vi.fn(),
    fail: vi.fn(),
    setCost: vi.fn(),
    setTxHash: vi.fn(),
  } as unknown as RequestContext['tracker'];
}

function createContext(path: string, body: unknown, overrides: Partial<RequestContext> = {}): RequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    req: createPostRequest(path, body),
    res: createResponse() as unknown as ServerResponse,
    agent: {} as RequestContext['agent'],
    publisherControl: {} as RequestContext['publisherControl'],
    publisherRuntime: null,
    config: {} as RequestContext['config'],
    startedAt: 0,
    dashDb: {} as RequestContext['dashDb'],
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
    url,
    path: url.pathname,
    requestToken: undefined,
    requestAgentAddress: '0x0000000000000000000000000000000000000001',
    ...overrides,
  };
}

function responseBody(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}

describe('daemon memory_graph_changed route emissions', () => {
  it('emits metadata-only SWM refresh events after shared-memory writes', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const share = vi.fn().mockResolvedValue({ shareOperationId: 'op-1' });
    const ctx = createContext('/api/shared-memory/write', {
      contextGraphId: 'project-a',
      subGraphName: 'notes',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    }, {
      agent: { share } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({ contextGraphId: 'project-a', triplesWritten: 1 });
    expect(share.mock.calls[0][2]).toMatchObject({
      subGraphName: 'notes',
      localOnly: false,
      callerAgentAddress: '0x0000000000000000000000000000000000000001',
    });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['swm'],
      subGraphName: 'notes',
      operation: 'shared_memory_written',
      source: 'api',
      counts: { triples: 1 },
    });
    expect(emitMemoryGraphChanged.mock.calls[0][0]).not.toHaveProperty('quads');
    expect(emitMemoryGraphChanged.mock.calls[0][0]).not.toHaveProperty('content');
  });

  it('emits an assertion_created refresh on standalone /api/assertion/create', async () => {
    // Pins the contract that every standalone lifecycle route fires its own
    // memory_graph_changed SSE. The chained /create handler emits all four
    // (created/written/finalized/promoted) inside one call, but a client that
    // composes the chain by hand (e.g. staking-ui, or any external integrator
    // calling create → write → finalize → promote in four separate POSTs) sees
    // events ONLY if each standalone route emits independently. A regression
    // where one of the four routes silently dropped its emit (we caught
    // exactly this in /finalize during PR #436 devnet validation) would break
    // any UI watching the graph state machine.
    const emitMemoryGraphChanged = vi.fn();
    const create = vi.fn().mockResolvedValue('did:dkg:context-graph:project-a/assertion/0x0/draft');
    const ctx = createContext('/api/assertion/create', {
      contextGraphId: 'project-a',
      name: 'draft',
      subGraphName: 'notes',
    }, {
      agent: { assertion: { create }, resolveAgentByToken: () => undefined } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleAssertionRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({ assertionUri: expect.stringContaining('draft') });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['wm'],
      subGraphName: 'notes',
      operation: 'assertion_created',
      source: 'api',
      counts: { triples: 0 },
    });
  });

  it('emits an assertion_finalized refresh on standalone /api/assertion/:name/finalize', async () => {
    // Regression test for the bug found during PR #436 devnet validation:
    // the chained /create handler emitted memory_graph_changed for the
    // finalize step, but the standalone /api/assertion/:name/finalize route
    // returned the EIP-712 seal without emitting. A staking-ui or external
    // tool composing the lifecycle by hand would silently miss the
    // 'assertion_finalized' state transition. Fixed by mirroring the chained
    // handler's emit pattern in the standalone route.
    const emitMemoryGraphChanged = vi.fn();
    const finalize = vi.fn().mockResolvedValue({
      assertionUri: 'did:dkg:context-graph:project-a/assertion/0x0/draft',
      merkleRoot: new Uint8Array(32),
      authorAddress: '0x0000000000000000000000000000000000000000',
      schemeVersion: 1,
      chainId: 31337n,
      kav10Address: '0x0000000000000000000000000000000000000001',
      eip712Digest: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    const ctx = createContext('/api/assertion/draft/finalize', {
      contextGraphId: 'project-a',
      subGraphName: 'notes',
    }, {
      agent: { assertion: { finalize }, resolveAgentByToken: () => undefined } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleAssertionRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({
      assertionUri: expect.stringContaining('draft'),
      schemeVersion: 1,
    });
    expect(finalize).toHaveBeenCalledWith('project-a', 'draft', { subGraphName: 'notes' });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['wm'],
      subGraphName: 'notes',
      operation: 'assertion_finalized',
      source: 'api',
    });
  });

  it('emits WM refresh events after assertion writes', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    const ctx = createContext('/api/assertion/draft/write', {
      contextGraphId: 'project-a',
      subGraphName: 'notes',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    }, {
      agent: { assertion: { write } } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleAssertionRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({ written: 1 });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['wm'],
      subGraphName: 'notes',
      operation: 'assertion_written',
      source: 'api',
      counts: { triples: 1 },
    });
  });

  it('emits WM and SWM refresh events after assertion promotion', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const promote = vi.fn().mockResolvedValue({ promotedCount: 2 });
    const ctx = createContext('/api/assertion/draft/promote', {
      contextGraphId: 'project-a',
      subGraphName: 'notes',
      entities: ['urn:root'],
    }, {
      agent: { assertion: { promote } } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleAssertionRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({ promotedCount: 2 });
    expect(promote).toHaveBeenCalledWith('project-a', 'draft', {
      entities: ['urn:root'],
      subGraphName: 'notes',
    });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['wm', 'swm'],
      subGraphName: 'notes',
      operation: 'assertion_promoted',
      source: 'api',
      counts: { triples: 2 },
    });
  });

  it('does not emit when shared-memory validation fails', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const share = vi.fn();
    const ctx = createContext('/api/shared-memory/write', {
      contextGraphId: 'project-a',
      quads: [],
    }, {
      agent: { share } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(400);
    expect(share).not.toHaveBeenCalled();
    expect(emitMemoryGraphChanged).not.toHaveBeenCalled();
  });

  it('rejects unsafe shared-memory contextGraphId before calling the agent', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const share = vi.fn();
    const ctx = createContext('/api/shared-memory/write', {
      contextGraphId: 'bad<id',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
    }, {
      agent: { share } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(400);
    expect(responseBody(ctx).error).toMatch(/Invalid "contextGraphId"/);
    expect(share).not.toHaveBeenCalled();
    expect(emitMemoryGraphChanged).not.toHaveBeenCalled();
  });

  it('threads callerAgentAddress into conditional shared-memory writes', async () => {
    const conditionalShare = vi.fn().mockResolvedValue({ shareOperationId: 'op-cas' });
    const ctx = createContext('/api/shared-memory/conditional-write', {
      contextGraphId: 'project-a',
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
      conditions: [{ subject: 'urn:s', predicate: 'urn:p', expectedValue: null }],
    }, {
      agent: { conditionalShare } as unknown as RequestContext['agent'],
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(conditionalShare.mock.calls[0][3]).toMatchObject({
      callerAgentAddress: '0x0000000000000000000000000000000000000001',
    });
  });

  it('threads callerAgentAddress into memory-turn SWM writes', async () => {
    const share = vi.fn().mockResolvedValue({ shareOperationId: 'op-turn' });
    const emitMemoryGraphChanged = vi.fn();
    const fileStore = {
      put: vi.fn().mockResolvedValue({ keccak256: 'turnhash' }),
    };
    const ctx = createContext('/api/memory/turn', {
      contextGraphId: 'project-a',
      markdown: '# Turn\n\nRemember this.',
      layer: 'swm',
    }, {
      agent: { peerId: 'peer-test', share } as unknown as RequestContext['agent'],
      fileStore: fileStore as unknown as RequestContext['fileStore'],
      emitMemoryGraphChanged,
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({ layer: 'swm', fileHash: 'turnhash' });
    expect(share.mock.calls[0][2]).toMatchObject({
      subGraphName: undefined,
      localOnly: false,
      callerAgentAddress: '0x0000000000000000000000000000000000000001',
    });
  });

  it('emits SWM and VM refresh events after confirmed selective publishes', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const publishFromSharedMemory = vi.fn().mockResolvedValue({
      kcId: 'kc-1',
      status: 'confirmed',
      kaManifest: [{ tokenId: 1n, rootEntity: 'urn:root' }],
      publicQuads: [
        { subject: 'urn:root', predicate: 'urn:p1', object: 'urn:o1', graph: 'urn:g' },
        { subject: 'urn:root', predicate: 'urn:p2', object: 'urn:o2', graph: 'urn:g' },
      ],
    });
    const ctx = createContext('/api/shared-memory/publish', {
      contextGraphId: 'project-a',
      subGraphName: 'notes',
      selection: ['urn:root'],
      clearAfter: false,
    }, {
      agent: { publishFromSharedMemory } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({
      kcId: 'kc-1',
      status: 'confirmed',
      kas: [{ tokenId: '1', rootEntity: 'urn:root' }],
    });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['swm', 'vm'],
      subGraphName: 'notes',
      operation: 'shared_memory_published',
      source: 'api',
      clearSharedMemoryAfter: false,
      status: 'confirmed',
      counts: { roots: 1, triples: 2 },
    });
    expect(ctx.tracker.complete).toHaveBeenCalledWith(expect.anything(), { tripleCount: 2 });
  });

  it('keeps implicit same-graph publishes out of the remap path', async () => {
    const publishFromSharedMemory = vi.fn().mockResolvedValue({
      kcId: 'kc-1',
      status: 'confirmed',
      kaManifest: [{ tokenId: 1n, rootEntity: 'urn:root' }],
      publicQuads: [{ subject: 'urn:root', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' }],
    });
    const getContextGraphOnChainId = vi.fn().mockResolvedValue('7');
    const ctx = createContext('/api/shared-memory/publish', {
      contextGraphId: 'project-a',
      selection: ['urn:root'],
    }, {
      agent: { publishFromSharedMemory, getContextGraphOnChainId } as unknown as RequestContext['agent'],
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(getContextGraphOnChainId).not.toHaveBeenCalled();
    expect(publishFromSharedMemory.mock.calls[0][2]).not.toHaveProperty('contextGraphId');
  });

  it('still forwards explicit publishContextGraphId as a remap request', async () => {
    const publishFromSharedMemory = vi.fn().mockResolvedValue({
      kcId: 'kc-1',
      status: 'confirmed',
      kaManifest: [{ tokenId: 1n, rootEntity: 'urn:root' }],
      publicQuads: [{ subject: 'urn:root', predicate: 'urn:p', object: 'urn:o', graph: 'urn:g' }],
    });
    const ctx = createContext('/api/shared-memory/publish', {
      contextGraphId: 'project-a',
      publishContextGraphId: '7',
      selection: ['urn:root'],
    }, {
      agent: { publishFromSharedMemory } as unknown as RequestContext['agent'],
    });

    await handleMemoryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(publishFromSharedMemory.mock.calls[0][2]).toMatchObject({
      contextGraphId: '7',
    });
    expect(responseBody(ctx)).toMatchObject({ publishContextGraphId: '7' });
  });

  it('emits VM refresh events after verified-memory verification', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const verify = vi.fn().mockResolvedValue({ verified: true, status: 'verified' });
    const ctx = createContext('/api/verify', {
      contextGraphId: 'project-a',
      verifiedMemoryId: 'vm-1',
      batchId: '42',
    }, {
      agent: { verify } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleQueryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(200);
    expect(responseBody(ctx)).toMatchObject({ verified: true, batchId: '42' });
    expect(verify).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      verifiedMemoryId: 'vm-1',
      batchId: 42n,
      timeoutMs: undefined,
      requiredSignatures: undefined,
    });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['vm'],
      operation: 'verified_memory_updated',
      source: 'api',
    });
  });

  it('returns 409 and emits WM refresh events for partial verification metadata', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const verify = vi.fn().mockResolvedValue({
      verifiedMemoryId: 'vm-1',
      signers: ['0x0000000000000000000000000000000000000001'],
      status: 'partial',
      trustLevel: 2,
    });
    const ctx = createContext('/api/verify', {
      contextGraphId: 'project-a',
      verifiedMemoryId: 'vm-1',
      batchId: '42',
    }, {
      agent: { verify } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleQueryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(409);
    expect(responseBody(ctx)).toMatchObject({
      batchId: '42',
      status: 'partial',
      verifiedMemoryId: 'vm-1',
      error: expect.stringContaining('partial trust metadata'),
    });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['wm'],
      operation: 'trust_metadata_updated',
      source: 'api',
    });
  });

  it('returns 409 for no-quorum verification without claiming a VM write', async () => {
    const emitMemoryGraphChanged = vi.fn();
    const verify = vi.fn().mockResolvedValue({
      verifiedMemoryId: 'vm-1',
      signers: [],
      status: 'no_quorum',
      trustLevel: 0,
    });
    const ctx = createContext('/api/verify', {
      contextGraphId: 'project-a',
      verifiedMemoryId: 'vm-1',
      batchId: '42',
    }, {
      agent: { verify } as unknown as RequestContext['agent'],
      emitMemoryGraphChanged,
    });

    await handleQueryRoutes(ctx);

    expect((ctx.res as unknown as { statusCode: number }).statusCode).toBe(409);
    expect(responseBody(ctx)).toMatchObject({
      batchId: '42',
      status: 'no_quorum',
      verifiedMemoryId: 'vm-1',
      error: expect.stringContaining('no verified memory was written'),
    });
    expect(emitMemoryGraphChanged).toHaveBeenCalledWith({
      contextGraphId: 'project-a',
      layers: ['wm'],
      operation: 'trust_metadata_updated',
      source: 'api',
    });
  });
});
