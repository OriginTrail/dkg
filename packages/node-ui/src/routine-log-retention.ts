import type Database from 'better-sqlite3';

export interface RoutineLogPruneBatch {
  deleted: number;
  hadOverflow: boolean;
  filledBatch: boolean;
}

/**
 * Owns the complete count-based retention policy for routine log rows.
 * Warning/error classification, guard cadence, overflow selection, and the
 * bounded deletion statement live together so compatibility writes and the
 * background pruner cannot drift onto different retention rules.
 */
export class RoutineLogRetention {
  private writesSinceGuard = 0;

  constructor(
    private readonly db: Pick<Database.Database, 'prepare'>,
    private readonly rowCap: number,
    private readonly batchRows: number,
  ) {}

  noteCommittedInsert(level: string): void {
    if (!this.isRoutineLevel(level)) return;
    this.writesSinceGuard += 1;
    // Each guard removes at most one configured batch, so its cadence must
    // never admit more routine rows than that batch can remove.
    const guardInterval = Math.min(
      1_000,
      Math.max(1, this.rowCap),
      this.batchRows,
    );
    if (this.writesSinceGuard < guardInterval) return;
    this.writesSinceGuard = 0;
    try {
      this.pruneOverflowBatch();
    } catch {
      // The INSERT has already committed. Inline retention is therefore
      // best-effort: surfacing this maintenance failure would falsely report
      // the durable write as failed and invite duplicate retries. The
      // independent volume pruner will retry the same bounded cleanup later.
    }
  }

  hasOverflow(): boolean {
    return this.overflowCutoff() !== null;
  }

  pruneOverflowBatch(): RoutineLogPruneBatch {
    const cutoff = this.overflowCutoff();
    if (cutoff === null) {
      return { deleted: 0, hadOverflow: false, filledBatch: false };
    }
    const deleted = this.db.prepare(`
      DELETE FROM logs
      WHERE id IN (
        SELECT id
        FROM logs
        WHERE id <= @cutoff
          AND level NOT IN ('warn', 'error')
        ORDER BY id ASC
        LIMIT @batchRows
      )
    `).run({ cutoff, batchRows: this.batchRows }).changes;
    return {
      deleted,
      hadOverflow: true,
      filledBatch: deleted === this.batchRows,
    };
  }

  private overflowCutoff(): number | null {
    const row = this.db.prepare(`
      SELECT id
      FROM logs
      WHERE level NOT IN ('warn', 'error')
      ORDER BY id DESC
      LIMIT 1 OFFSET ?
    `).get(this.rowCap) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private isRoutineLevel(level: string): boolean {
    return level !== 'warn' && level !== 'error';
  }
}
