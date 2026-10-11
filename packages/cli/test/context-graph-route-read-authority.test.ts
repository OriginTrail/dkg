// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { contextGraphAssertionUri } from '@origintrail-official/dkg-core';
import { handleCclRoutes } from '../src/daemon/routes/ccl.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import { handleEpcisRoutes } from '../src/daemon/routes/epcis.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import { daemonState } from '../src/daemon/state.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = 'private-target';
const CALLER = '0x2222222222222222222222222222222222222222';
const SECRET = 'private row';
type Route = { name: string; path: string; method?: string; body?: object; run: (ctx: RequestContext) => Promise<unknown> };
const routes: Route[] = [
  { name: 'CCL results', path: `/api/ccl/results?contextGraphId=${CG}`, run: handleCclRoutes },
  { name: 'CCL evaluation', path: '/api/ccl/eval', method: 'POST', body: { contextGraphId: CG, name: 'policy' }, run: handleCclRoutes },
  { name: 'KA lifecycle', path: `/api/knowledge-assets/asset?contextGraphId=${CG}`, run: handleKnowledgeAssetsRoutes },
  { name: 'WM quads', path: `/api/knowledge-assets/asset/wm/quads?contextGraphId=${CG}`, run: handleKnowledgeAssetsRoutes },
  { name: 'share job list', path: `/api/knowledge-assets/swm/share-jobs?contextGraphId=${CG}`, run: handleKnowledgeAssetsRoutes },
  { name: 'subgraph inventory', path: `/api/sub-graph/list?contextGraphId=${CG}`, run: handleContextGraphRoutes },
  { name: 'participant roster', path: `/api/context-graph/${CG}/participants`, run: handleContextGraphRoutes },
  { name: 'publisher intent', path: `/api/publisher/job-by-intent?contextGraphId=${CG}&name=asset`, run: handlePublisherRoutes },
  { name: 'publisher journal by intent', path: `/api/publisher/journal?contextGraphId=${CG}&name=asset`, run: handlePublisherRoutes },
  { name: 'publisher journal by job', path: '/api/publisher/journal?jobId=job', run: handlePublisherRoutes },
  { name: 'EPCIS events', path: `/api/epcis/events?contextGraphId=${CG}`, run: handleEpcisRoutes },
  { name: 'GenUI triples', path: '/api/genui/render', method: 'POST', body: { contextGraphId: CG, entityUri: 'urn:entity', libraryPrompt: 'library' }, run: handleQueryRoutes },
  { name: 'CCL policy inventory', path: `/api/ccl/policy/list?contextGraphId=${CG}`, run: handleCclRoutes },
  { name: 'CCL policy body', path: `/api/ccl/policy/resolve?contextGraphId=${CG}&name=policy&includeBody=true`, run: handleCclRoutes },
  { name: 'share job status', path: '/api/knowledge-assets/swm/share-jobs/job', run: handleKnowledgeAssetsRoutes },
  { name: 'publisher job', path: '/api/publisher/job?id=job', run: handlePublisherRoutes },
  { name: 'publisher payload', path: '/api/publisher/job-payload?id=job', run: handlePublisherRoutes },
  { name: 'publisher legacy job', path: '/api/publisher/jobs/job', run: handlePublisherRoutes },
  { name: 'publisher legacy payload', path: '/api/publisher/jobs/job/payload', run: handlePublisherRoutes },
  { name: 'publisher scoped inventory', path: `/api/publisher/jobs?contextGraphId=${CG}`, run: handlePublisherRoutes },
];
const previousWorker = daemonState.promoteWorkerAvailable;
afterEach(() => { daemonState.promoteWorkerAvailable = previousWorker; });

function fixture(route: Route, outcome: 'allowed' | 'denied' | 'unavailable', operator = false, reason = 'chain-participant') {
  daemonState.promoteWorkerAvailable = true;
  const req = Object.assign(new EventEmitter(), { method: route.method ?? 'GET', url: route.path,
    headers: {}, aborted: false, __dkgPrebufferedBody: Buffer.from(JSON.stringify(route.body ?? {})) });
  const res = Object.assign(new EventEmitter(), { statusCode: 0, body: '', headers: {} as Record<string, unknown>,
    destroyed: false, writableEnded: false,
    writeHead(status: number, headers?: Record<string, unknown>) { this.statusCode = status; Object.assign(this.headers, headers); },
    setHeader(key: string, value: unknown) { this.headers[key] = value; },
    end(body = '') { this.body = body; this.writableEnded = true; },
  });
  const read = vi.fn(async () => [{ secret: SECRET }]);
  const query = vi.fn(async () => ({ bindings: [] }));
  const authority = vi.fn(async () => ({ outcome, source: 'registered-chain', reason, grantScope: reason === 'legacy-subscription' ? 'node' : 'caller',
    ...(outcome === 'unavailable' ? { dependency: 'chain' } : {}) }));
  const job = { jobId: 'job', request: { jobType: 'knowledge-asset-vm-publish',
    knowledgeAssetVmPublish: { contextGraphId: CG }, contextGraphId: CG }, contextGraphId: CG };
  const agent = { resolveContextGraphReadAuthority: authority,
    listCclEvaluations: read, evaluateCclPolicy: read, listCclPolicies: read, resolveCclPolicy: read,
    assertion: { history: read, query: read, listPromoteAsyncJobs: vi.fn(async () => []), getPromoteAsyncStatus: vi.fn(async () => job) },
    listSubGraphs: vi.fn(async () => []), getContextGraphAllowedAgents: read, query,
    canReadContextGraph: vi.fn(async () => outcome === 'allowed'),
  };
  const publisherControl = { describeConfiguredRetryState: () => ({ autoRetryEligible: false }), lookupKnowledgeAssetVmPublishJobByIntent: read,
    readJournalContextGraphIdByJob: vi.fn(async () => null), readJournalByIntent: read, readJournalByJob: read, inspectPreparedPayload: read, list: vi.fn(async () => [job]), getStatus: vi.fn(async () => job) };
  const url = new URL(route.path, 'http://localhost');
  const ctx = { req, res, agent, publisherControl, publisherState: { runtime: null, availability: { available: false, reason: 'publisher_disabled', retryable: false, operatorActionRequired: true } }, config: { llm: { apiKey: 'fixture' } },
    path: url.pathname, url, requestAgentAddress: CALLER,
    authentication: requestAuthentication(operator ? { kind: 'nodeOperator' } : { kind: 'agent', agentAddress: CALLER }),
    extractionStatus: new Map(), tracker: {}, emitMemoryGraphChanged: vi.fn(),
  } as unknown as RequestContext;
  return { ctx, res, read, query, authority, agent, publisherControl };
}

describe('caller-bound graph reads', () => {
  it.each(routes)('$name refuses the caller before content lookup', async route => {
    const h = fixture(route, 'denied');
    await route.run(h.ctx);
    expect(h.res.statusCode).toBe(403);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.agent.assertion.listPromoteAsyncJobs).not.toHaveBeenCalled();
    expect(h.agent.listSubGraphs).not.toHaveBeenCalled();
    expect(h.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ callerAgentAddress: CALLER }));
    expect(h.res.body).not.toContain(SECRET);
  });
  it.each(routes)('$name reports unavailable authority with no content lookup', async route => {
    const h = fixture(route, 'unavailable');
    await route.run(h.ctx);
    expect(h.res.statusCode).toBe(503);
    expect(JSON.parse(h.res.body)).toMatchObject({ code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE', retryable: true });
    expect(h.res.headers['Retry-After']).toBe('3');
    expect(h.read).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.res.body).not.toContain(CG);
  });
  it.each(routes.slice(0, 10))('$name preserves node-operator access', async route => {
    const h = fixture(route, 'denied', true);
    await route.run(h.ctx);
    expect(h.res.statusCode).toBe(200);
    expect(h.authority).not.toHaveBeenCalled();
  });
  it.each(routes)('$name refuses node membership inherited by a bearer agent', async route => {
    const h = fixture(route, 'allowed', false, 'legacy-subscription');
    await route.run(h.ctx);
    expect(h.res.statusCode).toBe(403);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each([routes[10], routes[11]])('$name passes the bearer caller to its scoped query', async route => {
    const h = fixture(route, 'allowed');
    await route.run(h.ctx);
    expect(h.query).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ callerAgentAddress: CALLER }));
    expect(h.res.statusCode).toBe(route === routes[10] ? 200 : 404);
  });
  it('uses the persisted job CG even if the query names a different graph', async () => {
    const route = { ...routes[9], path: '/api/publisher/journal?jobId=job&contextGraphId=allowed-other' };
    const h = fixture(route, 'denied');
    await route.run(h.ctx);
    expect(h.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ callerAgentAddress: CALLER }));
    expect(h.publisherControl.readJournalByJob).not.toHaveBeenCalled();
  });
  it.each([
    { path: '/api/publisher/jobs', run: handlePublisherRoutes },
    { path: '/api/ccl/policy/list', run: handleCclRoutes },
    { path: '/api/knowledge-assets/swm/share-jobs', run: handleKnowledgeAssetsRoutes },
  ])('requires a CG for bearer-agent inventory at $path', async row => {
    const h = fixture({ ...row, name: row.path }, 'allowed');
    await row.run(h.ctx);
    expect(h.res.statusCode).toBe(400);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.publisherControl.list).not.toHaveBeenCalled();
    expect(h.agent.assertion.listPromoteAsyncJobs).not.toHaveBeenCalled();
  });
  it('does not read content after a requester disconnect during authority resolution', async () => {
    const h = fixture(routes[0], 'allowed');
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    h.authority.mockImplementation(async () => { await pending; return { outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant', grantScope: 'caller' };  });
    const handling = routes[0].run(h.ctx);
    h.ctx.req.emit('aborted');
    complete();
    await handling;
    expect(h.read).not.toHaveBeenCalled();
    expect(h.ctx.req.listenerCount('aborted')).toBe(0);
    expect(h.ctx.res.listenerCount('close')).toBe(0);
  });

  it('authorizes the same normalized CG used to filter publisher inventory', async () => {
    const route = { name: 'publisher CG alias', path: `/api/publisher/jobs?contextGraphId=did:dkg:context-graph:${CG}`, run: handlePublisherRoutes };
    const h = fixture(route, 'denied');
    await route.run(h.ctx);
    expect(h.authority).toHaveBeenCalledWith(CG, expect.objectContaining({ callerAgentAddress: CALLER }));
    expect(h.res.statusCode).toBe(403);
    expect(h.publisherControl.list).not.toHaveBeenCalled();
  });

  it('returns only the authorized CG from a mixed publisher inventory', async () => {
    const route = { name: 'mixed inventory', path: `/api/publisher/jobs?contextGraphId=${CG}`, run: handlePublisherRoutes };
    const h = fixture(route, 'allowed');
    const [ownJob] = await h.publisherControl.list();
    h.publisherControl.list.mockClear();
    h.publisherControl.list.mockResolvedValue([
      ownJob,
      { ...ownJob, jobId: 'other', request: { ...ownJob.request, knowledgeAssetVmPublish: { contextGraphId: 'another-private-cg' } } },
      { ...ownJob, jobId: 'legacy', request: { jobType: 'lift', lift: {} } } as unknown as typeof ownJob,
    ]);
    await route.run(h.ctx);
    expect(h.res.statusCode).toBe(200);
    expect(JSON.parse(h.res.body).jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['job']);
  });
  it('keeps a publisher job with no provable CG identity operator-only', async () => {
    const route = { name: 'raw journal', path: '/api/publisher/journal?jobId=legacy', run: handlePublisherRoutes };
    const h = fixture(route, 'allowed');
    h.publisherControl.getStatus.mockResolvedValue({ jobId: 'legacy', request: { jobType: 'lift', lift: {} } } as never);
    await route.run(h.ctx);
    expect(h.res.statusCode).toBe(403);
    expect(h.publisherControl.readJournalByJob).not.toHaveBeenCalled();
    const operator = fixture(route, 'denied', true);
    await route.run(operator.ctx);
    expect(operator.res.statusCode).toBe(200);
    expect(operator.publisherControl.readJournalByJob).toHaveBeenCalledWith('legacy');
    expect(operator.publisherControl.getStatus).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'publisher inventory', path: '/api/publisher/jobs', run: handlePublisherRoutes },
    { name: 'CCL inventory', path: '/api/ccl/policy/list', run: handleCclRoutes },
    { name: 'share inventory', path: '/api/knowledge-assets/swm/share-jobs', run: handleKnowledgeAssetsRoutes },
    { name: 'raw job', path: '/api/publisher/job?id=legacy', run: handlePublisherRoutes },
    { name: 'raw payload', path: '/api/publisher/job-payload?id=legacy', run: handlePublisherRoutes },
    { name: 'raw journal', path: '/api/publisher/journal?jobId=legacy', run: handlePublisherRoutes },
  ])('$name preserves tokenless auth-disabled operator access', async route => {
    const h = fixture(route, 'denied');
    Object.assign(h.ctx, { authentication: requestAuthentication({ kind: 'anonymous', mode: 'disabled' }) });
    h.publisherControl.getStatus.mockResolvedValue({ jobId: 'legacy', request: { jobType: 'lift', lift: {} } } as never);
    await route.run(h.ctx);
    expect(h.res.statusCode).toBe(200);
    expect(h.authority).not.toHaveBeenCalled();
  });

  it('keeps an accepted agent credential scoped when authentication is disabled', async () => {
    const h = fixture(routes[0], 'denied');
    Object.assign(h.ctx, { authentication: requestAuthentication({ kind: 'agent', agentAddress: CALLER, mode: 'disabled' }) });
    await routes[0].run(h.ctx);
    expect(h.res.statusCode).toBe(403);
    expect(h.authority).toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each(['allowed', 'denied', 'unavailable'] as const)(
    'extraction status uses one normalized subgraph scope for %s authority', async outcome => {
      const route = { name: 'extraction status', path: `/api/knowledge-assets/asset/wm/extraction-status?contextGraphId=did:dkg:context-graph:${CG}&subGraphName=docs&agentAddress=0x3333333333333333333333333333333333333333`, run: handleKnowledgeAssetsRoutes };
      const h = fixture(route, outcome);
      const assertionUri = contextGraphAssertionUri(CG, CALLER, 'asset', 'docs');
      h.ctx.extractionStatus.set(assertionUri, {
        status: 'completed', fileHash: 'secret-file-hash', rootEntity: 'urn:private:entity',
        detectedContentType: 'application/pdf', pipelineUsed: 'test', tripleCount: 1, startedAt: new Date().toISOString(),
      });
      await route.run(h.ctx);
      expect(h.authority).toHaveBeenCalledExactlyOnceWith(CG, expect.objectContaining({ callerAgentAddress: CALLER }));
      expect(h.res.statusCode).toBe(outcome === 'allowed' ? 200 : outcome === 'denied' ? 403 : 503);
      if (outcome === 'allowed') expect(JSON.parse(h.res.body)).toMatchObject({ assertionUri, fileHash: 'secret-file-hash', rootEntity: 'urn:private:entity' });
      else {
        expect(h.res.body).not.toContain('secret-file-hash');
        expect(h.res.body).not.toContain('urn:private:entity');
      }
    },
  );

  it('propagates unrelated authority failures while removing the request listeners', async () => {
    const h = fixture(routes[0], 'allowed');
    const error = new Error('unrelated programming failure');
    h.authority.mockRejectedValue(error);
    await expect(routes[0].run(h.ctx)).rejects.toBe(error);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.ctx.req.listenerCount('aborted')).toBe(0);
    expect(h.ctx.res.listenerCount('close')).toBe(0);
  });

});
