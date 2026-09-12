import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DkgHomeFiles } from '../src/config.js';
import { DkgConfigStore } from '../src/daemon-config-store.js';
import type { TelemetryInitConfig } from '@origintrail-official/dkg-node-ui';
import type { DkgConfig } from '../src/config.js';
import { createDaemonTelemetryLifecycle } from '../src/daemon/telemetry-lifecycle.js';
import {
  createTelemetryRuntime,
  createTelemetrySettings,
} from '../src/daemon/telemetry-runtime.js';

const directories: string[] = [];
const stores: DkgConfigStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('daemon telemetry lifecycle wiring', () => {
  it('starts traces, metrics, and the selected log exporter from a boot-disabled settings transition', async () => {
    const config: DkgConfig = {
      name: 'runtime-enable-test',
      apiPort: 0,
      listenPort: 0,
      nodeRole: 'edge',
      telemetry: {
        enabled: false,
        logs: {
          exporter: 'otlp',
          endpoint: 'http://collector.test/v1/logs',
        },
        traces: {
          endpoint: 'http://collector.test/v1/traces',
          sampleRatio: 0.25,
        },
        metrics: {
          endpoint: 'http://collector.test/v1/metrics',
          exportIntervalMs: 5_000,
        },
      },
    };
    const events: string[] = [];
    const persisted: boolean[] = [];
    const initOtel = vi.fn(async (_input: TelemetryInitConfig) => {
      events.push('otel:start');
    });
    const startLogExporter = vi.fn(async () => {
      events.push('logs:start');
      return { ok: true } as const;
    });
    const stopLogExporter = vi.fn(async () => {
      events.push('logs:stop');
    });
    const shutdownOtel = vi.fn(async () => {
      events.push('otel:stop');
    });
    const signals = createDaemonTelemetryLifecycle({
      readConfig: () => configStore.current,
      env: {},
      resource: {
        serviceName: 'dkg-node',
        serviceInstanceId: config.name,
        network: 'testnet',
      },
      initOtel,
      shutdownOtel,
      startLogExporter,
      stopLogExporter,
      log: vi.fn(),
    });
    const directory = await mkdtemp(join(tmpdir(), 'dkg-telemetry-lifecycle-'));
    directories.push(directory);
    const files = new DkgHomeFiles(directory);
    await files.saveConfig(config);
    const configStore = await DkgConfigStore.open(files, config);
    stores.push(configStore);
    const update = configStore.update.bind(configStore);
    vi.spyOn(configStore, 'update').mockImplementation(async (...args) => {
      const current = await update(...args);
      persisted.push(current.telemetry?.enabled ?? false);
      return current;
    });
    const runtime = createTelemetryRuntime({ configStore, signals });
    const settings = createTelemetrySettings(runtime);

    await runtime.startConfiguredBestEffort();
    expect(events).toEqual([]);
    expect(settings.getTelemetryEnabled()).toBe(false);

    await expect(settings.setTelemetryEnabled(true)).resolves.toEqual({
      ok: true,
    });

    expect(events).toEqual(['otel:start', 'logs:start']);
    expect(initOtel).toHaveBeenCalledWith({
      enabled: true,
      resource: {
        serviceName: 'dkg-node',
        serviceInstanceId: config.name,
        network: 'testnet',
      },
      traces: {
        endpoint: 'http://collector.test/v1/traces',
        token: undefined,
        sampleRatio: 0.25,
      },
      metrics: {
        endpoint: 'http://collector.test/v1/metrics',
        token: undefined,
        exportIntervalMs: 5_000,
      },
    });
    expect(startLogExporter).toHaveBeenCalledWith('otlp');
    expect(settings.getTelemetryEnabled()).toBe(true);

    await expect(settings.setTelemetryEnabled(false)).resolves.toEqual({
      ok: true,
    });

    expect(events).toEqual([
      'otel:start',
      'logs:start',
      'logs:stop',
      'otel:stop',
    ]);
    expect(stopLogExporter).toHaveBeenCalledTimes(1);
    expect(shutdownOtel).toHaveBeenCalledTimes(1);
    expect(settings.getTelemetryEnabled()).toBe(false);
    expect(persisted).toEqual([true, false]);
  });

  it('restarts with the latest committed telemetry while retaining immutable boot identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-telemetry-live-config-'));
    directories.push(directory);
    const files = new DkgHomeFiles(directory);
    const store = await DkgConfigStore.open(files, {
      name: 'boot-name', apiPort: 0, listenPort: 0, nodeRole: 'edge',
      telemetry: { enabled: true, logs: { exporter: 'none' }, traces: { endpoint: 'http://before.test/traces' } },
    });
    stores.push(store);
    const startupConfig = store.current;
    const initOtel = vi.fn(async (_input: TelemetryInitConfig) => {});
    const signals = createDaemonTelemetryLifecycle({
      readConfig: () => store.current,
      env: {},
      resource: { serviceName: 'dkg-node', serviceInstanceId: startupConfig.name },
      initOtel, shutdownOtel: vi.fn(async () => {}),
      startLogExporter: vi.fn(() => ({ ok: true } as const)),
      stopLogExporter: vi.fn(async () => {}), log: vi.fn(),
    });
    const runtime = createTelemetryRuntime({ configStore: store, signals });
    const settings = createTelemetrySettings(runtime);
    await runtime.startConfiguredBestEffort();
    expect(initOtel.mock.calls[0][0].traces?.endpoint).toBe('http://before.test/traces');
    await settings.setTelemetryEnabled(false);
    await store.update(current => ({
      ...current, name: 'next-boot-name',
      telemetry: { ...current.telemetry, traces: { endpoint: 'http://after.test/traces', token: 'new-token' } },
    }), 'configuration-only');
    await expect(settings.setTelemetryEnabled(true)).resolves.toEqual({ ok: true });
    expect(initOtel).toHaveBeenCalledTimes(2);
    expect(initOtel.mock.calls[1][0]).toMatchObject({
      traces: { endpoint: 'http://after.test/traces', token: 'new-token' },
      resource: { serviceInstanceId: 'boot-name' },
    });
    expect(store.current.name).toBe('next-boot-name');
    expect(startupConfig.name).toBe('boot-name');
    expect(startupConfig.telemetry?.traces?.endpoint).toBe('http://before.test/traces');
    expect(Object.isFrozen(startupConfig)).toBe(true);
    expect(Object.isFrozen(startupConfig.telemetry?.traces)).toBe(true);
    await settings.setTelemetryEnabled(false);
  });
});
