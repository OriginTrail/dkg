import {
  existsSync,
  lstatSync,
  mkdirSync,
} from 'node:fs';
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
import {
  FINALIZATION_INBOX_DATABASE_FILENAME,
} from './finalization-recovery-store.js';
import {
  finalizationRecoveryRowToEntry,
} from './finalization-recovery-sqlite-codec.js';

const APPLICATION_ID = 0x444b4649; // DKFI
const USER_VERSION = 1;

const DDL = `
CREATE TABLE finalization_inbox_v1 (
  key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('RECEIVED','VERIFIED','REORGED','SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED')
  ),
  chain_id TEXT NOT NULL,
  context_graph_id TEXT NOT NULL,
  source_peer_id TEXT,
  trusted_publisher_peer_id TEXT,
  ual TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  assertion_version TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  ka_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  target_context_graph_id TEXT,
  block_number INTEGER,
  block_hash TEXT,
  tx_index INTEGER,
  publisher_address TEXT,
  author_address TEXT,
  envelope_sha256 TEXT NOT NULL,
  raw_envelope BLOB NOT NULL,
  verified_evidence_json TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    state NOT IN ('VERIFIED','SETTLED')
    OR (
      block_number IS NOT NULL
      AND block_hash IS NOT NULL
      AND tx_index IS NOT NULL
      AND publisher_address IS NOT NULL
      AND verified_evidence_json IS NOT NULL
    )
  ),
  CHECK (
    state != 'REORGED'
    OR (
      block_number IS NULL
      AND block_hash IS NULL
      AND tx_index IS NULL
      AND publisher_address IS NULL
      AND author_address IS NULL
      AND verified_evidence_json IS NULL
    )
  )
) STRICT;
CREATE INDEX finalization_inbox_live_ka_v1
  ON finalization_inbox_v1(chain_id, context_graph_id, ual, ka_id, state, updated_at);
CREATE INDEX finalization_inbox_state_time_v1
  ON finalization_inbox_v1(state, updated_at);
`;

export interface OpenedFinalizationRecoveryDatabase {
  databasePath: string;
  database: DatabaseSync;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().toLowerCase();
}

function readPragmaInteger(database: DatabaseSync, pragma: string): number {
  return readOwnedSqlitePragmaIntegerV1(database, pragma, 'Finalization inbox');
}

function preparePath(dataDir: string): string {
  const root = resolve(dataDir);
  const path = resolve(root, FINALIZATION_INBOX_DATABASE_FILENAME);
  const relativePath = relative(root, path);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error('Finalization inbox path escapes the DKG data directory');
  }
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: RFC64_SECURE_DIRECTORY_MODE_V1 });
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Finalization inbox data directory must be a real directory');
  }
  assertRfc64FilesystemOwnerSyncV1(root);
  if (process.platform !== 'win32') {
    applyRfc64OwnerOnlyPermissionsSyncV1(
      root,
      RFC64_SECURE_DIRECTORY_MODE_V1,
      { entryKind: 'directory' },
    );
  }
  secureOwnedSqliteFileSetV1(path, 'Finalization inbox');
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
    memory.exec(DDL);
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
    throw new Error('Finalization inbox has a foreign or unsupported database identity');
  }
  const actual = schemaObjects(database);
  if (
    actual.size !== expected.size
    || [...expected].some(([name, sql]) => actual.get(name) !== sql)
  ) {
    throw new Error('Finalization inbox exact schema verification failed');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
    throw new Error('Finalization inbox foreign-key verification failed');
  }
  const quickCheck = database.prepare('PRAGMA quick_check').all();
  if (
    quickCheck.length !== 1
    || String(Object.values(quickCheck[0]!)[0]).toLowerCase() !== 'ok'
  ) {
    throw new Error('Finalization inbox SQLite integrity verification failed');
  }
  database.prepare('SELECT * FROM finalization_inbox_v1')
    .all()
    .forEach(finalizationRecoveryRowToEntry);
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
    throw new Error('Finalization inbox refused journal_mode=WAL');
  }
  const expected = new Map([
    ['foreign_keys', 1],
    ['trusted_schema', 0],
    ['synchronous', 2],
    ['busy_timeout', 5000],
  ]);
  for (const [pragma, value] of expected) {
    if (readPragmaInteger(database, pragma) !== value) {
      throw new Error(`Finalization inbox refused PRAGMA ${pragma}=${value}`);
    }
  }
}

function initializeFresh(database: DatabaseSync, path: string): void {
  const mode = database.prepare('PRAGMA journal_mode = DELETE').get();
  database.exec('PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000');
  if (String(mode?.journal_mode).toLowerCase() !== 'delete') {
    throw new Error('Finalization inbox refused durable bootstrap journal mode');
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
      throw new Error('Finalization inbox lost its pristine identity before initialization');
    }
    database.exec(DDL);
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

export async function openFinalizationRecoveryDatabase(
  dataDir: string,
): Promise<OpenedFinalizationRecoveryDatabase> {
  const databasePath = preparePath(dataDir);
  const fresh = !existsSync(databasePath);
  const sqlite = await loadOwnedSqliteModuleV1('Durable finalization recovery');
  if (!fresh) {
    assertOwnedSqliteHeaderIdentityV1(
      databasePath,
      APPLICATION_ID,
      USER_VERSION,
      'Finalization inbox',
    );
  }
  const database = new sqlite.DatabaseSync(databasePath);
  try {
    const expected = expectedSchema(sqlite.DatabaseSync);
    if (fresh) initializeFresh(database, databasePath);
    verifySchema(database, expected);
    applyRuntimePragmas(database);
    secureOwnedSqliteFileSetV1(databasePath, 'Finalization inbox');
    return { databasePath, database };
  } catch (error) {
    try { database.close(); } catch { /* retain open failure */ }
    throw error;
  }
}

export function fsyncFinalizationRecoveryDatabase(databasePath: string): void {
  fsyncOwnedSqliteFileAndDirectoryV1(databasePath);
}
