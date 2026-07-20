import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WalControlStore,
  blobU64,
  bytesEqual,
  fixedBytes,
  safeInteger,
  u64Blob,
  type FinalizeLocalWalInput,
  type RollbackHighWater,
  type WalControlTransactionPoint,
} from '../../src/control/index.js';
import { encodeProtocolTuple } from '../../src/protocol/codec.js';
import { encodeCanonicalCbor } from '../../src/protocol/canonical-cbor.js';
import { protocolTupleId } from '../../src/protocol/hashes.js';
import {
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  signSingleProtocolTuple,
  type WalEip191Signer,
} from '../../src/protocol/signatures.js';
import type { CborProtocolValue } from '../../src/protocol/schema.js';
import { createWalObjectV1, verifyWalObjectV1, type VerifiedWalObjectV1 } from '../../src/protocol/wal-object.js';
import { hashBytes } from '../../src/reconciliation/hash.js';
import { MutableSetCommitment } from '../../src/reconciliation/set-commitment.js';
import { walObjectId } from '../../src/reconciliation/ids.js';
import { PackedWalObjectStore } from '../../src/store/packed-store.js';

const vectors = JSON.parse(await readFile(
  new URL('../../../../conformance/wal-v1/vectors/protocol-v1.json', import.meta.url),
  'utf8',
));
const roots: string[] = [];
const controls: WalControlStore[] = [];
const packedStores: PackedWalObjectStore[] = [];

afterEach(async () => {
  for (const control of controls.splice(0)) control.close();
  for (const packed of packedStores.splice(0)) packed.close();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex'));
}

function bytes(label: string): Uint8Array {
  return hashBytes(new TextEncoder().encode(`wal-control-test-v1\0${label}`));
}

const privateKey = fromHex(vectors.fixturePrivateKey);
const zeroDigest = new Uint8Array(32);
const signer: WalEip191Signer = {
  address: recoverEip191Address(zeroDigest, signEip191DigestWithPrivateKey(zeroDigest, privateKey)),
  signMessage: digest => signEip191DigestWithPrivateKey(digest, privateKey),
};

function object(name: 'first' | 'second' = 'first'): VerifiedWalObjectV1 {
  return verifyWalObjectV1(fromHex(vectors.walObjects[name].canonicalBytes));
}

async function* source(value: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.length; offset += 31) yield value.slice(offset, offset + 31);
}

async function collect(value: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of value) { chunks.push(chunk); length += chunk.length; }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

async function temporary(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dkg-wal-control-${label}-`));
  roots.push(path);
  return path;
}

function packed(root: string): PackedWalObjectStore {
  const value = new PackedWalObjectStore({ root });
  packedStores.push(value);
  return value;
}

function control(root: string, options: Partial<ConstructorParameters<typeof WalControlStore>[0]> = {}): WalControlStore {
  const value = new WalControlStore({ root, ...options });
  controls.push(value);
  return value;
}

function closeControl(value: WalControlStore): void {
  value.close();
  controls.splice(controls.indexOf(value), 1);
}

async function prepare(root: string, names: readonly ('first' | 'second')[] = ['first']) {
  const value = packed(root);
  const objects = names.map(object);
  for (const item of objects) await value.put(walObjectId(item.walObjectId), source(item.canonicalBytes));
  return { value, objects };
}

async function checkpoint(
  item: VerifiedWalObjectV1,
  ids: readonly Uint8Array[],
  checkpointNumber: bigint,
  previousCheckpointId: Uint8Array | null,
  baselineSnapshotObjectId: Uint8Array | null = null,
) {
  const set = new MutableSetCommitment(ids.map(walObjectId));
  const unsigned = [
    1n,
    item.tuple[1],
    item.tuple[2],
    item.tuple[3],
    checkpointNumber,
    1n,
    set.root,
    BigInt(ids.length),
    item.tuple[4],
    previousCheckpointId,
    baselineSnapshotObjectId,
    0n,
  ] satisfies readonly CborProtocolValue[];
  const tuple = await signSingleProtocolTuple('AuthorCheckpointV1', unsigned, signer);
  return {
    tuple,
    id: protocolTupleId('AuthorCheckpointV1', tuple),
    bytes: encodeProtocolTuple('AuthorCheckpointV1', tuple),
    root: set.root,
  };
}

async function finalizeInput(
  item: VerifiedWalObjectV1,
  ids: readonly Uint8Array[],
  checkpointNumber: bigint,
  previousCheckpointId: Uint8Array | null,
  key = `key-${checkpointNumber}`,
  baselineSnapshotObjectId: Uint8Array | null = null,
): Promise<FinalizeLocalWalInput> {
  const value = await checkpoint(item, ids, checkpointNumber, previousCheckpointId, baselineSnapshotObjectId);
  return {
    objectId: item.walObjectId,
    object: item.tuple,
    canonicalLength: item.canonicalBytes.length,
    checkpointId: value.id,
    checkpointBytes: value.bytes,
    idempotencyKey: key,
    requestDigest: bytes(`request:${key}`),
    createdAtMs: 1_000 + Number(checkpointNumber),
  };
}

async function expectCode(action: Promise<unknown> | (() => unknown), expected: string): Promise<void> {
  if (typeof action === 'function') expect(action).toThrowError(expect.objectContaining({ code: expected }));
  else await expect(action).rejects.toMatchObject({ code: expected });
}

describe('WalControlStore schema and rollback guard', () => {
  it('creates the complete deterministic control schema beside a separately guarded high-water database', async () => {
    const root = await temporary('schema');
    await prepare(root);
    const value = control(root, { now: () => 77 });
    const database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as
      Array<{ name: string }>).map(row => row.name);
    for (const name of [
      'admission',
      'authority_conflicts',
      'authority_revocations',
      'authority_sets',
      'author_checkpoint_evidence',
      'author_lanes',
      'checkpoints',
      'collection_vector_conflicts',
      'collection_vector_heads',
      'collection_vectors',
      'gc_queue',
      'iblt_cache',
      'idempotency',
      'local_commit_work',
      'local_logical_heads',
      'materialization',
      'membership_checkpoints',
      'object_ranges',
      'peer_state',
      'private_payload_nonces',
      'quarantine',
      'retention_custody_receipts',
      'retention_epochs',
      'retention_gc_objects',
      'retry_queue',
      'rollback_guard',
      'set_commitment_nodes',
      'vectors',
      'wal_control_schema',
      'wal_objects',
    ]) expect(tables).toContain(name);
    const live = (value as unknown as { database: Database.Database }).database;
    expect(live.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(live.pragma('synchronous', { simple: true })).toBe(2);
    expect(live.pragma('foreign_keys', { simple: true })).toBe(1);
    database.close();

    expect((await stat(join(root, 'rollback-high-water.sqlite'))).mode & 0o777).toBe(0o600);
    expect(value.integrityScan()).toEqual({
      state: 'complete', reasons: [], objects: 0, checkpoints: 0, queued: 0, quarantinedBytes: 0,
    });
    closeControl(value);
    const reopened = control(root);
    expect(reopened.integrityScan().state).toBe('complete');
  });

  it('rolls back failed creation and gates unsupported or missing schemas', async () => {
    const root = await temporary('migration');
    await prepare(root);
    expect(() => control(root, { migrationHook: () => { throw new Error('migration crash'); } })).toThrow();
    let database = new Database(join(root, 'objects.sqlite'));
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'wal_control_schema'").get()).toBeUndefined();
    database.close();

    let value = control(root);
    closeControl(value);
    database = new Database(join(root, 'objects.sqlite'));
    database.prepare('UPDATE wal_control_schema SET version = 8').run();
    database.close();
    await expectCode(() => control(root), 'WAL_CONTROL_UNSUPPORTED_SCHEMA');

    const missingVersionRoot = await temporary('missing-version');
    await prepare(missingVersionRoot);
    value = control(missingVersionRoot);
    closeControl(value);
    database = new Database(join(missingVersionRoot, 'objects.sqlite'));
    database.prepare('DELETE FROM wal_control_schema').run();
    database.close();
    await expectCode(() => control(missingVersionRoot), 'WAL_CONTROL_UNSUPPORTED_SCHEMA');

    const noPacked = await temporary('no-packed');
    await expectCode(() => control(noPacked), 'WAL_CONTROL_INVALID_CONFIGURATION');

    const missingObjects = await temporary('missing-objects');
    database = new Database(join(missingObjects, 'objects.sqlite'));
    database.pragma('user_version = 1');
    database.close();
    await expectCode(() => control(missingObjects), 'WAL_CONTROL_INVALID_CONFIGURATION');
  });

  it('migrates schema version 1 through retention-journal version 7 transactionally', async () => {
    const root = await temporary('migration-v1-v2');
    await prepare(root);
    let value = control(root);
    closeControl(value);
    let database = new Database(join(root, 'objects.sqlite'));
    database.pragma('foreign_keys = OFF');
    for (const table of [
      'local_logical_heads',
      'local_commit_work',
      'private_payload_nonces',
      'collection_vector_heads',
      'collection_vector_conflicts',
      'collection_vectors',
      'author_checkpoint_evidence',
      'membership_checkpoints',
      'authority_revocations',
      'authority_conflicts',
      'authority_sets',
    ]) database.exec(`DROP TABLE ${table}`);
    database.prepare('UPDATE wal_control_schema SET version = 1').run();
    database.close();

    await expectCode(
      () => control(root, { migrationHook: () => { throw new Error('v1 to v2 migration crash'); } }),
      'WAL_CONTROL_IO',
    );
    database = new Database(join(root, 'objects.sqlite'));
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(1);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'authority_sets'").get()).toBeUndefined();
    database.close();

    let hookCalls = 0;
    value = control(root, { migrationHook: () => { hookCalls += 1; } });
    expect(hookCalls).toBe(6);
    database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(7);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'authority_sets'").get()).toBeDefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'private_payload_nonces'").get()).toBeDefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_commit_work'").get()).toBeDefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_logical_heads'").get()).toBeDefined();
    database.close();
  });

  it('migrates schema version 2 through retention-journal version 7 transactionally', async () => {
    const root = await temporary('migration-v2-v3');
    await prepare(root);
    let value = control(root);
    closeControl(value);
    let database = new Database(join(root, 'objects.sqlite'));
    database.exec('DROP TABLE local_logical_heads');
    database.exec('DROP TABLE local_commit_work');
    database.exec('DROP TABLE private_payload_nonces');
    database.prepare('UPDATE wal_control_schema SET version = 2').run();
    database.close();

    await expectCode(
      () => control(root, { migrationHook: () => { throw new Error('v2 to v3 migration crash'); } }),
      'WAL_CONTROL_IO',
    );
    database = new Database(join(root, 'objects.sqlite'));
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(2);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'private_payload_nonces'").get()).toBeUndefined();
    database.close();

    let hookCalls = 0;
    value = control(root, { migrationHook: () => { hookCalls += 1; } });
    expect(hookCalls).toBe(5);
    database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(7);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'private_payload_nonces'").get()).toBeDefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_commit_work'").get()).toBeDefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_logical_heads'").get()).toBeDefined();
    database.close();
  });

  it('migrates schema version 3 through namespace-scoped local work transactionally', async () => {
    const root = await temporary('migration-v3-v4');
    await prepare(root);
    let value = control(root);
    closeControl(value);
    let database = new Database(join(root, 'objects.sqlite'));
    database.exec('DROP TABLE local_logical_heads');
    database.exec('DROP TABLE local_commit_work');
    database.prepare('UPDATE wal_control_schema SET version = 3').run();
    database.close();

    await expectCode(
      () => control(root, { migrationHook: () => { throw new Error('v3 to v4 migration crash'); } }),
      'WAL_CONTROL_IO',
    );
    database = new Database(join(root, 'objects.sqlite'));
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(3);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_commit_work'").get()).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_logical_heads'").get()).toBeUndefined();
    database.close();

    value = control(root);
    database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(7);
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_commit_work'").get()).toBeDefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_logical_heads'").get()).toBeDefined();
    database.close();
  });

  it('migrates version 4 local heads to the exact WalObject namespace without losing work', async () => {
    const root = await temporary('migration-v4-v5');
    await prepare(root);
    let value = control(root, { now: () => 4_000 });
    const input = {
      namespaceId: bytes('migration-v4-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      payloadBytes: encodeCanonicalCbor([1n, 'migration-v4-payload']),
      signer,
      idempotencyKey: 'migration-v4-request',
      requestDigest: bytes('migration-v4-request'),
      logicalKey: bytes('migration-v4-logical-key'),
    } as const;
    const committed = await value.commitLocal(input);
    closeControl(value);

    let database = new Database(join(root, 'objects.sqlite'));
    database.pragma('foreign_keys = OFF');
    database.exec(`
      CREATE TABLE local_commit_work_v4 (
        object_id BLOB PRIMARY KEY CHECK (length(object_id) = 32),
        logical_key BLOB NOT NULL CHECK (length(logical_key) = 32),
        state TEXT NOT NULL CHECK (state IN ('PENDING', 'QUEUED', 'MATERIALIZED', 'BLOCKED')),
        last_error TEXT,
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        FOREIGN KEY (object_id) REFERENCES wal_objects(object_id) ON DELETE RESTRICT
      ) WITHOUT ROWID;
      INSERT INTO local_commit_work_v4(object_id, logical_key, state, last_error, updated_at_ms)
        SELECT object_id, logical_key, state, last_error, updated_at_ms FROM local_commit_work;
      CREATE TABLE local_logical_heads_v4 (
        logical_key BLOB NOT NULL CHECK (length(logical_key) = 32),
        object_id BLOB NOT NULL UNIQUE CHECK (length(object_id) = 32),
        PRIMARY KEY (logical_key, object_id),
        FOREIGN KEY (object_id) REFERENCES wal_objects(object_id) ON DELETE RESTRICT
      ) WITHOUT ROWID;
      INSERT INTO local_logical_heads_v4(logical_key, object_id)
        SELECT logical_key, object_id FROM local_logical_heads;
      DROP TABLE local_logical_heads;
      DROP TABLE local_commit_work;
      ALTER TABLE local_commit_work_v4 RENAME TO local_commit_work;
      ALTER TABLE local_logical_heads_v4 RENAME TO local_logical_heads;
      CREATE INDEX local_commit_work_state ON local_commit_work(state, updated_at_ms, object_id);
      UPDATE wal_control_schema SET version = 4 WHERE singleton = 1;
    `);
    database.close();

    await expectCode(
      () => control(root, { migrationHook: () => { throw new Error('v4 to v5 migration crash'); } }),
      'WAL_CONTROL_IO',
    );
    database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(4);
    expect((database.pragma('table_info(local_logical_heads)') as Array<{ name: string }>)
      .map(column => column.name)).not.toContain('namespace_id');
    database.close();

    value = control(root);
    expect(value.getLocalCommitWork(committed.objectId)).toEqual(expect.objectContaining({
      objectId: committed.objectId,
      namespaceId: input.namespaceId,
      logicalKey: input.logicalKey,
      state: 'PENDING',
    }));
    expect(value.getLocalLogicalHeads(input.namespaceId, input.logicalKey)).toEqual([committed.objectId]);
    database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(7);
    database.close();
  });

  it('migrates version 5 by resetting provisional materialization into namespace-scoped version 6', async () => {
    const root = await temporary('migration-v5-v6');
    await prepare(root);
    let value = control(root);
    closeControl(value);

    let database = new Database(join(root, 'objects.sqlite'));
    database.exec(`
      DROP INDEX materialization_status_v6;
      DROP TABLE materialization;
      CREATE TABLE materialization (
        logical_key BLOB PRIMARY KEY CHECK (length(logical_key) = 32),
        desired_heads_digest BLOB NOT NULL CHECK (length(desired_heads_digest) = 32),
        desired_state_digest BLOB NOT NULL CHECK (length(desired_state_digest) = 32),
        applied_heads_digest BLOB CHECK (applied_heads_digest IS NULL OR length(applied_heads_digest) = 32),
        applied_state_digest BLOB CHECK (applied_state_digest IS NULL OR length(applied_state_digest) = 32),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'BLOCKED')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        retry_at_ms INTEGER NOT NULL CHECK (retry_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
      ) WITHOUT ROWID;
      INSERT INTO materialization(
        logical_key, desired_heads_digest, desired_state_digest,
        status, attempts, retry_at_ms, updated_at_ms
      ) VALUES (
        zeroblob(32), zeroblob(32), zeroblob(32),
        'PENDING', 1, 2, 3
      );
      UPDATE wal_control_schema SET version = 5 WHERE singleton = 1;
    `);
    database.close();

    await expectCode(
      () => control(root, { migrationHook: () => { throw new Error('v5 to v6 migration crash'); } }),
      'WAL_CONTROL_IO',
    );
    database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(5);
    expect((database.prepare('SELECT count(*) AS count FROM materialization').get() as { count: number }).count).toBe(1);
    expect((database.pragma('table_info(materialization)') as Array<{ name: string }>)
      .map(column => column.name)).not.toContain('namespace_id');
    database.close();

    value = control(root);
    database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect((database.prepare('SELECT version FROM wal_control_schema').get() as { version: number }).version).toBe(7);
    expect((database.prepare('SELECT count(*) AS count FROM materialization').get() as { count: number }).count).toBe(0);
    expect((database.pragma('table_info(materialization)') as Array<{ name: string }>)
      .map(column => column.name)).toContain('namespace_id');
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'materialization_status_v6'").get())
      .toBeDefined();
    database.close();
  });

  it('claims private-payload nonces durably and scopes uniqueness to the derived object key', async () => {
    const root = await temporary('private-nonces');
    await prepare(root);
    let value = control(root, { now: () => 55 });
    const base = {
      namespaceId: fixedBytes(bytes('nonce-namespace'), 32, 'namespaceId'),
      writerId: object('first').tuple[2],
      writerEpoch: 3n,
      sequence: 9n,
      keyEpoch: 11n,
      nonce: bytes('nonce').slice(0, 12),
    };
    value.claimPrivatePayloadNonce(base);
    await expectCode(() => value.claimPrivatePayloadNonce(base), 'WAL_CONTROL_NONCE_REUSE');
    closeControl(value);

    value = control(root);
    await expectCode(() => value.claimPrivatePayloadNonce(base), 'WAL_CONTROL_NONCE_REUSE');
    for (const changed of [
      { sequence: 10n },
      { writerEpoch: 4n },
      { namespaceId: bytes('other-namespace') },
      { writerId: bytes('other-writer').slice(0, 20) },
      { nonce: bytes('other-nonce').slice(0, 12) },
    ]) value.claimPrivatePayloadNonce({ ...base, ...changed, claimedAtMs: 56 });
    await expectCode(
      () => value.claimPrivatePayloadNonce({ ...base, keyEpoch: 12n }),
      'WAL_CONTROL_NONCE_REUSE',
    );
    await expectCode(
      () => value.claimPrivatePayloadNonce({ ...base, nonce: new Uint8Array(11) }),
      'WAL_CONTROL_INVALID_CONFIGURATION',
    );
    await expectCode(
      () => value.claimPrivatePayloadNonce({ ...base, claimedAtMs: -1 }),
      'WAL_CONTROL_INVALID_CONFIGURATION',
    );
  });

  it('rejects invalid configuration, unsafe index paths, and use after close', async () => {
    for (const options of [
      undefined,
      { root: '' },
      { root: 'relative' },
    ]) await expectCode(() => new WalControlStore(options as never), 'WAL_CONTROL_INVALID_CONFIGURATION');

    const root = await temporary('invalid-options');
    await prepare(root);
    for (const options of [
      { maximumQueueEntries: 0 },
      { maximumQueueBytes: 0 },
      { maximumQuarantineEntriesPerPeer: 0 },
      { maximumQuarantineBytesPerPeer: 0 },
      { quarantineRetentionMs: 0 },
      { busyTimeoutMs: 0 },
    ]) await expectCode(() => control(root, options), 'WAL_CONTROL_INVALID_CONFIGURATION');

    const value = control(root);
    closeControl(value);
    value.close();
    await expectCode(() => value.integrityScan(), 'WAL_CONTROL_IO');
    await expectCode(() => value.enqueueRetry({ key: 'x', kind: 'x', payload: Uint8Array.of(1) }), 'WAL_CONTROL_IO');

    const unsafeRoot = await temporary('unsafe-index');
    const unsafeStore = packed(unsafeRoot);
    unsafeStore.close();
    packedStores.splice(packedStores.indexOf(unsafeStore), 1);
    await unlink(join(unsafeRoot, 'objects.sqlite'));
    await symlink('/dev/null', join(unsafeRoot, 'objects.sqlite'));
    await expectCode(() => control(unsafeRoot), 'WAL_CONTROL_PATH_UNSAFE');

    const wrongPacked = await temporary('wrong-packed');
    await writeFile(join(wrongPacked, 'objects.sqlite'), Uint8Array.of(1));
    await expectCode(() => control(wrongPacked), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => control(`/${'x'.repeat(5_000)}`), 'WAL_CONTROL_IO');
  });

  it('adopts an existing guard after an interrupted first install and blocks guard/schema substitution', async () => {
    const adoptedRoot = await temporary('adopt-guard');
    await prepare(adoptedRoot);
    let value = control(adoptedRoot);
    closeControl(value);
    let database = new Database(join(adoptedRoot, 'objects.sqlite'));
    database.prepare('DELETE FROM rollback_guard').run();
    database.close();
    value = control(adoptedRoot);
    expect(value.integrityScan().state).toBe('complete');
    closeControl(value);

    const mismatchRoot = await temporary('guard-mismatch');
    await prepare(mismatchRoot);
    value = control(mismatchRoot);
    closeControl(value);
    database = new Database(join(mismatchRoot, 'rollback-high-water.sqlite'));
    database.prepare('UPDATE guard SET guard_id = ?').run(Buffer.alloc(16, 9));
    database.close();
    value = control(mismatchRoot);
    expect(value.integrityScan().reasons).toContain('rollback-high-water-guard-mismatch');
    closeControl(value);

    const missingGuardRoot = await temporary('guard-missing');
    await prepare(missingGuardRoot);
    value = control(missingGuardRoot);
    closeControl(value);
    database = new Database(join(missingGuardRoot, 'rollback-high-water.sqlite'));
    database.prepare('DELETE FROM guard').run();
    database.close();
    value = control(missingGuardRoot);
    expect(value.integrityScan().reasons).toContain('rollback-high-water-guard-missing');
    closeControl(value);

    const schemaRoot = await temporary('rollback-schema');
    await prepare(schemaRoot);
    value = control(schemaRoot);
    closeControl(value);
    database = new Database(join(schemaRoot, 'rollback-high-water.sqlite'));
    database.prepare('UPDATE rollback_schema SET version = 2').run();
    database.close();
    value = control(schemaRoot);
    expect(value.integrityScan().reasons).toContain('rollback-high-water-schema:2');
    closeControl(value);

    const noSchemaRoot = await temporary('rollback-no-schema');
    await prepare(noSchemaRoot);
    value = control(noSchemaRoot);
    closeControl(value);
    database = new Database(join(noSchemaRoot, 'rollback-high-water.sqlite'));
    database.exec('DROP TABLE rollback_schema');
    database.close();
    value = control(noSchemaRoot);
    expect(value.integrityScan().reasons).toContain('rollback-high-water-schema:missing');
    closeControl(value);

    const unsafeRoot = await temporary('unsafe-rollback');
    await prepare(unsafeRoot);
    value = control(unsafeRoot);
    closeControl(value);
    await unlink(join(unsafeRoot, 'rollback-high-water.sqlite'));
    await symlink('/dev/null', join(unsafeRoot, 'rollback-high-water.sqlite'));
    await expectCode(() => control(unsafeRoot), 'WAL_CONTROL_PATH_UNSAFE');
  });

  it('round-trips protocol integers and rejects invalid utility inputs', async () => {
    expect(blobU64(u64Blob(0xffff_ffff_ffff_ffffn, 'maximum'), 'maximum')).toBe(0xffff_ffff_ffff_ffffn);
    expect([...fixedBytes(Uint8Array.of(1, 2), 2, 'pair')]).toEqual([1, 2]);
    expect(bytesEqual(null, null)).toBe(true);
    expect(bytesEqual(null, Uint8Array.of())).toBe(false);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(2))).toBe(false);
    expect(safeInteger(2, 'two', 1)).toBe(2);
    for (const action of [
      () => u64Blob(-1n, 'negative'),
      () => u64Blob(1 as never, 'not-bigint'),
      () => fixedBytes(Uint8Array.of(1), 2, 'short'),
      () => safeInteger(Number.NaN, 'nan'),
    ]) await expectCode(action, 'WAL_CONTROL_INVALID_CONFIGURATION');
    expect(() => blobU64(Uint8Array.of(1), 'short')).toThrowError(expect.objectContaining({ code: 'WAL_CONTROL_CORRUPT' }));
  });

  it('advances but never lowers or equivocates the separately protected high-water', async () => {
    const root = await temporary('high-water');
    await prepare(root);
    const value = control(root);
    const first: RollbackHighWater = {
      collectionId: bytes('collection'),
      vectorEpoch: 2n,
      vectorNumber: 7n,
      vectorId: bytes('vector-7'),
      updatedAtMs: 50,
    };
    expect(value.getRollbackHighWater(first.collectionId)).toBeNull();
    expect(value.setRollbackHighWater(first)).toBe('advanced');
    expect(value.setRollbackHighWater(first)).toBe('unchanged');
    expect(value.getRollbackHighWater(first.collectionId)).toEqual(first);
    await expectCode(() => value.setRollbackHighWater({ ...first, vectorNumber: 6n }), 'WAL_CONTROL_ROLLBACK_REJECTED');
    await expectCode(() => value.setRollbackHighWater({ ...first, vectorId: bytes('equivocation') }), 'WAL_CONTROL_ROLLBACK_REJECTED');
    expect(value.setRollbackHighWater({
      ...first, vectorEpoch: 3n, vectorNumber: 0n, vectorId: bytes('vector-epoch-3'), updatedAtMs: 60,
    })).toBe('advanced');
    expect(value.setRollbackHighWater({
      ...first, vectorEpoch: 3n, vectorNumber: 1n, vectorId: bytes('vector-epoch-3-1'), updatedAtMs: 61,
    })).toBe('advanced');

    closeControl(value);
    await unlink(join(root, 'rollback-high-water.sqlite'));
    const blocked = control(root);
    expect(blocked.rollbackProtectionStatus()).toEqual({
      state: 'blocked', reason: 'rollback-high-water-missing',
    });
    expect(blocked.integrityScan()).toEqual(expect.objectContaining({
      state: 'blocked', reasons: ['rollback-high-water-missing'],
    }));
    await expectCode(() => blocked.getRollbackHighWater(first.collectionId), 'WAL_CONTROL_BLOCKED');
    blocked.installVerifiedRollbackRecovery({
      ...first,
      vectorEpoch: 3n,
      vectorNumber: 1n,
      vectorId: bytes('vector-epoch-3-1'),
      updatedAtMs: 70,
    });
    expect(blocked.rollbackProtectionStatus()).toEqual({ state: 'available' });
    expect(blocked.getRollbackHighWater(first.collectionId)).toEqual(expect.objectContaining({
      vectorEpoch: 3n, vectorNumber: 1n, vectorId: bytes('vector-epoch-3-1'), updatedAtMs: 70,
    }));
    await expectCode(() => blocked.installVerifiedRollbackRecovery(first), 'WAL_CONTROL_BLOCKED');
  });

  it('refuses trusted rollback recovery when the durable control guard is missing', async () => {
    const root = await temporary('recovery-no-control-guard');
    await prepare(root);
    let value = control(root);
    closeControl(value);
    await unlink(join(root, 'rollback-high-water.sqlite'));
    value = control(root);
    const database = (value as unknown as { database: Database.Database }).database;
    database.prepare('DELETE FROM rollback_guard').run();
    await expectCode(() => value.installVerifiedRollbackRecovery({
      collectionId: bytes('collection'),
      vectorEpoch: 1n,
      vectorNumber: 0n,
      vectorId: bytes('vector'),
      updatedAtMs: 100,
    }), 'WAL_CONTROL_CORRUPT');
    expect(value.rollbackProtectionStatus()).toEqual({
      state: 'blocked', reason: 'rollback-high-water-missing',
    });
  });

  it('reports a lost in-process rollback database handle as unavailable', async () => {
    const root = await temporary('rollback-handle-unavailable');
    await prepare(root);
    const value = control(root);
    const internal = value as unknown as {
      rollbackDatabase?: Database.Database;
      blockedReason?: string;
    };
    internal.rollbackDatabase!.close();
    internal.rollbackDatabase = undefined;
    internal.blockedReason = undefined;
    expect(value.rollbackProtectionStatus()).toEqual({
      state: 'blocked', reason: 'rollback-high-water-unavailable',
    });
  });
});

describe('WalControlStore atomic finalization and admission', () => {
  it('rejects invalid local-commit configuration, payload, limits, and causal bases', async () => {
    const invalidRoot = await temporary('invalid-local-config');
    for (const maximumObjectBytes of [0n, 8_589_934_593n]) {
      expect(() => new WalControlStore({ root: invalidRoot, maximumObjectBytes })).toThrowError(
        expect.objectContaining({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' }),
      );
    }

    const root = await temporary('invalid-local-input');
    packed(root);
    const value = control(root, { maximumObjectBytes: 1_000n });
    const common = {
      namespaceId: bytes('invalid-local-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      signer,
      idempotencyKey: 'invalid-local',
      requestDigest: bytes('invalid-local'),
    } as const;
    await expectCode(value.commitLocal({
      ...common,
      payloadBytes: 'not-bytes' as never,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(value.commitLocal({
      ...common,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(value.commitLocal({
      ...common,
      payloadBytes: Uint8Array.of(1),
      buildPayloadBytes: () => Uint8Array.of(2),
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(value.commitLocal({
      ...common,
      buildPayloadBytes: () => 'not-bytes' as never,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    for (const maximumObjectBytes of [0n, 1_001n]) {
      await expectCode(value.commitLocal({
        ...common,
        payloadBytes: Uint8Array.of(1),
        maximumObjectBytes,
      }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    }
    await expectCode(value.commitLocal({
      ...common,
      payloadBytes: Uint8Array.of(1),
      logicalKey: bytes('duplicate-head-key'),
      baseHeads: [bytes('duplicate-head'), bytes('duplicate-head')],
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(value.commitLocal({
      ...common,
      payloadBytes: Uint8Array.of(1),
      logicalKey: bytes('distinct-head-key'),
      baseHeads: [bytes('distinct-head-a'), bytes('distinct-head-b')],
    }), 'WAL_CONTROL_STALE_BASE');
    await expectCode(value.commitLocal({
      ...common,
      payloadBytes: Uint8Array.of(1),
      baseHeads: [bytes('head-without-key')],
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');

    const explicitNull = await value.commitLocal({
      ...common,
      payloadBytes: Uint8Array.of(2),
      idempotencyKey: 'explicit-null-baseline',
      requestDigest: bytes('explicit-null-baseline'),
      logicalKey: bytes('explicit-null-key'),
      baselineSnapshotObjectId: null,
      createdAtMs: 123,
    });
    expect(explicitNull.status).toBe('committed');
    const explicitBaseline = await value.commitLocal({
      ...common,
      payloadBytes: Uint8Array.of(3),
      idempotencyKey: 'explicit-baseline',
      requestDigest: bytes('explicit-baseline'),
      logicalKey: bytes('explicit-baseline-key'),
      baselineSnapshotObjectId: explicitNull.objectId,
      createdAtMs: 124,
    });
    expect(explicitBaseline.status).toBe('committed');
  });

  it('authors the complete local object, packed bytes, checkpoint, lane, and idempotency result atomically', async () => {
    const root = await temporary('local-commit');
    const physical = packed(root);
    let value = control(root, { now: () => 7_000 });
    const namespaceId = bytes('local-namespace');
    const writerId = object().tuple[2];
    const firstInput = {
      namespaceId,
      writerId,
      writerEpoch: 3n,
      payloadBytes: encodeCanonicalCbor([1n, 'first-local-payload']),
      signer,
      idempotencyKey: 'local-request-1',
      requestDigest: bytes('local-request-1'),
      logicalKey: bytes('local-logical-key'),
    } as const;
    const first = await value.commitLocal(firstInput);
    expect(first).toEqual(expect.objectContaining({
      status: 'committed', objectCount: 1n, sequence: 0n,
    }));
    const firstBytes = await collect(physical.read(walObjectId(first.objectId)));
    const firstObject = verifyWalObjectV1(firstBytes);
    expect(firstObject.tuple.slice(1, 7)).toEqual([
      namespaceId,
      writerId,
      3n,
      0n,
      null,
      firstInput.payloadBytes,
    ]);
    expect(value.getLocalCommitWork(first.objectId)).toEqual({
      objectId: first.objectId,
      namespaceId: firstInput.namespaceId,
      logicalKey: firstInput.logicalKey,
      state: 'PENDING',
      lastError: null,
      updatedAtMs: 7_000,
    });
    value.setLocalCommitWorkState({
      objectId: first.objectId,
      expected: ['PENDING'],
      state: 'QUEUED',
      updatedAtMs: 7_001,
    });

    const second = await value.commitLocal({
      ...firstInput,
      payloadBytes: encodeCanonicalCbor([1n, 'second-local-payload']),
      idempotencyKey: 'local-request-2',
      requestDigest: bytes('local-request-2'),
      baseHeads: [first.objectId],
    });
    expect(second).toEqual(expect.objectContaining({
      status: 'committed', objectCount: 2n, sequence: 1n,
    }));
    const secondObject = verifyWalObjectV1(await collect(physical.read(walObjectId(second.objectId))));
    expect(secondObject.tuple[5]).toEqual(first.objectId);
    expect(value.listLocalCommitWork()).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: first.objectId, state: 'QUEUED' }),
      expect.objectContaining({ objectId: second.objectId, state: 'PENDING' }),
    ]));
    expect(value.completeLocalCommitWorkForScope(
      firstInput.namespaceId,
      firstInput.logicalKey,
      7_002,
    )).toBe(2);
    expect(value.getLocalCommitWork(first.objectId)?.state).toBe('MATERIALIZED');
    expect(value.getLocalCommitWork(second.objectId)?.state).toBe('MATERIALIZED');
    expect(value.completeLocalCommitWorkForScope(
      firstInput.namespaceId,
      firstInput.logicalKey,
      7_003,
    )).toBe(0);
    const database = (value as unknown as { database: Database.Database }).database;
    expect(database.prepare(
      "SELECT count(*) AS count FROM idempotency WHERE status = 'MATERIALIZED'",
    ).get()).toEqual({ count: 2 });
    expect(value.getLocalLogicalHeads(firstInput.namespaceId, firstInput.logicalKey))
      .toEqual([second.objectId]);
    expect(value.integrityScan()).toEqual(expect.objectContaining({
      state: 'complete', objects: 2, checkpoints: 2,
    }));

    closeControl(value);
    value = control(root);
    expect(await value.commitLocal(firstInput)).toEqual({ ...first, status: 'already-committed' });
    await expectCode(value.commitLocal({
      ...firstInput,
      requestDigest: bytes('different-local-request'),
    }), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');
  });

  it('finalizes a sequence-bound payload synchronously inside the durable author lane', async () => {
    const root = await temporary('local-sequence-bound-payload');
    const physical = packed(root);
    const value = control(root);
    const namespaceId = bytes('sequence-bound-namespace');
    const writerId = object().tuple[2];
    const seen: Array<{ sequence: bigint; previousObjectId: Uint8Array | null }> = [];
    const write = (idempotencyKey: string, requestDigest: Uint8Array) => value.commitLocal({
      namespaceId,
      writerId,
      writerEpoch: 4n,
      buildPayloadBytes: coordinates => {
        seen.push({
          sequence: coordinates.sequence,
          previousObjectId: coordinates.previousObjectId,
        });
        return encodeCanonicalCbor([coordinates.sequence, coordinates.previousObjectId]);
      },
      signer,
      idempotencyKey,
      requestDigest,
    });

    const first = await write('sequence-bound-1', bytes('sequence-bound-1'));
    const second = await write('sequence-bound-2', bytes('sequence-bound-2'));
    expect(seen).toEqual([
      { sequence: 0n, previousObjectId: null },
      { sequence: 1n, previousObjectId: first.objectId },
    ]);
    expect(verifyWalObjectV1(await collect(physical.read(walObjectId(first.objectId)))).payloadBytes)
      .toEqual(encodeCanonicalCbor([0n, null]));
    expect(verifyWalObjectV1(await collect(physical.read(walObjectId(second.objectId)))).payloadBytes)
      .toEqual(encodeCanonicalCbor([1n, first.objectId]));

    expect((await write('sequence-bound-1', bytes('sequence-bound-1'))).objectId).toEqual(first.objectId);
    expect(seen).toHaveLength(2);
  });

  it('serializes independent local requests on one author lane without preallocating sequence numbers', async () => {
    const root = await temporary('local-concurrent');
    packed(root);
    const value = control(root);
    const common = {
      namespaceId: bytes('concurrent-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      signer,
      logicalKey: bytes('concurrent-logical-key'),
    } as const;
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => value.commitLocal({
      ...common,
      logicalKey: bytes(`concurrent-logical-key-${index}`),
      payloadBytes: encodeCanonicalCbor([1n, BigInt(index)]),
      idempotencyKey: `concurrent-${index}`,
      requestDigest: bytes(`concurrent-${index}`),
    })));
    expect(results.map(result => result.sequence).sort((left, right) => Number(left - right)))
      .toEqual(Array.from({ length: 12 }, (_, index) => BigInt(index)));
    expect(new Set(results.map(result => Buffer.from(result.objectId).toString('hex'))).size).toBe(12);
    expect(value.integrityScan()).toEqual(expect.objectContaining({
      state: 'complete', objects: 12, checkpoints: 12,
    }));
  });

  it('rejects a stale logical base and an exhausted author lane before appending bytes', async () => {
    const root = await temporary('local-stale-exhausted');
    packed(root);
    const value = control(root);
    const namespaceId = bytes('stale-namespace');
    const writerId = object().tuple[2];
    const logicalKey = bytes('stale-key');
    const first = await value.commitLocal({
      namespaceId,
      writerId,
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(1),
      signer,
      idempotencyKey: 'stale-first',
      requestDigest: bytes('stale-first'),
      logicalKey,
    });
    await expectCode(value.commitLocal({
      namespaceId,
      writerId,
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(2),
      signer,
      idempotencyKey: 'stale-second',
      requestDigest: bytes('stale-second'),
      logicalKey,
      baseHeads: [],
    }), 'WAL_CONTROL_STALE_BASE');

    const database = (value as unknown as { database: Database.Database }).database;
    database.prepare('UPDATE author_lanes SET next_sequence = ?').run(u64Blob((1n << 64n) - 1n, 'maximum'));
    await expectCode(value.commitLocal({
      namespaceId,
      writerId,
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(3),
      signer,
      idempotencyKey: 'exhausted',
      requestDigest: bytes('exhausted'),
      logicalKey: bytes('exhausted-key'),
    }), 'WAL_CONTROL_LIMIT_EXCEEDED');
    expect(await collect(packedStores[0]!.read(walObjectId(first.objectId)))).toBeDefined();
  });

  it('handles an idempotent commit discovered after BEGIN as one transaction', async () => {
    const root = await temporary('local-concurrent-idempotency');
    packed(root);
    const value = control(root);
    const input = {
      namespaceId: bytes('concurrent-idempotency-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(1),
      signer,
      idempotencyKey: 'concurrent-idempotency',
      requestDigest: bytes('concurrent-idempotency'),
      logicalKey: bytes('concurrent-idempotency-key'),
    } as const;
    const first = await value.commitLocal(input);
    const database = (value as unknown as { database: Database.Database }).database;
    const originalPrepare = database.prepare.bind(database);
    let idempotencyReads = 0;
    (database as unknown as { prepare: typeof database.prepare }).prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!sql.includes('FROM idempotency')) return statement;
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== 'get') return Reflect.get(target, property, receiver);
          return (...parameters: unknown[]) => {
            idempotencyReads += 1;
            return idempotencyReads === 1 ? undefined : target.get(...parameters);
          };
        },
      });
    }) as typeof database.prepare;
    const replay = await value.commitLocal(input);
    expect(replay).toEqual({ ...first, status: 'already-committed' });
    expect(idempotencyReads).toBe(2);
  });

  it('validates local outbox queries and compare-and-set transitions', async () => {
    const root = await temporary('local-outbox-validation');
    packed(root);
    const value = control(root, { maximumQueueEntries: 2 });
    const committed = await value.commitLocal({
      namespaceId: bytes('outbox-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(1),
      signer,
      idempotencyKey: 'outbox-validation',
      requestDigest: bytes('outbox-validation'),
      logicalKey: bytes('outbox-key'),
    });
    expect(value.getLocalCommitWork(bytes('absent-local-work'))).toBeNull();
    expect(() => value.listLocalCommitWork(['PENDING'], 3)).toThrowError(
      expect.objectContaining({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' }),
    );
    expect(() => value.listLocalCommitWork([], 1)).toThrowError(
      expect.objectContaining({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' }),
    );
    expect(() => value.listLocalCommitWork(['INVALID' as never], 1)).toThrowError(
      expect.objectContaining({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' }),
    );
    expect(() => value.setLocalCommitWorkState({
      objectId: committed.objectId,
      expected: [],
      state: 'QUEUED',
    })).toThrowError(expect.objectContaining({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' }));
    expect(() => value.setLocalCommitWorkState({
      objectId: committed.objectId,
      expected: ['MATERIALIZED'],
      state: 'QUEUED',
    })).toThrowError(expect.objectContaining({ code: 'WAL_CONTROL_LANE_CONFLICT' }));
    const database = (value as unknown as { database: Database.Database }).database;
    database.exec(`
      CREATE TRIGGER reject_scope_materialization BEFORE UPDATE ON local_commit_work
      BEGIN SELECT RAISE(ABORT, 'scope materialization'); END
    `);
    expect(() => value.completeLocalCommitWorkForScope(
      bytes('outbox-namespace'),
      bytes('outbox-key'),
    )).toThrowError(expect.objectContaining({ code: 'WAL_CONTROL_IO' }));
    expect(database.inTransaction).toBe(false);
    expect(value.getLocalCommitWork(committed.objectId)?.state).toBe('PENDING');
    database.exec('DROP TRIGGER reject_scope_materialization');
    value.setLocalCommitWorkState({
      objectId: committed.objectId,
      expected: ['PENDING'],
      state: 'MATERIALIZED',
    });
    expect(value.getLocalCommitWork(committed.objectId)?.state).toBe('MATERIALIZED');
  });

  it.each([
    'after-object-file-sync',
    'after-packed-index-insert',
    'after-object-insert',
    'after-set-update',
    'after-checkpoint-insert',
    'after-local-work-insert',
    'before-commit',
  ] satisfies WalControlTransactionPoint[])('rolls back the complete local-commit %s boundary', async point => {
    const root = await temporary(`local-${point}`);
    const physical = packed(root);
    const value = control(root, {
      transactionHook: current => { if (current === point) throw new Error(point); },
    });
    await expect(value.commitLocal({
      namespaceId: bytes('rollback-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      payloadBytes: encodeCanonicalCbor([1n, point]),
      signer,
      idempotencyKey: `rollback-${point}`,
      requestDigest: bytes(`rollback-${point}`),
      logicalKey: bytes('rollback-logical-key'),
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_IO' });
    expect(value.integrityScan()).toEqual(expect.objectContaining({
      state: 'complete', objects: 0, checkpoints: 0,
    }));
    const ids: Uint8Array[] = [];
    for await (const id of physical.ids()) ids.push(id);
    expect(ids).toEqual([]);
    expect((await stat(join(root, 'segments', '0000000000000000.pack'))).size).toBe(32);
  });

  it('recovers the exact local result after a lost post-commit acknowledgement', async () => {
    const root = await temporary('local-lost-ack');
    packed(root);
    let fail = true;
    const value = control(root, {
      transactionHook: point => {
        if (point === 'after-commit' && fail) { fail = false; throw new Error('lost local acknowledgement'); }
      },
    });
    const input = {
      namespaceId: bytes('lost-ack-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      payloadBytes: encodeCanonicalCbor([1n, 'lost-ack']),
      signer,
      idempotencyKey: 'lost-local-ack',
      requestDigest: bytes('lost-local-ack'),
      logicalKey: bytes('lost-ack-logical-key'),
    } as const;
    await expect(value.commitLocal(input)).rejects.toThrow('lost local acknowledgement');
    const recovered = await value.commitLocal(input);
    expect(recovered).toEqual(expect.objectContaining({
      status: 'already-committed', sequence: 0n, objectCount: 1n,
    }));
    expect(value.integrityScan()).toEqual(expect.objectContaining({ objects: 1, checkpoints: 1 }));
  });

  it('enforces the complete signed-object byte cap before any packed or logical state is committed', async () => {
    const root = await temporary('local-byte-limit');
    const physical = packed(root);
    const value = control(root);
    await expectCode(value.commitLocal({
      namespaceId: bytes('limit-namespace'),
      writerId: object().tuple[2],
      writerEpoch: 0n,
      payloadBytes: Uint8Array.of(1),
      signer,
      idempotencyKey: 'too-small-limit',
      requestDigest: bytes('too-small-limit'),
      maximumObjectBytes: 1n,
    }), 'WAL_CONTROL_LIMIT_EXCEEDED');
    const ids: Uint8Array[] = [];
    for await (const id of physical.ids()) ids.push(id);
    expect(ids).toEqual([]);
    expect(value.integrityScan()).toEqual(expect.objectContaining({ objects: 0, checkpoints: 0 }));
  });

  it('atomically finalizes author lanes and persists idempotency across restart', async () => {
    const root = await temporary('finalize');
    const { objects } = await prepare(root, ['first', 'second']);
    let value = control(root);
    const firstInput = await finalizeInput(objects[0]!, [objects[0]!.walObjectId], 0n, null, 'publish-1');
    const first = await value.finalizeLocal(firstInput);
    expect(first).toEqual(expect.objectContaining({
      status: 'committed', objectCount: 1n, sequence: 0n,
    }));
    expect(first.objectSetRoot).toEqual((await checkpoint(objects[0]!, [objects[0]!.walObjectId], 0n, null)).root);
    expect(await value.finalizeLocal(firstInput)).toEqual({ ...first, status: 'already-committed' });
    await expectCode(value.finalizeLocal({ ...firstInput, requestDigest: bytes('different') }), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');

    const secondInput = await finalizeInput(
      objects[1]!,
      [objects[0]!.walObjectId, objects[1]!.walObjectId],
      1n,
      first.checkpointId,
      'publish-2',
    );
    const second = await value.finalizeLocal(secondInput);
    expect(second).toEqual(expect.objectContaining({ status: 'committed', objectCount: 2n, sequence: 1n }));
    expect(value.integrityScan()).toEqual(expect.objectContaining({ state: 'complete', objects: 2, checkpoints: 2 }));
    closeControl(value);
    value = control(root);
    expect((await value.finalizeLocal(secondInput)).status).toBe('already-committed');
  });

  it.each([
    'after-object-insert',
    'after-set-update',
    'after-checkpoint-insert',
    'before-commit',
  ] satisfies WalControlTransactionPoint[])('rolls back the %s transaction boundary', async (point) => {
    const root = await temporary(`rollback-${point}`);
    const { objects } = await prepare(root);
    const input = await finalizeInput(objects[0]!, [objects[0]!.walObjectId], 0n, null);
    const value = control(root, { transactionHook: current => { if (current === point) throw new Error(point); } });
    await expect(value.finalizeLocal(input)).rejects.toMatchObject({ code: 'WAL_CONTROL_IO' });
    expect(value.integrityScan()).toEqual(expect.objectContaining({ state: 'complete', objects: 0, checkpoints: 0 }));
  });

  it('keeps the old state when failure handling is interrupted after rollback', async () => {
    const root = await temporary('rollback-hook');
    const { objects } = await prepare(root);
    const input = await finalizeInput(objects[0]!, [objects[0]!.walObjectId], 0n, null);
    const value = control(root, {
      transactionHook: point => {
        if (point === 'before-commit') throw new Error('force rollback');
        if (point === 'after-rollback') throw new Error('lost rollback acknowledgement');
      },
    });
    await expect(value.finalizeLocal(input)).rejects.toThrow('lost rollback acknowledgement');
    expect(value.integrityScan()).toEqual(expect.objectContaining({ state: 'complete', objects: 0, checkpoints: 0 }));
  });

  it('keeps a committed result when the post-commit acknowledgement is lost', async () => {
    const root = await temporary('lost-ack');
    const { objects } = await prepare(root);
    const input = await finalizeInput(objects[0]!, [objects[0]!.walObjectId], 0n, null);
    let fail = true;
    const value = control(root, {
      transactionHook: point => {
        if (point === 'after-commit' && fail) { fail = false; throw new Error('lost acknowledgement'); }
      },
    });
    await expect(value.finalizeLocal(input)).rejects.toThrow('lost acknowledgement');
    expect((await value.finalizeLocal(input)).status).toBe('already-committed');
    expect(value.integrityScan()).toEqual(expect.objectContaining({ objects: 1, checkpoints: 1 }));
  });

  it('rejects unbound objects, checkpoint substitutions, lane conflicts, and absent referenced content', async () => {
    const root = await temporary('invalid-finalize');
    const { objects } = await prepare(root, ['first']);
    const value = control(root);
    const valid = await finalizeInput(objects[0]!, [objects[0]!.walObjectId], 0n, null);
    await expectCode(value.finalizeLocal({ ...valid, objectId: bytes('wrong-id') }), 'WAL_CONTROL_CORRUPT');
    await expectCode(value.finalizeLocal({ ...valid, canonicalLength: valid.canonicalLength + 1 }), 'WAL_CONTROL_CORRUPT');
    await expectCode(value.finalizeLocal({ ...valid, checkpointId: bytes('wrong-checkpoint') }), 'WAL_CONTROL_CORRUPT');

    const second = object('second');
    const absent = await finalizeInput(second, [second.walObjectId], 0n, null, 'absent');
    await expectCode(value.finalizeLocal(absent), 'WAL_CONTROL_NOT_FOUND');

    const wrongCheckpoint = await checkpoint(objects[0]!, [objects[0]!.walObjectId], 1n, null);
    await expectCode(value.finalizeLocal({
      ...valid,
      checkpointId: wrongCheckpoint.id,
      checkpointBytes: wrongCheckpoint.bytes,
      idempotencyKey: 'wrong-lane',
      requestDigest: bytes('wrong-lane'),
    }), 'WAL_CONTROL_LANE_CONFLICT');

    await expect(value.finalizeLocal({ ...valid, policyObjectId: bytes('missing-policy') })).rejects.toMatchObject({
      code: 'WAL_CONTROL_IO',
    });
    expect(value.integrityScan()).toEqual(expect.objectContaining({ objects: 0, checkpoints: 0 }));
  });

  it('covers default commit metadata, baseline references, lane replay conflicts, and u64 exhaustion', async () => {
    const root = await temporary('lane-boundaries');
    const prepared = await prepare(root, ['first']);
    const value = control(root, { now: () => 500 });
    const first = prepared.objects[0]!;
    const input = await finalizeInput(first, [first.walObjectId], 0n, null, 'baseline', first.walObjectId);
    delete input.createdAtMs;
    input.status = 'MATERIALIZATION_PENDING';
    const committed = await value.finalizeLocal(input);
    expect(committed.status).toBe('committed');

    const replay = await finalizeInput(first, [first.walObjectId], 0n, null, 'different-key');
    await expectCode(value.finalizeLocal(replay), 'WAL_CONTROL_LANE_CONFLICT');

    const maximum = await createWalObjectV1([
      1n,
      first.tuple[1],
      first.tuple[2],
      first.tuple[3],
      0xffff_ffff_ffff_ffffn,
      first.walObjectId,
      Uint8Array.of(9),
    ], signer);
    await prepared.value.put(walObjectId(maximum.walObjectId), source(maximum.canonicalBytes));
    const database = (value as unknown as { database: Database.Database }).database;
    database.prepare(`
      UPDATE author_lanes SET next_sequence = ?, next_checkpoint_number = ?
    `).run(u64Blob(0xffff_ffff_ffff_ffffn, 'maximum'), u64Blob(0xffff_ffff_ffff_ffffn, 'maximum'));
    const maximumInput = await finalizeInput(
      maximum,
      [first.walObjectId, maximum.walObjectId],
      0xffff_ffff_ffff_ffffn,
      committed.checkpointId,
      'maximum',
    );
    maximumInput.createdAtMs = 600;
    await expectCode(value.finalizeLocal(maximumInput), 'WAL_CONTROL_LIMIT_EXCEEDED');
  });

  it('stages and atomically admits a closed remote batch', async () => {
    const root = await temporary('remote');
    const { objects } = await prepare(root, ['first', 'second']);
    const value = control(root);
    for (const item of objects) value.stageAdmission({
      objectId: item.walObjectId,
      providerPeerId: Uint8Array.of(1),
      proofBytes: Uint8Array.of(2),
      closureBytes: Uint8Array.of(3),
      updatedAtMs: 10,
    });
    await value.admitRemoteBatch(objects.map(item => ({
      objectId: item.walObjectId,
      object: item.tuple,
      canonicalLength: item.canonicalBytes.length,
    })), 11);
    expect(value.integrityScan()).toEqual(expect.objectContaining({ state: 'complete', objects: 2 }));
    const database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect(database.prepare("SELECT count(*) AS count FROM admission WHERE state = 'ADMITTED'").get()).toEqual({ count: 2 });
    database.close();
    await expectCode(() => value.stageAdmission({ objectId: objects[0]!.walObjectId }), 'WAL_CONTROL_LANE_CONFLICT');
    await expectCode(value.admitRemoteBatch([]), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(value.admitRemoteBatch([{
      objectId: objects[0]!.walObjectId,
      object: objects[0]!.tuple,
      canonicalLength: objects[0]!.canonicalBytes.length,
    }]), 'WAL_CONTROL_LANE_CONFLICT');
  });

  it('rolls back remote admission when any staged object or physical record is missing', async () => {
    const root = await temporary('remote-rollback');
    const { objects } = await prepare(root, ['first']);
    const value = control(root);
    value.stageAdmission({ objectId: objects[0]!.walObjectId });
    const second = object('second');
    value.stageAdmission({ objectId: second.walObjectId });
    await expect(value.admitRemoteBatch([
      { objectId: objects[0]!.walObjectId, object: objects[0]!.tuple, canonicalLength: objects[0]!.canonicalBytes.length },
      { objectId: second.walObjectId, object: second.tuple, canonicalLength: second.canonicalBytes.length },
    ])).rejects.toMatchObject({ code: 'WAL_CONTROL_NOT_FOUND' });
    const database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect(database.prepare('SELECT count(*) AS count FROM wal_objects').get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM admission WHERE state = 'STAGED'").get()).toEqual({ count: 2 });
    database.close();
  });

  it('exposes immutable admission metadata and atomically deduplicates logical-key replay work', async () => {
    const root = await temporary('remote-metadata');
    const { objects } = await prepare(root, ['first', 'second']);
    const value = control(root);
    const logicalA = bytes('logical-a');
    const logicalB = bytes('logical-b');
    for (const item of objects) value.stageAdmission({
      objectId: item.walObjectId,
      providerPeerId: Uint8Array.of(7),
      proofBytes: Uint8Array.of(8),
      closureBytes: Uint8Array.of(9),
      updatedAtMs: 10,
    });
    expect(value.getAdmission(objects[0]!.walObjectId)).toEqual(expect.objectContaining({
      state: 'STAGED', providerPeerId: Uint8Array.of(7), proofBytes: Uint8Array.of(8),
      closureBytes: Uint8Array.of(9), reasonCode: null, updatedAtMs: 10,
    }));
    await value.admitRemoteBatch([
      {
        objectId: objects[0]!.walObjectId,
        object: objects[0]!.tuple,
        canonicalLength: objects[0]!.canonicalBytes.length,
        logicalKeys: [logicalA, logicalB],
      },
      {
        objectId: objects[1]!.walObjectId,
        object: objects[1]!.tuple,
        canonicalLength: objects[1]!.canonicalBytes.length,
        logicalKeys: [logicalA],
      },
    ], 11);
    const metadata = value.getWalObjectMetadata(objects[0]!.walObjectId)!;
    expect(metadata).toEqual(expect.objectContaining({
      objectId: objects[0]!.walObjectId,
      namespaceId: objects[0]!.tuple[1],
      writerId: objects[0]!.tuple[2],
      writerEpoch: objects[0]!.tuple[3],
      sequence: objects[0]!.tuple[4],
      canonicalLength: objects[0]!.canonicalBytes.length,
      origin: 'REMOTE',
      admittedAtMs: 11,
    }));
    expect(value.findWalObjectAtPosition(
      objects[0]!.tuple[1], objects[0]!.tuple[2], objects[0]!.tuple[3], objects[0]!.tuple[4],
    )?.objectId).toEqual(objects[0]!.walObjectId);
    expect(value.findWalObjectAtPosition(
      bytes('absent-namespace'), objects[0]!.tuple[2], objects[0]!.tuple[3], objects[0]!.tuple[4],
    )).toBeNull();
    expect(value.getWalObjectMetadata(bytes('absent-object'))).toBeNull();
    expect(value.getAdmission(bytes('absent-admission'))).toBeNull();
    expect(value.integrityScan().queued).toBe(2);

    const leased = [value.leaseRetry(100, 11), value.leaseRetry(100, 11)];
    expect(leased.map(entry => entry?.kind)).toEqual(['WAL_REPLAY_LOGICAL_KEY', 'WAL_REPLAY_LOGICAL_KEY']);
    expect(new Set(leased.map(entry => entry?.key)).size).toBe(2);

    const retry = bytes('blocked-retry');
    value.stageAdmission({ objectId: retry, updatedAtMs: 12 });
    value.setAdmissionState(retry, 'BLOCKED', 'DEPENDENCY_UNAVAILABLE', 13);
    expect(value.getAdmission(retry)).toEqual(expect.objectContaining({
      state: 'BLOCKED', reasonCode: 'DEPENDENCY_UNAVAILABLE', updatedAtMs: 13,
    }));
    value.stageAdmission({ objectId: retry, updatedAtMs: 14 });
    expect(value.getAdmission(retry)).toEqual(expect.objectContaining({ state: 'STAGED', reasonCode: null }));
    value.setAdmissionState(retry, 'QUARANTINED', 'INVALID_WAL_OBJECT', 15);
    value.setAdmissionState(retry, 'QUARANTINED', 'INVALID_WAL_OBJECT', 16);
    await expectCode(() => value.stageAdmission({ objectId: retry }), 'WAL_CONTROL_LANE_CONFLICT');
    await expectCode(() => value.setAdmissionState(retry, 'BLOCKED', 'NO'), 'WAL_CONTROL_LANE_CONFLICT');
    await expectCode(() => value.setAdmissionState(bytes('missing-state'), 'BLOCKED', 'NO'), 'WAL_CONTROL_NOT_FOUND');
  });

  it.each([
    'after-remote-object-insert',
    'after-remote-object-admit',
    'after-replay-enqueue',
    'before-commit',
  ] satisfies WalControlTransactionPoint[])('leaves the entire remote batch staged after a crash at %s', async point => {
    const root = await temporary(`remote-crash-${point}`);
    const { objects } = await prepare(root, ['first', 'second']);
    const value = control(root, {
      transactionHook: current => { if (current === point) throw new Error(`crash:${point}`); },
    });
    for (const item of objects) value.stageAdmission({ objectId: item.walObjectId });
    await expect(value.admitRemoteBatch(objects.map((item, index) => ({
      objectId: item.walObjectId,
      object: item.tuple,
      canonicalLength: item.canonicalBytes.length,
      logicalKeys: [bytes(`crash-logical-${index}`)],
    })))).rejects.toMatchObject({ code: 'WAL_CONTROL_IO' });
    for (const item of objects) {
      expect(value.getAdmission(item.walObjectId)?.state).toBe('STAGED');
      expect(value.getWalObjectMetadata(item.walObjectId)).toBeNull();
    }
    expect(value.leaseRetry(100, 1_000)).toBeNull();
    expect(value.integrityScan()).toEqual(expect.objectContaining({ objects: 0, queued: 0 }));
  });

  it('rejects an occupied author position instead of admitting an ignored conflicting insert', async () => {
    const root = await temporary('remote-equivocation');
    const { value: packedValue, objects } = await prepare(root, ['first']);
    const first = objects[0]!;
    const conflict = await createWalObjectV1([
      1n,
      first.tuple[1],
      first.tuple[2],
      first.tuple[3],
      first.tuple[4],
      first.tuple[5],
      new TextEncoder().encode('different bytes at the same author position'),
    ], signer);
    await packedValue.put(walObjectId(conflict.walObjectId), source(conflict.canonicalBytes));
    const controlValue = control(root);
    controlValue.stageAdmission({ objectId: first.walObjectId });
    await controlValue.admitRemoteBatch([{
      objectId: first.walObjectId, object: first.tuple, canonicalLength: first.canonicalBytes.length,
    }]);
    controlValue.stageAdmission({ objectId: conflict.walObjectId });
    await expectCode(controlValue.admitRemoteBatch([{
      objectId: conflict.walObjectId,
      object: conflict.tuple,
      canonicalLength: conflict.canonicalBytes.length,
    }]), 'WAL_CONTROL_LANE_CONFLICT');
    expect(controlValue.getAdmission(conflict.walObjectId)?.state).toBe('STAGED');
    expect(controlValue.getWalObjectMetadata(conflict.walObjectId)).toBeNull();
    expect(controlValue.findWalObjectAtPosition(
      first.tuple[1], first.tuple[2], first.tuple[3], first.tuple[4],
    )?.objectId).toEqual(first.walObjectId);
  });

  it('reuses exact logical-key work and rejects retry substitution or queue overflow atomically', async () => {
    const logical = bytes('preexisting-logical');
    const retryCoordinates = (namespaceId: Uint8Array) => ({
      queueKey: `wal-replay:${Buffer.from(namespaceId).toString('hex')}:${Buffer.from(logical).toString('hex')}`,
      payload: encodeCanonicalCbor([1n, namespaceId, logical]),
    });

    let root = await temporary('remote-existing-retry');
    let prepared = await prepare(root, ['first']);
    let value = control(root);
    let { queueKey, payload } = retryCoordinates(prepared.objects[0]!.tuple[1]);
    value.enqueueRetry({ key: queueKey, kind: 'WAL_REPLAY_LOGICAL_KEY', payload });
    value.stageAdmission({ objectId: prepared.objects[0]!.walObjectId });
    await value.admitRemoteBatch([{
      objectId: prepared.objects[0]!.walObjectId,
      object: prepared.objects[0]!.tuple,
      canonicalLength: prepared.objects[0]!.canonicalBytes.length,
      logicalKeys: [logical],
    }]);
    expect(value.integrityScan()).toEqual(expect.objectContaining({ objects: 1, queued: 1 }));

    root = await temporary('remote-retry-kind-conflict');
    prepared = await prepare(root, ['first']);
    value = control(root);
    ({ queueKey, payload } = retryCoordinates(prepared.objects[0]!.tuple[1]));
    value.enqueueRetry({ key: queueKey, kind: 'OTHER', payload });
    value.stageAdmission({ objectId: prepared.objects[0]!.walObjectId });
    await expectCode(value.admitRemoteBatch([{
      objectId: prepared.objects[0]!.walObjectId,
      object: prepared.objects[0]!.tuple,
      canonicalLength: prepared.objects[0]!.canonicalBytes.length,
      logicalKeys: [logical],
    }]), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');
    expect(value.getAdmission(prepared.objects[0]!.walObjectId)?.state).toBe('STAGED');
    expect(value.getWalObjectMetadata(prepared.objects[0]!.walObjectId)).toBeNull();

    root = await temporary('remote-retry-payload-conflict');
    prepared = await prepare(root, ['first']);
    value = control(root);
    ({ queueKey, payload } = retryCoordinates(prepared.objects[0]!.tuple[1]));
    value.enqueueRetry({ key: queueKey, kind: 'WAL_REPLAY_LOGICAL_KEY', payload: Uint8Array.of(1) });
    value.stageAdmission({ objectId: prepared.objects[0]!.walObjectId });
    await expectCode(value.admitRemoteBatch([{
      objectId: prepared.objects[0]!.walObjectId,
      object: prepared.objects[0]!.tuple,
      canonicalLength: prepared.objects[0]!.canonicalBytes.length,
      logicalKeys: [logical],
    }]), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');

    root = await temporary('remote-retry-count-limit');
    prepared = await prepare(root, ['first']);
    value = control(root, { maximumQueueEntries: 1 });
    value.enqueueRetry({ key: 'occupied', kind: 'OTHER', payload: Uint8Array.of(1) });
    value.stageAdmission({ objectId: prepared.objects[0]!.walObjectId });
    await expectCode(value.admitRemoteBatch([{
      objectId: prepared.objects[0]!.walObjectId,
      object: prepared.objects[0]!.tuple,
      canonicalLength: prepared.objects[0]!.canonicalBytes.length,
      logicalKeys: [logical],
    }]), 'WAL_CONTROL_LIMIT_EXCEEDED');
    expect(value.getAdmission(prepared.objects[0]!.walObjectId)?.state).toBe('STAGED');

    root = await temporary('remote-retry-byte-limit');
    prepared = await prepare(root, ['first']);
    value = control(root, { maximumQueueBytes: 1 });
    value.stageAdmission({ objectId: prepared.objects[0]!.walObjectId });
    await expectCode(value.admitRemoteBatch([{
      objectId: prepared.objects[0]!.walObjectId,
      object: prepared.objects[0]!.tuple,
      canonicalLength: prepared.objects[0]!.canonicalBytes.length,
      logicalKeys: [logical],
    }]), 'WAL_CONTROL_LIMIT_EXCEEDED');
    expect(value.getAdmission(prepared.objects[0]!.walObjectId)?.state).toBe('STAGED');
  });

  it('fails closed if an admission-state update is suppressed and rejects state changes after admission', async () => {
    const root = await temporary('admission-update-race');
    const prepared = await prepare(root, ['first']);
    const value = control(root);
    const staged = bytes('suppressed-update');
    value.stageAdmission({ objectId: staged });
    const database = (value as unknown as { database: Database.Database }).database;
    database.exec(`
      CREATE TRIGGER suppress_admission_update BEFORE UPDATE ON admission
      WHEN OLD.object_id = NEW.object_id BEGIN SELECT RAISE(IGNORE); END
    `);
    await expectCode(() => value.setAdmissionState(staged, 'BLOCKED', 'TEST'), 'WAL_CONTROL_LANE_CONFLICT');
    database.exec('DROP TRIGGER suppress_admission_update');

    value.stageAdmission({ objectId: prepared.objects[0]!.walObjectId });
    await value.admitRemoteBatch([{
      objectId: prepared.objects[0]!.walObjectId,
      object: prepared.objects[0]!.tuple,
      canonicalLength: prepared.objects[0]!.canonicalBytes.length,
    }]);
    await expectCode(() => value.setAdmissionState(
      prepared.objects[0]!.walObjectId, 'BLOCKED', 'TEST',
    ), 'WAL_CONTROL_LANE_CONFLICT');
  });

  it('keeps committed remote admission when its post-commit acknowledgement is lost', async () => {
    const root = await temporary('remote-lost-ack');
    const prepared = await prepare(root, ['first']);
    let fail = true;
    const value = control(root, {
      transactionHook: point => {
        if (point === 'after-commit' && fail) {
          fail = false;
          throw new Error('lost remote acknowledgement');
        }
      },
    });
    value.stageAdmission({ objectId: prepared.objects[0]!.walObjectId });
    await expect(value.admitRemoteBatch([{
      objectId: prepared.objects[0]!.walObjectId,
      object: prepared.objects[0]!.tuple,
      canonicalLength: prepared.objects[0]!.canonicalBytes.length,
    }])).rejects.toThrow('lost remote acknowledgement');
    expect(value.getAdmission(prepared.objects[0]!.walObjectId)?.state).toBe('ADMITTED');
    expect(value.getWalObjectMetadata(prepared.objects[0]!.walObjectId)).not.toBeNull();
  });

  it('maps SQLite failures to stable errors and rolls back every affected control transaction', async () => {
    const root = await temporary('sqlite-failures');
    const { objects } = await prepare(root, ['first']);
    const value = control(root);
    const database = (value as unknown as { database: Database.Database }).database;

    database.exec("CREATE TRIGGER reject_stage BEFORE INSERT ON admission BEGIN SELECT RAISE(ABORT, 'stage'); END");
    await expectCode(() => value.stageAdmission({ objectId: objects[0]!.walObjectId }), 'WAL_CONTROL_IO');
    database.exec('DROP TRIGGER reject_stage');
    value.stageAdmission({ objectId: objects[0]!.walObjectId });

    database.exec("CREATE TRIGGER reject_remote BEFORE INSERT ON wal_objects BEGIN SELECT RAISE(ABORT, 'remote'); END");
    await expectCode(value.admitRemoteBatch([{
      objectId: objects[0]!.walObjectId,
      object: objects[0]!.tuple,
      canonicalLength: objects[0]!.canonicalBytes.length,
    }]), 'WAL_CONTROL_IO');
    expect(database.inTransaction).toBe(false);
    database.exec('DROP TRIGGER reject_remote');

    value.enqueueRetry({ key: 'work', kind: 'test', payload: Uint8Array.of(1) });
    database.exec("CREATE TRIGGER reject_lease BEFORE UPDATE ON retry_queue BEGIN SELECT RAISE(ABORT, 'lease'); END");
    await expectCode(() => value.leaseRetry(10), 'WAL_CONTROL_IO');
    expect(database.inTransaction).toBe(false);
    database.exec('DROP TRIGGER reject_lease');

    database.exec("CREATE TRIGGER reject_cache BEFORE INSERT ON iblt_cache BEGIN SELECT RAISE(ABORT, 'cache'); END");
    await expectCode(() => value.putIbltCache({
      headId: bytes('failure-head'), reconciliationSeed: bytes('failure-seed'), firstSymbolIndex: 0n,
      symbolCount: 1, canonicalBytes: Uint8Array.of(1), createdAtMs: 1, expiresAtMs: 2,
    }, 1, 1), 'WAL_CONTROL_IO');
    expect(database.inTransaction).toBe(false);
    database.exec('DROP TRIGGER reject_cache');

    database.exec("CREATE TRIGGER reject_vector BEFORE INSERT ON vectors BEGIN SELECT RAISE(ABORT, 'vector'); END");
    await expectCode(() => value.putVector({
      vectorId: bytes('failure-vector'), collectionId: bytes('failure-collection'),
      vectorEpoch: 0n, vectorNumber: 0n, canonicalBytes: Uint8Array.of(1),
      status: 'CURRENT', expiresAtMs: 2, createdAtMs: 1,
    }), 'WAL_CONTROL_IO');
    expect(database.inTransaction).toBe(false);
  });
});

describe('WalControlStore bounded durable work', () => {
  it('leases persistent work by priority and recovers failures, completion, and expired leases', async () => {
    let clock = 100;
    const root = await temporary('queue');
    await prepare(root);
    let value = control(root, { now: () => clock, maximumQueueEntries: 3, maximumQueueBytes: 10 });
    value.enqueueRetry({ key: 'low', kind: 'materialize', payload: Uint8Array.of(1), priority: 1, maximumAttempts: 2 });
    value.enqueueRetry({ key: 'high', kind: 'admit', payload: Uint8Array.of(2), priority: 9, maximumAttempts: 1 });
    await expectCode(() => value.enqueueRetry({ key: '', kind: 'bad', payload: Uint8Array.of(1) }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.enqueueRetry({ key: 'bad', kind: 'bad', payload: 'no' as never }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    value.enqueueRetry({ key: 'future', kind: 'sync', payload: Uint8Array.of(3), availableAtMs: 1_000 });
    value.enqueueRetry({ key: 'low', kind: 'materialize', payload: Uint8Array.of(1) });
    await expectCode(() => value.enqueueRetry({ key: 'low', kind: 'other', payload: Uint8Array.of(1) }), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');
    await expectCode(() => value.enqueueRetry({ key: 'overflow', kind: 'x', payload: Uint8Array.of(1) }), 'WAL_CONTROL_LIMIT_EXCEEDED');

    const high = value.leaseRetry(50);
    expect(high).toEqual(expect.objectContaining({ key: 'high', state: 'LEASED', leaseUntilMs: 150 }));
    expect(value.failRetry('high', 'permanent', 200)).toBe('BLOCKED');
    expect(value.cancelRetry('high')).toBe(true);
    expect(value.cancelRetry('high')).toBe(false);
    const low = value.leaseRetry(50);
    expect(low?.key).toBe('low');
    expect(value.cancelRetry('low')).toBe(false);
    await expectCode(() => value.cancelRetry(''), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.completeRetry('missing'), 'WAL_CONTROL_LEASE_CONFLICT');
    await expectCode(() => value.failRetry('missing', 'no lease', 1), 'WAL_CONTROL_LEASE_CONFLICT');
    await expectCode(() => value.leaseRetry(1, Number.MAX_SAFE_INTEGER), 'WAL_CONTROL_INVALID_CONFIGURATION');
    closeControl(value);

    clock = 151;
    value = control(root, { now: () => clock, maximumQueueEntries: 3, maximumQueueBytes: 10 });
    expect(value.leaseRetry(50)?.key).toBe('low');
    value.completeRetry('low');
    expect(value.leaseRetry(50)).toBeNull();
    clock = 1_000;
    expect(value.leaseRetry(50)?.key).toBe('future');
    expect(value.failRetry('future', 'retry', 1_000)).toBe('READY');
    expect(value.leaseRetry(50)?.key).toBe('future');
    value.completeRetry('future');
  });

  it('bounds quarantine by peer, preserves idempotency, validates paths, and expires rows', async () => {
    const root = await temporary('quarantine');
    await prepare(root);
    const value = control(root, {
      maximumQuarantineEntriesPerPeer: 2,
      maximumQuarantineBytesPerPeer: 5,
      quarantineRetentionMs: 100,
      now: () => 10,
    });
    const peer = Uint8Array.of(1);
    value.quarantine({ entryId: bytes('q1'), providerPeerId: peer, reasonCode: 'BAD_ID', byteLength: 2, relativePath: 'q/1' });
    value.quarantine({ entryId: bytes('q1'), providerPeerId: peer, reasonCode: 'BAD_ID', byteLength: 2 });
    value.quarantine({ entryId: bytes('q2'), providerPeerId: peer, reasonCode: 'BAD_SIG', byteLength: 3 });
    expect(value.getQuarantine(bytes('q1'))).toEqual(expect.objectContaining({
      entryId: bytes('q1'), providerPeerId: peer, reasonCode: 'BAD_ID', relativePath: 'q/1',
      byteLength: 2, createdAtMs: 10, expiresAtMs: 110,
    }));
    expect(value.getQuarantine(bytes('missing-q'))).toBeNull();
    expect(value.listQuarantine(peer).map(entry => entry.reasonCode)).toEqual(['BAD_ID', 'BAD_SIG']);
    expect(value.listQuarantine(undefined, 1)).toHaveLength(1);
    await expectCode(() => value.listQuarantine(new Uint8Array()), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.listQuarantine(undefined, 3), 'WAL_CONTROL_INVALID_CONFIGURATION');
    expect(value.integrityScan().quarantinedBytes).toBe(5);
    await expectCode(() => value.quarantine({
      entryId: bytes('q3'), providerPeerId: peer, reasonCode: 'OVER', byteLength: 1,
    }), 'WAL_CONTROL_LIMIT_EXCEEDED');
    await expectCode(() => value.quarantine({
      entryId: bytes('path'), providerPeerId: peer, reasonCode: 'PATH', byteLength: 0, relativePath: '../escape',
    }), 'WAL_CONTROL_PATH_UNSAFE');
    await expectCode(() => value.quarantine({
      entryId: bytes('peer'), providerPeerId: new Uint8Array(), reasonCode: 'PEER', byteLength: 0,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.quarantine({
      entryId: bytes('expiry'), providerPeerId: Uint8Array.of(2), reasonCode: 'TIME', byteLength: 0,
      createdAtMs: 10, expiresAtMs: 10,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    expect(value.cleanupExpired(109).quarantine).toBe(0);
    expect(value.cleanupExpired(110).quarantine).toBe(2);
    expect(value.integrityScan().quarantinedBytes).toBe(0);
  });

  it.each([
    'after-quarantine-insert',
    'after-quarantine-state',
    'before-commit',
  ] satisfies WalControlTransactionPoint[])('rolls back quarantine metadata and admission state after a crash at %s', async point => {
    const root = await temporary(`quarantine-crash-${point}`);
    await prepare(root);
    const value = control(root, {
      transactionHook: current => { if (current === point) throw new Error(`crash:${point}`); },
    });
    const id = bytes(`quarantine-crash-id-${point}`);
    value.stageAdmission({ objectId: id });
    await expect(value.quarantineAdmission({
      entryId: id,
      providerPeerId: Uint8Array.of(1),
      reasonCode: 'INVALID_WAL_OBJECT',
      byteLength: 10,
      createdAtMs: 10,
      updatedAtMs: 10,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_IO' });
    expect(value.getAdmission(id)?.state).toBe('STAGED');
    expect(value.getQuarantine(id)).toBeNull();
  });

  it('atomically quarantines an invalid dependency, blocks its root, and preserves the bounds across restart', async () => {
    const root = await temporary('quarantine-admission');
    const prepared = await prepare(root, ['first']);
    let value = control(root, {
      maximumQuarantineEntriesPerPeer: 1,
      maximumQuarantineBytesPerPeer: 20,
      quarantineRetentionMs: 100,
      now: () => 10,
    });
    const dependency = bytes('bad-dependency');
    const rootObject = bytes('blocked-root');
    const peer = Uint8Array.of(1);
    value.stageAdmission({ objectId: dependency });
    value.stageAdmission({ objectId: rootObject });
    await value.quarantineAdmission({
      entryId: dependency,
      providerPeerId: peer,
      reasonCode: 'INVALID_WAL_OBJECT',
      byteLength: 20,
      blockedRootObjectId: rootObject,
      createdAtMs: 10,
      updatedAtMs: 11,
    });
    expect(value.getAdmission(dependency)).toEqual(expect.objectContaining({
      state: 'QUARANTINED', reasonCode: 'INVALID_WAL_OBJECT', updatedAtMs: 11,
    }));
    expect(value.getAdmission(rootObject)).toEqual(expect.objectContaining({
      state: 'BLOCKED', reasonCode: 'DEPENDENCY_INVALID', updatedAtMs: 11,
    }));
    closeControl(value);
    value = control(root, {
      maximumQuarantineEntriesPerPeer: 1,
      maximumQuarantineBytesPerPeer: 20,
      quarantineRetentionMs: 100,
      now: () => 11,
    });
    expect(value.listQuarantine(peer)).toHaveLength(1);
    const overflow = bytes('quarantine-overflow-after-restart');
    value.stageAdmission({ objectId: overflow });
    await expectCode(value.quarantineAdmission({
      entryId: overflow,
      providerPeerId: peer,
      reasonCode: 'INVALID_WAL_OBJECT',
      byteLength: 1,
      createdAtMs: 11,
    }), 'WAL_CONTROL_LIMIT_EXCEEDED');
    expect(value.getAdmission(overflow)?.state).toBe('STAGED');
    expect(value.getQuarantine(overflow)).toBeNull();

    const admitted = prepared.objects[0]!;
    value.stageAdmission({ objectId: admitted.walObjectId });
    await value.admitRemoteBatch([{
      objectId: admitted.walObjectId,
      object: admitted.tuple,
      canonicalLength: admitted.canonicalBytes.length,
    }]);
    await expectCode(value.quarantineAdmission({
      entryId: admitted.walObjectId,
      providerPeerId: Uint8Array.of(2),
      reasonCode: 'INVALID_WAL_OBJECT',
      byteLength: 1,
      createdAtMs: 11,
    }), 'WAL_CONTROL_LANE_CONFLICT');
    expect(value.getAdmission(admitted.walObjectId)?.state).toBe('ADMITTED');
    expect(value.getQuarantine(admitted.walObjectId)).toBeNull();
  });

  it('keeps committed quarantine state when its post-commit acknowledgement is lost', async () => {
    const root = await temporary('quarantine-lost-ack');
    await prepare(root);
    let fail = true;
    const value = control(root, {
      transactionHook: point => {
        if (point === 'after-commit' && fail) {
          fail = false;
          throw new Error('lost quarantine acknowledgement');
        }
      },
    });
    const id = bytes('quarantine-lost-ack-id');
    value.stageAdmission({ objectId: id });
    await expect(value.quarantineAdmission({
      entryId: id,
      providerPeerId: Uint8Array.of(1),
      reasonCode: 'INVALID_WAL_OBJECT',
      byteLength: 1,
      createdAtMs: 10,
    })).rejects.toThrow('lost quarantine acknowledgement');
    expect(value.getAdmission(id)?.state).toBe('QUARANTINED');
    expect(value.getQuarantine(id)).not.toBeNull();
    await value.quarantineAdmission({
      entryId: id,
      providerPeerId: Uint8Array.of(1),
      reasonCode: 'INVALID_WAL_OBJECT',
      byteLength: 1,
      createdAtMs: 10,
    });
  });

  it('persists bounded ranges, IBLT cache, vectors, materialization, peers, and GC work', async () => {
    const root = await temporary('control-surfaces');
    await prepare(root);
    const value = control(root);

    value.recordObjectRange({
      objectId: bytes('range-object'),
      offset: 0,
      length: 4,
      totalLength: 8,
      relativePath: 'ranges/0.part',
      providerPeerId: Uint8Array.of(1),
      receivedAtMs: 10,
      expiresAtMs: 20,
    });
    value.recordObjectRange({
      objectId: bytes('range-object'),
      offset: 0,
      length: 4,
      totalLength: 8,
      relativePath: 'ranges/retry.part',
      receivedAtMs: 11,
      expiresAtMs: 21,
    });
    await expectCode(() => value.recordObjectRange({
      objectId: bytes('range-object'), offset: 4, length: 4, totalLength: 9,
      relativePath: 'ranges/bad.part', receivedAtMs: 10, expiresAtMs: 20,
    }), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');
    await expectCode(() => value.recordObjectRange({
      objectId: bytes('bad-range'), offset: 7, length: 2, totalLength: 8,
      relativePath: 'ranges/bad.part', receivedAtMs: 10, expiresAtMs: 20,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.recordObjectRange({
      objectId: bytes('expired-range'), offset: 0, length: 1, totalLength: 1,
      relativePath: 'ranges/expired.part', receivedAtMs: 10, expiresAtMs: 10,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');

    const head = bytes('head');
    const seed = bytes('seed');
    value.putIbltCache({
      headId: head,
      reconciliationSeed: seed,
      firstSymbolIndex: 0n,
      symbolCount: 1,
      canonicalBytes: Uint8Array.of(1, 2),
      createdAtMs: 10,
      expiresAtMs: 30,
    }, 1, 3);
    expect(value.getIbltCache(head, seed, 0n)).toEqual(Uint8Array.of(1, 2));
    value.putIbltCache({
      headId: bytes('head-2'),
      reconciliationSeed: seed,
      firstSymbolIndex: 1n,
      symbolCount: 2,
      canonicalBytes: Uint8Array.of(3, 4, 5),
      createdAtMs: 11,
      expiresAtMs: 31,
    }, 1, 3);
    expect(value.getIbltCache(head, seed, 0n)).toBeNull();
    expect(value.getIbltCache(bytes('head-2'), seed, 1n)).toEqual(Uint8Array.of(3, 4, 5));
    value.putIbltCache({
      headId: bytes('head-2'), reconciliationSeed: seed, firstSymbolIndex: 1n, symbolCount: 1,
      canonicalBytes: Uint8Array.of(6), createdAtMs: 12, expiresAtMs: 32,
    }, 1, 3);
    expect(value.getIbltCache(bytes('head-2'), seed, 1n)).toEqual(Uint8Array.of(6));
    await expectCode(() => value.putIbltCache({
      headId: head, reconciliationSeed: seed, firstSymbolIndex: 0n, symbolCount: 1,
      canonicalBytes: new Uint8Array(), createdAtMs: 10, expiresAtMs: 20,
    }, 1, 3), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.putIbltCache({
      headId: head, reconciliationSeed: seed, firstSymbolIndex: 0n, symbolCount: 1,
      canonicalBytes: Uint8Array.of(1, 2, 3, 4), createdAtMs: 10, expiresAtMs: 20,
    }, 1, 3), 'WAL_CONTROL_LIMIT_EXCEEDED');
    await expectCode(() => value.putIbltCache({
      headId: head, reconciliationSeed: seed, firstSymbolIndex: 0n, symbolCount: 1,
      canonicalBytes: Uint8Array.of(1), createdAtMs: 20, expiresAtMs: 20,
    }, 1, 3), 'WAL_CONTROL_LIMIT_EXCEEDED');

    const collection = bytes('vector-collection');
    value.putVector({
      vectorId: bytes('vector-1'), collectionId: collection, vectorEpoch: 0n, vectorNumber: 1n,
      canonicalBytes: Uint8Array.of(1), status: 'CURRENT', expiresAtMs: 100, createdAtMs: 10,
    });
    value.putVector({
      vectorId: bytes('vector-2'), collectionId: collection, vectorEpoch: 0n, vectorNumber: 2n,
      canonicalBytes: Uint8Array.of(2), status: 'CURRENT', expiresAtMs: 100, createdAtMs: 11,
    });
    value.putVector({
      vectorId: bytes('vector-3'), collectionId: collection, vectorEpoch: 0n, vectorNumber: 3n,
      canonicalBytes: Uint8Array.of(3), status: 'VERIFIED', expiresAtMs: 100, createdAtMs: 12,
    });
    await expectCode(() => value.putVector({
      vectorId: bytes('empty-vector'), collectionId: collection, vectorEpoch: 0n, vectorNumber: 4n,
      canonicalBytes: new Uint8Array(), status: 'VERIFIED', expiresAtMs: 100, createdAtMs: 12,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.putVector({
      vectorId: bytes('vector-2'), collectionId: collection, vectorEpoch: 0n, vectorNumber: 2n,
      canonicalBytes: Uint8Array.of(9), status: 'CURRENT', expiresAtMs: 100, createdAtMs: 11,
    }), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');
    await expectCode(() => value.putVector({
      vectorId: bytes('vector-2'), collectionId: bytes('other-collection'), vectorEpoch: 0n, vectorNumber: 2n,
      canonicalBytes: Uint8Array.of(2), status: 'CURRENT', expiresAtMs: 100, createdAtMs: 11,
    }), 'WAL_CONTROL_IDEMPOTENCY_CONFLICT');

    const materializationNamespace = bytes('materialization-namespace');
    const materializationLogicalKey = bytes('logical-key');
    value.putMaterialization({
      namespaceId: materializationNamespace,
      logicalKey: materializationLogicalKey,
      desiredHeadsDigest: bytes('desired-heads'),
      desiredConflictHeadsDigest: bytes('desired-conflicts'),
      desiredStateDigest: bytes('desired-state'),
      sourceVectorId: bytes('materialization-vector'),
      status: 'PENDING',
      attempts: 0,
      retryAtMs: 12,
      lastError: 'waiting',
      updatedAtMs: 12,
    });
    expect(value.getMaterialization(materializationNamespace, materializationLogicalKey)).toEqual({
      namespaceId: materializationNamespace,
      logicalKey: materializationLogicalKey,
      desiredHeadsDigest: bytes('desired-heads'),
      desiredConflictHeadsDigest: bytes('desired-conflicts'),
      desiredStateDigest: bytes('desired-state'),
      sourceVectorId: bytes('materialization-vector'),
      appliedHeadsDigest: null,
      appliedConflictHeadsDigest: null,
      appliedStateDigest: null,
      status: 'PENDING',
      attempts: 0,
      retryAtMs: 12,
      lastError: 'waiting',
      updatedAtMs: 12,
    });
    value.putMaterialization({
      namespaceId: materializationNamespace,
      logicalKey: materializationLogicalKey,
      desiredHeadsDigest: bytes('desired-heads-2'),
      desiredConflictHeadsDigest: bytes('desired-conflicts-2'),
      desiredStateDigest: bytes('desired-state-2'),
      sourceVectorId: bytes('materialization-vector-2'),
      appliedHeadsDigest: bytes('applied-heads'),
      appliedConflictHeadsDigest: bytes('applied-conflicts'),
      appliedStateDigest: bytes('applied-state'),
      status: 'APPLIED',
      attempts: 1,
      retryAtMs: 13,
      updatedAtMs: 13,
    });
    const otherMaterializationNamespace = bytes('other-materialization-namespace');
    value.putMaterialization({
      namespaceId: otherMaterializationNamespace,
      logicalKey: materializationLogicalKey,
      desiredHeadsDigest: bytes('other-desired-heads'),
      desiredConflictHeadsDigest: bytes('other-desired-conflicts'),
      desiredStateDigest: bytes('other-desired-state'),
      sourceVectorId: bytes('other-materialization-vector'),
      status: 'BLOCKED',
      attempts: 2,
      retryAtMs: 14,
      lastError: 'selective rebuild required',
      updatedAtMs: 14,
    });
    expect(value.getMaterialization(materializationNamespace, materializationLogicalKey)).toEqual(
      expect.objectContaining({
        namespaceId: materializationNamespace,
        status: 'APPLIED',
        desiredConflictHeadsDigest: bytes('desired-conflicts-2'),
        appliedConflictHeadsDigest: bytes('applied-conflicts'),
        lastError: null,
      }),
    );
    expect(value.getMaterialization(otherMaterializationNamespace, materializationLogicalKey)).toEqual(
      expect.objectContaining({ namespaceId: otherMaterializationNamespace, status: 'BLOCKED' }),
    );
    expect(value.getMaterialization(bytes('missing-materialization-namespace'), materializationLogicalKey)).toBeNull();
    expect(value.listMaterializations()).toEqual([
      expect.objectContaining({ namespaceId: otherMaterializationNamespace, status: 'BLOCKED' }),
    ]);
    expect(value.listMaterializations(['APPLIED'], 1)).toEqual([
      expect.objectContaining({ namespaceId: materializationNamespace, status: 'APPLIED' }),
    ]);
    await expectCode(() => value.listMaterializations([], 1), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(
      () => value.listMaterializations(['INVALID' as never], 1),
      'WAL_CONTROL_INVALID_CONFIGURATION',
    );
    await expectCode(() => value.listMaterializations(['APPLIED'], 0), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(
      () => value.listMaterializations(['APPLIED'], 100_001),
      'WAL_CONTROL_INVALID_CONFIGURATION',
    );

    value.putPeerState({
      peerId: Uint8Array.of(1), successCount: 1, failureCount: 0,
      backoffUntilMs: 0, availabilityHint: Uint8Array.of(9), updatedAtMs: 10,
    });
    value.putPeerState({
      peerId: Uint8Array.of(1), successCount: 1, failureCount: 1,
      backoffUntilMs: 50, availabilityHint: null, updatedAtMs: 11,
    });
    expect(value.getPeerState(Uint8Array.of(1))).toEqual({
      peerId: Uint8Array.of(1), successCount: 1, failureCount: 1,
      backoffUntilMs: 50, availabilityHint: null, updatedAtMs: 11,
    });
    expect(value.getPeerState(Uint8Array.of(2))).toBeNull();
    expect(value.listPeerStates()).toEqual([{
      peerId: Uint8Array.of(1), successCount: 1, failureCount: 1,
      backoffUntilMs: 50, availabilityHint: null, updatedAtMs: 11,
    }]);
    value.putPeerState({
      peerId: Uint8Array.of(2), successCount: 2, failureCount: 0,
      backoffUntilMs: 0, availabilityHint: Uint8Array.of(8), updatedAtMs: 12,
    });
    expect(value.getPeerState(Uint8Array.of(2))?.availabilityHint).toEqual(Uint8Array.of(8));
    expect(value.listPeerStates().map(entry => entry.availabilityHint)).toEqual([null, Uint8Array.of(8)]);
    await expectCode(() => value.getPeerState(new Uint8Array()), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.putPeerState({
      peerId: new Uint8Array(), successCount: 0, failureCount: 0, backoffUntilMs: 0, updatedAtMs: 1,
    }), 'WAL_CONTROL_INVALID_CONFIGURATION');

    value.enqueueGc({
      targetId: bytes('gc'), relativePath: 'segments/old.pack', byteLength: 4,
      eligibleAtMs: 100, createdAtMs: 10,
    }, 1, 5);
    value.enqueueGc({
      targetId: bytes('gc'), relativePath: 'segments/old.pack', byteLength: 5,
      eligibleAtMs: 101, state: 'BLOCKED', createdAtMs: 10,
    }, 1, 5);
    await expectCode(() => value.enqueueGc({
      targetId: bytes('gc-2'), relativePath: 'segments/other.pack', byteLength: 1,
      eligibleAtMs: 100, createdAtMs: 10,
    }, 1, 5), 'WAL_CONTROL_LIMIT_EXCEEDED');

    const database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect(database.prepare("SELECT count(*) AS count FROM vectors WHERE status = 'CURRENT'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM materialization").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT count(*) AS count FROM materialization WHERE status = 'APPLIED'").get())
      .toEqual({ count: 1 });
    expect(database.prepare('SELECT failure_count FROM peer_state').get()).toEqual({ failure_count: 1 });
    expect(database.prepare('SELECT state, byte_length FROM gc_queue').get()).toEqual({ state: 'BLOCKED', byte_length: 5 });
    database.close();
    expect(value.cleanupExpired(21)).toEqual({ ranges: 1, cache: 0, quarantine: 0 });
    expect(value.cleanupExpired(32).cache).toBe(1);
  });
});

describe('WalControlStore integrity blocking', () => {
  async function finalized(label: string) {
    const root = await temporary(label);
    const prepared = await prepare(root, ['first', 'second']);
    const value = control(root);
    const input = await finalizeInput(
      prepared.objects[0]!,
      [prepared.objects[0]!.walObjectId],
      0n,
      null,
      `${label}-key`,
    );
    await value.finalizeLocal(input);
    return { root, prepared, value };
  }

  it('blocks on physical-object and foreign-key corruption', async () => {
    const { root, value } = await finalized('physical-corruption');
    const database = new Database(join(root, 'objects.sqlite'));
    database.pragma('foreign_keys = OFF');
    database.prepare('DELETE FROM objects').run();
    database.close();
    const result = value.integrityScan();
    expect(result.state).toBe('blocked');
    expect(result.reasons).toContain('foreign-keys:1');
    expect(result.reasons).toContain('physical-objects:1');
    await expectCode(() => value.enqueueRetry({ key: 'no', kind: 'no', payload: Uint8Array.of(1) }), 'WAL_CONTROL_BLOCKED');
  });

  it('blocks on lane count, membership, or commitment-snapshot corruption', async () => {
    const countCase = await finalized('count-corruption');
    let database = new Database(join(countCase.root, 'objects.sqlite'));
    database.prepare('UPDATE author_lanes SET object_count = ?').run(u64Blob(9n, 'count'));
    database.close();
    expect(countCase.value.integrityScan().reasons).toContain('set-count');

    const membershipCase = await finalized('membership-corruption');
    const second = membershipCase.prepared.objects[1]!;
    membershipCase.value.stageAdmission({ objectId: second.walObjectId });
    await membershipCase.value.admitRemoteBatch([{
      objectId: second.walObjectId,
      object: second.tuple,
      canonicalLength: second.canonicalBytes.length,
    }]);
    expect(membershipCase.value.integrityScan().reasons).toContain('set-membership');

    const snapshotCase = await finalized('snapshot-corruption');
    database = new Database(join(snapshotCase.root, 'objects.sqlite'));
    database.prepare("UPDATE set_commitment_nodes SET node_bytes = X'00'").run();
    database.close();
    expect(snapshotCase.value.integrityScan().reasons).toContain('set-snapshot');

    const snapshotMetadataCase = await finalized('snapshot-metadata-corruption');
    database = new Database(join(snapshotMetadataCase.root, 'objects.sqlite'));
    database.prepare('UPDATE set_commitment_nodes SET object_count = ?').run(u64Blob(9n, 'count'));
    database.close();
    expect(snapshotMetadataCase.value.integrityScan().reasons).toContain('set-snapshot');

    const missingCase = await finalized('missing-snapshot');
    database = new Database(join(missingCase.root, 'objects.sqlite'));
    database.pragma('foreign_keys = OFF');
    database.prepare('DELETE FROM set_commitment_nodes').run();
    database.close();
    const missing = missingCase.value.integrityScan();
    expect(missing.reasons).toContain('set-snapshot');
    expect(missing.reasons.some(reason => reason.startsWith('foreign-keys:'))).toBe(true);
  });

  it('returns blocked instead of throwing when SQLite integrity inspection itself fails', async () => {
    const root = await temporary('scan-failure');
    await prepare(root);
    const value = control(root);
    const holder = value as unknown as { database: Database.Database };
    const real = holder.database;
    Object.defineProperty(value, 'database', {
      configurable: true,
      value: { prepare: () => { throw new Error('injected scan failure'); } },
    });
    expect(value.integrityScan()).toEqual({
      state: 'blocked',
      reasons: ['scan:injected scan failure'],
      objects: 0,
      checkpoints: 0,
      queued: 0,
      quarantinedBytes: 0,
    });
    Object.defineProperty(value, 'database', { configurable: true, value: real });

    Object.defineProperty(value, 'database', {
      configurable: true,
      value: { prepare: () => { throw 'injected non-error failure'; } },
    });
    expect(value.integrityScan().reasons).toContain('scan:injected non-error failure');
    Object.defineProperty(value, 'database', { configurable: true, value: real });

    const originalPrepare = real.prepare.bind(real);
    Object.defineProperty(value, 'database', {
      configurable: true,
      value: {
        prepare: (sql: string) => sql === 'PRAGMA quick_check'
          ? { get: () => ({ quick_check: 'not-ok' }) }
          : originalPrepare(sql),
      },
    });
    const reported = value.integrityScan();
    expect(reported.reasons).toContain('sqlite:not-ok');
    Object.defineProperty(value, 'database', { configurable: true, value: real });
  });

  it('fails closed when rollback high-water storage becomes unavailable', async () => {
    const root = await temporary('rollback-unavailable');
    await prepare(root);
    const value = control(root);
    const holder = value as unknown as { rollbackDatabase: Database.Database | undefined };
    const rollback = holder.rollbackDatabase;
    holder.rollbackDatabase = undefined;
    await expectCode(() => value.getRollbackHighWater(bytes('collection')), 'WAL_CONTROL_BLOCKED');
    holder.rollbackDatabase = rollback;
  });
});
