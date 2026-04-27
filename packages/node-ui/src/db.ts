import Database from 'better-sqlite3';
import { join } from 'node:path';

const SCHEMA_VERSION = 9;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_SEMANTIC_ENRICHMENT_LEASE_MS = 5 * 60_000;
const DEFAULT_SEMANTIC_ENRICHMENT_RETRY_BASE_MS = 1_000;
const DEFAULT_SEMANTIC_ENRICHMENT_RETRY_MAX_MS = 5 * 60_000;

export interface DashboardDBOptions {
  /** Directory to store the SQLite database file. */
  dataDir: string;
  /** Days to retain data before pruning. Default: 90 */
  retentionDays?: number;
}

export class DashboardDB {
  readonly db: Database.Database;
  readonly dataDir: string;
  private retentionDays: number;

  constructor(opts: DashboardDBOptions) {
    this.dataDir = opts.dataDir;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const dbPath = join(opts.dataDir, 'node-ui.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.prune();
  }

  getRetentionDays(): number { return this.retentionDays; }
  setRetentionDays(days: number): void {
    this.retentionDays = Math.max(1, Math.min(365, days));
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('retentionDays', ?)").run(String(this.retentionDays));
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metric_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          cpu_percent REAL,
          mem_used_bytes INTEGER,
          mem_total_bytes INTEGER,
          disk_used_bytes INTEGER,
          disk_total_bytes INTEGER,
          heap_used_bytes INTEGER,
          uptime_seconds INTEGER,
          peer_count INTEGER,
          direct_peers INTEGER,
          relayed_peers INTEGER,
          mesh_peers INTEGER,
          paranet_count INTEGER,
          total_triples INTEGER,
          total_kcs INTEGER,
          total_kas INTEGER,
          store_bytes INTEGER,
          confirmed_kcs INTEGER,
          tentative_kcs INTEGER,
          rpc_latency_ms INTEGER,
          rpc_healthy INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON metric_snapshots(ts);

        CREATE TABLE IF NOT EXISTS operations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL,
          operation_name TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          duration_ms INTEGER,
          status TEXT DEFAULT 'in_progress',
          peer_id TEXT,
          paranet_id TEXT,
          triple_count INTEGER,
          error_message TEXT,
          details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ops_operation_id ON operations(operation_id);
        CREATE INDEX IF NOT EXISTS idx_ops_started_at ON operations(started_at);
        CREATE INDEX IF NOT EXISTS idx_ops_name ON operations(operation_name);

        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          level TEXT NOT NULL,
          operation_name TEXT,
          operation_id TEXT,
          module TEXT,
          message TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
        CREATE INDEX IF NOT EXISTS idx_logs_operation_id ON logs(operation_id);
        CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

        CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
          message, content=logs, content_rowid=id
        );

        CREATE TRIGGER IF NOT EXISTS logs_ai AFTER INSERT ON logs BEGIN
          INSERT INTO logs_fts(rowid, message) VALUES (new.id, new.message);
        END;
        CREATE TRIGGER IF NOT EXISTS logs_ad AFTER DELETE ON logs BEGIN
          INSERT INTO logs_fts(logs_fts, rowid, message) VALUES('delete', old.id, old.message);
        END;

        CREATE TABLE IF NOT EXISTS query_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          sparql TEXT NOT NULL,
          duration_ms INTEGER,
          result_count INTEGER,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_qhist_ts ON query_history(ts);

        CREATE TABLE IF NOT EXISTS saved_queries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          sparql TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    }

    if (version < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS operation_phases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL,
          phase TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          duration_ms INTEGER,
          status TEXT DEFAULT 'in_progress',
          details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_phases_op ON operation_phases(operation_id);

        ALTER TABLE operations ADD COLUMN gas_used INTEGER;
        ALTER TABLE operations ADD COLUMN gas_price_gwei REAL;
        ALTER TABLE operations ADD COLUMN gas_cost_eth REAL;
        ALTER TABLE operations ADD COLUMN trac_cost REAL;
        ALTER TABLE operations ADD COLUMN tx_hash TEXT;
        ALTER TABLE operations ADD COLUMN chain_id INTEGER;
      `);
    }

    if (version < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          direction TEXT NOT NULL,
          peer TEXT NOT NULL,
          peer_name TEXT,
          text TEXT NOT NULL,
          delivered INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_chat_ts ON chat_messages(ts);
        CREATE INDEX IF NOT EXISTS idx_chat_peer ON chat_messages(peer);
      `);
    }

    if (version < 4) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_persistence_jobs (
          turn_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          user_message TEXT NOT NULL,
          assistant_reply TEXT NOT NULL,
          tool_calls_json TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          next_attempt_at INTEGER NOT NULL,
          queued_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          store_ms INTEGER,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chat_persist_status_next
          ON chat_persistence_jobs(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_chat_persist_session
          ON chat_persistence_jobs(session_id);
      `);
    }

    if (version < 5) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          source TEXT,
          peer TEXT,
          read INTEGER NOT NULL DEFAULT 0,
          meta TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts);
        CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(read);
      `);
    }

    if (version < 6) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }

    if (version < 7) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_enrichment_events (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          semantic_triple_count INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          next_attempt_at INTEGER NOT NULL,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_semantic_enrichment_status_next
          ON semantic_enrichment_events(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_semantic_enrichment_status_lease
          ON semantic_enrichment_events(status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS idx_semantic_enrichment_updated_at
          ON semantic_enrichment_events(updated_at);
      `);
    }

    if (version < 8) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS extraction_status_snapshots (
          assertion_uri TEXT PRIMARY KEY,
          record_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_extraction_status_snapshots_updated_at
          ON extraction_status_snapshots(updated_at);
      `);
    }

    if (version < 9) {
      const semanticEventColumns = this.db
        .prepare(`PRAGMA table_info(semantic_enrichment_events)`)
        .all() as Array<{ name?: string }>;
      if (!semanticEventColumns.some((column) => column.name === 'semantic_triple_count')) {
        this.db.exec(`
          ALTER TABLE semantic_enrichment_events
          ADD COLUMN semantic_triple_count INTEGER NOT NULL DEFAULT 0
        `);
      }
    }

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);

    const savedRetention = this.db.prepare("SELECT value FROM settings WHERE key = 'retentionDays'").get() as { value: string } | undefined;
    if (savedRetention) {
      const days = Number(savedRetention.value);
      if (Number.isFinite(days) && days >= 1 && days <= 365) {
        this.retentionDays = days;
      }
    }
  }

  prune(): void {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    this.db.exec(`DELETE FROM metric_snapshots WHERE ts < ${cutoff}`);
    this.db.exec(`DELETE FROM operation_phases WHERE started_at < ${cutoff}`);
    this.db.exec(`DELETE FROM operations WHERE started_at < ${cutoff}`);
    this.db.exec(`DELETE FROM logs WHERE ts < ${cutoff}`);
    this.db.exec(`DELETE FROM query_history WHERE ts < ${cutoff}`);
    this.db.exec(`DELETE FROM chat_messages WHERE ts < ${cutoff}`);
    this.db.exec(`DELETE FROM chat_persistence_jobs WHERE updated_at < ${cutoff} AND status IN ('stored', 'failed')`);
    this.db.exec(`DELETE FROM semantic_enrichment_events WHERE updated_at < ${cutoff} AND status IN ('completed', 'dead_letter')`);
    this.db.exec(`DELETE FROM extraction_status_snapshots WHERE updated_at < ${cutoff}`);
    this.db.exec(`DELETE FROM notifications WHERE ts < ${cutoff}`);
  }

  // --- Prepared statements (lazy-initialized) ---

  private _stmts: Record<string, Database.Statement> = {};

  private stmt(key: string, sql: string): Database.Statement {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  // --- Metric snapshots ---

  insertSnapshot(snap: MetricSnapshotRow): void {
    this.stmt('insertSnapshot', `
      INSERT INTO metric_snapshots (
        ts, cpu_percent, mem_used_bytes, mem_total_bytes,
        disk_used_bytes, disk_total_bytes, heap_used_bytes, uptime_seconds,
        peer_count, direct_peers, relayed_peers, mesh_peers, paranet_count,
        total_triples, total_kcs, total_kas, store_bytes,
        confirmed_kcs, tentative_kcs, rpc_latency_ms, rpc_healthy
      ) VALUES (
        @ts, @cpu_percent, @mem_used_bytes, @mem_total_bytes,
        @disk_used_bytes, @disk_total_bytes, @heap_used_bytes, @uptime_seconds,
        @peer_count, @direct_peers, @relayed_peers, @mesh_peers, @paranet_count,
        @total_triples, @total_kcs, @total_kas, @store_bytes,
        @confirmed_kcs, @tentative_kcs, @rpc_latency_ms, @rpc_healthy
      )
    `).run(snap);
  }

  getLatestSnapshot(): MetricSnapshotRow | undefined {
    return this.db.prepare(
      'SELECT * FROM metric_snapshots ORDER BY ts DESC LIMIT 1',
    ).get() as MetricSnapshotRow | undefined;
  }

  getSnapshotHistory(from: number, to: number, maxPoints = 500): MetricSnapshotRow[] {
    const total = this.db.prepare(
      'SELECT COUNT(*) as c FROM metric_snapshots WHERE ts >= ? AND ts <= ?',
    ).get(from, to) as { c: number };

    if (total.c <= maxPoints) {
      return this.db.prepare(
        'SELECT * FROM metric_snapshots WHERE ts >= ? AND ts <= ? ORDER BY ts',
      ).all(from, to) as MetricSnapshotRow[];
    }

    const step = Math.ceil(total.c / maxPoints);
    return this.db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (ORDER BY ts) as rn
        FROM metric_snapshots WHERE ts >= ? AND ts <= ?
      ) WHERE rn % ? = 0 ORDER BY ts
    `).all(from, to, step) as MetricSnapshotRow[];
  }

  // --- Operations ---

  insertOperation(op: {
    operation_id: string;
    operation_name: string;
    started_at: number;
    peer_id?: string | null;
    paranet_id?: string | null;
    details?: string | null;
  }): void {
    this.stmt('insertOp', `
      INSERT INTO operations (operation_id, operation_name, started_at, status, peer_id, paranet_id, details)
      VALUES (@operation_id, @operation_name, @started_at, 'in_progress', @peer_id, @paranet_id, @details)
    `).run({
      operation_id: op.operation_id,
      operation_name: op.operation_name,
      started_at: op.started_at,
      peer_id: op.peer_id ?? null,
      paranet_id: op.paranet_id ?? null,
      details: op.details ?? null,
    });
  }

  completeOperation(op: {
    operation_id: string;
    duration_ms: number;
    triple_count?: number | null;
    details?: string | null;
  }): void {
    this.stmt('completeOp', `
      UPDATE operations SET status = 'success', duration_ms = @duration_ms,
        triple_count = @triple_count, details = COALESCE(@details, details)
      WHERE operation_id = @operation_id AND status = 'in_progress'
    `).run({
      operation_id: op.operation_id,
      duration_ms: op.duration_ms,
      triple_count: op.triple_count ?? null,
      details: op.details ?? null,
    });
  }

  failOperation(op: {
    operation_id: string;
    duration_ms: number;
    error_message: string;
  }): void {
    this.stmt('failOp', `
      UPDATE operations SET status = 'error', duration_ms = @duration_ms,
        error_message = @error_message
      WHERE operation_id = @operation_id AND status = 'in_progress'
    `).run(op);
  }

  getOperations(opts: {
    name?: string;
    status?: string;
    operationId?: string;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  } = {}): { operations: OperationRow[]; total: number } {
    const wheres: string[] = [];
    const params: unknown[] = [];

    if (opts.name) { wheres.push('operation_name = ?'); params.push(opts.name); }
    if (opts.status) { wheres.push('status = ?'); params.push(opts.status); }
    if (opts.operationId) { wheres.push('operation_id = ?'); params.push(opts.operationId); }
    if (opts.from) { wheres.push('started_at >= ?'); params.push(opts.from); }
    if (opts.to) { wheres.push('started_at <= ?'); params.push(opts.to); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;

    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM operations ${where}`).get(...params) as { c: number }).c;
    const operations = this.db.prepare(
      `SELECT * FROM operations ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as OperationRow[];

    return { operations, total };
  }

  getOperationsWithPhases(opts: {
    name?: string;
    status?: string;
    operationId?: string;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  } = {}): { operations: (OperationRow & { phases: OperationPhaseRow[] })[]; total: number } {
    const { operations, total } = this.getOperations(opts);
    if (operations.length === 0) return { operations: [], total };

    const ids = operations.map(o => o.operation_id);
    const placeholders = ids.map(() => '?').join(',');
    const allPhases = this.db.prepare(
      `SELECT * FROM operation_phases WHERE operation_id IN (${placeholders}) ORDER BY started_at`,
    ).all(...ids) as OperationPhaseRow[];

    const phaseMap = new Map<string, OperationPhaseRow[]>();
    for (const p of allPhases) {
      const arr = phaseMap.get(p.operation_id) ?? [];
      arr.push(p);
      phaseMap.set(p.operation_id, arr);
    }

    return {
      operations: operations.map(o => ({ ...o, phases: phaseMap.get(o.operation_id) ?? [] })),
      total,
    };
  }

  getErrorHotspots(periodMs = 7 * 86_400_000): { phase: string; operation_name: string; error_count: number; last_error: string | null; last_occurred: number | null }[] {
    const cutoff = Date.now() - periodMs;
    return this.db.prepare(`
      SELECT
        p.phase,
        o.operation_name,
        COUNT(*) as error_count,
        (SELECT p2.details FROM operation_phases p2
         JOIN operations o2 ON o2.operation_id = p2.operation_id
         WHERE p2.phase = p.phase AND o2.operation_name = o.operation_name
           AND p2.status = 'error' AND p2.started_at >= ?
         ORDER BY p2.started_at DESC LIMIT 1) as last_error,
        MAX(p.started_at) as last_occurred
      FROM operation_phases p
      JOIN operations o ON o.operation_id = p.operation_id
      WHERE p.status = 'error' AND p.started_at >= ?
      GROUP BY p.phase, o.operation_name
      ORDER BY error_count DESC
    `).all(cutoff, cutoff) as any[];
  }

  getFailedOperations(opts: { phase?: string; operationName?: string; periodMs?: number; q?: string; limit?: number } = {}): {
    operations: Array<OperationRow & { phase: string; phase_error: string | null; phase_started_at: number; logs: LogRow[] }>;
  } {
    const cutoff = Date.now() - (opts.periodMs ?? 7 * 86_400_000);
    const limit = opts.limit ?? 50;

    let where = 'p.status = ? AND p.started_at >= ?';
    const params: any[] = ['error', cutoff];

    if (opts.phase) {
      where += ' AND p.phase = ?';
      params.push(opts.phase);
    }
    if (opts.operationName) {
      where += ' AND o.operation_name = ?';
      params.push(opts.operationName);
    }
    if (opts.q) {
      where += ' AND (p.details LIKE ? OR o.operation_id LIKE ? OR o.error_message LIKE ?)';
      const like = `%${opts.q}%`;
      params.push(like, like, like);
    }
    params.push(limit);

    const rows = this.db.prepare(`
      SELECT
        o.*,
        p.phase AS phase,
        p.details AS phase_error,
        p.started_at AS phase_started_at
      FROM operation_phases p
      JOIN operations o ON o.operation_id = p.operation_id
      WHERE ${where}
      ORDER BY p.started_at DESC
      LIMIT ?
    `).all(...params) as Array<OperationRow & { phase: string; phase_error: string | null; phase_started_at: number }>;

    const operations = rows.map(row => {
      const logs = this.db.prepare(
        'SELECT * FROM logs WHERE operation_id = ? ORDER BY ts DESC LIMIT 20',
      ).all(row.operation_id) as LogRow[];
      logs.reverse();
      return { ...row, logs };
    });

    return { operations };
  }

  getOperation(operationId: string): { operation: OperationRow | null; logs: LogRow[]; phases: OperationPhaseRow[] } {
    const operation = this.db.prepare(
      'SELECT * FROM operations WHERE operation_id = ?',
    ).get(operationId) as OperationRow | null;

    const logs = this.db.prepare(
      'SELECT * FROM logs WHERE operation_id = ? ORDER BY ts',
    ).all(operationId) as LogRow[];

    const phases = this.db.prepare(
      'SELECT * FROM operation_phases WHERE operation_id = ? ORDER BY started_at',
    ).all(operationId) as OperationPhaseRow[];

    return { operation, logs, phases };
  }

  // --- Operation phases ---

  insertPhase(op: { operation_id: string; phase: string; started_at: number }): void {
    this.stmt('insertPhase', `
      INSERT INTO operation_phases (operation_id, phase, started_at, status)
      VALUES (@operation_id, @phase, @started_at, 'in_progress')
    `).run(op);
  }

  completePhase(op: { operation_id: string; phase: string; duration_ms: number }): void {
    this.stmt('completePhase', `
      UPDATE operation_phases SET status = 'success', duration_ms = @duration_ms
      WHERE operation_id = @operation_id AND phase = @phase AND status = 'in_progress'
    `).run(op);
  }

  failPhase(op: { operation_id: string; phase: string; duration_ms: number; error_message: string }): void {
    this.stmt('failPhase', `
      UPDATE operation_phases SET status = 'error', duration_ms = @duration_ms,
        details = @error_message
      WHERE operation_id = @operation_id AND phase = @phase AND status = 'in_progress'
    `).run(op);
  }

  failAllPhases(op: { operation_id: string; duration_ms: number; error_message: string }): void {
    this.stmt('failAllPhases', `
      UPDATE operation_phases SET status = 'error', duration_ms = @duration_ms,
        details = @error_message
      WHERE operation_id = @operation_id AND status = 'in_progress'
    `).run(op);
  }

  // --- Operation cost & tx ---

  setOperationCost(op: {
    operation_id: string;
    gas_used?: number | null;
    gas_price_gwei?: number | null;
    gas_cost_eth?: number | null;
    trac_cost?: number | null;
    tx_hash?: string | null;
    chain_id?: number | null;
  }): void {
    this.stmt('setCost', `
      UPDATE operations SET
        gas_used = COALESCE(@gas_used, gas_used),
        gas_price_gwei = COALESCE(@gas_price_gwei, gas_price_gwei),
        gas_cost_eth = COALESCE(@gas_cost_eth, gas_cost_eth),
        trac_cost = COALESCE(@trac_cost, trac_cost),
        tx_hash = COALESCE(@tx_hash, tx_hash),
        chain_id = COALESCE(@chain_id, chain_id)
      WHERE operation_id = @operation_id
    `).run({
      operation_id: op.operation_id,
      gas_used: op.gas_used ?? null,
      gas_price_gwei: op.gas_price_gwei ?? null,
      gas_cost_eth: op.gas_cost_eth ?? null,
      trac_cost: op.trac_cost ?? null,
      tx_hash: op.tx_hash ?? null,
      chain_id: op.chain_id ?? null,
    });
  }

  // --- Operation stats ---

  getOperationStats(opts: {
    name?: string;
    periodMs: number;
    bucketMs: number;
  }): { summary: OperationStatsSummary; timeSeries: OperationStatsBucket[] } {
    const cutoff = Date.now() - opts.periodMs;
    const nameFilter = opts.name ? 'AND operation_name = ?' : '';
    const params: unknown[] = [cutoff];
    if (opts.name) params.push(opts.name);

    const summaryRow = this.db.prepare(`
      SELECT
        COUNT(*) as totalCount,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errorCount,
        AVG(CASE WHEN status = 'success' THEN duration_ms END) as avgDurationMs,
        AVG(gas_cost_eth) as avgGasCostEth,
        SUM(gas_cost_eth) as totalGasCostEth,
        AVG(trac_cost) as avgTracCost,
        SUM(trac_cost) as totalTracCost
      FROM operations WHERE started_at >= ? ${nameFilter}
    `).get(...params) as any;

    const summary: OperationStatsSummary = {
      totalCount: summaryRow.totalCount ?? 0,
      successCount: summaryRow.successCount ?? 0,
      errorCount: summaryRow.errorCount ?? 0,
      successRate: summaryRow.totalCount > 0 ? (summaryRow.successCount ?? 0) / summaryRow.totalCount : 0,
      avgDurationMs: summaryRow.avgDurationMs ?? 0,
      avgGasCostEth: summaryRow.avgGasCostEth ?? 0,
      totalGasCostEth: summaryRow.totalGasCostEth ?? 0,
      avgTracCost: summaryRow.avgTracCost ?? 0,
      totalTracCost: summaryRow.totalTracCost ?? 0,
    };

    const bucketSize = opts.bucketMs;
    const tsParams: unknown[] = [bucketSize, cutoff];
    if (opts.name) tsParams.push(opts.name);

    const timeSeries = this.db.prepare(`
      SELECT
        (CAST(started_at / ? AS INTEGER) * ?) as bucket,
        COUNT(*) as count,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
        AVG(CASE WHEN status = 'success' THEN duration_ms END) as avgDurationMs,
        AVG(gas_cost_eth) as avgGasCostEth,
        SUM(gas_cost_eth) as totalGasCostEth
      FROM operations
      WHERE started_at >= ? ${nameFilter}
      GROUP BY bucket ORDER BY bucket
    `).all(bucketSize, bucketSize, ...params) as any[];

    return {
      summary,
      timeSeries: timeSeries.map((r: any) => ({
        bucket: r.bucket,
        count: r.count,
        successRate: r.count > 0 ? r.successCount / r.count : 0,
        avgDurationMs: r.avgDurationMs ?? 0,
        avgGasCostEth: r.avgGasCostEth ?? 0,
        totalGasCostEth: r.totalGasCostEth ?? 0,
      })),
    };
  }

  // --- Per-type time series ---

  getPerTypeTimeSeries(opts: { periodMs: number; bucketMs: number }): {
    buckets: number[];
    types: string[];
    series: Record<string, { count: number; avgMs: number; successRate: number; gasCostEth: number }[]>;
  } {
    const cutoff = Date.now() - opts.periodMs;
    const rows = this.db.prepare(`
      SELECT
        (CAST(started_at / ? AS INTEGER) * ?) as bucket,
        operation_name as type,
        COUNT(*) as count,
        AVG(CASE WHEN status = 'success' THEN duration_ms END) as avgMs,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
        SUM(gas_cost_eth) as gasCostEth
      FROM operations WHERE started_at >= ?
      GROUP BY bucket, operation_name ORDER BY bucket
    `).all(opts.bucketMs, opts.bucketMs, cutoff) as any[];

    const bucketSet = new Set<number>();
    const typeSet = new Set<string>();
    for (const r of rows) { bucketSet.add(r.bucket); typeSet.add(r.type); }

    const buckets = [...bucketSet].sort((a, b) => a - b);
    const types = [...typeSet].sort();

    const byBucketType = new Map<string, any>();
    for (const r of rows) byBucketType.set(`${r.bucket}:${r.type}`, r);

    const series: Record<string, { count: number; avgMs: number; successRate: number; gasCostEth: number }[]> = {};
    for (const t of types) {
      series[t] = buckets.map(b => {
        const r = byBucketType.get(`${b}:${t}`);
        return {
          count: r?.count ?? 0,
          avgMs: r?.avgMs ?? 0,
          successRate: r ? (r.count > 0 ? r.successCount / r.count : 0) : 0,
          gasCostEth: r?.gasCostEth ?? 0,
        };
      });
    }

    return { buckets, types, series };
  }

  // --- Success rates by operation type ---

  getSuccessRatesByType(periodMs: number): { type: string; total: number; success: number; error: number; rate: number; avgMs: number }[] {
    const cutoff = Date.now() - periodMs;
    return (this.db.prepare(`
      SELECT
        operation_name as type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
        AVG(CASE WHEN status = 'success' THEN duration_ms END) as avgMs
      FROM operations WHERE started_at >= ?
      GROUP BY operation_name ORDER BY total DESC
    `).all(cutoff) as any[]).map(r => ({
      ...r,
      rate: r.total > 0 ? r.success / r.total : 0,
      avgMs: r.avgMs ?? 0,
    }));
  }

  // --- Spending summary ---

  getSpendingSummary(): SpendingSummary {
    const periods = [
      { label: '24h', ms: 86_400_000 },
      { label: '7d', ms: 7 * 86_400_000 },
      { label: '30d', ms: 30 * 86_400_000 },
      { label: 'all', ms: Date.now() },
    ];
    const now = Date.now();

    const results: SpendingSummary = { periods: [] };

    for (const p of periods) {
      const cutoff = now - p.ms;
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as publishCount,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCount,
          COALESCE(SUM(gas_cost_eth), 0) as totalGasEth,
          COALESCE(SUM(trac_cost), 0) as totalTrac,
          COALESCE(AVG(gas_cost_eth), 0) as avgGasEth,
          COALESCE(AVG(trac_cost), 0) as avgTrac
        FROM operations
        WHERE operation_name = 'publish' AND started_at >= ?
      `).get(cutoff) as any;

      results.periods.push({
        label: p.label,
        publishCount: row.publishCount ?? 0,
        successCount: row.successCount ?? 0,
        totalGasEth: row.totalGasEth,
        totalTrac: row.totalTrac,
        avgGasEth: row.avgGasEth,
        avgTrac: row.avgTrac,
      });
    }

    return results;
  }

  // --- Chat messages ---

  insertChatMessage(msg: {
    ts: number;
    direction: 'in' | 'out';
    peer: string;
    peerName?: string | null;
    text: string;
    delivered?: boolean | null;
  }): void {
    this.stmt('insertChat', `
      INSERT INTO chat_messages (ts, direction, peer, peer_name, text, delivered)
      VALUES (@ts, @direction, @peer, @peer_name, @text, @delivered)
    `).run({
      ts: msg.ts,
      direction: msg.direction,
      peer: msg.peer,
      peer_name: msg.peerName ?? null,
      text: msg.text,
      delivered: msg.delivered == null ? null : msg.delivered ? 1 : 0,
    });
  }

  getChatMessages(opts: {
    peer?: string;
    since?: number;
    limit?: number;
  } = {}): ChatMessageRow[] {
    let sql = 'SELECT * FROM chat_messages WHERE 1=1';
    const params: unknown[] = [];

    if (opts.since) {
      sql += ' AND ts > ?';
      params.push(opts.since);
    }
    if (opts.peer) {
      sql += ' AND peer = ?';
      params.push(opts.peer);
    }
    sql += ' ORDER BY ts DESC LIMIT ?';
    params.push(opts.limit ?? 200);

    return (this.db.prepare(sql).all(...params) as ChatMessageRow[]).reverse();
  }

  // --- Chat persistence jobs ---

  getChatPersistenceJob(turnId: string): ChatPersistenceJobRow | undefined {
    return this.db.prepare(
      'SELECT * FROM chat_persistence_jobs WHERE turn_id = ?',
    ).get(turnId) as ChatPersistenceJobRow | undefined;
  }

  insertChatPersistenceJob(job: {
    turn_id: string;
    session_id: string;
    user_message: string;
    assistant_reply: string;
    tool_calls_json?: string | null;
    status: ChatPersistenceStatus;
    attempts: number;
    max_attempts: number;
    next_attempt_at: number;
    queued_at: number;
    updated_at: number;
    store_ms?: number | null;
    error_message?: string | null;
  }): void {
    this.stmt('insertChatPersistenceJob', `
      INSERT INTO chat_persistence_jobs (
        turn_id, session_id, user_message, assistant_reply, tool_calls_json,
        status, attempts, max_attempts, next_attempt_at, queued_at, updated_at,
        store_ms, error_message
      ) VALUES (
        @turn_id, @session_id, @user_message, @assistant_reply, @tool_calls_json,
        @status, @attempts, @max_attempts, @next_attempt_at, @queued_at, @updated_at,
        @store_ms, @error_message
      )
    `).run({
      ...job,
      tool_calls_json: job.tool_calls_json ?? null,
      store_ms: job.store_ms ?? null,
      error_message: job.error_message ?? null,
    });
  }

  markChatPersistenceInProgress(turnId: string, attempts: number, updatedAt: number): void {
    this.stmt('markChatPersistenceInProgress', `
      UPDATE chat_persistence_jobs
      SET status = 'in_progress', attempts = ?, updated_at = ?, error_message = NULL
      WHERE turn_id = ?
    `).run(attempts, updatedAt, turnId);
  }

  markChatPersistenceStored(turnId: string, storeMs: number, updatedAt: number): void {
    this.stmt('markChatPersistenceStored', `
      UPDATE chat_persistence_jobs
      SET status = 'stored', store_ms = ?, updated_at = ?, error_message = NULL
      WHERE turn_id = ?
    `).run(storeMs, updatedAt, turnId);
  }

  markChatPersistencePendingRetry(turnId: string, attempts: number, nextAttemptAt: number, updatedAt: number, errorMessage: string): void {
    this.stmt('markChatPersistencePendingRetry', `
      UPDATE chat_persistence_jobs
      SET status = 'pending', attempts = ?, next_attempt_at = ?, updated_at = ?, error_message = ?
      WHERE turn_id = ?
    `).run(attempts, nextAttemptAt, updatedAt, errorMessage, turnId);
  }

  markChatPersistenceFailed(turnId: string, attempts: number, updatedAt: number, errorMessage: string): void {
    this.stmt('markChatPersistenceFailed', `
      UPDATE chat_persistence_jobs
      SET status = 'failed', attempts = ?, updated_at = ?, error_message = ?
      WHERE turn_id = ?
    `).run(attempts, updatedAt, errorMessage, turnId);
  }

  recoverInProgressChatPersistenceJobs(now: number): void {
    this.stmt('recoverInProgressChatPersistenceJobs', `
      UPDATE chat_persistence_jobs
      SET status = 'pending', next_attempt_at = ?, updated_at = ?
      WHERE status = 'in_progress'
    `).run(now, now);
  }

  getRunnableChatPersistenceJobs(now: number, limit = 10): ChatPersistenceJobRow[] {
    return this.db.prepare(`
      SELECT * FROM chat_persistence_jobs
      WHERE status = 'pending' AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, queued_at ASC
      LIMIT ?
    `).all(now, limit) as ChatPersistenceJobRow[];
  }

  getNextPendingChatPersistenceAt(): number | null {
    const row = this.db.prepare(
      `SELECT MIN(next_attempt_at) AS next_at FROM chat_persistence_jobs WHERE status = 'pending'`,
    ).get() as { next_at: number | null };
    return row?.next_at ?? null;
  }

  getChatPersistenceHealth(now: number): ChatPersistenceHealthRow {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
        SUM(CASE WHEN status = 'stored' THEN 1 ELSE 0 END) AS stored_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN status = 'pending' AND next_attempt_at < ? THEN 1 ELSE 0 END) AS overdue_pending_count
      FROM chat_persistence_jobs
    `).get(now) as {
      pending_count: number | null;
      in_progress_count: number | null;
      stored_count: number | null;
      failed_count: number | null;
      overdue_pending_count: number | null;
    };

    const oldest = this.db.prepare(`
      SELECT MIN(queued_at) AS oldest_pending_queued_at
      FROM chat_persistence_jobs
      WHERE status = 'pending'
    `).get() as { oldest_pending_queued_at: number | null };

    return {
      pending_count: counts?.pending_count ?? 0,
      in_progress_count: counts?.in_progress_count ?? 0,
      stored_count: counts?.stored_count ?? 0,
      failed_count: counts?.failed_count ?? 0,
      overdue_pending_count: counts?.overdue_pending_count ?? 0,
      oldest_pending_queued_at: oldest?.oldest_pending_queued_at ?? null,
    };
  }

  // --- Semantic enrichment events ---

  getSemanticEnrichmentEvent(id: string): SemanticEnrichmentEventRow | undefined {
    return this.db.prepare(
      'SELECT * FROM semantic_enrichment_events WHERE id = ?',
    ).get(id) as SemanticEnrichmentEventRow | undefined;
  }

  getSemanticEnrichmentEventByIdempotencyKey(idempotencyKey: string): SemanticEnrichmentEventRow | undefined {
    return this.db.prepare(
      'SELECT * FROM semantic_enrichment_events WHERE idempotency_key = ?',
    ).get(idempotencyKey) as SemanticEnrichmentEventRow | undefined;
  }

  insertSemanticEnrichmentEvent(event: {
    id: string;
    kind: string;
    idempotency_key: string;
    payload_json: string;
    status: SemanticEnrichmentStatus;
    semantic_triple_count?: number;
    attempts: number;
    max_attempts: number;
    next_attempt_at: number;
    lease_owner?: string | null;
    lease_expires_at?: number | null;
    last_error?: string | null;
    created_at: number;
    updated_at: number;
  }): void {
    this.stmt('insertSemanticEnrichmentEvent', `
      INSERT INTO semantic_enrichment_events (
        id, kind, idempotency_key, payload_json, status, semantic_triple_count, attempts, max_attempts,
        next_attempt_at, lease_owner, lease_expires_at, last_error, created_at, updated_at
      ) VALUES (
        @id, @kind, @idempotency_key, @payload_json, @status, @semantic_triple_count, @attempts, @max_attempts,
        @next_attempt_at, @lease_owner, @lease_expires_at, @last_error, @created_at, @updated_at
      )
    `).run({
      ...event,
      semantic_triple_count: event.semantic_triple_count ?? 0,
      lease_owner: event.lease_owner ?? null,
      lease_expires_at: event.lease_expires_at ?? null,
      last_error: event.last_error ?? null,
    });
  }

  refreshPendingSemanticEnrichmentEventPayload(
    id: string,
    payloadJson: string,
    semanticTripleCount: number,
    updatedAt: number,
  ): boolean {
    const result = this.stmt('refreshPendingSemanticEnrichmentEventPayload', `
      UPDATE semantic_enrichment_events
      SET payload_json = ?,
          status = 'pending',
          semantic_triple_count = ?,
          next_attempt_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(payloadJson, semanticTripleCount, updatedAt, updatedAt, id);
    return result.changes > 0;
  }

  reclaimExpiredSemanticEnrichmentEvents(now: number): number {
    const tx = this.db.transaction((reclaimNow: number) => {
      const leaseExpiredError = 'Semantic enrichment lease expired before completion';
      const deadLettered = this.db.prepare(`
        UPDATE semantic_enrichment_events
        SET status = 'dead_letter',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ?,
            updated_at = ?
        WHERE status = 'leased'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ?
          AND attempts >= max_attempts
      `).run(leaseExpiredError, reclaimNow, reclaimNow).changes;

      const reclaimed = this.stmt('reclaimExpiredSemanticEnrichmentEvents', `
        UPDATE semantic_enrichment_events
        SET status = 'pending',
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_attempt_at = ?,
            updated_at = ?
        WHERE status = 'leased'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < ?
          AND attempts < max_attempts
      `).run(reclaimNow, reclaimNow, reclaimNow).changes;

      return deadLettered + reclaimed;
    });

    return tx(now);
  }

  deadLetterActiveSemanticEnrichmentEvents(
    updatedAt: number,
    lastError: string,
  ): SemanticEnrichmentEventRow[] {
    const tx = this.db.transaction((ts: number, error: string) => {
      const rows = this.db.prepare(`
        SELECT * FROM semantic_enrichment_events
        WHERE status IN ('pending', 'leased')
        ORDER BY created_at ASC, id ASC
      `).all() as SemanticEnrichmentEventRow[];
      if (rows.length === 0) return [] as SemanticEnrichmentEventRow[];

      this.db.prepare(`
        UPDATE semantic_enrichment_events
        SET status = 'dead_letter',
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = ?,
            updated_at = ?
        WHERE status IN ('pending', 'leased')
      `).run(error, ts);

      return rows.map((row) => ({
        ...row,
        status: 'dead_letter' as const,
        lease_owner: null,
        lease_expires_at: null,
        last_error: error,
        updated_at: ts,
      }));
    });

    return tx(updatedAt, lastError);
  }

  claimNextRunnableSemanticEnrichmentEvent(
    now: number,
    leaseOwner: string,
    leaseTtlMs = DEFAULT_SEMANTIC_ENRICHMENT_LEASE_MS,
  ): SemanticEnrichmentEventRow | undefined {
    const tx = this.db.transaction((claimNow: number, owner: string, ttlMs: number) => {
      this.reclaimExpiredSemanticEnrichmentEvents(claimNow);

      const candidate = this.db.prepare(`
        SELECT id
        FROM semantic_enrichment_events
        WHERE status = 'pending' AND next_attempt_at <= ? AND attempts < max_attempts
        ORDER BY next_attempt_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(claimNow) as { id: string } | undefined;
      if (!candidate) return undefined;

      const updated = this.db.prepare(`
        UPDATE semantic_enrichment_events
        SET status = 'leased',
            attempts = attempts + 1,
            lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?,
            last_error = NULL
        WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND attempts < max_attempts
      `).run(owner, claimNow + ttlMs, claimNow, candidate.id, claimNow);
      if (updated.changes === 0) return undefined;
      return this.getSemanticEnrichmentEvent(candidate.id);
    });

    return tx(now, leaseOwner, leaseTtlMs);
  }

  renewSemanticEnrichmentLease(
    id: string,
    leaseOwner: string,
    now: number,
    leaseTtlMs = DEFAULT_SEMANTIC_ENRICHMENT_LEASE_MS,
  ): boolean {
    const result = this.stmt('renewSemanticEnrichmentLease', `
      UPDATE semantic_enrichment_events
      SET lease_expires_at = ?,
          updated_at = ?,
          last_error = NULL
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_expires_at > ?
    `).run(now + leaseTtlMs, now, id, leaseOwner, now);
    return result.changes > 0;
  }

  releaseSemanticEnrichmentLease(
    id: string,
    leaseOwner: string,
    now: number,
  ): boolean {
    const result = this.stmt('releaseSemanticEnrichmentLease', `
      UPDATE semantic_enrichment_events
      SET status = 'pending',
          next_attempt_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          last_error = NULL
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `).run(now, now, id, leaseOwner);
    return result.changes > 0;
  }

  completeSemanticEnrichmentEvent(
    id: string,
    leaseOwner: string,
    updatedAt: number,
    semanticTripleCount?: number,
  ): boolean {
    const result = this.stmt('completeSemanticEnrichmentEvent', `
      UPDATE semantic_enrichment_events
      SET status = 'completed',
          semantic_triple_count = COALESCE(?, semantic_triple_count),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          last_error = NULL
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `).run(semanticTripleCount ?? null, updatedAt, id, leaseOwner);
    return result.changes > 0;
  }

  failSemanticEnrichmentEvent(
    id: string,
    leaseOwner: string,
    attempts: number,
    maxAttempts: number,
    nextAttemptAt: number,
    updatedAt: number,
    errorMessage: string,
  ): SemanticEnrichmentStatus | undefined {
    const status: SemanticEnrichmentStatus = attempts >= maxAttempts ? 'dead_letter' : 'pending';
    const result = this.stmt('failSemanticEnrichmentEvent', `
      UPDATE semantic_enrichment_events
      SET status = ?,
          attempts = ?,
          next_attempt_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          last_error = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `).run(status, attempts, nextAttemptAt, updatedAt, errorMessage, id, leaseOwner);
    return result.changes > 0 ? status : undefined;
  }

  getRunnableSemanticEnrichmentEvents(now: number, limit = 10): SemanticEnrichmentEventRow[] {
    return this.db.prepare(`
      SELECT * FROM semantic_enrichment_events
      WHERE status = 'pending' AND next_attempt_at <= ? AND attempts < max_attempts
      ORDER BY next_attempt_at ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(now, limit) as SemanticEnrichmentEventRow[];
  }

  getNextPendingSemanticEnrichmentAt(): number | null {
    const row = this.db.prepare(
      `SELECT MIN(next_attempt_at) AS next_at FROM semantic_enrichment_events WHERE status = 'pending'`,
    ).get() as { next_at: number | null };
    return row?.next_at ?? null;
  }

  getSemanticEnrichmentHealth(now: number): SemanticEnrichmentHealthRow {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count,
        SUM(CASE WHEN status = 'pending' AND next_attempt_at < ? THEN 1 ELSE 0 END) AS overdue_pending_count,
        SUM(CASE WHEN status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ? THEN 1 ELSE 0 END) AS expired_lease_count
      FROM semantic_enrichment_events
    `).get(now, now) as {
      pending_count: number | null;
      leased_count: number | null;
      completed_count: number | null;
      dead_letter_count: number | null;
      overdue_pending_count: number | null;
      expired_lease_count: number | null;
    };

    const oldest = this.db.prepare(`
      SELECT MIN(created_at) AS oldest_pending_created_at
      FROM semantic_enrichment_events
      WHERE status = 'pending'
    `).get() as { oldest_pending_created_at: number | null };

    const nextPendingAt = this.getNextPendingSemanticEnrichmentAt();

    return {
      pending_count: counts?.pending_count ?? 0,
      leased_count: counts?.leased_count ?? 0,
      completed_count: counts?.completed_count ?? 0,
      dead_letter_count: counts?.dead_letter_count ?? 0,
      overdue_pending_count: counts?.overdue_pending_count ?? 0,
      expired_lease_count: counts?.expired_lease_count ?? 0,
      oldest_pending_created_at: oldest?.oldest_pending_created_at ?? null,
      next_pending_at: nextPendingAt,
    };
  }

  getSemanticEnrichmentRetryDelayMs(attempts: number): number {
    if (attempts <= 0) return DEFAULT_SEMANTIC_ENRICHMENT_RETRY_BASE_MS;
    const delay = DEFAULT_SEMANTIC_ENRICHMENT_RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1));
    return Math.min(delay, DEFAULT_SEMANTIC_ENRICHMENT_RETRY_MAX_MS);
  }

  getSemanticEnrichmentNextAttemptAt(now: number, attempts: number): number {
    return now + this.getSemanticEnrichmentRetryDelayMs(attempts);
  }

  // --- Extraction-status snapshots ---

  getExtractionStatusSnapshot(assertionUri: string): ExtractionStatusSnapshotRow | undefined {
    return this.db.prepare(
      'SELECT * FROM extraction_status_snapshots WHERE assertion_uri = ?',
    ).get(assertionUri) as ExtractionStatusSnapshotRow | undefined;
  }

  upsertExtractionStatusSnapshot(snapshot: {
    assertion_uri: string;
    record_json: string;
    updated_at: number;
  }): void {
    this.stmt('upsertExtractionStatusSnapshot', `
      INSERT INTO extraction_status_snapshots (assertion_uri, record_json, updated_at)
      VALUES (@assertion_uri, @record_json, @updated_at)
      ON CONFLICT(assertion_uri) DO UPDATE SET
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
    `).run(snapshot);
  }

  deleteExtractionStatusSnapshot(assertionUri: string): void {
    this.stmt('deleteExtractionStatusSnapshot', `
      DELETE FROM extraction_status_snapshots WHERE assertion_uri = ?
    `).run(assertionUri);
  }

  // --- Logs ---

  insertLog(entry: {
    ts: number;
    level: string;
    operation_name?: string | null;
    operation_id?: string | null;
    module: string;
    message: string;
  }): void {
    this.stmt('insertLog', `
      INSERT INTO logs (ts, level, operation_name, operation_id, module, message)
      VALUES (@ts, @level, @operation_name, @operation_id, @module, @message)
    `).run({
      ts: entry.ts,
      level: entry.level,
      operation_name: entry.operation_name ?? null,
      operation_id: entry.operation_id ?? null,
      module: entry.module,
      message: entry.message,
    });
  }

  searchLogs(opts: {
    q?: string;
    operationId?: string;
    level?: string;
    module?: string;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  } = {}): { logs: LogRow[]; total: number } {
    if (opts.q) {
      return this.searchLogsFts(opts);
    }

    const wheres: string[] = [];
    const params: unknown[] = [];

    if (opts.operationId) { wheres.push('operation_id = ?'); params.push(opts.operationId); }
    if (opts.level) { wheres.push('level = ?'); params.push(opts.level); }
    if (opts.module) { wheres.push('module = ?'); params.push(opts.module); }
    if (opts.from) { wheres.push('ts >= ?'); params.push(opts.from); }
    if (opts.to) { wheres.push('ts <= ?'); params.push(opts.to); }

    const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;

    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM logs ${where}`).get(...params) as { c: number }).c;
    const logs = this.db.prepare(
      `SELECT * FROM logs ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as LogRow[];

    return { logs, total };
  }

  private searchLogsFts(opts: {
    q?: string;
    operationId?: string;
    level?: string;
    module?: string;
    from?: number;
    to?: number;
    limit?: number;
    offset?: number;
  }): { logs: LogRow[]; total: number } {
    const wheres: string[] = ['logs_fts MATCH ?'];
    const params: unknown[] = [opts.q!];

    if (opts.operationId) { wheres.push('l.operation_id = ?'); params.push(opts.operationId); }
    if (opts.level) { wheres.push('l.level = ?'); params.push(opts.level); }
    if (opts.module) { wheres.push('l.module = ?'); params.push(opts.module); }
    if (opts.from) { wheres.push('l.ts >= ?'); params.push(opts.from); }
    if (opts.to) { wheres.push('l.ts <= ?'); params.push(opts.to); }

    const where = wheres.join(' AND ');
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;

    const total = (this.db.prepare(
      `SELECT COUNT(*) as c FROM logs l JOIN logs_fts ON l.id = logs_fts.rowid WHERE ${where}`,
    ).get(...params) as { c: number }).c;

    const logs = this.db.prepare(
      `SELECT l.* FROM logs l JOIN logs_fts ON l.id = logs_fts.rowid WHERE ${where} ORDER BY l.ts DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as LogRow[];

    return { logs, total };
  }

  // --- Query history ---

  insertQueryHistory(entry: {
    sparql: string;
    duration_ms: number;
    result_count?: number | null;
    error?: string | null;
  }): void {
    this.stmt('insertQueryHistory', `
      INSERT INTO query_history (ts, sparql, duration_ms, result_count, error)
      VALUES (@ts, @sparql, @duration_ms, @result_count, @error)
    `).run({
      ts: Date.now(),
      sparql: entry.sparql,
      duration_ms: entry.duration_ms,
      result_count: entry.result_count ?? null,
      error: entry.error ?? null,
    });
  }

  getQueryHistory(limit = 50, offset = 0): QueryHistoryRow[] {
    return this.db.prepare(
      'SELECT * FROM query_history ORDER BY ts DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as QueryHistoryRow[];
  }

  // --- Saved queries ---

  getSavedQueries(): SavedQueryRow[] {
    return this.db.prepare('SELECT * FROM saved_queries ORDER BY updated_at DESC').all() as SavedQueryRow[];
  }

  insertSavedQuery(entry: { name: string; description?: string; sparql: string }): number {
    const now = Date.now();
    const result = this.db.prepare(
      'INSERT INTO saved_queries (name, description, sparql, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(entry.name, entry.description ?? null, entry.sparql, now, now);
    return result.lastInsertRowid as number;
  }

  updateSavedQuery(id: number, entry: { name?: string; description?: string; sparql?: string }): void {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];
    if (entry.name !== undefined) { sets.push('name = ?'); params.push(entry.name); }
    if (entry.description !== undefined) { sets.push('description = ?'); params.push(entry.description); }
    if (entry.sparql !== undefined) { sets.push('sparql = ?'); params.push(entry.sparql); }
    params.push(id);
    this.db.prepare(`UPDATE saved_queries SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteSavedQuery(id: number): void {
    this.db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id);
  }

  // --- Notifications ---

  insertNotification(n: {
    ts: number;
    type: string;
    title: string;
    message: string;
    source?: string | null;
    peer?: string | null;
    meta?: string | null;
  }): number {
    const result = this.stmt('insertNotif', `
      INSERT INTO notifications (ts, type, title, message, source, peer, read, meta)
      VALUES (@ts, @type, @title, @message, @source, @peer, 0, @meta)
    `).run({
      ts: n.ts,
      type: n.type,
      title: n.title,
      message: n.message,
      source: n.source ?? null,
      peer: n.peer ?? null,
      meta: n.meta ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getNotifications(opts: { limit?: number; since?: number } = {}): { notifications: NotificationRow[]; unreadCount: number } {
    const limit = opts.limit ?? 100;
    const sinceClause = opts.since ? 'WHERE ts > ?' : '';
    const params: unknown[] = opts.since ? [opts.since] : [];

    const notifications = this.db.prepare(
      `SELECT * FROM notifications ${sinceClause} ORDER BY ts DESC LIMIT ?`,
    ).all(...params, limit) as NotificationRow[];

    const unread = this.db.prepare(
      'SELECT COUNT(*) as c FROM notifications WHERE read = 0',
    ).get() as { c: number };

    return { notifications, unreadCount: unread.c };
  }

  markNotificationsRead(ids?: number[]): number {
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const result = this.db.prepare(
        `UPDATE notifications SET read = 1 WHERE id IN (${placeholders}) AND read = 0`,
      ).run(...ids);
      return result.changes;
    }
    const result = this.db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

// --- Row types ---

export interface MetricSnapshotRow {
  id?: number;
  ts: number;
  cpu_percent: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  disk_used_bytes: number | null;
  disk_total_bytes: number | null;
  heap_used_bytes: number | null;
  uptime_seconds: number | null;
  peer_count: number | null;
  direct_peers: number | null;
  relayed_peers: number | null;
  mesh_peers: number | null;
  paranet_count: number | null;
  total_triples: number | null;
  total_kcs: number | null;
  total_kas: number | null;
  store_bytes: number | null;
  confirmed_kcs: number | null;
  tentative_kcs: number | null;
  rpc_latency_ms: number | null;
  rpc_healthy: number | null;
}

export interface OperationRow {
  id: number;
  operation_id: string;
  operation_name: string;
  started_at: number;
  duration_ms: number | null;
  status: string;
  peer_id: string | null;
  paranet_id: string | null;
  triple_count: number | null;
  error_message: string | null;
  details: string | null;
  gas_used: number | null;
  gas_price_gwei: number | null;
  gas_cost_eth: number | null;
  trac_cost: number | null;
  tx_hash: string | null;
  chain_id: number | null;
}

export interface OperationPhaseRow {
  id: number;
  operation_id: string;
  phase: string;
  started_at: number;
  duration_ms: number | null;
  status: string;
  details: string | null;
}

export interface OperationStatsSummary {
  totalCount: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  avgDurationMs: number;
  avgGasCostEth: number;
  totalGasCostEth: number;
  avgTracCost: number;
  totalTracCost: number;
}

export interface OperationStatsBucket {
  bucket: number;
  count: number;
  successRate: number;
  avgDurationMs: number;
  avgGasCostEth: number;
  totalGasCostEth: number;
}

export interface LogRow {
  id: number;
  ts: number;
  level: string;
  operation_name: string | null;
  operation_id: string | null;
  module: string | null;
  message: string;
}

export interface QueryHistoryRow {
  id: number;
  ts: number;
  sparql: string;
  duration_ms: number | null;
  result_count: number | null;
  error: string | null;
}

export interface SavedQueryRow {
  id: number;
  name: string;
  description: string | null;
  sparql: string;
  created_at: number;
  updated_at: number;
}

export interface NotificationRow {
  id: number;
  ts: number;
  type: string;
  title: string;
  message: string;
  source: string | null;
  peer: string | null;
  read: number;
  meta: string | null;
}

export interface ChatMessageRow {
  id: number;
  ts: number;
  direction: 'in' | 'out';
  peer: string;
  peer_name: string | null;
  text: string;
  delivered: number | null;
}

export type ChatPersistenceStatus = 'pending' | 'in_progress' | 'stored' | 'failed';

export interface ChatPersistenceJobRow {
  turn_id: string;
  session_id: string;
  user_message: string;
  assistant_reply: string;
  tool_calls_json: string | null;
  status: ChatPersistenceStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  queued_at: number;
  updated_at: number;
  store_ms: number | null;
  error_message: string | null;
}

export interface ChatPersistenceHealthRow {
  pending_count: number;
  in_progress_count: number;
  stored_count: number;
  failed_count: number;
  overdue_pending_count: number;
  oldest_pending_queued_at: number | null;
}

export type SemanticEnrichmentStatus = 'pending' | 'leased' | 'completed' | 'dead_letter';

export interface SemanticEnrichmentEventRow {
  id: string;
  kind: string;
  idempotency_key: string;
  payload_json: string;
  status: SemanticEnrichmentStatus;
  semantic_triple_count: number;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface SemanticEnrichmentHealthRow {
  pending_count: number;
  leased_count: number;
  completed_count: number;
  dead_letter_count: number;
  overdue_pending_count: number;
  expired_lease_count: number;
  oldest_pending_created_at: number | null;
  next_pending_at: number | null;
}

export interface ExtractionStatusSnapshotRow {
  assertion_uri: string;
  record_json: string;
  updated_at: number;
}

export interface SpendingPeriod {
  label: string;
  publishCount: number;
  successCount: number;
  totalGasEth: number;
  totalTrac: number;
  avgGasEth: number;
  avgTrac: number;
}

export interface SpendingSummary {
  periods: SpendingPeriod[];
}
