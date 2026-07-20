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

  function kaVmPublishRequest() {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
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
    };
  }

  async function newControlWithJob(): Promise<{ control: ReturnType<typeof createPublisherControlFromStore>; jobId: string }> {
    const store = new OxigraphStore();
    stores.push(store);
    const control = createPublisherControlFromStore(store);
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
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
});

function createContext(path: string, publisherControl: RequestContext['publisherControl']): RequestContext {
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
    requestAgentAddress: '0x0',
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
