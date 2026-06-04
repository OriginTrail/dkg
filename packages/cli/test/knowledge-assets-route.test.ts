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

function ctxFor(method: string, path: string, body: unknown, agent: Record<string, unknown>): RequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    req: createRequest(method, path, method === 'GET' ? undefined : body),
    res: createResponse() as unknown as ServerResponse,
    agent: agent as RequestContext['agent'],
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
  } as RequestContext;
}

function body(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}
function status(ctx: RequestContext): number {
  return (ctx.res as unknown as { statusCode: number }).statusCode;
}

function makeAssertionAgent(over: Record<string, any> = {}) {
  const { assertion: assertionOver, ...restOver } = over;
  const assertion = {
    create: vi.fn(async (_cg: string, name: string) => `urn:dkg:assertion:cg:agent:${name}`),
    write: vi.fn(async () => undefined),
    finalize: vi.fn(async () => ({ merkleRoot: new Uint8Array([0xab, 0xcd]), eip712Digest: '0xdig' })),
    promote: vi.fn(async () => ({ promotedCount: 3 })),
    discard: vi.fn(async () => undefined),
    history: vi.fn(async () => ({ state: 'created', memoryLayer: 'WorkingMemory' })),
    pullFrom: vi.fn(async () => ({ seeded: 5, fromLayer: 'vm', entities: 2 })),
    ...(assertionOver ?? {}),
  };
  return {
    assertion,
    publishFromFinalizedAssertion: vi.fn(async () => ({
      kaId: 7n,
      status: 'confirmed',
      ual: 'did:dkg:hardhat:31337/0xabc/7',
      onChainResult: { txHash: '0xtx' },
    })),
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
    expect(agent.assertion.create).toHaveBeenCalledOnce();
    expect(agent.assertion.write).not.toHaveBeenCalled();
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

  it('POST .../:name/wm/finalize seals the draft', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/wm/finalize', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ merkleRoot: '0xabcd', eip712Digest: '0xdig' });
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
    const ctx = ctxFor('POST', '/api/knowledge-assets/f/vm/publish', { contextGraphId: 'cg' }, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ status: 'confirmed', ual: 'did:dkg:hardhat:31337/0xabc/7', txHash: '0xtx' });
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledOnce();
  });

  it('GET /api/knowledge-assets/:name returns lifecycle state', async () => {
    const agent = makeAssertionAgent();
    const ctx = ctxFor('GET', '/api/knowledge-assets/f?contextGraphId=cg', undefined, agent);
    await handleKnowledgeAssetsRoutes(ctx);
    expect(status(ctx)).toBe(200);
    expect(body(ctx)).toMatchObject({ state: 'created', memoryLayer: 'WorkingMemory' });
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

  // Parity with the legacy /api/assertion/* routes: a caller's own mistakes
  // are 400s (and the "_meta completed but empty" case a 409), not blanket 500s.
  describe('error-status parity with legacy assertion routes', () => {
    it('POST /api/knowledge-assets rejects an invalid name with 400 (before touching the engine)', async () => {
      const agent = makeAssertionAgent();
      const ctx = ctxFor('POST', '/api/knowledge-assets', { contextGraphId: 'cg', name: 'Bad Name!' }, agent);
      await handleKnowledgeAssetsRoutes(ctx);
      expect(status(ctx)).toBe(400);
      expect(String(body(ctx).error)).toMatch(/Invalid "name"/);
      expect(agent.assertion.create).not.toHaveBeenCalled();
    });

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
  });
});
