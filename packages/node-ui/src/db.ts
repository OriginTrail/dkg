import Database from 'better-sqlite3';
import { join } from 'node:path';
import {
  RESPONSE_CACHE_BYTES,
  type IdempotencyCheckResult,
  type MessageDirection,
  type MessageIdempotencyStore,
  type ProtocolOutboxEntry,
  type ProtocolOutboxStore,
} from '@origintrail-official/dkg-core';

const SCHEMA_VERSION = 13;
const DEFAULT_RETENTION_DAYS = 90;

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
          contextGraph_count INTEGER,
          total_triples INTEGER,
          total_kcs INTEGER,
          total_kas INTEGER,
          store_bytes INTEGER,
          confirmed_kcs INTEGER,
          tentative_kcs INTEGER,
          rpc_latency_ms INTEGER,
          rpc_healthy INTEGER,
          relay_capacity INTEGER,
          relay_reservation_count INTEGER,
          relay_active_circuits INTEGER,
          relay_bytes_in INTEGER,
          relay_bytes_out INTEGER
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
          contextGraph_id TEXT,
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
      // The `message_id` column landed in V11 (chat receiver-side dedup
      // after the May 2026 soak postmortem's seq=13 duplicate finding).
      // We add it to the fresh-install CREATE so new nodes get the
      // column + the partial unique index in one step; the V11 block
      // below idempotently adds the column to nodes that upgraded
      // through versions 3..10 first.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          direction TEXT NOT NULL,
          peer TEXT NOT NULL,
          peer_name TEXT,
          text TEXT NOT NULL,
          delivered INTEGER,
          message_id TEXT
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
        CREATE TABLE IF NOT EXISTS context_graph_subscriptions (
          context_graph_id TEXT PRIMARY KEY,
          name TEXT,
          subscribed INTEGER NOT NULL,
          synced INTEGER NOT NULL,
          meta_synced INTEGER,
          on_chain_id TEXT,
          sync_scoped INTEGER NOT NULL DEFAULT 1,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cg_subs_sync_scoped
          ON context_graph_subscriptions(sync_scoped);
      `);
    }

    if (version < 8) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS context_graph_memberships (
          context_graph_id TEXT NOT NULL,
          principal_type TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          role TEXT,
          status TEXT NOT NULL,
          source TEXT,
          display_name TEXT,
          metadata TEXT,
          first_seen_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (context_graph_id, principal_type, principal_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cg_members_context
          ON context_graph_memberships(context_graph_id);
        CREATE INDEX IF NOT EXISTS idx_cg_members_principal
          ON context_graph_memberships(principal_type, principal_id);
        CREATE INDEX IF NOT EXISTS idx_cg_members_status
          ON context_graph_memberships(status);
      `);
    }

    if (version < 9) {
      const columns = this.db.prepare('PRAGMA table_info(context_graph_subscriptions)').all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'shared_memory_synced')) {
        this.db.exec(`
          ALTER TABLE context_graph_subscriptions
            ADD COLUMN shared_memory_synced INTEGER;
        `);
      }
    }

    if (version < 10) {
      // The V1 CREATE statement above already lists the relay_* columns,
      // which covers fresh installs. For nodes upgrading from a pre-V10
      // schema the table already exists, so `CREATE TABLE IF NOT EXISTS`
      // is a no-op and the new columns wouldn't be added — `insertSnapshot()`
      // would then fail with `no such column: relay_capacity` on the next
      // metric tick. This block uses the same defensive idempotent
      // PRAGMA-then-ALTER pattern as `version < 9` to add any missing
      // relay_* columns. Not "V9 backward compat" in the data-preservation
      // sense — just making the schema bump safe to apply to whatever
      // table happens to already exist.
      const cols = new Set(
        (this.db.prepare('PRAGMA table_info(metric_snapshots)').all() as Array<{ name: string }>)
          .map((c) => c.name),
      );
      const relayCols = [
        'relay_capacity',
        'relay_reservation_count',
        'relay_active_circuits',
        'relay_bytes_in',
        'relay_bytes_out',
      ];
      for (const col of relayCols) {
        if (!cols.has(col)) {
          this.db.exec(`ALTER TABLE metric_snapshots ADD COLUMN ${col} INTEGER;`);
        }
      }
    }

    if (version < 11) {
      // Chat receiver-side dedup by `messageId` — addresses the seq=13
      // duplicate finding from the May 2026 Miles↔Lex soak postmortem
      // (same encrypted payload arrived twice on the receiver, 1s apart,
      // both stored because the schema had no idempotency key).
      //
      // The V3 CREATE above already declares `message_id` so fresh
      // installs get it. This block uses the same defensive
      // PRAGMA-then-ALTER pattern as V9/V10 to add the column for
      // nodes upgrading through versions 3..10 first, then creates
      // the partial unique index that powers `INSERT OR IGNORE` dedup
      // semantics in `insertChatMessage`.
      //
      // The index is keyed by `(peer, direction, message_id)`:
      //   - Per-direction keying — Codex review of PR #534 flagged
      //     that omitting `direction` lets an outbound row collide
      //     with a legitimate inbound row carrying the same
      //     `messageId` from the same peer. Negligible probability
      //     with v4 UUIDs but real for any future caller that
      //     supplies its own deterministic ids (the MCP layer, an
      //     external bridge, etc.) — and the failure mode would be
      //     a SILENTLY dropped inbound message, which is exactly the
      //     class this PR is trying to close. Including `direction`
      //     makes inbound + outbound dedup live in independent
      //     namespaces.
      //   - Per-sender keying — two different senders that happen to
      //     pick the same UUID (vanishingly unlikely with v4 UUIDs
      //     but non-zero in theory, and any future migration to a
      //     smaller id space would make it real) must not collide.
      //   - Predicate `WHERE message_id IS NOT NULL` keeps the legacy
      //     null-id rows (pre-V11 messages, plus any future sender
      //     that omits the field) outside the uniqueness constraint
      //     so an old persistent row can't block a new identical-text
      //     resend.
      const chatCols = new Set(
        (this.db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>)
          .map((c) => c.name),
      );
      if (!chatCols.has('message_id')) {
        this.db.exec(`ALTER TABLE chat_messages ADD COLUMN message_id TEXT;`);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_msgid
          ON chat_messages(peer, direction, message_id)
          WHERE message_id IS NOT NULL;
      `);
    }

    if (version < 12) {
      // Universal Messenger substrate (rc.9 plan PR-1).
      //
      // Two new tables back the substrate's `MessageIdempotencyStore`
      // and `ProtocolOutboxStore` ports — protocol-agnostic
      // counterparts to the chat-specific `idx_chat_msgid` (V11) and
      // the in-memory `MessageOutbox` (rc.8). Adding them at V12
      // before any caller migrates onto Messenger (PR-3+) so the
      // tables are present + tested by the time the substrate
      // actually wires them.
      //
      // The substrate's design constraint: adding a new short-message
      // protocol requires no new storage. A single
      // `message_idempotency` row + a single `protocol_outbox` row
      // describes any peer-to-peer short message regardless of the
      // protocol prefix (`/dkg/10.0.1/message`, `/dkg/10.0.1/skill_request`,
      // `/dkg/10.0.1/swm-sender-key`, etc.) — the `protocol` column
      // partitions the namespace.
      //
      // `message_idempotency` design:
      //   - PRIMARY KEY = (peer_id, protocol, message_id, direction).
      //     `direction` separates inbound vs outbound so a sender's
      //     "did I deliver this" cache lives in a distinct namespace
      //     from a receiver's "did I process this" dedup table — the
      //     Codex #534 lesson generalised.
      //   - `response_blob BLOB` holds responses up to
      //     `RESPONSE_CACHE_BYTES` (256 KiB) for idempotent re-delivery.
      //     Larger responses store `response_blob = NULL` with the
      //     actual size in `response_size` (mark-only); duplicate
      //     receives in that case surface `RESPONSE_GONE` to the
      //     sender's caller.
      //   - `ts` is the record-time wall-clock, used by the periodic
      //     prune (24h TTL default).
      //
      // `protocol_outbox` design:
      //   - PRIMARY KEY = (peer_id, protocol, message_id). One in-
      //     flight retry slot per `(peer, protocol, message)` tuple.
      //   - `payload BLOB` stores the envelope-wrapped wire bytes
      //     (i.e. the `ReliableEnvelope` proto output, not the raw
      //     application payload), so retries replay byte-identical
      //     frames without re-encoding.
      //   - `idx_outbox_next_attempt` indexes the periodic-tick query
      //     (`SELECT ... WHERE next_attempt_at <= ?`); the
      //     opportunistic-flush query
      //     (`SELECT ... WHERE peer_id = ?`) uses an implicit scan
      //     on the PK prefix, which is fast enough at expected
      //     queue sizes (~tens of entries per peer).
      //
      // No data migration: pure additive. The chat-specific
      // `idx_chat_msgid` from V11 stays in place — PR-3 will drop
      // it (V13) once chat migrates onto the substrate and
      // `message_id` is enforced via `message_idempotency` instead.
      // V13 will also preserve `chat_messages.message_id` as
      // nullable + unwritten for rollback safety.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS message_idempotency (
          peer_id TEXT NOT NULL,
          protocol TEXT NOT NULL,
          message_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          response_blob BLOB,
          response_size INTEGER NOT NULL DEFAULT 0,
          ts INTEGER NOT NULL,
          PRIMARY KEY (peer_id, protocol, message_id, direction)
        );
        CREATE INDEX IF NOT EXISTS idx_idem_ts ON message_idempotency(ts);

        CREATE TABLE IF NOT EXISTS protocol_outbox (
          peer_id TEXT NOT NULL,
          protocol TEXT NOT NULL,
          message_id TEXT NOT NULL,
          payload BLOB NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          first_failure_at INTEGER NOT NULL,
          last_attempt_at INTEGER NOT NULL,
          next_attempt_at INTEGER NOT NULL,
          last_error TEXT,
          PRIMARY KEY (peer_id, protocol, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_next_attempt
          ON protocol_outbox(next_attempt_at);
      `);
    }

    if (version < 13) {
      // PR-3 chat-substrate cutover: the receiver-side dedup that
      // V11 added via the partial unique index
      // `idx_chat_msgid(peer, direction, message_id)` is now
      // owned by `message_idempotency` (V12) — every inbound chat
      // travels through `Messenger.register` which gates on the
      // idempotency cache before invoking the application handler,
      // so the SQL index is no longer the source of truth.
      //
      // We DROP the index (lets the column hold non-unique values
      // again — important for rolling forward without conflicts on
      // any old non-substrate retries that may still be sitting in
      // pre-cutover daemons) but we KEEP the `chat_messages.message_id`
      // column itself, nullable + unwritten by the new code path.
      // This is the rollback-safety constraint from the rc.9 plan:
      // if PR-3 lands and a hot rollback to rc.8 is needed, the
      // V11 schema is still structurally compatible — only the
      // uniqueness contract changes between V12 and V13, not the
      // shape. Dropping the column entirely would require a full
      // table rebuild on downgrade.
      //
      // No data migration. No new tables. Pure DROP INDEX.
      this.db.exec(`
        DROP INDEX IF EXISTS idx_chat_msgid;
      `);
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
    this.db.exec(`DELETE FROM notifications WHERE ts < ${cutoff}`);
    // Universal Messenger idempotency table. Shorter TTL than the
    // 90-day operator retention: no realistic dedup window extends
    // beyond a day. The protocol_outbox table is intentionally not
    // pruned here; its max-age is store policy and must be applied
    // by SqliteProtocolOutboxStore.dropExpired().
    const messengerCutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.db.exec(`DELETE FROM message_idempotency WHERE ts < ${messengerCutoff}`);
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
        peer_count, direct_peers, relayed_peers, mesh_peers, contextGraph_count,
        total_triples, total_kcs, total_kas, store_bytes,
        confirmed_kcs, tentative_kcs, rpc_latency_ms, rpc_healthy,
        relay_capacity, relay_reservation_count, relay_active_circuits,
        relay_bytes_in, relay_bytes_out
      ) VALUES (
        @ts, @cpu_percent, @mem_used_bytes, @mem_total_bytes,
        @disk_used_bytes, @disk_total_bytes, @heap_used_bytes, @uptime_seconds,
        @peer_count, @direct_peers, @relayed_peers, @mesh_peers, @contextGraph_count,
        @total_triples, @total_kcs, @total_kas, @store_bytes,
        @confirmed_kcs, @tentative_kcs, @rpc_latency_ms, @rpc_healthy,
        @relay_capacity, @relay_reservation_count, @relay_active_circuits,
        @relay_bytes_in, @relay_bytes_out
      )
    `).run(snap);
  }

  getLatestSnapshot(): MetricSnapshotRow | undefined {
    return this.db.prepare(
      'SELECT * FROM metric_snapshots ORDER BY ts DESC LIMIT 1',
    ).get() as MetricSnapshotRow | undefined;
  }

  upsertContextGraphSubscription(record: {
    context_graph_id: string;
    name?: string | null;
    subscribed: number;
    synced: number;
    shared_memory_synced?: number | null;
    meta_synced?: number | null;
    on_chain_id?: string | null;
    sync_scoped: number;
    updated_at: number;
  }): void {
    this.stmt('upsertContextGraphSubscription', `
      INSERT INTO context_graph_subscriptions (
        context_graph_id, name, subscribed, synced, shared_memory_synced, meta_synced,
        on_chain_id, sync_scoped, updated_at
      ) VALUES (
        @context_graph_id, @name, @subscribed, @synced, @shared_memory_synced, @meta_synced,
        @on_chain_id, @sync_scoped, @updated_at
      )
      ON CONFLICT(context_graph_id) DO UPDATE SET
        name = excluded.name,
        subscribed = excluded.subscribed,
        synced = excluded.synced,
        shared_memory_synced = excluded.shared_memory_synced,
        meta_synced = excluded.meta_synced,
        on_chain_id = excluded.on_chain_id,
        sync_scoped = excluded.sync_scoped,
        updated_at = excluded.updated_at
    `).run({
      context_graph_id: record.context_graph_id,
      name: record.name ?? null,
      subscribed: record.subscribed,
      synced: record.synced,
      shared_memory_synced: record.shared_memory_synced ?? null,
      meta_synced: record.meta_synced ?? null,
      on_chain_id: record.on_chain_id ?? null,
      sync_scoped: record.sync_scoped,
      updated_at: record.updated_at,
    });
  }

  listContextGraphSubscriptions(): ContextGraphSubscriptionRow[] {
    return this.db.prepare(
      'SELECT * FROM context_graph_subscriptions ORDER BY context_graph_id ASC',
    ).all() as ContextGraphSubscriptionRow[];
  }

  deleteContextGraphSubscription(contextGraphId: string): void {
    this.stmt('deleteContextGraphSubscription', 'DELETE FROM context_graph_subscriptions WHERE context_graph_id = ?').run(contextGraphId);
  }

  upsertContextGraphMember(record: {
    context_graph_id: string;
    principal_type: ContextGraphMemberPrincipalType;
    principal_id: string;
    role?: string | null;
    status: ContextGraphMemberStatus;
    source?: string | null;
    display_name?: string | null;
    metadata?: string | null;
    first_seen_at?: number | null;
    updated_at: number;
  }): void {
    const firstSeenAt = record.first_seen_at ?? record.updated_at;
    this.stmt('upsertContextGraphMember', `
      INSERT INTO context_graph_memberships (
        context_graph_id, principal_type, principal_id, role, status, source,
        display_name, metadata, first_seen_at, updated_at
      ) VALUES (
        @context_graph_id, @principal_type, @principal_id, @role, @status, @source,
        @display_name, @metadata, @first_seen_at, @updated_at
      )
      ON CONFLICT(context_graph_id, principal_type, principal_id) DO UPDATE SET
        role = excluded.role,
        status = excluded.status,
        source = excluded.source,
        display_name = excluded.display_name,
        metadata = excluded.metadata,
        first_seen_at = context_graph_memberships.first_seen_at,
        updated_at = excluded.updated_at
    `).run({
      context_graph_id: record.context_graph_id,
      principal_type: record.principal_type,
      principal_id: record.principal_id,
      role: record.role ?? null,
      status: record.status,
      source: record.source ?? null,
      display_name: record.display_name ?? null,
      metadata: record.metadata ?? null,
      first_seen_at: firstSeenAt,
      updated_at: record.updated_at,
    });
  }

  listContextGraphMembers(contextGraphId?: string): ContextGraphMemberRow[] {
    if (contextGraphId) {
      return this.db.prepare(`
        SELECT * FROM context_graph_memberships
        WHERE context_graph_id = ?
        ORDER BY principal_type ASC, principal_id ASC
      `).all(contextGraphId) as ContextGraphMemberRow[];
    }
    return this.db.prepare(`
      SELECT * FROM context_graph_memberships
      ORDER BY context_graph_id ASC, principal_type ASC, principal_id ASC
    `).all() as ContextGraphMemberRow[];
  }

  deleteContextGraphMember(
    contextGraphId: string,
    principalType: ContextGraphMemberPrincipalType,
    principalId: string,
  ): void {
    this.stmt(
      'deleteContextGraphMember',
      'DELETE FROM context_graph_memberships WHERE context_graph_id = ? AND principal_type = ? AND principal_id = ?',
    ).run(contextGraphId, principalType, principalId);
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
    contextGraph_id?: string | null;
    details?: string | null;
  }): void {
    this.stmt('insertOp', `
      INSERT INTO operations (operation_id, operation_name, started_at, status, peer_id, contextGraph_id, details)
      VALUES (@operation_id, @operation_name, @started_at, 'in_progress', @peer_id, @contextGraph_id, @details)
    `).run({
      operation_id: op.operation_id,
      operation_name: op.operation_name,
      started_at: op.started_at,
      peer_id: op.peer_id ?? null,
      contextGraph_id: op.contextGraph_id ?? null,
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
      // "Publishes to VM": only publishes that actually spent TRAC
      // on-chain (Verified Memory commits) are counted, so the publish
      // count and the TRAC total are consistent. Free SWM/local/testnet
      // publishes record trac_cost = 0 and are intentionally excluded.
      const row = this.db.prepare(`
        SELECT
          SUM(CASE WHEN trac_cost > 0 THEN 1 ELSE 0 END) as publishCount,
          SUM(CASE WHEN status = 'success' AND trac_cost > 0 THEN 1 ELSE 0 END) as successCount,
          COALESCE(SUM(gas_cost_eth), 0) as totalGasEth,
          COALESCE(SUM(trac_cost), 0) as totalTrac,
          COALESCE(AVG(CASE WHEN trac_cost > 0 THEN gas_cost_eth END), 0) as avgGasEth,
          COALESCE(AVG(CASE WHEN trac_cost > 0 THEN trac_cost END), 0) as avgTrac
        FROM operations
        WHERE operation_name = 'publish' AND trac_cost > 0 AND started_at >= ?
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

  /**
   * Insert a chat message. rc.9 PR-3 moved the V11 receiver-side
   * dedup (the partial unique index `idx_chat_msgid`) out of SQL
   * and into the Universal Messenger substrate
   * (`Messenger.register` → `message_idempotency` table from V12).
   * The substrate intercepts duplicate inbound chats BEFORE they
   * reach this insert, so the table no longer enforces uniqueness
   * — and this method no longer carries an `ON CONFLICT` clause.
   * Returns `true` when a row was inserted (always now, modulo
   * raw SQL constraint failures).
   *
   * The `message_id` COLUMN is preserved as nullable + persisted
   * so HTTP/MCP readers can still surface it. V13 dropped only
   * the INDEX, not the column — rollback to rc.8 finds a
   * structurally-compatible schema.
   *
   * Non-dedup SQL constraint failures (NOT NULL on `peer`, etc.)
   * still throw — pinned by db.test.ts.
   */
  insertChatMessage(msg: {
    ts: number;
    direction: 'in' | 'out';
    peer: string;
    peerName?: string | null;
    text: string;
    delivered?: boolean | null;
    messageId?: string | null;
  }): boolean {
    const info = this.stmt('insertChat', `
      INSERT INTO chat_messages (ts, direction, peer, peer_name, text, delivered, message_id)
      VALUES (@ts, @direction, @peer, @peer_name, @text, @delivered, @message_id)
    `).run({
      ts: msg.ts,
      direction: msg.direction,
      peer: msg.peer,
      peer_name: msg.peerName ?? null,
      text: msg.text,
      delivered: msg.delivered == null ? null : msg.delivered ? 1 : 0,
      message_id: msg.messageId ?? null,
    });
    return info.changes > 0;
  }

  /**
   * Read chat history.
   *
   * Server-side `direction` filters BEFORE the LIMIT applies, which
   * matters for inbox reads — if the filter ran client-side, a burst
   * of outbound replies in the newest N rows would push inbound
   * messages past the cap and they'd never be surfaced.
   *
   * Forward pagination uses a **compound cursor** `(since, sinceId)`
   * to avoid losing rows that share the same millisecond `ts`.
   * Without `sinceId`, the predicate is just `ts > since`, and any
   * second-or-later row that shares the watermark `ts` is permanently
   * skipped (Codex PR #510 round 2 flagged this — chat bursts can
   * easily share `Date.now()` values). The compound cursor uses the
   * `id INTEGER PRIMARY KEY AUTOINCREMENT` from the schema as a stable
   * tiebreaker so pagination is lossless.
   *
   * `order` defaults to `'desc'` for the dashboard "show recent N"
   * view. Inbox/feed readers pass `'asc'` so pagination walks
   * oldest → newest and the cursor advances over rows we have
   * actually returned, never past unseen older ones.
   */
  getChatMessages(opts: {
    peer?: string;
    since?: number;
    /**
     * Secondary cursor — when paired with `since`, the predicate is
     * `(ts > since) OR (ts = since AND id > sinceId)`, which makes
     * pagination lossless across rows that share a millisecond.
     */
    sinceId?: number;
    limit?: number;
    direction?: 'in' | 'out';
    order?: 'asc' | 'desc';
  } = {}): ChatMessageRow[] {
    let sql = 'SELECT * FROM chat_messages WHERE 1=1';
    const params: unknown[] = [];

    if (opts.since) {
      if (typeof opts.sinceId === 'number') {
        sql += ' AND (ts > ? OR (ts = ? AND id > ?))';
        params.push(opts.since, opts.since, opts.sinceId);
      } else {
        sql += ' AND ts > ?';
        params.push(opts.since);
      }
    }
    if (opts.peer) {
      sql += ' AND peer = ?';
      params.push(opts.peer);
    }
    if (opts.direction === 'in' || opts.direction === 'out') {
      sql += ' AND direction = ?';
      params.push(opts.direction);
    }
    // Three sort modes — explicit values are honored literally, the
    // implicit (omitted) default preserves the pre-RFC dashboard
    // history contract.
    //
    //   order === 'asc'  → true ASC: oldest first (forward pagination)
    //   order === 'desc' → true DESC: newest first (inverse history)
    //   omitted          → legacy "newest N then displayed oldest-first":
    //                      SQL picks the newest N rows then `.reverse()`
    //                      flips them to chronological order for UI use.
    //                      Pre-existing callers (PanelRight, openclaw) rely
    //                      on this shape, so omitting `order` is the only
    //                      branch that keeps the post-fetch reverse.
    //
    // Codex PR #510 round 4 flagged that previously `order: 'desc'` was
    // not honored — SQL returned DESC and the unconditional `.reverse()`
    // flipped it back to ASC, so the API contract didn't match the
    // behaviour. The explicit `'desc'` branch now drops the reverse.
    if (opts.order === 'asc') {
      sql += ' ORDER BY ts ASC, id ASC LIMIT ?';
      params.push(opts.limit ?? 200);
      return this.db.prepare(sql).all(...params) as ChatMessageRow[];
    }
    if (opts.order === 'desc') {
      sql += ' ORDER BY ts DESC, id DESC LIMIT ?';
      params.push(opts.limit ?? 200);
      return this.db.prepare(sql).all(...params) as ChatMessageRow[];
    }
    sql += ' ORDER BY ts DESC, id DESC LIMIT ?';
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

// --- Universal Messenger substrate stores (rc.9 plan PR-1) ---

/**
 * SQLite-backed `MessageIdempotencyStore` against the V12
 * `message_idempotency` table in `DashboardDB`. Receiver-side dedup
 * cache + sender-side "did we deliver this" cache, keyed by
 * `(peer, protocol, message_id, direction)`.
 *
 * Constructed against an already-opened `DashboardDB` so all DKG
 * persistence shares a single SQLite file (one WAL, one fsync, one
 * pragma surface). Doesn't open the DB itself — the daemon's
 * `lifecycle.ts` owns DB lifecycle and hands one in here in PR-2.
 *
 * Response caching policy lives in `RESPONSE_CACHE_BYTES` (256 KiB
 * fixed limit, exported from `@origintrail-official/dkg-core`).
 * Responses up to the limit are stored inline in `response_blob`;
 * larger responses store `response_blob = NULL` with the actual
 * size in `response_size` (mark-only). Duplicate receives whose
 * original was mark-only surface as `RESPONSE_GONE` to the sender
 * — see `RESPONSE_GONE_MARKER` for the canonical signal string.
 */
export class SqliteMessageIdempotencyStore implements MessageIdempotencyStore {
  private readonly db: Database.Database;
  private readonly clock: () => number;

  /** @param clock injectable for deterministic tests. Defaults to `Date.now`. */
  constructor(dashboard: DashboardDB, options: { clock?: () => number } = {}) {
    this.db = dashboard.db;
    this.clock = options.clock ?? (() => Date.now());
  }

  check(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
  ): IdempotencyCheckResult {
    const row = this.db
      .prepare(
        `SELECT response_blob FROM message_idempotency
         WHERE peer_id = ? AND protocol = ? AND message_id = ? AND direction = ?`,
      )
      .get(peer, protocol, messageId, direction) as
      | { response_blob: Buffer | null }
      | undefined;
    if (!row) return { seen: false };
    // better-sqlite3 returns Node Buffer for BLOB columns; copy into a
    // Uint8Array so callers cannot mutate the cached DB snapshot.
    if (row.response_blob === null) return { seen: true };
    return {
      seen: true,
      cachedResponse: new Uint8Array(row.response_blob),
    };
  }

  record(
    peer: string,
    protocol: string,
    messageId: string,
    direction: MessageDirection,
    response?: Uint8Array,
  ): void {
    const responseSize = response?.length ?? 0;
    // Mark-only when over the cache limit. Stores NULL blob + the
    // actual size, so a future duplicate receive can surface
    // `RESPONSE_GONE`. The 256 KiB cutoff is the rc.9 plan's locked
    // design decision — no per-protocol/per-call knob.
    const blob =
      response !== undefined && response.length <= RESPONSE_CACHE_BYTES
        ? Buffer.from(response)
        : null;
    // Targeted ON CONFLICT — never the broader INSERT OR IGNORE which
    // would silently swallow unrelated constraint violations (the
    // Codex #534 lesson). Idempotent re-record on the same key is a
    // no-op; any other constraint violation surfaces as a thrown
    // SqliteError so the substrate's bug doesn't disguise itself as
    // a normal duplicate.
    this.db
      .prepare(
        `INSERT INTO message_idempotency
           (peer_id, protocol, message_id, direction, response_blob, response_size, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (peer_id, protocol, message_id, direction) DO NOTHING`,
      )
      .run(peer, protocol, messageId, direction, blob, responseSize, this.clock());
  }

  pruneOlderThan(tsMs: number): number {
    const result = this.db
      .prepare(`DELETE FROM message_idempotency WHERE ts < ?`)
      .run(tsMs);
    return result.changes;
  }
}

/**
 * SQLite-backed `ProtocolOutboxStore` against the V12
 * `protocol_outbox` table. Sender-side durable retry queue, keyed
 * by `(peer, protocol, message_id)`. The substrate's reliability
 * floor: a daemon crash mid-retry doesn't lose the message — the
 * next startup's `Messenger.processOutboxTick` picks up exactly
 * where the crash left off (modulo the in-flight bytes that died
 * with the process, which is documented as the "in-flight queue
 * caveat" in CHANGELOG for rc.9).
 *
 * The backoff ladder + max-age are NOT stored in SQL — they live
 * on the wrapping `ProtocolOutbox` in `packages/core`, and only
 * the resulting `next_attempt_at` and `first_failure_at` timestamps
 * land in the table. This keeps the schema independent of policy
 * changes: bumping the ladder doesn't require a migration.
 *
 * Constructor takes a `maxAgeMs` so `dropExpired` can apply it
 * directly in SQL (avoiding a full table read).
 */
export interface SqliteProtocolOutboxStoreOptions {
  /**
   * Max age (ms) from `firstFailureAt` before `dropExpired(now)`
   * evicts an entry. Defaults to 24h. Mirrors the wrapping
   * `ProtocolOutbox`'s `maxAgeMs` so both layers agree.
   */
  maxAgeMs?: number;
  /**
   * Function that returns the backoff (ms) to apply for an entry
   * about to bump to `attempts`. The schema does NOT store the
   * ladder; PR-2's `lifecycle.ts` wiring passes the wrapping
   * `ProtocolOutbox`'s `backoffFor` method here so policy lives in
   * one place. Defaults to a flat 5s backoff so the store works
   * standalone in tests + before the wrapping outbox is wired.
   */
  backoffFor?: (attempts: number) => number;
}

export class SqliteProtocolOutboxStore implements ProtocolOutboxStore {
  private readonly db: Database.Database;
  private maxAgeMs = 24 * 60 * 60 * 1000;
  private backoffFor: (attempts: number) => number = (_attempts) => 5_000;

  constructor(dashboard: DashboardDB, options: SqliteProtocolOutboxStoreOptions = {}) {
    this.db = dashboard.db;
    this.configurePolicy(options);
  }

  configurePolicy(options: SqliteProtocolOutboxStoreOptions = {}): void {
    this.maxAgeMs = options.maxAgeMs ?? this.maxAgeMs;
    this.backoffFor = options.backoffFor ?? this.backoffFor;
  }

  enqueue(
    peer: string,
    protocol: string,
    messageId: string,
    payload: Uint8Array,
    error: string,
    now: number,
  ): ProtocolOutboxEntry {
    const existing = this.db
      .prepare(
        `SELECT * FROM protocol_outbox
         WHERE peer_id = ? AND protocol = ? AND message_id = ?`,
      )
      .get(peer, protocol, messageId) as
      | {
          peer_id: string;
          protocol: string;
          message_id: string;
          payload: Buffer;
          attempts: number;
          first_failure_at: number;
          last_attempt_at: number;
          next_attempt_at: number;
          last_error: string | null;
        }
      | undefined;

    if (existing) {
      const newAttempts = existing.attempts + 1;
      const nextAttemptAt = now + this.backoffFor(newAttempts);
      this.db
        .prepare(
          `UPDATE protocol_outbox
           SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?, last_error = ?
           WHERE peer_id = ? AND protocol = ? AND message_id = ?`,
        )
        .run(newAttempts, now, nextAttemptAt, error, peer, protocol, messageId);
      return {
        peer,
        protocol,
        messageId,
        payload: new Uint8Array(existing.payload),
        attempts: newAttempts,
        firstFailureAt: existing.first_failure_at,
        lastAttemptAt: now,
        nextAttemptAt,
        lastError: error,
      };
    }

    const attempts = 1;
    const nextAttemptAt = now + this.backoffFor(attempts);
    const blob = Buffer.from(payload);
    this.db
      .prepare(
        `INSERT INTO protocol_outbox
           (peer_id, protocol, message_id, payload, attempts,
            first_failure_at, last_attempt_at, next_attempt_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(peer, protocol, messageId, blob, attempts, now, now, nextAttemptAt, error);
    return {
      peer,
      protocol,
      messageId,
      payload: new Uint8Array(blob),
      attempts,
      firstFailureAt: now,
      lastAttemptAt: now,
      nextAttemptAt,
      lastError: error,
    };
  }

  markDelivered(peer: string, protocol: string, messageId: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM protocol_outbox
         WHERE peer_id = ? AND protocol = ? AND message_id = ?`,
      )
      .run(peer, protocol, messageId);
    return result.changes > 0;
  }

  hasEntry(peer: string, protocol: string, messageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM protocol_outbox
         WHERE peer_id = ? AND protocol = ? AND message_id = ? LIMIT 1`,
      )
      .get(peer, protocol, messageId) as { 1: number } | undefined;
    return row !== undefined;
  }

  pendingFor(peer: string): ProtocolOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM protocol_outbox WHERE peer_id = ? ORDER BY first_failure_at ASC`,
      )
      .all(peer) as Array<{
      peer_id: string;
      protocol: string;
      message_id: string;
      payload: Buffer;
      attempts: number;
      first_failure_at: number;
      last_attempt_at: number;
      next_attempt_at: number;
      last_error: string | null;
    }>;
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  due(now: number): ProtocolOutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM protocol_outbox WHERE next_attempt_at <= ?`,
      )
      .all(now) as Array<{
      peer_id: string;
      protocol: string;
      message_id: string;
      payload: Buffer;
      attempts: number;
      first_failure_at: number;
      last_attempt_at: number;
      next_attempt_at: number;
      last_error: string | null;
    }>;
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  dropExpired(now: number): ProtocolOutboxEntry[] {
    const cutoff = now - this.maxAgeMs;
    const rows = this.db
      .prepare(`SELECT * FROM protocol_outbox WHERE first_failure_at < ?`)
      .all(cutoff) as Array<{
      peer_id: string;
      protocol: string;
      message_id: string;
      payload: Buffer;
      attempts: number;
      first_failure_at: number;
      last_attempt_at: number;
      next_attempt_at: number;
      last_error: string | null;
    }>;
    this.db.prepare(`DELETE FROM protocol_outbox WHERE first_failure_at < ?`).run(cutoff);
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  size(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM protocol_outbox`).get() as {
      c: number;
    };
    return row.c;
  }

  list(): ProtocolOutboxEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM protocol_outbox ORDER BY first_failure_at ASC`)
      .all() as Array<{
      peer_id: string;
      protocol: string;
      message_id: string;
      payload: Buffer;
      attempts: number;
      first_failure_at: number;
      last_attempt_at: number;
      next_attempt_at: number;
      last_error: string | null;
    }>;
    return rows.map(SqliteProtocolOutboxStore.rowToEntry);
  }

  getEntry(peer: string, protocol: string, messageId: string): ProtocolOutboxEntry | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM protocol_outbox WHERE peer_id = ? AND protocol = ? AND message_id = ?`,
      )
      .get(peer, protocol, messageId) as
      | {
          peer_id: string;
          protocol: string;
          message_id: string;
          payload: Buffer;
          attempts: number;
          first_failure_at: number;
          last_attempt_at: number;
          next_attempt_at: number;
          last_error: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return SqliteProtocolOutboxStore.rowToEntry(row);
  }

  private static rowToEntry(row: {
    peer_id: string;
    protocol: string;
    message_id: string;
    payload: Buffer;
    attempts: number;
    first_failure_at: number;
    last_attempt_at: number;
    next_attempt_at: number;
    last_error: string | null;
  }): ProtocolOutboxEntry {
    return {
      peer: row.peer_id,
      protocol: row.protocol,
      messageId: row.message_id,
      payload: new Uint8Array(row.payload),
      attempts: row.attempts,
      firstFailureAt: row.first_failure_at,
      lastAttemptAt: row.last_attempt_at,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error ?? '',
    };
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
  contextGraph_count: number | null;
  total_triples: number | null;
  total_kcs: number | null;
  total_kas: number | null;
  store_bytes: number | null;
  confirmed_kcs: number | null;
  tentative_kcs: number | null;
  rpc_latency_ms: number | null;
  rpc_healthy: number | null;
  /**
   * Operator-configured relay reservation cap (DKGNodeConfig.relayServerCapacity).
   * NULL on edge nodes (no relay server enabled).
   */
  relay_capacity: number | null;
  /** Live count of held reservations at snapshot time. NULL off-relay. */
  relay_reservation_count: number | null;
  /**
   * Active forwarded circuits at snapshot time, counted as the number of
   * open relay STOP streams (`/libp2p/circuit/relay/0.2.0/stop`). NOTE:
   * forwarded circuits do not appear as `/p2p-circuit` connections on the
   * relay host — that multiaddr only exists on the edge endpoints. NULL
   * off-relay.
   */
  relay_active_circuits: number | null;
  /**
   * Total bytes received via 'message' events on relay HOP+STOP streams
   * since the relay started (= bytes ARRIVING at the relay's HOP+STOP
   * endpoints from the dialer / reservee). Stored as plain integer
   * (SQLite INTEGER is 8 bytes signed = ~9.2e18, well above any
   * realistic relay byte total before retention pruning). NULL off-relay.
   */
  relay_bytes_in: number | null;
  /**
   * Same as relay_bytes_in but for outbound traffic — bytes sent via
   * `.send()` on relay HOP+STOP streams (= bytes DEPARTING from the
   * relay toward the dialer / reservee). NULL off-relay.
   */
  relay_bytes_out: number | null;
}

export interface OperationRow {
  id: number;
  operation_id: string;
  operation_name: string;
  started_at: number;
  duration_ms: number | null;
  status: string;
  peer_id: string | null;
  contextGraph_id: string | null;
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
  /**
   * Sender-assigned message id (UUID v4 by default; caller-overridable
   * via `dkg-agent.ts`'s `options.messageId`). Nullable for pre-V11
   * rows AND for any future sender that intentionally omits it.
   * As of V13 (rc.9 PR-3), receiver-side dedup is owned by the
   * Universal Messenger substrate (`message_idempotency` table +
   * `Messenger.register` envelope decode), not by this column's
   * SQL index — the index was dropped, the column persists for
   * readers + rollback safety.
   */
  message_id: string | null;
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

export interface ContextGraphSubscriptionRow {
  context_graph_id: string;
  name: string | null;
  subscribed: number;
  synced: number;
  shared_memory_synced: number | null;
  meta_synced: number | null;
  on_chain_id: string | null;
  sync_scoped: number;
  updated_at: number;
}

export type ContextGraphMemberPrincipalType = 'node' | 'agent' | 'identity';
export type ContextGraphMemberStatus = 'active' | 'removed' | 'pending';

export interface ContextGraphMemberRow {
  context_graph_id: string;
  principal_type: ContextGraphMemberPrincipalType;
  principal_id: string;
  role: string | null;
  status: ContextGraphMemberStatus;
  source: string | null;
  display_name: string | null;
  metadata: string | null;
  first_seen_at: number;
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
