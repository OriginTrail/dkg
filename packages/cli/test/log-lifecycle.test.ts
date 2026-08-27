import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@origintrail-official/dkg-core';
import {
  exitAfterFatalLogDrain,
  startDaemonLogController,
} from '../src/daemon/log-lifecycle.js';
import {
  startDaemonLogFileWriter,
  type DebugLogRecord,
} from '../src/daemon/daemon-log-file-writer.js';
import { appendBoundedDaemonLogDiagnostic } from '../src/daemon/daemon-log-diagnostics.js';
import type { DkgConfig } from '../src/config.js';
import { createTelemetryRuntime } from '../src/daemon/telemetry-runtime.js';

const noRotation = async () => ({
  rotated: false,
  previousBytes: 0,
  keptBytes: 0,
});

describe('startDaemonLogController', () => {
  afterEach(() => {
    vi.useRealTimers();
    Logger.setSink(null);
    vi.restoreAllMocks();
  });

  it('forces fatal exit when the file writer never drains', async () => {
    vi.useFakeTimers();
    const detach = vi.fn();
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const exit = vi.fn();
    const reportTimeout = vi.fn();

    const fatalExit = exitAfterFatalLogDrain({
      detach,
      shutdown,
      exit,
      reportTimeout,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await fatalExit;

    expect(detach).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(reportTimeout).toHaveBeenCalledWith(
      expect.stringContaining('fatal log drain timed out'),
    );
    expect(exit).toHaveBeenCalledWith(1);
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
      writeLocalDebug: () => undefined,
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
      writeLocalDebug: () => undefined,
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
      writeLocalDebug: () => undefined,
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

  it('keeps debug records in the local file without routine SQLite persistence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-debug-log-'));
    const file = join(directory, 'daemon.log');
    const persisted: string[] = [];
    const logFileWriter = startDaemonLogFileWriter({
      logFile: file,
      rotate: noRotation,
    });
    const controller = startDaemonLogController({
      writeLocalDebug: (record) => {
        logFileWriter.pushDebug(record);
      },
      insertDiagnosticLog: (record) => persisted.push(record.message),
      redact: (record) => record,
    });

    try {
      const logger = new Logger('debug-file-test');
      logger.debug(
        { operationId: 'op-debug', operationName: 'system' },
        'discovery scan failed',
      );
      controller.detachSink();
      await logFileWriter.shutdown();

      expect(await readFile(file, 'utf8')).toContain(
        'system op-debug [debug-file-test] discovery scan failed [DEBUG]',
      );
      expect(persisted).toEqual([]);
    } finally {
      controller.detachSink();
      await logFileWriter.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('bounds queued debug writes and waits for accepted records on shutdown', async () => {
    let releaseAppend!: () => void;
    let markAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appended: string[] = [];
    let concurrentAppends = 0;
    let maxConcurrentAppends = 0;
    const logFileWriter = startDaemonLogFileWriter({
      logFile: 'unused-in-injected-test',
      rotate: noRotation,
      maxQueuedEntries: 4,
      maxBatchEntries: 1,
      append: async (data) => {
        concurrentAppends += 1;
        maxConcurrentAppends = Math.max(maxConcurrentAppends, concurrentAppends);
        markAppendStarted();
        await appendGate;
        appended.push(data);
        concurrentAppends -= 1;
      },
    });
    const debugRecord = (index: number): DebugLogRecord => ({
      level: 'debug',
      operationName: 'system',
      operationId: `op-${index}`,
      module: 'queue-test',
      message: `message-${index}`,
    });
    expectTypeOf(logFileWriter.pushDebug).parameter(0).toEqualTypeOf<DebugLogRecord>();
    const pushDebug = (index: number) => logFileWriter.pushDebug(debugRecord(index));

    pushDebug(0);
    await appendStarted;
    for (let index = 1; index <= 20; index++) pushDebug(index);

    expect(logFileWriter.pending()).toBe(5); // one active + four bounded queued
    expect(logFileWriter.dropped()).toBe(16);
    let shutdownSettled = false;
    const shutdown = logFileWriter.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    const settledBeforeRelease = shutdownSettled;
    releaseAppend();
    await shutdown;
    expect(settledBeforeRelease).toBe(false);
    expect(maxConcurrentAppends).toBe(1);
    expect(logFileWriter.pending()).toBe(0);
    expect(pushDebug(21)).toBe(false);
    expect(appended.join('')).toContain('message-0');
    for (const index of [17, 18, 19, 20]) {
      expect(appended.join('')).toContain(`message-${index}`);
    }
    expect(appended.join('')).not.toContain('message-16');
  });

  it('drops debug before standard output in both mixed overflow directions', async () => {
    const runScenario = async (queueWrites: (
      writer: ReturnType<typeof startDaemonLogFileWriter>,
      debug: DebugLogRecord,
    ) => void) => {
      let releaseAppend!: () => void;
      let markAppendStarted!: () => void;
      const appendStarted = new Promise<void>((resolve) => {
        markAppendStarted = resolve;
      });
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const appended: string[] = [];
      let appendCalls = 0;
      const writer = startDaemonLogFileWriter({
        logFile: 'unused-in-injected-test',
        rotate: noRotation,
        maxQueuedEntries: 2,
        maxBatchEntries: 1,
        append: async (data) => {
          appendCalls += 1;
          if (appendCalls === 1) {
            markAppendStarted();
            await appendGate;
          }
          appended.push(data);
        },
      });
      const debug: DebugLogRecord = {
        level: 'debug',
        operationName: 'system',
        operationId: 'op-debug',
        module: 'overflow-test',
        message: 'debug-queued',
      };

      expect(writer.push('in-flight\n')).toBe(true);
      await appendStarted;
      queueWrites(writer, debug);
      releaseAppend();
      await writer.shutdown();
      return { appended: appended.join(''), writer };
    };

    const evicted = await runScenario((writer, debug) => {
      expect(writer.push('standard-a\n')).toBe(true);
      expect(writer.pushDebug(debug)).toBe(true);
      expect(writer.push('standard-c\n')).toBe(true);
    });
    expect(evicted.appended).toContain('standard-a');
    expect(evicted.appended).toContain('standard-c');
    expect(evicted.appended).not.toContain('debug-queued');
    expect(evicted.writer.dropped()).toBe(1);

    const rejected = await runScenario((writer, debug) => {
      expect(writer.push('standard-a\n')).toBe(true);
      expect(writer.push('standard-b\n')).toBe(true);
      expect(writer.pushDebug(debug)).toBe(false);
    });
    expect(rejected.appended).toContain('standard-a');
    expect(rejected.appended).toContain('standard-b');
    expect(rejected.appended).not.toContain('debug-queued');
    expect(rejected.writer.dropped()).toBe(1);
  });

  it('retries failed batches, counts final loss, and awaits a durable diagnostic', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-log-writer-diagnostic-'));
    const diagnosticFile = join(directory, 'daemon-log-writer-errors.log');
    const append = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    const logFileWriter = startDaemonLogFileWriter({
      logFile: 'unused-in-injected-test',
      rotate: noRotation,
      maxAppendAttempts: 3,
      append,
      waitBeforeRetry: async () => undefined,
      onDiagnostic: async (message) => {
        await appendFile(diagnosticFile, `${message}\n`);
      },
    });

    try {
      expect(logFileWriter.push('accepted-before-failure\n')).toBe(true);
      await logFileWriter.shutdown();

      expect(append).toHaveBeenCalledTimes(3);
      expect(logFileWriter.pending()).toBe(0);
      expect(logFileWriter.dropped()).toBe(1);
      expect(await readFile(diagnosticFile, 'utf8')).toContain(
        'discarded accepted entries=1',
      );
    } finally {
      await logFileWriter.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('coalesces repeated append failures and caps the diagnostic file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-log-writer-bounded-diagnostic-'));
    const diagnosticFile = join(directory, 'daemon-log-writer-errors.log');
    let releaseFirstDiagnostic!: () => void;
    let markFirstDiagnosticStarted!: () => void;
    const firstDiagnosticStarted = new Promise<void>((resolve) => {
      markFirstDiagnosticStarted = resolve;
    });
    const firstDiagnosticGate = new Promise<void>((resolve) => {
      releaseFirstDiagnostic = resolve;
    });
    const diagnostics: string[] = [];
    const logFileWriter = startDaemonLogFileWriter({
      logFile: 'unused-in-injected-test',
      rotate: noRotation,
      maxQueuedEntries: 32,
      maxBatchEntries: 1,
      maxAppendAttempts: 1,
      append: async () => {
        throw new Error('daemon log is read-only');
      },
      onDiagnostic: async (message) => {
        diagnostics.push(message);
        if (diagnostics.length === 1) {
          markFirstDiagnosticStarted();
          await firstDiagnosticGate;
        }
        await appendBoundedDaemonLogDiagnostic(
          diagnosticFile,
          `${message}\n`,
          180,
        );
      },
    });

    try {
      for (let index = 0; index < 16; index++) {
        expect(logFileWriter.push(`entry-${index}\n`)).toBe(true);
      }
      await firstDiagnosticStarted;
      await vi.waitFor(() => {
        expect(logFileWriter.dropped()).toBe(16);
      });

      // The blocked first report does not permit an unbounded promise chain;
      // all later snapshots collapse into one replaceable pending report.
      expect(diagnostics).toHaveLength(1);
      const shutdown = logFileWriter.shutdown();
      releaseFirstDiagnostic();
      await shutdown;

      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[1]).toContain('failure batches=16');
      expect(diagnostics[1]).toContain('total dropped=16');
      const persisted = await readFile(diagnosticFile);
      expect(persisted.byteLength).toBeLessThanOrEqual(180);
      expect(persisted.toString()).toContain('total dropped=16');
    } finally {
      releaseFirstDiagnostic?.();
      await logFileWriter.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('serializes mixed standard/debug writes with rotation and final drain', async () => {
    let releaseFirstAppend!: () => void;
    let markFirstAppendStarted!: () => void;
    const firstAppendStarted = new Promise<void>((resolve) => {
      markFirstAppendStarted = resolve;
    });
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    const events: string[] = [];
    let appendCalls = 0;
    let concurrentAppends = 0;
    let maxConcurrentAppends = 0;
    const logFileWriter = startDaemonLogFileWriter({
      logFile: 'unused-in-injected-test',
      maxBatchEntries: 1,
      rotate: async () => {
        events.push('rotate');
        return { rotated: true, previousBytes: 10, keptBytes: 5 };
      },
      append: async (data) => {
        appendCalls += 1;
        concurrentAppends += 1;
        maxConcurrentAppends = Math.max(maxConcurrentAppends, concurrentAppends);
        if (appendCalls === 1) {
          markFirstAppendStarted();
          await firstAppendGate;
        }
        events.push(`append:${data.trim()}`);
        concurrentAppends -= 1;
      },
    });

    logFileWriter.push('info-0\n');
    await firstAppendStarted;
    logFileWriter.pushDebug({
      level: 'debug',
      operationName: 'system',
      operationId: 'op-debug-1',
      module: 'mixed-writer-test',
      message: 'debug-1',
    });
    logFileWriter.push('info-2\n');
    const rotation = logFileWriter.rotate();
    logFileWriter.pushDebug({
      level: 'debug',
      operationName: 'system',
      operationId: 'op-debug-3',
      module: 'mixed-writer-test',
      message: 'debug-3',
    });

    releaseFirstAppend();
    expect(await rotation).toEqual({
      rotated: true,
      previousBytes: 10,
      keptBytes: 5,
    });
    await logFileWriter.shutdown();

    expect(events).toHaveLength(5);
    expect(events[0]).toBe('append:info-0');
    expect(events[1]).toContain('debug-1 [DEBUG]');
    expect(events[2]).toBe('append:info-2');
    expect(events[3]).toBe('rotate');
    expect(events[4]).toContain('debug-3 [DEBUG]');
    expect(maxConcurrentAppends).toBe(1);
    expect(logFileWriter.pending()).toBe(0);
  });
});
