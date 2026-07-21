import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PackedWalObjectStore,
  WalControlStore,
  WalLocalCommitter,
  WAL_V1_ENUMS,
  canonicalizeNQuadsV1,
  encodeProtocolTuple,
  recoverEip191Address,
  signEip191DigestWithPrivateKey,
  signSingleProtocolTuple,
  type ProtocolTuple,
  type WalControlTransactionPoint,
  type WalEip191Signer,
} from '../../src/index.js';
import { walObjectId } from '../../src/reconciliation/ids.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true })));
});

function bytes(label: string, length = 32): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`wal-retention-control-v1\0${label}`).digest().subarray(0, length));
}

function signer(slot: number): WalEip191Signer & { readonly address: Uint8Array } {
  const privateKey = new Uint8Array(32);
  privateKey[31] = slot;
  const digest = new Uint8Array(32);
  const address = recoverEip191Address(digest, signEip191DigestWithPrivateKey(digest, privateKey));
  return { address, signMessage: value => signEip191DigestWithPrivateKey(value, privateKey) };
}

const author = signer(21);
const custodianA = signer(22);
const custodianB = signer(23);
const namespaceId = bytes('namespace');
const collectionId = bytes('collection');

async function makeRoot(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `wal-retention-control-${label}-`));
  roots.push(value);
  return value;
}

async function oldEpoch(control: WalControlStore) {
  const first = await control.commitLocal({
    namespaceId,
    writerId: author.address,
    writerEpoch: 4n,
    payloadBytes: bytes('old-a'),
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
    payloadBytes: bytes('old-b'),
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

async function snapshot(control: WalControlStore, old: Awaited<ReturnType<typeof oldEpoch>>) {
  return new WalLocalCommitter({ control, now: () => 1_000 }).commitSnapshot({
    manifest: manifest(old),
    signer: author,
    idempotencyKey: 'snapshot',
    retentionGraceMs: 30_000,
    createdAtMs: 1_000,
  });
}

async function receipt(
  custodian: WalEip191Signer & { readonly address: Uint8Array },
  snapshotObjectId: Uint8Array,
  membershipId: Uint8Array,
  peer: string,
  nonceLabel: string,
  expiresAtMs = 100_000n,
): Promise<ProtocolTuple<'SnapshotCustodyReceiptV1'>> {
  return signSingleProtocolTuple('SnapshotCustodyReceiptV1', [
    1n,
    snapshotObjectId,
    custodian.address,
    new TextEncoder().encode(peer),
    membershipId,
    1_000n,
    expiresAtMs,
    bytes(nonceLabel, 16),
  ], custodian);
}

describe('WAL retention control-journal fail-closed boundaries', () => {
  it('rejects invalid and conflicting epoch installation including a nonzero self baseline', async () => {
    const path = await makeRoot('install');
    const packed = new PackedWalObjectStore({ root: path });
    const control = new WalControlStore({ root: path, now: () => 1_000 });
    const laneFirst = await control.commitLocal({
      namespaceId,
      writerId: author.address,
      writerEpoch: 20n,
      payloadBytes: bytes('lane-first'),
      signer: author,
      idempotencyKey: 'lane-first',
      requestDigest: bytes('lane-first-request'),
      status: 'COMMITTED',
    });
    await expect(control.commitLocal({
      namespaceId,
      writerId: author.address,
      writerEpoch: 20n,
      payloadBytes: bytes('lane-second'),
      signer: author,
      idempotencyKey: 'lane-second',
      requestDigest: bytes('lane-second-request'),
      status: 'COMMITTED',
      baselineSnapshotObjectId: 'self',
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    expect(laneFirst.sequence).toBe(0n);

    const old = await oldEpoch(control);
    const installed = await snapshot(control, old);
    const base = {
      snapshotObjectId: installed.receipt.walObjectId,
      namespaceId,
      writerId: author.address,
      coveredWriterEpoch: 4n,
      newWriterEpoch: 5n,
      coveredCheckpointId: old.second.checkpointId,
      compactionFloor: 2n,
      graceStartedAtMs: 1_000,
      graceEndsAtMs: 31_000,
      updatedAtMs: 1_000,
    } as const;
    await expect(control.installRetentionEpoch({ ...base, newWriterEpoch: 7n }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.installRetentionEpoch({ ...base, compactionFloor: 0n }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.installRetentionEpoch({ ...base, graceStartedAtMs: 31_001 }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.installRetentionEpoch({ ...base, namespaceId: bytes('other-namespace') }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_IDEMPOTENCY_CONFLICT' });
    await expect(control.installRetentionEpoch({ ...base, snapshotObjectId: bytes('absent-snapshot') }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });

    const ordinary = await control.commitLocal({
      namespaceId,
      writerId: author.address,
      writerEpoch: 6n,
      payloadBytes: bytes('ordinary-epoch-six'),
      signer: author,
      idempotencyKey: 'ordinary-epoch-six',
      requestDigest: bytes('ordinary-epoch-six-request'),
      status: 'COMMITTED',
    });
    await expect(control.installRetentionEpoch({
      ...base,
      snapshotObjectId: ordinary.objectId,
      coveredWriterEpoch: 5n,
      newWriterEpoch: 6n,
      coveredCheckpointId: installed.receipt.checkpointId,
      compactionFloor: 1n,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    control.close();
    packed.close();
  });

  it('rejects malformed, unbound, colliding, or overflowing custody receipts', async () => {
    const path = await makeRoot('receipts');
    const packed = new PackedWalObjectStore({ root: path });
    const control = new WalControlStore({ root: path, now: () => 1_000 });
    const old = await oldEpoch(control);
    const installed = await snapshot(control, old);
    const membershipId = bytes('membership');
    await expect(control.recordRetentionCustodyReceipt(bytes('not-cbor', 8)))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    const overflow = await receipt(
      custodianA,
      installed.receipt.walObjectId,
      membershipId,
      'overflow-peer',
      'overflow-nonce',
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    );
    await expect(control.recordRetentionCustodyReceipt(encodeProtocolTuple('SnapshotCustodyReceiptV1', overflow)))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    const absent = await receipt(custodianA, bytes('absent-snapshot'), membershipId, 'absent-peer', 'absent-nonce');
    await expect(control.recordRetentionCustodyReceipt(encodeProtocolTuple('SnapshotCustodyReceiptV1', absent)))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });

    const good = await receipt(custodianA, installed.receipt.walObjectId, membershipId, 'peer-a', 'nonce-a');
    const goodBytes = encodeProtocolTuple('SnapshotCustodyReceiptV1', good);
    const stored = await control.recordRetentionCustodyReceipt(goodBytes);
    const db = (control as unknown as { database: import('better-sqlite3').Database }).database;
    db.prepare('UPDATE retention_custody_receipts SET canonical_bytes = ? WHERE receipt_id = ?')
      .run(bytes('substituted-receipt-bytes'), stored.receiptId);
    await expect(control.recordRetentionCustodyReceipt(goodBytes))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_IDEMPOTENCY_CONFLICT' });
    db.prepare('UPDATE retention_custody_receipts SET canonical_bytes = ? WHERE receipt_id = ?')
      .run(goodBytes, stored.receiptId);
    const collision = await receipt(custodianA, installed.receipt.walObjectId, membershipId, 'peer-a', 'nonce-b');
    await expect(control.recordRetentionCustodyReceipt(encodeProtocolTuple('SnapshotCustodyReceiptV1', collision)))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_IDEMPOTENCY_CONFLICT' });
    control.close();
    packed.close();
  });

  it('enforces monotonic vector, floor, receipt, object, and physical-GC transitions', async () => {
    const path = await makeRoot('transitions');
    let fault: WalControlTransactionPoint | null = null;
    const packed = new PackedWalObjectStore({ root: path });
    const control = new WalControlStore({
      root: path,
      now: () => 1_000,
      transactionHook: point => {
        if (point === fault) throw new Error(`simulated ${point}`);
      },
    });
    const old = await oldEpoch(control);
    const installed = await snapshot(control, old);
    const snapshotObjectId = installed.receipt.walObjectId;
    const ids32 = [bytes('receipt-a'), bytes('receipt-b')] as const;
    await expect(control.bindRetentionVector({
      snapshotObjectId: bytes('unknown-epoch'), vectorId: bytes('unknown-vector'), updatedAtMs: 2_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.bindRetentionVector({
      snapshotObjectId, vectorId: bytes('unknown-vector'), updatedAtMs: 2_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: ids32,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });

    const vectorA = bytes('vector-a');
    const vectorB = bytes('vector-b');
    for (const [vectorId, number] of [[vectorA, 1n], [vectorB, 2n]] as const) {
      control.putVector({
        vectorId,
        collectionId,
        vectorEpoch: 1n,
        vectorNumber: number,
        canonicalBytes: bytes(`vector-${number}-bytes`),
        status: 'CURRENT',
        expiresAtMs: 200_000,
        createdAtMs: 2_000,
      });
    }
    fault = 'after-retention-vector-bind';
    await expect(control.bindRetentionVector({ snapshotObjectId, vectorId: vectorA, updatedAtMs: 2_000 }))
      .rejects.toThrow('simulated');
    expect(control.getRetentionEpoch(snapshotObjectId)?.state).toBe('INSTALLED');
    fault = null;
    await expect(control.bindRetentionVector({ snapshotObjectId, vectorId: vectorA, updatedAtMs: 2_000 }))
      .resolves.toBe('advanced');
    await expect(control.bindRetentionVector({ snapshotObjectId, vectorId: vectorA, updatedAtMs: 2_001 }))
      .resolves.toBe('unchanged');
    await expect(control.bindRetentionVector({ snapshotObjectId, vectorId: vectorB, updatedAtMs: 2_001 }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_ROLLBACK_REJECTED' });

    const membershipId = bytes('membership');
    const receiptA = await receipt(custodianA, snapshotObjectId, membershipId, 'peer-a', 'nonce-a');
    const receiptB = await receipt(custodianB, snapshotObjectId, membershipId, 'peer-b', 'nonce-b');
    const persisted = await Promise.all([receiptA, receiptB].map(value =>
      control.recordRetentionCustodyReceipt(encodeProtocolTuple('SnapshotCustodyReceiptV1', value), 2_000)));
    const receiptIds = persisted.map(value => value.receiptId);

    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: [receiptIds[0]!, receiptIds[0]!],
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: [old.first.objectId, old.first.objectId],
      evaluatedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId: bytes('unknown-epoch'),
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 30_999,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: [old.first.objectId],
      evaluatedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: [receiptIds[0]!, bytes('missing-receipt')],
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 100_001,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: [old.first.objectId, snapshotObjectId],
      evaluatedAtMs: 31_000,
    })).rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });

    await expect(control.completeRetentionGc({ snapshotObjectId: bytes('unknown-epoch'), completedAtMs: 31_000 }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.completeRetentionGc({ snapshotObjectId, completedAtMs: 31_000 }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_000,
    })).resolves.toBe('advanced');
    await expect(control.markRetentionGcEligible({
      snapshotObjectId,
      verifiedReceiptIds: receiptIds,
      coveredObjectIds: old.ids,
      evaluatedAtMs: 31_001,
    })).resolves.toBe('unchanged');
    await expect(control.completeRetentionGc({ snapshotObjectId, completedAtMs: 31_001 }))
      .rejects.toMatchObject({ code: 'WAL_CONTROL_INVALID_CONFIGURATION' });
    await packed.collectGarbage(old.ids.map(walObjectId), 31_001);
    await expect(control.completeRetentionGc({ snapshotObjectId, completedAtMs: 31_002 }))
      .resolves.toBe('advanced');
    await expect(control.completeRetentionGc({ snapshotObjectId, completedAtMs: 31_003 }))
      .resolves.toBe('unchanged');
    control.close();
    packed.close();
  });
});
