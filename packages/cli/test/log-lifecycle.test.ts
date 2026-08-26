import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@origintrail-official/dkg-core';
import { startDaemonLogController } from '../src/daemon/log-lifecycle.js';
import type { DkgConfig } from '../src/config.js';
import { createTelemetryRuntime } from '../src/daemon/telemetry-runtime.js';

describe('startDaemonLogController', () => {
  afterEach(() => {
    Logger.setSink(null);
    vi.restoreAllMocks();
  });

  it('owns exporter attach, runtime detach, and diagnostic persistence independently', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const persisted: string[] = [];
    const pushed: string[] = [];
    const firstShutdown = vi.fn(async () => {});
    const secondShutdown = vi.fn(async () => {});
    const secondPushed: string[] = [];
    const controller = startDaemonLogController({
      insertDiagnosticLog: (record) => persisted.push(record.message),
      redact: (record) => ({ ...record, message: `redacted:${record.message}` }),
    });
    const factory = vi.fn(() => ({
      shipper: { push: (record: { message: string }) => pushed.push(record.message) },
      shutdown: firstShutdown,
    }));

    expect(controller.startExporter('otlp', factory)).toEqual({ ok: true, started: true });
    expect(controller.startExporter('otlp', factory)).toEqual({ ok: true, started: false });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(controller.startExporter('syslog', factory)).toEqual({
      ok: false,
      error: 'Cannot start syslog while otlp is active',
    });

    const logger = new Logger('controller-test');
    const context = { operationId: 'op-1', operationName: 'system' as const };
    logger.info(context, 'routine');
    logger.warn(context, 'diagnostic-before-disable');
    expect(persisted).toEqual(['diagnostic-before-disable']);
    expect(pushed).toEqual(['redacted:routine', 'redacted:diagnostic-before-disable']);

    await controller.stopExporter();
    logger.warn(context, 'diagnostic-after-disable');
    expect(persisted).toEqual([
      'diagnostic-before-disable',
      'diagnostic-after-disable',
    ]);
    expect(pushed).toHaveLength(2);
    expect(firstShutdown).toHaveBeenCalledTimes(1);

    expect(controller.startExporter('otlp', () => ({
      shipper: { push: (record: { message: string }) => secondPushed.push(record.message) },
      shutdown: secondShutdown,
    }))).toEqual({ ok: true, started: true });
    logger.info(context, 'routine-after-re-enable');
    expect(pushed).toHaveLength(2);
    expect(secondPushed).toEqual(['redacted:routine-after-re-enable']);
    await controller.stopExporter();
    expect(firstShutdown).toHaveBeenCalledTimes(1);
    expect(secondShutdown).toHaveBeenCalledTimes(1);
  });

  it('does not attach a replacement while runtime exporter shutdown is pending', async () => {
    let releaseShutdown!: () => void;
    const controller = startDaemonLogController({
      insertDiagnosticLog: () => undefined,
      redact: (record) => record,
    });
    expect(controller.startExporter('otlp', () => ({
      shipper: { push: () => undefined },
      shutdown: () => new Promise<void>((resolve) => { releaseShutdown = resolve; }),
    }))).toEqual({ ok: true, started: true });

    const stopping = controller.stopExporter();
    expect(controller.startExporter('otlp', () => ({
      shipper: { push: () => undefined },
      shutdown: async () => undefined,
    }))).toEqual({
      ok: false,
      error: 'Cannot start otlp while the previous exporter is shutting down',
    });

    releaseShutdown();
    await stopping;
    expect(controller.startExporter('otlp', () => ({
      shipper: { push: () => undefined },
      shutdown: async () => undefined,
    }))).toEqual({ ok: true, started: true });
    await controller.stopExporter();
  });

  it('lets the telemetry runtime exclusively flush once during daemon shutdown', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const persisted: string[] = [];
    const pushed: string[] = [];
    let releaseStart!: () => void;
    let markStartDispatched!: () => void;
    const startDispatched = new Promise<void>((resolve) => {
      markStartDispatched = resolve;
    });
    let releaseExporterShutdown!: () => void;
    let markExporterShutdownStarted!: () => void;
    const exporterShutdownStarted = new Promise<void>((resolve) => {
      markExporterShutdownStarted = resolve;
    });
    const exporterShutdown = vi.fn(() => new Promise<void>((resolve) => {
      releaseExporterShutdown = resolve;
      markExporterShutdownStarted();
    }));
    const controller = startDaemonLogController({
      insertDiagnosticLog: (record) => persisted.push(record.message),
      redact: (record) => record,
    });
    const config: DkgConfig = {
      name: 'composed-telemetry-test',
      apiPort: 0,
      listenPort: 0,
      nodeRole: 'edge',
      telemetry: { enabled: false },
    };
    const runtime = createTelemetryRuntime({
      config,
      persist: vi.fn(async () => undefined),
      signals: {
        start: async () => {
          const result = controller.startExporter('syslog', () => ({
            shipper: { push: (record) => pushed.push(record.message) },
            shutdown: exporterShutdown,
          }));
          markStartDispatched();
          await new Promise<void>((resolve) => { releaseStart = resolve; });
          return result.ok ? { ok: true } : result;
        },
        stop: async () => {
          await controller.stopExporter();
        },
      },
    });

    const logger = new Logger('controller-stop-test');
    const context = { operationId: 'op-2', operationName: 'system' as const };
    const enabling = runtime.setEnabled(true);
    await startDispatched;
    logger.warn(context, 'before-stop');
    controller.detachSink();
    let shutdownSettled = false;
    const stopping = runtime.shutdown().then(() => {
      shutdownSettled = true;
    });
    logger.warn(context, 'after-stop');

    expect(persisted).toEqual(['before-stop']);
    expect(pushed).toEqual(['before-stop']);
    expect(exporterShutdown).not.toHaveBeenCalled();
    releaseStart();
    await enabling;
    await exporterShutdownStarted;
    await Promise.resolve();
    await Promise.resolve();
    const settledBeforeExporterFlush = shutdownSettled;
    releaseExporterShutdown();
    await stopping;
    expect(settledBeforeExporterFlush).toBe(false);
    expect(shutdownSettled).toBe(true);
    controller.detachSink();
    await runtime.shutdown();
    expect(exporterShutdown).toHaveBeenCalledTimes(1);
  });
});
