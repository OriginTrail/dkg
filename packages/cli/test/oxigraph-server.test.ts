/**
 * Supervised Oxigraph server — unit tests with injected spawn + fetch.
 *
 * Locks in:
 *   - spawns `oxigraph serve --location <dir> --bind <host:port>` and
 *     resolves once the ASK probe answers;
 *   - rejects (and kills the child) when the server never becomes ready;
 *   - stop() sends SIGTERM and resolves on child exit;
 *   - an unexpected child exit triggers a restart with backoff;
 *   - a child exit AFTER stop() does NOT restart.
 *
 * No real binary, no real ports.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killArgs: string[] = [];
  kill(signal?: string) {
    this.killArgs.push(signal ?? 'SIGTERM');
    // Emulate a process that honours SIGTERM promptly.
    queueMicrotask(() => this.emitExit(0, signal ?? null));
    return true;
  }
  emitStderr(line: string) {
    this.stderr.emit('data', Buffer.from(line));
  }
  emitExit(code: number | null, signal: string | null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/**
 * @param onSpawn optional hook invoked with each freshly-spawned child, used
 *   to simulate a child that dies on bind (EADDRINUSE) during startup.
 */
function spawnFactory(onSpawn?: (c: FakeChild) => void) {
  const children: FakeChild[] = [];
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    onSpawn?.(c);
    return c as any;
  }) as any;
  return { spawn, children, calls };
}

describe('startOxigraphServer', () => {
  it('spawns with serve flags and resolves once the probe answers', async () => {
    const { spawn, calls } = spawnFactory();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));

    const handle = await startOxigraphServer({
      binaryPath: '/bin/oxigraph',
      location: '/data/oxi',
      port: 7878,
      readyIntervalMs: 5,
      io: { spawn, fetch: fetchMock as any },
    });

    expect(calls[0]).toEqual({
      cmd: '/bin/oxigraph',
      args: ['serve', '--location', '/data/oxi', '--bind', '127.0.0.1:7878'],
    });
    expect(handle.queryEndpoint).toBe('http://127.0.0.1:7878/query');
    expect(handle.updateEndpoint).toBe('http://127.0.0.1:7878/update');
    await handle.stop();
  });

  it('kills the child and rejects when the server never becomes ready', async () => {
    const { spawn, children } = spawnFactory();
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      startOxigraphServer({
        binaryPath: '/bin/oxigraph',
        location: '/data/oxi',
        port: 7900,
        readyTimeoutMs: 120,
        readyIntervalMs: 20,
        io: { spawn, fetch: fetchMock as any },
      }),
    ).rejects.toThrow(/did not become ready/);

    expect(children[0].killArgs.length).toBeGreaterThan(0);
  });

  it('does NOT adopt a foreign SPARQL server when the spawned child dies on bind', async () => {
    // The child dies on EADDRINUSE during startup, but a foreign server on
    // the same port answers the probe with 200. We must fail fast, not
    // return a handle wired to the unrelated server.
    const { spawn, children } = spawnFactory((c) => {
      c.emitStderr('error: Address already in use (os error 48)');
      queueMicrotask(() => c.emitExit(1, null));
    });
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));

    await expect(
      startOxigraphServer({
        binaryPath: '/bin/oxigraph',
        location: '/data/oxi',
        port: 7878,
        readyTimeoutMs: 200,
        readyIntervalMs: 10,
        io: { spawn, fetch: fetchMock as any },
      }),
    ).rejects.toThrow(/exited during startup|already in use/i);

    // Exactly one spawn — a startup-phase exit must NOT trigger a restart.
    expect(children.length).toBe(1);
  });

  it('killSync sends SIGTERM synchronously', async () => {
    const { spawn, children } = spawnFactory();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const handle = await startOxigraphServer({
      binaryPath: '/bin/oxigraph',
      location: '/data/oxi',
      port: 7878,
      readyIntervalMs: 5,
      io: { spawn, fetch: fetchMock as any },
    });

    handle.killSync();
    expect(children[0].killArgs).toContain('SIGTERM');
  });

  it('stop() sends SIGTERM and resolves on exit', async () => {
    const { spawn, children } = spawnFactory();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const handle = await startOxigraphServer({
      binaryPath: '/bin/oxigraph',
      location: '/data/oxi',
      port: 7878,
      readyIntervalMs: 5,
      io: { spawn, fetch: fetchMock as any },
    });

    await handle.stop();
    expect(children[0].killArgs).toContain('SIGTERM');
    // Idempotent.
    await handle.stop();
  });

  it('restarts the child on an unexpected exit', async () => {
    const { spawn, children, calls } = spawnFactory();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const handle = await startOxigraphServer({
      binaryPath: '/bin/oxigraph',
      location: '/data/oxi',
      port: 7878,
      readyIntervalMs: 5,
      restartBackoffBaseMs: 10,
      io: { spawn, fetch: fetchMock as any },
    });

    expect(calls.length).toBe(1);
    // Simulate a crash (not via stop()).
    children[0].emitExit(1, null);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(2);

    await handle.stop();
  });

  it('does NOT adopt a foreign server when a post-crash respawn dies on bind', async () => {
    // After a healthy boot the server crashes. While it's down another
    // process grabs the port: every respawn now dies on EADDRINUSE, yet a
    // foreign server answers the probe with 200. The supervisor must NOT
    // settle as "ready" against that foreign 200 — it must keep retrying
    // (ownership re-validated each time), so the agent never silently hits
    // an unrelated SPARQL server.
    let spawnCount = 0;
    const { spawn, children, calls } = spawnFactory((c) => {
      spawnCount += 1;
      // Child #1 is the healthy startup child; every revive child dies on
      // bind as if the port is now held by someone else.
      if (spawnCount >= 2) {
        c.emitStderr('error: Address already in use (os error 48)');
        queueMicrotask(() => c.emitExit(1, null));
      }
    });
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const handle = await startOxigraphServer({
      binaryPath: '/bin/oxigraph',
      location: '/data/oxi',
      port: 7878,
      readyTimeoutMs: 50,
      readyIntervalMs: 5,
      restartBackoffBaseMs: 5,
      restartBackoffMaxMs: 10,
      io: { spawn, fetch: fetchMock as any },
    });

    expect(calls.length).toBe(1);
    // Healthy child crashes → revive respawns, but every respawn dies on bind.
    children[0].emitExit(1, null);
    await new Promise((r) => setTimeout(r, 60));
    // It kept trying instead of adopting the foreign 200: >2 spawns.
    expect(calls.length).toBeGreaterThan(2);

    await handle.stop();
  });

  it('does NOT restart after stop()', async () => {
    const { spawn, calls } = spawnFactory();
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const handle = await startOxigraphServer({
      binaryPath: '/bin/oxigraph',
      location: '/data/oxi',
      port: 7878,
      readyIntervalMs: 5,
      restartBackoffBaseMs: 10,
      io: { spawn, fetch: fetchMock as any },
    });

    await handle.stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.length).toBe(1);
  });
});
