import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authHeaders, startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

const DAY = 24 * 60 * 60 * 1000;
const routes = ['/api/settings/shared-memory-ttl', '/api/settings/workspace-ttl'];

// The built daemon, agent, store and HTTP dispatcher are real. A mock chain
// isolates HTTP settings behavior from unrelated network/contract availability.
describe('daemon shared-memory TTL route wiring', () => {
  let daemon: LiveDaemon | undefined;
  beforeAll(async () => {
    daemon = await startLiveDaemon({
      extraConfig: {
        chain: { type: 'mock' }, sharedMemoryTtlMs: DAY, workspaceTtlMs: DAY,
        telemetry: { enabled: false, logs: { exporter: 'none' }, traces: { enabled: false }, metrics: { enabled: false } },
      },
    });
  }, 60_000);
  afterAll(async () => { await stopLiveDaemon(daemon); });

  it.each(routes)('persists PUT and serves both aliases through the daemon at %s', async route => {
    const ttlDays = route.endsWith('/workspace-ttl') ? 0.5 : 2;
    const response = await fetch(daemon!.base + route, {
      method: 'PUT', headers: authHeaders(daemon!), body: JSON.stringify({ ttlDays }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ttlMs: ttlDays * DAY, ttlDays });
    const persisted = JSON.parse(await readFile(join(daemon!.home, 'config.json'), 'utf8'));
    expect(persisted).toMatchObject({ sharedMemoryTtlMs: ttlDays * DAY, workspaceTtlMs: ttlDays * DAY });
    for (const alias of routes) {
      const read = await fetch(daemon!.base + alias, { headers: authHeaders(daemon!) });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ ttlMs: ttlDays * DAY });
    }
  });

  it.each(routes)('rejects an out-of-range TTL without publishing configuration through %s', async route => {
    const path = join(daemon!.home, 'config.json');
    const before = await readFile(path, 'utf8');
    const response = await fetch(daemon!.base + route, {
      method: 'PUT', headers: authHeaders(daemon!), body: '{"ttlDays":100000001}',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('sharedMemoryTtlMs') });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each([
    { setting: 'llm', submitted: { apiKey: 'local-fixture-key', model: 'fixture-model' }, expected: { configured: true, model: 'fixture-model' } },
    { setting: 'telemetry', submitted: { enabled: true }, expected: { enabled: true } },
  ])('wires the transactional $setting adapter into the built daemon', async ({ setting, submitted, expected }) => {
    const path = join(daemon!.home, 'config.json');
    const before = JSON.parse(await readFile(path, 'utf8'));
    const response = await fetch(daemon!.base + '/api/settings/' + setting, {
      method: 'PUT', headers: authHeaders(daemon!), body: JSON.stringify(submitted),
    });
    expect(response.status).toBe(200);
    const read = await fetch(daemon!.base + '/api/settings/' + setting, { headers: authHeaders(daemon!) });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject(expected);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved[setting]).toMatchObject(submitted);
    expect(saved.sharedMemoryTtlMs).toBe(before.sharedMemoryTtlMs);
    expect(saved.workspaceTtlMs).toBe(before.workspaceTtlMs);
  });
});
