import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeStartSupervisorLivenessWatcher } from '../src/cli-supervisor.js';
import { startLivenessWatcher } from '../src/daemon/supervisor-liveness.js';
import { logPath } from '../src/config.js';

it('retains real probe history in the parent log across watcher replacement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dkg-watchdog-log-'));
  const oldHome = process.env.DKG_HOME;
  let stop: (() => void) | undefined;
  let stalled = true;
  const server = createServer((_request, response) => {
    if (!stalled) { response.writeHead(401); response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  let kills = 0;
  const start = () => maybeStartSupervisorLivenessWatcher({ kill: () => { kills++; return true; } },
    { enabled: true, shutdownGraceMs: 30_000 }, {
      readPort: async () => port, loadApiHost: async () => '127.0.0.1', apiPortExists: () => true,
      startWatcher: (options) => startLivenessWatcher({ ...options, intervalMs: 30, timeoutMs: 15 }),
    });
  try {
    process.env.DKG_HOME = home;
    stop = await start();
    await expect.poll(() => kills).toBe(1);
    stop();
    const path = logPath();
    await expect.poll(async () => (await readFile(path, 'utf8')).includes('liveness restart')).toBe(true);
    const before = await readFile(path, 'utf8');
    const restart = JSON.parse(before.split('\n').find((line) => line.includes('liveness restart'))!.split('liveness restart ')[1]);
    expect(restart.recent).toHaveLength(5);
    expect(restart.recent.every((item: { probe: { outcome: string; connected: boolean } }) =>
      item.probe.outcome === 'deadline' && item.probe.connected)).toBe(true);
    stalled = false;
    stop = await start();
    await expect.poll(async () => (await readFile(path, 'utf8')).includes('"statusCode":401')).toBe(true);
    stop();
    const after = await readFile(path, 'utf8');
    expect(after).toContain(before);
    const healthy = JSON.parse(after.split('\n').find((line) => line.includes('"statusCode":401'))!.split('liveness probe ')[1]);
    expect(healthy.generation).not.toBe(restart.generation);
    expect(kills).toBe(1);
    expect(after).not.toContain('127.0.0.1');
  } finally {
    stop?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (oldHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
