import type { OperationContext } from '@dkg/core';
import type { DashboardDB } from './db.js';

/**
 * Records the lifecycle of node operations (publish, query, sync, etc.)
 * in the dashboard SQLite database. If no DB is configured (e.g. in tests),
 * all methods are no-ops.
 */
export class OperationTracker {
  private readonly starts = new Map<string, number>();
  private readonly phaseStarts = new Map<string, number>();

  constructor(private readonly db: DashboardDB | null) {}

  start(ctx: OperationContext, meta?: {
    peerId?: string;
    paranetId?: string;
    details?: Record<string, unknown>;
  }): void {
    if (!this.db) return;
    const now = Date.now();
    this.starts.set(ctx.operationId, now);
    try {
      this.db.insertOperation({
        operation_id: ctx.operationId,
        operation_name: ctx.operationName,
        started_at: now,
        peer_id: meta?.peerId,
        paranet_id: meta?.paranetId,
        details: meta?.details ? JSON.stringify(meta.details) : null,
      });
    } catch {
      // Must never break the node
    }
  }

  complete(ctx: OperationContext, meta?: {
    tripleCount?: number;
    details?: Record<string, unknown>;
  }): void {
    if (!this.db) return;
    const startedAt = this.starts.get(ctx.operationId);
    this.starts.delete(ctx.operationId);
    try {
      this.db.completeOperation({
        operation_id: ctx.operationId,
        duration_ms: startedAt ? Date.now() - startedAt : 0,
        triple_count: meta?.tripleCount,
        details: meta?.details ? JSON.stringify(meta.details) : null,
      });
    } catch {
      // Must never break the node
    }
  }

  fail(ctx: OperationContext, err: unknown): void {
    if (!this.db) return;
    const now = Date.now();
    const startedAt = this.starts.get(ctx.operationId);
    this.starts.delete(ctx.operationId);
    const message = err instanceof Error ? err.message : String(err);
    try {
      const prefix = ctx.operationId + ':';
      const activeKeys = [...this.phaseStarts.keys()].filter(k => k.startsWith(prefix));
      for (const key of activeKeys) {
        const phase = key.slice(prefix.length);
        const phaseStartedAt = this.phaseStarts.get(key);
        this.phaseStarts.delete(key);
        this.db.failPhase({
          operation_id: ctx.operationId,
          phase,
          duration_ms: phaseStartedAt ? now - phaseStartedAt : 0,
          error_message: message,
        });
      }
      this.db.failOperation({
        operation_id: ctx.operationId,
        duration_ms: startedAt ? now - startedAt : 0,
        error_message: message,
      });
    } catch {
      // Must never break the node
    }
  }

  startPhase(ctx: OperationContext, phase: string): void {
    if (!this.db) return;
    const now = Date.now();
    const key = `${ctx.operationId}:${phase}`;
    this.phaseStarts.set(key, now);
    try {
      this.db.insertPhase({
        operation_id: ctx.operationId,
        phase,
        started_at: now,
      });
    } catch {
      // Must never break the node
    }
  }

  completePhase(ctx: OperationContext, phase: string): void {
    if (!this.db) return;
    const key = `${ctx.operationId}:${phase}`;
    const startedAt = this.phaseStarts.get(key);
    this.phaseStarts.delete(key);
    try {
      this.db.completePhase({
        operation_id: ctx.operationId,
        phase,
        duration_ms: startedAt ? Date.now() - startedAt : 0,
      });
    } catch {
      // Must never break the node
    }
  }

  setCost(ctx: OperationContext, cost: {
    gasUsed?: bigint;
    gasPrice?: bigint;
    gasCost?: bigint;
    tracCost?: bigint;
  }): void {
    if (!this.db) return;
    try {
      const gasPriceGwei = cost.gasPrice != null
        ? Number(cost.gasPrice) / 1e9
        : null;
      const gasCostEth = cost.gasCost != null
        ? Number(cost.gasCost) / 1e18
        : null;
      const tracCost = cost.tracCost != null
        ? Number(cost.tracCost) / 1e18
        : null;
      this.db.setOperationCost({
        operation_id: ctx.operationId,
        gas_used: cost.gasUsed != null ? Number(cost.gasUsed) : null,
        gas_price_gwei: gasPriceGwei,
        gas_cost_eth: gasCostEth,
        trac_cost: tracCost,
      });
    } catch {
      // Must never break the node
    }
  }

  setTxHash(ctx: OperationContext, txHash?: string, chainId?: number): void {
    if (!this.db || !txHash) return;
    try {
      this.db.setOperationCost({
        operation_id: ctx.operationId,
        tx_hash: txHash,
        chain_id: chainId ?? null,
      });
    } catch {
      // Must never break the node
    }
  }

  /**
   * Execute `fn` as a tracked phase — no timing gaps, no forgotten end calls.
   * On success completes the phase; on error fails the phase and re-throws.
   */
  async trackPhase<T>(ctx: OperationContext, phase: string, fn: () => Promise<T>): Promise<T> {
    this.startPhase(ctx, phase);
    try {
      const result = await fn();
      this.completePhase(ctx, phase);
      return result;
    } catch (err) {
      if (this.db) {
        const key = `${ctx.operationId}:${phase}`;
        const startedAt = this.phaseStarts.get(key);
        this.phaseStarts.delete(key);
        try {
          this.db.failPhase({
            operation_id: ctx.operationId,
            phase,
            duration_ms: startedAt ? Date.now() - startedAt : 0,
            error_message: err instanceof Error ? err.message : String(err),
          });
        } catch { /* never crash */ }
      }
      throw err;
    }
  }

  /**
   * Create an onPhase callback wired to this tracker instance.
   * Pass this to DKGAgent/Publisher methods that accept `onPhase`.
   */
  phaseCallback(ctx: OperationContext): (phase: string, status: 'start' | 'end') => void {
    return (phase, status) => {
      if (status === 'start') this.startPhase(ctx, phase);
      else this.completePhase(ctx, phase);
    };
  }
}
