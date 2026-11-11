import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { describeDaemonStartupFailure, waitForDaemonReady } from '../src/daemon/startup-wait.js';

function simulation(readyAt = 39_000) {
  let now = 0;
  let alive = true;
  const child = Object.assign(new EventEmitter(), { pid: 101, exitCode: null, signalCode: null }) as unknown as ChildProcess;
  const probes: number[] = [];
  return {
    child, probes, elapsed: () => now, die: () => { alive = false; },
    dependencies: {
      readPid: async (): Promise<number | null> => 102,
      readPort: async () => 9200,
      isRunning: () => alive,
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
      probe: async (_port: number, _host: string, timeoutMs: number) => {
        probes.push(timeoutMs);
        return now >= readyAt;
      },
    },
  };
}

describe('detached daemon startup readiness', () => {
  it('waits for a valid 39s startup with the default bounded policy', async () => {
    const h = simulation();
    h.dependencies.readPid = async () => h.elapsed() < 39_000 ? null : 102;
    await expect(waitForDaemonReady(h.child, '127.0.0.1', undefined, h.dependencies))
      .resolves.toEqual({ status: 'ready', pid: 102, port: 9200 });
    expect(h.elapsed()).toBe(39_000);
  });

  it('does not report a live PID and port as ready before the HTTP probe succeeds', async () => {
    const h = simulation(Infinity);
    const result = await waitForDaemonReady(h.child, '127.0.0.1', 1300, h.dependencies);
    expect(result).toEqual({ status: 'starting', pid: 102, timeoutMs: 1300 });
    expect(h.elapsed()).toBe(1300);
    expect(h.probes).toEqual([1300, 800, 300]);
    expect(describeDaemonStartupFailure(result as { status: 'starting'; pid: number; timeoutMs: number }))
      .toContain('still starting after 1.3s');
  });

  it('fails promptly when the supervisor exits before readiness', async () => {
    const h = simulation(Infinity);
    const sleep = h.dependencies.sleep;
    h.dependencies.sleep = async ms => { await sleep(ms); h.die(); };
    await expect(waitForDaemonReady(h.child, 'localhost', undefined, h.dependencies))
      .resolves.toMatchObject({ status: 'failed', reason: expect.stringContaining('exited before API readiness') });
    expect(h.elapsed()).toBe(500);
  });

  it('reports a spawn error and removes its listener', async () => {
    const h = simulation(Infinity);
    h.dependencies.readPid = async () => { h.child.emit('error', new Error('spawn refused')); return 102; };
    await expect(waitForDaemonReady(h.child, 'localhost', undefined, h.dependencies))
      .resolves.toMatchObject({ status: 'failed', reason: expect.stringContaining('spawn refused') });
    expect(h.child.listenerCount('error')).toBe(0);
  });

  it('rejects a readiness response from a worker replaced during the probe', async () => {
    const h = simulation(0);
    let reads = 0;
    h.dependencies.readPid = async () => ++reads === 1 ? 102 : 103;
    const result = await waitForDaemonReady(h.child, 'localhost', 500, h.dependencies);
    expect(result.status).toBe('starting');
  });

  it.each([0, -1, NaN, Infinity, 2 ** 31, 1.5])('refuses invalid timeout %s', async timeout => {
    const h = simulation();
    await expect(waitForDaemonReady(h.child, 'localhost', timeout, h.dependencies)).rejects.toThrow('--timeout');
  });
});

const serverSource = `
  const http = require('node:http');
  let ready = false;
  process.on('message', message => { if (message === 'ready') ready = true; });
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/status' || request.method !== 'HEAD') { response.writeHead(404).end(); return; }
    response.writeHead(ready ? 200 : 503).end();
    process.send({ probe: true, ready });
  });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
`;

describe('startup readiness through a real child HTTP server', () => {
  it('waits past the early startup 503 and succeeds only after the child serves 200', async () => {
    const child = spawn(process.execPath, ['-e', serverSource], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const observations: boolean[] = [];
    try {
      const [started] = await once(child, 'message');
      const port = (started as { port: number }).port;
      child.on('message', message => {
        const row = message as { probe?: boolean; ready?: boolean };
        if (row.probe) { observations.push(row.ready!); if (!row.ready) child.send('ready'); }
      });
      await expect(waitForDaemonReady(child, '127.0.0.1', 5000, {
        readPid: async () => child.pid!, readPort: async () => port,
      })).resolves.toEqual({ status: 'ready', pid: child.pid, port });
      expect(observations).toContain(false);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });

  it('leaves a live but unready child running and reports a bounded starting result', async () => {
    const child = spawn(process.execPath, ['-e', serverSource], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      const [started] = await once(child, 'message');
      const result = await waitForDaemonReady(child, '127.0.0.1', 100, {
        readPid: async () => child.pid!, readPort: async () => (started as { port: number }).port,
      });
      expect(result).toEqual({ status: 'starting', pid: child.pid, timeoutMs: 100 });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
});
