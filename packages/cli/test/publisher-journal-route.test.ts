import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createPublisherControlFromStore } from '../src/publisher-runner.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

// #1829 — GET /api/publisher/journal route: read-only append-only journal, by jobId
// or facts-pure by lifecycle identity. createPublisherControlFromStore enables
// journalWrites, so enqueue produces an admission entry.
describe('#1829 GET /api/publisher/journal', () => {
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

  async function newControlWithJob(): Promise<{ control: ReturnType<typeof createPublisherControlFromStore>; jobId: string; store: OxigraphStore }> {
    const store = new OxigraphStore();
    stores.push(store);
    const control = createPublisherControlFromStore(store);
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    return { control, jobId, store };
  }

  it('reads the journal by jobId (200, admission entry present)', async () => {
    const { control, jobId } = await newControlWithJob();
    const ctx = createContext(`/api/publisher/journal?jobId=${jobId}`, control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    const body = responseBody(ctx) as { entries: Array<{ kind: string; jobId: string }>; maxSeq: number; complete: boolean };
    expect(body.entries.length).toBe(1);
    expect(body.entries[0]?.kind).toBe('admission');
    expect(body.entries[0]?.jobId).toBe(jobId);
    expect(body.complete).toBe(true);
  });

  it.each([true, false])('keeps a cleared journal bound to its durable CG for an authorized=%s agent', async allowed => {
    const { control, jobId, store } = await newControlWithJob();
    await control.claimNext('wallet-1');
    await control.update(jobId, 'validated', { validation: { canonicalRoots: [], canonicalRootMap: {}, swmQuadCount: 2, authorityProofRef: 'knowledge-asset-lifecycle', transitionType: 'CREATE' } });
    await control.update(jobId, 'finalized', { finalization: { mode: 'local' } });
    const retained = await control.readJournalByJob(jobId);
    expect(retained.entries.length).toBeGreaterThan(1);
    await control.clearTerminalJob(jobId);
    expect(await control.getStatus(jobId)).toBeNull();
    const reloaded = createPublisherControlFromStore(store);
    const status = vi.spyOn(reloaded, 'getStatus');
    const journal = vi.spyOn(reloaded, 'readJournalByJob');
    const queries = vi.spyOn(store, 'query');
    const ctx = createContext(`/api/publisher/journal?jobId=${jobId}&contextGraphId=unrelated-public`, reloaded);
    const caller = '0x3333333333333333333333333333333333333333';
    ctx.authentication = requestAuthentication({ kind: 'agent', agentAddress: caller });
    const authority = vi.fn(async () => ({ outcome: allowed ? 'allowed' as const : 'denied' as const,
      source: 'registered-chain' as const, reason: 'chain-participant', grantScope: allowed ? 'caller' as const : 'none' as const,
      metadataBootstrap: 'forbidden' as const }));
    Object.assign(ctx.agent, { resolveContextGraphReadAuthority: authority });
    await handlePublisherRoutes(ctx);
    expect(authority).toHaveBeenCalledWith('music-social', expect.objectContaining({ callerAgentAddress: caller }));
    expect(responseStatus(ctx)).toBe(allowed ? 200 : 403);
    expect(status).not.toHaveBeenCalled();
    expect(queries.mock.calls.filter(([sparql]) => sparql.includes('<urn:dkg:publisher:journalJobId>'))).toHaveLength(1);
    expect(journal).toHaveBeenCalledExactlyOnceWith(jobId);
    if (allowed) expect(responseBody(ctx)).toEqual(retained);
    else expect((ctx.res as unknown as { body: string }).body).not.toContain(jobId);
    expect(await control.readJournalByJob(jobId)).toEqual(retained);
  });

  it('reads the journal facts-pure by lifecycle identity (200)', async () => {
    const { control, jobId } = await newControlWithJob();
    const ctx = createContext('/api/publisher/journal?contextGraphId=music-social&name=albums', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    const body = responseBody(ctx) as { entries: Array<{ jobId: string }>; txHashes: string[] };
    expect(body.entries.some((e) => e.jobId === jobId)).toBe(true);
    expect(body.txHashes).toEqual([]); // no broadcast yet
  });

  it('400s when neither jobId nor (contextGraphId+name) is given', async () => {
    const { control } = await newControlWithJob();
    const ctx = createContext('/api/publisher/journal?contextGraphId=music-social', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);
  });

  it('400s on an explicit empty subGraphName (matches admission)', async () => {
    const { control } = await newControlWithJob();
    const ctx = createContext('/api/publisher/journal?contextGraphId=music-social&name=albums&subGraphName=', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(400);
  });

  it('returns an empty journal for unknown facts (200)', async () => {
    const { control } = await newControlWithJob();
    const ctx = createContext('/api/publisher/journal?contextGraphId=music-social&name=nope', control);
    await handlePublisherRoutes(ctx);
    expect(responseStatus(ctx)).toBe(200);
    const body = responseBody(ctx) as { entries: unknown[]; maxSeq: number };
    expect(body.entries).toEqual([]);
    expect(body.maxSeq).toBe(-1);
  });
});

function createContext(path: string, publisherControl: RequestContext['publisherControl'], requestAgentAddress = '0x0'): RequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = Readable.from([]);
  Object.assign(req, { method: 'GET', url: path, headers: { host: '127.0.0.1' } });
  return {
    req: req as RequestContext['req'],
    res: createResponse() as unknown as ServerResponse,
    agent: { resolveContextGraphReadAuthority: async () => ({
      outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant', metadataBootstrap: 'forbidden',
    }) } as RequestContext['agent'],
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
    authentication: requestAuthentication({ kind: 'anonymous' }),
    requestAgentAddress,
  };
}

function createResponse() {
  return Object.assign(new EventEmitter(), {
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
  });
}

function responseStatus(ctx: RequestContext): number {
  return (ctx.res as unknown as { statusCode: number }).statusCode;
}

function responseBody(ctx: RequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}
