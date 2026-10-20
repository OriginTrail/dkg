import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MintAdoptionRefusedError } from '@origintrail-official/dkg-publisher';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import type { DkgConfig } from '../src/config.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

// A named asset whose publish transaction mined after the node stopped
// waiting: `vm/reconcile` records it (node admin only, never sends anything),
// and `vm/publish` answers a refused adoption with a typed 409/503 instead of
// a generic 500.

const AGENT_SCOPE = requestAuthentication({ kind: 'agent', agentAddress: '0x00000000000000000000000000000000000000a1' });
const OPERATOR = requestAuthentication({ kind: 'nodeOperator' });
const CG = '0xd14e38693f4a8b7cc71a3c0203e146fd58a046d1/perutnina-ptuj';
const AUTHOR = '0x00000000000000000000000000000000000000a1';
const UAL = `did:dkg:gnosis:100/${AUTHOR}/30013`;
const TX_HASH = `0x${'ab'.repeat(32)}`;
const PATH = '/api/knowledge-assets/lots-2026-08-12-083f0bc7e9b78e9c/vm/reconcile';

function fakeReq(method: string, path: string, rawBody = '') {
  const req = Readable.from([]);
  Object.assign(req, { method, url: path, headers: { host: '127.0.0.1' }, __dkgPrebufferedBody: Buffer.from(rawBody, 'utf8') });
  return req as unknown as RequestContext['req'];
}

async function callRoute(path: string, authentication: AllowedHttpAuthentication, body: unknown, agent: Record<string, unknown>) {
  const res = {
    statusCode: 0, body: '', writableEnded: false, headersSent: false,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    end(text?: string) { this.body = text ?? ''; this.writableEnded = true; return this; },
  };
  const url = new URL(`http://127.0.0.1${path}`);
  await handleKnowledgeAssetsRoutes({
    req: fakeReq('POST', path, typeof body === 'string' ? body : JSON.stringify(body)),
    res: res as unknown as ServerResponse,
    agent: { listContextGraphs: vi.fn(async () => [{ id: CG, subscribed: true, synced: true }]), ...agent },
    config: {} as DkgConfig,
    validTokens: new Set<string>(),
    url,
    path: url.pathname,
    authentication,
    requestAgentAddress: AUTHOR,
  } as unknown as RequestContext);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) as Record<string, unknown> : {} };
}

/** The agent surface reconcile drives: author resolution, lifecycle history, and the publish path. */
function stubAgent(opts: {
  statuses: Array<{ status: string; publishedUal?: string } | null>;
  publish?: () => Promise<unknown>;
}) {
  const history = vi.fn();
  for (const status of opts.statuses) history.mockResolvedValueOnce(status);
  const publishFromFinalizedAssertion = vi.fn(opts.publish ?? (async () => ({
    status: 'confirmed',
    ual: UAL,
    kaId: 30013n,
    onChainResult: { kaId: 30013n, batchId: 30013n, txHash: TX_HASH, blockNumber: 48_853_001, tokenAmount: 100n },
  })));
  return {
    resolveFinalizedAssertionPublishAuthor: vi.fn(async () => AUTHOR),
    assertion: { history },
    publishFromFinalizedAssertion,
  };
}

describe('POST /api/knowledge-assets/:name/vm/reconcile', () => {
  it('rejects an agent-scoped token before reading the body or the asset', async () => {
    const agent = stubAgent({ statuses: [] });
    const result = await callRoute(PATH, AGENT_SCOPE, '{invalid', agent);
    expect(result.status).toBe(403);
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it.each([42, '', '0x1234', `0x${'zz'.repeat(32)}`])('rejects txHash=%j before touching the asset', async (txHash) => {
    const agent = stubAgent({ statuses: [] });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots', txHash }, agent);
    expect(result.status).toBe(400);
    expect(agent.resolveFinalizedAssertionPublishAuthor).not.toHaveBeenCalled();
  });

  it('adopts the late mint through the publish path in record-only mode and reports it', async () => {
    const agent = stubAgent({ statuses: [{ status: 'swm-shared' }, { status: 'vm-confirmed', publishedUal: UAL }] });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots', txHash: TX_HASH }, agent);
    expect(result).toEqual({
      status: 200,
      body: { status: 'adopted', ual: UAL, kaId: '30013', txHash: TX_HASH, blockNumber: 48_853_001, tokenAmount: '100' },
    });
    expect(agent.publishFromFinalizedAssertion).toHaveBeenCalledExactlyOnceWith(
      CG, 'lots-2026-08-12-083f0bc7e9b78e9c',
      { subGraphName: 'lots', agentAddress: AUTHOR, adoptExistingMint: { txHash: TX_HASH } },
    );
  });

  it('leaves an already published asset untouched', async () => {
    const agent = stubAgent({ statuses: [{ status: 'vm-confirmed', publishedUal: UAL }] });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result).toEqual({ status: 200, body: { status: 'already-published', ual: UAL } });
    expect(agent.publishFromFinalizedAssertion).not.toHaveBeenCalled();
  });

  it('fails retryably when the record did not flip the lifecycle to vm-confirmed', async () => {
    const agent = stubAgent({ statuses: [{ status: 'swm-shared' }, { status: 'swm-shared' }] });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'KA_MINT_RECONCILE_INCOMPLETE', retryable: true });
  });

  it.each([
    ['mint-receipt-missing', 503, true],
    ['mint-not-final', 503, true],
    ['root-mismatch', 409, false],
    ['not-minted', 409, false],
  ] as const)('answers a %s refusal with %i', async (reason, status, retryable) => {
    const refusal = new MintAdoptionRefusedError(reason, 30013n, 'detail');
    const agent = stubAgent({ statuses: [{ status: 'swm-shared' }], publish: async () => { throw refusal; } });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result).toEqual({
      status,
      body: { code: 'KA_MINT_ADOPTION_REFUSED', reason, kaId: '30013', retryable, error: refusal.message },
    });
  });
});

describe('POST /api/knowledge-assets/:name/vm/publish with a refused late-mint adoption', () => {
  it('answers with the typed refusal instead of a generic 500', async () => {
    const refusal = new MintAdoptionRefusedError('root-mismatch', 30013n, 'on-chain root differs');
    const publishFromFinalizedAssertion = vi.fn(async () => { throw refusal; });
    const result = await callRoute('/api/knowledge-assets/lots-2026-08-12-083f0bc7e9b78e9c/vm/publish', OPERATOR,
      { contextGraphId: CG, subGraphName: 'lots' }, { publishFromFinalizedAssertion });
    expect(publishFromFinalizedAssertion).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: 409,
      body: { code: 'KA_MINT_ADOPTION_REFUSED', reason: 'root-mismatch', kaId: '30013', retryable: false, error: refusal.message },
    });
  });
});
