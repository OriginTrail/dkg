import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DkgHomeFiles, configPath, loadConfig, saveConfig, type DkgConfig } from '../src/config.js';
import * as configuration from '../src/config.js';
import * as filePublication from '../src/fs-utils.js';
import type { SwmExpiryCleanupWorker } from '../../agent/src/swm-expiry-cleanup-worker.js';
import { handleSharedMemoryTtlSettings } from '../src/daemon/routes/shared-memory-ttl.js';
import { isPayloadTooLargeError, jsonResponse, SMALL_BODY_BYTES } from '../src/daemon/http-utils.js';

const DAY = 24 * 60 * 60 * 1000;
const routes = ['/api/settings/shared-memory-ttl', '/api/settings/workspace-ttl'];

describe('shared-memory TTL settings HTTP boundary', () => {
  let directory: string;
  let config: DkgConfig;
  let agent: DKGAgent;
  let server: Server;
  let baseUrl: string;
  let bubbledErrors: unknown[];
  const runtimeTtl = () => (agent as unknown as { config: { sharedMemoryTtlMs: number } }).config.sharedMemoryTtlMs;

  async function seedRetainedOperation() {
    const graph = 'did:dkg:context-graph:ttl-settings/_shared_memory';
    const operation = 'urn:ttl-settings:operation';
    await agent.store.insert([
      { subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/WorkspaceOperation', graph: `${graph}_meta` },
      { subject: operation, predicate: 'http://dkg.io/ontology/publishedAt', object: `"${new Date(Date.now() - DAY / 2).toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, graph: `${graph}_meta` },
      { subject: operation, predicate: 'http://dkg.io/ontology/rootEntity', object: 'urn:ttl-settings:entity', graph: `${graph}_meta` },
      { subject: 'urn:ttl-settings:entity', predicate: 'urn:value', object: '"retained"', graph },
    ]);
    return () => agent.store.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o`);
  }

  beforeEach(async () => {
    bubbledErrors = [];
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
        bubbledErrors.push(error);
        if (isPayloadTooLargeError(error)) {
          jsonResponse(res, 413, { error: error.message });
          return;
        }
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
    vi.restoreAllMocks();
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

  it.each(routes.flatMap(route => [
    '{"ttlDays":-1}', '{"ttlDays":"1"}', '{}', '{"ttlDays":1e309}',
  ].map(body => ({ route, body }))))(
    'rejects invalid TTL input $body through $route without changing configuration', async ({ route, body }) => {
      const persistedBefore = await readFile(configPath(), 'utf8');
      const configBefore = structuredClone(config);
      const response = await fetch(baseUrl + route, { method: 'PUT', body });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'ttlDays must be a finite non-negative number' });
      expect(config).toEqual(configBefore);
      expect(runtimeTtl()).toBe(DAY);
      expect(await readFile(configPath(), 'utf8')).toBe(persistedBefore);
    },
  );

  it.each(routes)('reports an unexpected setter failure as HTTP 500 through %s', async route => {
    const persistedBefore = await readFile(configPath(), 'utf8');
    const configBefore = structuredClone(config);
    vi.spyOn(agent, 'setSharedMemoryTtlMs').mockImplementation(() => { throw new Error('worker failure'); });
    const response = await fetch(baseUrl + route, { method: 'PUT', body: '{"ttlDays":2}' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'worker failure' });
    expect(config).toEqual(configBefore);
    expect(runtimeTtl()).toBe(DAY);
    expect(await readFile(configPath(), 'utf8')).toBe(persistedBefore);
    expect(bubbledErrors).toEqual([]);
  });

  it.each(routes)('keeps retention and stored operations unchanged when persistence fails through %s', async route => {
    const readOperations = await seedRetainedOperation();
    const operationsBefore = await readOperations();
    const persistedBefore = await readFile(configPath(), 'utf8');
    const configBefore = structuredClone(config);
    const setter = vi.spyOn(agent, 'setSharedMemoryTtlMs');
    vi.spyOn(configuration, 'saveConfigSettingsTransaction').mockImplementationOnce(async () => {
      // Force physical cleanup while persistence is unresolved. The previous
      // ordering applies the shorter TTL here and irreversibly deletes the row.
      await agent.cleanupExpiredSharedMemory();
      throw new Error('disk full');
    });
    const response = await fetch(baseUrl + route, { method: 'PUT', body: '{"ttlDays":0.25}' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'disk full' });
    expect.soft(setter).not.toHaveBeenCalled();
    expect.soft(config).toEqual(configBefore);
    expect.soft(runtimeTtl()).toBe(DAY);
    expect.soft(await readFile(configPath(), 'utf8')).toBe(persistedBefore);
    expect.soft(await readOperations()).toEqual(operationsBefore);
  });

  it.each(routes.flatMap(route => ['compatibility helper', 'retained home'].map(saveBoundary => ({ route, saveBoundary }))))(
    'preserves committed TTL when an unrelated $saveBoundary save queues behind $route', async ({ route, saveBoundary }) => {
      const home = new DkgHomeFiles(directory);
      const publish = filePublication.writeFileAtomic;
      let entered!: () => void;
      let release!: () => void;
      const publicationEntered = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      vi.spyOn(filePublication, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
        entered();
        await blocked;
        return publish(...args);
      });
      const changingTtl = fetch(baseUrl + route, { method: 'PUT', body: '{"ttlDays":2}' });
      await publicationEntered;
      config.name = 'concurrent unrelated edit';
      const saving = saveBoundary === 'retained home' ? home.saveConfig(config) : saveConfig(config);
      const otherHome = join(directory, 'other-home');
      vi.stubEnv('DKG_HOME', otherHome);
      try {
        expect(runtimeTtl()).toBe(DAY);
        expect(config.sharedMemoryTtlMs).toBe(DAY);
      } finally {
        release();
        await Promise.allSettled([changingTtl, saving]);
        vi.stubEnv('DKG_HOME', directory);
      }
      const response = await changingTtl;
      await saving;
      expect(response.status).toBe(200);
      expect(runtimeTtl()).toBe(2 * DAY);
      expect(config).toMatchObject({ sharedMemoryTtlMs: 2 * DAY, workspaceTtlMs: 2 * DAY });
      const persisted = JSON.parse(await readFile(home.configPath, 'utf8'));
      expect(persisted).toMatchObject({
        name: 'concurrent unrelated edit', sharedMemoryTtlMs: 2 * DAY, workspaceTtlMs: 2 * DAY,
      });
      expect(persisted.sharedMemoryTtlMs).toBe(runtimeTtl());
      await expect(readFile(join(otherHome, 'config.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(routes)('rolls back persisted configuration and runtime after activation fails through %s', async route => {
    const readOperations = await seedRetainedOperation();
    const operationsBefore = await readOperations();
    const persistedBefore = await readFile(configPath(), 'utf8');
    const configBefore = structuredClone(config);
    const worker = (agent as unknown as { swmExpiryCleanupWorker: SwmExpiryCleanupWorker }).swmExpiryCleanupWorker;
    worker.start();
    const notify = worker.onTtlChanged.bind(worker);
    vi.spyOn(worker, 'onTtlChanged').mockImplementationOnce(() => {
      notify();
      throw new Error('cleanup activation failed');
    });
    const response = await fetch(baseUrl + route, { method: 'PUT', body: '{"ttlDays":0.25}' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'cleanup activation failed' });
    expect(config).toEqual(configBefore);
    expect(runtimeTtl()).toBe(DAY);
    expect(await readFile(configPath(), 'utf8')).toBe(persistedBefore);
    await agent.cleanupExpiredSharedMemory();
    expect(await readOperations()).toEqual(operationsBefore);
  });

  it.each(routes)('preserves the payload-limit error for the HTTP boundary through %s', async route => {
    const persistedBefore = await readFile(configPath(), 'utf8');
    const setter = vi.spyOn(agent, 'setSharedMemoryTtlMs');
    const response = await fetch(baseUrl + route, {
      method: 'PUT', body: JSON.stringify({ ttlDays: 2, padding: 'x'.repeat(SMALL_BODY_BYTES) }),
    });
    expect(response.status).toBe(413);
    expect(bubbledErrors).toHaveLength(1);
    expect(isPayloadTooLargeError(bubbledErrors[0])).toBe(true);
    expect(setter).not.toHaveBeenCalled();
    expect(runtimeTtl()).toBe(DAY);
    expect(await readFile(configPath(), 'utf8')).toBe(persistedBefore);
  });

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
