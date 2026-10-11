// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DKGAgent, KaNumberAllocator } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataGraphUri, contextGraphMetaUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { makeTestKaNumberStore } from '../../agent/test/_helpers/ka-allocator.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = 'legacy-curator-draft';
function context(agent: DKGAgent, caller: string, path: string) {
  const url = new URL(path, 'http://localhost');
  const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, aborted: false });
  const res = Object.assign(new EventEmitter(), { statusCode: 0, body: '', destroyed: false, writableEnded: false,
    writeHead(status: number) { this.statusCode = status; }, setHeader() {},
    end(body = '') { this.body = body; this.writableEnded = true; },
  });
  const ctx = { agent, req, res, url, path: url.pathname,
    authentication: requestAuthentication({ kind: 'agent', agentAddress: caller }),
    requestAgentAddress: caller, extractionStatus: new Map(),
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('real local curator draft provenance through HTTP admission', () => {
  const store = new OxigraphStore();
  let agent: DKGAgent;
  let owner: string;
  let other: string;
  let kaNumber: string;
  let compactLiteralName: string;
  const deniedCg = `${CG}-denied`;
  const revokedCg = `${CG}-revoked`;
  const foreignCg = `${CG}-foreign-curator`;
  beforeAll(async () => {
    agent = await DKGAgent.create({ name: 'legacy-curator-read', store,
      chainAdapter: new MockChainAdapter(), kaNumberAllocator: new KaNumberAllocator(makeTestKaNumberStore()), nodeRole: 'edge', listenHost: '127.0.0.1', listenPort: 0 });
    await agent.start();
    owner = (await agent.registerAgent('owner')).agentAddress;
    other = (await agent.registerAgent('other')).agentAddress;
    for (const cg of [CG, deniedCg, revokedCg, foreignCg]) {
      await agent.createContextGraph({ id: cg, name: cg, accessPolicy: 1,
        callerAgentAddress: cg === foreignCg ? other : owner, ...(cg === deniedCg ? { allowedAgents: [other] } : {}) });
      await agent.assertion.create(cg, 'asset', { agentAddress: owner });
      await agent.assertion.write(cg, 'asset', [{ subject: 'urn:legacy:private', predicate: 'http://schema.org/name',
        object: '"legacy secret"', graph: '' }], { agentAddress: owner });
      await agent.assertion.finalize(cg, 'asset', { agentAddress: owner, authorAgentAddress: owner });
      // A pre-agent roster has no allowedAgent rows and no revocation. Preserve
      // the real declaration, local-create provenance, curator and subscription.
      if (cg === revokedCg) {
        await agent.removeAgentFromContextGraph(cg, owner, owner);
      } else await store.deleteByPattern({ graph: contextGraphMetaUri(cg), subject: contextGraphDataGraphUri(cg),
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, ...(cg === deniedCg ? { object: `"${owner}"` } : {}) });
      await agent.renameContextGraph(cg, cg, cg === foreignCg ? other : owner);
    }
    compactLiteralName = `${other}:5`;
    await agent.assertion.create(CG, compactLiteralName, { agentAddress: owner });
    await agent.assertion.write(CG, compactLiteralName, [{ subject: 'urn:legacy:literal', predicate: 'http://schema.org/name',
      object: '"literal secret"', graph: '' }], { agentAddress: owner });
    expect((await agent.getCgMeta(revokedCg)).revokedAgents.map(address => address.toLowerCase())).toContain(owner.toLowerCase());
    kaNumber = (await agent.assertion.history(CG, 'asset', { agentAddress: owner }))!.kaNumber!;
    expect(kaNumber).toBeDefined();
    expect(await agent.resolveContextGraphReadAuthority(CG, { callerAgentAddress: owner }))
      .toMatchObject({ outcome: 'allowed', grantScope: 'node', source: 'legacy-local' });
    expect(await agent.resolveContextGraphReadAuthority(deniedCg, { callerAgentAddress: owner }))
      .toMatchObject({ outcome: 'denied' });
  });
  afterAll(async () => { try { await agent?.stop(); } finally { await store.close(); } });

  async function read(identifier: string, suffix = '/wm/quads', caller = owner, query = '', cg = CG) {
    const h = context(agent, caller, `/api/knowledge-assets/${encodeURIComponent(identifier)}${suffix}?contextGraphId=${cg}${query}`);
    await handleKnowledgeAssetsRoutes(h.ctx);
    return h.res;
  }
  it.each(['', '/wm', '/wm/quads', '/wm/extraction-status'])('reads the legacy curator own draft at %s', async suffix => {
    const res = await read('asset', suffix);
    expect(res.statusCode, res.body).toBe(suffix === '/wm/extraction-status' ? 404 : 200);
    if (suffix === '/wm/quads') expect(res.body).toContain('legacy secret');
  });
  it.each(['compact', 'ual', 'packed'] as const)('resolves the own %s alias to the same draft', async kind => {
    const packed = ((BigInt(owner) << 96n) | BigInt(kaNumber)).toString();
    const alias = kind === 'compact' ? `${owner}:${kaNumber}` : kind === 'ual' ? `did:dkg:31337/${owner}/${kaNumber}` : `did:dkg:31337/0x1111111111111111111111111111111111111111/${packed}`;
    const res = await read(alias);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('legacy secret');
  });
  it.each(['', '/wm', '/wm/quads', '/wm/extraction-status'])('keeps own compact-looking literal precedence at %s', async suffix => {
    const res = await read(compactLiteralName, suffix);
    expect(res.statusCode, res.body).toBe(suffix === '/wm/extraction-status' ? 404 : 200);
    if (suffix === '/wm/quads') expect(res.body).toContain('literal secret');
  });
  it('refuses another caller inspecting the curator lane', async () => {
    const res = await read('asset', '/wm/quads', other, `&agentAddress=${owner}`);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('legacy secret');
  });
  it('refuses a curator selecting another author lane or alias', async () => {
    for (const identifier of ['asset', `${other}:${kaNumber}`]) {
      const res = await read(identifier, '/wm/quads', owner, `&agentAddress=${other}`);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('legacy secret');
    }
  });
  it('rejects a foreign alias even with the default caller lane', async () => {
    expect((await read(`${other}:${kaNumber}`)).statusCode).toBe(403);
  });
  it.each(['/swm', '/vm'])('does not extend draft-only evidence to %s', async suffix => {
    expect((await read('asset', suffix)).statusCode).toBe(403);
  });
  it('keeps explicit roster denial above local curator provenance', async () => {
    const res = await read('asset', '/wm/quads', owner, '', deniedCg);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('legacy secret');
  });
  it('keeps explicit revocation above local curator provenance', async () => {
    const res = await read('asset', '/wm/quads', owner, '', revokedCg);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('legacy secret');
  });
  it('requires this caller to be the real local curator', async () => {
    const res = await read('asset', '/wm/quads', owner, '', foreignCg);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('legacy secret');
  });
  it('refuses a later draft-provenance metadata outage after a real legacy node grant', async () => {
    const originalAuthority = agent.resolveContextGraphReadAuthority.bind(agent);
    const originalMeta = agent.getCgMeta.bind(agent);
    let authoritySettled = false;
    let laterMetadataReads = 0;
    const authority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockImplementation(async (...args) => {
      const decision = await originalAuthority(...args);
      expect(decision).toMatchObject({ outcome: 'allowed', source: 'legacy-local', grantScope: 'node' });
      authoritySettled = true;
      return decision;
    });
    const meta = vi.spyOn(agent, 'getCgMeta').mockImplementation(async (...args) => {
      if (authoritySettled) {
        laterMetadataReads++;
        throw new Error('later draft metadata unavailable');
      }
      return originalMeta(...args);
    });
    try {
      const res = await read('asset');
      expect(authoritySettled).toBe(true);
      expect(laterMetadataReads).toBe(1);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE' });
      expect(res.body).not.toContain('later draft metadata unavailable');
      expect(res.body).not.toContain('legacy secret');
    } finally { meta.mockRestore(); authority.mockRestore(); }
  });
  it('keeps unavailable authority retryable without curator fallback', async () => {
    const authority = vi.spyOn(agent, 'resolveContextGraphReadAuthority').mockResolvedValueOnce({
      outcome: 'unavailable', source: 'registered-chain', reason: 'registered-authority-error',
      dependency: 'chain', metadataBootstrap: 'eligible',
    });
    try {
      const res = await read('asset');
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toContain('legacy secret');
    } finally { authority.mockRestore(); }
  });
});
