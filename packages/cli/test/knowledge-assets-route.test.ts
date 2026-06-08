import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { daemonState } from '../src/daemon/state.js';

// The default `requestAgentAddress` baked into `ctxFor` below. Several
// import-artifact / import-file assertions reconstruct canonical assertion
// URIs against it, so it's pinned as a named constant.
const REQUEST_AGENT_ADDRESS = '0x0000000000000000000000000000000000000001';

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

// Build a request. For JSON routes pass an object `body`; for multipart routes
// pass a raw `Buffer` plus a `contentType` header so `import-file` reads it via
// `readBodyBuffer` + `parseMultipart` instead of the JSON preflight.
function createRequest(
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
): RequestContext['req'] {
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(body === undefined ? '' : JSON.stringify(body));
  const request = Readable.from([payload]);
  Object.assign(request, {
    method,
    url: path,
    headers: {
      host: '127.0.0.1',
      ...(contentType ? { 'content-type': contentType } : {}),
    },
  });
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

interface CtxOverrides {
  contentType?: string;
  extractionStatus?: RequestContext['extractionStatus'];
  fileStore?: Record<string, unknown>;
  extractionRegistry?: Record<string, unknown>;
}

function ctxFor(
  method: string,
  path: string,
  body: unknown,
  agent: Record<string, unknown>,
  over: CtxOverrides = {},
): RequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    req: createRequest(method, path, method === 'GET' ? undefined : body, over.contentType),
    res: createResponse() as unknown as ServerResponse,
    agent: agent as RequestContext['agent'],
    publisherControl: {} as RequestContext['publisherControl'],
    publisherRuntime: null,
    config: {} as RequestContext['config'],
    startedAt: 0,
    // The activity/notification side-effects flow through `dashDb.insertNotification`
    // (wrapped in a try/catch in the route), so a spy keeps it observable without
    // ever throwing.
    dashDb: { insertNotification: vi.fn(() => 1) } as unknown as RequestContext['dashDb'],
    opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RequestContext['opWallets'],
    network: null as RequestContext['network'],
    tracker: createTracker(),
    memoryManager: {} as RequestContext['memoryManager'],
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: {} as RequestContext['catchupTracker'],
    extractionRegistry: (over.extractionRegistry ?? {}) as RequestContext['extractionRegistry'],
    fileStore: (over.fileStore ?? {}) as RequestContext['fileStore'],
    extractionStatus: over.extractionStatus ?? new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {} as RequestContext['vectorStore'],
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    requestToken: undefined,
    requestAgentAddress: REQUEST_AGENT_ADDRESS,
    emitMemoryGraphChanged: vi.fn(),
    emitNotification: vi.fn(),
  } as unknown as RequestContext;
}

function body(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}
function status(ctx: RequestContext): number {
  return (ctx.res as unknown as { statusCode: number }).statusCode;
}

// A context-graph row that resolves as locally writable for `cg` (and any other
// id the tests pass): `subscribed && synced` short-circuits the writability
// check in `contextGraphRowIsWritable`. `listContextGraphs` receives no id
// argument, so we surface a writable row for every id the suite uses; the
// `resolveRequiredWriteContextGraphId` `exact` match then keys off the request.
const WRITABLE_CG_IDS = ['cg', 'cg-2', 'other'];

function contextGraphMocks() {
  return {
    listContextGraphs: vi.fn(async () =>
      WRITABLE_CG_IDS.map((id) => ({
        id,
        uri: `did:dkg:context-graph:${id}`,
        name: id,
        subscribed: true,
        synced: true,
      })),
    ),
    contextGraphExists: vi.fn(async (id: string) => WRITABLE_CG_IDS.includes(id)),
    resolveAgentByToken: vi.fn(() => undefined),
  };
}

function makeAssertionAgent(over: Record<string, any> = {}) {
  const { assertion: assertionOver, publisher: publisherOver, store: storeOver, ...restOver } = over;
  const assertion = {
    create: vi.fn(async (_cg: string, name: string) => `urn:dkg:assertion:cg:agent:${name}`),
    write: vi.fn(async () => undefined),
    finalize: vi.fn(async () => ({ merkleRoot: new Uint8Array([0xab, 0xcd]), eip712Digest: '0xdig' })),
    promote: vi.fn(async () => ({ promotedCount: 3 })),
    discard: vi.fn(async () => undefined),
    history: vi.fn(async () => ({ state: 'created', memoryLayer: 'WorkingMemory' })),
    pullFrom: vi.fn(async () => ({ seeded: 5, fromLayer: 'vm', entities: 2 })),
    // WM-quad dump + async-share queue methods used by the new routes.
    query: vi.fn(async () => []),
    promoteAsync: vi.fn(async () => ({ jobId: 'job-1' })),
    listPromoteAsyncJobs: vi.fn(async () => []),
    getPromoteAsyncStatus: vi.fn(async () => null),
    cancelPromoteAsync: vi.fn(async () => undefined),
    recoverPromoteAsync: vi.fn(async () => undefined),
    ...(assertionOver ?? {}),
  };
  const publisher = {
    assertionCreate: vi.fn(async () => undefined),
    assertionWrite: vi.fn(async () => undefined),
    // rc.17 per-KA WM: the import-file handler re-pins data to the resolved
    // working-memory graph via this public publisher method. Mirror the real
    // publisher's …/_working_memory/{addr}/{number} shape so the handler can
    // remap the data-graph quads before store.insert.
    wmGraphUri: vi.fn(
      async (cg: string, agentAddress: string, _name: string, sub?: string) =>
        `did:dkg:context-graph:${cg}${sub ? `/${sub}` : ''}/_working_memory/${agentAddress}/1`,
    ),
    ...(publisherOver ?? {}),
  };
  const store = {
    query: vi.fn(async () => ({ type: 'bindings', bindings: [] })),
    insert: vi.fn(async () => undefined),
    hasGraph: vi.fn(async () => false),
    dropGraph: vi.fn(async () => undefined),
    createGraph: vi.fn(async () => undefined),
    deleteByPattern: vi.fn(async () => undefined),
    ...(storeOver ?? {}),
  };
  return {
    ...contextGraphMocks(),
    peerId: 'did-peer-test',
    assertion,
    publisher,
    store,
    publishFromFinalizedAssertion: vi.fn(async () => ({
      kaId: 7n,
      status: 'confirmed',
      ual: 'did:dkg:hardhat:31337/0xabc/7',
      onChainResult: { txHash: '0xtx' },
    })),
    ...restOver,
  };
}

// Minimal `PromoteJob`-shaped record `promoteJobToView` can render into the
// public view. Only the fields the view reads are populated.
function makePromoteJob(over: Record<string, any> = {}): any {
  return {
    jobId: 'job-1',
    state: 'queued',
    request: { contextGraphId: 'cg', assertionName: 'notes', entities: 'all' },
    enqueuedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    attempt: { count: 0, maxRetries: 3 },
    ...over,
  };
}

describe('GitHub-shaped /api/knowledge-assets routes (OT-RFC-43 §10.5)', () => {
  it('POST /api/knowledge-assets creates a KA + opens a WM draft', async () => {
    // A fresh KA: no prior lifecycle descriptor, so alreadyExists is false.
    const agent = makeAssertionAgent({ assertion: { history: vi.fn(async () => null) } });
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'meeting-notes' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(body(ctx)).toMatchObject({ name: 'meeting-notes', status: 'draft-open', alreadyExists: false });
    expect(agent.assertion.create).toHaveBeenCalledOnce();
    expect(agent.assertion.write).not.toHaveBeenCalled();
  });

  it('POST /api/knowledge-assets reports alreadyExists when a prior descriptor is found', async () => {
    // The engine create is get-or-create; the route detects prior existence via
    // a cheap descriptor read and surfaces it for idempotent callers.
    const agent = makeAssertionAgent({
      assertion: { history: vi.fn(async () => ({ state: 'created' })) },
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'dup' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(body(ctx)).toMatchObject({ name: 'dup', alreadyExists: true });
  });

  it('POST /api/knowledge-assets rejects finalize-only fields without auto-finalize quads', async () => {
    for (const payload of [
      { authorAgentAddress: `0x${'11'.repeat(20)}` },
      { quads: [], schemeVersion: 1 },
    ]) {
      const agent = makeAssertionAgent();
      const ctx = ctxFor('POST', '/api/knowledge-assets', {
        contextGraphId: 'cg',
        name: 'f',
        ...payload,
      }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(400);
      expect(body(ctx).error).toContain('require non-empty "quads"');
      expect(agent.assertion.create).not.toHaveBeenCalled();
      expect(agent.assertion.finalize).not.toHaveBeenCalled();
    }
  });

  it('POST /api/knowledge-assets with quads auto-writes + auto-finalizes (sealed assertion v1)', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'f', quads }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    expect(body(ctx)).toMatchObject({ status: 'wm-sealed', written: 1, merkleRoot: '0xabcd' });
    expect(agent.assertion.write).toHaveBeenCalledOnce();
    expect(agent.assertion.finalize).toHaveBeenCalledOnce();
  });

  it('POST /api/knowledge-assets validates and forwards atomic finalize external-signer fields', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const address = `0x${'11'.repeat(20)}`;
    const preSignedAuthorAttestation = {
      address,
      signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
    };
    const ctx = ctxFor('POST', '/api/knowledge-assets', {
      contextGraphId: 'cg',
      name: 'f',
      quads,
      preSignedAuthorAttestation,
      schemeVersion: 1,
    }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(201);
    const finalizeOpts = (agent.assertion.finalize as any).mock.calls[0][2];
    expect(finalizeOpts.schemeVersion).toBe(1);
    expect(finalizeOpts.authorAgentAddress).toBeUndefined();
    expect(finalizeOpts.preSignedAuthorAttestation.address).toBe(address);
    expect(finalizeOpts.preSignedAuthorAttestation.signature.r).toBeInstanceOf(Uint8Array);
    expect(finalizeOpts.preSignedAuthorAttestation.signature.vs).toBeInstanceOf(Uint8Array);
  });

  it('POST /api/knowledge-assets rejects mutually exclusive atomic finalize authorship fields', async () => {
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets', {
      contextGraphId: 'cg',
      name: 'f',
      quads,
      authorAgentAddress: `0x${'11'.repeat(20)}`,
      preSignedAuthorAttestation: {
        address: `0x${'22'.repeat(20)}`,
        signature: { r: `0x${'22'.repeat(32)}`, vs: `0x${'33'.repeat(32)}` },
      },
    }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('mutually exclusive');
    expect(agent.assertion.create).not.toHaveBeenCalled();
    expect(agent.assertion.finalize).not.toHaveBeenCalled();
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
    expect(agent.assertion.write).toHaveBeenCalledWith('cg', 'f', quads, { subGraphName: undefined });
  });

  it('POST .../:name/wm/write get-or-creates the KA before the first append', async () => {
    // RC.17 lifecycle bug: a bare wm/write to a name that was never created
    // used to skip create() and fall through to the legacy name-keyed graph,
    // yielding a KA that is permanently 404 in the descriptor API (no _meta
    // lifecycle record, no per-KA layout). The route now calls the idempotent
    // create() first, BEFORE the write, so the KA always has the proper layout.
    const agent = makeAssertionAgent();
    const quads = [{ subject: 'ex:A', predicate: 'ex:p', object: '"x"', graph: '' }];
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/write', { contextGraphId: 'cg', quads }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.assertion.create).toHaveBeenCalledWith('cg', 'f', { subGraphName: undefined });
    // Ordering matters: create() must run before write() or the first append
    // still lands in the wrong graph.
    const createOrder = (agent.assertion.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const writeOrder = (agent.assertion.write as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(writeOrder);
  });

  it('POST .../:name/wm/finalize seals the draft (full seal payload)', async () => {
    // PR #971: finalize returns the whole seal payload (assertionUri /
    // authorAddress / chainId / kav10Address) so clients can inspect the attestation.
    const agent = makeAssertionAgent({
      assertion: {
        finalize: vi.fn(async () => ({
          merkleRoot: new Uint8Array([0xab, 0xcd]),
          eip712Digest: '0xdig',
          assertionUri: 'urn:dkg:assertion:cg:agent:f',
          authorAddress: `0x${'11'.repeat(20)}`,
          schemeVersion: 1,
          chainId: 31337n,
          kav10Address: `0x${'aa'.repeat(20)}`,
        })),
      },
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/finalize', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({
      merkleRoot: '0xabcd',
      eip712Digest: '0xdig',
      assertionUri: 'urn:dkg:assertion:cg:agent:f',
      authorAddress: `0x${'11'.repeat(20)}`,
      schemeVersion: 1,
      chainId: '31337',
      kav10Address: `0x${'aa'.repeat(20)}`,
    });
  });

  it('POST .../:name/wm/finalize rejects malformed pre-signed attestations before finalize', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/finalize', {
      contextGraphId: 'cg',
      preSignedAuthorAttestation: {
        address: `0x${'11'.repeat(20)}`,
        signature: { r: '0xnot-32-bytes', vs: `0x${'33'.repeat(32)}` },
      },
    }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('preSignedAuthorAttestation.signature.r');
    expect(agent.assertion.finalize).not.toHaveBeenCalled();
  });

  it('POST .../:name/swm/share advances the SWM pointer (promote→share) + emits activity', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/swm/share', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ swmShared: true, promotedCount: 3 });
    expect(agent.assertion.promote).toHaveBeenCalledOnce();
    // promotedCount !== 0 → memory-graph-changed + assertion-activity side-effects fire.
    expect(ctx.emitMemoryGraphChanged).toHaveBeenCalled();
    expect((ctx.dashDb as any).insertNotification).toHaveBeenCalled();
    expect(ctx.emitNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'assertion_activity' }),
    );
  });

  it('POST .../:name/vm/publish mints/updates on chain', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ status: 'confirmed', ual: 'did:dkg:hardhat:31337/0xabc/7', txHash: '0xtx' });
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
  });

  it('POST .../:name/vm/publish hex-encodes a Uint8Array merkleRoot (parity with wm/finalize)', async () => {
    // RC.17 bug: vm/publish echoed the raw publisher merkleRoot, which is a
    // Uint8Array byte-map, so the JSON came back as {"0":171,"1":205,...}
    // instead of the "0xabcd" hex string wm/finalize returns. The route now
    // hex-encodes it when it isn't already a string, so the two surfaces agree.
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({
        kaId: 7n,
        status: 'confirmed',
        ual: 'did:dkg:hardhat:31337/0xabc/7',
        onChainResult: { txHash: '0xtx' },
        merkleRoot: new Uint8Array([0xab, 0xcd]),
      })),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx).merkleRoot).toBe('0xabcd');
  });

  it('POST .../:name/vm/publish leaves an already-hex merkleRoot untouched', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({
        kaId: 7n,
        status: 'confirmed',
        ual: 'did:dkg:hardhat:31337/0xabc/7',
        onChainResult: { txHash: '0xtx' },
        merkleRoot: '0xdeadbeef',
      })),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx).merkleRoot).toBe('0xdeadbeef');
  });

  // PR #972: vm/publish HTTP status reflects the actual publish outcome.
  it('POST .../:name/vm/publish returns 207 when the KA minted but the context-graph binding failed', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({
        kaId: 7n,
        status: 'confirmed',
        ual: 'did:dkg:hardhat:31337/0xabc/7',
        onChainResult: { txHash: '0xtx' },
        contextGraphError: 'CG value bind failed',
      })),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(207);
    expect(body(ctx)).toMatchObject({ status: 'confirmed', contextGraphError: 'CG value bind failed' });
  });

  it('POST .../:name/vm/publish returns 502 when the publish is tentative (did not confirm)', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({ kaId: 7n, status: 'tentative', ual: 'did:dkg:hardhat:31337/0xabc/7' })),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(502);
    expect(body(ctx).error).toContain('did not confirm');
  });

  it('POST .../:name/vm/publish returns 502 when the publish failed', async () => {
    const agent = makeAssertionAgent({
      publishFromFinalizedAssertion: vi.fn(async () => ({ status: 'failed' })),
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(502);
  });

  // PR #971: validate + normalize vm/publish options before the publish.
  it('POST .../:name/vm/publish rejects a non-integer epochs option (400, no publish)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg', options: { epochs: 'soon' } }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('POST .../:name/vm/publish rejects epochs above the uint32 ceiling (400)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg', options: { epochs: 4294967296 } }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('POST .../:name/vm/publish rejects assertionName (the URL name selects the assertion) (400)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg', assertionName: 'other' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('POST .../:name/vm/publish rejects an author override (the seal encodes the author) (400)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg', authorAgentAddress: '0xdead' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('POST .../:name/vm/publish normalizes a valid epochs option and publishes', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg', options: { epochs: 5 } }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
    const passedOpts = (agent.publishFromFinalizedAssertion as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(passedOpts).toMatchObject({ publishEpochs: 5 });
  });

  it('GET /api/knowledge-assets/:name returns lifecycle state', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ state: 'created', memoryLayer: 'WorkingMemory' });
  });

  it('GET /api/knowledge-assets/:name forwards an author-scoped agentAddress (#988)', async () => {
    const agent = makeAssertionAgent();
    const authorAddr = `0x${'cd'.repeat(20)}`;
    const ctx = ctxFor('GET', `/api/knowledge-assets/f?contextGraphId=cg&agentAddress=${authorAddr}`, undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    // history is called with the agentAddress merged into its options.
    expect(agent.assertion.history).toHaveBeenCalledWith('cg', 'f', { subGraphName: undefined, agentAddress: authorAddr });
  });

  it('GET /api/knowledge-assets/:name rejects a malformed agentAddress (400)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f?contextGraphId=cg&agentAddress=not-an-address', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('agentAddress');
    expect(agent.assertion.history).not.toHaveBeenCalled();
  });

  it('POST .../:name/wm/pull-from seeds a draft from the given layer', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/pull-from', { contextGraphId: 'cg', layer: 'vm' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ wmDraft: 'open', seededFrom: { layer: 'vm' }, seeded: 5 });
    expect(agent.assertion.pullFrom).toHaveBeenCalledWith('cg', 'f', 'vm', { subGraphName: undefined, onConflict: 'reject' });
  });

  it('POST .../:name/wm/pull-from requires a valid layer', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/pull-from', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
  });

  it('POST .../:name/wm/pull-from maps a dirty-draft conflict to 409', async () => {
    const agent = makeAssertionAgent({
      assertion: {
        pullFrom: vi.fn(async () => { throw Object.assign(new Error('draft exists'), { code: 'WM_DRAFT_CONFLICT' }); }),
      },
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/pull-from', { contextGraphId: 'cg', layer: 'swm' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(409);
    expect(body(ctx)).toMatchObject({ code: 'WM_DRAFT_CONFLICT' });
  });

  it('ignores non-/api/knowledge-assets paths', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/assertion/create', { contextGraphId: 'cg', name: 'f' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(ctx.res.writableEnded).toBe(false); // not handled here
  });
});

// ── GET /api/knowledge-assets/:name/wm/quads — dump the WM draft's quads ──

describe('GET /api/knowledge-assets/:name/wm/quads', () => {
  it('returns the WM draft quads sorted with a count', async () => {
    // Deliberately out of sort order; the route sorts by JSON string.
    const unsorted = [
      { subject: 'ex:Z', predicate: 'ex:p', object: '"z"', graph: '' },
      { subject: 'ex:A', predicate: 'ex:p', object: '"a"', graph: '' },
    ];
    const agent = makeAssertionAgent({ assertion: { query: vi.fn(async () => unsorted) } });
    const ctx = ctxFor('GET', '/api/knowledge-assets/f/wm/quads?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    const b = body(ctx);
    expect(b.count).toBe(2);
    const quads = b.quads as Array<{ subject: string }>;
    // Sorted: ex:A before ex:Z.
    expect(quads[0].subject).toBe('ex:A');
    expect(quads[1].subject).toBe('ex:Z');
    expect(agent.assertion.query).toHaveBeenCalledWith('cg', 'f', undefined);
  });

  it('rejects a bad assertion name (400, no query)', async () => {
    const agent = makeAssertionAgent();
    // A name with an illegal char fails validateAssertionName.
    const ctx = ctxFor('GET', '/api/knowledge-assets/bad%20name/wm/quads?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('Invalid "name"');
    expect(agent.assertion.query).not.toHaveBeenCalled();
  });

  it('maps an engine "not found" error to 400', async () => {
    const agent = makeAssertionAgent({
      assertion: { query: vi.fn(async () => { throw new Error('assertion not found'); }) },
    });
    const ctx = ctxFor('GET', '/api/knowledge-assets/f/wm/quads?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
  });
});

// ── GET /api/knowledge-assets/:name/wm/extraction-status ──

describe('GET /api/knowledge-assets/:name/wm/extraction-status', () => {
  it('returns the recorded extraction status for the assertion', async () => {
    const agent = makeAssertionAgent();
    const assertionUri = contextGraphAssertionUri('cg', REQUEST_AGENT_ADDRESS, 'doc');
    const extractionStatus = new Map([[assertionUri, {
      status: 'completed' as const,
      fileHash: 'keccak256:' + 'ab'.repeat(32),
      detectedContentType: 'text/markdown',
      pipelineUsed: 'text/markdown',
      tripleCount: 4,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }]]);
    const ctx = ctxFor('GET', '/api/knowledge-assets/doc/wm/extraction-status?contextGraphId=cg', undefined, agent, { extractionStatus });
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ assertionUri, status: 'completed', tripleCount: 4 });
  });

  it('returns 404 when no extraction record exists', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/doc/wm/extraction-status?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(404);
  });
});

// ── POST /api/knowledge-assets/import-artifact/resolve ──

describe('POST /api/knowledge-assets/import-artifact/resolve', () => {
  const fileHash = 'keccak256:' + 'ab'.repeat(32);

  // Agent whose `store.query` returns the `_meta` binding `resolveImportedArtifact`
  // expects for a completed import keyed by the canonical assertionUri.
  function importAgent() {
    return makeAssertionAgent({
      store: {
        query: vi.fn(async (sparql: string) => {
          if (sparql.includes('SELECT ?fileHash')) {
            return {
              type: 'bindings',
              bindings: [{
                fileHash,
                contentType: 'text/markdown',
                rootEntity: 'urn:doc:imported',
                structuralTripleCount: '3',
                semanticTripleCount: '0',
                extractionMethod: 'text/markdown',
                extractionStatus: 'completed',
                sourceFileName: 'imported.md',
              }],
            };
          }
          // markdownForm probe on the assertion graph — none.
          return { type: 'bindings', bindings: [] };
        }),
      },
    });
  }

  it('resolves a completed import artifact from graph metadata', async () => {
    const agent = importAgent();
    const assertionUri = contextGraphAssertionUri('cg', REQUEST_AGENT_ADDRESS, 'imported-doc');
    const ctx = ctxFor('POST', '/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId: 'cg',
      assertionUri,
    }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    const b = body(ctx);
    expect((b.artifact as any).assertionName).toBe('imported-doc');
    expect((b.artifact as any).sourceFileHash).toBe(fileHash);
  });

  it('rejects a missing assertionUri (400)', async () => {
    const agent = importAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/import-artifact/resolve', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('assertionUri');
  });
});

// ── POST /api/knowledge-assets/import-artifact/read-markdown ──

describe('POST /api/knowledge-assets/import-artifact/read-markdown', () => {
  const markdownHash = 'keccak256:' + 'cd'.repeat(32);

  function markdownAgent() {
    return makeAssertionAgent({
      store: {
        query: vi.fn(async (sparql: string) => {
          if (sparql.includes('SELECT ?fileHash')) {
            return {
              type: 'bindings',
              bindings: [{
                fileHash: markdownHash,
                contentType: 'text/markdown',
                structuralTripleCount: '3',
                extractionStatus: 'completed',
              }],
            };
          }
          return { type: 'bindings', bindings: [] };
        }),
      },
    });
  }

  it('reads the Markdown blob tied to a completed import', async () => {
    const agent = markdownAgent();
    const fileStore = { get: vi.fn(async () => Buffer.from('# Hello\n', 'utf-8')) };
    const assertionUri = contextGraphAssertionUri('cg', REQUEST_AGENT_ADDRESS, 'imported-doc');
    const ctx = ctxFor('POST', '/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId: 'cg',
      assertionUri,
    }, agent, { fileStore });
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ contentType: 'text/markdown', markdown: '# Hello\n' });
    expect(fileStore.get).toHaveBeenCalledWith(markdownHash);
  });

  it('returns 404 when the Markdown bytes are absent from the file store', async () => {
    const agent = markdownAgent();
    const fileStore = { get: vi.fn(async () => undefined) };
    const assertionUri = contextGraphAssertionUri('cg', REQUEST_AGENT_ADDRESS, 'imported-doc');
    const ctx = ctxFor('POST', '/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId: 'cg',
      assertionUri,
    }, agent, { fileStore });
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(404);
  });
});

// ── POST /api/knowledge-assets/semantic-enrichment/write ──

describe('POST /api/knowledge-assets/semantic-enrichment/write', () => {
  const fileHash = 'keccak256:' + 'ef'.repeat(32);

  function enrichmentAgent() {
    return makeAssertionAgent({
      store: {
        query: vi.fn(async (sparql: string) => {
          if (sparql.includes('SELECT ?fileHash')) {
            return {
              type: 'bindings',
              bindings: [{
                fileHash,
                contentType: 'text/markdown',
                structuralTripleCount: '3',
                extractionStatus: 'completed',
              }],
            };
          }
          return { type: 'bindings', bindings: [] };
        }),
      },
    });
  }

  it('writes model-derived semantic triples with provenance', async () => {
    const agent = enrichmentAgent();
    const assertionUri = contextGraphAssertionUri('cg', REQUEST_AGENT_ADDRESS, 'imported-doc');
    const ctx = ctxFor('POST', '/api/knowledge-assets/semantic-enrichment/write', {
      contextGraphId: 'cg',
      assertionUri,
      semanticQuads: [
        { subject: 'urn:e:1', predicate: 'http://schema.org/about', object: 'urn:topic:climate' },
      ],
    }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    const b = body(ctx);
    expect(b.semanticTripleCount).toBe(1);
    expect(b.assertionName).toBe('imported-doc');
    expect((b.enrichmentUri as string).startsWith('urn:dkg:semantic-enrichment:')).toBe(true);
    // Triples are written via publisher.assertionWrite to the source assertion.
    expect(agent.publisher.assertionWrite).toHaveBeenCalledOnce();
  });

  it('rejects a target assertion name override (400)', async () => {
    const agent = enrichmentAgent();
    const assertionUri = contextGraphAssertionUri('cg', REQUEST_AGENT_ADDRESS, 'imported-doc');
    const ctx = ctxFor('POST', '/api/knowledge-assets/semantic-enrichment/write', {
      contextGraphId: 'cg',
      assertionUri,
      name: 'somewhere-else',
      semanticQuads: [{ subject: 'urn:e:1', predicate: 'p', object: 'o' }],
    }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('target assertion names are not supported');
    expect(agent.publisher.assertionWrite).not.toHaveBeenCalled();
  });
});

// ── POST /api/knowledge-assets/:name/wm/import-file — multipart, not JSON ──

describe('POST /api/knowledge-assets/:name/wm/import-file (multipart)', () => {
  const BOUNDARY = 'testboundary123';

  // Assemble a minimal multipart/form-data body. `parts` may include a file
  // part (with filename) and text parts.
  function multipart(parts: Array<{ name: string; filename?: string; contentType?: string; value: string }>): Buffer {
    const chunks: Buffer[] = [];
    for (const p of parts) {
      let header = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${p.name}"`;
      if (p.filename !== undefined) header += `; filename="${p.filename}"`;
      header += '\r\n';
      if (p.contentType) header += `Content-Type: ${p.contentType}\r\n`;
      header += '\r\n';
      chunks.push(Buffer.from(header, 'utf-8'));
      chunks.push(Buffer.from(p.value, 'utf-8'));
      chunks.push(Buffer.from('\r\n', 'utf-8'));
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf-8'));
    return Buffer.concat(chunks);
  }

  const contentTypeHeader = `multipart/form-data; boundary=${BOUNDARY}`;

  it('routes a markdown upload to the import-file handler (not JSON-parsed) and completes', async () => {
    // markdown path: no converter lookup, extractFromMarkdown runs over the raw
    // bytes, then the daemon writes the assertion via store.insert. We mock the
    // store + publisher boundary so the handler reaches a completed status.
    const agent = makeAssertionAgent({
      store: {
        // CONSTRUCT snapshots → empty; SELECT skipped-meta subjects → empty.
        query: vi.fn(async () => ({ type: 'quads', quads: [] })),
        insert: vi.fn(async () => undefined),
        hasGraph: vi.fn(async () => false),
        dropGraph: vi.fn(async () => undefined),
        deleteByPattern: vi.fn(async () => undefined),
      },
    });
    const fileStore = {
      put: vi.fn(async () => ({ keccak256: 'keccak256:' + '11'.repeat(32), path: '/tmp/x', size: 12 })),
    };
    const extractionStatus = new Map();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/doc/wm/import-file',
      multipart([
        { name: 'file', filename: 'doc.md', contentType: 'text/markdown', value: '# Title\n\nHello world.\n' },
        { name: 'contextGraphId', value: 'cg' },
      ]),
      agent,
      { contentType: contentTypeHeader, fileStore, extractionStatus },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    const b = body(ctx);
    expect((b.extraction as any).status).toBe('completed');
    expect(fileStore.put).toHaveBeenCalled();
    expect(agent.store.insert).toHaveBeenCalled();
  });

  it('returns the import-file-specific 400 when the file part is missing (proves no JSON-parse)', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/doc/wm/import-file',
      multipart([{ name: 'contextGraphId', value: 'cg' }]),
      agent,
      { contentType: contentTypeHeader },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    // This error string is unique to the multipart handler — the JSON preflight
    // would instead 400 with "Invalid JSON in request body".
    expect(body(ctx).error).toContain('Missing required "file" field');
  });

  it('returns 400 when the request is not multipart/form-data', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor(
      'POST',
      '/api/knowledge-assets/doc/wm/import-file',
      Buffer.from('not-multipart'),
      agent,
      { contentType: 'text/plain' },
    );
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(400);
    expect(body(ctx).error).toContain('multipart/form-data');
  });
});

// ── Async SWM-share queue routes ──────────────────────────────────────────

describe('async SWM-share queue routes', () => {
  beforeEach(() => {
    daemonState.promoteWorkerAvailable = true;
    daemonState.promoteWorkerUnavailableReason = null;
  });
  afterEach(() => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  it('POST /:name/swm/share-async enqueues a job → { jobId, state: queued }', async () => {
    const agent = makeAssertionAgent({
      assertion: { promoteAsync: vi.fn(async () => ({ jobId: 'job-xyz' })) },
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/notes/swm/share-async', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ jobId: 'job-xyz', state: 'queued' });
    expect(agent.assertion.promoteAsync).toHaveBeenCalledWith('cg', 'notes', { entities: 'all', subGraphName: undefined });
  });

  it('POST /:name/swm/share-async returns 503 when the worker is unavailable (daemonState)', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'supervisor not started';
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/notes/swm/share-async', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(503);
    expect(body(ctx).error).toContain('async-promote worker is not available');
    expect(agent.assertion.promoteAsync).not.toHaveBeenCalled();
  });

  it('GET /swm/share-jobs lists jobs', async () => {
    const jobs = [makePromoteJob({ jobId: 'a' }), makePromoteJob({ jobId: 'b', state: 'running' })];
    const agent = makeAssertionAgent({
      assertion: { listPromoteAsyncJobs: vi.fn(async () => jobs) },
    });
    const ctx = ctxFor('GET', '/api/knowledge-assets/swm/share-jobs?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    const b = body(ctx);
    expect(Array.isArray(b.jobs)).toBe(true);
    expect((b.jobs as any[]).map((j) => j.jobId)).toEqual(['a', 'b']);
    expect(agent.assertion.listPromoteAsyncJobs).toHaveBeenCalledOnce();
  });

  it('GET /swm/share-jobs/:jobId returns the job status', async () => {
    const agent = makeAssertionAgent({
      assertion: { getPromoteAsyncStatus: vi.fn(async () => makePromoteJob({ jobId: 'job-1', state: 'succeeded' })) },
    });
    const ctx = ctxFor('GET', '/api/knowledge-assets/swm/share-jobs/job-1', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ jobId: 'job-1', state: 'succeeded' });
  });

  it('GET /swm/share-jobs/:jobId returns 404 for an unknown job', async () => {
    const agent = makeAssertionAgent({
      assertion: { getPromoteAsyncStatus: vi.fn(async () => null) },
    });
    const ctx = ctxFor('GET', '/api/knowledge-assets/swm/share-jobs/missing', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(404);
    expect(body(ctx).error).toContain('not found');
  });

  it('DELETE /swm/share-jobs/:jobId cancels a job', async () => {
    const agent = makeAssertionAgent({
      assertion: {
        cancelPromoteAsync: vi.fn(async () => undefined),
        getPromoteAsyncStatus: vi.fn(async () => makePromoteJob({ jobId: 'job-1', state: 'cancelled' })),
      },
    });
    const ctx = ctxFor('DELETE', '/api/knowledge-assets/swm/share-jobs/job-1', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ jobId: 'job-1', state: 'cancelled' });
    expect(agent.assertion.cancelPromoteAsync).toHaveBeenCalledWith('job-1');
  });

  it('DELETE /swm/share-jobs/:jobId maps a not-found cancel to 404', async () => {
    const agent = makeAssertionAgent({
      assertion: { cancelPromoteAsync: vi.fn(async () => { throw new Error('Promote job not found: job-1'); }) },
    });
    const ctx = ctxFor('DELETE', '/api/knowledge-assets/swm/share-jobs/job-1', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(404);
  });

  it('POST /swm/share-jobs/:jobId/recover requeues a terminal-failed job', async () => {
    const agent = makeAssertionAgent({
      assertion: {
        recoverPromoteAsync: vi.fn(async () => undefined),
        getPromoteAsyncStatus: vi.fn(async () => makePromoteJob({ jobId: 'job-1', state: 'queued' })),
      },
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/swm/share-jobs/job-1/recover', {}, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ jobId: 'job-1', state: 'queued' });
    expect(agent.assertion.recoverPromoteAsync).toHaveBeenCalledWith('job-1');
  });

  it('POST /swm/share-jobs/:jobId/recover maps a not-recoverable job to 409', async () => {
    const agent = makeAssertionAgent({
      assertion: { recoverPromoteAsync: vi.fn(async () => { throw new Error('Cannot recover job in state running'); }) },
    });
    const ctx = ctxFor('POST', '/api/knowledge-assets/swm/share-jobs/job-1/recover', {}, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(409);
  });
});

// ── OT-RFC-43 A2/B3 — per-layer status + (agent, number) / did:dkg addressing ──

describe('OT-RFC-43 A2/B3 — per-layer status + kaId addressing', () => {
  const AGENT_ADDR = `0x${'ab'.repeat(20)}`; // 0xabab...ab
  // A descriptor with diverged pointers: WM ahead of SWM/VM.
  const divergedDescriptor = {
    contextGraphId: 'cg',
    agentAddress: AGENT_ADDR,
    name: 'notes',
    state: 'published',
    memoryLayer: 'VM',
    assertionGraph: `did:dkg:context-graph:cg/assertion/${AGENT_ADDR}/notes`,
    events: [],
    wmCurrentAssertion: 'bbbb', // newer (WM ahead)
    swmCurrentAssertion: 'aaaa',
    vmCurrentAssertion: 'aaaa',
    status: 'vm-confirmed',
    kaNumber: '5',
    reservedUal: `did:dkg:evm:31337/${AGENT_ADDR}/5`,
  };

  function makePointerAgent() {
    const history = vi.fn(async () => divergedDescriptor);
    const resolveByKaId = vi.fn(async () => divergedDescriptor);
    return {
      ...contextGraphMocks(),
      assertion: {
        create: vi.fn(),
        write: vi.fn(),
        finalize: vi.fn(),
        promote: vi.fn(),
        discard: vi.fn(),
        history,
        resolveByKaId,
        pullFrom: vi.fn(),
      },
      publishFromFinalizedAssertion: vi.fn(),
    };
  }

  it('GET /:name returns the overall descriptor + 3 pointers + status', async () => {
    const agent = makePointerAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/notes?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({
      name: 'notes',
      status: 'vm-confirmed',
      wmCurrentAssertion: 'bbbb',
      swmCurrentAssertion: 'aaaa',
      vmCurrentAssertion: 'aaaa',
    });
    expect(agent.assertion.history).toHaveBeenCalledOnce();
    expect(agent.assertion.resolveByKaId).not.toHaveBeenCalled();
  });

  it('GET /:name/wm returns the WM layer pointer + wm-sealed status (divergence observable)', async () => {
    const agent = makePointerAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/notes/wm?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    const b = body(ctx);
    expect(b.layer).toBe('wm');
    expect(b.currentAssertion).toBe('bbbb'); // WM's own pointer (newer)
    expect(b.status).toBe('wm-sealed');
  });

  it('GET /:name/vm returns the VM layer pointer + vm-confirmed status', async () => {
    const agent = makePointerAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/notes/vm?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    const b = body(ctx);
    expect(b.layer).toBe('vm');
    expect(b.currentAssertion).toBe('aaaa'); // VM still on the old merkle
    expect(b.status).toBe('vm-confirmed');
  });

  it('B3: resolves a KA by (agent, number) — same descriptor as by name', async () => {
    const agent = makePointerAgent();
    const ident = `${AGENT_ADDR}:5`;
    const ctx = ctxFor('GET', `/api/knowledge-assets/${encodeURIComponent(ident)}?contextGraphId=cg`, undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ name: 'notes', status: 'vm-confirmed' });
    // Routed through resolveByKaId with the packed kaId = (agent<<96)|5.
    expect(agent.assertion.resolveByKaId).toHaveBeenCalledOnce();
    const packed = (BigInt(AGENT_ADDR) << 96n) | 5n;
    expect(agent.assertion.resolveByKaId.mock.calls[0][1]).toBe(packed);
    expect(agent.assertion.history).not.toHaveBeenCalled();
  });

  it('B3: resolves a KA by did:dkg UAL — same descriptor', async () => {
    const agent = makePointerAgent();
    const packed = (BigInt(AGENT_ADDR) << 96n) | 5n;
    const ual = `did:dkg:evm:31337/0xkaaddr/${packed.toString()}`;
    const ctx = ctxFor('GET', `/api/knowledge-assets/${encodeURIComponent(ual)}?contextGraphId=cg`, undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ name: 'notes', status: 'vm-confirmed' });
    expect(agent.assertion.resolveByKaId).toHaveBeenCalledOnce();
    expect(agent.assertion.resolveByKaId.mock.calls[0][1]).toBe(packed);
  });

  it('B3: a plain name still routes through history (current behavior)', async () => {
    const agent = makePointerAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/plain-name?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(agent.assertion.history).toHaveBeenCalledOnce();
    expect(agent.assertion.resolveByKaId).not.toHaveBeenCalled();
  });

  // Parity with the legacy /api/assertion/* routes: on the WM/SWM mutation
  // verbs a caller's own mistakes are 400s (and the "_meta completed but empty"
  // case a 409), not blanket 500s — but vm/publish failures stay 500.
  describe('error-status parity with legacy assertion routes', () => {
    it('maps engine "not found" / "Invalid" / "Unsafe" failures to 400 on wm/write', async () => {
      const agent = makeAssertionAgent({
        assertion: { write: vi.fn(async () => { throw new Error('assertion not found'); }) },
      });
      const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/write', { contextGraphId: 'cg', quads: [{ subject: 's', predicate: 'p', object: '"o"' }] }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(400);
    });

    it('maps a reserved-namespace error to 400 on wm/write', async () => {
      const err = Object.assign(new Error('reserved namespace'), { name: 'ReservedNamespaceError' });
      const agent = makeAssertionAgent({ assertion: { write: vi.fn(async () => { throw err; }) } });
      const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/write', { contextGraphId: 'cg', quads: [{ subject: 's', predicate: 'p', object: '"o"' }] }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(400);
    });

    it('maps AssertionNotPersistedError to 409 on swm/share', async () => {
      const err = Object.assign(new Error('data graph empty'), {
        name: 'AssertionNotPersistedError',
        code: 'ASSERTION_NOT_PERSISTED',
        contextGraphId: 'cg',
        assertionGraph: 'urn:g',
        expectedTripleCount: 4,
      });
      const agent = makeAssertionAgent({ assertion: { promote: vi.fn(async () => { throw err; }) } });
      const ctx = ctxFor('POST', '/api/knowledge-assets/f/swm/share', { contextGraphId: 'cg' }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(409);
      expect(body(ctx)).toMatchObject({ code: 'ASSERTION_NOT_PERSISTED', expectedTripleCount: 4 });
    });

    it('still returns 500 for genuinely unexpected engine failures', async () => {
      const agent = makeAssertionAgent({
        assertion: { discard: vi.fn(async () => { throw new Error('disk on fire'); }) },
      });
      const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/discard', { contextGraphId: 'cg' }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(500);
    });

    it('does NOT down-classify vm/publish failures: an "Invalid ..." publisher error stays 500', async () => {
      const agent = makeAssertionAgent({
        publishFromFinalizedAssertion: vi.fn(async () => { throw new Error('Invalid on-chain state root'); }),
      });
      const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(500);
    });

    // RC.17 bug: a vm/publish on a KA that hasn't been finalized — or hasn't
    // been shared to SWM — is a caller precondition error, but the route used
    // to return a blanket 500. Both messages are thrown by the engine BEFORE
    // any chain interaction, so they down-classify to 409 without violating
    // the #988 "don't down-classify on-chain errors" contract above.
    it('maps a not-finalized vm/publish to 409 (caller precondition)', async () => {
      const agent = makeAssertionAgent({
        publishFromFinalizedAssertion: vi.fn(async () => { throw new Error('Assertion <urn:x> is not finalized'); }),
      });
      const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(409);
      expect(body(ctx)).toMatchObject({ code: 'VM_PUBLISH_PRECONDITION' });
    });

    it('maps a publish-without-share vm/publish to 409 (caller precondition)', async () => {
      const agent = makeAssertionAgent({
        publishFromFinalizedAssertion: vi.fn(async () => { throw new Error('No quads in shared memory for context graph cg matching selection'); }),
      });
      const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(409);
      expect(body(ctx)).toMatchObject({ code: 'VM_PUBLISH_PRECONDITION' });
    });
  });
});
