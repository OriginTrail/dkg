// SPDX-License-Identifier: Apache-2.0
/**
 * OT-RFC-73 P9b (AC6, decision D-8): the wire contract of the opt-in paged mode of the two job list routes,
 * `GET /api/knowledge-assets/swm/share-jobs` and `GET /api/publisher/jobs`.
 *
 * Real HTTP servers run the production route handlers over the real queues (in-memory Oxigraph) and the daemon's own
 * top-level error mapping. What is pinned:
 *   - the default (no `cursor`, no `pageSize`) is the complete listing, byte for byte what the queue's `list()` returns;
 *   - the first page, a walk that follows `nextCursor` to `complete` (each job once), and the filters on a walk;
 *   - every request error is `400` with a stable code, a cursor of the other queue included, and an unknown publisher
 *     status is `400` in both modes; store pressure stays `503` and a fault in the stored rows is a `500`, never `400`,
 *     which logs one warn line and answers a fixed message that names no job;
 *   - the read authority gate runs before any page is read;
 *   - `dkg ka share-jobs` and `dkg publisher jobs` walk those routes with --page-size, --cursor and --all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OxigraphStore, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import {
  LIFT_JOB_STATES,
  LiftJobPageError,
  TripleStoreAsyncLiftPublisher,
  TripleStoreAsyncPromoteQueue,
  encodeLiftJobPageCursor,
} from '@origintrail-official/dkg-publisher';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';
import { registerPublisherCommand } from '../src/commands/publisher.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { promoteJobToView } from '../src/daemon/routes/shared-assertion-helpers.js';
import { respondWithDaemonError } from '../src/daemon/http-utils.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { daemonState } from '../src/daemon/state.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CALLER = '0x2222222222222222222222222222222222222222';
const SHARE = '/api/knowledge-assets/swm/share-jobs';
const PUBLISHER = '/api/publisher/jobs';
const JOBS = 25;

type Json = Record<string, any>;
const allowed = { outcome: 'allowed', grantScope: 'caller', source: 'registered-chain', reason: 'chain-participant', metadataBootstrap: 'eligible' };
const denied = { outcome: 'denied', grantScope: 'none', source: 'registered-chain', reason: 'agent-not-in-chain-roster', metadataBootstrap: 'forbidden' };

/** Job `n` of the fixture is enqueued at `1_000 + 1_000 * floor(n / 5)`: five jobs per millisecond, so ties cross every page size used. */
const enqueuedAt = (n: number) => 1_000 + 1_000 * Math.floor(n / 5);
const graphOf = (n: number) => (n % 2 === 0 ? 'cg-1' : 'cg-2');

let server: Server;
let baseUrl: string;
let store: OxigraphStore;
let queue: TripleStoreAsyncPromoteQueue;
let publisher: TripleStoreAsyncLiftPublisher;
let authentication = requestAuthentication({ kind: 'nodeOperator' });
let authority = vi.fn(async (..._args: unknown[]): Promise<Json> => allowed);
let busy = false;
/** Rewrites the bindings of every query the store answers, to put a fault in the rows a page reads. */
let tamper: ((bindings: Array<Record<string, string>>) => Array<Record<string, string>>) | undefined;
let clock = 0;
let shareSeq = 0;
let liftSeq = 0;
const jobId = (prefix: string, seq: number) => `${prefix}-${String(seq).padStart(2, '0')}`;

function agent() {
  return {
    promoteQueue: queue,
    resolveContextGraphReadAuthority: authority,
    canReadContextGraph: async () => true,
    assertion: { listPromoteAsyncJobs: (filter?: Parameters<typeof queue.list>[0]) => queue.list(filter) },
  };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ctx = { req, res, url, path: url.pathname, agent: agent(), publisherControl: publisher, authentication,
      requestAgentAddress: CALLER, config: {}, extractionStatus: new Map() } as unknown as RequestContext;
    try {
      if (url.pathname.startsWith(SHARE)) await handleKnowledgeAssetsRoutes(ctx);
      else await handlePublisherRoutes(ctx);
      if (!res.writableEnded) { res.statusCode = 404; res.end(); }
    } catch (error) {
      respondWithDaemonError(res, error);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

beforeEach(async () => {
  daemonState.promoteWorkerAvailable = true;
  authentication = requestAuthentication({ kind: 'nodeOperator' });
  authority = vi.fn(async () => allowed);
  busy = false;
  tamper = undefined;
  shareSeq = 0;
  liftSeq = 0;
  store = new OxigraphStore();
  const query = store.query.bind(store);
  store.query = (async (...args: Parameters<typeof query>) => {
    if (busy) throw new StoreSchedulerBusyError('queue_full', 'control', 'test.listing');
    const result = await query(...args);
    return tamper && result.type === 'bindings' ? { ...result, bindings: tamper(result.bindings) } : result;
  }) as typeof store.query;
  queue = new TripleStoreAsyncPromoteQueue(store, { now: () => clock, idGenerator: () => jobId('job', ++shareSeq) });
  publisher = new TripleStoreAsyncLiftPublisher(store, { now: () => clock, idGenerator: () => jobId('lj', ++liftSeq) });
  for (let n = 0; n < JOBS; n++) {
    clock = enqueuedAt(n);
    await queue.enqueue({ contextGraphId: graphOf(n), assertionName: `asset-${n}`, entities: 'all' } as never);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: graphOf(n), name: `asset-${n}`, shareOperationId: `op-${n}` }));
  }
  // Four share jobs end up `failed` (cancelled) and three publisher jobs `claimed`, so the state filters have something to tell apart.
  for (const id of ['job-02', 'job-09', 'job-14', 'job-21']) await queue.cancel(id);
  for (const wallet of ['wallet-1', 'wallet-2', 'wallet-3']) await publisher.claimNext(wallet);
});
afterEach(() => { vi.restoreAllMocks(); daemonState.promoteWorkerAvailable = false; });

async function get(path: string): Promise<{ status: number; body: Json; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers };
}

/** Follow `nextCursor` until a page says `complete`; every page is returned. */
async function walk(route: string, query: string, pageSize: number): Promise<Json[]> {
  const pages: Json[] = [];
  let cursor: string | null = null;
  do {
    const page = await get(`${route}?${query}${query ? '&' : ''}pageSize=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(page.status).toBe(200);
    pages.push(page.body);
    cursor = page.body.nextCursor;
    expect(pages.length).toBeLessThan(JOBS + 2);
  } while (cursor);
  return pages;
}
const idsOf = (pages: Json[]) => pages.flatMap(page => page.jobs.map((job: { jobId: string }) => job.jobId));

describe('GET /api/knowledge-assets/swm/share-jobs', () => {
  it('without a paging parameter answers the complete listing, exactly as the queue lists it', async () => {
    const listPage = vi.spyOn(queue, 'listPage');
    const response = await get(SHARE);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body)).toEqual(['jobs']);
    expect(response.body.jobs).toHaveLength(JOBS);
    expect(response.body).toEqual(JSON.parse(JSON.stringify({ jobs: (await queue.list()).map(promoteJobToView) })));
    // `limit` keeps its meaning of capping the complete listing.
    const capped = await get(`${SHARE}?limit=4&state=queued&contextGraphId=cg-1`);
    expect(capped.body).toEqual(JSON.parse(JSON.stringify({ jobs: (await queue.list({ limit: 4, state: ['queued'], contextGraphId: 'cg-1' })).map(promoteJobToView) })));
    expect(Object.keys(capped.body)).toEqual(['jobs']);
    expect(listPage).not.toHaveBeenCalled();
  });

  it('pageSize alone asks for the first page: the oldest jobs, a cursor and complete=false', async () => {
    const response = await get(`${SHARE}?pageSize=10`);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['complete', 'jobs', 'nextCursor']);
    expect(response.body.complete).toBe(false);
    expect(response.body.nextCursor).toMatch(/^v1\./);
    expect(idsOf([response.body])).toEqual(Array.from({ length: 10 }, (_, n) => jobId('job', n + 1)));
    const direct = await queue.listPage({}, { pageSize: 10 });
    expect(response.body).toEqual(JSON.parse(JSON.stringify({ jobs: direct.jobs.map(promoteJobToView), nextCursor: direct.nextCursor, complete: false })));
  });

  it.each([1, 4, 7, 25, 26, 1000])('a walk with pageSize %i lists each job once and ends on complete', async pageSize => {
    const pages = await walk(SHARE, '', pageSize);
    expect(idsOf(pages)).toEqual(Array.from({ length: JOBS }, (_, n) => jobId('job', n + 1)));
    expect(pages).toHaveLength(Math.ceil(JOBS / pageSize));
    expect(pages.slice(0, -1).every(page => page.complete === false && typeof page.nextCursor === 'string')).toBe(true);
    expect(pages.at(-1)).toMatchObject({ complete: true, nextCursor: null });
  });

  it('a cursor without pageSize pages with the default of 100', async () => {
    const first = await get(`${SHARE}?pageSize=10`);
    const rest = await get(`${SHARE}?cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(rest.status).toBe(200);
    expect(rest.body.jobs).toHaveLength(JOBS - 10);
    expect(rest.body).toMatchObject({ complete: true, nextCursor: null });
  });

  it('keeps the state and context graph filters on every page of a walk', async () => {
    expect(idsOf(await walk(SHARE, 'state=failed', 3))).toEqual(['job-02', 'job-09', 'job-14', 'job-21']);
    const scoped = idsOf(await walk(SHARE, 'contextGraphId=cg-2&state=queued', 4));
    expect(scoped).toEqual(Array.from({ length: JOBS }, (_, n) => n).filter(n => graphOf(n) === 'cg-2' && ![1, 8, 13, 20].includes(n)).map(n => jobId('job', n + 1)));
  });

  it('a job admitted behind the walk is not part of it, one ahead of it is, and a later walk sees both (complete is never proof of absence)', async () => {
    const first = await get(`${SHARE}?pageSize=24`);
    expect(first.body.complete).toBe(false);
    shareSeq = 89;
    clock = 1_000;
    await queue.enqueue({ contextGraphId: 'cg-1', assertionName: 'behind', entities: 'all' } as never);
    clock = 9_000;
    await queue.enqueue({ contextGraphId: 'cg-1', assertionName: 'ahead', entities: 'all' } as never);
    const rest = await get(`${SHARE}?pageSize=24&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(rest.body).toMatchObject({ complete: true, nextCursor: null });
    expect(idsOf([first.body, rest.body]).filter(id => id > 'job-24')).toEqual(['job-25', 'job-91']);
    expect(idsOf(await walk(SHARE, '', 24))).toEqual(expect.arrayContaining(['job-90', 'job-91']));
  });

  it.each([
    ['garbage', 'cursor=not-a-cursor'],
    ['an empty cursor', 'cursor='],
    ['a repeated cursor', 'cursor=v1.a&cursor=v1.b'],
    ['a cursor of the right prefix and a bad body', 'cursor=v1.AAAA'],
  ])('answers 400 PROMOTE_LIST_CURSOR_INVALID for %s, without echoing it', async (_name, query) => {
    const response = await get(`${SHARE}?${query}&pageSize=5`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'cursor is not a valid share job cursor', code: 'PROMOTE_LIST_CURSOR_INVALID' });
  });

  it.each(['0', '-1', '1001', '1.5', '1e2', '0x10', '+5', '%205', 'abc', '', '99999999999999999999'])('answers 400 PROMOTE_LIST_PAGE_SIZE_INVALID for pageSize=%s', async size => {
    const response = await get(`${SHARE}?pageSize=${size}`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'pageSize must be an integer from 1 to 1000', code: 'PROMOTE_LIST_PAGE_SIZE_INVALID' });
  });

  it('answers 400 for a repeated cursor even when it is a valid one, and for a repeated pageSize', async () => {
    const cursor = (await get(`${SHARE}?pageSize=5`)).body.nextCursor;
    const repeated = await get(`${SHARE}?cursor=${cursor}&cursor=${cursor}`);
    expect(repeated.status).toBe(400);
    expect(repeated.body.code).toBe('PROMOTE_LIST_CURSOR_INVALID');
    expect((await get(`${SHARE}?pageSize=5&pageSize=5`)).body.code).toBe('PROMOTE_LIST_PAGE_SIZE_INVALID');
  });

  it('answers 400 for a repeated pageSize and for limit sent with a paging parameter', async () => {
    expect((await get(`${SHARE}?pageSize=5&pageSize=6`)).body.code).toBe('PROMOTE_LIST_PAGE_SIZE_INVALID');
    for (const query of ['limit=5&pageSize=5', 'cursor=v1.a&limit=5']) {
      const response = await get(`${SHARE}?${query}`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('LIST_PAGING_LIMIT_CONFLICT');
    }
  });

  it('keeps the existing filter errors in the paged mode', async () => {
    expect((await get(`${SHARE}?state=garbage&pageSize=5`)).status).toBe(400);
    expect((await get(`${SHARE}?limit=abc&pageSize=5`)).body.error).toMatch(/limit must be a positive integer/);
  });

  it('refuses a cursor of the publisher listing', async () => {
    const publisherCursor = (await get(`${PUBLISHER}?pageSize=5`)).body.nextCursor;
    expect(publisherCursor).toEqual(expect.any(String));
    const response = await get(`${SHARE}?cursor=${encodeURIComponent(publisherCursor)}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PROMOTE_LIST_CURSOR_INVALID');
  });

  it('answers 503 while the share worker is unavailable, before any paging parameter is read', async () => {
    daemonState.promoteWorkerAvailable = false;
    const response = await get(`${SHARE}?pageSize=0`);
    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/async-promote worker is not available/i);
  });

  it('keeps the store-busy 503 with its retry hint', async () => {
    busy = true;
    const response = await get(`${SHARE}?pageSize=5`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.body).toMatchObject({ code: 'STORE_SCHEDULER_BUSY', retryable: true, outcome: 'not_started', priority: 'control' });
  });

  it('answers a fault in the stored rows with 500, not 400: one warn line, a fixed message, no job named', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tamper = rows => [...rows].reverse();
    await expect(queue.listPage({}, { pageSize: 5 })).rejects.toThrow(/^Share job listing: the store returned job keys out of order/);
    const response = await get(`${SHARE}?pageSize=5`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: expect.stringMatching(/^The job list cannot be paged: a stored job row is unreadable or out of order/) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[list-paging\] GET \/api\/knowledge-assets\/swm\/share-jobs: .*\(stored_rows\); answering 500$/);
    tamper = undefined;
    expect((await get(SHARE)).status).toBe(200);
  });

  it('keeps the queue\'s own message, which may name a job, out of the 500 body and the warn line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const subject = 'urn:dkg:promote-queue:job:job-07';
    vi.spyOn(queue, 'listPage').mockRejectedValue(new Error(`Share job listing: ${subject} cannot be placed in the page order`));
    const response = await get(`${SHARE}?pageSize=5`);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/job-07|urn:dkg/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/job-07|urn:dkg/);
  });

  it('does not log or rewrite any other fault: an error of another kind keeps the daemon\'s own 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(queue, 'listPage').mockRejectedValue(new Error('boom'));
    const response = await get(`${SHARE}?pageSize=5`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'boom' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers 501 for a queue that cannot page', async () => {
    (queue as { listPage?: unknown }).listPage = undefined;
    const response = await get(`${SHARE}?pageSize=5`);
    expect(response.status).toBe(501);
    expect(response.body.code).toBe('PROMOTE_LIST_PAGING_UNSUPPORTED');
    expect((await get(SHARE)).status).toBe(200);
  });

  it('checks the read authority before it reads a page, as the complete listing does', async () => {
    authentication = requestAuthentication({ kind: 'agent', agentAddress: CALLER });
    const listPage = vi.spyOn(queue, 'listPage');
    expect((await get(`${SHARE}?pageSize=5`)).status).toBe(400);
    authority.mockResolvedValue(denied);
    expect((await get(`${SHARE}?contextGraphId=cg-1&pageSize=5`)).status).toBe(403);
    expect(listPage).not.toHaveBeenCalled();
    authority.mockResolvedValue(allowed);
    const page = await get(`${SHARE}?contextGraphId=cg-1&pageSize=5`);
    expect(page.status).toBe(200);
    expect(authority).toHaveBeenLastCalledWith('cg-1', expect.objectContaining({ callerAgentAddress: CALLER }));
    expect(page.body.jobs).toHaveLength(5);
  });
});

describe('GET /api/publisher/jobs', () => {
  it('without a paging parameter answers the complete listing, exactly as the publisher lists it', async () => {
    const listPage = vi.spyOn(publisher, 'listPage');
    const response = await get(PUBLISHER);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body)).toEqual(['jobs']);
    expect(response.body.jobs).toHaveLength(JOBS);
    expect(response.body).toEqual(JSON.parse(JSON.stringify({ jobs: await publisher.list() })));
    const claimed = await get(`${PUBLISHER}?status=claimed&contextGraphId=cg-1`);
    expect(claimed.body).toEqual(JSON.parse(JSON.stringify({ jobs: await publisher.list({ status: 'claimed', contextGraphId: 'cg-1' }) })));
    // `limit` has never capped this list (the recovery scripts pass it); it still does not.
    expect((await get(`${PUBLISHER}?limit=3`)).body.jobs).toHaveLength(JOBS);
    expect(listPage).not.toHaveBeenCalled();
  });

  it('pageSize alone asks for the first page: the oldest jobs, a cursor and complete=false', async () => {
    const response = await get(`${PUBLISHER}?pageSize=10`);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['complete', 'jobs', 'nextCursor']);
    expect(response.body.complete).toBe(false);
    expect(response.body.nextCursor).toEqual(expect.any(String));
    const direct = await publisher.listPage({ limit: 10 });
    expect(response.body).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(response.body.jobs).toHaveLength(10);
  });

  it.each([1, 4, 7, 25, 26, 1000])('a walk with pageSize %i lists each job once and ends on complete', async pageSize => {
    const pages = await walk(PUBLISHER, '', pageSize);
    const ids = idsOf(pages);
    expect(new Set(ids).size).toBe(JOBS);
    expect(ids).toHaveLength(JOBS);
    expect([...ids].sort()).toEqual((await publisher.list()).map(job => job.jobId).sort());
    expect(pages).toHaveLength(Math.ceil(JOBS / pageSize));
    expect(pages.slice(0, -1).every(page => page.complete === false && typeof page.nextCursor === 'string')).toBe(true);
    expect(pages.at(-1)).toMatchObject({ complete: true, nextCursor: null });
  });

  it('a cursor without pageSize pages with the default of 100', async () => {
    const first = await get(`${PUBLISHER}?pageSize=10`);
    const rest = await get(`${PUBLISHER}?cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(rest.body.jobs).toHaveLength(JOBS - 10);
    expect(rest.body).toMatchObject({ complete: true, nextCursor: null });
  });

  it('keeps the status and context graph filters on every page of a walk', async () => {
    const claimed = idsOf(await walk(PUBLISHER, 'status=claimed', 2));
    expect([...claimed].sort()).toEqual((await publisher.list({ status: 'claimed' })).map(job => job.jobId).sort());
    expect(claimed).toHaveLength(3);
    const scoped = await walk(PUBLISHER, 'contextGraphId=cg-2&status=accepted', 3);
    expect([...idsOf(scoped)].sort()).toEqual((await publisher.list({ status: 'accepted', contextGraphId: 'cg-2' })).map(job => job.jobId).sort());
  });

  it('a job accepted behind the walk is not part of it, one ahead of it is, and a later walk sees both (complete is never proof of absence)', async () => {
    const first = await get(`${PUBLISHER}?pageSize=24`);
    expect(first.body.complete).toBe(false);
    liftSeq = 89;
    clock = 1_000;
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: 'cg-1', name: 'behind', shareOperationId: 'op-behind' }));
    clock = 9_000;
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ contextGraphId: 'cg-1', name: 'ahead', shareOperationId: 'op-ahead' }));
    const rest = await get(`${PUBLISHER}?pageSize=24&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(rest.body).toMatchObject({ complete: true, nextCursor: null });
    expect(idsOf([first.body, rest.body]).filter(id => id > 'lj-24')).toEqual(['lj-25', 'lj-91']);
    expect(idsOf(await walk(PUBLISHER, '', 24))).toEqual(expect.arrayContaining(['lj-90', 'lj-91']));
  });

  it.each([
    ['garbage', 'cursor=not-a-cursor'],
    ['an empty cursor', 'cursor='],
    ['a repeated cursor', 'cursor=a&cursor=b'],
    ['a decodable body that is not a cursor', `cursor=${Buffer.from('{"v":1}').toString('base64url')}`],
  ])('answers 400 PUBLISHER_LIST_CURSOR_INVALID for %s, without echoing it', async (_name, query) => {
    const response = await get(`${PUBLISHER}?${query}&pageSize=5`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'cursor is not a valid publisher job cursor', code: 'PUBLISHER_LIST_CURSOR_INVALID' });
  });

  it.each(['0', '-1', '1001', '1.5', '1e2', '0x10', '+5', '%205', 'abc', '', '99999999999999999999'])('answers 400 PUBLISHER_LIST_PAGE_SIZE_INVALID for pageSize=%s', async size => {
    const response = await get(`${PUBLISHER}?pageSize=${size}`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'pageSize must be an integer from 1 to 1000', code: 'PUBLISHER_LIST_PAGE_SIZE_INVALID' });
  });

  it('answers 400 for a repeated cursor even when it is a valid one, and for a repeated pageSize', async () => {
    const cursor = (await get(`${PUBLISHER}?pageSize=5`)).body.nextCursor;
    const repeated = await get(`${PUBLISHER}?cursor=${cursor}&cursor=${cursor}`);
    expect(repeated.status).toBe(400);
    expect(repeated.body.code).toBe('PUBLISHER_LIST_CURSOR_INVALID');
    expect((await get(`${PUBLISHER}?pageSize=5&pageSize=5`)).body.code).toBe('PUBLISHER_LIST_PAGE_SIZE_INVALID');
  });

  it('answers 400 for a repeated pageSize and for limit sent with a paging parameter', async () => {
    expect((await get(`${PUBLISHER}?pageSize=5&pageSize=6`)).body.code).toBe('PUBLISHER_LIST_PAGE_SIZE_INVALID');
    for (const query of ['limit=5&pageSize=5', 'cursor=abc&limit=5']) {
      const response = await get(`${PUBLISHER}?${query}`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('LIST_PAGING_LIMIT_CONFLICT');
    }
  });

  it('refuses a cursor of the share listing', async () => {
    const shareCursor = (await get(`${SHARE}?pageSize=5`)).body.nextCursor;
    expect(shareCursor).toMatch(/^v1\./);
    const response = await get(`${PUBLISHER}?cursor=${encodeURIComponent(shareCursor)}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PUBLISHER_LIST_CURSOR_INVALID');
  });

  it('refuses a well-formed cursor that names another queue', async () => {
    const response = await get(`${PUBLISHER}?cursor=${Buffer.from('{"v":1,"q":"promote","t":5,"j":"x"}').toString('base64url')}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('PUBLISHER_LIST_CURSOR_INVALID');
  });

  it('accepts every publisher status and answers 400 PUBLISHER_LIST_STATUS_INVALID for any other, in both modes', async () => {
    for (const status of LIFT_JOB_STATES) {
      expect((await get(`${PUBLISHER}?status=${status}`)).status).toBe(200);
      expect((await get(`${PUBLISHER}?status=${status}&pageSize=5`)).status).toBe(200);
    }
    for (const query of ['status=bogus', 'status=Claimed', 'status=claimed,failed', 'status=bogus&pageSize=5', 'status=%27%20OR%201%3D1']) {
      const response = await get(`${PUBLISHER}?${query}`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: `Invalid status filter. Allowed: ${LIFT_JOB_STATES.join(',')}`, code: 'PUBLISHER_LIST_STATUS_INVALID' });
    }
    // An empty status is no filter, as it always was.
    expect((await get(`${PUBLISHER}?status=`)).body.jobs).toHaveLength(JOBS);
  });

  it('keeps the store-busy 503 with its retry hint', async () => {
    busy = true;
    const response = await get(`${PUBLISHER}?pageSize=5`);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.body).toMatchObject({ code: 'STORE_SCHEDULER_BUSY', retryable: true, outcome: 'not_started' });
  });

  it.each(['unreadable_row', 'unordered_page'] as const)('answers %s, a fault in the stored rows, with 500 and not 400: one warn line, a fixed message', async code => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(publisher, 'listPage').mockRejectedValue(new LiftJobPageError(code, 'the stored rows cannot be paged'));
    const response = await get(`${PUBLISHER}?pageSize=5`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: expect.stringMatching(/^The job list cannot be paged: a stored job row is unreadable or out of order/) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(new RegExp(`^\\[list-paging\\] GET /api/publisher/jobs: .*\\(${code}\\); answering 500$`));
  });

  it.each([
    ['unreadable_row', (rows: Array<Record<string, string>>) => rows.map((row, i) => (i === 0 ? { ...row, acceptedAt: '"soon"' } : row))],
    ['unordered_page', (rows: Array<Record<string, string>>) => [...rows].reverse()],
  ] as const)('keeps the job a real %s names out of the 500 body and the warn line', async (code, fault) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    tamper = fault;
    // The queue's own error does name a job (its subject or its id), which is why the route must not pass its message on.
    await expect(publisher.listPage({ limit: 5 })).rejects.toThrow(/lj-\d\d/);
    await expect(publisher.listPage({ limit: 5 })).rejects.toMatchObject({ name: 'LiftJobPageError', code });
    const response = await get(`${PUBLISHER}?pageSize=5`);
    expect(response.status).toBe(500);
    expect(response.body.code).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toMatch(/lj-\d\d|urn:dkg/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`(${code})`);
    expect(String(warn.mock.calls[0]![0])).not.toMatch(/lj-\d\d|urn:dkg/);
    tamper = undefined;
    expect((await get(PUBLISHER)).status).toBe(200);
  });

  it('checks the read authority before it reads a page, as the complete listing does', async () => {
    authentication = requestAuthentication({ kind: 'agent', agentAddress: CALLER });
    const listPage = vi.spyOn(publisher, 'listPage');
    expect((await get(`${PUBLISHER}?pageSize=5`)).status).toBe(400);
    authority.mockResolvedValue(denied);
    expect((await get(`${PUBLISHER}?contextGraphId=cg-1&pageSize=5`)).status).toBe(403);
    expect(listPage).not.toHaveBeenCalled();
    authority.mockResolvedValue(allowed);
    const page = await get(`${PUBLISHER}?contextGraphId=cg-1&pageSize=5`);
    expect(page.status).toBe(200);
    expect(authority).toHaveBeenLastCalledWith('cg-1', expect.objectContaining({ callerAgentAddress: CALLER }));
    expect(page.body.jobs).toHaveLength(5);
    expect(listPage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ contextGraphId: 'cg-1', limit: 5 }));
  });

  it('a cursor encoded by the publisher codec for the same position pages from it', async () => {
    const ids = (await publisher.list()).map(job => job.jobId);
    const anchor = (await publisher.list()).find(job => job.jobId === ids[0])!;
    const cursor = encodeLiftJobPageCursor({ acceptedAt: anchor.timestamps.acceptedAt, jobId: anchor.jobId });
    const page = await get(`${PUBLISHER}?pageSize=100&cursor=${encodeURIComponent(cursor)}`);
    expect(page.status).toBe(200);
    expect(page.body.jobs.map((job: { jobId: string }) => job.jobId)).not.toContain(anchor.jobId);
    expect(page.body.jobs).toHaveLength(JOBS - 1);
  });
});

describe('the list commands through the daemon routes', () => {
  const printed: string[] = [];
  const errors: string[] = [];

  async function run(command: 'ka' | 'publisher', ...args: string[]): Promise<string> {
    const program = new Command().name('dkg').exitOverride();
    registerKnowledgeAssetCommand(program);
    registerPublisherCommand(program);
    printed.length = 0;
    await program.parseAsync(['node', 'dkg', command, ...args]);
    return printed.join('\n');
  }

  beforeEach(() => {
    errors.length = 0;
    vi.spyOn(ApiClient, 'connect').mockImplementation(async () => new ApiClient(Number(new URL(baseUrl).port), 'token'));
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit:1'); }) as typeof process.exit);
  });

  it('ka share-jobs --all lists every job once, a page at a time', async () => {
    const listPage = vi.spyOn(queue, 'listPage');
    const output = JSON.parse(await run('ka', 'share-jobs', '--all', '--page-size', '7', '--json'));
    expect(Object.keys(output)).toEqual(['jobs']);
    expect(output.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(Array.from({ length: JOBS }, (_, n) => jobId('job', n + 1)));
    expect(listPage).toHaveBeenCalledTimes(Math.ceil(JOBS / 7));
  });

  it('ka share-jobs --page-size then --cursor walks the list by hand', async () => {
    const first = (await run('ka', 'share-jobs', '--page-size', '20')).split('\n');
    expect(first).toHaveLength(21);
    expect(first[0]).toMatch(/^job-01\tqueued\t/);
    const cursor = first[20]!.replace('Next cursor: ', '');
    expect(cursor).toMatch(/^v1\./);
    const rest = (await run('ka', 'share-jobs', '--cursor', cursor)).split('\n');
    expect(rest.map(line => line.split('\t')[0])).toEqual([...Array.from({ length: 5 }, (_, n) => jobId('job', n + 21)), 'No further jobs when this page was read.']);
  });

  it('ka share-jobs reports the daemon error for a cursor it did not issue', async () => {
    await expect(run('ka', 'share-jobs', '--cursor', 'nope')).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('cursor is not a valid share job cursor');
  });

  it('publisher jobs --all prints every job once as the bare array the command always printed', async () => {
    const listPage = vi.spyOn(publisher, 'listPage');
    const jobs = JSON.parse(await run('publisher', 'jobs', '--all', '--page-size', '6'));
    expect(jobs.map((job: { jobId: string }) => job.jobId).sort()).toEqual((await publisher.list()).map(job => job.jobId).sort());
    expect(jobs).toHaveLength(JOBS);
    expect(listPage).toHaveBeenCalledTimes(Math.ceil(JOBS / 6));
  });

  it('publisher jobs --page-size then --cursor walks the list by hand, with the filter', async () => {
    const first = JSON.parse(await run('publisher', 'jobs', '--status', 'accepted', '--page-size', '5'));
    expect(first).toMatchObject({ complete: false, nextCursor: expect.any(String) });
    expect(first.jobs).toHaveLength(5);
    const rest = JSON.parse(await run('publisher', 'jobs', '--status', 'accepted', '--cursor', first.nextCursor, '--page-size', '100'));
    expect(rest).toMatchObject({ complete: true, nextCursor: null });
    expect(first.jobs.length + rest.jobs.length).toBe(JOBS - 3);
  });

  it('publisher jobs reports the daemon error for a cursor it did not issue', async () => {
    await expect(run('publisher', 'jobs', '--cursor', 'nope')).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('cursor is not a valid publisher job cursor');
  });
});
