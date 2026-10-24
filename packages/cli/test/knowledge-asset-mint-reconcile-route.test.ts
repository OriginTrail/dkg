import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { MintAdoptionRefusedError } from '@origintrail-official/dkg-publisher';
import { ApiClient } from '../src/api-client.js';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import { registerKnowledgeAssetCommand } from '../src/commands/knowledge-asset.js';
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
const OTHER_AUTHOR = '0x00000000000000000000000000000000000000b2';
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

const ADOPTED = { status: 'adopted', ual: UAL, kaId: '30013', txHash: TX_HASH, blockNumber: 48_853_001, tokenAmount: '100' };

/** The agent's reconcile, answering or failing as the agent would. */
function stubAgent(reconcile: () => Promise<unknown> = async () => ADOPTED) {
  return { reconcileKnowledgeAssetMint: vi.fn(reconcile) };
}

describe('POST /api/knowledge-assets/:name/vm/reconcile', () => {
  it('rejects an agent-scoped token before reading the body or the asset', async () => {
    const agent = stubAgent();
    const result = await callRoute(PATH, AGENT_SCOPE, '{invalid', agent);
    expect(result.status).toBe(403);
    expect(agent.reconcileKnowledgeAssetMint).not.toHaveBeenCalled();
  });

  it.each([42, '', '0x1234', `0x${'zz'.repeat(32)}`])('rejects txHash=%j before touching the asset', async (txHash) => {
    const agent = stubAgent();
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots', txHash }, agent);
    expect(result.status).toBe(400);
    expect(agent.reconcileKnowledgeAssetMint).not.toHaveBeenCalled();
  });

  it('reconciles the named asset and reports the adopted mint', async () => {
    const agent = stubAgent();
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots', txHash: TX_HASH }, agent);
    expect(result).toEqual({ status: 200, body: ADOPTED });
    expect(agent.reconcileKnowledgeAssetMint).toHaveBeenCalledExactlyOnceWith({
      contextGraphId: CG, name: 'lots-2026-08-12-083f0bc7e9b78e9c', subGraphName: 'lots', txHash: TX_HASH,
    });
  });

  it.each([null, '', '0x1234'])('rejects selectedAuthorAgentAddress=%j before touching the asset', async (selected) => {
    const agent = stubAgent();
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, selectedAuthorAgentAddress: selected }, agent);
    expect(result.status).toBe(400);
    expect(agent.reconcileKnowledgeAssetMint).not.toHaveBeenCalled();
  });

  it('forwards the resident-author selector, as vm/publish accepts it', async () => {
    const agent = stubAgent();
    const result = await callRoute(PATH, OPERATOR, {
      contextGraphId: CG, subGraphName: 'lots', txHash: TX_HASH, selectedAuthorAgentAddress: OTHER_AUTHOR,
    }, agent);
    expect(result.status).toBe(200);
    expect(agent.reconcileKnowledgeAssetMint).toHaveBeenCalledExactlyOnceWith({
      contextGraphId: CG, name: 'lots-2026-08-12-083f0bc7e9b78e9c', subGraphName: 'lots', txHash: TX_HASH,
      selectedAuthorAgentAddress: OTHER_AUTHOR,
    });
  });

  it.each([
    ['AMBIGUOUS_ASSERTION_AUTHOR', [AUTHOR, OTHER_AUTHOR]],
    ['ASSERTION_AUTHOR_NOT_RESIDENT', [AUTHOR]],
  ])('answers %s with 409 and the resident candidates', async (code, candidates) => {
    const agent = stubAgent(async () => { throw Object.assign(new Error(`author selection: ${code}`), { code, candidates }); });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result).toEqual({ status: 409, body: { code, error: `author selection: ${code}`, candidates } });
  });

  it('reports an already published asset', async () => {
    const agent = stubAgent(async () => ({ status: 'already-published', ual: UAL }));
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result).toEqual({ status: 200, body: { status: 'already-published', ual: UAL } });
  });

  it('fails retryably when the lifecycle did not complete', async () => {
    const agent = stubAgent(async () => {
      throw Object.assign(new Error('lifecycle is not complete'), { code: 'KA_MINT_RECONCILE_INCOMPLETE' });
    });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ code: 'KA_MINT_RECONCILE_INCOMPLETE', retryable: true });
  });

  it.each([
    ['a caller precondition', new Error('assertion <urn:x> is not finalized. Call wm/finalize first'), 409,
      { code: 'VM_PUBLISH_PRECONDITION', error: 'assertion <urn:x> is not finalized. Call wm/finalize first' }],
    ['an unexpected failure', new Error('store exploded'), 500, { error: 'store exploded' }],
  ] as const)('answers %s with %i', async (_case, failure, status, body) => {
    const agent = stubAgent(async () => { throw failure; });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result).toEqual({ status, body });
  });

  it('answers 409 when this node holds nothing it can complete', async () => {
    const agent = stubAgent(async () => {
      throw Object.assign(new Error('no verified record of the sealed content'), { code: 'KA_MINT_RECONCILE_REFUSED' });
    });
    const result = await callRoute(PATH, OPERATOR, { contextGraphId: CG, subGraphName: 'lots' }, agent);
    expect(result).toEqual({
      status: 409, body: { code: 'KA_MINT_RECONCILE_REFUSED', error: 'no verified record of the sealed content' },
    });
  });

  it.each([
    ['mint-receipt-missing', 503, true],
    ['mint-not-final', 503, true],
    ['version-view-unavailable', 503, true],
    ['root-mismatch', 409, false],
    ['not-minted', 409, false],
    ['superseded', 409, false],
  ] as const)('answers a %s refusal with %i', async (reason, status, retryable) => {
    const refusal = new MintAdoptionRefusedError(reason, 30013n, 'detail');
    const agent = stubAgent(async () => { throw refusal; });
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

describe('dkg ka reconcile', () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function reconcile(args: string[], answer: unknown) {
    const knowledgeAssetReconcileMint = vi.fn().mockResolvedValue(answer);
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ knowledgeAssetReconcileMint } as unknown as ApiClient);
    const program = new Command().name('dkg');
    program.exitOverride();
    registerKnowledgeAssetCommand(program);
    await program.parseAsync(['node', 'dkg', 'ka', 'reconcile', ...args]);
    return knowledgeAssetReconcileMint;
  }

  it('records the late mint and prints the original transaction', async () => {
    const client = await reconcile([
      'lots-2026-08-12', '-c', CG, '--sub-graph-name', 'lots', '--tx-hash', TX_HASH, '--selected-author-agent-address', OTHER_AUTHOR,
    ], ADOPTED);

    expect(client).toHaveBeenCalledExactlyOnceWith(CG, 'lots-2026-08-12', {
      subGraphName: 'lots', txHash: TX_HASH, selectedAuthorAgentAddress: OTHER_AUTHOR,
    });
    expect(lines).toEqual([
      'Knowledge asset late mint recorded:',
      '  Name:    lots-2026-08-12',
      '  KA ID:   30013',
      `  UAL:     ${UAL}`,
      `  Tx hash: ${TX_HASH}`,
      '  Block:   48853001',
    ]);
  });

  it('reports an already published asset, and prints JSON on request', async () => {
    await reconcile(['lots-2026-08-12', '-c', CG], { status: 'already-published', ual: UAL });
    expect(lines).toEqual([`Knowledge asset "lots-2026-08-12" is already published as ${UAL}; nothing to do.`]);

    lines.length = 0;
    const client = await reconcile(['lots-2026-08-12', '-c', CG, '--json'], ADOPTED);
    expect(client).toHaveBeenCalledExactlyOnceWith(CG, 'lots-2026-08-12', {});
    expect(JSON.parse(lines.join('\n'))).toEqual(ADOPTED);
  });
});
