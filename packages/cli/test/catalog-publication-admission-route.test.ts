import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { DKGAgent, CatalogPublicationAdmissionError } from '@origintrail-official/dkg-agent';
import { confirmedPublicationCatalogConfigV1 } from '../../agent/test/support/confirmed-publication-harness.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = '0x1111111111111111111111111111111111111111/catalog-admission';
const NAME = '界'.repeat(100); // Valid legacy name; above the catalog's 256-byte limit.
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});
async function fixture(enabled = true) {
  const preparation = vi.fn(() => { throw new Error('publication preparation entered'); });
  const submit = vi.fn(); const enqueue = vi.fn();
  const agent = Object.assign(Object.create(DKGAgent.prototype), {
    config: confirmedPublicationCatalogConfigV1(enabled),
    contextGraphExists: async () => true, resolveAgentByToken: () => undefined,
    writePreflightIdentity: undefined,
    probeContextGraphWritePreflight: async () => ({ storeAvailable: true, exists: true, hasLocalContent: true,
      accessPolicy: 'public', callerAuthorized: true, inMemorySubscription: { subscribed: true, synced: true } }),
    listContextGraphs: async () => [{ id: CG, uri: `did:dkg:context-graph:${CG}`, subscribed: true, synced: true }],
    resolveFinalizedAssertionPublishAuthor: preparation,
    publisher: { publish: submit, update: submit },
  }) as DKGAgent;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      await handleKnowledgeAssetsRoutes({ req, res, url, path: url.pathname, agent,
        config: {}, publisherState: { availability: { available: true } },
        publisherControl: { enqueueKnowledgeAssetVmPublish: enqueue },
        requestAgentAddress: '0x1111111111111111111111111111111111111111',
        authentication: requestAuthentication({ kind: 'nodeOperator' }),
      } as unknown as RequestContext);
      if (!res.writableEnded) { res.statusCode = 404; res.end('{}'); }
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const post = async (verb: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/knowledge-assets/${encodeURIComponent(NAME)}/vm/${verb}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextGraphId: CG }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { agent, preparation, submit, enqueue, post };
}
describe('typed catalog publication admission over HTTP', () => {
  it.each(['publish', 'publish-async'])('%s rejects a catalog-incompatible name before submission or enqueue', async verb => {
    const f = await fixture(); const response = await f.post(verb);
    expect(response).toMatchObject({ status: 400, body: { code: 'CATALOG_PUBLICATION_ADMISSION_INVALID' } });
    expect(f.preparation).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(['publish', 'publish-async'])('%s preserves the legacy name when the catalog is excluded', async verb => {
    const f = await fixture(false); const response = await f.post(verb);
    expect(f.preparation).toHaveBeenCalledWith(CG, NAME, expect.any(Object));
    expect(response).toMatchObject({ status: 500, body: { error: 'publication preparation entered' } });
  });
  it('does not down-classify an error after queue admission has begun', async () => {
    const f = await fixture(false);
    Object.assign(f.agent, { resolveFinalizedAssertionVmPublishIntent: async () => ({}), preflightKnowledgeAssetVmPublishSnapshot: async () => {} });
    f.enqueue.mockImplementation(() => { throw new CatalogPublicationAdmissionError(new Error('enqueue persisted then failed')); });
    const response = await f.post('publish-async');
    expect(f.enqueue).toHaveBeenCalledOnce(); expect(response.status).toBe(500);
  });
  it('keeps an on-chain invalid-value failure as a server error', async () => {
    const f = await fixture(false);
    Object.assign(f.agent, { publishFromFinalizedAssertion: async () => { throw new Error('Invalid value: transaction reverted'); } });
    expect(await f.post('publish')).toMatchObject({ status: 500 });
  });
});
