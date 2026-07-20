import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createPublisherControlFromStore } from '../src/publisher-runner.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

// #1828 — GET /api/publisher/job-by-intent route: read-only durable-admission
// recovery keyed on the lifecycle facts the client retains.
describe('#1828 GET /api/publisher/job-by-intent', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  });

  function kaVmPublishRequest(overrides: Record<string, unknown> = {}) {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
      // Admission always persists a non-empty agent lane; the default here mirrors
      // the ctx.requestAgentAddress the route falls back to, so the lifecycle key
      // matches on both write and lookup (as it does in production).
      agentAddress: '0x0',
      shareOperationId: 'share-op-1',
      roots: [] as string[],
      contentScopeVersion: 2 as const,
      kaUal,
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1,
        reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`,
      wmCurrentAssertion: '12'.repeat(32),
      swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(),
      reservedUal: kaUal,
      ...overrides,
    };
  }

  async function newControlWithJob(
    overrides: Record<string, unknown> = {},
  ): Promise<{ control: ReturnType<typeof createPublisherControlFromStore>; jobId: string }> {
    const store = new OxigraphStore();
    stores.push(store);
    const control = createPublisherControlFromStore(store);
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest(overrides));
    return { control, jobId };
  }

  it('recovers the active job by lifecycle facts (200 result=active)', async () => {
    const { control, jobId } = await newControlWithJob();
    const ctx = createContext('/api/publisher/job-by-intent?contextGraphId=music-social&name=albums', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    const body = responseBody(ctx) as { result: string; job?: { jobId: string }; superseded?: unknown[] };
    expect(body.result).toBe('active');
    expect(body.job?.jobId).toBe(jobId);
    expect(body.superseded).toEqual([]);
  });

  it('returns result=none for unknown facts', async () => {
    const { control } = await newControlWithJob();
    const ctx = createContext('/api/publisher/job-by-intent?contextGraphId=music-social&name=missing', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    expect((responseBody(ctx) as { result: string }).result).toBe('none');
  });

  it('400s when required facts are missing', async () => {
    const { control } = await newControlWithJob();
    const ctx = createContext('/api/publisher/job-by-intent?contextGraphId=music-social', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);
  });

  it('400s on a malformed intentKey', async () => {
    const { control } = await newControlWithJob();
    const ctx = createContext('/api/publisher/job-by-intent?contextGraphId=music-social&name=albums&intentKey=not-a-hash', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);
  });

  // #1828 (otReviewAgent): the lifecycle key joins facts with U+001F, so a fact
  // carrying that delimiter could forge a colliding key on this public route.
  it('400s when a fact carries a control character (U+001F key-delimiter)', async () => {
    const { control } = await newControlWithJob();
    const ctx = createContext(
      '/api/publisher/job-by-intent?contextGraphId=music-social&name=al%1Fbums',
      control,
    );
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);
  });

  // #1828 (otReviewAgent): admission indexes under a non-empty agent lane, and a
  // recovering client rarely retains agentAddress. The route must default the
  // omitted lane to the caller's authenticated agent (the same resolver admission
  // used), not the empty lane, or the job is invisible.
  it('defaults an omitted agentAddress to the caller lane so an agent-scoped job is still found', async () => {
    const agentLane = `0x${'ab'.repeat(20)}`;
    const { control, jobId } = await newControlWithJob({ agentAddress: agentLane });

    // Same lane, agentAddress omitted -> recovered via the caller-lane default.
    const ctx = createContext('/api/publisher/job-by-intent?contextGraphId=music-social&name=albums', control, agentLane);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    const body = responseBody(ctx) as { result: string; job?: { jobId: string } };
    expect(body.result).toBe('active');
    expect(body.job?.jobId).toBe(jobId);

    // A different caller lane (still omitting agentAddress) must NOT see it —
    // proves the defaulted lane is actually applied to the lookup key.
    const otherCtx = createContext('/api/publisher/job-by-intent?contextGraphId=music-social&name=albums', control, `0x${'cd'.repeat(20)}`);
    await handlePublisherRoutes(otherCtx);
    expect((responseBody(otherCtx) as { result: string }).result).toBe('none');
  });

  // #1828 (zsculac): admission normalizes contextGraphId (trim + strip the
  // did:dkg:context-graph: prefix) before persisting, so recovery must apply the
  // same normalization or the URI form the client submitted returns a false none.
  it('normalizes a did:dkg:context-graph URI contextGraphId to the persisted bare id', async () => {
    const { control, jobId } = await newControlWithJob();
    const ctx = createContext(
      '/api/publisher/job-by-intent?contextGraphId=did%3Adkg%3Acontext-graph%3Amusic-social&name=albums',
      control,
    );
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    const body = responseBody(ctx) as { result: string; job?: { jobId: string } };
    expect(body.result).toBe('active');
    expect(body.job?.jobId).toBe(jobId);
  });

  // #1828 (otReviewAgent): subGraphName is part of the recovery identity, so the
  // route must forward it and recover only the matching lane.
  it('respects subGraphName as part of the recovery identity', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const control = createPublisherControlFromStore(store);
    const research = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ subGraphName: 'research' }));
    await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ subGraphName: 'production' }));

    const ctx = createContext(
      '/api/publisher/job-by-intent?contextGraphId=music-social&name=albums&subGraphName=research',
      control,
    );
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    const body = responseBody(ctx) as { result: string; job?: { jobId: string } };
    expect(body.result).toBe('active');
    expect(body.job?.jobId).toBe(research);
  });

  // #1828 (otReviewAgent + branarakic): admission rejects an empty subGraphName
  // (validateOptionalSubGraphName), and the lifecycle key collapses '' and undefined
  // to the same root lane (`subGraphName ?? ''`). An explicit `subGraphName=` must be
  // a 400 — not silently alias and recover the root job.
  it('400s on an explicit empty subGraphName (does not alias the root job)', async () => {
    const { control, jobId } = await newControlWithJob(); // root-lane job (no subGraphName)
    const ctx = createContext(
      '/api/publisher/job-by-intent?contextGraphId=music-social&name=albums&subGraphName=',
      control,
    );
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);

    // Sanity: the same facts WITHOUT the empty param recover the root job, proving
    // the 400 is specifically the empty-string guard, not a facts mismatch.
    const ok = createContext('/api/publisher/job-by-intent?contextGraphId=music-social&name=albums', control);
    await handlePublisherRoutes(ok);
    expect(responseStatus(ok)).toBe(200);
    expect((responseBody(ok) as { result: string; job?: { jobId: string } }).job?.jobId).toBe(jobId);
  });
});

function createContext(
  path: string,
  publisherControl: RequestContext['publisherControl'],
  requestAgentAddress = '0x0',
): RequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', url: path, headers: { host: '127.0.0.1' } });
  return {
    req: req as RequestContext['req'],
    res: createResponse() as unknown as ServerResponse,
    agent: {} as RequestContext['agent'],
    publisherControl,
    publisherState: {
      runtime: null,
      availability: { available: false, reason: 'publisher_disabled', retryable: false, operatorActionRequired: true },
    },
    config: {} as RequestContext['config'],
    startedAt: 0,
    dashDb: {} as RequestContext['dashDb'],
    opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RequestContext['opWallets'],
    network: null as RequestContext['network'],
    tracker: {} as RequestContext['tracker'],
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
    requestAgentAddress,
  };
}

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

function responseStatus(ctx: RequestContext): number {
  return (ctx.res as unknown as { statusCode: number }).statusCode;
}

function responseBody(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}
