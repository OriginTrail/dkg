import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { PromoteAdmissionError, TripleStoreAsyncPromoteQueue } from '@origintrail-official/dkg-publisher';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { handleKaShareAsyncEnqueue } from '../src/daemon/routes/knowledge-assets-async-share.js';
import { respondAssertionError } from '../src/daemon/routes/knowledge-assets-error-mapping.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { withDurableShareOwner } from './_helpers/durable-share-owner.js';
import { daemonState } from '../src/daemon/state.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { daemonState.promoteWorkerAvailable = false; vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(s => s.close())); });
function context(promoteAsync: (...args: any[]) => Promise<unknown>) {
  daemonState.promoteWorkerAvailable = true;
  const record = { status: 0, body: '', headers: {} as Record<string, string> };
  const url = new URL('http://localhost/api/knowledge-assets/asset/swm/share-async');
  const ctx = {
    req: { method: 'POST', __dkgPrebufferedBody: Buffer.from(JSON.stringify({ contextGraphId: 'admission-cg' })) },
    res: { writeHead(status: number, headers: Record<string, string>) { record.status = status; Object.assign(record.headers, headers); },
      end(body: string) { record.body = body; } },
    url, path: url.pathname, authentication: requestAuthentication({ kind: 'nodeOperator' }),
    agent: {
      probeContextGraphWritePreflight: vi.fn(async () => ({ storeAvailable: true, exists: true,
        hasLocalContent: true, declarationFound: true, accessPolicy: 'public', callerAuthorized: true })),
      assertion: { promoteAsync },
    },
  } as unknown as RequestContext;
  return { ctx, record };
}

describe('async share admission HTTP evidence', () => {
  it.each(['live', 'standalone'])('keeps a nested not_started out of the %s response after persistence starts', async route => {
    const cause = new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'private.operation.name');
    const { ctx, record } = context(async () => { throw new PromoteAdmissionError({ phase: 'persist', admissionOutcome: 'indeterminate', jobId: 'original-job' }, cause); });
    if (route === 'live') await handleKnowledgeAssetsRoutes(ctx);
    else await handleKaShareAsyncEnqueue(ctx, 'asset');
    expect(record.status).toBe(503);
    expect(record.headers['Retry-After']).toBe('1');
    expect(JSON.parse(record.body)).toMatchObject({ admissionScope: 'async_promote_job', admissionOutcome: 'indeterminate',
      phase: 'persist', jobId: 'original-job', statusPath: '/api/knowledge-assets/swm/share-jobs/original-job' });
    expect(JSON.parse(record.body)).not.toHaveProperty('outcome');
    expect(record.body).not.toContain('private.operation.name');
    expect(record.body).not.toContain('not_started');
  });

  it('reports proven non-admission without inventing an ID or claiming the whole HTTP operation never started', () => {
    const { ctx, record } = context(async () => undefined);
    respondAssertionError(ctx.res, new PromoteAdmissionError({ phase: 'conflict', admissionOutcome: 'not_admitted' }));
    expect(JSON.parse(record.body)).toMatchObject({ admissionScope: 'async_promote_job', admissionOutcome: 'not_admitted' });
    expect(JSON.parse(record.body)).not.toHaveProperty('jobId');
    expect(JSON.parse(record.body)).not.toHaveProperty('outcome');
  });

  it('returns one real native job ID after the caller discards the first delivered response', async () => {
    const store = new OxigraphStore(); stores.push(store);
    const queue = new TripleStoreAsyncPromoteQueue(store, { graphUri: 'urn:test:route-admission' });
    const promote = async (contextGraphId: string, assertionName: string) => ({
      jobId: await queue.enqueue({ contextGraphId, assertionName, entities: 'all' }),
    });
    const first = context(promote);
    await handleKnowledgeAssetsRoutes(first.ctx); // caller loses this response
    expect(first.record.status).toBe(200);
    const id = (await queue.list())[0]!.jobId;
    const query = vi.spyOn(store, 'query');
    const replay = context(promote);
    await handleKnowledgeAssetsRoutes(replay.ctx);
    expect(replay.record.status).toBe(409);
    expect(JSON.parse(replay.record.body)).toMatchObject({ existingJobId: id, observedAdmission: true });
    expect(replay.ctx.agent.probeContextGraphWritePreflight).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(await queue.list()).toHaveLength(1);
  });
});

it.each([false, true])('one-shot sharing preserves uncertainty and stops before optional publishing (%s)', async publish => {
  const { ctx, record } = context(async () => undefined);
  const promote = vi.fn(async () => ({ promotedCount: 1 }));
  Object.assign(ctx.agent.assertion, {
    history: async () => null, create: async () => 'urn:test:asset', write: async () => undefined,
    finalize: async () => ({ merkleRoot: new Uint8Array(32), authorAddress: 'test-author' }), promote,
  });
  withDurableShareOwner(ctx.agent, stores);
  vi.spyOn(ctx.agent.assertion, 'admitDurableShare').mockRejectedValue(
    new PromoteAdmissionError({ phase: 'persist', admissionOutcome: 'indeterminate', jobId: 'original-uncertain-job' }));
  const publishFromFinalizedAssertion = vi.fn();
  Object.assign(ctx.agent, { publishFromFinalizedAssertion });
  Object.assign(ctx, { path: '/api/knowledge-assets', url: new URL('http://localhost/api/knowledge-assets') });
  Object.assign(ctx.req, { __dkgPrebufferedBody: Buffer.from(JSON.stringify({
    contextGraphId: 'admission-cg', name: 'asset', alsoShareSwm: true, alsoPublishVm: publish,
    quads: [{ subject: 'urn:asset', predicate: 'urn:label', object: '"payload"' }],
  })) });
  await handleKnowledgeAssetsRoutes(ctx);
  expect(record.status).toBe(503);
  expect(JSON.parse(record.body)).toMatchObject({ created: true, partial: true, admissionOutcome: 'indeterminate',
    jobId: 'original-uncertain-job', statusPath: '/api/knowledge-assets/swm/share-jobs/original-uncertain-job',
    recovery: expect.stringContaining('Observe this job ID') });
  expect(publishFromFinalizedAssertion).not.toHaveBeenCalled();
  expect(promote).not.toHaveBeenCalled();
});
