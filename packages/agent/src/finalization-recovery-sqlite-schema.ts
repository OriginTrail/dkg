import type { DatabaseSync } from 'node:sqlite';
import {
  fsyncOwnedSqliteFileAndDirectoryV1,
} from './sqlite/owned-sqlite-v1.js';
import {
  openOwnedSqliteDatabaseV1,
  type OwnedSqliteDatabaseDescriptorV1,
} from './sqlite/owned-sqlite-bootstrap-v1.js';
import {
  FINALIZATION_INBOX_DATABASE_FILENAME,
} from './finalization-recovery-store.js';
import {
  finalizationRecoveryRowToEntry,
} from './finalization-recovery-sqlite-codec.js';

const APPLICATION_ID = 0x444b4649; // DKFI
const LEGACY_USER_VERSION = 1;
const USER_VERSION = 2;

const DDL_V1 = `
CREATE TABLE finalization_inbox_v1 (
  key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('RECEIVED','VERIFIED','REORGED','SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED')
  ),
  chain_id TEXT NOT NULL,
  context_graph_id TEXT NOT NULL,
  source_peer_id TEXT,
  trusted_publisher_peer_id TEXT,
  publisher_upgrade_pending INTEGER NOT NULL DEFAULT 0 CHECK (
    publisher_upgrade_pending IN (0, 1)
  ),
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
  ),
  CHECK (
    publisher_upgrade_pending = 0
    OR (
      trusted_publisher_peer_id IS NOT NULL
      AND state IN ('VERIFIED','REORGED','SETTLED')
    )
  )
) STRICT;
CREATE INDEX finalization_inbox_live_ka_v1
  ON finalization_inbox_v1(chain_id, context_graph_id, ual, ka_id, state, updated_at);
CREATE INDEX finalization_inbox_state_time_v1
  ON finalization_inbox_v1(state, updated_at);
`;

const PENDING_DDL_V2 = `
-- This is a bounded admission spool, not a second recovery state machine.
-- Canonical recovery states, verification evidence, attempts, and transitions
-- remain exclusively in finalization_inbox_v1. Keeping the spool separate
-- avoids rebuilding/copying accepted v1 rows merely to widen that table's
-- state CHECK during an upgrade; promotion atomically moves immutable envelope
-- identity into the canonical inbox.
CREATE TABLE finalization_pending_v2 (
  key TEXT PRIMARY KEY NOT NULL,
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
  envelope_sha256 TEXT NOT NULL,
  raw_envelope BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX finalization_pending_time_v2
  ON finalization_pending_v2(created_at, key);
CREATE INDEX finalization_pending_graph_v2
  ON finalization_pending_v2(context_graph_id, created_at);
CREATE INDEX finalization_pending_peer_v2
  ON finalization_pending_v2(source_peer_id, created_at);
`;

const DDL_V2 = `${DDL_V1}\n${PENDING_DDL_V2}`;

export interface OpenedFinalizationRecoveryDatabase {
  databasePath: string;
  database: DatabaseSync;
}

function migrateLegacyV1(database: DatabaseSync, databasePath: string): void {
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    database.exec(PENDING_DDL_V2);
    database.exec(`PRAGMA user_version = ${USER_VERSION}`);
    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { database.exec('ROLLBACK'); } catch { /* retain migration failure */ }
    }
    throw error;
  }
  const journalMode = database.prepare('PRAGMA journal_mode').get();
  if (String(journalMode?.journal_mode).toLowerCase() === 'wal') {
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (Number(checkpoint?.busy ?? 1) !== 0) {
      throw new Error('Finalization inbox v1 migration WAL checkpoint remained busy');
    }
  }
  fsyncOwnedSqliteFileAndDirectoryV1(databasePath);
}

/**
 * The inbox contributes its identity, DDLs, one legacy migration and its
 * domain validation (foreign keys + a full row sweep through the codec) to
 * the CANONICAL owned-SQLite bootstrap (review r2); everything else — the
 * secure path, header identity, bootstrap, exact-schema verification and
 * runtime pragmas — is the one shared implementation.
 */
const FINALIZATION_INBOX_DESCRIPTOR: OwnedSqliteDatabaseDescriptorV1 = {
  feature: 'Finalization inbox',
  loadLabel: 'Durable finalization recovery',
  filename: FINALIZATION_INBOX_DATABASE_FILENAME,
  applicationId: APPLICATION_ID,
  userVersion: USER_VERSION,
  ddl: DDL_V2,
  verifyDomain(database) {
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) {
      throw new Error('Finalization inbox foreign-key verification failed');
    }
    database.prepare('SELECT * FROM finalization_inbox_v1')
      .all()
      .forEach(finalizationRecoveryRowToEntry);
  },
  legacyMigration: {
    fromVersion: LEGACY_USER_VERSION,
    fromDdl: DDL_V1,
    migrate: migrateLegacyV1,
  },
};

export async function openFinalizationRecoveryDatabase(
  dataDir: string,
): Promise<OpenedFinalizationRecoveryDatabase> {
  return openOwnedSqliteDatabaseV1(dataDir, FINALIZATION_INBOX_DESCRIPTOR);
}

export function fsyncFinalizationRecoveryDatabase(databasePath: string): void {
  fsyncOwnedSqliteFileAndDirectoryV1(databasePath);
}
