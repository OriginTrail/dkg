import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@origintrail-official/dkg-core';
import { startDaemonLogController } from '../src/daemon/log-lifecycle.js';

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

  it('detaches the sink synchronously and shuts the active exporter down once', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const persisted: string[] = [];
    const pushed: string[] = [];
    let releaseShutdown!: () => void;
    const shutdown = vi.fn(() => new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    }));
    const controller = startDaemonLogController({
      insertDiagnosticLog: (record) => persisted.push(record.message),
      redact: (record) => record,
    });
    controller.startExporter('syslog', () => ({
      shipper: { push: (record) => pushed.push(record.message) },
      shutdown,
    }));

    const logger = new Logger('controller-stop-test');
    const context = { operationId: 'op-2', operationName: 'system' as const };
    logger.warn(context, 'before-stop');
    const stopping = controller.stop();
    logger.warn(context, 'after-stop');

    expect(persisted).toEqual(['before-stop']);
    expect(pushed).toEqual(['before-stop']);
    expect(shutdown).toHaveBeenCalledTimes(1);
    releaseShutdown();
    await stopping;
    await controller.stop();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
