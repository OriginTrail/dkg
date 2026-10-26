import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DKGAgent, KaNumberAllocator } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { assertionLifecycleUri, contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { BlazegraphStore, GraphManager, OxigraphStore, PrivateContentStore, type Quad } from '@origintrail-official/dkg-storage';
import { computePrivateRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { makeTestKaNumberStore } from '../../agent/test/_helpers/ka-allocator.js';

const CG = `http-private-partitions-${Date.now()}`;
const secret: Quad = { subject: 'urn:private:record', predicate: 'urn:value', object: '"secret"', graph: '' };
const publicQuad: Quad = { ...secret, subject: 'urn:public:record', object: '"public"' };

describe('private partitions through real HTTP, agent and RDF storage', () => {
  // Optional integration lane: point only at a disposable test namespace.
  const store = process.env.DKG_PRIVATE_HTTP_BLAZEGRAPH_URL
    ? new BlazegraphStore(process.env.DKG_PRIVATE_HTTP_BLAZEGRAPH_URL) : new OxigraphStore();
  let agent: DKGAgent;
  let owner: string;
  let other: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    agent = await DKGAgent.create({ name: 'private-http', store, chainAdapter: new MockChainAdapter(),
      kaNumberAllocator: new KaNumberAllocator(makeTestKaNumberStore()), nodeRole: 'edge', listenHost: '127.0.0.1', listenPort: 0 });
    await agent.start();
    owner = (await agent.registerAgent(`owner-${CG}`)).agentAddress;
    other = (await agent.registerAgent(`other-${CG}`)).agentAddress;
    await agent.createContextGraph({ id: CG, name: CG, accessPolicy: 1, callerAgentAddress: owner, allowedAgents: [owner, other] });
    server = createServer(async (req, res) => {
      const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
      const authentication = token === 'operator' ? requestAuthentication({ kind: 'nodeOperator' })
        : token === 'anonymous' ? requestAuthentication({ kind: 'anonymous', mode: 'disabled' })
        : requestAuthentication({ kind: 'agent', agentAddress: token });
      const url = new URL(req.url!, 'http://localhost');
      try {
        await handleKnowledgeAssetsRoutes({ agent, req, res, url, path: url.pathname,
          authentication, requestAgentAddress: token === 'operator' || token === 'anonymous' ? owner : token,
        } as unknown as RequestContext);
        if (!res.writableEnded) { res.writeHead(404); res.end('{}'); }
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
    base = `http://127.0.0.1:${address.port}/api/knowledge-assets`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { await agent?.stop(); } finally { await store.close(); }
  });
  async function call(path: string, body?: Record<string, unknown>, caller = owner) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: {
      Authorization: `Bearer ${caller}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify({ contextGraphId: CG, ...body }) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  const read = (name: string, layer = 'wm', query = '') => `/${encodeURIComponent(name)}/${layer}/quads?contextGraphId=${CG}&partition=private${query}`;

  it('creates an editable private-only KA, appends private RDF, and keeps the public partition empty', async () => {
    const created = await call('', { name: 'editable', privateQuads: [secret], finalize: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft-open', writtenPrivate: 1 });
    const second = { ...secret, subject: 'urn:private:second' };
    expect((await call('/editable/wm/write', { privateQuads: [second] })).body).toMatchObject({ written: 1, writtenPrivate: 1 });
    const result = await call(read('editable'));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.quads).toEqual(expect.arrayContaining([secret, second]));
    const ordinary = await call(`/editable/wm/quads?contextGraphId=${CG}`);
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.quads).toEqual([]);
  });

  it('writes mixed partitions separately and seals a private-only KA by default', async () => {
    expect((await call('', { name: 'mixed', quads: [publicQuad], privateQuads: [secret], finalize: false })).status).toBe(201);
    expect((await call(read('mixed'))).body.quads).toEqual([secret]);
    const publicRead = await call(`/mixed/wm/quads?contextGraphId=${CG}`);
    expect(JSON.stringify(publicRead.body)).toContain('public');
    expect(JSON.stringify(publicRead.body)).not.toContain('secret');
    const sealed = await call('', { name: 'sealed', privateQuads: [secret] });
    expect(sealed.status, JSON.stringify(sealed.body)).toBe(201);
    expect(sealed.body.status).toBe('wm-sealed');
    const write = await call('/sealed/wm/write', { privateQuads: [secret] });
    expect(write.status).toBe(409);
    // Existing empty public writes are no-ops; retain that behavior.
    expect((await call('/sealed/wm/write', { quads: [] })).status).toBe(200);
    expect((await call('/sealed/wm/write', { privateQuads: [] })).status).toBe(409);
  });

  it.each([
    { privateQuads: 'invalid' },
    { quads: 'invalid', privateQuads: [secret] },
    { quads: [publicQuad], privateQuads: [{ ...secret, predicate: 'not an IRI' }] },
    { quads: [publicQuad], privateQuads: [{ ...secret, graph: 'urn:foreign:graph' }] },
    { privateQuads: [{ ...secret, object: '"unterminated' }] },
    { quads: [publicQuad], privateQuads: [{ ...secret, subject: 'urn:dkg:file:forged' }] },
  ])('rejects malformed partitions before create or public write: %j', async body => {
    const name = `invalid-${Math.random().toString(36).slice(2)}`;
    const create = await call('', { name, ...body, finalize: false });
    expect(create.status).toBe(400);
    expect(await agent.assertion.history(CG, name, { agentAddress: owner })).toBeNull();
    const write = await call(`/${name}/wm/write`, body);
    expect(write.status).toBe(400);
    expect(await agent.assertion.history(CG, name, { agentAddress: owner })).toBeNull();
  });

  it('denies another CG member selecting the owner, but allows an authenticated node operator', async () => {
    await call('', { name: 'owner-only', privateQuads: [secret], finalize: false });
    expect((await call(read('owner-only', 'wm', `&agentAddress=${owner}`), undefined, other)).status).toBe(403);
    expect((await call(read('owner-only', 'wm', `&agentAddress=${owner}`), undefined, 'anonymous')).status).toBe(403);
    expect((await call(read('owner-only', 'wm', `&agentAddress=${owner}`), undefined, 'operator')).body.quads).toEqual([secret]);
  });

  it('checks owner identity after resolving UAL and compact aliases', async () => {
    await call('', { name: 'alias', privateQuads: [secret], finalize: false });
    const descriptor = (await agent.assertion.history(CG, 'alias', { agentAddress: owner }))!;
    for (const identifier of [descriptor.reservedUal!, `${owner}:${descriptor.kaNumber}`]) {
      expect((await call(read(identifier))).body.quads).toEqual([secret]);
      expect((await call(read(identifier), undefined, other)).status).toBe(403);
    }
  });

  it('fails closed when current CG authority is denied or unavailable', async () => {
    await call('', { name: 'revoked', privateQuads: [secret], finalize: false });
    const resolver = vi.spyOn(agent, 'resolveContextGraphReadAuthority');
    try {
      resolver.mockResolvedValue({ outcome: 'denied', source: 'legacy-local', reason: 'no-read-authority',
        metadataBootstrap: 'forbidden', grantScope: 'none' });
      expect((await call(read('revoked'))).status).toBe(403);
      resolver.mockResolvedValue({ outcome: 'unavailable', source: 'legacy-local', reason: 'authority-unavailable',
        metadataBootstrap: 'forbidden', dependency: 'store' });
      expect((await call(read('revoked'))).status).toBe(503);
    } finally { resolver.mockRestore(); }
  });

  async function seedConfirmed(name: string, value = secret, subGraphName?: string) {
    await call('', { name, privateQuads: [value], subGraphName });
    const seal = await agent.assertion.finalize(CG, name, { agentAddress: owner, authorAgentAddress: owner, subGraphName });
    const scope = createGraphKnowledgeAssetScope(seal.kaUal!, seal.assertionVersion!);
    const privateStore = new PrivateContentStore(store, new GraphManager(store));
    await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, [value], subGraphName);
    await store.insert(generateGraphKnowledgeAssetMetadata({ ual: scope.ual, contextGraphId: CG,
      assertionVersion: scope.assertionVersion, publicTripleCount: 0, privateTripleCount: 1,
      privateMerkleRoot: computePrivateRootV10([value]), merkleRoot: seal.merkleRoot,
      assertionGraph: knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope, subGraphName), subGraphName,
      publisherPeerId: 'fixture', agentAddress: owner, accessPolicy: 'ownerOnly', timestamp: new Date(),
    }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
      txHash: `0x${'a'.repeat(64)}`, blockNumber: 1, blockTimestamp: 1, publisherAddress: owner, batchId: 1n, chainId: '31337',
    } } }));
    await store.insert([{ subject: assertionLifecycleUri(CG, owner, name, subGraphName),
      predicate: 'http://dkg.io/ontology/vmCurrentAssertion', object: `"${Buffer.from(seal.merkleRoot).toString('hex')}"`, graph: contextGraphMetaUri(CG) }]);
    return { privateStore, scope };
  }

  it('returns exact confirmed private VM content and commitment evidence without opening a draft', async () => {
    await seedConfirmed('confirmed');
    const before = await agent.assertion.history(CG, 'confirmed', { agentAddress: owner });
    const result = await call(read('confirmed', 'vm'));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({ status: 'vm-confirmed', quads: [secret], count: 1,
      assertionVersion: '1', transactionHash: `0x${'a'.repeat(64)}` });
    expect(result.body.privateMerkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await agent.assertion.history(CG, 'confirmed', { agentAddress: owner })).toEqual(before);
    expect((await call(read('confirmed', 'vm', `&agentAddress=${owner}`), undefined, other)).status).toBe(403);
    expect((await call(read(String(result.body.ual), 'vm'))).body.quads).toEqual([secret]);
    await expect(agent.assertion.queryPrivateVm(CG, String(result.body.ual), { subGraphName: 'wrong' }))
      .rejects.toMatchObject({ code: 'PRIVATE_KA_SCOPE_MISMATCH' });
  });

  it('refuses wrong same-count private content instead of returning it as confirmed', async () => {
    const { privateStore, scope } = await seedConfirmed('corrupt');
    await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, [{ ...secret, object: '"tampered"' }]);
    const result = await call(read('corrupt', 'vm'));
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('PRIVATE_KA_PAYLOAD_MISMATCH');
    expect(JSON.stringify(result.body)).not.toContain('tampered');
  });

  it('reads the exact subgraph partition without crossing into a same-name KA', async () => {
    await agent.createSubGraph(CG, 'welding');
    const otherValue = { ...secret, object: '"subgraph secret"' };
    await seedConfirmed('confirmed', otherValue, 'welding');
    const scoped = await call(read('confirmed', 'vm', '&subGraphName=welding'));
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
    expect(scoped.body.quads).toEqual([otherValue]);
    expect((await call(read('confirmed', 'vm'))).body.quads).toEqual([secret]);
  });

  it('refuses missing local VM payload and an unconfirmed draft', async () => {
    const { privateStore, scope } = await seedConfirmed('missing');
    await privateStore.replaceKnowledgeAssetPrivateTriples(CG, scope, []);
    expect((await call(read('missing', 'vm'))).body.code).toBe('PRIVATE_KA_PAYLOAD_MISMATCH');
    await call('', { name: 'unconfirmed', privateQuads: [secret], finalize: false });
    expect((await call(read('unconfirmed', 'vm'))).body.code).toBe('PRIVATE_KA_NOT_CONFIRMED');
  });

  it('refuses a descriptor pointing to a different confirmed version', async () => {
    await seedConfirmed('moved');
    const descriptor = (await agent.assertion.history(CG, 'moved', { agentAddress: owner }))!;
    const pointer = { subject: assertionLifecycleUri(CG, owner, 'moved'),
      predicate: 'http://dkg.io/ontology/vmCurrentAssertion', graph: contextGraphMetaUri(CG) };
    await store.delete([{ ...pointer, object: `"${descriptor.vmCurrentAssertion}"` }]);
    await store.insert([{ ...pointer, object: `"${'b'.repeat(64)}"` }]);
    expect((await call(read('moved', 'vm'))).body.code).toBe('PRIVATE_KA_VERSION_MOVED');
  });

  it('preserves the committed typed dateTime lexical value through VM storage', async () => {
    const value = { ...secret, object: '"2026-10-26T10:00:00.120Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>' };
    await seedConfirmed('timestamp', value);
    const result = await call(read('timestamp', 'vm'));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.count).toBe(1);
  });
});
