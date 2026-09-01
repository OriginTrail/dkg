// SPDX-License-Identifier: Apache-2.0
/**
 * Owned-SQLite bootstrap for the re-verification intent file (#2435).
 *
 * Same header-identity discipline as the finalization inbox — refuse symlinks
 * and foreign owners, refuse a foreign `application_id`/`user_version`, verify
 * the exact schema, run FULL/WAL — but with its OWN identity and its own file,
 * so the two stores can never be mistaken for one another and neither can
 * migrate the other. There is deliberately no migration path here: `v1` is the
 * only version this code has ever written, and a file at any other version is
 * refused rather than upgraded.
 */
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  applyRfc64OwnerOnlyPermissionsSyncV1,
  assertRfc64FilesystemOwnerSyncV1,
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
} from './rfc64/secure-filesystem-policy-v1.js';
import {
  assertOwnedSqliteHeaderIdentityV1,
  fsyncOwnedSqliteFileAndDirectoryV1,
  loadOwnedSqliteModuleV1,
  readOwnedSqlitePragmaIntegerV1,
  secureOwnedSqliteFileSetV1,
  type OwnedSqliteModuleV1,
} from './sqlite/owned-sqlite-v1.js';
import { VM_REVERIFY_INTENTS_DATABASE_FILENAME } from './vm-reverify-intent-store.js';

/** "DKVR" — distinct from the finalization inbox's "DKFI" (0x444b4649). */
const APPLICATION_ID = 0x444b5652;
const USER_VERSION = 1;

const FEATURE = 'VM re-verify intents';

/**
 * STRICT because every column here is either an identity string or a chain
 * integer, and a silently coerced `observed_block` would corrupt the ordering
 * the whole design rests on. The paired CHECK on `state`/`abandon_reason` makes
 * "abandoned without a reason" — the shape that turns a loud dead row into a
 * silent one — unrepresentable.
 */
const DDL_V1 = `
CREATE TABLE vm_reverify_intents_v1 (
  ual TEXT PRIMARY KEY,
  local_cg_id TEXT NOT NULL CHECK (length(local_cg_id) > 0),
  ka_id TEXT NOT NULL CHECK (length(ka_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('lifecycle-update','root-added','roots-replaced','root-removed')),
  observed_block INTEGER NOT NULL CHECK (observed_block >= 0),
  observed_block_hash TEXT NOT NULL CHECK (length(observed_block_hash) > 0),
  observed_tx_hash TEXT NOT NULL CHECK (length(observed_tx_hash) > 0),
  observed_tx_index INTEGER NOT NULL CHECK (observed_tx_index >= 0),
  observed_log_index INTEGER NOT NULL CHECK (observed_log_index >= 0),
  state TEXT NOT NULL CHECK (state IN ('PENDING','ABANDONED')),
  abandon_reason TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempt_at INTEGER,
  next_attempt_at INTEGER,
  last_outcome TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'ABANDONED') = (abandon_reason IS NOT NULL))
) STRICT;
CREATE INDEX vm_reverify_intents_v1_due ON vm_reverify_intents_v1 (state, next_attempt_at, observed_block);
CREATE INDEX vm_reverify_intents_v1_cg ON vm_reverify_intents_v1 (local_cg_id, state);
`;

export interface OpenedVmReverifyIntentDatabase {
  databasePath: string;
  database: DatabaseSync;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();
}

function readPragmaInteger(database: DatabaseSync, pragma: string): number {
  return readOwnedSqlitePragmaIntegerV1(database, pragma, FEATURE);
}

function preparePath(dataDir: string): string {
  const root = resolve(dataDir);
  const path = resolve(root, VM_REVERIFY_INTENTS_DATABASE_FILENAME);
  const relativePath = relative(root, path);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`${FEATURE} path escapes the DKG data directory`);
  }
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: RFC64_SECURE_DIRECTORY_MODE_V1 });
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${FEATURE} data directory must be a real directory`);
  }
  assertRfc64FilesystemOwnerSyncV1(root);
  if (process.platform !== 'win32') {
    applyRfc64OwnerOnlyPermissionsSyncV1(
      root,
      RFC64_SECURE_DIRECTORY_MODE_V1,
      { entryKind: 'directory' },
    );
  }
  secureOwnedSqliteFileSetV1(path, FEATURE);
  return path;
}

function schemaObjects(database: DatabaseSync): Map<string, string> {
  const rows = database.prepare(
    `SELECT name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
     ORDER BY name`,
  ).all();
  return new Map(rows.map((row) => [String(row.name), normalizeSql(String(row.sql))]));
}

function expectedSchema(Database: OwnedSqliteModuleV1['DatabaseSync']): Map<string, string> {
  const memory = new Database(':memory:');
  try {
    memory.exec(DDL_V1);
    return schemaObjects(memory);
  } finally {
    memory.close();
  }
}

function verifySchema(database: DatabaseSync, expected: Map<string, string>): void {
  if (
    readPragmaInteger(database, 'application_id') !== APPLICATION_ID
    || readPragmaInteger(database, 'user_version') !== USER_VERSION
  ) {
    throw new Error(`${FEATURE} has a foreign or unsupported database identity`);
  }
  const actual = schemaObjects(database);
  if (
    actual.size !== expected.size
    || [...expected].some(([name, sql]) => actual.get(name) !== sql)
  ) {
    throw new Error(`${FEATURE} exact schema verification failed`);
  }
  const quickCheck = database.prepare('PRAGMA quick_check').all();
  if (
    quickCheck.length !== 1
    || String(Object.values(quickCheck[0]!)[0]).toLowerCase() !== 'ok'
  ) {
    throw new Error(`${FEATURE} SQLite integrity verification failed`);
  }
}

function applyRuntimePragmas(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_size_limit = 67108864;
  `);
  const mode = database.prepare('PRAGMA journal_mode = WAL').get();
  if (String(mode?.journal_mode).toLowerCase() !== 'wal') {
    throw new Error(`${FEATURE} refused journal_mode=WAL`);
  }
  const expected = new Map([
    ['foreign_keys', 1],
    ['trusted_schema', 0],
    ['synchronous', 2],
    ['busy_timeout', 5000],
  ]);
  for (const [pragma, value] of expected) {
    if (readPragmaInteger(database, pragma) !== value) {
      throw new Error(`${FEATURE} refused PRAGMA ${pragma}=${value}`);
    }
  }
}

function initializeFresh(database: DatabaseSync, path: string): void {
  const mode = database.prepare('PRAGMA journal_mode = DELETE').get();
  database.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000');
  if (String(mode?.journal_mode).toLowerCase() !== 'delete') {
    throw new Error(`${FEATURE} refused durable bootstrap journal mode`);
  }
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (
      readPragmaInteger(database, 'application_id') !== 0
      || readPragmaInteger(database, 'user_version') !== 0
      || schemaObjects(database).size !== 0
    ) {
      throw new Error(`${FEATURE} lost its pristine identity before initialization`);
    }
    database.exec(DDL_V1);
    database.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    database.exec(`PRAGMA user_version = ${USER_VERSION}`);
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

export async function openVmReverifyIntentDatabase(
  dataDir: string,
): Promise<OpenedVmReverifyIntentDatabase> {
  const databasePath = preparePath(dataDir);
  const fresh = !existsSync(databasePath);
  const sqlite = await loadOwnedSqliteModuleV1('Durable VM re-verify intents');
  if (!fresh) {
    assertOwnedSqliteHeaderIdentityV1(databasePath, APPLICATION_ID, USER_VERSION, FEATURE);
  }
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    if (fresh) initializeFresh(database, databasePath);
    if (readPragmaInteger(database, 'user_version') !== USER_VERSION) {
      throw new Error(`${FEATURE} has a foreign or unsupported recovered version`);
    }
    verifySchema(database, expectedSchema(sqlite.DatabaseSync));
    applyRuntimePragmas(database);
    secureOwnedSqliteFileSetV1(databasePath, FEATURE);
    return { databasePath, database };
  } catch (error) {
    try { database.close(); } catch { /* retain open failure */ }
    throw error;
  }
}

export function fsyncVmReverifyIntentDatabase(databasePath: string): void {
  fsyncOwnedSqliteFileAndDirectoryV1(databasePath);
}
