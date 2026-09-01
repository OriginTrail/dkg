// SPDX-License-Identifier: Apache-2.0
/**
 * Identity and DDL of the re-verification intent file (#2435) — nothing
 * else. The sensitive lifecycle (secure path, header identity, DELETE/FULL
 * bootstrap, exact-schema verification, WAL/FULL pragmas, quick-check) is
 * the CANONICAL owned-SQLite bootstrap shared with the finalization inbox
 * (review r2); this store contributes its descriptor and a strict
 * no-migration policy: `v1` is the only version this code has ever written,
 * and a file at any other version is refused rather than upgraded.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  fsyncOwnedSqliteFileAndDirectoryV1,
} from './sqlite/owned-sqlite-v1.js';
import {
  openOwnedSqliteDatabaseV1,
  type OwnedSqliteDatabaseDescriptorV1,
} from './sqlite/owned-sqlite-bootstrap-v1.js';
import { VM_REVERIFY_INTENTS_DATABASE_FILENAME } from './vm-reverify-intent-store.js';

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

/** "DKVR" — distinct from the finalization inbox's "DKFI" (0x444b4649). */
const VM_REVERIFY_DESCRIPTOR: OwnedSqliteDatabaseDescriptorV1 = {
  feature: 'VM re-verify intents',
  loadLabel: 'Durable VM re-verify intents',
  filename: VM_REVERIFY_INTENTS_DATABASE_FILENAME,
  applicationId: 0x444b5652,
  userVersion: 1,
  ddl: DDL_V1,
};

export interface OpenedVmReverifyIntentDatabase {
  databasePath: string;
  database: DatabaseSync;
}

export async function openVmReverifyIntentDatabase(
  dataDir: string,
): Promise<OpenedVmReverifyIntentDatabase> {
  return openOwnedSqliteDatabaseV1(dataDir, VM_REVERIFY_DESCRIPTOR);
}

export function fsyncVmReverifyIntentDatabase(databasePath: string): void {
  fsyncOwnedSqliteFileAndDirectoryV1(databasePath);
}
