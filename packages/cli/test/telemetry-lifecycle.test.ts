import { describe, expect, it, vi } from 'vitest';
import type { TelemetryInitConfig } from '@origintrail-official/dkg-node-ui';
import type { DkgConfig } from '../src/config.js';
import { createDaemonTelemetryLifecycle } from '../src/daemon/telemetry-lifecycle.js';
import {
  createTelemetryRuntime,
  createTelemetrySettings,
} from '../src/daemon/telemetry-runtime.js';

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
      config,
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
    const runtime = createTelemetryRuntime({
      config,
      signals,
      persist: vi.fn(async (current) => {
        persisted.push(current.telemetry?.enabled ?? false);
      }),
    });
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
});
