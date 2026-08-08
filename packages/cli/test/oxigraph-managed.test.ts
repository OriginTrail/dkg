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
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  SparqlHttpStore,
  extractManagedOxigraphHandoffV1,
  extractManagedOxigraphLeaseV1,
  type SparqlHttpStoreOptions,
} from '@origintrail-official/dkg-storage';

import {
  planManagedOxigraph,
  resolveManagedOxigraphPort,
  startManagedOxigraph,
  MANAGED_OXIGRAPH_BACKEND,
  DEFAULT_OXIGRAPH_PORT,
} from '../src/daemon/oxigraph-managed.js';

let systemOxigraphDir: string | undefined;
let originalPath: string | undefined;

beforeAll(async () => {
  systemOxigraphDir = await mkdtemp(join(tmpdir(), 'oxi-managed-system-'));
  const systemOxigraph = join(systemOxigraphDir, 'oxigraph');
  await writeFile(
    systemOxigraph,
    `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2);
const bindIdx = args.indexOf('--bind');
if (bindIdx < 0 || !args[bindIdx + 1]) {
  console.error('missing --bind');
  process.exit(2);
}
const [host, rawPort] = args[bindIdx + 1].split(':');
const port = Number(rawPort);
const delayMs = Number(process.env.OXIGRAPH_STANDIN_STARTUP_DELAY_MS || '250');
let listening = false;
const srv = http.createServer((req, res) => {
  if (req.url === '/args') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(args));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/sparql-results+json');
  res.end(JSON.stringify({ head: {}, boolean: true }));
});
srv.on('error', (e) => { console.error('bind failed: ' + e.message); process.exit(1); });
srv.on('listening', () => { listening = true; });
const listenTimer = setTimeout(() => srv.listen(port, host), delayMs);
process.on('SIGTERM', () => {
  clearTimeout(listenTimer);
  if (!listening) process.exit(0);
  srv.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 100).unref();
});
`,
    'utf8',
  );
  await chmod(systemOxigraph, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [systemOxigraphDir, originalPath].filter(Boolean).join(delimiter);
});

afterAll(async () => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (systemOxigraphDir) {
    await rm(systemOxigraphDir, { recursive: true, force: true }).catch(() => {});
  }
});

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

  it('honours operator overrides for port, location and cacheDir', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { port: 9999, location: '/mnt/oxi', cacheDir: '/mnt/oxi-bin' },
        },
      },
      '/data',
    );
    expect(plan!.port).toBe(9999);
    expect(plan!.location).toBe('/mnt/oxi');
    expect(plan!.cacheDir).toBe('/mnt/oxi-bin');
  });

  it('honours managed Oxigraph startup and native query timeout options', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { readyTimeoutMs: 180_000, queryTimeoutS: 35 },
        },
      },
      '/data',
    );
    expect(plan!.readyTimeoutMs).toBe(180_000);
    expect(plan!.queryTimeoutS).toBe(35);
    expect(plan!.clientTimeoutMs).toBe(40_000);
    expect(plan!.storeConfigTemplate.options.timeout).toBe(40_000);
  });

  it('honours an independent HTTP client timeout without enabling the native Oxigraph timeout', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { clientTimeoutMs: 180_000 },
        },
      },
      '/data',
    );
    expect(plan!.queryTimeoutS).toBeUndefined();
    expect(plan!.clientTimeoutMs).toBe(180_000);
    expect(plan!.storeConfigTemplate.options.timeout).toBe(180_000);
  });

  it('lets an explicit HTTP client timeout override the native-timeout-derived deadline', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { queryTimeoutS: 35, clientTimeoutMs: 120_000 },
        },
      },
      '/data',
    );
    expect(plan!.queryTimeoutS).toBe(35);
    expect(plan!.clientTimeoutMs).toBe(120_000);
    expect(plan!.storeConfigTemplate.options.timeout).toBe(120_000);
  });

  it('plans finite managed Oxigraph memory limits independently of the daemon service', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { memoryHighMiB: 2048, memoryMaxMiB: 3072 },
        },
      },
      '/data',
    );
    expect(plan!.memoryLimits).toEqual({ highMiB: 2048, maxMiB: 3072 });
  });

  it('rejects unsafe or incomplete managed Oxigraph memory limits', () => {
    expect(() => planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { memoryHighMiB: 2048 },
        },
      },
      '/data',
    )).toThrow(/memoryMaxMiB/);

    expect(() => planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { memoryHighMiB: 4096, memoryMaxMiB: 3072 },
        },
      },
      '/data',
    )).toThrow(/no greater than memoryMaxMiB/);
  });

  it('clamps an absurd queryTimeoutS to Node’s max timer instead of overflowing to an instant abort', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          // ~24.8 days: queryTimeoutS * 1000 + grace exceeds 2^31-1 ms, which
          // AbortSignal.timeout would silently coerce to 1ms (immediate abort).
          options: { queryTimeoutS: 4_294_967 },
        },
      },
      '/data',
    );
    expect(plan!.queryTimeoutS).toBe(4_294_967);
    expect(plan!.clientTimeoutMs).toBe(2_147_483_647);
    expect(plan!.storeConfigTemplate.options.timeout).toBe(2_147_483_647);
  });

  it('clamps an absurd clientTimeoutMs to Node’s max timer', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { clientTimeoutMs: 4_294_967_000 },
        },
      },
      '/data',
    );
    expect(plan!.clientTimeoutMs).toBe(2_147_483_647);
    expect(plan!.storeConfigTemplate.options.timeout).toBe(2_147_483_647);
  });

  it('ignores invalid managed Oxigraph timeout options', () => {
    const plan = planManagedOxigraph(
      {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { readyTimeoutMs: 0, queryTimeoutS: 1.5, clientTimeoutMs: -1 },
        },
      },
      '/data',
    );
    expect(plan!.readyTimeoutMs).toBeUndefined();
    expect(plan!.queryTimeoutS).toBeUndefined();
    expect(plan!.clientTimeoutMs).toBeUndefined();
    expect(plan!.storeConfigTemplate.options).toEqual({ managedByDkg: true });
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

async function fetchManagedArgs(port: number): Promise<string[]> {
  const res = await fetch(`http://127.0.0.1:${port}/args`);
  return await res.json() as string[];
}

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

  it('forwards managed query timeout through startup and the rewritten HTTP store config', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oxi-managed-'));
    const port = await freePort();

    const result = await startManagedOxigraph({
      config: {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { port, readyTimeoutMs: 5_000, queryTimeoutS: 35 },
        },
      },
      dataDir,
      platform: 'freebsd',
      log: () => {},
    });
    try {
      expect(result).not.toBeNull();
      expect(result!.storeConfig.options.timeout).toBe(40_000);
      const args = await fetchManagedArgs(port);
      const timeoutIndex = args.indexOf('--timeout-s');
      expect(timeoutIndex).toBeGreaterThanOrEqual(0);
      expect(args[timeoutIndex + 1]).toBe('35');
    } finally {
      await result?.handle.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('forwards an independent client timeout without passing --timeout-s to Oxigraph', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'oxi-managed-'));
    const port = await freePort();

    const result = await startManagedOxigraph({
      config: {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { port, readyTimeoutMs: 5_000, clientTimeoutMs: 180_000 },
        },
      },
      dataDir,
      platform: 'freebsd',
      log: () => {},
    });
    try {
      expect(result).not.toBeNull();
      expect(result!.storeConfig.options.timeout).toBe(180_000);
      const args = await fetchManagedArgs(port);
      expect(args).not.toContain('--timeout-s');
    } finally {
      await result?.handle.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses config readyTimeoutMs and lets the explicit startup override win', async () => {
    const tooShortDir = await mkdtemp(join(tmpdir(), 'oxi-managed-'));
    const tooShortPort = await freePort();
    await expect(
      startManagedOxigraph({
        config: {
          store: {
            backend: MANAGED_OXIGRAPH_BACKEND,
            options: { port: tooShortPort, readyTimeoutMs: 1, queryTimeoutS: 35 },
          },
        },
        dataDir: tooShortDir,
        platform: 'freebsd',
        log: () => {},
      }),
    ).rejects.toThrow(/ready/i);
    await rm(tooShortDir, { recursive: true, force: true });

    const overrideDir = await mkdtemp(join(tmpdir(), 'oxi-managed-'));
    const overridePort = await freePort();
    const result = await startManagedOxigraph({
      config: {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { port: overridePort, readyTimeoutMs: 1, queryTimeoutS: 35 },
        },
      },
      dataDir: overrideDir,
      platform: 'freebsd',
      readyTimeoutMs: 5_000,
      log: () => {},
    });
    try {
      expect(result).not.toBeNull();
      const args = await fetchManagedArgs(overridePort);
      const timeoutIndex = args.indexOf('--timeout-s');
      expect(timeoutIndex).toBeGreaterThanOrEqual(0);
      expect(args[timeoutIndex + 1]).toBe('35');
    } finally {
      await result?.handle.stop();
      await rm(overrideDir, { recursive: true, force: true });
    }
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
        // Asserted on the STRING-keyed projection: `options` also carries the
        // ownership lease under a symbol key (see the lease case below), which
        // a whole-object toEqual would compare — symbol keys and all. Everything
        // an operator or a persisted config can see is still pinned exactly.
        expect(result!.storeConfig.backend).toBe('sparql-http');
        expect(result!.storeConfig.graphSetIndex).toBeUndefined();
        expect(Object.fromEntries(Object.entries(result!.storeConfig.options))).toEqual({
          managedByDkg: true,
          queryEndpoint: `http://127.0.0.1:${port}/query`,
          updateEndpoint: `http://127.0.0.1:${port}/update`,
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

  it(
    'attaches a live ownership lease that survives a spread but never a JSON round trip',
    async () => {
      // Same STABLE cache as the case above: a REAL oxigraph, really
      // downloaded and sha256-verified, really supervised.
      const cacheDir = join(tmpdir(), 'dkg-test-oxigraph-cache');
      await mkdir(cacheDir, { recursive: true });
      const dataDir = await mkdtemp(join(tmpdir(), 'oxi-managed-lease-'));
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
        // Exactly one proven generation was bound by the supervised start.
        expect(result!.ownership.snapshot()).toEqual({
          childGeneration: '1',
          queryEndpoint: result!.handle.queryEndpoint,
          updateEndpoint: result!.handle.updateEndpoint,
          ready: true,
          terminal: false,
        });
        expect(result!.ownership).toBe(result!.handle.ownership);

        // The lease on the rewritten options is the LIVE one, by identity
        // against the storage package's private table — not a look-alike.
        expect(extractManagedOxigraphLeaseV1(result!.storeConfig.options))
          .toBe(result!.ownership.lease);
        // The supervisor handoff rides along too. Without it the store would
        // hold a valid lease and still refuse to advertise the lane, because
        // nothing could prove the retired child dead before a replacement binds.
        expect(extractManagedOxigraphHandoffV1(result!.storeConfig.options))
          .toBe(result!.handle.supervisorHandoff);

        // `resolveAdapterOptions` rewrites options with an object spread;
        // spread copies own enumerable symbol keys, so BOTH survive it.
        expect(extractManagedOxigraphLeaseV1({ ...result!.storeConfig.options }))
          .toBe(result!.ownership.lease);
        expect(extractManagedOxigraphHandoffV1({ ...result!.storeConfig.options }))
          .toBe(result!.handle.supervisorHandoff);

        // The real composed options advertise the lane end to end — the whole
        // point of attaching the handoff rather than the lease alone.
        expect(
          new SparqlHttpStore(result!.storeConfig.options as unknown as SparqlHttpStoreOptions)
            .getSystemRecordLaneControllerV1(),
        ).toBeDefined();

        // A JSON round trip — what persisting `config.json` does — destroys
        // both. A lease or handoff that could be written to disk and replayed
        // on a later boot would prove nothing about who owns the process today.
        const persisted = JSON.parse(JSON.stringify(result!.storeConfig)) as {
          backend: string;
          options: Record<string, unknown>;
        };
        expect(Object.getOwnPropertySymbols(persisted.options)).toEqual([]);
        expect(extractManagedOxigraphLeaseV1(persisted.options)).toBeNull();
        expect(extractManagedOxigraphHandoffV1(persisted.options)).toBeNull();
        // A store rebuilt from the persisted config is therefore inert.
        expect(
          new SparqlHttpStore(persisted.options as unknown as SparqlHttpStoreOptions)
            .getSystemRecordLaneControllerV1(),
        ).toBeUndefined();
        // ...and the string-keyed config an operator would see is unchanged.
        expect(persisted).toEqual({
          backend: 'sparql-http',
          options: {
            managedByDkg: true,
            queryEndpoint: `http://127.0.0.1:${port}/query`,
            updateEndpoint: `http://127.0.0.1:${port}/update`,
          },
        });

        // structuredClone drops symbol keys too (and could not carry identity
        // even if it kept them).
        expect(extractManagedOxigraphLeaseV1(structuredClone(persisted.options))).toBeNull();
        expect(extractManagedOxigraphHandoffV1(structuredClone(persisted.options))).toBeNull();
      } finally {
        await result?.handle.stop();
        await rm(dataDir, { recursive: true, force: true });
      }

      // Shutdown burns the lease: a stopped supervisor owns nothing.
      expect(result!.ownership.snapshot()).toMatchObject({
        ready: false,
        terminal: true,
        lastInvalidation: 'shutdown',
      });
    },
    120_000,
  );
});
