/**
 * Launch-option forwarding from `startManagedOxigraph` into
 * `startOxigraphServer`.
 *
 * The end-to-end suite in `oxigraph-managed.test.ts` runs without mocks on
 * purpose, so it can only observe what the spawned child exposes — and the WAL
 * maintenance threshold is never a command-line argument, never in the
 * rewritten store config, and only takes effect an hour into a loaded node's
 * life. That left the one line that carries `plan.walRestartThresholdBytes`
 * into the supervisor untested: deleting it silently reverted every operator
 * override to the 4 GiB default.
 *
 * This file therefore stubs the two module boundaries `startManagedOxigraph`
 * calls out to, so the options object handed to the supervisor can be asserted
 * directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { startOxigraphServer, resolveOxigraphBinary } = vi.hoisted(() => ({
  startOxigraphServer: vi.fn(),
  resolveOxigraphBinary: vi.fn(),
}));

vi.mock('../src/daemon/oxigraph-server.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/daemon/oxigraph-server.js')>(),
  startOxigraphServer,
}));

vi.mock('../src/daemon/oxigraph-binary.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/daemon/oxigraph-binary.js')>(),
  resolveOxigraphBinary,
}));

import {
  DEFAULT_OXIGRAPH_PORT,
  MANAGED_OXIGRAPH_BACKEND,
  startManagedOxigraph,
} from '../src/daemon/oxigraph-managed.js';
import { DEFAULT_WAL_RESTART_THRESHOLD_BYTES } from '../src/daemon/oxigraph-wal-maintenance.js';

function stubHandle(port: number) {
  return {
    host: '127.0.0.1',
    port,
    queryEndpoint: `http://127.0.0.1:${port}/query`,
    updateEndpoint: `http://127.0.0.1:${port}/update`,
    requestRestart: vi.fn(() => true),
    registerStoreActivity: vi.fn(() => ({ report: vi.fn(), dispose: vi.fn() })),
    getRecoveryState: vi.fn(() => ({
      recovering: false,
      admissionsPaused: false,
      generation: 0,
    })),
    stop: vi.fn(async () => {}),
    killSync: vi.fn(),
  };
}

function startedWith(): Record<string, unknown> {
  expect(startOxigraphServer).toHaveBeenCalledOnce();
  return startOxigraphServer.mock.calls[0]![0] as Record<string, unknown>;
}

describe('startManagedOxigraph launch-option forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOxigraphBinary.mockResolvedValue({
      path: '/nonexistent/oxigraph',
      source: 'bundled',
      version: '0.6.0',
    });
    startOxigraphServer.mockImplementation(
      async (options: { port: number }) => stubHandle(options.port),
    );
  });

  it('hands the operator WAL threshold to the supervisor unchanged', async () => {
    const result = await startManagedOxigraph({
      config: {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { walRestartThresholdBytes: 1_234 },
        },
      },
      dataDir: '/data',
      platform: 'linux',
    });

    expect(result).not.toBeNull();
    expect(startedWith().walRestartThresholdBytes).toBe(1_234);
  });

  it('hands the canonical default to the supervisor when nothing is configured', async () => {
    await startManagedOxigraph({
      config: { store: { backend: MANAGED_OXIGRAPH_BACKEND } },
      dataDir: '/data',
      platform: 'linux',
    });

    expect(startedWith().walRestartThresholdBytes)
      .toBe(DEFAULT_WAL_RESTART_THRESHOLD_BYTES);
    expect(startedWith().port).toBe(DEFAULT_OXIGRAPH_PORT);
  });
});
