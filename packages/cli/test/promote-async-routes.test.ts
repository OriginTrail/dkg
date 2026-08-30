/**
 * Async SWM-share queue HTTP routes (the KA-unified successors of the
 * legacy async-promote queue routes).
 *
 * Five routes, migrated from `/api/assertion/promote-async*` to the
 * GitHub-shaped `/api/knowledge-assets/.../swm/share*` surface:
 *
 *   POST   /api/knowledge-assets/:name/swm/share-async
 *        ↔ POST   /api/assertion/:name/promote-async
 *   GET    /api/knowledge-assets/swm/share-jobs
 *        ↔ GET    /api/assertion/promote-async
 *   GET    /api/knowledge-assets/swm/share-jobs/:jobId
 *        ↔ GET    /api/assertion/promote-async/:jobId
 *   DELETE /api/knowledge-assets/swm/share-jobs/:jobId
 *        ↔ DELETE /api/assertion/promote-async/:jobId
 *   POST   /api/knowledge-assets/swm/share-jobs/:jobId/recover
 *        ↔ POST   /api/assertion/promote-async/:jobId/recover
 *
 * Pattern mirrors `knowledge-assets-route.test.ts`: spin up a real HTTP
 * server with `handleKnowledgeAssetsRoutes`, hand it a minimal mock agent
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
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { daemonState } from '../src/daemon/state.js';

describe('async SWM-share queue daemon routes', () => {
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

  function makeAgent(tokenToAddress: Record<string, string> = {}) {
    return {
      async listContextGraphs() {
        return ['cg', 'cg-1', 'cg-2', 'graphify', 'team-graph'].map((id) => ({
          id,
          uri: `did:dkg:context-graph:${id}`,
          name: id,
          subscribed: true,
          synced: true,
        }));
      },
      async contextGraphExists(contextGraphId: string) {
        return ['cg', 'cg-1', 'cg-2', 'graphify', 'team-graph'].includes(contextGraphId);
      },
      resolveAgentByToken: (token?: string) => (token ? tokenToAddress[token] : undefined),
      assertion: {
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
          } as any);
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
        async clearPromoteAsync(jobId: string) {
          return (queue as TripleStoreAsyncPromoteQueue).clearTerminalJob(jobId);
        },
      },
    };
  }

  async function startRoutes(agent: ReturnType<typeof makeAgent>) {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = req.headers.authorization;
      const requestToken = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : undefined;
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
          requestToken,
          requestAgentAddress: agent.resolveAgentByToken(requestToken) ?? 'did:dkg:agent:test',
          requestPrincipal: agent.resolveAgentByToken(requestToken)
            ? { kind: 'agent', agentAddress: agent.resolveAgentByToken(requestToken) }
            : { kind: 'anonymous' },
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

  async function post(
    path: string,
    body?: Record<string, unknown>,
    opts: { bearer?: string } = {},
  ) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
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

  it('POST /:name/swm/share-async returns 503 when the worker is unavailable', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/x/swm/share-async', {
      contextGraphId: 'cg',
      entities: 'all',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/async-promote worker is not available/i);
  });

  it('POST /:name/swm/share-async surfaces the unavailability reason when set', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'supervisor crashed during recoverOnStartup';
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/x/swm/share-async', { contextGraphId: 'cg' });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('supervisor crashed during recoverOnStartup');
  });

  it('GET /swm/share-jobs returns 503 when the worker is unavailable', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/async-promote worker is not available/i);
  });

  it('GET /swm/share-jobs/:jobId returns 503 when the worker is unavailable', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = null;
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs/anything');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/async-promote worker is not available/i);
  });

  // ---------------------------------------------------------------------------
  // POST /api/knowledge-assets/:name/swm/share-async
  // ---------------------------------------------------------------------------

  it('POST /:name/swm/share-async returns 200 with jobId on success', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/my-assertion/swm/share-async', {
      contextGraphId: 'graphify',
      subGraphName: 'code',
      entities: 'all',
    });
    expect(r.status).toBe(200);
    expect(r.body.jobId).toBe('job-1');
    expect(r.body.state).toBe('queued');
    expect(r.body.enqueuedAt).toBeUndefined();
  });

  it('POST /:name/swm/share-async stores the agent-token author in the internal job request', async () => {
    const agentAddress = `0x${'ab'.repeat(20)}`;
    await startRoutes(makeAgent({ 'agent-a-token': agentAddress }));
    const r = await post(
      '/api/knowledge-assets/my-assertion/swm/share-async',
      {
        contextGraphId: 'graphify',
        entities: 'all',
      },
      { bearer: 'agent-a-token' },
    );
    expect(r.status).toBe(200);
    const job = await queue.getStatus(r.body.jobId);
    expect((job?.request as Record<string, unknown>).agentAddress).toBe(agentAddress);
    expect((job?.request as Record<string, unknown>).authorAgentAddress).toBe(agentAddress);
  });

  it('POST /:name/swm/share-async returns 503 when the worker is unavailable', async () => {
    await startRoutes(makeAgent());
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'recoverOnStartup failed';
    const r = await post('/api/knowledge-assets/my-assertion/swm/share-async', {
      contextGraphId: 'graphify',
      entities: 'all',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('recoverOnStartup failed');
  });

  it('POST /:name/swm/share-async returns 409 with existingJobId on duplicate enqueue', async () => {
    await startRoutes(makeAgent());
    const first = await post('/api/knowledge-assets/dup/swm/share-async', {
      contextGraphId: 'cg',
      subGraphName: 'sub',
      entities: 'all',
    });
    expect(first.status).toBe(200);
    const second = await post('/api/knowledge-assets/dup/swm/share-async', {
      contextGraphId: 'cg',
      subGraphName: 'sub',
      entities: 'all',
    });
    expect(second.status).toBe(409);
    expect(second.body.existingJobId).toBe(first.body.jobId);
    expect(second.body.error).toMatch(/already active/i);
  });

  it('POST /:name/swm/share-async returns 503 when the worker is disabled', async () => {
    daemonState.promoteWorkerAvailable = false;
    daemonState.promoteWorkerUnavailableReason = 'disabled via config.promoteQueue.enabled=false';
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/my-assertion/swm/share-async', {
      contextGraphId: 'graphify',
      entities: 'all',
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/disabled/);
    expect(await queue.getStats()).toMatchObject({ queued: 0 });
  });

  it('POST /:name/swm/share-async returns 400 on missing contextGraphId', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/x/swm/share-async', { entities: 'all' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/contextGraphId/);
  });

  it('POST /:name/swm/share-async returns 400 on invalid assertion name', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/..%2Fbad/swm/share-async', {
      contextGraphId: 'cg',
    });
    expect(r.status).toBe(400);
    // The KA per-name dispatch validates the decoded :name segment up front.
    expect(r.body.error).toMatch(/Invalid "name"/);
  });

  it('POST /:name/swm/share-async rejects an explicit entities list', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/list/swm/share-async', {
      contextGraphId: 'cg',
      entities: ['urn:dkg:entity:a', 'urn:dkg:entity:b'],
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('KA_ATOMIC_SHARE_REQUIRED');
    expect(await queue.getStats()).toMatchObject({ queued: 0 });
  });

  // ---------------------------------------------------------------------------
  // GET /api/knowledge-assets/swm/share-jobs/:jobId
  // ---------------------------------------------------------------------------

  it('GET /swm/share-jobs/:jobId returns the documented wire schema (RFC §3.2)', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/single/swm/share-async', {
      contextGraphId: 'cg',
      subGraphName: 'sg',
      entities: 'all',
    });
    const r = await get(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}`);
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

  it('GET /swm/share-jobs/:jobId never leaks the internal queue shape (claimToken, request, attempt, commitMarker)', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/internals/swm/share-async', {
      contextGraphId: 'cg',
      entities: 'all',
    });
    // Force the job into `running` so the queue assigns a lease + claim
    // token; the wire shape must still hide both.
    await queue.claimNext('test-worker');
    const r = await get(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('running');
    expect(r.body).not.toHaveProperty('request');
    expect(r.body).not.toHaveProperty('attempt');
    expect(r.body).not.toHaveProperty('lease');
    expect(r.body).not.toHaveProperty('commitMarker');
    expect(JSON.stringify(r.body)).not.toContain('claimToken');
    expect(JSON.stringify(r.body)).not.toContain('workerId');
  });

  it('GET /swm/share-jobs/:jobId returns 404 for unknown job', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs/non-existent');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });

  it('GET /swm/share-jobs/:jobId rejects unsafe path values before queue lookup', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs/job%3Ebad');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid promote jobId/);
  });

  // ---------------------------------------------------------------------------
  // GET /api/knowledge-assets/swm/share-jobs (list)
  // ---------------------------------------------------------------------------

  it('GET /swm/share-jobs lists all jobs', async () => {
    await startRoutes(makeAgent());
    await post('/api/knowledge-assets/a/swm/share-async', { contextGraphId: 'cg-1' });
    await post('/api/knowledge-assets/b/swm/share-async', { contextGraphId: 'cg-2' });
    await post('/api/knowledge-assets/c/swm/share-async', { contextGraphId: 'cg-1' });

    const r = await get('/api/knowledge-assets/swm/share-jobs');
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(3);
  });

  it('GET /swm/share-jobs?contextGraphId=cg scopes by CG', async () => {
    await startRoutes(makeAgent());
    await post('/api/knowledge-assets/a/swm/share-async', { contextGraphId: 'cg-1' });
    await post('/api/knowledge-assets/b/swm/share-async', { contextGraphId: 'cg-2' });
    await post('/api/knowledge-assets/c/swm/share-async', { contextGraphId: 'cg-1' });

    const r = await get('/api/knowledge-assets/swm/share-jobs?contextGraphId=cg-1');
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(2);
    expect(r.body.jobs.every((j: { contextGraphId: string }) => j.contextGraphId === 'cg-1')).toBe(true);
  });

  it('GET /swm/share-jobs?state=queued filters by state', async () => {
    await startRoutes(makeAgent());
    const a = await post('/api/knowledge-assets/a/swm/share-async', { contextGraphId: 'cg' });
    const b = await post('/api/knowledge-assets/b/swm/share-async', { contextGraphId: 'cg' });
    await del(`/api/knowledge-assets/swm/share-jobs/${a.body.jobId}`);

    const queued = await get('/api/knowledge-assets/swm/share-jobs?state=queued');
    expect(queued.body.jobs).toHaveLength(1);
    expect(queued.body.jobs[0].jobId).toBe(b.body.jobId);

    const failed = await get('/api/knowledge-assets/swm/share-jobs?state=failed');
    expect(failed.body.jobs).toHaveLength(1);
    expect(failed.body.jobs[0].jobId).toBe(a.body.jobId);
  });

  it('GET /swm/share-jobs?state=garbage returns 400', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs?state=garbage');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid state filter/);
  });

  it('GET /swm/share-jobs?state=queued,garbage rejects the whole filter', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs?state=queued,garbage');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid state filter/);
  });

  it('GET /swm/share-jobs?limit=abc returns 400', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs?limit=abc');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/positive integer/);
  });

  it('GET /swm/share-jobs?limit=10foo returns 400 instead of coercing', async () => {
    await startRoutes(makeAgent());
    const r = await get('/api/knowledge-assets/swm/share-jobs?limit=10foo');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/positive integer/);
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/knowledge-assets/swm/share-jobs/:jobId
  // ---------------------------------------------------------------------------

  it('DELETE /swm/share-jobs/:jobId cancels a queued job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/cancel-me/swm/share-async', { contextGraphId: 'cg' });
    const r = await del(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('failed');
    const job = await queue.getStatus(enq.body.jobId);
    expect(job?.reason).toBe('cancelled');
  });

  it('DELETE /swm/share-jobs/:jobId returns 409 for running job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/running/swm/share-async', { contextGraphId: 'cg' });
    await queue.claimNext('test-worker');
    const r = await del(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Cannot cancel.*running/);
  });

  it('DELETE /swm/share-jobs/:jobId returns 404 for unknown job', async () => {
    await startRoutes(makeAgent());
    const r = await del('/api/knowledge-assets/swm/share-jobs/non-existent');
    expect(r.status).toBe(404);
  });

  it('DELETE /swm/share-jobs/:jobId rejects unsafe path values before queue lookup', async () => {
    await startRoutes(makeAgent());
    const r = await del('/api/knowledge-assets/swm/share-jobs/job%20bad');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid promote jobId/);
  });

  // ---------------------------------------------------------------------------
  // POST /api/knowledge-assets/swm/share-jobs/:jobId/recover
  // ---------------------------------------------------------------------------

  it('POST /swm/share-jobs/:jobId/recover requeues a failed job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/recoverable/swm/share-async', { contextGraphId: 'cg' });
    await del(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}`);
    expect((await queue.getStatus(enq.body.jobId))?.state).toBe('failed');

    const r = await post(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}/recover`, {});
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('queued');
  });

  it('POST /swm/share-jobs/:jobId/recover returns 409 for non-failed job', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/queued/swm/share-async', { contextGraphId: 'cg' });
    const r = await post(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}/recover`, {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Cannot recover/);
  });

  it('POST /swm/share-jobs/:jobId/recover returns 404 for unknown job', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/swm/share-jobs/non-existent/recover', {});
    expect(r.status).toBe(404);
  });

  it('POST /swm/share-jobs/:jobId/recover rejects unsafe path values before queue lookup', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/swm/share-jobs/job%3Ebad/recover', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid promote jobId/);
  });

  // ---------------------------------------------------------------------------
  // POST /api/knowledge-assets/swm/share-jobs/:jobId/clear  (#1837)
  // Atomic terminal record removal — DISTINCT from DELETE (cancel). Idempotent:
  // already_absent is 200, not 404.
  // ---------------------------------------------------------------------------

  it('POST /swm/share-jobs/:jobId/clear clears a terminal job → 200 cleared; repeat → 200 already_absent', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/clearable/swm/share-async', { contextGraphId: 'cg' });
    await del(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}`); // cancel → terminal 'failed'
    expect((await queue.getStatus(enq.body.jobId))?.state).toBe('failed');

    const r = await post(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}/clear`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'cleared' });
    expect(await queue.getStatus(enq.body.jobId)).toBeNull();

    const again = await post(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}/clear`, {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ outcome: 'already_absent' });
  });

  it('POST /swm/share-jobs/:jobId/clear returns 409 for a nonterminal (queued) job, without mutation', async () => {
    await startRoutes(makeAgent());
    const enq = await post('/api/knowledge-assets/queued2/swm/share-async', { contextGraphId: 'cg' });
    const r = await post(`/api/knowledge-assets/swm/share-jobs/${enq.body.jobId}/clear`, {});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await queue.getStatus(enq.body.jobId))?.state).toBe('queued');
  });

  it('POST /swm/share-jobs/:jobId/clear returns 200 already_absent for an unknown job (idempotent)', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/swm/share-jobs/non-existent/clear', {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'already_absent' });
  });

  it('POST /swm/share-jobs/:jobId/clear rejects an unsafe path value before queue lookup (400)', async () => {
    await startRoutes(makeAgent());
    const r = await post('/api/knowledge-assets/swm/share-jobs/job%3Ebad/clear', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid promote jobId/);
  });

  // ---------------------------------------------------------------------------
  // Routing precedence — the list route (`/swm/share-jobs`) must not be
  // claimed by the per-job route (`/swm/share-jobs/:jobId`).
  // ---------------------------------------------------------------------------

  it('GET /swm/share-jobs (no jobId) hits the list route, not the per-job route', async () => {
    await startRoutes(makeAgent());
    await post('/api/knowledge-assets/x/swm/share-async', { contextGraphId: 'cg' });
    const r = await get('/api/knowledge-assets/swm/share-jobs');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.jobs)).toBe(true);
  });
});
