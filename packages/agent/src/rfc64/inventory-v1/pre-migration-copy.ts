// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
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

function hasExactObjects(database: DatabaseSync, expected: Readonly<Record<string, string>>): boolean {
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
  return new RegExp(`^${stem}\\.schema-v(\\d+)-to-v(\\d+)\\.pre-migration\\.sqlite3${suffix}$`);
}

/** The copy of the database as it was at `fromVersion`, before a migration to `toVersion` started. */
export function inventoryV1PreMigrationCopyPath(databasePath: string, fromVersion: number, toVersion: number): string {
  return join(
    dirname(databasePath),
    `${databaseStem(databasePath)}.schema-v${fromVersion}-to-v${toVersion}.pre-migration.sqlite3`,
  );
}

export interface InventoryV1PreMigrationCopy {
  readonly path: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/** The copies kept next to the database. */
export function listInventoryV1PreMigrationCopies(databasePath: string): InventoryV1PreMigrationCopy[] {
  const directory = dirname(databasePath);
  const pattern = copyNamePattern(databasePath);
  return readdirSync(directory).flatMap((name) => {
    const match = pattern.exec(name);
    return match === null ? [] : [{ path: join(directory, name), fromVersion: Number(match[1]), toVersion: Number(match[2]) }];
  });
}

/**
 * Keep one copy of an existing database before its schema migration starts,
 * so `dkg rollback` can give the release that wrote it back a file it opens.
 * The caller holds the inventory lease, so the checkpointed main file is the
 * whole database. The copy is written under a temporary name, fsynced and
 * renamed; it replaces the copies earlier migrations kept, one per store.
 */
export function keepInventoryV1PreMigrationCopy(database: DatabaseSync, databasePath: string): void {
  const userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
  const migration = INVENTORY_SCHEMA_MIGRATIONS_V1.find((candidate) => candidate.fromVersion === userVersion);
  // A database that is not exactly its version's schema is quarantined, not migrated.
  if (migration === undefined || !hasExactObjects(database, migration.fromObjects)) return;
  // A migration interrupted between its steps already kept the copy of the
  // release that ran before it; a copy of the intermediate schema would replace it.
  if (listInventoryV1PreMigrationCopies(databasePath).some((copy) =>
    copy.fromVersion < userVersion && copy.toVersion === INVENTORY_V1_USER_VERSION)) return;

  const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (checkpoint?.busy !== 0) {
    throw new InventoryV1OpenError(
      checkpoint?.busy === 1 ? 'database-busy' : 'database-io',
      'RFC-64 inventory could not checkpoint before keeping its pre-migration copy',
    );
  }
  const directory = dirname(databasePath);
  const copyPath = inventoryV1PreMigrationCopyPath(databasePath, userVersion, INVENTORY_V1_USER_VERSION);
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
    copyFileSync(databasePath, temporaryPath, fsConstants.COPYFILE_EXCL);
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
