import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { configPath, loadConfig, saveConfig, type DkgConfig } from '../src/config.js';
import { handleSharedMemoryTtlSettings } from '../src/daemon/routes/shared-memory-ttl.js';

const DAY = 24 * 60 * 60 * 1000;
const routes = ['/api/settings/shared-memory-ttl', '/api/settings/workspace-ttl'];

describe('shared-memory TTL settings HTTP boundary', () => {
  let directory: string;
  let config: DkgConfig;
  let agent: DKGAgent;
  let server: Server;
  let baseUrl: string;
  const runtimeTtl = () => (agent as unknown as { config: { sharedMemoryTtlMs: number } }).config.sharedMemoryTtlMs;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dkg-ttl-settings-'));
    vi.stubEnv('DKG_HOME', directory);
    expect(configPath()).toBe(join(directory, 'config.json'));
    config = await loadConfig();
    config.sharedMemoryTtlMs = DAY;
    config.workspaceTtlMs = DAY;
    await saveConfig(config);
    agent = await DKGAgent.create({ name: 'ttl-settings', chainAdapter: new MockChainAdapter(), sharedMemoryTtlMs: DAY });
    server = createServer((req, res) => {
      if (!routes.includes(new URL(req.url ?? '/', 'http://localhost').pathname)) {
        res.writeHead(404); res.end(); return;
      }
      void handleSharedMemoryTtlSettings({ req, res, config, agent }).catch(error => {
        res.writeHead(500); res.end(String(error));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing HTTP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await agent?.stop();
    await agent?.store.close();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(routes.flatMap(route => [100000001, Number.MAX_VALUE].map(ttlDays => ({ route, ttlDays }))))(
    'rejects $ttlDays days through $route without changing runtime or persisted config', async ({ route, ttlDays }) => {
      const persistedBefore = await readFile(configPath(), 'utf8');
      const configBefore = structuredClone(config);
      const response = await fetch(baseUrl + route, { method: 'PUT', body: JSON.stringify({ ttlDays }) });
      expect.soft(response.status).toBe(400);
      expect.soft(await response.json()).toMatchObject({ error: expect.stringContaining('sharedMemoryTtlMs') });
      expect.soft(config).toEqual(configBefore);
      expect.soft(runtimeTtl()).toBe(DAY);
      expect.soft(await readFile(configPath(), 'utf8')).toBe(persistedBefore);
      for (const alias of routes) {
        expect.soft(await (await fetch(baseUrl + alias)).json()).toMatchObject({ ttlMs: DAY, ttlDays: 1 });
      }
      config.name = 'unrelated later edit';
      await saveConfig(config);
      expect.soft(JSON.parse(await readFile(configPath(), 'utf8'))).toMatchObject({ sharedMemoryTtlMs: DAY, workspaceTtlMs: DAY });
    },
  );

  it.each(routes.flatMap(route => [0, 0.5, 100000000].map(ttlDays => ({ route, ttlDays }))))(
    'accepts $ttlDays days through $route', async ({ route, ttlDays }) => {
      const ttlMs = ttlDays * DAY;
      const response = await fetch(baseUrl + route, { method: 'PUT', body: JSON.stringify({ ttlDays }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, ttlMs, ttlDays });
      expect(runtimeTtl()).toBe(ttlMs);
      expect(JSON.parse(await readFile(configPath(), 'utf8'))).toMatchObject({ sharedMemoryTtlMs: ttlMs, workspaceTtlMs: ttlMs });
      expect(await (await fetch(baseUrl + route)).json()).toMatchObject({ ttlMs });
    },
  );
});
