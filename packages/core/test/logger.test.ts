import { describe, it, expect, afterEach } from 'vitest';
import { Logger, createOperationContext, type LogSink, type OperationContext } from '../src/logger.js';

interface LogEntry {
  level: string;
  operationName: string;
  operationId: string;
  sourceOperationId?: string;
  module: string;
  message: string;
}

function collectSink(): { entries: LogEntry[]; sink: LogSink } {
  const entries: LogEntry[] = [];
  return { entries, sink: (entry) => entries.push(entry) };
}

function captureStdout<T>(fn: () => T): { result: T; output: string[] } {
  const output: string[] = [];
  const orig = process.stdout.write;
  process.stdout.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as any;
  const result = fn();
  process.stdout.write = orig;
  return { result, output };
}

function captureStderr<T>(fn: () => T): { result: T; output: string[] } {
  const output: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: any) => { output.push(String(chunk)); return true; }) as any;
  const result = fn();
  process.stderr.write = orig;
  return { result, output };
}

function captureBoth<T>(fn: () => T): { result: T; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => { stdout.push(String(chunk)); return true; }) as any;
  process.stderr.write = ((chunk: any) => { stderr.push(String(chunk)); return true; }) as any;
  const result = fn();
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  return { result, stdout, stderr };
}

describe('Logger', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  function ctx(overrides?: Partial<OperationContext>): OperationContext {
    return { operationId: 'op-123', operationName: 'publish', ...overrides };
  }

  it('info writes to stdout and invokes sink', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('TestModule');
    const { output } = captureStdout(() => log.info(ctx(), 'hello world'));

    expect(output.length).toBe(1);
    expect(output[0]).toContain('publish');
    expect(output[0]).toContain('op-123');
    expect(output[0]).toContain('[TestModule]');
    expect(output[0]).toContain('hello world');
    expect(output[0]).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].operationName).toBe('publish');
    expect(entries[0].operationId).toBe('op-123');
    expect(entries[0].module).toBe('TestModule');
    expect(entries[0].message).toBe('hello world');
  });

  it('warn writes to stderr with [WARN] tag', () => {
    const log = new Logger('WarnModule');
    const { output } = captureStderr(() => log.warn(ctx(), 'something iffy'));

    expect(output.length).toBe(1);
    expect(output[0]).toContain('[WARN]');
    expect(output[0]).toContain('something iffy');
  });

  it('error writes to stderr with [ERROR] tag', () => {
    const log = new Logger('ErrorModule');
    const { output } = captureStderr(() => log.error(ctx(), 'broke'));

    expect(output[0]).toContain('[ERROR]');
  });

  it('debug does not write to stdout/stderr — only invokes sink', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('DebugModule');
    const { stdout, stderr } = captureBoth(() => log.debug(ctx(), 'trace detail'));

    expect(stdout.length).toBe(0);
    expect(stderr.length).toBe(0);
    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe('debug');
  });

  it('includes sourceOperationId in sink and formatted output when present', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('Mod');
    const { output } = captureStdout(() =>
      log.info(ctx({ sourceOperationId: 'remote-op-456' }), 'propagated'),
    );

    expect(output[0]).toContain('[from:remote-op-456]');
    expect(entries[0].sourceOperationId).toBe('remote-op-456');
  });

  it('omits [from:...] when sourceOperationId is undefined', () => {
    const log = new Logger('Mod');
    const { output } = captureStdout(() => log.info(ctx(), 'local only'));

    expect(output[0]).not.toContain('[from:');
  });

  it('setSink(null) clears the sink', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);
    Logger.setSink(null);

    const log = new Logger('X');
    log.debug(ctx(), 'ignored');

    expect(entries.length).toBe(0);
  });

  it('sink receives all four levels', () => {
    const { entries, sink } = collectSink();
    Logger.setSink(sink);

    const log = new Logger('M');
    captureBoth(() => {
      log.debug(ctx(), 'd');
      log.info(ctx(), 'i');
      log.warn(ctx(), 'w');
      log.error(ctx(), 'e');
    });

    const levels = entries.map(e => e.level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('createOperationContext', () => {
  it('generates a UUID-shaped operationId', () => {
    const ctx = createOperationContext('query');
    expect(ctx.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(ctx.operationName).toBe('query');
    expect(ctx.sourceOperationId).toBeUndefined();
  });

  it('includes sourceOperationId when provided', () => {
    const ctx = createOperationContext('sync', 'remote-op');
    expect(ctx.sourceOperationId).toBe('remote-op');
  });

  it('generates unique IDs across calls', () => {
    const a = createOperationContext('publish');
    const b = createOperationContext('publish');
    expect(a.operationId).not.toBe(b.operationId);
  });
});
