import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { startLiveDaemon, stopLiveDaemon, postJson, getJson, type LiveDaemon } from './helpers/live-daemon.js';

const CG = `sealed-retry-${Date.now().toString(36)}`;
const NAME = 'evidence-pack-retry';
let daemon: LiveDaemon;
const payload = (value: string) => ({ contextGraphId: CG, name: NAME, quads: [{
  subject: 'urn:test:pack', predicate: 'https://umanitek.ai/dkg/evidence-pack/createdAt',
  object: JSON.stringify(value),
}] });
const descriptor = () => getJson(daemon, `/api/knowledge-assets/${NAME}?contextGraphId=${CG}`);
const quads = () => getJson(daemon, `/api/knowledge-assets/${NAME}/wm/quads?contextGraphId=${CG}`);

describe('sealed create retry over real HTTP with an isolated mock chain', () => {
  beforeAll(async () => {
    daemon = await startLiveDaemon({ extraConfig: { chain: { type: 'mock' } } });
    const registered = await postJson(daemon, '/api/agent/register', { name: CG, framework: 'test' });
    expect(registered.status).toBeLessThan(300);
    daemon.token = String(registered.body.authToken);
    const cg = await postJson(daemon, '/api/context-graph/create', { id: CG, name: CG });
    expect(cg.status, JSON.stringify(cg.body)).toBeLessThan(300);
    const created = await postJson(daemon, '/api/knowledge-assets', payload('original'));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/i);
  }, 60_000);
  afterAll(async () => stopLiveDaemon(daemon));

  it('returns a conflict without changing content or lifecycle on a changed retry', async () => {
    const before = await descriptor();
    const beforeQuads = await quads();
    const retried = await postJson(daemon, '/api/knowledge-assets', payload('retry'));
    expect(retried.status).toBe(409);
    expect(retried.body).toMatchObject({ code: 'KA_ASSERTION_ALREADY_FINALIZED', retryAction: 'resume_existing_knowledge_asset', retryKnowledgeAssetName: NAME });
    expect((await quads()).body).toEqual(beforeQuads.body);
    expect((await descriptor()).body).toEqual(before.body);
  });

  it('keeps a metadata-only get-or-create request harmless', async () => {
    const before = await descriptor();
    const retried = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: CG, name: NAME });
    expect(retried.status).toBe(201);
    expect(retried.body.alreadyExists).toBe(true);
    expect((await descriptor()).body).toEqual(before.body);
  });

  it('maps a direct write to a sealed draft to an actionable conflict', async () => {
    const before = await quads();
    const written = await postJson(daemon, `/api/knowledge-assets/${NAME}/wm/write`, payload('retry'));
    expect(written.status).toBe(409);
    expect(written.body.code).toBe('KA_ASSERTION_ALREADY_FINALIZED');
    expect((await quads()).body).toEqual(before.body);
  });
});

describe('durable interrupted sharing recovery over real HTTP', () => {
  const cgId = `${CG}-recovery`;
  const operationId = 'original-interrupted-share';
  let live: LiveDaemon;
  let seed: LiveDaemon;
  let stderr = '';

  beforeAll(async () => {
    seed = await startLiveDaemon({ extraConfig: { chain: { type: 'mock' } } });
    const registered = await postJson(seed, '/api/agent/register', { name: cgId, framework: 'test' });
    expect(registered.status).toBeLessThan(300);
    seed.token = String(registered.body.authToken);
    expect((await postJson(seed, '/api/context-graph/create', { id: cgId, name: cgId })).status).toBeLessThan(300);
    const created = await postJson(seed, '/api/knowledge-assets', { ...payload('original'), contextGraphId: cgId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const status = await getJson(seed, '/api/status');
    // Seed the exact durable shape left by an interrupted promote while the
    // real daemon is stopped; production HTTP requests then exercise its guard.
    await seed.owner.stop();
    const store = new OxigraphStore(join(seed.home, 'store.nq'));
    const subject = assertionLifecycleUri(cgId, String(created.body.authorAddress), NAME);
    const graph = contextGraphMetaUri(cgId);
    const intent = {
      version: 1, operationId, timestampMs: Date.now(),
      publisherPeerId: status.body.peerId, confirmationRequired: false,
      accessPolicy: 'public', allowedPeers: [],
    };
    await store.insert([
      { subject, graph, predicate: 'http://dkg.io/ontology/shareOperationId', object: JSON.stringify(operationId) },
      { subject, graph, predicate: 'http://dkg.io/ontology/promoteOperationIntent', object: JSON.stringify(JSON.stringify(intent)) },
    ]);
    await store.close();
    live = await startLiveDaemon({
      extraConfig: { chain: { type: 'mock' } },
      prepareHome: async (home) => {
        const config = await readFile(join(home, 'config.json'));
        await cp(seed.home, home, { recursive: true });
        await writeFile(join(home, 'config.json'), config);
      },
    });
    live.token = seed.token;
    live.child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  }, 60_000);

  afterAll(async () => {
    await stopLiveDaemon(live);
    await stopLiveDaemon(seed);
  });

  it('returns typed recovery conflicts for create, write and discard without losing the sealed draft', async () => {
    const path = `/api/knowledge-assets/${NAME}?contextGraphId=${cgId}`;
    const before = await getJson(live, path);
    const beforeQuads = await getJson(live, path.replace('?', '/wm/quads?'));
    for (const [url, body] of [
      ['/api/knowledge-assets', { ...payload('changed'), contextGraphId: cgId }],
      [`/api/knowledge-assets/${NAME}/wm/write`, { ...payload('changed'), contextGraphId: cgId }],
      [`/api/knowledge-assets/${NAME}/wm/discard`, { contextGraphId: cgId }],
    ] as const) {
      const result = await postJson(live, url, body);
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect(result.body).toMatchObject({
        code: 'KA_PROMOTE_RECOVERY_REQUIRED', retryAction: 'resume_existing_knowledge_asset',
        retryPhase: 'swm-share', contextGraphId: cgId, retryKnowledgeAssetName: NAME,
      });
      expect((await getJson(live, path)).body).toEqual(before.body);
      expect((await getJson(live, path.replace('?', '/wm/quads?'))).body).toEqual(beforeQuads.body);
    }
    expect(stderr).toContain('knowledge_asset_recovery_required');
    expect(stderr).toContain(NAME);
    expect(stderr).not.toContain('https://umanitek.ai/dkg/evidence-pack/createdAt');
  });

  it('resumes the original sharing operation through the advertised endpoint', async () => {
    const result = await postJson(live, `/api/knowledge-assets/${NAME}/swm/share`, { contextGraphId: cgId });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.shareOperationId).toBe(operationId);
    expect(result.body.promotedCount).toBe(1);
    const draft = await getJson(live, `/api/knowledge-assets/${NAME}/wm/quads?contextGraphId=${cgId}`);
    expect(draft.body.count).toBe(0);
  });
});
