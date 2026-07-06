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
import type { RouteRequestContext } from '../src/daemon/routes/context.js';
import { testRouteIdentityFields } from './helpers/route-request-context.js';

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
    const jobId = await publisherControl.lift({
      contextGraphId: CONTEXT_GRAPH,
      swmId: write.shareOperationId,
      shareOperationId: write.shareOperationId,
      roots: [ENTITY],
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:route' },
      publishEpochs: 9,
    });

    const payloadCtx = createContext('GET', `/api/publisher/job-payload?id=${encodeURIComponent(jobId)}`, undefined, publisherControl);
    await handlePublisherRoutes(payloadCtx);

    expect(responseStatus(payloadCtx)).toBe(200);
    const body = responseBody(payloadCtx) as {
      payload?: {
        publishOptions?: {
          quads?: Array<{ subject: string; predicate: string; object: string }>;
          publishEpochs?: number;
        };
      };
    };
    expect(body.payload?.publishOptions?.publishEpochs).toBe(9);
    // GH #1122 — the async lift preserves caller root IRIs (parity with sync);
    // the payload carries the verbatim caller subject, not a dkg:<cg>:… rewrite.
    expect(body.payload?.publishOptions?.quads).toEqual([
      expect.objectContaining({
        subject: ENTITY,
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
  publisherControl: RouteRequestContext['publisherControl'],
): RouteRequestContext {
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    req: createRequest(method, path, body),
    res: createResponse() as unknown as ServerResponse,
    agent: {} as RouteRequestContext['agent'],
    publisherControl,
    publisherRuntime: null,
    config: {} as RouteRequestContext['config'],
    startedAt: 0,
    dashDb: {} as RouteRequestContext['dashDb'],
    opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RouteRequestContext['opWallets'],
    network: null as RouteRequestContext['network'],
    tracker: {} as RouteRequestContext['tracker'],
    memoryManager: {} as RouteRequestContext['memoryManager'],
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'test',
    catchupTracker: {} as RouteRequestContext['catchupTracker'],
    extractionRegistry: {} as RouteRequestContext['extractionRegistry'],
    fileStore: {} as RouteRequestContext['fileStore'],
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {} as RouteRequestContext['vectorStore'],
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    ...testRouteIdentityFields({ agentAddress: '0x0' }),
  };
}

function createRequest(method: 'GET' | 'POST', path: string, body: unknown): RouteRequestContext['req'] {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(payload);
  Object.assign(request, {
    method,
    url: path,
    headers: { host: '127.0.0.1' },
  });
  return request as RouteRequestContext['req'];
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

function responseStatus(ctx: RouteRequestContext): number {
  return (ctx.res as unknown as { statusCode: number }).statusCode;
}

function responseBody(ctx: RouteRequestContext): Record<string, unknown> {
  return JSON.parse((ctx.res as unknown as { body: string }).body) as Record<string, unknown>;
}
