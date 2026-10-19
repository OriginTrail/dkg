import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ApiClient } from '../src/api-client.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const caller = '0x2222222222222222222222222222222222222222';
const input = { contextGraphId: 'private-cg', assertionName: 'asset', agentAddress: caller,
  authorAddress: caller, entities: 'all' as const, kaUal: `did:dkg:evm:31337/${caller}/7`,
  assertionVersion: '2', merkleRoot: `0x${'aa'.repeat(32)}` };
const result = { outcome: 'unproven', reason: 'absent_or_pruned', mutationRetryAllowed: false,
  inventory: { scope: 'retained_context_jobs', complete: true, limit: 1000 } };
const allowed = { outcome: 'allowed', grantScope: 'caller', source: 'registered-chain',
  reason: 'chain-participant', metadataBootstrap: 'eligible' };
function fixture() {
  const url = new URL(`http://localhost/api/knowledge-assets/swm/share-jobs/reconcile?${new URLSearchParams(input)}`);
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, aborted: false });
  const res = Object.assign(new EventEmitter(), { statusCode: 0, body: '', writableEnded: false, destroyed: false,
    writeHead(status: number) { this.statusCode = status; }, setHeader: vi.fn(),
    end(body = '') { this.body = body; this.writableEnded = true; },
  });
  const reconcileShare = vi.fn(async () => result);
  const authority = vi.fn(async () => allowed);
  const ctx = { req, res, url, path: url.pathname, requestAgentAddress: caller,
    authentication: requestAuthentication({ kind: 'agent', agentAddress: caller }),
    agent: { resolveContextGraphReadAuthority: authority, assertion: { reconcileShare } },
  } as unknown as RequestContext;
  return { ctx, res, reconcileShare, authority };
}
afterEach(() => vi.unstubAllGlobals());
describe('exact share reconciliation HTTP and SDK', () => {
  it('dispatches the read before the job-ID route and preserves the conservative result', async () => {
    const h = fixture();
    await handleKnowledgeAssetsRoutes(h.ctx);
    expect(h.res.statusCode).toBe(200);
    expect(JSON.parse(h.res.body)).toEqual(result);
    expect(h.reconcileShare).toHaveBeenCalledExactlyOnceWith(input);
    expect(h.authority).toHaveBeenCalledWith(input.contextGraphId, expect.objectContaining({ callerAgentAddress: caller }));
  });
  it.each(['disabled', 'public'] as const)('rejects anonymous %s access even with a claimed agent address', async mode => {
    const h = fixture();
    h.ctx.authentication = requestAuthentication({ kind: 'anonymous', mode });
    await handleKnowledgeAssetsRoutes(h.ctx);
    expect(h.res.statusCode).toBe(403);
    expect(h.authority).not.toHaveBeenCalled();
    expect(h.reconcileShare).not.toHaveBeenCalled();
  });
  it('rejects a token agent selecting another lane before accessing records', async () => {
    const h = fixture();
    h.ctx.url.searchParams.set('agentAddress', '0x3333333333333333333333333333333333333333');
    await handleKnowledgeAssetsRoutes(h.ctx);
    expect(h.res.statusCode).toBe(403);
    expect(h.reconcileShare).not.toHaveBeenCalled();
    expect(h.authority).not.toHaveBeenCalled();
  });
  it.each(['denied', 'unavailable'] as const)('does not read private evidence when context authority is %s', async outcome => {
    const h = fixture();
    h.authority.mockResolvedValue({ ...allowed, outcome, grantScope: 'none' });
    await handleKnowledgeAssetsRoutes(h.ctx);
    expect(h.res.statusCode).toBe(outcome === 'denied' ? 403 : 503);
    expect(h.reconcileShare).not.toHaveBeenCalled();
    expect(h.res.body).not.toContain(input.contextGraphId);
  });
  it('allows an authenticated operator to choose a lane', async () => {
    const h = fixture();
    h.ctx.authentication = requestAuthentication({ kind: 'nodeOperator' });
    await handleKnowledgeAssetsRoutes(h.ctx);
    expect(h.res.statusCode).toBe(200);
    expect(h.authority).not.toHaveBeenCalled();
    expect(h.reconcileShare).toHaveBeenCalledOnce();
  });
  it.each(['agentAddress=forged', 'correlationId=echo', 'entities=not-json'])('rejects duplicate or unsupported identity fields: %s', async query => {
    const h = fixture();
    h.ctx.url.search += `&${query}`;
    await handleKnowledgeAssetsRoutes(h.ctx);
    expect(h.res.statusCode).toBe(400);
    expect(h.reconcileShare).not.toHaveBeenCalled();
  });
  it('maps storage unavailability to 503 without granting mutation retry', async () => {
    const h = fixture();
    h.reconcileShare.mockResolvedValue({ ...result, reason: 'unavailable', inventory: { ...result.inventory, complete: false } });
    await handleKnowledgeAssetsRoutes(h.ctx);
    expect(h.res.statusCode).toBe(503);
    expect(JSON.parse(h.res.body)).toMatchObject({ reason: 'unavailable', mutationRetryAllowed: false });
  });
  it('round-trips the SDK selector through the real collection route', async () => {
    const h = fixture();
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      h.ctx.url = new URL(String(url));
      h.ctx.path = h.ctx.url.pathname;
      await handleKnowledgeAssetsRoutes(h.ctx);
      return new Response(h.res.body, { status: h.res.statusCode });
    }));
    expect(await new ApiClient(8899, 'token').knowledgeAssetReconcileShare({ ...input, entities: ['urn:one', 'urn:two'] })).toEqual(result);
    expect(h.reconcileShare).toHaveBeenCalledWith({ ...input, entities: ['urn:one', 'urn:two'] });
  });
});
