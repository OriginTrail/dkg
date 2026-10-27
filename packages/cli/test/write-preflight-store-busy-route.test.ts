/**
 * Store pressure in the write preflight's follow-up reads (OT-RFC-73 S4a, AC10): after the exact probe the
 * resolver reads whether the named graph is writable here, and whether it exists locally. A scheduler refusal
 * (or store deadline) in either read used to answer `500`; it is a transient, retryable `503`, as at every other
 * route that reads the store. Checked at both async admission routes, share and publish.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { StoreOperationTimeoutError, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { asyncAdmissionUsage } from '@origintrail-official/dkg-core';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { handleKaShareAsyncEnqueue } from '../src/daemon/routes/knowledge-assets-async-share.js';
import { beginAsyncAdmissionTrace } from '../src/daemon/async-admission-trace.js';
import { daemonState } from '../src/daemon/state.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = 'cg';
const NAME = 'albums';
const busy = () => new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'agent.contextGraph.exists');
const deadline = () => new StoreOperationTimeoutError({ backend: 'oxigraph', operation: 'query', outcome: 'indeterminate' });

/** The graph is listed, but this node has neither synced it nor yet shown content for it. */
const listedUnsynced = [{ id: CG, uri: `did:dkg:context-graph:${CG}`, name: CG, subscribed: false, synced: false }];

type AgentReads = {
  listContextGraphs: () => Promise<unknown[]>;
  contextGraphHasLocalContent?: (id: string) => Promise<boolean>;
  contextGraphExists?: (id: string) => Promise<boolean>;
};

/** A graph row whose writability read fails with `failure`. */
const failingWritabilityRead = (failure: () => unknown): AgentReads => ({
  listContextGraphs: async () => listedUnsynced,
  contextGraphHasLocalContent: async () => { throw failure(); },
});

/** No row for the graph, and the local-existence read fails with `failure`. */
const failingExistenceRead = (failure: () => unknown): AgentReads => ({
  listContextGraphs: async () => [],
  contextGraphExists: async () => { throw failure(); },
});

describe('store pressure in the preflight follow-up reads, at both async admission routes', () => {
  let server: Server | undefined;
  let baseUrl: string;
  const resolveIntent = vi.fn();

  beforeEach(() => {
    asyncAdmissionUsage.reset();
    resolveIntent.mockReset();
    daemonState.promoteWorkerAvailable = true;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => { server!.close((err) => (err ? reject(err) : resolve())); });
      server = undefined;
    }
    daemonState.promoteWorkerAvailable = false;
  });

  async function start(reads: AgentReads) {
    const agent = {
      resolveAgentByToken: () => undefined,
      resolveFinalizedAssertionVmPublishIntent: resolveIntent,
      assertion: { async promoteAsync() { return { jobId: 'share-job-1' }; } },
      ...reads,
    };
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      beginAsyncAdmissionTrace(req.method, url.pathname, res);
      try {
        await handleKnowledgeAssetsRoutes({
          req, res, agent,
          publisherControl: {},
          publisherState: { runtime: { walletIds: [] }, availability: { available: true } },
          config: {}, startedAt: Date.now(), dashDb: { insertNotification: () => 1 }, opWallets: {}, network: {}, tracker: {},
          memoryManager: {}, bridgeAuthToken: undefined, nodeVersion: 'test', nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {}, fileStore: {}, extractionStatus: new Map(), assertionImportLocks: new Map(), vectorStore: {},
          embeddingProvider: null, validTokens: new Set(), apiHost: '127.0.0.1', apiPortRef: { value: 0 },
          url, path: url.pathname, requestAgentAddress: 'did:dkg:agent:test',
          authentication: requestAuthentication({ kind: 'anonymous' }),
          emitMemoryGraphChanged: () => {}, emitNotification: () => {},
        } as any);
        if (!res.writableEnded) { res.statusCode = 404; res.end(); }
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Unhandled: ${err?.message ?? err}` }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server!.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async function post(verbPath: string) {
    const res = await fetch(`${baseUrl}/api/knowledge-assets/${NAME}/${verbPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphId: CG }),
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json().catch(() => null) as any };
  }

  /** The server records on `close`, which can land just after the client has read the answer. */
  async function recorded(): Promise<string[]> {
    const deadlineAt = Date.now() + 2_000;
    for (;;) {
      const entries = asyncAdmissionUsage.take().http.map((e) => `${e.route}/${e.phase}/${e.status}/${e.code}:${e.count}`);
      if (entries.length >= 1 || Date.now() > deadlineAt) return entries;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const routes = [
    ['share_async', 'swm/share-async'],
    ['publish_async', 'vm/publish-async'],
  ] as const;

  describe.each(routes)('%s', (route, verbPath) => {
    it.each([
      ['the writability read', failingWritabilityRead],
      ['the local existence read', failingExistenceRead],
    ])('answers a scheduler refusal in %s as a retryable 503 that never started, not a 500', async (_label, reads) => {
      await start(reads(busy));
      const answer = await post(verbPath);
      expect(answer.status).toBe(503);
      expect(answer.retryAfter).toBe('1');
      expect(answer.body).toMatchObject({
        code: 'STORE_SCHEDULER_BUSY',
        reason: 'queue_wait_timeout',
        priority: 'normal',
        retryable: true,
        outcome: 'not_started',
      });
      // It is the preflight's answer: nothing after it ran.
      expect(resolveIntent).not.toHaveBeenCalled();
      expect(await recorded()).toEqual([`${route}/write_preflight/503/STORE_SCHEDULER_BUSY:1`]);
    });

    it.each([
      ['the writability read', failingWritabilityRead],
      ['the local existence read', failingExistenceRead],
    ])('answers a store deadline in %s as a retryable 503 too', async (_label, reads) => {
      await start(reads(deadline));
      const answer = await post(verbPath);
      expect(answer.status).toBe(503);
      expect(answer.retryAfter).toBe('1');
      expect(answer.body).toMatchObject({ retryable: true, outcome: 'indeterminate' });
      expect(await recorded()).toEqual([expect.stringMatching(new RegExp(`^${route}/write_preflight/503/`))]);
    });

    it.each([
      ['the writability read', failingWritabilityRead, 'Failed to validate contextGraphId local writability: disk on fire'],
      ['the local existence read', failingExistenceRead, 'Failed to validate contextGraphId local existence: disk on fire'],
    ])('keeps any other failure of %s a 500, unchanged', async (_label, reads, error) => {
      await start(reads(() => new Error('disk on fire')));
      const answer = await post(verbPath);
      expect(answer.status).toBe(500);
      expect(answer.retryAfter).toBeNull();
      expect(answer.body).toEqual({ error });
      expect(await recorded()).toEqual([`${route}/write_preflight/500/-:1`]);
    });
  });

  it('answers the standalone share-async handler the same way', async () => {
    const record = { status: 0, body: '', headers: {} as Record<string, string> };
    const url = new URL(`http://localhost/api/knowledge-assets/${NAME}/swm/share-async`);
    const ctx = {
      req: { method: 'POST', __dkgPrebufferedBody: Buffer.from(JSON.stringify({ contextGraphId: CG })) },
      res: {
        writeHead(status: number, headers: Record<string, string>) { record.status = status; Object.assign(record.headers, headers); },
        end(body: string) { record.body = body; },
      },
      url, path: url.pathname, authentication: requestAuthentication({ kind: 'nodeOperator' }),
      agent: { ...failingWritabilityRead(busy), assertion: { promoteAsync: vi.fn() } },
    } as unknown as RequestContext;
    await handleKaShareAsyncEnqueue(ctx, NAME);
    expect(record.status).toBe(503);
    expect(record.headers['Retry-After']).toBe('1');
    expect(JSON.parse(record.body)).toMatchObject({ code: 'STORE_SCHEDULER_BUSY', retryable: true, outcome: 'not_started' });
    expect(ctx.agent.assertion.promoteAsync).not.toHaveBeenCalled();
  });
});
