import { randomUUID } from 'node:crypto';
import { currentTraceIds } from './telemetry-api.js';

export type OperationName = 'publish' | 'update' | 'query' | 'resolve' | 'connect' | 'sync' | 'system' | 'share' | 'publishFromSWM' | 'gossip' | 'ka-update' | 'reconstruct' | 'init' | 'verify' | 'migrate-swm-attr';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = typeof LOG_LEVELS[number];
export type LogPersistenceClass = 'routine' | 'diagnostic';
export const LOG_LEVEL_PERSISTENCE_CLASS = {
  debug: 'routine',
  info: 'routine',
  warn: 'diagnostic',
  error: 'diagnostic',
} as const satisfies Record<LogLevel, LogPersistenceClass>;
export type DiagnosticLogLevel = {
  [Level in LogLevel]: typeof LOG_LEVEL_PERSISTENCE_CLASS[Level] extends 'diagnostic'
    ? Level
    : never;
}[LogLevel];
export const DIAGNOSTIC_LOG_LEVELS = LOG_LEVELS.filter(
  (level): level is DiagnosticLogLevel => LOG_LEVEL_PERSISTENCE_CLASS[level] === 'diagnostic',
);

export function isDiagnosticLogLevel(level: string): level is DiagnosticLogLevel {
  return level in LOG_LEVEL_PERSISTENCE_CLASS
    && LOG_LEVEL_PERSISTENCE_CLASS[level as LogLevel] === 'diagnostic';
}

export interface OperationContext {
  operationId: string;
  operationName: OperationName;
  /** The originating node's operation ID, present when this operation was triggered by a remote message. */
  sourceOperationId?: string;
}

/**
 * The canonical structured log record emitted on every Logger call. This is
 * the single shape that flows to any configured sink. The daemon uses it for
 * remote shippers (syslog, OTLP); local info/warn/error logs are file-backed.
 * Keep it stable — redaction and the exporters consume it.
 */
export interface LogRecord {
  level: LogLevel;
  operationName: string;
  operationId: string;
  sourceOperationId?: string;
  module: string;
  message: string;
  /** Hex W3C trace/span id of the active span when logged (when a span is recording), for trace↔log correlation. */
  traceId?: string;
  spanId?: string;
}

export type LogSink = (entry: LogRecord) => void;

/**
 * Structured logger that prefixes every message with a timestamp,
 * operation name, and operation ID for cross-node log correlation.
 *
 * Format: YYYY-MM-DD HH:MM:SS <operationName> <operationId> "<message>"
 */
export class Logger {
  private static sink: LogSink | null = null;
  private readonly prefix: string;

  static setSink(sink: LogSink | null): void {
    Logger.sink = sink;
  }

  constructor(private readonly moduleName: string) {
    this.prefix = moduleName;
  }

  /**
   * Build the structured record and hand it to the sink. Attaches the active
   * span's trace/span id when one is recording (no-op/empty otherwise), so logs
   * emitted inside an instrumented boundary correlate to its trace.
   */
  private emit(level: LogLevel, ctx: OperationContext, message: string): void {
    if (!Logger.sink) return;
    Logger.sink({
      level,
      operationName: ctx.operationName,
      operationId: ctx.operationId,
      sourceOperationId: ctx.sourceOperationId,
      module: this.moduleName,
      message,
      ...currentTraceIds(),
    });
  }

  debug(ctx: OperationContext, message: string): void {
    this.emit('debug', ctx, message);
  }

  info(ctx: OperationContext, message: string): void {
    process.stdout.write(`${this.format(ctx, message)}\n`);
    this.emit('info', ctx, message);
  }

  warn(ctx: OperationContext, message: string): void {
    process.stderr.write(`${this.format(ctx, message)} [WARN]\n`);
    this.emit('warn', ctx, message);
  }

  error(ctx: OperationContext, message: string): void {
    process.stderr.write(`${this.format(ctx, message)} [ERROR]\n`);
    this.emit('error', ctx, message);
  }

  private format(ctx: OperationContext, message: string): string {
    const ts = formatTimestamp(new Date());
    const src = ctx.sourceOperationId ? ` [from:${ctx.sourceOperationId}]` : '';
    return `${ts} ${ctx.operationName} ${ctx.operationId}${src} [${this.prefix}] ${message}`;
  }
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function createOperationContext(operationName: OperationName, sourceOperationId?: string): OperationContext {
  return { operationId: randomUUID(), operationName, sourceOperationId };
}
