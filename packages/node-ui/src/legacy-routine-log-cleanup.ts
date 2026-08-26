import type Database from 'better-sqlite3';

const STATE_KEY = 'legacyRoutineLogCleanup.v3';

interface CleanupRange {
  /** Candidate ids are strictly greater than this boundary. */
  afterId: number;
  /** Candidate ids are less than or equal to this boundary. */
  throughId: number;
}

export interface LegacyRoutineLogCleanupState {
  version: 1;
  pendingRanges: CleanupRange[];
  writer: {
    status: 'active' | 'stopped';
    highWaterId: number;
  };
}

export interface LegacyRoutineLogDeleteBatchResult {
  deleted: number;
  hasMore: boolean;
}

/**
 * Finite upgrade migration for routine rows written by the former daemon
 * SQLite sink. The durable state records both the cleanup ranges and the last
 * id owned by this release's compatibility writer.
 *
 * On a clean shutdown the writer is marked stopped. If a later startup finds
 * rows beyond that id, an older rollback release wrote them, so exactly that
 * new interval is added to the migration. Rows written through this release
 * before shutdown, and rows written after the new cutover, stay outside the
 * interval. A crash leaves the writer active and therefore fails safe: rows
 * that might have come from the current compatibility API are not reclassified.
 *
 * Warning/error rows are always diagnostics. For a retained operation, the
 * newest routine row across the pending migration ranges is also kept as a
 * bounded summary so the operation detail API remains useful; older routine
 * traffic and orphaned operation IDs are drained.
 */
export class LegacyRoutineLogCleanup {
  constructor(
    private readonly db: Database.Database,
    private readonly batchRows: number,
  ) {
    this.initializeWriterSession();
  }

  state(): LegacyRoutineLogCleanupState {
    const state = this.readState();
    if (!state) throw new Error('Legacy routine-log cleanup state was not initialized');
    return state;
  }

  hasPendingRows(): boolean {
    const state = this.state();
    if (state.pendingRanges.length === 0) return false;
    const query = this.candidateQuery(state.pendingRanges, 'SELECT 1 FROM logs AS candidate');
    return this.db.prepare(`${query.sql} LIMIT 1`).get(query.params) !== undefined;
  }

  deleteBatch(): LegacyRoutineLogDeleteBatchResult {
    const state = this.state();
    if (state.pendingRanges.length === 0) return { deleted: 0, hasMore: false };
    const query = this.candidateQuery(
      state.pendingRanges,
      'SELECT candidate.id FROM logs AS candidate',
    );
    const deleted = this.db.prepare(`
      DELETE FROM logs
      WHERE id IN (
        ${query.sql}
        ORDER BY candidate.id ASC
        LIMIT @batchRows
      )
    `).run({ ...query.params, batchRows: this.batchRows }).changes;
    return { deleted, hasMore: deleted === this.batchRows };
  }

  markComplete(): void {
    const highWaterId = this.maxLogId();
    this.writeState({
      version: 1,
      pendingRanges: [],
      writer: { status: 'active', highWaterId },
    });
  }

  /** Record a clean current-writer shutdown so a later rollback is detectable. */
  markWriterStopped(): void {
    const current = this.readState();
    // Tests and repair tools may deliberately remove the marker before close.
    if (!current) return;
    this.writeState({
      ...current,
      writer: { status: 'stopped', highWaterId: this.maxLogId() },
    });
  }

  private initializeWriterSession(): void {
    const current = this.readState();
    const highWaterId = this.maxLogId();
    if (!current) {
      this.writeState({
        version: 1,
        pendingRanges: highWaterId > 0
          ? [{ afterId: 0, throughId: highWaterId }]
          : [],
        writer: { status: 'active', highWaterId },
      });
      return;
    }

    const rollbackRange = current.writer.status === 'stopped'
      && highWaterId > current.writer.highWaterId
      ? [{ afterId: current.writer.highWaterId, throughId: highWaterId }]
      : [];
    this.writeState({
      version: 1,
      pendingRanges: this.mergeRanges([...current.pendingRanges, ...rollbackRange]),
      writer: { status: 'active', highWaterId },
    });
  }

  private readState(): LegacyRoutineLogCleanupState | null {
    const row = this.db.prepare(
      `SELECT value FROM settings WHERE key = ?`,
    ).get(STATE_KEY) as { value: string } | undefined;
    return row ? this.parseState(row.value) : null;
  }

  private parseState(value: string): LegacyRoutineLogCleanupState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Invalid legacy routine-log cleanup state: ${value}`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Invalid legacy routine-log cleanup state: ${value}`);
    }
    const candidate = parsed as Partial<LegacyRoutineLogCleanupState>;
    const writer = candidate.writer;
    if (
      candidate.version !== 1
      || !Array.isArray(candidate.pendingRanges)
      || !writer
      || (writer.status !== 'active' && writer.status !== 'stopped')
      || !this.isValidId(writer.highWaterId)
      || candidate.pendingRanges.some((range) => (
        !range
        || !this.isValidId(range.afterId)
        || !this.isValidId(range.throughId)
        || range.afterId >= range.throughId
      ))
    ) {
      throw new Error(`Invalid legacy routine-log cleanup state: ${value}`);
    }
    return candidate as LegacyRoutineLogCleanupState;
  }

  private writeState(state: LegacyRoutineLogCleanupState): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(STATE_KEY, JSON.stringify(state));
  }

  private maxLogId(): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(id), 0) AS id FROM logs`,
    ).get() as { id: number };
    return row.id;
  }

  private isValidId(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  private mergeRanges(ranges: CleanupRange[]): CleanupRange[] {
    const ordered = [...ranges].sort((left, right) => left.afterId - right.afterId);
    const merged: CleanupRange[] = [];
    for (const range of ordered) {
      const previous = merged.at(-1);
      if (previous && range.afterId <= previous.throughId) {
        previous.throughId = Math.max(previous.throughId, range.throughId);
      } else {
        merged.push({ ...range });
      }
    }
    return merged;
  }

  private candidateQuery(
    ranges: CleanupRange[],
    select: string,
  ): { sql: string; params: Record<string, number> } {
    const params: Record<string, number> = {};
    const candidateRanges = ranges.map((range, index) => {
      params[`after${index}`] = range.afterId;
      params[`through${index}`] = range.throughId;
      return `(candidate.id > @after${index} AND candidate.id <= @through${index})`;
    });
    const newerRanges = candidateRanges.map((predicate) => (
      predicate.replaceAll('candidate.id', 'newer.id')
    ));
    return {
      params,
      sql: `
        ${select}
        WHERE (${candidateRanges.join(' OR ')})
          AND candidate.level IN ('debug', 'info')
          AND (
            candidate.operation_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM operations AS operation
              WHERE operation.operation_id = candidate.operation_id
            )
            OR EXISTS (
              SELECT 1
              FROM logs AS newer
              WHERE newer.operation_id = candidate.operation_id
                AND newer.id > candidate.id
                AND (${newerRanges.join(' OR ')})
                AND newer.level IN ('debug', 'info')
            )
          )
      `,
    };
  }
}
