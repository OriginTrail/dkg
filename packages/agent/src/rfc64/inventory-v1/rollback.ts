// SPDX-License-Identifier: Apache-2.0
import { constants as fsConstants, copyFileSync, linkSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { loadOwnedSqliteModuleV1 } from '../../sqlite/module-loader-v1.js';
import { resolveRfc64InventoryDatabasePathV1 } from '../persistence-layout-v1.js';
import {
  acquireInventoryLease,
  assertOwnedRegularFile,
  assertOwnedUnitOwners,
  assertTargetJournalModeCoherence,
  fsyncDirectory,
  fsyncRegularFile,
  isBusySqliteError,
  pathEntryExists,
  prepareSecureDirectory,
  readIdentity,
  readValidSqliteHeaderIdentity,
  recoveryMarkerPath,
  rejectOrphanedSqliteSidecars,
  rejectOwnedFileSymlinks,
  releaseInventoryLease,
  schemaMatches,
  type DatabaseSyncV1,
  type InventoryV1Lease,
  type SqliteModuleV1,
} from './open.js';
import { InventoryV1OpenError } from './open-error.js';
import { INVENTORY_V1_OBJECTS_BY_USER_VERSION, listInventoryV1PreMigrationCopies } from './pre-migration-copy.js';
import { INVENTORY_SCHEMA_DOWNGRADES_V1, type InventorySchemaMigrationV1 } from './schema-migrations.js';
import { INVENTORY_V1_APPLICATION_ID, INVENTORY_V1_USER_VERSION } from './sql.js';

export { INVENTORY_SCHEMA_FIRST_RELEASES_V1 } from './schema-migrations.js';

const SQLITE_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

/** What `prepareRfc64InventoryForRollbackV1` did to the inventory database. */
export type Rfc64InventoryRollbackOutcomeV1 =
  | 'absent'
  | 'compatible'
  | 'downgraded'
  | 'restored';

export type Rfc64InventoryRollbackRefusalReasonV1 =
  | 'in-use'
  | 'pending-rebuild'
  | 'unrecognized-schema'
  | 'unsafe-database';

/** Nothing was changed: the target release cannot be given a database it opens. */
export class Rfc64InventoryRollbackRefusedErrorV1 extends Error {
  constructor(
    readonly reason: Rfc64InventoryRollbackRefusalReasonV1,
    readonly databasePath: string,
    readonly userVersion: number | null,
    readonly maxUserVersion: number,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'Rfc64InventoryRollbackRefusedErrorV1';
  }
}

export interface Rfc64InventoryRollbackPlanV1 {
  readonly action: 'none' | 'downgrade' | 'restore';
  readonly databasePath: string;
  readonly userVersion: number | null;
}

export interface Rfc64InventoryRollbackPreparationV1 {
  readonly outcome: Rfc64InventoryRollbackOutcomeV1;
  readonly databasePath: string;
  readonly fromVersion: number | null;
  readonly toVersion: number | null;
  /** Where a restore kept the database it replaced. */
  readonly keptPath: string | null;
  /** KA UALs of the confirmed catalog placements removed for a target that cannot read them. */
  readonly removedConfirmedCatalogPlacements: readonly string[];
  /** Ends the inventory lease. Call it once the node runs the target version, or on failure. */
  release(): void;
}

export interface Rfc64InventoryRollbackOptionsV1 {
  /**
   * The target reads only version 1 placement repairs (releases before
   * `RFC64_CONFIRMED_CATALOG_PLACEMENT_FIRST_RELEASE_V1`), so the confirmed
   * catalog placements (version 2) are removed, with their failure diagnostics.
   */
  readonly removeConfirmedCatalogPlacements?: boolean;
}

/**
 * The first release that keeps confirmed catalog placements (version 2 rows of
 * `rfc64_finalized_private_placement_repairs_v1`). An earlier release refuses
 * to start on a database holding one, although the schema version is the same.
 */
export const RFC64_CONFIRMED_CATALOG_PLACEMENT_FIRST_RELEASE_V1 = '10.0.27';

function downgradeChain(fromVersion: number, maxUserVersion: number): InventorySchemaMigrationV1[] | null {
  const chain: InventorySchemaMigrationV1[] = [];
  let userVersion = fromVersion;
  while (userVersion > maxUserVersion) {
    const step = INVENTORY_SCHEMA_DOWNGRADES_V1.find((candidate) => candidate.fromVersion === userVersion);
    if (step === undefined) return null;
    chain.push(step);
    userVersion = step.toVersion;
  }
  return chain;
}

/** The oldest schema the down-migrations reach from the current one, keeping every row. */
export const RFC64_INVENTORY_ROLLBACK_FLOOR_USER_VERSION_V1 = (() => {
  let userVersion = INVENTORY_V1_USER_VERSION;
  for (;;) {
    const step = INVENTORY_SCHEMA_DOWNGRADES_V1.find((candidate) => candidate.fromVersion === userVersion);
    if (step === undefined) return userVersion;
    userVersion = step.toVersion;
  }
})();

interface PreMigrationCopyV1 {
  readonly path: string;
  readonly userVersion: number;
}

/** Copies whose name, owner and header fit a target that opens `maxUserVersion`, newest schema first. */
function preMigrationCopyCandidates(databasePath: string, maxUserVersion: number): PreMigrationCopyV1[] {
  return listInventoryV1PreMigrationCopies(databasePath)
    .filter((copy) => copy.fromVersion <= maxUserVersion)
    .sort((left, right) => right.fromVersion - left.fromVersion)
    .flatMap(({ path, fromVersion }) => {
      assertOwnedRegularFile(path, 'inventory pre-migration copy');
      if (SQLITE_SIDECAR_SUFFIXES.some((suffix) => pathEntryExists(`${path}${suffix}`))) return [];
      const header = readValidSqliteHeaderIdentity(path);
      // Copies are rollback-journal databases, which a read-only check leaves as they are.
      return header?.applicationId === INVENTORY_V1_APPLICATION_ID && header.userVersion === fromVersion
        && header.writeVersion === 1 && header.readVersion === 1 ? [{ path, userVersion: fromVersion }] : [];
    });
}

/** The copy passes SQLite's quick check and holds exactly its schema, with intact foreign keys. */
function isRestorableCopy(sqlite: SqliteModuleV1, copy: PreMigrationCopyV1): boolean {
  const expected = INVENTORY_V1_OBJECTS_BY_USER_VERSION.get(copy.userVersion);
  let database: DatabaseSyncV1 | null = null;
  try {
    database = new sqlite.DatabaseSync(copy.path, { readOnly: true });
    const quickCheck = database.prepare('PRAGMA quick_check').all();
    return expected !== undefined
      && quickCheck.length === 1 && Object.values(quickCheck[0]!)[0] === 'ok'
      && schemaMatches(readIdentity(database).userObjects, expected)
      && database.prepare('PRAGMA foreign_key_check').all().length === 0;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function unrecognizedSchema(
  databasePath: string,
  userVersion: number | null,
  maxUserVersion: number,
): Rfc64InventoryRollbackRefusedErrorV1 {
  const schema = userVersion === null ? 'no readable inventory schema' : `schema v${userVersion}`;
  return new Rfc64InventoryRollbackRefusedErrorV1(
    'unrecognized-schema',
    databasePath,
    userVersion,
    maxUserVersion,
    `RFC-64 inventory database ${databasePath} has ${schema}; no exact down-migration and no `
      + `restorable pre-migration copy brings it to schema v${maxUserVersion} or older`,
  );
}

/**
 * Read-only: what the rollback would do, safe while the node runs. Refuses
 * when neither a down-migration nor a pre-migration copy fits the target. The
 * exact schema is checked again by `prepareRfc64InventoryForRollbackV1`.
 */
export function planRfc64InventoryRollbackV1(
  dataDir: string,
  maxUserVersion: number,
): Rfc64InventoryRollbackPlanV1 {
  const databasePath = resolveRfc64InventoryDatabasePathV1(resolve(dataDir));
  let userVersion: number | null = null;
  try {
    if (maxUserVersion <= 0 || !pathEntryExists(databasePath)) {
      return { action: 'none', databasePath, userVersion };
    }
    const header = readValidSqliteHeaderIdentity(databasePath);
    if (header === null || header.applicationId !== INVENTORY_V1_APPLICATION_ID) {
      throw unrecognizedSchema(databasePath, null, maxUserVersion);
    }
    userVersion = header.userVersion;
    if (userVersion <= maxUserVersion) return { action: 'none', databasePath, userVersion };
    if (downgradeChain(userVersion, maxUserVersion) !== null) {
      return { action: 'downgrade', databasePath, userVersion };
    }
    if (preMigrationCopyCandidates(databasePath, maxUserVersion).length !== 0) {
      return { action: 'restore', databasePath, userVersion };
    }
    throw unrecognizedSchema(databasePath, userVersion, maxUserVersion);
  } catch (cause) {
    throw refusalFrom(cause, databasePath, userVersion, maxUserVersion);
  }
}

/**
 * The committed schema version, which can be ahead of the file header while a
 * write-ahead log is pending. Closing this last connection folds the log into
 * the main file, so the header the target release checks first agrees.
 */
function readUserVersionFoldingLog(sqlite: SqliteModuleV1, databasePath: string): number {
  const database: DatabaseSyncV1 = new sqlite.DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 0');
    return readIdentity(database).userVersion;
  } finally {
    database.close();
  }
}

function confirmedPlacementUal(repairJson: string): string | null {
  try {
    const repair = JSON.parse(repairJson) as { version?: unknown; kaUal?: unknown };
    return repair.version === 2 ? String(repair.kaUal) : null;
  } catch {
    return null;
  }
}

/**
 * In the caller's transaction, delete the confirmed catalog placements (version
 * 2 repairs); the KA UALs of the deleted rows. Every other row stays.
 */
function deleteConfirmedCatalogPlacements(database: DatabaseSyncV1): string[] {
  const table = database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'rfc64_finalized_private_placement_repairs_v1'",
  ).get();
  if (table === undefined) return [];
  const rows = database.prepare(
    'SELECT repair_digest, repair_json FROM rfc64_finalized_private_placement_repairs_v1',
  ).all() as Array<{ repair_digest: Uint8Array; repair_json: string }>;
  // Each failure diagnostic goes with its repair (ON DELETE CASCADE).
  const deleteRepair = database.prepare(
    'DELETE FROM rfc64_finalized_private_placement_repairs_v1 WHERE repair_digest = ?',
  );
  return rows.flatMap((row) => {
    const ual = confirmedPlacementUal(row.repair_json);
    if (ual === null) return [];
    deleteRepair.run(row.repair_digest);
    return [ual];
  });
}

/**
 * Give the target a database it reads, in one transaction: remove the confirmed
 * catalog placements when it cannot read them, then lower the schema along
 * `chain`. The KA UALs of the removed placements, or null, changing nothing,
 * when the database is not exactly the schema `chain` starts from.
 */
function changeForTarget(
  sqlite: SqliteModuleV1,
  databasePath: string,
  chain: readonly InventorySchemaMigrationV1[],
  removePlacements: boolean,
): string[] | null {
  const first = chain[0];
  const last = chain.at(-1);
  if (last === undefined && !removePlacements) return [];
  const database: DatabaseSyncV1 = new sqlite.DatabaseSync(databasePath);
  let transactionOpen = false;
  let committed = false;
  let removed: string[] = [];
  try {
    database.exec('PRAGMA busy_timeout = 0');
    if (first !== undefined) {
      const identity = readIdentity(database);
      if (
        identity.applicationId !== INVENTORY_V1_APPLICATION_ID
        || identity.userVersion !== first.fromVersion
        || !schemaMatches(identity.userObjects, first.fromObjects)
        || database.prepare('PRAGMA foreign_key_check').all().length !== 0
      ) return null;
    }
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (removePlacements) removed = deleteConfirmedCatalogPlacements(database);
    for (const step of chain) database.exec(step.sql);
    if (last !== undefined) {
      const lowered = readIdentity(database);
      if (lowered.userVersion !== last.toVersion || !schemaMatches(lowered.userObjects, last.toObjects)) {
        throw new InventoryV1OpenError('database-io', 'the down-migration did not leave the exact older schema');
      }
    }
    database.exec('COMMIT');
    transactionOpen = false;
    committed = true;
  } catch (cause) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* keep the failure that stopped the change */ }
    }
    throw cause;
  } finally {
    if (!committed) database.close();
  }
  const changes = [
    ...(removed.length === 0 ? [] : [`cleared of ${removed.length} confirmed catalog placement(s)`]),
    ...(last === undefined ? [] : [`lowered to schema v${last.toVersion}`]),
  ];
  if (changes.length === 0) {
    database.close();
    return removed;
  }
  finishChange(databasePath, changes.join(' and '), () => {
    // Closing the last connection checkpoints the log into the main file,
    // whose header is what the target release reads first.
    database.close();
    fsyncRegularFile(databasePath, 'inventory database readied for rollback');
    fsyncDirectory(dirname(databasePath));
    const header = readValidSqliteHeaderIdentity(databasePath);
    if (last !== undefined && header?.userVersion !== last.toVersion) throw new Error('its file header was not updated');
  });
  return removed;
}

/** After the database changed, a failure is reported as such, never as a refusal. */
function finishChange(databasePath: string, change: string, finish: () => void): void {
  try {
    finish();
  } catch (cause) {
    throw new Error(
      `RFC-64 inventory database ${databasePath} was ${change}, but finishing that failed: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Replace the database with its pre-migration copy, keeping the replaced file
 * next to it. The caller's last connection folded the write-ahead log into the
 * main file, so no log of the replaced database can be replayed onto the copy.
 */
function restorePreMigrationCopy(
  databasePath: string,
  userVersion: number,
  copy: PreMigrationCopyV1,
): string {
  if (SQLITE_SIDECAR_SUFFIXES.some((suffix) => pathEntryExists(`${databasePath}${suffix}`))) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'the inventory database still has SQLite sidecar files; another process may be using it',
    );
  }
  const directory = dirname(databasePath);
  const keptPath = join(
    directory,
    `${basename(databasePath).replace(/\.sqlite3$/, '')}.schema-v${userVersion}.before-rollback.sqlite3`,
  );
  if (pathEntryExists(keptPath)) unlinkSync(keptPath);
  // Give the database a second name before one rename puts the copy in its
  // place, so the live path holds a whole database even if the process dies.
  try {
    linkSync(databasePath, keptPath);
  } catch {
    // A volume without hard links keeps a full copy instead.
    copyFileSync(databasePath, keptPath, fsConstants.COPYFILE_EXCL);
    fsyncRegularFile(keptPath, 'replaced inventory database');
  }
  fsyncDirectory(directory);
  renameSync(copy.path, databasePath);
  finishChange(databasePath, `replaced by its pre-migration copy, and the replaced one is kept at ${keptPath}`, () => {
    fsyncDirectory(directory);
    const restored = readValidSqliteHeaderIdentity(databasePath);
    if (restored?.userVersion !== copy.userVersion) throw new Error('the restored file does not carry the copy schema');
  });
  return keptPath;
}

function refusalFrom(
  cause: unknown,
  databasePath: string,
  userVersion: number | null,
  maxUserVersion: number,
): unknown {
  if (cause instanceof Rfc64InventoryRollbackRefusedErrorV1) return cause;
  if (
    (cause instanceof InventoryV1OpenError && cause.code === 'database-busy')
    || isBusySqliteError(cause)
  ) {
    return new Rfc64InventoryRollbackRefusedErrorV1(
      'in-use',
      databasePath,
      userVersion,
      maxUserVersion,
      `RFC-64 inventory database ${databasePath} is in use by another process`,
      { cause },
    );
  }
  if (cause instanceof InventoryV1OpenError) {
    return new Rfc64InventoryRollbackRefusedErrorV1(
      'unsafe-database',
      databasePath,
      userVersion,
      maxUserVersion,
      `RFC-64 inventory database ${databasePath} cannot be prepared for rollback: ${cause.message}`,
      { cause },
    );
  }
  return cause;
}

/**
 * With the node stopped, give the target release an inventory database it
 * opens: lower an exact newer schema, keeping every row the target reads, or
 * else restore the pre-migration copy. Refuses, changing nothing, when neither
 * applies. For a target before 10.0.27 it also removes the confirmed catalog
 * placements that target cannot read, in the same transaction as lowering the
 * schema. The inventory lease stays held until `release()`, so a node started
 * before the version switch cannot migrate the database forward again.
 */
export async function prepareRfc64InventoryForRollbackV1(
  dataDir: string,
  maxUserVersion: number,
  options: Rfc64InventoryRollbackOptionsV1 = {},
): Promise<Rfc64InventoryRollbackPreparationV1> {
  const resolvedDataDir = resolve(dataDir);
  const databasePath = resolveRfc64InventoryDatabasePathV1(resolvedDataDir);
  const unleased = (outcome: Rfc64InventoryRollbackOutcomeV1): Rfc64InventoryRollbackPreparationV1 =>
    Object.freeze({
      outcome, databasePath, fromVersion: null, toVersion: null, keptPath: null,
      removedConfirmedCatalogPlacements: [], release: () => {},
    });
  if (maxUserVersion <= 0) return unleased('compatible');
  if (!pathEntryExists(dirname(databasePath))) return unleased('absent');

  let lease: InventoryV1Lease | null = null;
  let userVersion: number | null = null;
  try {
    prepareSecureDirectory(resolvedDataDir, dirname(databasePath));
    const sqlite = await loadOwnedSqliteModuleV1('RFC-64 inventory rollback');
    lease = await acquireInventoryLease(sqlite, databasePath);
    const held = lease;
    const removePlacements = options.removeConfirmedCatalogPlacements === true;
    const prepared = (
      outcome: Rfc64InventoryRollbackOutcomeV1,
      toVersion: number | null,
      removedConfirmedCatalogPlacements: readonly string[] = [],
      keptPath: string | null = null,
    ): Rfc64InventoryRollbackPreparationV1 => {
      let released = false;
      return Object.freeze({
        outcome, databasePath, fromVersion: userVersion, toVersion, keptPath, removedConfirmedCatalogPlacements,
        release: () => {
          if (released) return;
          released = true;
          releaseInventoryLease(held);
        },
      });
    };

    if (pathEntryExists(recoveryMarkerPath(databasePath))) {
      throw new Rfc64InventoryRollbackRefusedErrorV1(
        'pending-rebuild',
        databasePath,
        null,
        maxUserVersion,
        `RFC-64 inventory database ${databasePath} has an interrupted rebuild pending`,
      );
    }
    if (!pathEntryExists(databasePath)) {
      rejectOrphanedSqliteSidecars(databasePath, 'inventory database');
      return prepared('absent', null);
    }
    rejectOwnedFileSymlinks(databasePath);
    assertOwnedUnitOwners(databasePath);
    assertTargetJournalModeCoherence(databasePath);
    const header = readValidSqliteHeaderIdentity(databasePath);
    if (header === null || header.applicationId !== INVENTORY_V1_APPLICATION_ID) {
      throw unrecognizedSchema(databasePath, null, maxUserVersion);
    }
    userVersion = readUserVersionFoldingLog(sqlite, databasePath);
    // Another connection can keep the log from folding into the main file,
    // whose header is what the target release checks first.
    if (readValidSqliteHeaderIdentity(databasePath)?.userVersion !== userVersion) {
      throw new InventoryV1OpenError('database-busy', 'its write-ahead log could not be folded into the database file');
    }
    if (userVersion <= maxUserVersion) {
      return prepared('compatible', userVersion, changeForTarget(sqlite, databasePath, [], removePlacements) ?? []);
    }

    const chain = downgradeChain(userVersion, maxUserVersion);
    const removed = chain === null ? null : changeForTarget(sqlite, databasePath, chain, removePlacements);
    if (chain !== null && removed !== null) {
      return prepared('downgraded', chain[chain.length - 1]!.toVersion, removed);
    }
    const copy = preMigrationCopyCandidates(databasePath, maxUserVersion)
      .find((candidate) => isRestorableCopy(sqlite, candidate));
    if (copy === undefined) throw unrecognizedSchema(databasePath, userVersion, maxUserVersion);
    const keptPath = restorePreMigrationCopy(databasePath, userVersion, copy);
    const removedFromCopy = changeForTarget(sqlite, databasePath, [], removePlacements) ?? [];
    return prepared('restored', copy.userVersion, removedFromCopy, keptPath);
  } catch (cause) {
    if (lease !== null) releaseInventoryLease(lease);
    throw refusalFrom(cause, databasePath, userVersion, maxUserVersion);
  }
}
