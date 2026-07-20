import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PackedWalObjectStore,
  WalControlStore,
  WalLocalCommitter,
  WalRetentionCoordinatorV1,
  WAL_V1_ENUMS,
  canonicalizeNQuadsV1,
  createWalObjectV1,
  encodeProtocolTuple,
  protocolTupleId,
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  signSingleProtocolTuple,
  verifySnapshotCustodyForGcV1,
  type ProtocolTuple,
  type WalControlTransactionPoint,
  type WalEip191Signer,
  type VerifiedSnapshotBaselineV1,
} from '../../src/index.js';
import { walObjectId } from '../../src/reconciliation/ids.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-retention-persistence-v1\0${label}`).digest().subarray(0, length));
}

function signer(slot: number): WalEip191Signer & { readonly address: Uint8Array } {
  const privateKey = new Uint8Array(32);
  privateKey[31] = slot;
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return { address, signMessage: value => signEip191DigestWithPrivateKey(value, privateKey) };
}

const author = signer(11);
const custodianA = signer(12);
const custodianB = signer(13);
const namespaceId = bytes('namespace');
const policyObjectId = bytes('policy');
const collectionId = bytes('collection');

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `wal-retention-${label}-`));
  roots.push(value);
  return value;
}

async function readPackedObject(packed: PackedWalObjectStore, objectId: Uint8Array): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of packed.read(walObjectId(objectId))) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function openStores(
  path: string,
  hook?: (point: WalControlTransactionPoint) => void | Promise<void>,
) {
  const packed = new PackedWalObjectStore({ root: path, segmentTargetBytes: 1_048_576 });
  const control = new WalControlStore({ root: path, now: () => 1_000, transactionHook: hook });
  return { packed, control };
}

async function oldEpoch(control: WalControlStore) {
  const first = await control.commitLocal({
    namespaceId,
    writerId: author.address,
    writerEpoch: 4n,
    payloadBytes: bytes('payload-a'),
    signer: author,
    idempotencyKey: 'old-a',
    requestDigest: bytes('request-a'),
    status: 'COMMITTED',
    createdAtMs: 100,
  });
  const second = await control.commitLocal({
    namespaceId,
    writerId: author.address,
    writerEpoch: 4n,
    payloadBytes: bytes('payload-b'),
    signer: author,
    idempotencyKey: 'old-b',
    requestDigest: bytes('request-b'),
    status: 'COMMITTED',
    createdAtMs: 101,
  });
  return { first, second, ids: [first.objectId, second.objectId] as const };
}

function manifest(old: Awaited<ReturnType<typeof oldEpoch>>): ProtocolTuple<'SnapshotManifestV1'> {
  const empty = canonicalizeNQuadsV1('');
  return [
    1n,
    namespaceId,
    author.address,
    5n,
    4n,
    old.second.checkpointId,
    old.second.objectSetRoot,
    2n,
    2n,
    [[
      bytes('logical-key'),
      BigInt(WAL_V1_ENUMS.snapshotEntryState.TOMBSTONE),
      [old.second.objectId],
      empty.stateDigest,
      new Uint8Array(),
    ]],
    [],
    old.first.objectId,
    1n,
    [2043n, 99n, bytes('block')],
  ];
}

async function commitSnapshot(control: WalControlStore, old: Awaited<ReturnType<typeof oldEpoch>>) {
  const committer = new WalLocalCommitter({ control, now: () => 1_000 });
  return committer.commitSnapshot({
    manifest: manifest(old),
    signer: author,
    idempotencyKey: 'snapshot-5',
    retentionGraceMs: 30_000,
    createdAtMs: 1_000,
  });
}

async function custodyReceipt(
  custodian: WalEip191Signer & { readonly address: Uint8Array },
  snapshotObjectId: Uint8Array,
  membershipId: Uint8Array,
  peer: string,
) {
  return signSingleProtocolTuple('SnapshotCustodyReceiptV1', [
    1n,
    snapshotObjectId,
    custodian.address,
    new TextEncoder().encode(peer),
    membershipId,
    1_000n,
    100_000n,
    bytes(`nonce:${peer}`, 16),
  ], custodian);
}

async function authorizeGc(
  control: WalControlStore,
  old: Awaited<ReturnType<typeof oldEpoch>>,
  snapshotObjectId: Uint8Array,
) {
  const membershipId = bytes('membership');
  const receipts = await Promise.all([
    custodyReceipt(custodianA, snapshotObjectId, membershipId, 'peer-a'),
    custodyReceipt(custodianB, snapshotObjectId, membershipId, 'peer-b'),
  ]);
  for (const receipt of receipts) {
    await control.recordRetentionCustodyReceipt(
      encodeProtocolTuple('SnapshotCustodyReceiptV1', receipt),
      2_000,
    );
  }
  const verified = await verifySnapshotCustodyForGcV1({
    snapshotObjectId,
    authorAddress: author.address,
    currentMembershipCheckpointId: membershipId,
    receipts,
    graceStartedAtMs: 1_000n,
    retentionGraceMs: 30_000n,
    evaluatedAtMs: 31_000n,
    newEpochCheckpointVectorBound: true,
    validateCurrentCustodian: async () => ({
      current: true,
      authorized: true,
      peerMatchesAgent: true,
      removedOrRevoked: false,
    }),
  });
  const vectorId = bytes('vector');
  control.putVector({
    vectorId,
    collectionId,
    vectorEpoch: 1n,
    vectorNumber: 1n,
    canonicalBytes: bytes('vector-bytes'),
    status: 'CURRENT',
    expiresAtMs: 100_000,
    createdAtMs: 2_000,
  });
  await control.bindRetentionVector({ snapshotObjectId, vectorId, updatedAtMs: 2_000 });
  await control.markRetentionGcEligible({
    snapshotObjectId,
    verifiedReceiptIds: verified.receiptIds,
    coveredObjectIds: old.ids,
    evaluatedAtMs: 31_000,
  });
  return { receipts, verified, vectorId };
}

describe('WAL retention persistence and physical serving GC', () => {
  it('orders multi-segment physical reclamation deterministically', async () => {
    const path = await root('packed-gc-multi-segment');
    const packed = new PackedWalObjectStore({ root: path, segmentTargetBytes: 128 });
    const objects = await Promise.all([0n, 1n, 2n].map(epoch => createWalObjectV1([
      1n,
      namespaceId,
      author.address,
      100n + epoch,
      0n,
      null,
      bytes(`multi-segment-${epoch}`),
    ], author)));
    for (const object of objects) {
      await packed.put(walObjectId(object.walObjectId), (async function* () { yield object.canonicalBytes; })());
    }
    const result = await packed.collectGarbage([
      walObjectId(objects[0]!.walObjectId),
      walObjectId(objects[1]!.walObjectId),
    ], 1_000);
    expect(result.physicallyRemovedSegmentIds).toEqual([0, 1]);
    expect(await packed.has(walObjectId(objects[2]!.walObjectId))).toBe(true);
    packed.close();
  });

  it('fails closed for invalid, duplicate, missing, retired, and deferred packed GC targets', async () => {
    const path = await root('packed-gc-boundaries');
    const { packed, control } = openStores(path);
    const old = await oldEpoch(control);
    const firstBytes = await readPackedObject(packed, old.first.objectId);
    await expect(packed.collectGarbage([walObjectId(old.first.objectId)], -1))
      .rejects.toMatchObject({ code: 'WAL_STORE_INVALID_CONFIGURATION' });
    await expect(packed.collectGarbage([
      walObjectId(old.first.objectId), walObjectId(old.first.objectId),
    ], 1_000)).rejects.toMatchObject({ code: 'WAL_STORE_INVALID_CONFIGURATION' });
    await expect(packed.collectGarbage([walObjectId(bytes('missing-packed-object'))], 1_000))
      .rejects.toMatchObject({ code: 'WAL_STORE_OBJECT_NOT_FOUND' });

    const first = await packed.collectGarbage([walObjectId(old.first.objectId)], 1_000);
    expect(first).toMatchObject({ newlyRetiredObjects: 1, deferredSegmentIds: [0] });
    await expect(packed.collectGarbage([walObjectId(old.first.objectId)], 1_001))
      .resolves.toMatchObject({ alreadyRetiredObjects: 1, deferredSegmentIds: [0] });
    await expect(packed.put(walObjectId(old.first.objectId), (async function* () { yield firstBytes; })()))
      .rejects.toMatchObject({ code: 'WAL_STORE_INVALID_OBJECT' });

    await expect(packed.collectGarbage([walObjectId(old.second.objectId)], 1_002, point => {
      if (point === 'tombstones-written') throw new Error('rollback packed tombstone');
    })).rejects.toThrow('rollback packed tombstone');
    expect(await packed.has(walObjectId(old.second.objectId))).toBe(true);
    await expect(packed.collectGarbage([walObjectId(old.second.objectId)], 1_003))
      .resolves.toMatchObject({ newlyRetiredObjects: 1, deferredSegmentIds: [0] });
    control.close();
    packed.close();
  });

  it('rejects retired-segment indexes that still serve data or retire an active segment', async () => {
    const servedPath = await root('packed-gc-corrupt-served');
    let stores = openStores(servedPath);
    await oldEpoch(stores.control);
    let packedDb = (stores.packed as unknown as { database: import('better-sqlite3').Database }).database;
    packedDb.prepare('INSERT INTO packed_gc_segments(segment_id, retired_at_ms) VALUES (0, 1)').run();
    stores.control.close();
    stores.packed.close();
    expect(() => new PackedWalObjectStore({ root: servedPath }))
      .toThrow(expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }));

    const activePath = await root('packed-gc-corrupt-active');
    stores = openStores(activePath);
    const old = await oldEpoch(stores.control);
    packedDb = (stores.packed as unknown as { database: import('better-sqlite3').Database }).database;
    packedDb.prepare('INSERT INTO packed_gc_tombstones(object_id, retired_at_ms) VALUES (?, 1)')
      .run(old.first.objectId);
    packedDb.prepare('INSERT INTO packed_gc_tombstones(object_id, retired_at_ms) VALUES (?, 1)')
      .run(old.second.objectId);
    packedDb.prepare('INSERT INTO packed_gc_segments(segment_id, retired_at_ms) VALUES (0, 1)').run();
    stores.control.close();
    stores.packed.close();
    expect(() => new PackedWalObjectStore({ root: activePath }))
      .toThrow(expect.objectContaining({ code: 'WAL_STORE_CORRUPT' }));
  });

  it('authors private snapshots and reports checkpoint-nudge success/failure without changing the atom', async () => {
    const invalidPath = await root('snapshot-invalid-grace');
    let stores = openStores(invalidPath);
    let old = await oldEpoch(stores.control);
    await expect(new WalLocalCommitter({ control: stores.control }).commitSnapshot({
      manifest: manifest(old),
      signer: author,
      idempotencyKey: 'invalid-grace',
      retentionGraceMs: -1,
    })).rejects.toThrow('retentionGraceMs');
    stores.control.close();
    stores.packed.close();

    const successPath = await root('snapshot-private-nudge-success');
    stores = openStores(successPath);
    old = await oldEpoch(stores.control);
    const successNudges: bigint[] = [];
    const sent = await new WalLocalCommitter({
      control: stores.control,
      now: () => 2_000,
      sendCheckpointNudge: async nudge => { successNudges.push(nudge.sequence); },
    }).commitSnapshot({
      manifest: manifest(old),
      signer: author,
      idempotencyKey: 'private-snapshot-success',
      retentionGraceMs: 30_000,
      privatePayload: {
        epochKey: bytes('private-epoch-key'),
        keyEpoch: 7n,
        nonce: bytes('private-nonce', 12),
      },
    });
    expect(sent.receipt.nudgeStatus).toBe('sent');
    expect(successNudges).toEqual([0n]);
    stores.control.close();
    stores.packed.close();

    const failurePath = await root('snapshot-private-nudge-failure');
    stores = openStores(failurePath);
    old = await oldEpoch(stores.control);
    const failed = await new WalLocalCommitter({
      control: stores.control,
      sendCheckpointNudge: () => { throw new Error('nudge unavailable'); },
    }).commitSnapshot({
      manifest: manifest(old),
      signer: author,
      idempotencyKey: 'private-snapshot-failure',
      requestDigest: bytes('private-request-digest'),
      retentionGraceMs: 30_000,
      createdAtMs: 3_000,
      privatePayload: {
        epochKey: bytes('private-epoch-key-random-nonce'),
        keyEpoch: 8n,
      },
    });
    expect(failed.receipt).toMatchObject({
      nudgeStatus: 'failed',
      nudgeError: 'nudge unavailable',
    });
    stores.control.close();
    stores.packed.close();
  });

  it('installs a verified below-floor baseline and coordinates durable custody through exact serving GC', async () => {
    const path = await root('coordinator');
    const { packed, control } = openStores(path);
    const old = await oldEpoch(control);
    const snapshot = await commitSnapshot(control, old);
    const coordinator = new WalRetentionCoordinatorV1({ packed, control });
    const verified = {
      snapshotObjectId: snapshot.receipt.walObjectId,
      snapshotObject: [] as unknown,
      manifest: snapshot.manifest,
      coveredCheckpointId: old.second.checkpointId,
      coveredCheckpoint: [] as unknown,
      coveredObjectIds: old.ids,
    } as unknown as VerifiedSnapshotBaselineV1;
    await expect(coordinator.installVerifiedBaseline({
      verified,
      graceStartedAtMs: 1_000,
      retentionGraceMs: -1,
      updatedAtMs: 1_000,
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_INVALID' });
    await expect(coordinator.installVerifiedBaseline({
      verified,
      graceStartedAtMs: 1_000,
      retentionGraceMs: 30_000,
      updatedAtMs: 1_000,
    })).resolves.toBe('replay');

    await expect(coordinator.collectAuthorizedServingGc({
      snapshotObjectId: bytes('unknown-snapshot'),
      completedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_GC_NOT_AUTHORIZED' });
    await expect(coordinator.collectAuthorizedServingGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      completedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_GC_NOT_AUTHORIZED' });

    const vectorId = bytes('coordinator-vector');
    control.putVector({
      vectorId,
      collectionId,
      vectorEpoch: 1n,
      vectorNumber: 1n,
      canonicalBytes: bytes('coordinator-vector-bytes'),
      status: 'CURRENT',
      expiresAtMs: 100_000,
      createdAtMs: 2_000,
    });
    await control.bindRetentionVector({
      snapshotObjectId: snapshot.receipt.walObjectId,
      vectorId,
      updatedAtMs: 2_000,
    });
    const membershipId = bytes('coordinator-membership');
    const receipts = await Promise.all([
      custodyReceipt(custodianA, snapshot.receipt.walObjectId, membershipId, 'peer-a'),
      custodyReceipt(custodianB, snapshot.receipt.walObjectId, membershipId, 'peer-b'),
    ]);
    await coordinator.persistCustodyReceipts([receipts[0]!], 2_000);
    const authorize = (overrides: Partial<Parameters<typeof coordinator.authorizeServingGc>[0]> = {}) =>
      coordinator.authorizeServingGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      authorAddress: author.address,
      currentMembershipCheckpointId: membershipId,
      receipts,
      graceStartedAtMs: 1_000n,
      retentionGraceMs: 30_000n,
      evaluatedAtMs: 31_000,
      currentVectorId: vectorId,
      coveredObjectIds: old.ids,
      validateCurrentVectorBinding: async () => true,
      validateCurrentCustodian: async () => ({
        current: true, authorized: true, peerMatchesAgent: true, removedOrRevoked: false,
      }),
      ...overrides,
    });
    await expect(authorize({ currentVectorId: bytes('wrong-current-vector') }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_VECTOR_REQUIRED' });
    await expect(authorize({ validateCurrentVectorBinding: async () => false }))
      .rejects.toMatchObject({ code: 'WAL_RETENTION_VECTOR_REQUIRED' });
    await expect(authorize()).rejects.toMatchObject({ code: 'WAL_RETENTION_GC_NOT_AUTHORIZED' });
    expect(await coordinator.persistCustodyReceipts(receipts, 2_000)).toHaveLength(2);
    await expect(authorize()).resolves.toMatchObject({ receiptIds: expect.any(Array) });

    const db = (control as unknown as { database: import('better-sqlite3').Database }).database;
    db.prepare('DELETE FROM retention_gc_objects WHERE snapshot_object_id = ? AND object_id = ?')
      .run(snapshot.receipt.walObjectId, old.first.objectId);
    await expect(coordinator.collectAuthorizedServingGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      completedAtMs: 31_001,
    })).rejects.toMatchObject({ code: 'WAL_RETENTION_GC_NOT_AUTHORIZED' });
    db.prepare(`
      INSERT INTO retention_gc_objects(snapshot_object_id, object_id, state, updated_at_ms)
      VALUES (?, ?, 'ELIGIBLE', ?)
    `).run(snapshot.receipt.walObjectId, old.first.objectId, 31_000);

    const gcPoints: string[] = [];
    const collected = await coordinator.collectAuthorizedServingGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      completedAtMs: 31_001,
      hook: point => { gcPoints.push(point); },
    });
    expect(collected.newlyRetiredObjects).toBe(2);
    expect(gcPoints).toEqual(['tombstones-written', 'gc-index-committed', 'gc-segment-files-removed']);
    await expect(coordinator.collectAuthorizedServingGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      completedAtMs: 31_002,
    })).resolves.toMatchObject({ alreadyRetiredObjects: 2 });
    expect(control.getRetentionEpoch(snapshot.receipt.walObjectId)?.state).toBe('GC_COMPLETE');
    control.close();
    packed.close();
  });

  it('authors a self-bound sequence-zero snapshot on a fresh segment and retires only complete old WalObjects', async () => {
    const path = await root('complete');
    let { packed, control } = openStores(path);
    const old = await oldEpoch(control);
    const snapshot = await commitSnapshot(control, old);
    expect(snapshot.receipt.sequence).toBe(0n);
    expect(snapshot.receipt.objectCount).toBe(1n);
    expect(control.getWalObjectMetadata(snapshot.receipt.walObjectId)?.origin).toBe('SNAPSHOT');
    expect(control.getRetentionEpoch(snapshot.receipt.walObjectId)).toMatchObject({
      state: 'INSTALLED',
      coveredWriterEpoch: 4n,
      newWriterEpoch: 5n,
      compactionFloor: 2n,
    });
    const db = (control as unknown as { database: import('better-sqlite3').Database }).database;
    const checkpoint = db.prepare(`
      SELECT canonical_bytes FROM checkpoints WHERE checkpoint_id = ?
    `).get(snapshot.receipt.checkpointId) as { canonical_bytes: Buffer };
    const tuple = (await import('../../src/protocol/codec.js')).decodeProtocolTuple(
      'AuthorCheckpointV1',
      checkpoint.canonical_bytes,
    );
    expect(Buffer.from(tuple[10]!)).toEqual(Buffer.from(snapshot.receipt.walObjectId));
    expect(tuple[11]).toBe(2n);

    await authorizeGc(control, old, snapshot.receipt.walObjectId);
    const collected = await packed.collectGarbage(old.ids.map(walObjectId), 31_000);
    expect(collected.newlyRetiredObjects).toBe(2);
    expect(collected.physicallyRemovedSegmentIds).toEqual([0]);
    expect(await packed.has(old.first.objectId as never)).toBe(false);
    expect(await packed.has(snapshot.receipt.walObjectId as never)).toBe(true);
    await expect(control.completeRetentionGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      completedAtMs: 31_001,
    })).resolves.toBe('advanced');
    expect(control.getRetentionEpoch(snapshot.receipt.walObjectId)?.state).toBe('GC_COMPLETE');

    control.close();
    packed.close();
    ({ packed, control } = openStores(path));
    expect(await packed.has(old.first.objectId as never)).toBe(false);
    expect(await packed.has(old.second.objectId as never)).toBe(false);
    expect(await packed.has(snapshot.receipt.walObjectId as never)).toBe(true);
    expect(control.getRetentionEpoch(snapshot.receipt.walObjectId)?.state).toBe('GC_COMPLETE');
    expect(await readdir(join(path, 'segments'))).toEqual(['0000000000000001.pack']);
    control.close();
    packed.close();
  });

  it('recovers a crash between snapshot/checkpoint commit and retention-journal install idempotently', async () => {
    const path = await root('snapshot-crash');
    let crashed = false;
    let { packed, control } = openStores(path, point => {
      if (!crashed && point === 'after-retention-snapshot-install') {
        crashed = true;
        throw new Error('simulated snapshot-install crash');
      }
    });
    const old = await oldEpoch(control);
    await expect(commitSnapshot(control, old)).rejects.toThrow('simulated snapshot-install crash');
    const committedSnapshot = control.findWalObjectAtPosition(namespaceId, author.address, 5n, 0n);
    expect(committedSnapshot).not.toBeNull();
    expect(control.getRetentionEpoch(committedSnapshot!.objectId)).toBeNull();
    control.close();
    packed.close();

    ({ packed, control } = openStores(path));
    const retried = await commitSnapshot(control, old);
    expect(retried.receipt.walStatus).toBe('already-committed');
    expect(control.getRetentionEpoch(retried.receipt.walObjectId)?.state).toBe('INSTALLED');
    control.close();
    packed.close();
  });

  it('rolls back receipt/floor/completion transitions and recovers post-commit physical GC safely', async () => {
    const path = await root('transition-crashes');
    let fault: WalControlTransactionPoint | null = null;
    let { packed, control } = openStores(path, point => {
      if (point === fault) throw new Error(`simulated ${point} crash`);
    });
    const old = await oldEpoch(control);
    const snapshot = await commitSnapshot(control, old);
    const membershipId = bytes('membership');
    const receiptA = await custodyReceipt(custodianA, snapshot.receipt.walObjectId, membershipId, 'peer-a');
    fault = 'after-retention-receipt-persist';
    await expect(control.recordRetentionCustodyReceipt(
      encodeProtocolTuple('SnapshotCustodyReceiptV1', receiptA),
      2_000,
    )).rejects.toThrow('simulated');
    expect(control.listRetentionCustodyReceipts(snapshot.receipt.walObjectId)).toHaveLength(0);
    fault = null;
    await authorizeGc(control, old, snapshot.receipt.walObjectId);

    // Rewind only the last transition in a transactionally controlled test seam.
    const db = (control as unknown as { database: import('better-sqlite3').Database }).database;
    db.prepare("DELETE FROM retention_gc_objects WHERE snapshot_object_id = ?").run(snapshot.receipt.walObjectId);
    db.prepare("UPDATE retention_epochs SET state = 'VECTOR_BOUND' WHERE snapshot_object_id = ?")
      .run(snapshot.receipt.walObjectId);
    const verifiedIds = control.listRetentionCustodyReceipts(snapshot.receipt.walObjectId).map(value => value.receiptId);
    fault = 'after-retention-floor-advance';
    await expect(control.markRetentionGcEligible({
      snapshotObjectId: snapshot.receipt.walObjectId,
      verifiedReceiptIds: verifiedIds,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_000,
    })).rejects.toThrow('simulated');
    expect(control.getRetentionEpoch(snapshot.receipt.walObjectId)?.state).toBe('VECTOR_BOUND');
    expect(control.listRetentionGcObjects(snapshot.receipt.walObjectId)).toHaveLength(0);
    fault = null;
    await control.markRetentionGcEligible({
      snapshotObjectId: snapshot.receipt.walObjectId,
      verifiedReceiptIds: verifiedIds,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_000,
    });

    await expect(packed.collectGarbage(old.ids.map(walObjectId), 31_000, point => {
      if (point === 'gc-index-committed') throw new Error('simulated post-index GC crash');
    })).rejects.toThrow('simulated post-index GC crash');
    expect(await packed.has(old.first.objectId as never)).toBe(false);
    control.close();
    packed.close();

    // Recovery removes the now-orphaned physically retired segment and keeps
    // the authenticated snapshot/new epoch authoritative.
    ({ packed, control } = openStores(path, point => {
      if (point === fault) throw new Error(`simulated ${point} crash`);
    }));
    expect(await packed.has(old.first.objectId as never)).toBe(false);
    expect(await packed.has(snapshot.receipt.walObjectId as never)).toBe(true);
    fault = 'after-retention-gc-complete';
    await expect(control.completeRetentionGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      completedAtMs: 31_001,
    })).rejects.toThrow('simulated');
    expect(control.getRetentionEpoch(snapshot.receipt.walObjectId)?.state).toBe('GC_ELIGIBLE');
    fault = null;
    await expect(control.completeRetentionGc({
      snapshotObjectId: snapshot.receipt.walObjectId,
      completedAtMs: 31_001,
    })).resolves.toBe('advanced');
    expect(control.getRetentionEpoch(snapshot.receipt.walObjectId)?.state).toBe('GC_COMPLETE');
    control.close();
    packed.close();
  });
});
