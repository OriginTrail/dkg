/**
 * Managed Oxigraph orchestration — NO mocks.
 *
 * `planManagedOxigraph` / `resolveManagedOxigraphPort` (pure) are tested
 * directly. `startManagedOxigraph` previously had the binary-fetch and
 * server-spawn MODULES replaced by vitest module mocks — the orchestration was never actually
 * proven. It now runs FOR REAL, end to end: the pinned Oxigraph binary is
 * really downloaded (sha256-verified, into a STABLE tmp cache so the ~10MB
 * fetch happens once per machine — exactly what production does on a node's
 * first boot), the REAL oxigraph server is spawned on a real port, the
 * rewritten sparql-http endpoints answer a REAL SPARQL ASK, and stop()
 * really releases the port.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  planManagedOxigraph,
  resolveManagedOxigraphPort,
  startManagedOxigraph,
  MANAGED_OXIGRAPH_BACKEND,
  DEFAULT_OXIGRAPH_PORT,
} from '../src/daemon/oxigraph-managed.js';
import type { OxigraphServerIo } from '../src/daemon/oxigraph-server.js';

describe('planManagedOxigraph', () => {
  it('returns null for non-oxigraph-server backends', () => {
    expect(planManagedOxigraph({ store: { backend: 'oxigraph-worker' } }, '/data')).toBeNull();
    expect(planManagedOxigraph({ store: { backend: 'sparql-http' } }, '/data')).toBeNull();
    expect(planManagedOxigraph({}, '/data')).toBeNull();
  });

  it('defaults port, location, cacheDir and blob dir under the data dir', () => {
    const plan = planManagedOxigraph({ store: { backend: MANAGED_OXIGRAPH_BACKEND } }, '/data');
    expect(plan).not.toBeNull();
    expect(plan!.port).toBe(DEFAULT_OXIGRAPH_PORT);
    expect(plan!.readyTimeoutMs).toBeUndefined();
    expect(plan!.location).toBe(join('/data', 'oxigraph-data'));
    expect(plan!.cacheDir).toBe(join('/data', 'oxigraph'));
    expect(plan!.largeLiteralStorage).toEqual({
      enabled: true,
      thresholdBytes: undefined,
      directory: join('/data', 'literal-blobs'),
    });
    expect(plan!.storeConfigTemplate).toEqual({
      backend: 'sparql-http',
      options: { managedByDkg: true },
    });
  });

  it('honours operator overrides for port, location, cacheDir and readiness timeout', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: {
            port: 9999,
            location: '/mnt/oxi',
            cacheDir: '/mnt/oxi-bin',
            readyTimeoutMs: 180_000,
          },
        },
      },
      '/data',
    );
    expect(plan!.port).toBe(9999);
    expect(plan!.location).toBe('/mnt/oxi');
    expect(plan!.cacheDir).toBe('/mnt/oxi-bin');
    expect(plan!.readyTimeoutMs).toBe(180_000);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '180000',
    null,
  ])('ignores invalid readiness timeout %j', (readyTimeoutMs) => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { readyTimeoutMs },
        },
      },
      '/data',
    );

    expect(plan!.readyTimeoutMs).toBeUndefined();
  });

  it('resolveManagedOxigraphPort rejects out-of-range values', () => {
    expect(resolveManagedOxigraphPort({ port: 70000 })).toBe(DEFAULT_OXIGRAPH_PORT);
    expect(resolveManagedOxigraphPort({ port: 7878 })).toBe(7878);
  });

  it('rejects an out-of-range port and falls back to the default', () => {
    const plan = planManagedOxigraph(
      { store: { backend: MANAGED_OXIGRAPH_BACKEND, options: { port: 70000 } } },
      '/data',
    );
    expect(plan!.port).toBe(DEFAULT_OXIGRAPH_PORT);
  });

  it('respects an operator-configured largeLiteralStorage', () => {
    const plan = planManagedOxigraph(
      {
        store: { backend: MANAGED_OXIGRAPH_BACKEND },
        largeLiteralStorage: { enabled: false, directory: '/custom/blobs' },
      },
      '/data',
    );
    expect(plan!.largeLiteralStorage).toEqual({
      enabled: false,
      thresholdBytes: undefined,
      directory: '/custom/blobs',
    });
  });

  it('preserves graphSetIndex options through the managed store rewrite plan', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          graphSetIndex: { enabled: true, revalidateMs: 5_000 },
        },
      },
      '/data',
    );
    expect(plan!.storeConfigTemplate.graphSetIndex).toEqual({ enabled: true, revalidateMs: 5_000 });
  });

  it('leaves sharedMemoryPublicSnapshotStorage undefined when disabled/absent', () => {
    expect(
      planManagedOxigraph({ store: { backend: MANAGED_OXIGRAPH_BACKEND } }, '/data')!
        .sharedMemoryPublicSnapshotStorage,
    ).toBeUndefined();
    expect(
      planManagedOxigraph(
        {
          store: { backend: MANAGED_OXIGRAPH_BACKEND },
          sharedMemoryPublicSnapshotStorage: { enabled: false },
        },
        '/data',
      )!.sharedMemoryPublicSnapshotStorage,
    ).toBeUndefined();
  });

  it('defaults the snapshot dir under the data dir when enabled without one', () => {
    const plan = planManagedOxigraph(
      {
        store: { backend: MANAGED_OXIGRAPH_BACKEND },
        sharedMemoryPublicSnapshotStorage: { enabled: true },
      },
      '/data',
    );
    expect(plan!.sharedMemoryPublicSnapshotStorage).toEqual({
      enabled: true,
      directory: join('/data', 'swm-public-snapshots'),
    });
  });

  it('respects an operator-configured snapshot directory', () => {
    const plan = planManagedOxigraph(
      {
        store: { backend: MANAGED_OXIGRAPH_BACKEND },
        sharedMemoryPublicSnapshotStorage: { enabled: true, directory: '/custom/snaps' },
      },
      '/data',
    );
    expect(plan!.sharedMemoryPublicSnapshotStorage).toEqual({
      enabled: true,
      directory: '/custom/snaps',
    });
  });

  it('preserves graphSetIndex options through the managed store rewrite plan', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          graphSetIndex: { enabled: true, revalidateMs: 5_000 },
        },
      },
      '/data',
    );
    expect(plan!.storeConfigTemplate.graphSetIndex).toEqual({ enabled: true, revalidateMs: 5_000 });
  });
});

// A real free port from the OS (probe listener closed before reuse).
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function neverReadyChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  let signalCode: NodeJS.Signals | null = null;
  Object.defineProperties(child, {
    exitCode: { get: () => null },
    signalCode: { get: () => signalCode },
  });
  child.stderr = new PassThrough();
  child.kill = ((signal: NodeJS.Signals = 'SIGTERM') => {
    signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  }) as ChildProcess['kill'];
  return child;
}

async function observeManagedStartupTimeout(opts: {
  configuredTimeoutMs: number;
  callerTimeoutMs?: number;
}): Promise<{ settledAfterOnePoll: boolean; error: unknown }> {
  const binDir = await mkdtemp(join(tmpdir(), 'oxi-managed-bin-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'oxi-managed-timeout-'));
  const binaryPath = join(binDir, 'oxigraph');
  const previousPath = process.env.PATH;
  await writeFile(binaryPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(binaryPath, 0o755);
  process.env.PATH = binDir;

  let notifySpawn!: () => void;
  const spawned = new Promise<void>((resolve) => {
    notifySpawn = resolve;
  });
  const serverIo: Partial<OxigraphServerIo> = {
    spawn: (() => {
      notifySpawn();
      return neverReadyChild();
    }) as OxigraphServerIo['spawn'],
    fetch: (async () => new Response(null, { status: 503 })) as typeof globalThis.fetch,
  };

  vi.useFakeTimers();
  try {
    let outcome: { error: unknown } | undefined;
    const startup = startManagedOxigraph({
      config: {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { readyTimeoutMs: opts.configuredTimeoutMs },
        },
      },
      dataDir,
      platform: 'freebsd',
      readyTimeoutMs: opts.callerTimeoutMs,
      serverIo,
    }).then(
      () => {
        outcome = { error: new Error('managed startup unexpectedly succeeded') };
      },
      (error: unknown) => {
        outcome = { error };
      },
    );

    await spawned;
    await vi.advanceTimersByTimeAsync(600);
    const settledAfterOnePoll = outcome !== undefined;
    if (!outcome) {
      // Before the fix, config was ignored and the 30s server default kept
      // polling. Advance far enough to cleanly stop that red-path child.
      await vi.advanceTimersByTimeAsync(31_000);
    }
    await startup;
    return { settledAfterOnePoll, error: outcome!.error };
  } finally {
    vi.useRealTimers();
    process.env.PATH = previousPath;
    await rm(binDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe('startManagedOxigraph readiness timeout', () => {
  it('passes the configured readiness timeout to the managed server', async () => {
    const observed = await observeManagedStartupTimeout({ configuredTimeoutMs: 20 });

    expect(observed.settledAfterOnePoll).toBe(true);
    expect(observed.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining('within 20ms') }),
    );
  });

  it('prefers an explicit caller readiness timeout over config', async () => {
    const observed = await observeManagedStartupTimeout({
      configuredTimeoutMs: 20,
      callerTimeoutMs: 40,
    });

    expect(observed.settledAfterOnePoll).toBe(true);
    expect(observed.error).toEqual(
      expect.objectContaining({ message: expect.stringContaining('within 40ms') }),
    );
  });
});

describe('startManagedOxigraph (real download + real server)', () => {
  it('returns null for non-managed backends', async () => {
    // Contract: a non-managed backend is a no-op — null result, and nothing
    // observable happens (no cache dir is created, nothing binds a port).
    const result = await startManagedOxigraph({
      config: { store: { backend: 'oxigraph-worker' } },
      dataDir: '/data',
    });
    expect(result).toBeNull();
  });

  it(
    'rewrites store to sparql-http endpoints served by a REAL oxigraph it really downloaded',
    async () => {
      // STABLE cache shared across runs: the first run on a machine really
      // downloads + sha256-verifies the pinned binary (what production does
      // on first boot); later runs prove the cache path.
      const cacheDir = join(tmpdir(), 'dkg-test-oxigraph-cache');
      await mkdir(cacheDir, { recursive: true });
      const dataDir = await mkdtemp(join(tmpdir(), 'oxi-managed-'));
      const port = await freePort();

      const result = await startManagedOxigraph({
        config: {
          store: { backend: MANAGED_OXIGRAPH_BACKEND, options: { port, cacheDir } },
        },
        dataDir,
        log: () => {},
        readyTimeoutMs: 30_000,
      });
      try {
        expect(result).not.toBeNull();
        expect(result!.storeConfig).toEqual({
          backend: 'sparql-http',
          options: {
            managedByDkg: true,
            queryEndpoint: `http://127.0.0.1:${port}/query`,
            updateEndpoint: `http://127.0.0.1:${port}/update`,
          },
        });
        expect(result!.largeLiteralStorage.directory).toBe(join(dataDir, 'literal-blobs'));

        // The rewritten endpoint is served by a REAL oxigraph: a genuine
        // SPARQL ASK over HTTP answers with a boolean result.
        const res = await fetch(String(result!.storeConfig.options.queryEndpoint), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sparql-query',
            Accept: 'application/sparql-results+json',
          },
          body: 'ASK { ?s ?p ?o }',
        });
        expect(res.ok).toBe(true);
        const body = (await res.json()) as { boolean?: boolean };
        expect(typeof body.boolean).toBe('boolean');
      } finally {
        await result?.handle.stop();
        await rm(dataDir, { recursive: true, force: true });
      }

      // stop() really released the port.
      await new Promise((r) => setTimeout(r, 150));
      await expect(
        fetch(`http://127.0.0.1:${port}/query`, { signal: AbortSignal.timeout(400) }),
      ).rejects.toThrow();
    },
    120_000,
  );
});
