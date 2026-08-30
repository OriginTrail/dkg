import Database from 'better-sqlite3';
import type { DashboardDB } from './db.js';

type RegistryScanCursorKey = {
  chainId: string;
  deploymentId: string;
  registryAddress: string;
};
type RoleAwareRegistryScanCursorKey = RegistryScanCursorKey & {
  cursorKind: 'historical' | 'tip';
};

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
 * contiguous prefix. It is keyed by chain/deployment/registry address/cursor role;
 * corrupt values are ignored by returning `undefined`. Historical loads retain
 * fallbacks for role-less runtime rows and the original settings representation.
 */
export class SqliteContextGraphRegistryScanCursorStore {
  private readonly cursors: RuntimePositiveIntegerCursorStore;
  private readonly legacyCursors: SettingsPositiveIntegerCursorStore;

  constructor(dashboard: DashboardDB) {
    this.cursors = new RuntimePositiveIntegerCursorStore(dashboard.db, 'contextGraphRegistryScan.cursor');
    this.legacyCursors = new SettingsPositiveIntegerCursorStore(dashboard.db);
  }

  async load(
    key: RegistryScanCursorKey | RoleAwareRegistryScanCursorKey,
  ): Promise<number | undefined> {
    const cursorKind = this.cursorKind(key);
    const current = this.cursors.load(this.scope(key), this.registryKey(key, cursorKind));
    if (current !== undefined || cursorKind === 'tip') return current;
    return this.cursors.load(this.scope(key), this.legacyRegistryKey(key))
      ?? this.legacyCursors.load(this.legacyKey(key));
  }

  async save(
    key: RegistryScanCursorKey | RoleAwareRegistryScanCursorKey,
    nextBlock: number,
  ): Promise<void> {
    this.cursors.save(this.scope(key), this.registryKey(key, this.cursorKind(key)), nextBlock);
  }

  private scope(key: { chainId: string; deploymentId: string }): string {
    return `${key.chainId}:${key.deploymentId}`;
  }

  private cursorKind(
    key: RegistryScanCursorKey | RoleAwareRegistryScanCursorKey,
  ): 'historical' | 'tip' {
    return 'cursorKind' in key ? key.cursorKind : 'historical';
  }

  private registryKey(
    key: { registryAddress: string },
    cursorKind: 'historical' | 'tip',
  ): string {
    return `${cursorKind}:${key.registryAddress.toLowerCase()}`;
  }

  private legacyRegistryKey(key: { registryAddress: string }): string {
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
