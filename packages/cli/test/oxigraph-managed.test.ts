/**
 * Managed Oxigraph orchestration — unit tests.
 *
 * `planManagedOxigraph` (pure) is tested directly. `startManagedOxigraph`
 * is tested with the binary-fetch and server-spawn modules mocked, so we
 * assert the config-rewrite contract (oxigraph-server → sparql-http with
 * loopback endpoints + managedByDkg) without touching disk or processes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/daemon/oxigraph-binary.js', () => ({
  ensureOxigraphBinary: vi.fn(async () => '/cache/oxigraph-v0.5.8'),
}));
vi.mock('../src/daemon/oxigraph-server.js', () => ({
  startOxigraphServer: vi.fn(async (opts: any) => ({
    host: '127.0.0.1',
    port: opts.port,
    queryEndpoint: `http://127.0.0.1:${opts.port}/query`,
    updateEndpoint: `http://127.0.0.1:${opts.port}/update`,
    stop: async () => {},
    killSync: () => {},
  })),
}));

import {
  planManagedOxigraph,
  resolveManagedOxigraphPort,
  startManagedOxigraph,
  MANAGED_OXIGRAPH_BACKEND,
  DEFAULT_OXIGRAPH_PORT,
} from '../src/daemon/oxigraph-managed.js';
import { ensureOxigraphBinary } from '../src/daemon/oxigraph-binary.js';
import { startOxigraphServer } from '../src/daemon/oxigraph-server.js';

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
    expect(plan!.location).toBe('/data/oxigraph-data');
    expect(plan!.cacheDir).toBe('/data/oxigraph');
    expect(plan!.largeLiteralStorage).toEqual({
      enabled: true,
      thresholdBytes: undefined,
      directory: '/data/literal-blobs',
    });
    expect(plan!.storeConfigTemplate).toEqual({
      backend: 'sparql-http',
      options: { managedByDkg: true },
    });
  });

  it('honours operator overrides for port and location', () => {
    const plan = planManagedOxigraph(
      { store: { backend: MANAGED_OXIGRAPH_BACKEND, options: { port: 9999, location: '/mnt/oxi' } } },
      '/data',
    );
    expect(plan!.port).toBe(9999);
    expect(plan!.location).toBe('/mnt/oxi');
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
      directory: '/data/swm-public-snapshots',
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
});

describe('startManagedOxigraph', () => {
  beforeEach(() => {
    vi.mocked(ensureOxigraphBinary).mockClear();
    vi.mocked(startOxigraphServer).mockClear();
  });

  it('returns null for non-managed backends without fetching or spawning', async () => {
    const result = await startManagedOxigraph({
      config: { store: { backend: 'oxigraph-worker' } },
      dataDir: '/data',
    });
    expect(result).toBeNull();
    expect(ensureOxigraphBinary).not.toHaveBeenCalled();
    expect(startOxigraphServer).not.toHaveBeenCalled();
  });

  it('rewrites store to sparql-http with loopback endpoints + managedByDkg', async () => {
    const result = await startManagedOxigraph({
      config: { store: { backend: MANAGED_OXIGRAPH_BACKEND } },
      dataDir: '/data',
    });
    expect(result).not.toBeNull();
    expect(ensureOxigraphBinary).toHaveBeenCalledOnce();
    expect(startOxigraphServer).toHaveBeenCalledOnce();
    expect(result!.storeConfig).toEqual({
      backend: 'sparql-http',
      options: {
        managedByDkg: true,
        queryEndpoint: `http://127.0.0.1:${DEFAULT_OXIGRAPH_PORT}/query`,
        updateEndpoint: `http://127.0.0.1:${DEFAULT_OXIGRAPH_PORT}/update`,
      },
    });
    expect(result!.largeLiteralStorage.directory).toBe('/data/literal-blobs');
  });
});
