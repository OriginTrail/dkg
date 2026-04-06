import { randomUUID } from 'node:crypto';

export type OperationName = 'publish' | 'update' | 'query' | 'resolve' | 'connect' | 'sync' | 'system' | 'share' | 'publishFromSWM' | 'gossip' | 'ka-update' | 'reconstruct' | 'init' | 'verify';

export interface OperationContext {
  operationId: string;
  operationName: OperationName;
  /** The originating node's operation ID, present when this operation was triggered by a remote message. */
  sourceOperationId?: string;
}

export type LogSink = (entry: {
  level: string;
  operationName: string;
  operationId: string;
  sourceOperationId?: string;
  module: string;
  message: string;
}) => void;

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

  debug(ctx: OperationContext, message: string): void {
    Logger.sink?.({ level: 'debug', operationName: ctx.operationName, operationId: ctx.operationId, sourceOperationId: ctx.sourceOperationId, module: this.moduleName, message });
  }

  info(ctx: OperationContext, message: string): void {
    process.stdout.write(`${this.format(ctx, message)}\n`);
    Logger.sink?.({ level: 'info', operationName: ctx.operationName, operationId: ctx.operationId, sourceOperationId: ctx.sourceOperationId, module: this.moduleName, message });
  }

  warn(ctx: OperationContext, message: string): void {
    process.stderr.write(`${this.format(ctx, message)} [WARN]\n`);
    Logger.sink?.({ level: 'warn', operationName: ctx.operationName, operationId: ctx.operationId, sourceOperationId: ctx.sourceOperationId, module: this.moduleName, message });
  }

  error(ctx: OperationContext, message: string): void {
    process.stderr.write(`${this.format(ctx, message)} [ERROR]\n`);
    Logger.sink?.({ level: 'error', operationName: ctx.operationName, operationId: ctx.operationId, sourceOperationId: ctx.sourceOperationId, module: this.moduleName, message });
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
