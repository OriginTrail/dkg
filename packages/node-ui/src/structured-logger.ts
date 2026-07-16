import { Logger, type OperationContext } from '@origintrail-official/dkg-core';
import type { DashboardDB } from './db.js';

/**
 * Deprecated compatibility shim for external callers that imported
 * StructuredLogger from @origintrail-official/dkg-node-ui.
 *
 * The dashboard no longer depends on the DB-backed free-text log search,
 * but structured log rows are still retained for operation correlation.
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
        module: (this as unknown as { moduleName?: string }).moduleName ?? 'unknown',
        message,
      });
    } catch {
      // DB write failures must never break the node.
    }
  }
}
