import { Logger, type OperationContext } from '@origintrail-official/dkg-core';
import type { DashboardDB } from './db.js';

/**
 * Drop-in replacement for Logger that also writes structured log
 * entries to the dashboard SQLite database. Existing stdout/stderr
 * output is preserved — the DB write is a side-effect.
 */
export class StructuredLogger extends Logger {
  constructor(
    moduleName: string,
    private readonly db: DashboardDB,
  ) {
    super(moduleName);
  }

  override info(ctx: OperationContext, message: string): void {
    super.info(ctx, message);
    this.persist('info', ctx, message);
  }

  override warn(ctx: OperationContext, message: string): void {
    super.warn(ctx, message);
    this.persist('warn', ctx, message);
  }

  override error(ctx: OperationContext, message: string): void {
    super.error(ctx, message);
    this.persist('error', ctx, message);
  }

  private persist(level: string, ctx: OperationContext, message: string): void {
    try {
      this.db.insertLog({
        ts: Date.now(),
        level,
        operation_name: ctx.operationName,
        operation_id: ctx.operationId,
        module: (this as any).moduleName ?? 'unknown',
        message,
      });
    } catch {
      // DB write failures must never break the node
    }
  }
}
