import Database from 'better-sqlite3';
import type { DashboardDB } from './db.js';

function parsePositiveSafeInteger(value: number | string | undefined): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

class SettingsPositiveIntegerCursorStore {
  constructor(private readonly db: Database.Database) {}

  load(key: string): number | undefined {
    const row = this.db.prepare(
      `SELECT value FROM settings WHERE key = ?`,
    ).get(key) as { value: string } | undefined;
    return parsePositiveSafeInteger(row?.value);
  }

  save(key: string, value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) return;
    this.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(key, String(value));
  }
}

class RuntimePositiveIntegerCursorStore {
  constructor(
    private readonly db: Database.Database,
    private readonly namespace: string,
  ) {}

  load(scope: string, key: string): number | undefined {
    const row = this.db.prepare(
      `SELECT value FROM runtime_cursors WHERE namespace = ? AND scope = ? AND key = ?`,
    ).get(this.namespace, scope, key) as { value: number } | undefined;
    return parsePositiveSafeInteger(row?.value);
  }

  save(scope: string, key: string, value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) return;
    this.db.prepare(`
      INSERT INTO runtime_cursors (namespace, scope, key, value, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(namespace, scope, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(this.namespace, scope, key, value, Date.now());
  }
}

/**
 * SQLite-backed lane cursor store for `ChainEventPoller`.
 *
 * `scope` should include the effective chain/deployment identity so a node-home
 * reused across networks never applies an old lane cursor to a different chain.
 */
export class SqliteChainEventCursorStore {
  private readonly cursors: RuntimePositiveIntegerCursorStore;
  private readonly legacyCursors: SettingsPositiveIntegerCursorStore;
  private readonly scope: string;

  constructor(dashboard: DashboardDB, options: { scope?: string } = {}) {
    this.cursors = new RuntimePositiveIntegerCursorStore(dashboard.db, 'chainEventPoller.cursor');
    this.legacyCursors = new SettingsPositiveIntegerCursorStore(dashboard.db);
    this.scope = options.scope ?? 'default';
  }

  async loadLane(lane: string): Promise<number | undefined> {
    return this.cursors.load(this.scope, lane) ?? this.legacyCursors.load(this.legacyKey(lane));
  }

  async saveLane(lane: string, blockNumber: number): Promise<void> {
    this.cursors.save(this.scope, lane, blockNumber);
  }

  private legacyKey(lane: string): string {
    return `chainEventPoller.cursor:${this.scope}:${lane}`;
  }
}

/**
 * SQLite-backed ContextGraphNameRegistry scan cursor.
 *
 * The value is the next unbuffered block after a successfully scanned
 * contiguous prefix. It is keyed by chain/deployment/registry address; corrupt
 * values are ignored by returning `undefined`, which fails closed to the
 * historical scan path.
 */
export class SqliteContextGraphRegistryScanCursorStore {
  private readonly cursors: RuntimePositiveIntegerCursorStore;
  private readonly legacyCursors: SettingsPositiveIntegerCursorStore;

  constructor(dashboard: DashboardDB) {
    this.cursors = new RuntimePositiveIntegerCursorStore(dashboard.db, 'contextGraphRegistryScan.cursor');
    this.legacyCursors = new SettingsPositiveIntegerCursorStore(dashboard.db);
  }

  async load(key: { chainId: string; deploymentId: string; registryAddress: string }): Promise<number | undefined> {
    return this.cursors.load(this.scope(key), this.registryKey(key))
      ?? this.legacyCursors.load(this.legacyKey(key));
  }

  async save(key: { chainId: string; deploymentId: string; registryAddress: string }, nextBlock: number): Promise<void> {
    this.cursors.save(this.scope(key), this.registryKey(key), nextBlock);
  }

  private scope(key: { chainId: string; deploymentId: string }): string {
    return `${key.chainId}:${key.deploymentId}`;
  }

  private registryKey(key: { registryAddress: string }): string {
    return key.registryAddress.toLowerCase();
  }

  private legacyKey(key: { chainId: string; deploymentId: string; registryAddress: string }): string {
    return [
      'contextGraphRegistryScan.cursor',
      key.chainId,
      key.deploymentId,
      key.registryAddress.toLowerCase(),
    ].join(':');
  }
}

/**
 * Opaque, SQLite-backed authority-history checkpoints.
 *
 * SQLite makes each replacement atomic. The chain package exclusively owns
 * the versioned codec, integrity check, and authority-state model; this adapter
 * intentionally only persists and returns JSON values.
 */
export class SqliteContextGraphAuthorityHistoryStore {
  static readonly KEY_PREFIX = 'contextGraphAuthorityHistory.checkpoint:v1:';

  private readonly db: Database.Database;

  constructor(dashboard: DashboardDB) {
    this.db = dashboard.db;
  }

  async load(cacheKey: string): Promise<unknown> {
    const row = this.db.prepare(
      `SELECT value FROM settings WHERE key = ?`,
    ).get(this.key(cacheKey)) as { value: string } | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  async save(cacheKey: string, checkpoint: unknown): Promise<void> {
    const value = JSON.stringify(checkpoint);
    this.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(this.key(cacheKey), value);
  }

  async delete(cacheKey: string): Promise<void> {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(this.key(cacheKey));
  }

  private key(cacheKey: string): string {
    return `${SqliteContextGraphAuthorityHistoryStore.KEY_PREFIX}${cacheKey}`;
  }
}

/**
 * Opaque SQLite persistence for the chain-owned contract-wide authority index.
 *
 * Authority-bearing JSON is never interpreted here. The store owns the
 * monotonic CAS token, and JSON `null` is its durable invalidation tombstone.
 * Tokens therefore never repeat, including across corruption/reorg recovery.
 */
export class SqliteContextGraphAuthorityIndexStore {
  private readonly db: Database.Database;

  constructor(dashboard: DashboardDB) {
    this.db = dashboard.db;
  }

  async load(scope: string): Promise<Readonly<{ token: number; value: unknown | null }> | undefined> {
    const row = this.db.prepare(`
      SELECT revision, checkpoint_json
        FROM context_graph_authority_indexes
       WHERE scope = ?
    `).get(scope) as { revision: number; checkpoint_json: string } | undefined;
    if (row === undefined) return undefined;
    try {
      return Object.freeze({
        token: row.revision,
        value: JSON.parse(row.checkpoint_json) as unknown,
      });
    } catch {
      // Preserve the durable token even when the opaque payload is corrupt, so
      // chain can conditionally invalidate this exact row without racing a
      // newer compare-and-swap winner.
      return Object.freeze({
        token: row.revision,
        value: Object.freeze({ invalidCheckpointJson: row.checkpoint_json }),
      });
    }
  }

  async compareAndSwap(
    scope: string,
    expectedToken: number | undefined,
    checkpoint: unknown,
  ): Promise<number | undefined> {
    if (scope.trim().length === 0) throw new Error('Authority index scope is empty');
    const value = JSON.stringify(checkpoint);
    if (value === undefined) throw new Error('Authority index checkpoint is not serializable');
    if (expectedToken === undefined) {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO context_graph_authority_indexes (
          scope, revision, checkpoint_json, updated_at
        ) VALUES (?, ?, ?, ?)
      `).run(scope, 1, value, Date.now()).changes === 1;
      return inserted ? 1 : undefined;
    }
    if (!Number.isSafeInteger(expectedToken) || expectedToken < 1) {
      throw new Error('Authority index expected token is invalid');
    }
    const nextToken = expectedToken + 1;
    if (!Number.isSafeInteger(nextToken)) {
      throw new Error('Authority index token exceeds the safe integer range');
    }
    const updated = this.db.prepare(`
      UPDATE context_graph_authority_indexes
         SET revision = ?, checkpoint_json = ?, updated_at = ?
       WHERE scope = ? AND revision = ?
    `).run(nextToken, value, Date.now(), scope, expectedToken).changes === 1;
    return updated ? nextToken : undefined;
  }

  async invalidate(scope: string, expectedToken: number): Promise<number | undefined> {
    if (!Number.isSafeInteger(expectedToken) || expectedToken < 1) {
      throw new Error('Authority index expected token is invalid');
    }
    const nextToken = expectedToken + 1;
    if (!Number.isSafeInteger(nextToken)) {
      throw new Error('Authority index token exceeds the safe integer range');
    }
    const invalidated = this.db.prepare(`
      UPDATE context_graph_authority_indexes
         SET revision = ?, checkpoint_json = 'null', updated_at = ?
       WHERE scope = ? AND revision = ?
    `).run(nextToken, Date.now(), scope, expectedToken).changes === 1;
    return invalidated ? nextToken : undefined;
  }
}
