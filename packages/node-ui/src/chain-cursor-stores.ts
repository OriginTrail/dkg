import Database from 'better-sqlite3';
import type { DashboardDB } from './db.js';

function parsePositiveSafeIntegerSetting(value: string | undefined): number | undefined {
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
    return parsePositiveSafeIntegerSetting(row?.value);
  }

  save(key: string, value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) return;
    this.db.prepare(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ).run(key, String(value));
  }
}

/**
 * SQLite-backed lane cursor store for `ChainEventPoller`.
 *
 * The store is intentionally implemented against the generic settings table:
 * cursor rows are tiny, durable, and should not be pruned. `scope` should
 * include the effective chain/deployment identity so a node-home reused across
 * networks never applies an old lane cursor to a different chain.
 */
export class SqliteChainEventCursorStore {
  private readonly cursors: SettingsPositiveIntegerCursorStore;
  private readonly scope: string;

  constructor(dashboard: DashboardDB, options: { scope?: string } = {}) {
    this.cursors = new SettingsPositiveIntegerCursorStore(dashboard.db);
    this.scope = options.scope ?? 'default';
  }

  async loadLane(lane: string): Promise<number | undefined> {
    return this.cursors.load(this.key(lane));
  }

  async saveLane(lane: string, blockNumber: number): Promise<void> {
    this.cursors.save(this.key(lane), blockNumber);
  }

  private key(lane: string): string {
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
  private readonly cursors: SettingsPositiveIntegerCursorStore;

  constructor(dashboard: DashboardDB) {
    this.cursors = new SettingsPositiveIntegerCursorStore(dashboard.db);
  }

  async load(key: { chainId: string; deploymentId: string; registryAddress: string }): Promise<number | undefined> {
    return this.cursors.load(this.key(key));
  }

  async save(key: { chainId: string; deploymentId: string; registryAddress: string }, nextBlock: number): Promise<void> {
    this.cursors.save(this.key(key), nextBlock);
  }

  private key(key: { chainId: string; deploymentId: string; registryAddress: string }): string {
    return [
      'contextGraphRegistryScan.cursor',
      key.chainId,
      key.deploymentId,
      key.registryAddress.toLowerCase(),
    ].join(':');
  }
}
