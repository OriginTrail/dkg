/**
 * Launch-option forwarding from `startManagedOxigraph` into
 * `startOxigraphServer`.
 *
 * The end-to-end suite in `oxigraph-managed.test.ts` runs without mocks on
 * purpose, so it can only observe what the spawned child exposes — and the WAL
 * maintenance threshold is never a command-line argument, never in the
 * rewritten store config, and only takes effect an hour into a loaded node's
 * life. That left the one line that carries `plan.walRestartThresholdBytes`
 * into the supervisor untested: deleting it silently turned every operator's
 * maintenance reopen off, which is what an unset threshold means.
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

  it('hands the operator WAL threshold to the supervisor unchanged and says the reopen is on', async () => {
    const lines: string[] = [];
    const result = await startManagedOxigraph({
      config: {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { walRestartThresholdBytes: 2 * 1024 ** 3 },
        },
      },
      dataDir: '/data',
      platform: 'linux',
      log: line => lines.push(line),
    });

    expect(result).not.toBeNull();
    expect(startedWith().walRestartThresholdBytes).toBe(2 * 1024 ** 3);
    expect(lines.filter(line => line.includes('WAL maintenance reopen'))).toEqual([
      '[oxigraph] WAL maintenance reopen is on: the store is reopened once 2.00 GiB of write-ahead log '
      + 'is retained (store.options.walRestartThresholdBytes)',
    ]);
  });

  it('leaves the WAL maintenance reopen off, without a word, when nothing is configured', async () => {
    const lines: string[] = [];
    await startManagedOxigraph({
      config: { store: { backend: MANAGED_OXIGRAPH_BACKEND } },
      dataDir: '/data',
      platform: 'linux',
      log: line => lines.push(line),
    });

    expect(startedWith()).toHaveProperty('walRestartThresholdBytes', undefined);
    expect(startedWith().port).toBe(DEFAULT_OXIGRAPH_PORT);
    expect(lines.filter(line => line.includes('walRestartThresholdBytes'))).toEqual([]);
  });

  it.each([
    [0, '0'],
    [-5, '-5'],
    [1.5, '1.5'],
    ['4294967296', '"4294967296"'],
    ['x'.repeat(40), `"${'x'.repeat(32)}..."`],
    [null, 'null'],
    [true, 'true'],
    [{ bytes: 1 }, 'a value of type object'],
    [[4096], 'a value of type array'],
  ])('ignores the invalid WAL threshold %j and says the reopen stays off', async (configured, shown) => {
    const lines: string[] = [];
    await startManagedOxigraph({
      config: {
        store: {
          backend: MANAGED_OXIGRAPH_BACKEND,
          options: { walRestartThresholdBytes: configured },
        },
      },
      dataDir: '/data',
      platform: 'linux',
      log: line => lines.push(line),
    });

    expect(startedWith()).toHaveProperty('walRestartThresholdBytes', undefined);
    expect(lines.filter(line => line.includes('walRestartThresholdBytes'))).toEqual([
      '[oxigraph] store.options.walRestartThresholdBytes must be a positive integer number of bytes; '
      + `ignoring ${shown}. The WAL maintenance reopen stays off`,
    ]);
  });
});
