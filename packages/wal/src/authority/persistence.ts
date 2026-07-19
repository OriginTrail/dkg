import Database from 'better-sqlite3';
import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { WAL_CONTROL_SCHEMA_VERSION } from '../control/schema.js';
import { bytesEqual, fixedBytes, safeInteger, u64Blob } from '../control/integers.js';
import type { ProtocolTuple } from '../protocol/schema.js';
import { authorityError, WalAuthorityError } from './errors.js';

export interface StoredAuthorityObject<Name extends 'AuthoritySetV1' | 'MembershipCheckpointV1' | 'CollectionHeadVectorV1'> {
  id: Uint8Array;
  canonicalBytes: Uint8Array;
  status: string;
  tuple?: ProtocolTuple<Name>;
}

export interface StoredCheckpointEvidence {
  id: Uint8Array;
  canonicalBytes: Uint8Array;
  setSnapshot: Uint8Array;
  status: 'ACCEPTED' | 'EQUIVOCATED';
}

export interface VectorHeadRecord {
  namespaceId: Uint8Array;
  writerId: Uint8Array;
  checkpointId: Uint8Array;
}

function copy(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function assertRoot(root: string): string {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    authorityError('WAL_AUTHORITY_INVALID', 'authority persistence root must be an absolute path');
  }
  const resolved = resolve(root);
  let details;
  try {
    details = lstatSync(join(resolved, 'objects.sqlite'));
  } catch (error) {
    return authorityError('WAL_AUTHORITY_IO', 'failed to inspect WAL control database', error);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    authorityError('WAL_AUTHORITY_INVALID', 'WAL control database must be a regular non-symlink file');
  }
  return resolved;
}

export class WalAuthorityPersistence {
  readonly root: string;
  readonly databasePath: string;
  private readonly database!: Database.Database;
  private closed = false;

  constructor(root: string, busyTimeoutMs = 30_000) {
    this.root = assertRoot(root);
    this.databasePath = join(this.root, 'objects.sqlite');
    safeInteger(busyTimeoutMs, 'authority busy timeout', 1);
    try {
      this.database = new Database(this.databasePath);
      this.database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('synchronous = FULL');
      const version = this.database.prepare('SELECT version FROM wal_control_schema WHERE singleton = 1').get() as
        { version: number } | undefined;
      if (version?.version !== WAL_CONTROL_SCHEMA_VERSION) {
        authorityError('WAL_AUTHORITY_INVALID', 'WAL-007 requires the current WAL control schema');
      }
      for (const table of [
        'authority_sets',
        'authority_revocations',
        'authority_conflicts',
        'membership_checkpoints',
        'author_checkpoint_evidence',
        'collection_vectors',
        'collection_vector_conflicts',
        'collection_vector_heads',
      ]) {
        const present = this.database.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table);
        if (present === undefined) authorityError('WAL_AUTHORITY_INVALID', `WAL authority table ${table} is missing`);
      }
    } catch (error) {
      if (error instanceof WalAuthorityError) throw error;
      /* v8 ignore start -- environmental SQLite/open failure is wrapped and tested at the control-store boundary */
      return authorityError('WAL_AUTHORITY_IO', 'failed to open WAL authority persistence', error);
      /* v8 ignore stop */
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  getCurrentAuthority(networkId: string, scope: bigint): StoredAuthorityObject<'AuthoritySetV1'> | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT authority_set_id, canonical_bytes, status FROM authority_sets
      WHERE network_id = ? AND scope = ? AND status = 'CURRENT'
    `).get(networkId, Number(scope)) as { authority_set_id: Buffer; canonical_bytes: Buffer; status: string } | undefined;
    return row === undefined ? null : { id: copy(row.authority_set_id), canonicalBytes: copy(row.canonical_bytes), status: row.status };
  }

  getAuthority(id: Uint8Array): StoredAuthorityObject<'AuthoritySetV1'> | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT authority_set_id, canonical_bytes, status FROM authority_sets WHERE authority_set_id = ?
    `).get(fixedBytes(id, 32, 'authoritySetId')) as
      { authority_set_id: Buffer; canonical_bytes: Buffer; status: string } | undefined;
    return row === undefined ? null : { id: copy(row.authority_set_id), canonicalBytes: copy(row.canonical_bytes), status: row.status };
  }

  isRevoked(id: Uint8Array): boolean {
    this.assertOpen();
    return this.database.prepare('SELECT 1 FROM authority_revocations WHERE revoked_authority_set_id = ?')
      .get(fixedBytes(id, 32, 'authoritySetId')) !== undefined;
  }

  hasAuthorityConflict(networkId: string, scope: bigint): boolean {
    this.assertOpen();
    return this.database.prepare('SELECT 1 FROM authority_conflicts WHERE network_id = ? AND scope = ? LIMIT 1')
      .get(networkId, Number(scope)) !== undefined;
  }

  recordAuthorityConflict(
    networkId: string,
    scope: bigint,
    epoch: bigint,
    firstId: Uint8Array,
    secondId: Uint8Array,
    detectedAtMs: number,
  ): void {
    this.assertOpen();
    this.database.prepare(`
      INSERT OR IGNORE INTO authority_conflicts(
        network_id, scope, authority_epoch, first_authority_set_id, second_authority_set_id, detected_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      networkId,
      Number(scope),
      u64Blob(epoch, 'authorityEpoch'),
      fixedBytes(firstId, 32, 'firstAuthoritySetId'),
      fixedBytes(secondId, 32, 'secondAuthoritySetId'),
      safeInteger(detectedAtMs, 'detectedAtMs'),
    );
  }

  putAuthority(
    id: Uint8Array,
    bytes: Uint8Array,
    tuple: ProtocolTuple<'AuthoritySetV1'>,
    acceptedAtMs: number,
  ): 'stored' | 'replay' {
    this.assertOpen();
    const key = fixedBytes(id, 32, 'authoritySetId');
    const existing = this.database.prepare('SELECT canonical_bytes FROM authority_sets WHERE authority_set_id = ?')
      .get(key) as { canonical_bytes: Buffer } | undefined;
    if (existing !== undefined) {
      if (!bytesEqual(existing.canonical_bytes, bytes)) authorityError('WAL_AUTHORITY_FORK', 'authority ID bytes changed');
      return 'replay';
    }
    this.transaction(() => {
      this.database.prepare("UPDATE authority_sets SET status = 'SUPERSEDED' WHERE network_id = ? AND scope = ? AND status = 'CURRENT'")
        .run(tuple[2], Number(tuple[1]));
      this.database.prepare(`
        INSERT INTO authority_sets(
          authority_set_id, canonical_bytes, scope, network_id, authority_epoch,
          threshold, not_before_ms, expires_at_ms, previous_authority_set_id, status, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)
      `).run(
        key,
        Buffer.from(bytes),
        Number(tuple[1]),
        tuple[2],
        u64Blob(tuple[3], 'authorityEpoch'),
        Number(tuple[4]),
        Number(tuple[6]),
        Number(tuple[7]),
        tuple[8] === null ? null : Buffer.from(tuple[8]),
        acceptedAtMs,
      );
      if (tuple[1] === 1n) {
        const insert = this.database.prepare(`
          INSERT OR IGNORE INTO authority_revocations(
            revoked_authority_set_id, source_authority_set_id, revoked_at_ms
          ) VALUES (?, ?, ?)
        `);
        for (const revoked of tuple[9]) insert.run(revoked, key, acceptedAtMs);
      }
    });
    return 'stored';
  }

  getCurrentMembership(collectionId: Uint8Array): StoredAuthorityObject<'MembershipCheckpointV1'> | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT membership_checkpoint_id, canonical_bytes, status FROM membership_checkpoints
      WHERE collection_id = ? AND status = 'CURRENT'
    `).get(fixedBytes(collectionId, 32, 'collectionId')) as
      { membership_checkpoint_id: Buffer; canonical_bytes: Buffer; status: string } | undefined;
    return row === undefined ? null : {
      id: copy(row.membership_checkpoint_id), canonicalBytes: copy(row.canonical_bytes), status: row.status,
    };
  }

  getMembership(id: Uint8Array): StoredAuthorityObject<'MembershipCheckpointV1'> | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT membership_checkpoint_id, canonical_bytes, status FROM membership_checkpoints
      WHERE membership_checkpoint_id = ?
    `).get(fixedBytes(id, 32, 'membershipCheckpointId')) as
      { membership_checkpoint_id: Buffer; canonical_bytes: Buffer; status: string } | undefined;
    return row === undefined ? null : {
      id: copy(row.membership_checkpoint_id), canonicalBytes: copy(row.canonical_bytes), status: row.status,
    };
  }

  putMembership(
    id: Uint8Array,
    bytes: Uint8Array,
    tuple: ProtocolTuple<'MembershipCheckpointV1'>,
    acceptedAtMs: number,
  ): 'stored' | 'replay' {
    this.assertOpen();
    const key = fixedBytes(id, 32, 'membershipCheckpointId');
    const existing = this.database.prepare('SELECT canonical_bytes FROM membership_checkpoints WHERE membership_checkpoint_id = ?')
      .get(key) as { canonical_bytes: Buffer } | undefined;
    if (existing !== undefined) {
      if (!bytesEqual(existing.canonical_bytes, bytes)) authorityError('WAL_AUTHORITY_FORK', 'membership ID bytes changed');
      return 'replay';
    }
    this.transaction(() => {
      this.database.prepare("UPDATE membership_checkpoints SET status = 'SUPERSEDED' WHERE collection_id = ? AND status = 'CURRENT'")
        .run(tuple[1]);
      this.database.prepare(`
        INSERT INTO membership_checkpoints(
          membership_checkpoint_id, canonical_bytes, collection_id, checkpoint_number,
          policy_epoch, publish_mode, rdf_policy_object_id,
          previous_membership_checkpoint_id, issued_at_ms, authority_set_id, status, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)
      `).run(
        key,
        Buffer.from(bytes),
        tuple[1],
        u64Blob(tuple[2], 'membership checkpoint number'),
        u64Blob(tuple[3], 'membership policy epoch'),
        Number(tuple[4]),
        tuple[9],
        tuple[10] === null ? null : tuple[10],
        Number(tuple[11]),
        tuple[12],
        acceptedAtMs,
      );
    });
    return 'stored';
  }

  findCheckpointAtPosition(
    namespaceId: Uint8Array,
    writerId: Uint8Array,
    writerEpoch: bigint,
    checkpointNumber: bigint,
  ): StoredCheckpointEvidence[] {
    this.assertOpen();
    const rows = this.database.prepare(`
      SELECT checkpoint_id, canonical_bytes, set_snapshot, status
      FROM author_checkpoint_evidence
      WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ? AND checkpoint_number = ?
      ORDER BY checkpoint_id
    `).all(
      fixedBytes(namespaceId, 32, 'namespaceId'),
      fixedBytes(writerId, 20, 'writerId'),
      u64Blob(writerEpoch, 'writerEpoch'),
      u64Blob(checkpointNumber, 'checkpointNumber'),
    ) as Array<{ checkpoint_id: Buffer; canonical_bytes: Buffer; set_snapshot: Buffer; status: 'ACCEPTED' | 'EQUIVOCATED' }>;
    return rows.map(row => ({
      id: copy(row.checkpoint_id),
      canonicalBytes: copy(row.canonical_bytes),
      setSnapshot: copy(row.set_snapshot),
      status: row.status,
    }));
  }

  getCheckpoint(id: Uint8Array): StoredCheckpointEvidence | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT checkpoint_id, canonical_bytes, set_snapshot, status
      FROM author_checkpoint_evidence WHERE checkpoint_id = ?
    `).get(fixedBytes(id, 32, 'checkpointId')) as
      { checkpoint_id: Buffer; canonical_bytes: Buffer; set_snapshot: Buffer; status: 'ACCEPTED' | 'EQUIVOCATED' } | undefined;
    return row === undefined ? null : {
      id: copy(row.checkpoint_id),
      canonicalBytes: copy(row.canonical_bytes),
      setSnapshot: copy(row.set_snapshot),
      status: row.status,
    };
  }

  getAcceptedLaneTip(namespaceId: Uint8Array, writerId: Uint8Array, writerEpoch: bigint): StoredCheckpointEvidence | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT checkpoint_id, canonical_bytes, set_snapshot, status
      FROM author_checkpoint_evidence
      WHERE namespace_id = ? AND writer_id = ? AND writer_epoch = ? AND status = 'ACCEPTED'
      ORDER BY checkpoint_number DESC LIMIT 1
    `).get(
      fixedBytes(namespaceId, 32, 'namespaceId'),
      fixedBytes(writerId, 20, 'writerId'),
      u64Blob(writerEpoch, 'writerEpoch'),
    ) as { checkpoint_id: Buffer; canonical_bytes: Buffer; set_snapshot: Buffer; status: 'ACCEPTED' } | undefined;
    return row === undefined ? null : {
      id: copy(row.checkpoint_id), canonicalBytes: copy(row.canonical_bytes),
      setSnapshot: copy(row.set_snapshot), status: row.status,
    };
  }

  hasLaneEquivocation(namespaceId: Uint8Array, writerId: Uint8Array): boolean {
    this.assertOpen();
    return this.database.prepare(`
      SELECT 1 FROM author_checkpoint_evidence
      WHERE namespace_id = ? AND writer_id = ? AND status = 'EQUIVOCATED' LIMIT 1
    `).get(
      fixedBytes(namespaceId, 32, 'namespaceId'),
      fixedBytes(writerId, 20, 'writerId'),
    ) !== undefined;
  }

  getLatestWriterEpoch(namespaceId: Uint8Array, writerId: Uint8Array): bigint | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT writer_epoch FROM author_checkpoint_evidence
      WHERE namespace_id = ? AND writer_id = ? ORDER BY writer_epoch DESC LIMIT 1
    `).get(
      fixedBytes(namespaceId, 32, 'namespaceId'),
      fixedBytes(writerId, 20, 'writerId'),
    ) as { writer_epoch: Buffer } | undefined;
    if (row === undefined) return null;
    let output = 0n;
    for (const byte of row.writer_epoch) output = (output << 8n) | BigInt(byte);
    return output;
  }

  getAcceptedNamespaceHeads(namespaceId: Uint8Array): Array<{ writerId: Uint8Array; checkpointId: Uint8Array }> {
    this.assertOpen();
    const rows = this.database.prepare(`
      SELECT e.writer_id, e.checkpoint_id
      FROM author_checkpoint_evidence e
      WHERE e.namespace_id = ? AND e.status = 'ACCEPTED'
        AND NOT EXISTS (
          SELECT 1 FROM author_checkpoint_evidence newer
          WHERE newer.namespace_id = e.namespace_id
            AND newer.writer_id = e.writer_id
            AND newer.status = 'ACCEPTED'
            AND (
              newer.writer_epoch > e.writer_epoch
              OR (newer.writer_epoch = e.writer_epoch AND newer.checkpoint_number > e.checkpoint_number)
            )
        )
      ORDER BY e.writer_id
    `).all(fixedBytes(namespaceId, 32, 'namespaceId')) as Array<{ writer_id: Buffer; checkpoint_id: Buffer }>;
    return rows.map(row => ({ writerId: copy(row.writer_id), checkpointId: copy(row.checkpoint_id) }));
  }

  putCheckpoint(
    id: Uint8Array,
    bytes: Uint8Array,
    tuple: ProtocolTuple<'AuthorCheckpointV1'>,
    setSnapshot: Uint8Array,
    acceptedAtMs: number,
  ): 'stored' | 'replay' {
    this.assertOpen();
    const key = fixedBytes(id, 32, 'checkpointId');
    const existing = this.getCheckpoint(key);
    if (existing !== null) {
      if (!bytesEqual(existing.canonicalBytes, bytes)) authorityError('WAL_AUTHORITY_FORK', 'checkpoint ID bytes changed');
      return 'replay';
    }
    this.database.prepare(`
      INSERT INTO author_checkpoint_evidence(
        checkpoint_id, canonical_bytes, namespace_id, writer_id, writer_epoch,
        checkpoint_number, object_set_root, object_count, max_sequence,
        previous_checkpoint_id, baseline_snapshot_object_id, compaction_floor,
        set_snapshot, status, accepted_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', ?)
    `).run(
      key,
      Buffer.from(bytes),
      tuple[1],
      tuple[2],
      u64Blob(tuple[3], 'writerEpoch'),
      u64Blob(tuple[4], 'checkpointNumber'),
      tuple[6],
      u64Blob(tuple[7], 'objectCount'),
      u64Blob(tuple[8], 'maxSequence'),
      tuple[9] === null ? null : tuple[9],
      tuple[10] === null ? null : tuple[10],
      u64Blob(tuple[11], 'compactionFloor'),
      Buffer.from(setSnapshot),
      acceptedAtMs,
    );
    return 'stored';
  }

  markEquivocation(ids: readonly Uint8Array[]): void {
    this.assertOpen();
    const update = this.database.prepare("UPDATE author_checkpoint_evidence SET status = 'EQUIVOCATED' WHERE checkpoint_id = ?");
    this.transaction(() => {
      for (const id of ids) update.run(fixedBytes(id, 32, 'checkpointId'));
    });
  }

  putVector(
    id: Uint8Array,
    bytes: Uint8Array,
    tuple: ProtocolTuple<'CollectionHeadVectorV1'>,
    heads: readonly VectorHeadRecord[],
    acceptedAtMs: number,
  ): 'stored' | 'replay' {
    this.assertOpen();
    const key = fixedBytes(id, 32, 'vectorId');
    const existing = this.database.prepare('SELECT canonical_bytes FROM collection_vectors WHERE vector_id = ?')
      .get(key) as { canonical_bytes: Buffer } | undefined;
    if (existing !== undefined) {
      if (!bytesEqual(existing.canonical_bytes, bytes)) authorityError('WAL_AUTHORITY_FORK', 'vector ID bytes changed');
      return 'replay';
    }
    this.transaction(() => {
      this.database.prepare("UPDATE collection_vectors SET status = 'VERIFIED' WHERE collection_id = ? AND status = 'CURRENT'")
        .run(tuple[1]);
      this.database.prepare(`
        INSERT INTO collection_vectors(
          vector_id, canonical_bytes, collection_id, membership_checkpoint_id,
          vector_epoch, vector_number, previous_vector_id, issued_at_ms,
          expires_at_ms, authority_set_id, status, accepted_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CURRENT', ?)
      `).run(
        key,
        Buffer.from(bytes),
        tuple[1],
        tuple[2],
        u64Blob(tuple[4], 'vectorEpoch'),
        u64Blob(tuple[5], 'vectorNumber'),
        tuple[6] === null ? null : tuple[6],
        Number(tuple[7]),
        Number(tuple[8]),
        tuple[10],
        acceptedAtMs,
      );
      const insert = this.database.prepare(`
        INSERT INTO collection_vector_heads(vector_id, namespace_id, writer_id, checkpoint_id)
        VALUES (?, ?, ?, ?)
      `);
      for (const head of heads) insert.run(key, head.namespaceId, head.writerId, head.checkpointId);
    });
    return 'stored';
  }

  getCurrentVector(collectionId: Uint8Array): StoredAuthorityObject<'CollectionHeadVectorV1'> | null {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT vector_id, canonical_bytes, status FROM collection_vectors
      WHERE collection_id = ? AND status = 'CURRENT'
    `).get(fixedBytes(collectionId, 32, 'collectionId')) as
      { vector_id: Buffer; canonical_bytes: Buffer; status: string } | undefined;
    return row === undefined ? null : { id: copy(row.vector_id), canonicalBytes: copy(row.canonical_bytes), status: row.status };
  }

  hasVectorConflict(collectionId: Uint8Array): boolean {
    this.assertOpen();
    return this.database.prepare('SELECT 1 FROM collection_vector_conflicts WHERE collection_id = ? LIMIT 1')
      .get(fixedBytes(collectionId, 32, 'collectionId')) !== undefined;
  }

  recordVectorConflict(
    collectionId: Uint8Array,
    epoch: bigint,
    number: bigint,
    firstId: Uint8Array,
    secondId: Uint8Array,
    detectedAtMs: number,
  ): void {
    this.assertOpen();
    this.database.prepare(`
      INSERT OR IGNORE INTO collection_vector_conflicts(
        collection_id, vector_epoch, vector_number, first_vector_id, second_vector_id, detected_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      fixedBytes(collectionId, 32, 'collectionId'),
      u64Blob(epoch, 'vectorEpoch'),
      u64Blob(number, 'vectorNumber'),
      fixedBytes(firstId, 32, 'firstVectorId'),
      fixedBytes(secondId, 32, 'secondVectorId'),
      safeInteger(detectedAtMs, 'detectedAtMs'),
    );
  }

  getVectorHeads(vectorId: Uint8Array): VectorHeadRecord[] {
    this.assertOpen();
    const rows = this.database.prepare(`
      SELECT namespace_id, writer_id, checkpoint_id FROM collection_vector_heads
      WHERE vector_id = ? ORDER BY namespace_id, writer_id
    `).all(fixedBytes(vectorId, 32, 'vectorId')) as
      Array<{ namespace_id: Buffer; writer_id: Buffer; checkpoint_id: Buffer }>;
    return rows.map(row => ({
      namespaceId: copy(row.namespace_id),
      writerId: copy(row.writer_id),
      checkpointId: copy(row.checkpoint_id),
    }));
  }

  private transaction(operation: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof WalAuthorityError) throw error;
      return authorityError('WAL_AUTHORITY_IO', 'failed to persist WAL authority state', error);
    }
  }

  private assertOpen(): void {
    if (this.closed) authorityError('WAL_AUTHORITY_IO', 'WAL authority persistence is closed');
  }
}
