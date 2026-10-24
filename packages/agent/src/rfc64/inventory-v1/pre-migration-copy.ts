// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  statfsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  applyRfc64OwnerOnlyPermissionsSyncV1,
  fsyncRfc64DirectorySyncV1,
  rfc64RegularFileFsyncOpenFlagsV1,
} from '../secure-filesystem-policy-v1.js';
import { InventoryV1OpenError } from './open-error.js';
import { INVENTORY_SCHEMA_MIGRATIONS_V1 } from './schema-migrations.js';
import { INVENTORY_V1_FILE_MODE, INVENTORY_V1_USER_VERSION, normalizeInventoryV1SchemaSql } from './sql.js';

/** Free space a copy must leave on the volume, so keeping it cannot fill the disk. */
export const INVENTORY_V1_PRE_MIGRATION_COPY_RESERVE_BYTES = 64 * 1024 * 1024;

const MIB = 1024 * 1024;

/** The exact objects of each schema version a migration starts from or reaches. */
export const INVENTORY_V1_OBJECTS_BY_USER_VERSION: ReadonlyMap<number, Readonly<Record<string, string>>> = new Map(
  INVENTORY_SCHEMA_MIGRATIONS_V1.flatMap((migration) => [
    [migration.fromVersion, migration.fromObjects] as const,
    [migration.toVersion, migration.toObjects] as const,
  ]),
);

/** The database's objects, outside SQLite's own, are exactly `expected`. */
function hasExactInventoryV1Objects(
  database: DatabaseSync,
  expected: Readonly<Record<string, string>>,
): boolean {
  const objects = database.prepare(
    `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string; sql: string | null }>;
  return objects.length === Object.keys(expected).length && objects.every((object) =>
    object.sql !== null && expected[object.name] === normalizeInventoryV1SchemaSql(object.sql));
}

function databaseStem(databasePath: string): string {
  return basename(databasePath).replace(/\.sqlite3$/, '');
}

function copyNamePattern(databasePath: string, suffix = ''): RegExp {
  const stem = databaseStem(databasePath).replace(/[.]/g, '\\.');
  return new RegExp(`^${stem}\\.schema-v(\\d+)-to-v(\\d+)\\.pre-migration(\\.pending)?\\.sqlite3${suffix}$`);
}

/**
 * The copy of the database as it was at `fromVersion`, before a migration to
 * `toVersion` started. It is pending until that migration completes.
 */
export function inventoryV1PreMigrationCopyPath(
  databasePath: string,
  fromVersion: number,
  toVersion: number,
  pending = false,
): string {
  return join(
    dirname(databasePath),
    `${databaseStem(databasePath)}.schema-v${fromVersion}-to-v${toVersion}.pre-migration${pending ? '.pending' : ''}.sqlite3`,
  );
}

export interface InventoryV1PreMigrationCopy {
  readonly path: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly pending: boolean;
}

/** The copies kept next to the database. */
export function listInventoryV1PreMigrationCopies(databasePath: string): InventoryV1PreMigrationCopy[] {
  const directory = dirname(databasePath);
  const pattern = copyNamePattern(databasePath);
  return readdirSync(directory).flatMap((name) => {
    const match = pattern.exec(name);
    return match === null ? [] : [{
      path: join(directory, name),
      fromVersion: Number(match[1]),
      toVersion: Number(match[2]),
      pending: match[3] !== undefined,
    }];
  });
}

/**
 * Keep one copy of an existing database before its schema migration starts,
 * so `dkg rollback` can give the release that wrote it back a file it opens.
 * `VACUUM INTO` writes a consistent snapshot, write-ahead log included, as a
 * rollback-journal database that can be checked read-only without leaving
 * SQLite files next to it. The copy is written under a temporary name, fsynced
 * and renamed; it replaces the copies earlier migrations kept, one per store.
 */
export function keepInventoryV1PreMigrationCopy(database: DatabaseSync, databasePath: string): void {
  const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  const migration = INVENTORY_SCHEMA_MIGRATIONS_V1.find((candidate) => candidate.fromVersion === userVersion);
  // A database that is not exactly its version's schema is quarantined, not migrated.
  if (migration === undefined || !hasExactInventoryV1Objects(database, migration.fromObjects)) return;
  // A migration that stopped between its steps keeps the copy it took first,
  // of the release that ran before it, rather than one of a middle schema.
  if (listInventoryV1PreMigrationCopies(databasePath).some((copy) =>
    copy.pending && copy.fromVersion < userVersion && copy.toVersion === INVENTORY_V1_USER_VERSION)) return;

  const directory = dirname(databasePath);
  const copyPath = inventoryV1PreMigrationCopyPath(databasePath, userVersion, INVENTORY_V1_USER_VERSION, true);
  const neededBytes = statSync(databasePath).size + INVENTORY_V1_PRE_MIGRATION_COPY_RESERVE_BYTES;
  const volume = statfsSync(directory);
  const freeBytes = volume.bavail * volume.bsize;
  if (freeBytes < neededBytes) {
    throw new InventoryV1OpenError(
      'database-io',
      `not enough free disk space to keep ${basename(copyPath)} before the inventory schema migration: `
        + `${Math.ceil(neededBytes / MIB)} MiB needed, ${Math.floor(freeBytes / MIB)} MiB free; `
        + 'free some space and start the node again',
    );
  }

  const temporaryPath = `${copyPath}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    database.exec(`VACUUM INTO '${temporaryPath.replaceAll("'", "''")}'`);
    applyRfc64OwnerOnlyPermissionsSyncV1(temporaryPath, INVENTORY_V1_FILE_MODE, { entryKind: 'file' });
    const descriptor = openSync(temporaryPath, rfc64RegularFileFsyncOpenFlagsV1());
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporaryPath, copyPath);
  } catch (cause) {
    try { unlinkSync(temporaryPath); } catch { /* keep the copy failure */ }
    throw new InventoryV1OpenError(
      'database-io',
      `failed to keep ${basename(copyPath)} before the inventory schema migration`,
      { cause },
    );
  }
  const earlierCopy = copyNamePattern(databasePath, '(?:\\.tmp-[0-9a-f]{16})?');
  for (const name of readdirSync(directory)) {
    if (name !== basename(copyPath) && earlierCopy.test(name)) unlinkSync(join(directory, name));
  }
  fsyncRfc64DirectorySyncV1(directory);
}

/**
 * The database is at the current schema: a pending copy belongs to a migration
 * that completed, so a later upgrade from an older schema takes a fresh copy.
 */
export function finishInventoryV1PreMigrationCopy(databasePath: string): void {
  const pending = listInventoryV1PreMigrationCopies(databasePath).filter((copy) => copy.pending);
  if (pending.length === 0) return;
  try {
    for (const copy of pending) {
      renameSync(copy.path, inventoryV1PreMigrationCopyPath(databasePath, copy.fromVersion, copy.toVersion));
    }
    fsyncRfc64DirectorySyncV1(dirname(databasePath));
  } catch (cause) {
    throw new InventoryV1OpenError('database-io', 'failed to mark the inventory pre-migration copy finished', { cause });
  }
}
