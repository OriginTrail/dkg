import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ownProcess } from '../../../scripts/testing/owned-process.mjs';
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

  function runCli(args: string[]) {
    return ownProcess(spawn(process.execPath, [
      '--experimental-sqlite', fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...args,
    ], {
      env: { ...process.env, DKG_HOME: daemon!.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    }), { label: 'Separate configuration CLI' });
  }

  it('rejects a separate publisher enable process while a subsequent daemon TTL update survives', async () => {
    const path = join(daemon!.home, 'config.json');
    const before = await readFile(path, 'utf8');
    const publisher = runCli(['publisher', 'enable']);
    try {
      await expect(publisher.waitForExit(15_000)).rejects.toThrow('owned by another process');
      expect((await publisher.closed).code).toBe(1);
      expect(await readFile(path, 'utf8')).toBe(before);

      const response = await fetch(daemon!.base + routes[0], {
        method: 'PUT', headers: authHeaders(daemon!), body: JSON.stringify({ ttlDays: 3 }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, ttlMs: 3 * DAY });
      const saved = JSON.parse(await readFile(path, 'utf8'));
      expect(saved.publisher).toEqual(JSON.parse(before).publisher);
      expect(saved).toMatchObject({ sharedMemoryTtlMs: 3 * DAY, workspaceTtlMs: 3 * DAY });
      for (const alias of routes) {
        const read = await fetch(daemon!.base + alias, { headers: authHeaders(daemon!) });
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject({ ttlMs: 3 * DAY });
      }
    } finally { await publisher.stop(); }
  });

  it('preserves create and subscribe --save through the daemon durable subscription owner', async () => {
    const path = join(daemon!.home, 'config.json');
    const before = await readFile(path, 'utf8');
    const create = runCli(['context-graph', 'create', 'config-owner-saved', '--save']);
    let id: string;
    try {
      const result = await create.waitForExit(15_000);
      const match = result.stdout.match(/^\s*ID:\s+(.+)$/m);
      expect(match).not.toBeNull();
      id = match![1].trim();
      expect(result.stdout).toContain('Saved subscription');
    } finally { await create.stop(); }
    const subscribe = runCli(['subscribe', id, '--save']);
    try {
      const result = await subscribe.waitForExit(15_000);
      expect(result.stdout).toContain('Synchronization mode: always on');
    } finally { await subscribe.stop(); }
    // Check the real durable subscription record independently of CLI text.
    const db = new DatabaseSync(join(daemon!.home, 'node-ui.db'), { readOnly: true });
    try {
      expect(db.prepare('SELECT subscribed FROM context_graph_subscriptions WHERE context_graph_id = ?').get(id))
        .toMatchObject({ subscribed: 1 });
    } finally { db.close(); }
    expect(await readFile(path, 'utf8')).toBe(before);
  });

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
