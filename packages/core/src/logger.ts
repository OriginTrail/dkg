import { randomUUID } from 'node:crypto';
import { currentTraceIds } from './telemetry-api.js';

export type OperationName = 'publish' | 'update' | 'query' | 'resolve' | 'connect' | 'sync' | 'system' | 'share' | 'publishFromSWM' | 'gossip' | 'ka-update' | 'reconstruct' | 'init' | 'verify' | 'migrate-swm-attr';

export interface OperationContext {
  operationId: string;
  operationName: OperationName;
  /** The originating node's operation ID, present when this operation was triggered by a remote message. */
  sourceOperationId?: string;
}

/**
 * The canonical structured log record emitted on every Logger call. This is
 * the single shape that flows to the local dashboard DB and to any remote
 * shipper (syslog, OTLP). Keep it stable — redaction and the OTLP exporter
 * both consume it.
 */
export interface LogRecord {
  level: string;
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

export type KaLifecycleLogLevel = 'info' | 'warn' | 'error';

export type KaLifecycleMetadataValue = string | number | boolean | null | undefined;

export interface KaLifecycleLogEvent {
  level?: KaLifecycleLogLevel;
  assetUal: string;
  stage: string;
  event: string;
  role: string;
  localPeerId: string;
  localNodeIdentityId: string;
  peer?: string;
  peerNodeIdentityId?: string;
  metadata?: Record<string, KaLifecycleMetadataValue>;
}

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
  private emit(level: string, ctx: OperationContext, message: string): void {
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

export function logKaLifecycleEvent(log: Logger, ctx: OperationContext, input: KaLifecycleLogEvent): void {
  const level = input.level ?? 'info';
  log[level](ctx, formatKaLifecycleEvent(input));
}

function formatKaLifecycleEvent(input: KaLifecycleLogEvent): string {
  const fields: Array<[string, KaLifecycleMetadataValue]> = [
    ['assetUal', input.assetUal],
    ['stage', input.stage],
    ['event', input.event],
    ['role', input.role],
    ['localPeerId', input.localPeerId],
    ['localNodeIdentityId', input.localNodeIdentityId],
    ['peer', input.peer],
    ['peerNodeIdentityId', input.peerNodeIdentityId],
  ];
  if (input.metadata) fields.push(...Object.entries(input.metadata));
  return `ka_lifecycle ${fields
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')}`;
}
