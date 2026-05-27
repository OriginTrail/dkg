/**
 * Async-promote queue HTTP routes.
 *
 * Five new routes added by PR #2 of the async-promote-queue series:
 *
 *   POST   /api/assertion/:name/promote-async
 *   GET    /api/assertion/promote-async
 *   GET    /api/assertion/promote-async/:jobId
 *   DELETE /api/assertion/promote-async/:jobId
 *   POST   /api/assertion/promote-async/:jobId/recover
 *
 * Pattern mirrors `import-artifact-routes.test.ts`: spin up a real HTTP
 * server with `handleAssertionRoutes`, hand it a minimal mock agent
 * whose `assertion` subsurface delegates to a real
 * `TripleStoreAsyncPromoteQueue` backed by `OxigraphStore`. This means
 * we test the wire contract AND the queue invariants end-to-end without
 * needing hardhat.
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
import { handleAssertionRoutes } from '../src/daemon/routes/assertion.js';
import { daemonState } from '../src/daemon/state.js';

describe('promote-async daemon routes', () => {
  let server: Server | undefined;
  let baseUrl: string;
  let now: number;
  let idCounter: number;
  let queue: AsyncPromoteQueue;

  beforeEach(() => {
    now = 1_700_000_000_000;
    idCounter = 0;
    const store = new OxigraphStore();
    queue = new TripleStoreAsyncPromoteQueue(store, {
      now: () => now,
      idGenerator: () => `job-${++idCounter}`,
      backoff: () => 60_000,
    });
    // Wire-contract tests don't spin up the worker supervisor — they
    // pretend the worker is already up. Individual tests can flip
    // `promoteWorkerAvailable` back off to exercise the 503 path.
    daemonState.promoteWorkerAvailable = true;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
  });

  function makeAgent() {
    return {
      async listContextGraphs() {
        return ['cg', 'cg-1', 'cg-2', 'graphify', 'team-graph'].map((id) => ({
          id,
          uri: `did:dkg:context-graph:${id}`,
          name: id,
          subscribed: true,
        }));
      },
      async contextGraphExists(contextGraphId: string) {
        return ['cg', 'cg-1', 'cg-2', 'graphify', 'team-graph'].includes(contextGraphId);
      },
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
        await handleAssertionRoutes({
          req,
          res,
          agent,
          publisherControl: {},
          publisherRuntime: null,
          config: {},
          startedAt: Date.now(),
          dashDb: {},
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
          emitMemoryGraphChanged: () => {},
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
  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }
  async function del(path: string) {
    const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  // ---------------------------------------------------------------------------
  // Worker-availability gate (RFC §3.1 / Codex PR #660 review id=3302072808)
  //
  // The async-promote routes go public in this PR but the supervisor that
  // drains the queue ships in a follow-up PR. Until `promoteWorkerAvailable`
  // flips to true, every enqueue / list / status call must return 503 with
  // a reason — silently accepting jobs that would sit `queued` forever is
  // exactly the "silent black hole" the reviewer flagged.
  // ---------------------------------------------------------------------------

  it('POST /:name/promote-async returns 503 when the worker is unavailable', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/x/promote-async', {
      contextGraphId: 'cg',
      entities: 'all',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/async-promote worker is not available/i);
  });

  it('POST /:name/promote-async surfaces the unavailability reason when set', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'supervisor crashed during recoverOnStartup';
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/x/promote-async', { contextGraphId: 'cg' });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('supervisor crashed during recoverOnStartup');
  });

  it('GET /promote-async returns 503 when the worker is unavailable', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/async-promote worker is not available/i);
  });

  it('GET /promote-async/:jobId returns 503 when the worker is unavailable', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async/anything');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/async-promote worker is not available/i);
  });

  // ---------------------------------------------------------------------------
  // POST /api/assertion/:name/promote-async
  // ---------------------------------------------------------------------------

  it('POST /:name/promote-async returns 200 with jobId on success', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/my-assertion/promote-async', {
      contextGraphId: 'graphify',
      subGraphName: 'code',
      entities: 'all',
    });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe('job-1');
    expect(r.body.state).toBe('queued');
    expect(r.body.enqueuedAt).toBeUndefined();
  });

  it('POST /:name/promote-async returns 503 when the worker is unavailable', async () => {
    await startRoutes(makeAgent());
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'recoverOnStartup failed';
    const r = await post('/api/assertion/my-assertion/promote-async', {
      contextGraphId: 'graphify',
      entities: 'all',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('recoverOnStartup failed');
  });

  it('POST /:name/promote-async returns 409 with existingJobId on duplicate enqueue', async () => {
    await startRoutes(makeAgent());
    const first = await post('/api/assertion/dup/promote-async', {
      contextGraphId: 'cg',
      subGraphName: 'sub',
      entities: 'all',
    });
    expect(first.status).toBe(200);
    const second = await post('/api/assertion/dup/promote-async', {
      contextGraphId: 'cg',
      subGraphName: 'sub',
      entities: 'all',
    });
    expect(second.status).toBe(409);
    expect(second.body.existingJobId).toBe(first.body.jobId);
    expect(second.body.error).toMatch(/already active/i);
  });

  it('POST /:name/promote-async returns 503 when the worker is disabled', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'disabled via config.promoteQueue.enabled=false';
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/my-assertion/promote-async', {
      contextGraphId: 'graphify',
      entities: 'all',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/disabled/);
    expect(await queue.getStats()).toMatchObject({ queued: 0 });
  });

  it('POST /:name/promote-async returns 400 on missing contextGraphId', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/x/promote-async', { entities: 'all' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/contextGraphId/);
  });

  it('POST /:name/promote-async returns 400 on invalid assertion name', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/..%2Fbad/promote-async', {
      contextGraphId: 'cg',
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid assertion name/);
  });

  it('POST /:name/promote-async accepts an explicit entities list', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/list/promote-async', {
      contextGraphId: 'cg',
      entities: ['urn:dkg:entity:a', 'urn:dkg:entity:b'],
    });
    expect(r.status).toBe(200);
    const job = await queue.getStatus(r.body.jobId);
    expect(job?.request.entities).toEqual(['urn:dkg:entity:a', 'urn:dkg:entity:b']);
  });

  // ---------------------------------------------------------------------------
  // GET /api/assertion/promote-async/:jobId
  // ---------------------------------------------------------------------------

  it('GET /promote-async/:jobId returns the documented wire schema (RFC §3.2)', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/assertion/single/promote-async', {
      contextGraphId: 'cg',
      subGraphName: 'sg',
      entities: 'all',
    });
    const r = await get(`/api/assertion/promote-async/${enq.body.jobId}`);
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe(enq.body.jobId);
    expect(r.body.state).toBe('queued');
    // Flat assertion identity at the top level, not nested under `request`.
    expect(r.body.contextGraphId).toBe('cg');
    expect(r.body.assertionName).toBe('single');
    expect(r.body.subGraphName).toBe('sg');
    expect(r.body.entities).toBe('all');
    expect(r.body.attempts).toBe(0);
    expect(r.body.maxAttempts).toBeGreaterThan(0);
    // ISO-8601 timestamps, not raw epoch ms.
    expect(typeof r.body.enqueuedAt).toBe('string');
    expect(new Date(r.body.enqueuedAt).toISOString()).toBe(r.body.enqueuedAt);
    expect(typeof r.body.updatedAt).toBe('string');
  });

  it('GET /promote-async/:jobId never leaks the internal queue shape (claimToken, request, attempt, commitMarker)', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/assertion/internals/promote-async', {
      contextGraphId: 'cg',
      entities: 'all',
    });
    // Force the job into `running` so the queue assigns a lease + claim
    // token; the wire shape must still hide both.
    await queue.claimNext('test-worker');
    const r = await get(`/api/assertion/promote-async/${enq.body.jobId}`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('running');
    expect(r.body).not.toHaveProperty('request');
    expect(r.body).not.toHaveProperty('attempt');
    expect(r.body).not.toHaveProperty('lease');
    expect(r.body).not.toHaveProperty('commitMarker');
    expect(JSON.stringify(r.body)).not.toContain('claimToken');
    expect(JSON.stringify(r.body)).not.toContain('workerId');
  });

  it('GET /promote-async/:jobId returns 404 for unknown job', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async/non-existent');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });

  it('GET /promote-async/:jobId rejects unsafe path values before queue lookup', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async/job%3Ebad');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid promote jobId/);
  });

  // ---------------------------------------------------------------------------
  // GET /api/assertion/promote-async (list)
  // ---------------------------------------------------------------------------

  it('GET /promote-async lists all jobs', async () => {
    await startRoutes(makeAgent());
    await post('/api/assertion/a/promote-async', { contextGraphId: 'cg-1' });
    await post('/api/assertion/b/promote-async', { contextGraphId: 'cg-2' });
    await post('/api/assertion/c/promote-async', { contextGraphId: 'cg-1' });

    const r = await get('/api/assertion/promote-async');
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(3);
  });

  it('GET /promote-async?contextGraphId=cg scopes by CG', async () => {
    await startRoutes(makeAgent());
    await post('/api/assertion/a/promote-async', { contextGraphId: 'cg-1' });
    await post('/api/assertion/b/promote-async', { contextGraphId: 'cg-2' });
    await post('/api/assertion/c/promote-async', { contextGraphId: 'cg-1' });

    const r = await get('/api/assertion/promote-async?contextGraphId=cg-1');
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(2);
    expect(r.body.jobs.every((j: { contextGraphId: string }) => j.contextGraphId === 'cg-1')).toBe(true);
  });

  it('GET /promote-async?state=queued filters by state', async () => {
    await startRoutes(makeAgent());
    const a = await post('/api/assertion/a/promote-async', { contextGraphId: 'cg' });
    const b = await post('/api/assertion/b/promote-async', { contextGraphId: 'cg' });
    await del(`/api/assertion/promote-async/${a.body.jobId}`);

    const queued = await get('/api/assertion/promote-async?state=queued');
    expect(queued.body.jobs).toHaveLength(1);
    expect(queued.body.jobs[0].jobId).toBe(b.body.jobId);

    const failed = await get('/api/assertion/promote-async?state=failed');
    expect(failed.body.jobs).toHaveLength(1);
    expect(failed.body.jobs[0].jobId).toBe(a.body.jobId);
  });

  it('GET /promote-async?state=garbage returns 400', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async?state=garbage');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid state filter/);
  });

  it('GET /promote-async?state=queued,garbage rejects the whole filter', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async?state=queued,garbage');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid state filter/);
  });

  it('GET /promote-async?limit=abc returns 400', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async?limit=abc');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/positive integer/);
  });

  it('GET /promote-async?limit=10foo returns 400 instead of coercing', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/assertion/promote-async?limit=10foo');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/positive integer/);
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/assertion/promote-async/:jobId
  // ---------------------------------------------------------------------------

  it('DELETE /promote-async/:jobId cancels a queued job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/assertion/cancel-me/promote-async', { contextGraphId: 'cg' });
    const r = await del(`/api/assertion/promote-async/${enq.body.jobId}`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('failed');
    const job = await queue.getStatus(enq.body.jobId);
    expect(job?.reason).toBe('cancelled');
  });

  it('DELETE /promote-async/:jobId returns 409 for running job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/assertion/running/promote-async', { contextGraphId: 'cg' });
    await queue.claimNext('test-worker');
    const r = await del(`/api/assertion/promote-async/${enq.body.jobId}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Cannot cancel.*running/);
  });

  it('DELETE /promote-async/:jobId returns 404 for unknown job', async () => {
    await startRoutes(makeAgent());
    const r = await del('/api/assertion/promote-async/non-existent');
    expect(r.status).toBe(404);
  });

  it('DELETE /promote-async/:jobId rejects unsafe path values before queue lookup', async () => {
    await startRoutes(makeAgent());
    const r = await del('/api/assertion/promote-async/job%20bad');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid promote jobId/);
  });

  // ---------------------------------------------------------------------------
  // POST /api/assertion/promote-async/:jobId/recover
  // ---------------------------------------------------------------------------

  it('POST /promote-async/:jobId/recover requeues a failed job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/assertion/recoverable/promote-async', { contextGraphId: 'cg' });
    await del(`/api/assertion/promote-async/${enq.body.jobId}`);
    expect((await queue.getStatus(enq.body.jobId))?.state).toBe('failed');

    const r = await post(`/api/assertion/promote-async/${enq.body.jobId}/recover`, {});
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('queued');
  });

  it('POST /promote-async/:jobId/recover returns 409 for non-failed job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/assertion/queued/promote-async', { contextGraphId: 'cg' });
    const r = await post(`/api/assertion/promote-async/${enq.body.jobId}/recover`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Cannot recover/);
  });

  it('POST /promote-async/:jobId/recover returns 404 for unknown job', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/promote-async/non-existent/recover', {});
    expect(r.status).toBe(404);
  });

  it('POST /promote-async/:jobId/recover rejects unsafe path values before queue lookup', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/assertion/promote-async/job%3Ebad/recover', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid promote jobId/);
  });

  // ---------------------------------------------------------------------------
  // Routing precedence — the list route (`/promote-async`) must not be
  // claimed by the per-job route (`/promote-async/:jobId`).
  // ---------------------------------------------------------------------------

  it('GET /promote-async (no jobId) hits the list route, not the per-job route', async () => {
    await startRoutes(makeAgent());
    await post('/api/assertion/x/promote-async', { contextGraphId: 'cg' });
    const r = await get('/api/assertion/promote-async');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.jobs)).toBe(true);
  });
});
