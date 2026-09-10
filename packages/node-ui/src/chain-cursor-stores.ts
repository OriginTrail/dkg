import Database from 'better-sqlite3';
import type { DashboardDB } from './db.js';

interface ContextGraphAuthorityIndexStateRecord {
  readonly contextGraphId: string;
  readonly nameHash: string;
  readonly ownershipEra: number;
  readonly policyVersion: number;
  readonly rosterVersion: number;
  readonly sourceBlockNumber: number;
  readonly sourceBlockHash: string;
}

interface ContextGraphAuthorityIndexCursorRecord {
  readonly deploymentBlockNumber: number;
  readonly throughBlockNumber: number;
  readonly throughBlockHash: string;
  readonly stateCount: number;
}

interface ContextGraphAuthorityIndexCheckpointRecord {
  readonly cursor: ContextGraphAuthorityIndexCursorRecord;
  readonly states: readonly ContextGraphAuthorityIndexStateRecord[];
}

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
 * Atomic durable backing for one contract-wide Context Graph authority index.
 *
 * The cursor and all states changed by a successfully fetched range are
 * committed in one SQLite transaction. Cursor compare-and-swap prevents a
 * delayed provider attempt from overwriting a newer contiguous prefix.
 */
export class SqliteContextGraphAuthorityIndexStore {
  private readonly db: Database.Database;

  constructor(dashboard: DashboardDB) {
    this.db = dashboard.db;
  }

  async load(scope: string): Promise<ContextGraphAuthorityIndexCheckpointRecord | undefined> {
    const cursor = this.db.prepare(`
      SELECT
        deployment_block_number AS deploymentBlockNumber,
        through_block_number AS throughBlockNumber,
        through_block_hash AS throughBlockHash,
        state_count AS stateCount
      FROM context_graph_authority_index_cursors
      WHERE scope = ?
    `).get(scope) as ContextGraphAuthorityIndexCursorRecord | undefined;
    if (cursor === undefined) return undefined;
    const states = this.db.prepare(`
      SELECT
        context_graph_id AS contextGraphId,
        name_hash AS nameHash,
        ownership_era AS ownershipEra,
        policy_version AS policyVersion,
        roster_version AS rosterVersion,
        source_block_number AS sourceBlockNumber,
        source_block_hash AS sourceBlockHash
      FROM context_graph_authority_index_states
      WHERE scope = ?
      ORDER BY length(context_graph_id), context_graph_id
    `).all(scope) as ContextGraphAuthorityIndexStateRecord[];
    return { cursor, states };
  }

  async commitPage(
    scope: string,
    expected: ContextGraphAuthorityIndexCursorRecord | undefined,
    next: ContextGraphAuthorityIndexCursorRecord,
    changedStates: readonly ContextGraphAuthorityIndexStateRecord[],
  ): Promise<boolean> {
    assertAuthorityIndexPage(scope, expected, next, changedStates);
    const readCursor = this.db.prepare(`
      SELECT
        deployment_block_number AS deploymentBlockNumber,
        through_block_number AS throughBlockNumber,
        through_block_hash AS throughBlockHash,
        state_count AS stateCount
      FROM context_graph_authority_index_cursors
      WHERE scope = ?
    `);
    const clearStates = this.db.prepare(
      `DELETE FROM context_graph_authority_index_states WHERE scope = ?`,
    );
    const upsertState = this.db.prepare(`
      INSERT INTO context_graph_authority_index_states (
        scope, context_graph_id, name_hash, ownership_era, policy_version,
        roster_version, source_block_number, source_block_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, context_graph_id) DO UPDATE SET
        name_hash = excluded.name_hash,
        ownership_era = excluded.ownership_era,
        policy_version = excluded.policy_version,
        roster_version = excluded.roster_version,
        source_block_number = excluded.source_block_number,
        source_block_hash = excluded.source_block_hash
    `);
    const countStates = this.db.prepare(`
      SELECT count(*) AS count
      FROM context_graph_authority_index_states
      WHERE scope = ?
    `);
    const writeCursor = this.db.prepare(`
      INSERT INTO context_graph_authority_index_cursors (
        scope, deployment_block_number, through_block_number,
        through_block_hash, state_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        deployment_block_number = excluded.deployment_block_number,
        through_block_number = excluded.through_block_number,
        through_block_hash = excluded.through_block_hash,
        state_count = excluded.state_count,
        updated_at = excluded.updated_at
    `);
    const commit = this.db.transaction((): boolean => {
      const current = readCursor.get(scope) as ContextGraphAuthorityIndexCursorRecord | undefined;
      if (!sameAuthorityIndexCursor(current, expected)) return false;
      if (expected === undefined) clearStates.run(scope);
      for (const state of changedStates) {
        upsertState.run(
          scope,
          state.contextGraphId,
          state.nameHash,
          state.ownershipEra,
          state.policyVersion,
          state.rosterVersion,
          state.sourceBlockNumber,
          state.sourceBlockHash,
        );
      }
      const count = (countStates.get(scope) as { count: number }).count;
      if (count !== next.stateCount) {
        throw new Error(
          `Context Graph authority index state count ${count} does not match cursor ${next.stateCount}`,
        );
      }
      writeCursor.run(
        scope,
        next.deploymentBlockNumber,
        next.throughBlockNumber,
        next.throughBlockHash,
        next.stateCount,
        Date.now(),
      );
      return true;
    });
    return commit();
  }

  async delete(scope: string): Promise<void> {
    const remove = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM context_graph_authority_index_states WHERE scope = ?`,
      ).run(scope);
      this.db.prepare(
        `DELETE FROM context_graph_authority_index_cursors WHERE scope = ?`,
      ).run(scope);
    });
    remove();
  }
}

function sameAuthorityIndexCursor(
  left: ContextGraphAuthorityIndexCursorRecord | undefined,
  right: ContextGraphAuthorityIndexCursorRecord | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.deploymentBlockNumber === right.deploymentBlockNumber
    && left.throughBlockNumber === right.throughBlockNumber
    && left.throughBlockHash.toLowerCase() === right.throughBlockHash.toLowerCase()
    && left.stateCount === right.stateCount;
}

const AUTHORITY_INDEX_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertAuthorityIndexCursor(
  cursor: ContextGraphAuthorityIndexCursorRecord,
  label: string,
): void {
  if (
    !isNonNegativeSafeInteger(cursor.deploymentBlockNumber)
    || !isNonNegativeSafeInteger(cursor.throughBlockNumber)
    || cursor.throughBlockNumber < cursor.deploymentBlockNumber
    || !AUTHORITY_INDEX_HASH_PATTERN.test(cursor.throughBlockHash)
    || !isNonNegativeSafeInteger(cursor.stateCount)
  ) {
    throw new Error(`Invalid Context Graph authority index ${label} cursor`);
  }
}

function assertAuthorityIndexPage(
  scope: string,
  expected: ContextGraphAuthorityIndexCursorRecord | undefined,
  next: ContextGraphAuthorityIndexCursorRecord,
  changedStates: readonly ContextGraphAuthorityIndexStateRecord[],
): void {
  if (!scope.trim()) throw new Error('Context Graph authority index scope must not be empty');
  if (expected !== undefined) assertAuthorityIndexCursor(expected, 'expected');
  assertAuthorityIndexCursor(next, 'next');
  if (
    expected !== undefined
    && (
      next.deploymentBlockNumber !== expected.deploymentBlockNumber
      || next.throughBlockNumber <= expected.throughBlockNumber
    )
  ) {
    throw new Error('Context Graph authority index page must advance within one deployment');
  }
  const ids = new Set<string>();
  for (const state of changedStates) {
    if (
      !/^[1-9][0-9]*$/.test(state.contextGraphId)
      || !AUTHORITY_INDEX_HASH_PATTERN.test(state.nameHash)
      || !isNonNegativeSafeInteger(state.ownershipEra)
      || !isNonNegativeSafeInteger(state.policyVersion)
      || !isNonNegativeSafeInteger(state.rosterVersion)
      || !isNonNegativeSafeInteger(state.sourceBlockNumber)
      || state.sourceBlockNumber < next.deploymentBlockNumber
      || state.sourceBlockNumber > next.throughBlockNumber
      || !AUTHORITY_INDEX_HASH_PATTERN.test(state.sourceBlockHash)
      || ids.has(state.contextGraphId)
    ) {
      throw new Error('Invalid Context Graph authority index changed state');
    }
    ids.add(state.contextGraphId);
  }
}
