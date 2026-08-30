/**
 * Async-promote queue — end-to-end test.
 *
 * PR #4 of the async-promote-queue series. This is the test we
 * couldn't write before PR #3 landed: it bolts the worker supervisor
 * onto the HTTP routes from PR #2 and the queue library from PR #1,
 * and drives the entire pipeline through HTTP.
 *
 * The only "stub" is the underlying `agent.assertion.promote` body —
 * that one call would otherwise need full chain + SWM plumbing
 * (i.e. hardhat). Everything else is real:
 *
 *   - real `OxigraphStore` triple store
 *   - real `TripleStoreAsyncPromoteQueue`
 *   - real `createPromoteWorkerSupervisor` (polling, classifying, claiming)
 *   - real `handleKnowledgeAssetsRoutes` HTTP wire contract
 *   - real `node:http` server bound to a random port
 *   - real `fetch()` client
 *
 * What's verified end-to-end:
 *
 *   1. Happy path — POST /swm/share-async → wait → GET reports `succeeded`
 *      + `memoryGraphChanged` fires with `source: 'async-worker'`.
 *   2. Transient failure path — promote throws `fetch failed` → worker
 *      classifies as transient → GET reports `failed_retrying` with a
 *      future `nextRetryAt`.
 *   3. Cap-exceeded path — promote throws gossip-too-large → worker
 *      classifies as `cap_exceeded` → GET reports terminal `failed`.
 *   4. Concurrency — three concurrent enqueues all settle, none get
 *      lost, `GET ?state=succeeded` reports them all.
 *   5. Config knob — `workerConcurrency: 1` actually serializes the
 *      work (observed via max-in-flight counter).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncPromoteQueue,
  type AsyncPromoteQueue,
  type PromoteJob,
  type PromoteListFilter,
  type PromoteRequest,
} from '@origintrail-official/dkg-publisher';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { daemonState } from '../src/daemon/state.js';
import {
  createPromoteWorkerSupervisor,
  type PromoteMemoryGraphChangedEvent,
  type PromoteWorkerSupervisor,
} from '../src/daemon/worker/async-promote-worker.js';

describe('async-promote queue — end-to-end (routes + worker + queue)', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let store: OxigraphStore;
  let queue: AsyncPromoteQueue;
  let supervisor: PromoteWorkerSupervisor | undefined;
  let memoryGraphChangedEvents: PromoteMemoryGraphChangedEvent[];
  let promoteHandler: (req: PromoteRequest) => Promise<{ promotedCount: number }>;
  let promoteCallCount: number;
  let inFlightHigh: number;
  let requestToken: string | undefined;
  let tokenAgentAddress: string | undefined;

  beforeEach(() => {
    store = new OxigraphStore();
    queue = new TripleStoreAsyncPromoteQueue(store, {
      // Short backoff so the transient-retry test can verify scheduling
      // without sleeping for minutes.
      backoff: () => 200,
      maxRetries: 3,
    });
    memoryGraphChangedEvents = [];
    promoteCallCount = 0;
    inFlightHigh = 0;
    requestToken = undefined;
    tokenAgentAddress = undefined;
    promoteHandler = async () => ({ promotedCount: 1 });
    // PR #660 gates `/swm/share-async` on `daemonState.promoteWorkerAvailable`;
    // the e2e test boots its own supervisor without going through the daemon
    // lifecycle that flips this flag, so we set it manually for the routes
    // under test. afterEach resets to the initial-boot value.
    daemonState.promoteWorkerAvailable = true;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  afterEach(async () => {
    if (supervisor) {
      await supervisor.stop();
      supervisor = undefined;
    }
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  /** Builds the same agent surface PR #2's routes expect. */
  function makeAgent() {
    let inFlight = 0;
    return {
      promoteQueue: queue,
      async listContextGraphs() {
        return ['team-graph', 'graphify', 'cg'].map((id) => ({
          id,
          uri: `did:dkg:context-graph:${id}`,
          name: id,
          subscribed: true,
          synced: true,
        }));
      },
      async contextGraphExists(contextGraphId: string) {
        return ['team-graph', 'graphify', 'cg'].includes(contextGraphId);
      },
      resolveAgentByToken: (token: string) => (token === requestToken ? tokenAgentAddress : undefined),
      assertion: {
        async promote(
          contextGraphId: string,
          name: string,
          opts?: {
            entities?: readonly string[] | 'all';
            subGraphName?: string;
            agentAddress?: string;
            authorAgentAddress?: string;
          },
        ): Promise<{ promotedCount: number }> {
          inFlight += 1;
          inFlightHigh = Math.max(inFlightHigh, inFlight);
          promoteCallCount += 1;
          try {
            return await promoteHandler({
              contextGraphId,
              assertionName: name,
              subGraphName: opts?.subGraphName,
              entities: opts?.entities ?? 'all',
              ...(opts?.agentAddress ? { agentAddress: opts.agentAddress } : {}),
              ...(opts?.authorAgentAddress ? { authorAgentAddress: opts.authorAgentAddress } : {}),
            });
          } finally {
            inFlight -= 1;
          }
        },
        async promoteAsync(
          contextGraphId: string,
          name: string,
          opts?: {
            entities?: readonly string[] | 'all';
            subGraphName?: string;
            agentAddress?: string;
            authorAgentAddress?: string;
          },
        ): Promise<{ jobId: string }> {
          const jobId = await queue.enqueue({
            contextGraphId,
            assertionName: name,
            subGraphName: opts?.subGraphName,
            entities: opts?.entities ?? 'all',
            ...(opts?.agentAddress ? { agentAddress: opts.agentAddress } : {}),
            ...(opts?.authorAgentAddress ? { authorAgentAddress: opts.authorAgentAddress } : {}),
          });
          return { jobId };
        },
        async getPromoteAsyncStatus(jobId: string): Promise<PromoteJob | null> {
          return queue.getStatus(jobId);
        },
        async listPromoteAsyncJobs(filter?: PromoteListFilter): Promise<PromoteJob[]> {
          return queue.list(filter);
        },
        async cancelPromoteAsync(jobId: string): Promise<void> {
          return queue.cancel(jobId);
        },
        async recoverPromoteAsync(jobId: string): Promise<void> {
          return queue.recover(jobId);
        },
      },
    } as const;
  }

  async function startServerAndSupervisor(
    options: { workerConcurrency?: number; pollIntervalMs?: number } = {},
  ) {
    const agent = makeAgent();

    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        await handleKnowledgeAssetsRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherRuntime: null,
          config: {},
          startedAt: Date.now(),
          dashDb: { insertNotification: () => 1 },
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {},
          fileStore: {},
          extractionStatus: new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          url,
          path: url.pathname,
          requestAgentAddress: 'did:dkg:agent:test',
          authentication: tokenAgentAddress
            ? requestAuthentication({ kind: 'agent', agentAddress: tokenAgentAddress, token: requestToken })
            : requestAuthentication({ kind: 'anonymous' }),
          emitMemoryGraphChanged: () => {},
          emitNotification: () => {},
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
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

    supervisor = createPromoteWorkerSupervisor({
      agent: agent as any,
      workerConcurrency: options.workerConcurrency ?? 2,
      pollIntervalMs: options.pollIntervalMs ?? 25,
      heartbeatIntervalMs: 0, // disable heartbeat for fast tests; tested separately in worker unit tests
      shutdownTimeoutMs: 1000,
      log: () => {},
      emitMemoryGraphChanged: (e) => memoryGraphChangedEvents.push(e),
      workerIdPrefix: 'e2e',
    });
    await supervisor.start();
  }

  async function post(path: string, body?: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function waitForJobState(jobId: string, target: PromoteJob['state'], timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await queue.getStatus(jobId);
      if (job?.state === target) return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    const final = await queue.getStatus(jobId);
    throw new Error(`Timed out waiting for ${jobId} to reach ${target}; current state: ${final?.state}`);
  }

  it('happy path: POST /swm/share-async → worker drains → GET reports succeeded + SSE event fires', async () => {
    await startServerAndSupervisor();
    const { status, body } = await post('/api/knowledge-assets/notes/swm/share-async', {
      contextGraphId: 'team-graph',
      subGraphName: 'docs',
      entities: 'all',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ state: 'queued' });
    const jobId = body!.jobId as string;

    const done = await waitForJobState(jobId, 'succeeded');
    expect(done.state).toBe('succeeded');
    expect(done.result?.promotedCount).toBe(1);
    // The stubbed `agent.assertion.promote` in this test only triggers the
    // `swmInserted` + `promoteStarted` flags; the wmCleaned / lifecycleStamped
    // / gossiped flags require a real chain + SWM substrate which this test
    // intentionally avoids. See rc.12 backlog (#676) for a fixture-backed
    // version of this assertion.
    expect(done.commitMarker).toMatchObject({ swmInserted: true });

    const httpView = await get(`/api/knowledge-assets/swm/share-jobs/${jobId}`);
    expect(httpView.status).toBe(200);
    expect(httpView.body).toMatchObject({ jobId, state: 'succeeded' });

    expect(memoryGraphChangedEvents).toHaveLength(1);
    expect(memoryGraphChangedEvents[0]).toMatchObject({
      contextGraphId: 'team-graph',
      subGraphName: 'docs',
      operation: 'assertion_promoted',
      source: 'async-worker',
      counts: { triples: 1 },
      layers: ['wm', 'swm'],
    });
  });

  it('agent-token share-async carries the storage lane and author through queue and worker', async () => {
    requestToken = 'agent-token-lane';
    tokenAgentAddress = '0x3333333333333333333333333333333333333333';
    const promoteRequests: PromoteRequest[] = [];
    promoteHandler = async (req) => {
      promoteRequests.push(req);
      return { promotedCount: 1 };
    };
    await startServerAndSupervisor();

    const { status, body } = await post('/api/knowledge-assets/token-notes/swm/share-async', {
      contextGraphId: 'team-graph',
      subGraphName: 'docs',
      entities: 'all',
    });
    expect(status).toBe(200);
    const jobId = body!.jobId as string;

    const done = await waitForJobState(jobId, 'succeeded');
    expect(done.request).toMatchObject({
      agentAddress: tokenAgentAddress,
      authorAgentAddress: tokenAgentAddress,
    });
    expect(promoteRequests).toHaveLength(1);
    expect(promoteRequests[0]).toMatchObject({
      assertionName: 'token-notes',
      agentAddress: tokenAgentAddress,
      authorAgentAddress: tokenAgentAddress,
    });
  });

  it('transient failure: fetch error → failed_retrying → GET reflects retry schedule', async () => {
    promoteHandler = async () => {
      throw new Error('fetch failed');
    };
    await startServerAndSupervisor();
    const { body } = await post('/api/knowledge-assets/wobbly/swm/share-async', {
      contextGraphId: 'team-graph',
    });
    const jobId = body!.jobId as string;

    const retrying = await waitForJobState(jobId, 'failed_retrying');
    expect(retrying.attempt.count).toBe(1);
    expect(retrying.attempt.lastError?.classification).toBe('transient');
    expect(retrying.attempt.lastError?.message).toContain('fetch failed');
    expect(retrying.attempt.nextRetryAt).toBeGreaterThan(Date.now() - 1_000);

    const httpView = await get(`/api/knowledge-assets/swm/share-jobs/${jobId}`);
    expect(httpView.body).toMatchObject({ state: 'failed_retrying' });
    // No memoryGraphChanged emitted on failed attempts.
    expect(memoryGraphChangedEvents).toHaveLength(0);
  });

  it('cap_exceeded: gossip-too-large error settles immediately in terminal failed (no retries)', async () => {
    promoteHandler = async () => {
      throw new Error('Promoted assertion too large for gossip (6000 KB, limit 4 MB)');
    };
    await startServerAndSupervisor();
    const { body } = await post('/api/knowledge-assets/giant/swm/share-async', {
      contextGraphId: 'team-graph',
    });
    const jobId = body!.jobId as string;

    const failed = await waitForJobState(jobId, 'failed');
    expect(failed.attempt.lastError?.classification).toBe('cap_exceeded');
    expect(failed.attempt.lastError?.retryable).toBe(false);
    expect(failed.attempt.nextRetryAt).toBeUndefined();
    expect(promoteCallCount).toBe(1); // never retried
  });

  it('concurrency: three concurrent enqueues all settle and list() reports them', async () => {
    await startServerAndSupervisor({ workerConcurrency: 3 });
    const results = await Promise.all([
      post('/api/knowledge-assets/a/swm/share-async', { contextGraphId: 'team-graph' }),
      post('/api/knowledge-assets/b/swm/share-async', { contextGraphId: 'team-graph' }),
      post('/api/knowledge-assets/c/swm/share-async', { contextGraphId: 'team-graph' }),
    ]);
    const jobIds = results.map((r) => r.body!.jobId as string);
    expect(new Set(jobIds).size).toBe(3); // all unique

    for (const id of jobIds) await waitForJobState(id, 'succeeded');

    const listResp = await get('/api/knowledge-assets/swm/share-jobs?state=succeeded');
    expect(listResp.status).toBe(200);
    const succeeded = (listResp.body as { jobs: PromoteJob[] }).jobs;
    expect(succeeded.map((j) => j.jobId).sort()).toEqual([...jobIds].sort());
  });

  it('workerConcurrency: 1 actually serializes the work (max-in-flight === 1)', async () => {
    promoteHandler = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { promotedCount: 1 };
    };
    await startServerAndSupervisor({ workerConcurrency: 1, pollIntervalMs: 10 });
    await Promise.all([
      post('/api/knowledge-assets/a/swm/share-async', { contextGraphId: 'team-graph' }),
      post('/api/knowledge-assets/b/swm/share-async', { contextGraphId: 'team-graph' }),
      post('/api/knowledge-assets/c/swm/share-async', { contextGraphId: 'team-graph' }),
    ]);
    // Wait for all three to settle.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const stats = (await get('/api/knowledge-assets/swm/share-jobs')).body as { jobs: PromoteJob[] };
      if (stats.jobs.filter((j) => j.state === 'succeeded').length === 3) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(inFlightHigh).toBe(1);
    expect(promoteCallCount).toBe(3);
  });
});
