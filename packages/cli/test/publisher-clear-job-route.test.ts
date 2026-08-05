import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createPublisherControlFromStore } from '../src/publisher-runner.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

// #1837 — POST /api/publisher/clear-job outcome → HTTP mapping.
describe('#1837 POST /api/publisher/clear-job', () => {
  const stores: OxigraphStore[] = [];
  let ids = 0;
  let now = 1_000;
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  });

  function kaVmPublishRequest() {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social', name: 'albums', agentAddress: '0x0', shareOperationId: 'share-op-1',
      roots: [] as string[], contentScopeVersion: 2 as const, kaUal, assertionVersion: '1',
      publicTripleCount: 2, privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`, authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1, reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`, sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`, wmCurrentAssertion: '12'.repeat(32), swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(), reservedUal: kaUal,
    };
  }

  function newControl() {
    const store = new OxigraphStore();
    stores.push(store);
    return createPublisherControlFromStore(store, {});
  }

  async function finalizedJob(control: ReturnType<typeof createPublisherControlFromStore>): Promise<string> {
    const bx = { txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, walletId: 'wallet-1' };
    const inc = { blockNumber: 10, blockHash: `0x${'aa'.repeat(32)}` as `0x${string}`, blockTimestamp: 1 };
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await control.claimNext('wallet-1');
    await control.update(jobId, 'validated', { validation: { canonicalRoots: [], canonicalRootMap: {}, swmQuadCount: 2, authorityProofRef: 'knowledge-asset-lifecycle', transitionType: 'CREATE' } });
    await control.update(jobId, 'broadcast', { broadcast: bx });
    await control.update(jobId, 'included', { broadcast: bx, inclusion: inc });
    await control.update(jobId, 'finalized', { broadcast: bx, inclusion: inc, finalization: { mode: 'local' } });
    return jobId;
  }

  it('clears a terminal job → 200 cleared; repeat → 200 already_absent', async () => {
    const control = newControl();
    const jobId = await finalizedJob(control);
    const ctx1 = postClearJob(control, { jobId });
    await handlePublisherRoutes(ctx1);
    expect(responseStatus(ctx1)).toBe(200);
    expect(responseBody(ctx1)).toMatchObject({ outcome: 'cleared', jobId });

    const ctx2 = postClearJob(control, { jobId });
    await handlePublisherRoutes(ctx2);
    expect(responseStatus(ctx2)).toBe(200);
    expect(responseBody(ctx2)).toMatchObject({ outcome: 'already_absent', jobId });
  });

  it('rejects a nonterminal (accepted) job → 409 nonterminal', async () => {
    const control = newControl();
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const ctx = postClearJob(control, { jobId });
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(409);
    expect(responseBody(ctx)).toMatchObject({ outcome: 'rejected', reason: 'nonterminal' });
  });

  it('rejects a missing/empty jobId → 400 malformed', async () => {
    const control = newControl();
    const ctx = postClearJob(control, {});
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);
  });

  // #1883 review (🔴): a literal `null` body parses fine but must not TypeError on
  // destructure (→ 500). It falls through to the malformed guard as a bounded 400.
  it('rejects a literal null body → 400 malformed (no 500)', async () => {
    const control = newControl();
    const ctx = postClearJobRaw(control, 'null');
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);
    expect(responseBody(ctx)).toMatchObject({ outcome: 'rejected', reason: 'malformed' });
  });

  // #1883 review (🔴): a SPARQL-unsafe jobId must be a bounded 400, never a query-error 500.
  it('rejects a SPARQL-unsafe jobId → 400 malformed (no 500)', async () => {
    const control = newControl();
    for (const jobId of ['bad id', 'bad>id']) {
      const ctx = postClearJob(control, { jobId });
      await handlePublisherRoutes(ctx);
      expect(responseStatus(ctx)).toBe(400);
      expect(responseBody(ctx)).toMatchObject({ outcome: 'rejected', reason: 'malformed' });
    }
  });

  function postClearJob(publisherControl: RequestContext['publisherControl'], body: Record<string, unknown>): RequestContext {
    return postClearJobRaw(publisherControl, JSON.stringify(body));
  }

  function postClearJobRaw(publisherControl: RequestContext['publisherControl'], rawBody: string): RequestContext {
    const path = '/api/publisher/clear-job';
    const url = new URL(`http://127.0.0.1${path}`);
    const req = Readable.from([]);
    // readBody() resolves synchronously from a prebuffered body (as httpAuthGuard's
    // eager drain leaves it) — avoids driving a mock stream in the unit harness.
    Object.assign(req, {
      method: 'POST', url: path, headers: { host: '127.0.0.1' },
      __dkgPrebufferedBody: Buffer.from(rawBody, 'utf8'),
    });
    return {
      req: req as RequestContext['req'],
      res: createResponse() as unknown as ServerResponse,
      agent: {} as RequestContext['agent'],
      publisherControl,
      publisherState: { runtime: null, availability: { available: false, reason: 'publisher_disabled', retryable: false, operatorActionRequired: true } },
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
      statusCode: 0, headers: undefined as Record<string, string> | undefined, body: '', writableEnded: false,
      writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this; },
      end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; },
    };
  }
  function responseStatus(ctx: RequestContext): number { return (ctx.res as unknown as { statusCode: number }).statusCode; }
  function responseBody(ctx: RequestContext): Record<string, unknown> { return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>; }
});
