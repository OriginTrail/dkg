// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, postJson, getJson, type LiveDaemon } from './helpers/live-daemon.js';

const privateCg = `read-private-${Date.now().toString(36)}`;
const callerCg = `read-caller-${Date.now().toString(36)}`;
const secret = 'private tenant content';
const draftCg = `curator-draft-${Date.now().toString(36)}`;
let daemon: LiveDaemon;
let allowed: { address: string; token: string };
let excluded: { address: string; token: string };

async function request(token: string, path: string, body?: object) {
  const response = await fetch(`${daemon.base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

describe('real HTTP caller-bound CG reads', () => {
  beforeAll(async () => {
    daemon = await startLiveDaemon();
    async function register(name: string) {
      const result = await postJson(daemon, '/api/agent/register', { name, framework: 'test' });
      expect(result.status).toBeLessThan(300);
      return { address: String(result.body.agentAddress), token: String(result.body.authToken) };
    }
    allowed = await register(`private-owner-${Date.now().toString(36)}`);
    excluded = await register(`other-owner-${Date.now().toString(36)}`);
    for (const [owner, id] of [[allowed, privateCg], [excluded, callerCg]] as const) {
      const created = await request(owner.token, '/api/context-graph/create', { id, name: id, accessPolicy: 1 });
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
      const registered = await request(owner.token, '/api/context-graph/register', { id, accessPolicy: 1 });
      expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    }
    const localCreated = await request(allowed.token, '/api/context-graph/create', {
      id: draftCg, name: draftCg, accessPolicy: 1,
    });
    expect(localCreated.status, JSON.stringify(localCreated.body)).toBeLessThan(300);
    const localAsset = await request(allowed.token, '/api/knowledge-assets', { contextGraphId: draftCg, name: 'local-draft' });
    expect(localAsset.status, JSON.stringify(localAsset.body)).toBe(201);
    const localWritten = await request(allowed.token, '/api/knowledge-assets/local-draft/wm/write', {
      contextGraphId: draftCg,
      quads: [{ subject: 'urn:local:draft', predicate: 'http://schema.org/name', object: '"curator draft content"', graph: '' }],
    });
    expect(localWritten.status, JSON.stringify(localWritten.body)).toBe(200);
    const created = await request(allowed.token, '/api/knowledge-assets', { contextGraphId: privateCg, name: 'private-asset' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const written = await request(allowed.token, '/api/knowledge-assets/private-asset/wm/write', {
      contextGraphId: privateCg,
      quads: [{ subject: 'urn:private:entity', predicate: 'http://schema.org/name', object: `"${secret}"`, graph: '' }],
    });
    expect(written.status, JSON.stringify(written.body)).toBe(200);
  }, 120_000);
  afterAll(async () => { if (daemon) await stopLiveDaemon(daemon); });

  it.each(['', '/wm', '/wm/quads', '/wm/extraction-status'])('reads the unregistered curator own local draft at %s', async suffix => {
    const result = await request(allowed.token, `/api/knowledge-assets/local-draft${suffix}?contextGraphId=${draftCg}`);
    expect(result.status, JSON.stringify(result.body)).toBe(suffix === '/wm/extraction-status' ? 404 : 200);
    if (suffix === '/wm/quads') expect(JSON.stringify(result.body)).toContain('curator draft content');
  });
  it('does not let another agent read the unregistered curator draft', async () => {
    const result = await request(excluded.token, `/api/knowledge-assets/local-draft/wm/quads?contextGraphId=${draftCg}&agentAddress=${allowed.address}`);
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain('curator draft content');
  });

  const reads = [
    { path: () => `/api/ccl/results?contextGraphId=${privateCg}` },
    { path: () => '/api/ccl/eval', body: () => ({ contextGraphId: privateCg, name: 'policy' }) },
    { path: () => `/api/knowledge-assets/private-asset?contextGraphId=${privateCg}` },
    { path: () => `/api/knowledge-assets/private-asset/wm/quads?contextGraphId=${privateCg}&agentAddress=${allowed.address}` },
    { path: () => `/api/knowledge-assets/swm/share-jobs?contextGraphId=${privateCg}` },
    { path: () => `/api/sub-graph/list?contextGraphId=${privateCg}` },
    { path: () => `/api/context-graph/${privateCg}/participants` },
    { path: () => `/api/publisher/job-by-intent?contextGraphId=${privateCg}&name=private-asset` },
    { path: () => `/api/publisher/journal?contextGraphId=${privateCg}&name=private-asset` },
    { path: () => `/api/epcis/events?contextGraphId=${privateCg}` },
    { path: () => '/api/genui/render', body: () => ({ contextGraphId: privateCg, entityUri: 'urn:private:entity', libraryPrompt: 'library' }) },
  ];
  it.each(reads)('refuses another registered agent on $path', async row => {
    const response = await request(excluded.token, row.path(), row.body?.());
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(JSON.stringify(response.body)).not.toContain('urn:private:entity');
  });
  it('returns the actual private WM rows to their allowed bearer agent', async () => {
    const response = await request(allowed.token, `/api/knowledge-assets/private-asset/wm/quads?contextGraphId=${privateCg}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(JSON.stringify(response.body)).toContain(secret);
  });
  it('preserves the node operator’s explicit cross-agent draft inspection', async () => {
    const response = await getJson(daemon, `/api/knowledge-assets/private-asset/wm/quads?contextGraphId=${privateCg}&agentAddress=${allowed.address}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(JSON.stringify(response.body)).toContain(secret);
  });
  it('still lets the excluded private-graph caller inspect its own CG', async () => {
    const response = await request(excluded.token, `/api/context-graph/${callerCg}/participants`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(JSON.stringify(response.body).toLowerCase()).toContain(excluded.address.toLowerCase());
  });
});
