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
      'author_lanes',
      'checkpoints',
      'gc_queue',
      'iblt_cache',
      'idempotency',
      'materialization',
      'object_ranges',
      'peer_state',
      'quarantine',
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
    database.prepare('UPDATE wal_control_schema SET version = 2').run();
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
    expect(blocked.integrityScan()).toEqual(expect.objectContaining({
      state: 'blocked', reasons: ['rollback-high-water-missing'],
    }));
    await expectCode(() => blocked.getRollbackHighWater(first.collectionId), 'WAL_CONTROL_BLOCKED');
  });
});

describe('WalControlStore atomic finalization and admission', () => {
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
    value.admitRemoteBatch(objects.map(item => ({
      objectId: item.walObjectId,
      object: item.tuple,
      canonicalLength: item.canonicalBytes.length,
    })), 11);
    expect(value.integrityScan()).toEqual(expect.objectContaining({ state: 'complete', objects: 2 }));
    const database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect(database.prepare("SELECT count(*) AS count FROM admission WHERE state = 'ADMITTED'").get()).toEqual({ count: 2 });
    database.close();
    await expectCode(() => value.stageAdmission({ objectId: objects[0]!.walObjectId }), 'WAL_CONTROL_LANE_CONFLICT');
    await expectCode(() => value.admitRemoteBatch([]), 'WAL_CONTROL_INVALID_CONFIGURATION');
    await expectCode(() => value.admitRemoteBatch([{
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
    expect(() => value.admitRemoteBatch([
      { objectId: objects[0]!.walObjectId, object: objects[0]!.tuple, canonicalLength: objects[0]!.canonicalBytes.length },
      { objectId: second.walObjectId, object: second.tuple, canonicalLength: second.canonicalBytes.length },
    ])).toThrowError(expect.objectContaining({ code: 'WAL_CONTROL_NOT_FOUND' }));
    const database = new Database(join(root, 'objects.sqlite'), { readonly: true });
    expect(database.prepare('SELECT count(*) AS count FROM wal_objects').get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM admission WHERE state = 'STAGED'").get()).toEqual({ count: 2 });
    database.close();
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
    await expectCode(() => value.admitRemoteBatch([{
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
    const low = value.leaseRetry(50);
    expect(low?.key).toBe('low');
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

    value.putMaterialization({
      logicalKey: bytes('logical-key'),
      desiredHeadsDigest: bytes('desired-heads'),
      desiredStateDigest: bytes('desired-state'),
      status: 'PENDING',
      attempts: 0,
      retryAtMs: 12,
      updatedAtMs: 12,
    });
    value.putMaterialization({
      logicalKey: bytes('logical-key'),
      desiredHeadsDigest: bytes('desired-heads-2'),
      desiredStateDigest: bytes('desired-state-2'),
      appliedHeadsDigest: bytes('applied-heads'),
      appliedStateDigest: bytes('applied-state'),
      status: 'APPLIED',
      attempts: 1,
      retryAtMs: 13,
      updatedAtMs: 13,
    });

    value.putPeerState({
      peerId: Uint8Array.of(1), successCount: 1, failureCount: 0,
      backoffUntilMs: 0, availabilityHint: Uint8Array.of(9), updatedAtMs: 10,
    });
    value.putPeerState({
      peerId: Uint8Array.of(1), successCount: 1, failureCount: 1,
      backoffUntilMs: 50, availabilityHint: null, updatedAtMs: 11,
    });
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
    expect(database.prepare("SELECT status FROM materialization").get()).toEqual({ status: 'APPLIED' });
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
    membershipCase.value.admitRemoteBatch([{
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
