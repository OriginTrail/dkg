import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_DDL,
  INVENTORY_V1_DIRECTORY_MODE,
  INVENTORY_V1_FILE_MODE,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_OBJECTS,
  INVENTORY_V1_USER_VERSION,
  normalizeInventoryV1SchemaSql,
} from './sql.js';
import {
  CandidateInventoryV1,
  type CandidateBucketDiffTraversalV1,
  type CandidateBucketHeaderV1,
  type CandidateBucketLoadKeyV1,
  type CandidateBucketPageV1,
  type CandidateBucketPutResultV1,
  type CandidateBucketRowsTraversalV1,
  type CandidateSessionV1,
  type CandidateSessionGcBatchResultV1,
  type Rfc64InventoryV1CandidateApi,
  type VerifiedCandidateBucketLoadV1,
} from './candidate.js';
import type { KaIdV1 } from '@origintrail-official/dkg-core';

type SqliteModuleV1 = typeof import('node:sqlite');
type DatabaseSyncV1 = InstanceType<SqliteModuleV1['DatabaseSync']>;

const RECOVERY_MARKER_SUFFIX = '.rebuild-required';
const QUARANTINE_DIRECTORY = 'quarantine';
const OWNED_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;

export type InventoryV1OpenErrorCode =
  | 'sqlite-unavailable'
  | 'foreign-database'
  | 'newer-schema'
  | 'ambiguous-database'
  | 'unsafe-path'
  | 'pragma-mismatch'
  | 'database-busy'
  | 'database-closed'
  | 'database-io';

export class InventoryV1OpenError extends Error {
  constructor(
    readonly code: InventoryV1OpenErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'InventoryV1OpenError';
  }
}

export interface Rfc64InventoryV1Foundation extends Rfc64InventoryV1CandidateApi {
  readonly databasePath: string;
  readonly closed: boolean;
  quarantineAndRebuild(): void;
  close(): void;
}

export async function openInventoryV1(dataDir: string): Promise<Rfc64InventoryV1Foundation> {
  const sqlite = await loadSqliteModule();
  const resolvedDataDir = resolve(dataDir);
  const databasePath = resolve(resolvedDataDir, INVENTORY_V1_RELATIVE_PATH);
  try {
    prepareSecureDirectory(resolvedDataDir, dirname(databasePath));
    finishPendingQuarantine(databasePath);
    const database = openOrRebuildOwnedDatabase(sqlite, databasePath);
    return new InventoryV1Foundation(sqlite, databasePath, database);
  } catch (cause) {
    if (cause instanceof InventoryV1OpenError) throw cause;
    throw new InventoryV1OpenError(
      'database-io',
      'failed to prepare or open the RFC-64 inventory database',
      { cause },
    );
  }
}

class InventoryV1Foundation implements Rfc64InventoryV1Foundation {
  #database: DatabaseSyncV1 | null;
  #candidate: CandidateInventoryV1;

  constructor(
    private readonly sqlite: SqliteModuleV1,
    readonly databasePath: string,
    database: DatabaseSyncV1,
  ) {
    this.#database = database;
    this.#candidate = this.createCandidateInventory(database);
  }

  get closed(): boolean {
    return this.#database === null;
  }

  quarantineAndRebuild(): void {
    const database = this.requireOpen();
    assertDatabaseQuiescent(database);
    this.#candidate.close();
    database.close();
    this.#database = null;
    try {
      beginQuarantine(this.databasePath);
      finishPendingQuarantine(this.databasePath);
      this.#database = openOrRebuildOwnedDatabase(this.sqlite, this.databasePath);
      this.#candidate = this.createCandidateInventory(this.#database);
    } catch (error) {
      throw new InventoryV1OpenError(
        'database-io',
        'failed to quarantine and rebuild the RFC-64 inventory database',
        { cause: error },
      );
    }
  }

  close(): void {
    this.#candidate.close();
    this.#database?.close();
    this.#database = null;
  }

  createCandidateSession(): CandidateSessionV1 {
    this.requireOpen();
    return this.#candidate.createCandidateSession();
  }

  purgeNextStartupStaleCandidateBatch(): CandidateSessionGcBatchResultV1 {
    this.requireOpen();
    return this.#candidate.purgeNextStartupStaleCandidateBatch();
  }

  putVerifiedCandidateBucket(load: VerifiedCandidateBucketLoadV1): CandidateBucketPutResultV1 {
    this.requireOpen();
    return this.#candidate.putVerifiedCandidateBucket(load);
  }

  getCandidateBucket(loadKey: CandidateBucketLoadKeyV1): CandidateBucketHeaderV1 {
    this.requireOpen();
    return this.#candidate.getCandidateBucket(loadKey);
  }

  beginCandidateBucketRows(loadKey: CandidateBucketLoadKeyV1): CandidateBucketRowsTraversalV1 {
    this.requireOpen();
    return this.#candidate.beginCandidateBucketRows(loadKey);
  }

  beginCandidateBucketDiff(
    oldLoadKey: CandidateBucketLoadKeyV1,
    newLoadKey: CandidateBucketLoadKeyV1,
  ): CandidateBucketDiffTraversalV1 {
    this.requireOpen();
    return this.#candidate.beginCandidateBucketDiff(oldLoadKey, newLoadKey);
  }

  pageCandidateBucketRows(
    traversal: CandidateBucketRowsTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    this.requireOpen();
    return this.#candidate.pageCandidateBucketRows(traversal, cursor, limit);
  }

  pageCandidateBucketAddedOrChanged(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    this.requireOpen();
    return this.#candidate.pageCandidateBucketAddedOrChanged(traversal, cursor, limit);
  }

  pageCandidateBucketRemoved(
    traversal: CandidateBucketDiffTraversalV1,
    cursor: KaIdV1 | null | undefined,
    limit: number,
  ): CandidateBucketPageV1 {
    this.requireOpen();
    return this.#candidate.pageCandidateBucketRemoved(traversal, cursor, limit);
  }

  closeCandidateTraversal(
    traversal: CandidateBucketRowsTraversalV1 | CandidateBucketDiffTraversalV1,
  ): void {
    this.requireOpen();
    this.#candidate.closeCandidateTraversal(traversal);
  }

  discardCandidateSessionBatch(
    session: CandidateSessionV1,
  ): CandidateSessionGcBatchResultV1 {
    this.requireOpen();
    return this.#candidate.discardCandidateSessionBatch(session);
  }

  deleteCandidateBucket(loadKey: CandidateBucketLoadKeyV1): void {
    this.requireOpen();
    this.#candidate.deleteCandidateBucket(loadKey);
  }

  private requireOpen(): DatabaseSyncV1 {
    if (this.#database === null) {
      throw new InventoryV1OpenError('database-closed', 'inventory database is closed');
    }
    return this.#database;
  }

  private createCandidateInventory(database: DatabaseSyncV1): CandidateInventoryV1 {
    return new CandidateInventoryV1(
      database,
      (currentDatabase) => {
        if (this.#database !== currentDatabase) {
          throw new InventoryV1OpenError(
            'database-closed',
            'candidate inventory low-level handle no longer owns the live foundation connection',
          );
        }
        try {
          currentDatabase.close();
        } catch (cause) {
          this.#database = null;
          throw new InventoryV1OpenError(
            'database-io',
            'failed to close the over-budget inventory connection before verified reopen',
            { cause },
          );
        }
        this.#database = null;
        try {
          const reopened = reopenVerifiedOwnedDatabase(this.sqlite, this.databasePath);
          this.#database = reopened;
          return reopened;
        } catch (cause) {
          // Never quarantine, rebuild, or manufacture a candidate outcome on the
          // latency/indeterminate-COMMIT path. The live foundation stays closed.
          throw new InventoryV1OpenError(
            'database-io',
            'failed to verify and reopen the existing RFC-64 inventory database',
            { cause },
          );
        }
      },
      undefined,
      (rejectedDatabase) => {
        // Candidate validation happens after the provider returns. Detach the
        // adopted replacement before closing it so `closed` and requireOpen()
        // cannot observe a stale closed DatabaseSync handle.
        if (this.#database === rejectedDatabase) this.#database = null;
        rejectedDatabase.close();
      },
    );
  }
}

function reopenVerifiedOwnedDatabase(
  sqlite: SqliteModuleV1,
  databasePath: string,
): DatabaseSyncV1 {
  rejectOwnedFileSymlinks(databasePath);
  rejectOrphanedSidecars(databasePath);
  if (!existsSync(databasePath)) {
    throw new InventoryV1OpenError(
      'database-io',
      'inventory database disappeared before verified low-level reopen',
    );
  }
  refuseValidForeignSqliteHeader(databasePath);
  assertOwnedUnitOwners(databasePath);

  let database: DatabaseSyncV1 | null = null;
  try {
    database = new sqlite.DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 5000;
    `);
    const identity = readIdentity(database);
    if (identity.applicationId !== INVENTORY_V1_APPLICATION_ID) {
      throw new InventoryV1OpenError(
        identity.applicationId === 0 ? 'ambiguous-database' : 'foreign-database',
        'verified reopen found a non-DK64 inventory database',
      );
    }
    if (identity.userVersion !== INVENTORY_V1_USER_VERSION) {
      throw new InventoryV1OpenError(
        identity.userVersion > INVENTORY_V1_USER_VERSION ? 'newer-schema' : 'ambiguous-database',
        `verified reopen requires exact inventory user_version ${INVENTORY_V1_USER_VERSION}`,
      );
    }
    if (!schemaMatches(identity.userObjects)) {
      throw new InventoryV1OpenError(
        'database-io',
        'verified reopen found an incompatible owned v1 schema',
      );
    }
    applyAndVerifyPragmas(database);
    verifyOwnedSchema(database);
    tightenOwnedFileMode(databasePath);
    return database;
  } catch (cause) {
    try { database?.close(); } catch { /* preserve verified-reopen failure */ }
    if (cause instanceof InventoryV1OpenError) throw cause;
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'inventory database is busy during verified low-level reopen',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'failed to verify the existing inventory database during low-level reopen',
      { cause },
    );
  }
}

async function loadSqliteModule(): Promise<SqliteModuleV1> {
  try {
    const moduleName = 'node:sqlite';
    return await import(moduleName);
  } catch (cause) {
    throw new InventoryV1OpenError(
      'sqlite-unavailable',
      'RFC-64 SQL-1 requires Node runtime support for node:sqlite',
      { cause },
    );
  }
}

function openOrRebuildOwnedDatabase(
  sqlite: SqliteModuleV1,
  databasePath: string,
): DatabaseSyncV1 {
  rejectOwnedFileSymlinks(databasePath);
  rejectOrphanedSidecars(databasePath);
  const existed = existsSync(databasePath);
  if (existed) {
    refuseValidForeignSqliteHeader(databasePath);
    assertOwnedUnitOwners(databasePath);
  }
  if (!existed) createSecureEmptyFile(databasePath);

  let database: DatabaseSyncV1 | null = null;
  try {
    // Keep SQL-1 on the original Node 22.5 node:sqlite surface. Loading
    // extensions is disabled by default; every statement below is fixed SQL,
    // so double-quoted-string compatibility cannot affect parsing.
    database = new sqlite.DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 5000;
    `);
    const identity = readIdentity(database);

    if (isFreshIdentity(identity)) {
      if (identity.userObjects.length !== 0) {
        database.close();
        database = null;
        throw new InventoryV1OpenError(
          'ambiguous-database',
          'application_id=0/user_version=0 database contains user objects and will not be modified',
        );
      }
      tightenOwnedFileMode(databasePath);
      applyAndVerifyPragmas(database);
      initializeFreshDatabase(database);
      verifyOwnedSchema(database);
      tightenOwnedFileMode(databasePath);
      return database;
    }

    if (identity.applicationId !== INVENTORY_V1_APPLICATION_ID) {
      database.close();
      database = null;
      throw new InventoryV1OpenError(
        identity.applicationId === 0 ? 'ambiguous-database' : 'foreign-database',
        'database application_id does not identify RFC-64 SQL-1 and will not be modified',
      );
    }
    if (identity.userVersion < INVENTORY_V1_USER_VERSION) {
      database.close();
      database = null;
      throw new InventoryV1OpenError(
        'ambiguous-database',
        `inventory application_id is DK64 but user_version ${identity.userVersion} is not a committed v1 database`,
      );
    }
    if (identity.userVersion > INVENTORY_V1_USER_VERSION) {
      database.close();
      database = null;
      throw new InventoryV1OpenError(
        'newer-schema',
        `inventory user_version ${identity.userVersion} is newer than supported version 1`,
      );
    }

    tightenOwnedFileMode(databasePath);
    if (identity.userVersion !== INVENTORY_V1_USER_VERSION || !schemaMatches(identity.userObjects)) {
      assertDatabaseQuiescent(database);
      database.close();
      database = null;
      beginQuarantine(databasePath);
      finishPendingQuarantine(databasePath);
      return openOrRebuildOwnedDatabase(sqlite, databasePath);
    }

    applyAndVerifyPragmas(database);
    try {
      verifyOwnedSchema(database);
    } catch (error) {
      if (!(error instanceof OwnedInventoryV1SchemaError)) throw error;
      assertDatabaseQuiescent(database);
      database.close();
      database = null;
      beginQuarantine(databasePath);
      finishPendingQuarantine(databasePath);
      return openOrRebuildOwnedDatabase(sqlite, databasePath);
    }
    tightenOwnedFileMode(databasePath);
    return database;
  } catch (error) {
    const closeProbe = (): void => {
      if (database === null) return;
      try { database.close(); } catch { /* retain the original failure */ }
      database = null;
    };
    if (error instanceof InventoryV1OpenError) {
      closeProbe();
      throw error;
    }
    if (isCorruptSqliteError(error)) {
      let ownership: CorruptDatabaseOwnershipV1;
      try {
        ownership = classifyCorruptDatabaseOwnership(databasePath);
      } catch (cause) {
        closeProbe();
        throw cause;
      }
      if (ownership === 'ambiguous') {
        closeProbe();
        throw new InventoryV1OpenError(
          'ambiguous-database',
          'corrupt database does not have a readable DK64 ownership identity and will not be modified',
          { cause: error },
        );
      }
      if (ownership === 'newer') {
        closeProbe();
        throw new InventoryV1OpenError(
          'newer-schema',
          'corrupt DK64 database has a newer user_version and will not be modified',
          { cause: error },
        );
      }
      if (ownership === 'foreign') {
        closeProbe();
        throw new InventoryV1OpenError(
          'foreign-database',
          'corrupt SQLite database has a foreign application_id and will not be modified',
          { cause: error },
        );
      }
      if (database === null) {
        throw new InventoryV1OpenError(
          'database-io',
          'cannot prove exclusive access to the corrupt DK64 database; it will not be quarantined',
          { cause: error },
        );
      }
      try {
        assertCorruptDatabaseQuiescent(database);
      } catch (cause) {
        closeProbe();
        if (cause instanceof InventoryV1OpenError) throw cause;
        throw new InventoryV1OpenError(
          'database-io',
          'cannot prove exclusive access to the corrupt DK64 database; it will not be quarantined',
          { cause },
        );
      }
      try {
        database.close();
      } catch (cause) {
        database = null;
        throw new InventoryV1OpenError(
          'database-io',
          'failed to close the corrupt DK64 database after proving quiescence; it will not be quarantined',
          { cause },
        );
      }
      database = null;
      beginQuarantine(databasePath);
      finishPendingQuarantine(databasePath);
      return openOrRebuildOwnedDatabase(sqlite, databasePath);
    }
    closeProbe();
    if (isBusySqliteError(error)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'inventory database is busy or locked and will not be quarantined',
        { cause: error },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      existed ? 'failed to open RFC-64 inventory database' : 'failed to initialize RFC-64 inventory database',
      { cause: error },
    );
  }
}

interface DatabaseIdentityV1 {
  applicationId: number;
  userVersion: number;
  userObjects: Array<{ name: string; sql: string | null }>;
}

function readIdentity(database: DatabaseSyncV1): DatabaseIdentityV1 {
  return {
    applicationId: readPragmaInteger(database, 'application_id'),
    userVersion: readPragmaInteger(database, 'user_version'),
    userObjects: database.prepare(
      `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all().map((row) => ({
      name: assertString(row.name, 'sqlite_schema.name'),
      sql: row.sql === null ? null : assertString(row.sql, 'sqlite_schema.sql'),
    })),
  };
}

function isFreshIdentity(identity: DatabaseIdentityV1): boolean {
  return identity.applicationId === 0 && identity.userVersion === 0;
}

function schemaMatches(objects: DatabaseIdentityV1['userObjects']): boolean {
  if (objects.length !== Object.keys(INVENTORY_V1_USER_OBJECTS).length) return false;
  return objects.every((object) => {
    const expected = INVENTORY_V1_USER_OBJECTS[object.name];
    return expected !== undefined
      && object.sql !== null
      && normalizeInventoryV1SchemaSql(object.sql) === expected;
  });
}

function initializeFreshDatabase(database: DatabaseSyncV1): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(INVENTORY_V1_DDL);
    database.exec(`PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${INVENTORY_V1_USER_VERSION}`);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* retain the initialization error */ }
    throw error;
  }
}

class OwnedInventoryV1SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnedInventoryV1SchemaError';
  }
}

function verifyOwnedSchema(database: DatabaseSyncV1): void {
  const identity = readIdentity(database);
  if (
    identity.applicationId !== INVENTORY_V1_APPLICATION_ID
    || identity.userVersion !== INVENTORY_V1_USER_VERSION
    || !schemaMatches(identity.userObjects)
  ) {
    throw new OwnedInventoryV1SchemaError('RFC-64 inventory schema verification failed');
  }
  const foreignKeyRows = database.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyRows.length !== 0) {
    throw new OwnedInventoryV1SchemaError('RFC-64 inventory foreign-key check failed');
  }
}

function assertDatabaseQuiescent(database: DatabaseSyncV1): void {
  let transactionOpen = false;
  try {
    database.exec('PRAGMA busy_timeout = 0');
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const busy = checkpoint?.busy;
    if (typeof busy !== 'number' || busy !== 0) {
      throw new InventoryV1OpenError(
        busy === 1 ? 'database-busy' : 'database-io',
        busy === 1
          ? 'inventory database has active WAL readers and will not be quarantined'
          : 'SQLite returned an invalid WAL checkpoint result',
      );
    }
    database.exec('BEGIN EXCLUSIVE');
    transactionOpen = true;
    database.exec('ROLLBACK');
    transactionOpen = false;
  } catch (cause) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain the quiescence failure */ }
    }
    if (cause instanceof InventoryV1OpenError) throw cause;
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'inventory database is busy and will not be quarantined',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'could not prove exclusive access; inventory database will not be quarantined',
      { cause },
    );
  } finally {
    try { database.exec('PRAGMA busy_timeout = 5000'); } catch { /* best-effort connection restore */ }
  }
}

function assertCorruptDatabaseQuiescent(database: DatabaseSyncV1): void {
  let transactionOpen = false;
  try {
    // Probe the writer lock before corruption-sensitive schema/checkpoint work
    // so a live WAL writer is reported as busy and is never split from the
    // database file during quarantine.
    database.exec('PRAGMA busy_timeout = 0');
    database.exec('BEGIN EXCLUSIVE');
    transactionOpen = true;
    database.exec('ROLLBACK');
    transactionOpen = false;
  } catch (cause) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain the probe failure */ }
    }
    if (isBusySqliteError(cause)) {
      throw new InventoryV1OpenError(
        'database-busy',
        'corrupt inventory database has an active writer and will not be quarantined',
        { cause },
      );
    }
    throw new InventoryV1OpenError(
      'database-io',
      'cannot prove exclusive access to the corrupt inventory database; it will not be quarantined',
      { cause },
    );
  } finally {
    try { database.exec('PRAGMA busy_timeout = 5000'); } catch { /* best-effort connection restore */ }
  }
  assertDatabaseQuiescent(database);
}

function applyAndVerifyPragmas(database: DatabaseSyncV1): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_size_limit = 67108864;
  `);
  const journalMode = database.prepare('PRAGMA journal_mode = WAL').get();
  if (journalMode === undefined || String(journalMode.journal_mode).toLowerCase() !== 'wal') {
    throw new InventoryV1OpenError('pragma-mismatch', 'SQLite refused journal_mode=WAL');
  }
  const expected = new Map<string, number>([
    ['foreign_keys', 1],
    ['trusted_schema', 0],
    ['synchronous', 2],
    ['busy_timeout', 5000],
    ['journal_size_limit', 67_108_864],
  ]);
  for (const [pragma, expectedValue] of expected) {
    if (readPragmaInteger(database, pragma) !== expectedValue) {
      throw new InventoryV1OpenError('pragma-mismatch', `SQLite refused PRAGMA ${pragma}=${expectedValue}`);
    }
  }
}

function readPragmaInteger(database: DatabaseSyncV1, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (row === undefined) throw new InventoryV1OpenError('database-io', `PRAGMA ${pragma} returned no row`);
  const value = Object.values(row)[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new InventoryV1OpenError('database-io', `PRAGMA ${pragma} returned a non-integer value`);
  }
  return value;
}

function prepareSecureDirectory(dataDirectory: string, directoryPath: string): void {
  const relativeDirectory = relative(dataDirectory, directoryPath);
  if (
    relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${sep}`)
    || isAbsolute(relativeDirectory)
  ) {
    throw new InventoryV1OpenError(
      'unsafe-path',
      'inventory database directory must remain within the declared DKG data directory',
    );
  }

  if (pathEntryExists(dataDirectory)) {
    rejectSymlink(dataDirectory, 'DKG data directory');
    assertFilesystemOwner(dataDirectory);
  } else {
    // The declared data-directory boundary may itself be new. Components above
    // that caller-selected boundary are intentionally outside adapter policy.
    mkdirSync(dataDirectory, { recursive: true, mode: INVENTORY_V1_DIRECTORY_MODE });
    rejectSymlink(dataDirectory, 'DKG data directory');
    assertFilesystemOwner(dataDirectory);
  }

  let currentDirectory = dataDirectory;
  for (const component of relativeDirectory.split(sep).filter((value) => value.length !== 0)) {
    // The current parent was owner-checked before this content mutation.
    const nextDirectory = join(currentDirectory, component);
    if (pathEntryExists(nextDirectory)) {
      rejectSymlink(nextDirectory, 'inventory directory path component');
      assertFilesystemOwner(nextDirectory);
    } else {
      mkdirSync(nextDirectory, { mode: INVENTORY_V1_DIRECTORY_MODE });
      rejectSymlink(nextDirectory, 'inventory directory path component');
      assertFilesystemOwner(nextDirectory);
    }
    currentDirectory = nextDirectory;
  }
  applySecurePermissions(directoryPath, INVENTORY_V1_DIRECTORY_MODE, true);
}

function createSecureEmptyFile(databasePath: string): void {
  const descriptor = openSync(databasePath, 'wx', INVENTORY_V1_FILE_MODE);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  applySecurePermissions(databasePath, INVENTORY_V1_FILE_MODE, false);
}

function tightenOwnedFileMode(databasePath: string): void {
  applySecurePermissions(databasePath, INVENTORY_V1_FILE_MODE, false);
}

function assertFilesystemOwner(path: string): void {
  if (process.platform === 'win32') {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$owner = (Get-Acl -LiteralPath $env:DKG_RFC64_ACL_PATH).GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value) { exit 40 }
`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, DKG_RFC64_ACL_PATH: path },
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new InventoryV1OpenError(
        'database-io',
        `inventory path is not owned by the current Windows identity: ${path}`,
        { cause: result.error ?? new Error(result.stderr.trim() || `PowerShell exited ${result.status}`) },
      );
    }
    return;
  }
  try {
    const processUid = process.getuid?.();
    if (processUid !== undefined && statSync(path).uid !== processUid) {
      throw new Error('filesystem entry is not owned by the current process uid');
    }
  } catch (cause) {
    throw new InventoryV1OpenError(
      'database-io',
      `inventory path is not owned by the current process: ${path}`,
      { cause },
    );
  }
}

function assertOwnedUnitOwners(databasePath: string): void {
  for (const suffix of OWNED_FILE_SUFFIXES) {
    const path = `${databasePath}${suffix}`;
    if (pathEntryExists(path)) assertFilesystemOwner(path);
  }
}

function applySecurePermissions(path: string, mode: number, directory: boolean): void {
  // Never let chmod or Set-Acl turn a foreign existing entry into an owned one.
  // Newly created entries are also checked because they must already be owned
  // by this process before their permissions are tightened.
  assertFilesystemOwner(path);
  if (process.platform === 'win32') {
    applyWindowsOwnerOnlyAcl(path, directory);
    return;
  }
  try {
    chmodSync(path, mode);
    const stat = statSync(path);
    const processUid = process.getuid?.();
    if (processUid !== undefined && stat.uid !== processUid) {
      throw new Error(`path owner uid ${stat.uid} does not match process uid ${processUid}`);
    }
    if ((stat.mode & 0o777) !== mode) {
      throw new Error(`path mode ${(stat.mode & 0o777).toString(8)} does not match ${mode.toString(8)}`);
    }
  } catch (cause) {
    throw new InventoryV1OpenError('database-io', `failed to set secure permissions on ${path}`, { cause });
  }
}

function applyWindowsOwnerOnlyAcl(path: string, directory: boolean): void {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:DKG_RFC64_ACL_PATH
$isDirectory = [System.Convert]::ToBoolean($env:DKG_RFC64_ACL_DIRECTORY)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = if ($isDirectory) {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($isDirectory) {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl
$verified = Get-Acl -LiteralPath $target
$rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $verified.AreAccessRulesProtected -or $rules.Count -ne 1) { exit 41 }
if ($rules[0].IdentityReference.Value -ne $sid.Value) { exit 42 }
if ($rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 43 }
if (($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 44 }
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        DKG_RFC64_ACL_PATH: path,
        DKG_RFC64_ACL_DIRECTORY: String(directory),
      },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new InventoryV1OpenError(
      'database-io',
      `failed to establish owner-only Windows ACL on ${path}`,
      { cause: result.error ?? new Error(result.stderr.trim() || `PowerShell exited ${result.status}`) },
    );
  }
}

function rejectOwnedFileSymlinks(databasePath: string): void {
  for (const suffix of OWNED_FILE_SUFFIXES) {
    const path = `${databasePath}${suffix}`;
    if (pathEntryExists(path)) rejectSymlink(path, `inventory database${suffix}`);
  }
}

function rejectOrphanedSidecars(databasePath: string): void {
  if (existsSync(databasePath)) return;
  if (pathEntryExists(`${databasePath}-wal`) || pathEntryExists(`${databasePath}-shm`)) {
    throw new InventoryV1OpenError(
      'ambiguous-database',
      'orphaned inventory sidecars exist without a database and will not be modified',
    );
  }
}

function rejectSymlink(path: string, label: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new InventoryV1OpenError('unsafe-path', `${label} must not be a symbolic link`);
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new InventoryV1OpenError('database-io', `failed to inspect filesystem entry ${path}`, { cause });
  }
}

interface RecoveryMarkerV1 {
  version: 1;
  quarantineDirectory: string;
}

function beginQuarantine(databasePath: string): void {
  const markerPath = recoveryMarkerPath(databasePath);
  if (pathEntryExists(markerPath)) {
    rejectSymlink(markerPath, 'inventory recovery marker');
    return;
  }
  const inventoryDirectory = dirname(databasePath);
  const quarantineRoot = join(inventoryDirectory, QUARANTINE_DIRECTORY);
  if (pathEntryExists(quarantineRoot)) rejectSymlink(quarantineRoot, 'inventory quarantine directory');
  mkdirSync(quarantineRoot, { recursive: true, mode: INVENTORY_V1_DIRECTORY_MODE });
  rejectSymlink(quarantineRoot, 'inventory quarantine directory');
  applySecurePermissions(quarantineRoot, INVENTORY_V1_DIRECTORY_MODE, true);
  fsyncDirectory(inventoryDirectory);
  const suffix = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const quarantineDirectory = join(quarantineRoot, `inventory-v1-${suffix}`);
  mkdirSync(quarantineDirectory, { mode: INVENTORY_V1_DIRECTORY_MODE });
  rejectSymlink(quarantineDirectory, 'inventory quarantine generation');
  applySecurePermissions(quarantineDirectory, INVENTORY_V1_DIRECTORY_MODE, true);
  fsyncDirectory(quarantineRoot);
  const marker: RecoveryMarkerV1 = { version: 1, quarantineDirectory };
  writeFileSync(markerPath, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx', mode: INVENTORY_V1_FILE_MODE });
  applySecurePermissions(markerPath, INVENTORY_V1_FILE_MODE, false);
  const descriptor = openSync(markerPath, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  fsyncDirectory(inventoryDirectory);
}

function finishPendingQuarantine(databasePath: string): void {
  const markerPath = recoveryMarkerPath(databasePath);
  if (!pathEntryExists(markerPath)) return;
  rejectSymlink(markerPath, 'inventory recovery marker');
  assertFilesystemOwner(markerPath);
  const inventoryDirectory = dirname(databasePath);
  const quarantineRoot = join(inventoryDirectory, QUARANTINE_DIRECTORY);
  if (pathEntryExists(quarantineRoot)) {
    rejectSymlink(quarantineRoot, 'inventory quarantine directory');
    assertFilesystemOwner(quarantineRoot);
  }
  const marker = parseRecoveryMarker(readFileSync(markerPath, 'utf8'), inventoryDirectory);
  mkdirSync(marker.quarantineDirectory, { recursive: true, mode: INVENTORY_V1_DIRECTORY_MODE });
  rejectSymlink(quarantineRoot, 'inventory quarantine directory');
  applySecurePermissions(quarantineRoot, INVENTORY_V1_DIRECTORY_MODE, true);
  rejectSymlink(marker.quarantineDirectory, 'inventory quarantine generation');
  assertFilesystemOwner(marker.quarantineDirectory);
  applySecurePermissions(marker.quarantineDirectory, INVENTORY_V1_DIRECTORY_MODE, true);
  // Make both levels of the quarantine destination durable before evidence is
  // moved under the recovery marker.
  fsyncDirectory(inventoryDirectory);
  fsyncDirectory(quarantineRoot);
  for (const suffix of OWNED_FILE_SUFFIXES) {
    const source = `${databasePath}${suffix}`;
    if (!pathEntryExists(source)) continue;
    rejectSymlink(source, `inventory database${suffix}`);
    assertFilesystemOwner(source);
    const target = join(marker.quarantineDirectory, `inventory-v1.sqlite3${suffix}`);
    if (pathEntryExists(target)) {
      throw new InventoryV1OpenError('database-io', `quarantine target already exists: ${target}`);
    }
    renameSync(source, target);
  }
  // Persist destination names and source removals before deleting the marker.
  // A crash before either fsync leaves the durable marker to resume safely.
  fsyncDirectory(marker.quarantineDirectory);
  fsyncDirectory(inventoryDirectory);
  unlinkSync(markerPath);
  fsyncDirectory(inventoryDirectory);
}

function parseRecoveryMarker(value: string, inventoryDirectory: string): RecoveryMarkerV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) {
    throw new InventoryV1OpenError('database-io', 'inventory recovery marker is malformed', { cause });
  }
  if (
    typeof parsed !== 'object'
    || parsed === null
    || (parsed as { version?: unknown }).version !== 1
    || typeof (parsed as { quarantineDirectory?: unknown }).quarantineDirectory !== 'string'
  ) {
    throw new InventoryV1OpenError('database-io', 'inventory recovery marker has an invalid shape');
  }
  const quarantineDirectory = resolve((parsed as RecoveryMarkerV1).quarantineDirectory);
  const quarantineRoot = resolve(inventoryDirectory, QUARANTINE_DIRECTORY);
  const relativePath = relative(quarantineRoot, quarantineDirectory);
  if (
    relativePath.length === 0
    || relativePath.startsWith('..')
    || isAbsolute(relativePath)
    || basename(relativePath) !== relativePath
    || !/^inventory-v1-[0-9]+-[0-9a-f]{16}$/.test(relativePath)
  ) {
    throw new InventoryV1OpenError('unsafe-path', 'inventory recovery marker escapes the quarantine directory');
  }
  return { version: 1, quarantineDirectory };
}

function recoveryMarkerPath(databasePath: string): string {
  return `${databasePath}${RECOVERY_MARKER_SUFFIX}`;
}

function isCorruptSqliteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === 11 || errcode === 26;
}

function isBusySqliteError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { errcode?: unknown }).errcode;
  return errcode === 5 || errcode === 6;
}

type CorruptDatabaseOwnershipV1 = 'owned' | 'ambiguous' | 'foreign' | 'newer';

interface SqliteHeaderIdentityV1 {
  applicationId: number;
  userVersion: number;
}

function classifyCorruptDatabaseOwnership(databasePath: string): CorruptDatabaseOwnershipV1 {
  const identity = readValidSqliteHeaderIdentity(databasePath);
  if (identity === null || identity.applicationId === 0) return 'ambiguous';
  if (identity.applicationId !== INVENTORY_V1_APPLICATION_ID) return 'foreign';
  if (identity.userVersion > INVENTORY_V1_USER_VERSION) return 'newer';
  return identity.userVersion === INVENTORY_V1_USER_VERSION ? 'owned' : 'ambiguous';
}

function refuseValidForeignSqliteHeader(databasePath: string): void {
  const identity = readValidSqliteHeaderIdentity(databasePath);
  if (
    identity !== null
    && identity.applicationId !== 0
    && identity.applicationId !== INVENTORY_V1_APPLICATION_ID
  ) {
    throw new InventoryV1OpenError(
      'foreign-database',
      'database header has a foreign application_id and will not be opened or modified',
    );
  }
}

function readValidSqliteHeaderIdentity(databasePath: string): SqliteHeaderIdentityV1 | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(databasePath, 'r');
    const header = Buffer.alloc(100);
    const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0);
    if (bytesRead < header.byteLength || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\u0000') {
      return null;
    }
    return {
      applicationId: header.readUInt32BE(68),
      userVersion: header.readUInt32BE(60),
    };
  } catch (cause) {
    throw new InventoryV1OpenError(
      'database-io',
      'failed to read the inventory database header; it will not be quarantined',
      { cause },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new InventoryV1OpenError('database-io', `${label} is not text`);
  }
  return value;
}
