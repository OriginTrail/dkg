// SPDX-License-Identifier: Apache-2.0
/**
 * The CANONICAL owned-SQLite bootstrap (review r2).
 *
 * Every durable store the agent owns exclusively — the finalization inbox,
 * the VM re-verification intents — runs the same sensitive lifecycle: secure
 * path preparation under the DKG data directory, header-identity refusal of
 * foreign files, DELETE/FULL bootstrap of a fresh database, exact-schema
 * verification against an in-memory build of the DDL, WAL/FULL runtime
 * pragmas, and quick-check integrity. Two hand-synchronized copies of that
 * policy is exactly the drift this module exists to end: a store contributes
 * a DESCRIPTOR — identity, DDL, optional domain validation, optional legacy
 * migration — and consumes one implementation of everything else.
 *
 * Error messages are parameterized by the descriptor's `feature` label and
 * preserve the exact wording both stores have always produced.
 */
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  applyRfc64OwnerOnlyPermissionsSyncV1,
  assertRfc64FilesystemOwnerSyncV1,
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
} from '../rfc64/secure-filesystem-policy-v1.js';
import {
  assertOwnedSqliteHeaderIdentityV1,
  fsyncOwnedSqliteFileAndDirectoryV1,
  loadOwnedSqliteModuleV1,
  readOwnedSqlitePragmaIntegerV1,
  secureOwnedSqliteFileSetV1,
  type OwnedSqliteModuleV1,
} from './owned-sqlite-v1.js';

export interface OwnedSqliteDatabaseDescriptorV1 {
  /** Human label carried by every error message (e.g. 'Finalization inbox'). */
  feature: string;
  /** Label for the sqlite module loader's own failure message. */
  loadLabel: string;
  filename: string;
  applicationId: number;
  userVersion: number;
  ddl: string;
  /**
   * Domain-specific verification, run after the generic identity, exact-schema
   * and quick-check passes on EVERY open (the finalization inbox sweeps its
   * rows through the codec and checks foreign keys here). Throw to refuse the
   * file.
   */
  verifyDomain?(database: DatabaseSync): void;
  /**
   * Single-step legacy migration. When the recovered `user_version` equals
   * `fromVersion`, the store is first verified against `fromDdl` at that
   * version (domain verification included), then `migrate` runs, then the
   * open re-verifies at the current version. Absent = a strict no-migration
   * policy: any other version is refused, never upgraded.
   */
  legacyMigration?: {
    fromVersion: number;
    fromDdl: string;
    migrate(database: DatabaseSync, databasePath: string): void;
  };
}

export interface OpenedOwnedSqliteDatabaseV1 {
  databasePath: string;
  database: DatabaseSync;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();
}

function schemaObjects(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
     ORDER BY name`,
  ).all();
  return new Map(rows.map((row) => [String(row.name), normalizeSql(String(row.sql))]));
}

function expectedSchema(
  Database: OwnedSqliteModuleV1['DatabaseSync'],
  ddl: string,
): Map<string, string> {
  const memory = new Database(':memory:');
  try {
    memory.exec(ddl);
    return schemaObjects(memory);
  } finally {
    memory.close();
  }
}

function preparePath(dataDir: string, descriptor: OwnedSqliteDatabaseDescriptorV1): string {
  const root = resolve(dataDir);
  const path = resolve(root, descriptor.filename);
  const relativePath = relative(root, path);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`${descriptor.feature} path escapes the DKG data directory`);
  }
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: RFC64_SECURE_DIRECTORY_MODE_V1 });
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${descriptor.feature} data directory must be a real directory`);
  }
  assertRfc64FilesystemOwnerSyncV1(root);
  if (process.platform !== 'win32') {
    applyRfc64OwnerOnlyPermissionsSyncV1(
      root,
      RFC64_SECURE_DIRECTORY_MODE_V1,
      { entryKind: 'directory' },
    );
  }
  secureOwnedSqliteFileSetV1(path, descriptor.feature);
  return path;
}

function verifySchema(
  database: DatabaseSync,
  descriptor: OwnedSqliteDatabaseDescriptorV1,
  expected: Map<string, string>,
  userVersion: number,
): void {
  if (
    readOwnedSqlitePragmaIntegerV1(database, 'application_id', descriptor.feature)
      !== descriptor.applicationId
    || readOwnedSqlitePragmaIntegerV1(database, 'user_version', descriptor.feature)
      !== userVersion
  ) {
    throw new Error(`${descriptor.feature} has a foreign or unsupported database identity`);
  }
  const actual = schemaObjects(database);
  if (
    actual.size !== expected.size
    || [...expected].some(([name, sql]) => actual.get(name) !== sql)
  ) {
    throw new Error(`${descriptor.feature} exact schema verification failed`);
  }
  const quickCheck = database.prepare('PRAGMA quick_check').all();
  if (
    quickCheck.length !== 1
    || String(Object.values(quickCheck[0]!)[0]).toLowerCase() !== 'ok'
  ) {
    throw new Error(`${descriptor.feature} SQLite integrity verification failed`);
  }
  descriptor.verifyDomain?.(database);
}

function applyRuntimePragmas(
  database: DatabaseSync,
  descriptor: OwnedSqliteDatabaseDescriptorV1,
): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_size_limit = 67108864;
  `);
  const mode = database.prepare('PRAGMA journal_mode = WAL').get();
  if (String(mode?.journal_mode).toLowerCase() !== 'wal') {
    throw new Error(`${descriptor.feature} refused journal_mode=WAL`);
  }
  const expected = new Map([
    ['foreign_keys', 1],
    ['trusted_schema', 0],
    ['synchronous', 2],
    ['busy_timeout', 5000],
  ]);
  for (const [pragma, value] of expected) {
    if (readOwnedSqlitePragmaIntegerV1(database, pragma, descriptor.feature) !== value) {
      throw new Error(`${descriptor.feature} refused PRAGMA ${pragma}=${value}`);
    }
  }
}

function initializeFresh(
  database: DatabaseSync,
  path: string,
  descriptor: OwnedSqliteDatabaseDescriptorV1,
): void {
  const mode = database.prepare('PRAGMA journal_mode = DELETE').get();
  database.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000');
  if (String(mode?.journal_mode).toLowerCase() !== 'delete') {
    throw new Error(`${descriptor.feature} refused durable bootstrap journal mode`);
  }
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (
      readOwnedSqlitePragmaIntegerV1(database, 'application_id', descriptor.feature) !== 0
      || readOwnedSqlitePragmaIntegerV1(database, 'user_version', descriptor.feature) !== 0
      || schemaObjects(database).size !== 0
    ) {
      throw new Error(`${descriptor.feature} lost its pristine identity before initialization`);
    }
    database.exec(descriptor.ddl);
    database.exec(`PRAGMA application_id = ${descriptor.applicationId}`);
    database.exec(`PRAGMA user_version = ${descriptor.userVersion}`);
    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain initialization failure */ }
    }
    throw error;
  }
  applyRfc64OwnerOnlyPermissionsSyncV1(
    path,
    RFC64_SECURE_FILE_MODE_V1,
    { entryKind: 'file' },
  );
  fsyncOwnedSqliteFileAndDirectoryV1(path);
}

export async function openOwnedSqliteDatabaseV1(
  dataDir: string,
  descriptor: OwnedSqliteDatabaseDescriptorV1,
): Promise<OpenedOwnedSqliteDatabaseV1> {
  const databasePath = preparePath(dataDir, descriptor);
  const fresh = !existsSync(databasePath);
  const sqlite = await loadOwnedSqliteModuleV1(descriptor.loadLabel);
  if (!fresh) {
    if (descriptor.legacyMigration) {
      try {
        assertOwnedSqliteHeaderIdentityV1(
          databasePath,
          descriptor.applicationId,
          descriptor.userVersion,
          descriptor.feature,
        );
      } catch {
        // The main-file header can legitimately lag a committed WAL. Accept
        // exactly the owned legacy header here, then classify from SQLite's
        // recovered PRAGMA below after the WAL has been replayed.
        assertOwnedSqliteHeaderIdentityV1(
          databasePath,
          descriptor.applicationId,
          descriptor.legacyMigration.fromVersion,
          descriptor.feature,
        );
      }
    } else {
      assertOwnedSqliteHeaderIdentityV1(
        databasePath,
        descriptor.applicationId,
        descriptor.userVersion,
        descriptor.feature,
      );
    }
  }
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    if (fresh) initializeFresh(database, databasePath, descriptor);
    const recoveredVersion = readOwnedSqlitePragmaIntegerV1(
      database,
      'user_version',
      descriptor.feature,
    );
    if (descriptor.legacyMigration && recoveredVersion === descriptor.legacyMigration.fromVersion) {
      verifySchema(
        database,
        descriptor,
        expectedSchema(sqlite.DatabaseSync, descriptor.legacyMigration.fromDdl),
        descriptor.legacyMigration.fromVersion,
      );
      descriptor.legacyMigration.migrate(database, databasePath);
    } else if (recoveredVersion !== descriptor.userVersion) {
      throw new Error(`${descriptor.feature} has a foreign or unsupported recovered version`);
    }
    verifySchema(
      database,
      descriptor,
      expectedSchema(sqlite.DatabaseSync, descriptor.ddl),
      descriptor.userVersion,
    );
    applyRuntimePragmas(database, descriptor);
    secureOwnedSqliteFileSetV1(databasePath, descriptor.feature);
    return { databasePath, database };
  } catch (error) {
    try { database.close(); } catch { /* retain open failure */ }
    throw error;
  }
}

/**
 * The serialized synchronous-connection discipline both owned stores share:
 * every mutation joins one promise tail, reads settle behind it, multi-
 * statement mutations run inside BEGIN IMMEDIATE, and teardown checkpoints,
 * closes and fsyncs behind the drained tail.
 */
export class OwnedSqliteSerializedConnectionV1 {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: DatabaseSync,
    private readonly databasePath: string,
  ) {}

  /** Await to observe every previously enqueued mutation settled. */
  get settled(): Promise<void> {
    return this.#tail;
  }

  mutate<T>(operation: () => T): Promise<T> {
    const run = this.#tail.catch(() => undefined).then(operation);
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The queued transaction (review r4): joins the tail AND owns
   * BEGIN IMMEDIATE/COMMIT/ROLLBACK in one operation, so transactionality
   * cannot be invoked outside the serialization discipline — the raw
   * mechanics are private. `mutate` remains for operations whose atomicity
   * is a single statement, and for reads that must settle behind the tail.
   */
  mutateTransaction<T>(operation: () => T): Promise<T> {
    return this.mutate(() => this.#runTransaction(operation));
  }

  #runTransaction<T>(operation: () => T): T {
    let open = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      open = true;
      const result = operation();
      this.database.exec('COMMIT');
      open = false;
      return result;
    } catch (error) {
      if (open) {
        try { this.database.exec('ROLLBACK'); } catch { /* retain transaction failure */ }
      }
      throw error;
    }
  }

  /**
   * Drain the tail, then checkpoint (best-effort — compaction is not a
   * durability boundary; FULL commits make the WAL recoverable, and a live
   * prepared statement can make checkpointing return SQLITE_LOCKED, so
   * connection close remains the mandatory boundary) and close. The caller
   * marks its own closed flag and fsyncs — flag-before-fsync ordering is
   * the stores' contract, preserved exactly.
   */
  async drainCheckpointAndClose(): Promise<void> {
    await this.#tail;
    this.database.exec('PRAGMA busy_timeout = 0');
    try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* retain WAL */ }
    this.database.close();
  }
}
