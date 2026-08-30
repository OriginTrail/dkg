/**
 * Daemon lifecycle wiring for async promote.
 *
 * The route tests prove `/swm/share-async` enqueues jobs. The worker tests
 * prove the supervisor can drain a queue. This file pins the seam
 * `runDaemonInner()` uses after the API is listening: a job enqueued
 * through the HTTP route is drained by the daemon lifecycle worker, and
 * shutdown waits for the in-flight promote before closing the agent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncPromoteQueue,
  type AsyncPromoteQueue,
  type PromoteJob,
  type PromoteListFilter,
} from '@origintrail-official/dkg-publisher';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { daemonState, startPromoteWorkerDaemonLifecycle, type PromoteWorkerDaemonLifecycle } from '../src/daemon.js';

describe('promote-async daemon lifecycle wiring', () => {
  let server: Server | undefined;
  let baseUrl: string;
  let queue: AsyncPromoteQueue;
  let now: number;
  let lifecycle: PromoteWorkerDaemonLifecycle | undefined;

  beforeEach(() => {
    now = 1_700_000_000_000;
    const store = new OxigraphStore();
    queue = new TripleStoreAsyncPromoteQueue(store, {
      now: () => now,
      idGenerator: () => 'job-daemon-1',
      backoff: () => 60_000,
    });
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  afterEach(async () => {
    await lifecycle?.stop('test cleanup');
    lifecycle = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(assertion: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await assertion()) return;
      await sleep(10);
    }
    throw new Error('timed out waiting for daemon lifecycle assertion');
  }

  function makeAgent(promoteImpl: (contextGraphId: string, name: string, opts?: any) => Promise<{ promotedCount: number }>) {
    return {
      promoteQueue: queue,
      async listContextGraphs() {
        return ['graphify', 'cg'].map((id) => ({
          id,
          uri: `did:dkg:context-graph:${id}`,
          name: id,
          subscribed: true,
          synced: true,
        }));
      },
      async contextGraphExists(contextGraphId: string) {
        return ['graphify', 'cg'].includes(contextGraphId);
      },
      resolveAgentByToken: () => undefined,
      assertion: {
        async promoteAsync(
          contextGraphId: string,
          name: string,
          opts?: { entities?: readonly string[] | 'all'; subGraphName?: string },
        ): Promise<{ jobId: string }> {
          const jobId = await queue.enqueue({
            contextGraphId,
            assertionName: name,
            subGraphName: opts?.subGraphName,
            entities: opts?.entities ?? 'all',
          });
          return { jobId };
        },
        async promote(contextGraphId: string, name: string, opts?: any): Promise<{ promotedCount: number }> {
          return promoteImpl(contextGraphId, name, opts);
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
    };
  }

  async function startRoutes(agent: ReturnType<typeof makeAgent>) {
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
          requestToken: undefined,
          requestAgentAddress: 'did:dkg:agent:test',
          requestPrincipal: { kind: 'anonymous' },
          requestAuthorization: { nodeOperator: false },
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
  }

  async function post(path: string, body?: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  it('drains a route-enqueued job after daemon worker startup and waits for it during shutdown', async () => {
    const promoteStarted = deferred<void>();
    const promoteGate = deferred<{ promotedCount: number }>();
    const promoteCalls: Array<{ contextGraphId: string; name: string; opts: any }> = [];
    const memoryEvents: any[] = [];

    const agent = makeAgent(async (contextGraphId, name, opts) => {
      promoteCalls.push({ contextGraphId, name, opts });
      promoteStarted.resolve(undefined);
      return promoteGate.promise;
    });

    await startRoutes(agent);

    daemonState.promoteWorkerAvailable = true;
    const enqueued = await post('/api/knowledge-assets/daemon-lifecycle/swm/share-async', {
      contextGraphId: 'graphify',
      subGraphName: 'code',
      entities: 'all',
    });
    // Spec §3.1: enqueue replies 200 OK with `{ jobId, state: "queued" }`.
    // (Routes return 503 when the worker flag is off — the test arms it
    // explicitly above so the enqueue gets through.)
    expect(enqueued.status).toBe(200);
    expect(enqueued.body.jobId).toBe('job-daemon-1');

    daemonState.promoteWorkerAvailable = false;
    lifecycle = startPromoteWorkerDaemonLifecycle({
      agent: agent as any,
      log: () => {},
      emitMemoryGraphChanged: (event) => memoryEvents.push(event),
      workerConfig: {
        workerConcurrency: 1,
        pollIntervalMs: 10,
        heartbeatIntervalMs: 1_000,
        shutdownTimeoutMs: 1_000,
        now: () => now,
        workerIdPrefix: 'daemon-lifecycle-test',
      },
    });

    await lifecycle.waitForStartup();
    expect(daemonState.promoteWorkerAvailable).toBe(true);
    await waitFor(() => promoteCalls.length === 1);
    await promoteStarted.promise;

    expect(promoteCalls[0]).toEqual({
      contextGraphId: 'graphify',
      name: 'daemon-lifecycle',
      opts: { entities: 'all', subGraphName: 'code' },
    });

    let stopSettled = false;
    const stopPromise = lifecycle.stop('daemon shutting down').then(() => {
      stopSettled = true;
    });
    await sleep(25);
    expect(stopSettled).toBe(false);

    now += 10;
    promoteGate.resolve({ promotedCount: 2 });
    await stopPromise;

    const job = await queue.getStatus(enqueued.body.jobId);
    expect(job?.state).toBe('succeeded');
    expect(job?.result?.promotedCount).toBe(2);
    expect(stopSettled).toBe(true);
    expect(daemonState.promoteWorkerAvailable).toBe(false);
    expect(daemonState.promoteWorkerUnavailableReason).toBe('daemon shutting down');
    expect(memoryEvents).toContainEqual({
      contextGraphId: 'graphify',
      layers: ['wm', 'swm'],
      subGraphName: 'code',
      operation: 'assertion_promoted',
      source: 'async-worker',
      counts: { triples: 2 },
    });
  });

  it('worker startup failure leaves the daemon-state flag off and tags the structured log (Codex PR #665 id=3300423547)', async () => {
    // Force `supervisor.start()` to throw by handing it an agent whose
    // queue.recoverOnStartup rejects. The lifecycle wrapper must record
    // the failure on `daemonState` (so the route layer surfaces 503
    // instead of silently queueing jobs) and emit a structured
    // `[async-promote-worker]` log line so operators can grep for it.
    const recoverError = new Error('triple-store offline during recovery');
    const failingAgent = {
      promoteQueue: {
        recoverOnStartup: async () => {
          throw recoverError;
        },
        claimNext: async () => {
          throw new Error('claimNext must not run after a failed startup');
        },
      },
      assertion: {
        promote: async () => ({ promotedCount: 0 }),
      },
    };
    const logs: string[] = [];
    lifecycle = startPromoteWorkerDaemonLifecycle({
      agent: failingAgent as any,
      log: (m) => logs.push(m),
      emitMemoryGraphChanged: () => {},
      workerConfig: {
        workerConcurrency: 1,
        pollIntervalMs: 1_000_000,
        heartbeatIntervalMs: 0,
        shutdownTimeoutMs: 200,
        now: () => now,
        workerIdPrefix: 'startup-failure-test',
      },
    });

    await lifecycle.waitForStartup();
    expect(daemonState.promoteWorkerAvailable).toBe(false);
    expect(daemonState.promoteWorkerUnavailableReason).toContain(
      'triple-store offline during recovery',
    );
    // Greppable tag + the "read-only until daemon restart" phrasing the
    // operator-runbook docs point at.
    expect(
      logs.some(
        (m) =>
          m.includes('[async-promote-worker]') &&
          m.includes('startup failed') &&
          m.includes('queue is read-only'),
      ),
    ).toBe(true);
    expect(lifecycle.getSupervisor()).toBeNull();
  });
});
