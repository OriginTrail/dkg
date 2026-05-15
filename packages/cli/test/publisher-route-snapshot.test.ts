import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, FileWorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { createPublisherControlFromStore } from '../src/publisher-runner.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const CONTEXT_GRAPH = 'publisher-route-snapshot';
const ENTITY = 'urn:publisher-route:snapshot:entity';

describe('publisher routes with disk public snapshot refs', () => {
  const tempDirs: string[] = [];
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('inspects an enqueued job payload backed by publicSnapshotRef files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-route-snapshot-'));
    tempDirs.push(dataDir);
    const store = new OxigraphStore();
    stores.push(store);
    const publicSnapshotStore = new FileWorkspacePublicSnapshotStore(join(dataDir, 'swm-public-snapshots'));
    const publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publicSnapshotStore,
    });
    const write = await publisher.share(CONTEXT_GRAPH, [
      { subject: ENTITY, predicate: 'http://schema.org/name', object: '"Route Snapshot"', graph: '' },
    ], { publisherPeerId: 'peer-route' });

    const publisherControl = createPublisherControlFromStore(store, publicSnapshotStore);
    const enqueue = createContext('POST', '/api/publisher/enqueue', {
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: write.shareOperationId,
      roots: [ENTITY],
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authorityProofRef: 'proof:owner:route',
    }, publisherControl);

    await handlePublisherRoutes(enqueue);
    expect(responseStatus(enqueue)).toBe(200);
    const jobId = String(responseBody(enqueue).jobId);

    const payloadCtx = createContext('GET', `/api/publisher/job-payload?id=${encodeURIComponent(jobId)}`, undefined, publisherControl);
    await handlePublisherRoutes(payloadCtx);

    expect(responseStatus(payloadCtx)).toBe(200);
    const body = responseBody(payloadCtx) as {
      payload?: { publishOptions?: { quads?: Array<{ subject: string; predicate: string; object: string }> } };
    };
    expect(body.payload?.publishOptions?.quads).toEqual([
      expect.objectContaining({
        subject: expect.stringMatching(/^dkg:publisher-route-snapshot:aloha:person-profile\/entity-/),
        predicate: 'http://schema.org/name',
        object: '"Route Snapshot"',
      }),
    ]);
  });
});

function createContext(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  publisherControl: RequestContext['publisherControl'],
): RequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    req: createRequest(method, path, body),
    res: createResponse() as unknown as ServerResponse,
    agent: {} as RequestContext['agent'],
    publisherControl,
    publisherRuntime: null,
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

function createRequest(method: 'GET' | 'POST', path: string, body: unknown): RequestContext['req'] {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(payload);
  Object.assign(request, {
    method,
    url: path,
    headers: { host: '127.0.0.1' },
  });
  return request as RequestContext['req'];
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
