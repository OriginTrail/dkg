import { afterEach, describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphWorkerStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../agent/src/index.js';
import { LocalContextGraphProvenance } from '../../agent/src/local-context-graph-provenance.js';
import { resolveRequiredWriteContextGraphId } from '../src/daemon/http-utils.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';
const OUTSIDER = '0x3333333333333333333333333333333333333333';
const CG = `${OWNER}/local-private-first-write`;

function captureResponse() {
  const out: { status?: number; body?: { code?: string } } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) { if (body) out.body = JSON.parse(body); },
  } as unknown as ServerResponse;
  return { res, out };
}

describe('local private graph first-write preflight', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => { await agent?.stop(); });

  async function createPrivateGraph(store?: TripleStore) {
    agent = await DKGAgent.create({
      name: 'PrivateFirstWrite',
      listenPort: 0,
      listenHost: '127.0.0.1',
      chainAdapter: new NoChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
      ...(store ? { store } : {}),
    });
    await agent.start();
    await agent.createContextGraph({
      id: CG, name: 'Local private', private: true,
      accessPolicy: 1, publishPolicy: 0,
      callerAgentAddress: OWNER, allowedAgents: [OWNER, MEMBER],
    });
    return agent;
  }

  it.each([OWNER, MEMBER])('accepts an authorized %s before any content without gossip', async (caller) => {
    const a = await createPrivateGraph();
    const before = a.getSubscribedContextGraphs().get(CG);
    expect(before).toMatchObject({ subscribed: false, synced: true, metaSynced: true });
    expect(await a.contextGraphHasLocalContent(CG)).toBe(false);
    expect(await a.probeContextGraphWritePreflight(CG, { callerAgentAddress: caller }))
      .toMatchObject({ storeAvailable: true, exists: true, hasLocalContent: false,
        locallyCreated: true, declarationFound: true, accessPolicy: 'private', callerAuthorized: true });

    const { res, out } = captureResponse();
    expect(await resolveRequiredWriteContextGraphId(a, CG, res, { callerAgentAddress: caller }))
      .toBe(CG);
    expect(out.status).toBeUndefined();
    expect(a.getSubscribedContextGraphs().get(CG)).toBe(before);
    expect(before?.subscribed).toBe(false);
  });

  it('keeps unauthorized private callers denied despite local-create origin', async () => {
    const a = await createPrivateGraph();
    const { res, out } = captureResponse();
    expect(await resolveRequiredWriteContextGraphId(a, CG, res, { callerAgentAddress: OUTSIDER }))
      .toBeNull();
    expect(out.status).toBe(400);
    expect(out.body?.code).toBe('CONTEXT_GRAPH_NOT_FOUND');
  });

  it('does not trust declaration, curator RDF, or an unsubscribed graph as local origin', async () => {
    const a = await createPrivateGraph();
    Reflect.set(a, 'localContextGraphProvenance', new LocalContextGraphProvenance());
    const { res, out } = captureResponse();
    expect(await resolveRequiredWriteContextGraphId(a, CG, res, { callerAgentAddress: OWNER }))
      .toBeNull();
    expect(out.body?.code).toBe('CONTEXT_GRAPH_NOT_WRITABLE');
  });

  it('accepts the restored durable local-origin journal without enabling subscription', async () => {
    const a = await createPrivateGraph();
    const restored = new LocalContextGraphProvenance();
    restored.restoreOriginRecords([{ contextGraphId: CG, source: 'local-create' }]);
    Reflect.set(a, 'localContextGraphProvenance', restored);
    const { res } = captureResponse();
    expect(await resolveRequiredWriteContextGraphId(a, CG, res, { callerAgentAddress: OWNER }))
      .toBe(CG);
    expect(a.getSubscribedContextGraphs().get(CG)?.subscribed).toBe(false);
  });

  it('does not admit a journal-only ghost without a store-backed graph declaration', async () => {
    const a = await createPrivateGraph();
    const missing = `${OWNER}/journal-only-ghost`;
    Reflect.get(a, 'localContextGraphProvenance').recordLocalCreate(missing);
    const { res, out } = captureResponse();
    expect(await resolveRequiredWriteContextGraphId(a, missing, res, { callerAgentAddress: OWNER }))
      .toBeNull();
    expect(out.body?.code).toBe('CONTEXT_GRAPH_NOT_FOUND');
  });

  it('fails closed for private local-origin graphs when the store is unavailable', async () => {
    const a = await createPrivateGraph(new OxigraphWorkerStore(undefined));
    await a.store.close();
    const { res, out } = captureResponse();
    expect(await resolveRequiredWriteContextGraphId(a, CG, res, { callerAgentAddress: OWNER }))
      .toBeNull();
    expect(out.status).toBe(503);
    expect(out.body?.code).toBe('CONTEXT_GRAPH_VALIDATION_UNAVAILABLE');
  });
});
