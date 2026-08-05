import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  computeSwmAuthorInventoryHeadObjectDigestV1,
  computeSwmAuthorInventoryRowsDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryHeadV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type UnsignedSwmAuthorInventoryHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  INVENTORY_V1_DIRECTORY_MODE,
  INVENTORY_V1_FILE_MODE,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_VERSION,
  INVENTORY_V1_V2_USER_VERSION,
  openInventoryV1,
  type Rfc64InventoryV1Foundation,
} from '../src/rfc64/inventory-v1/index.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const SIGNATURE = `0x${'77'.repeat(65)}`;
const SCOPE = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: 'public-swm-persistence-fixture',
  governanceChainId: '20430',
  governanceContractAddress: '0x2222222222222222222222222222222222222222',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
}) as SwmAuthorInventoryScopeV1;
const SCOPE_DIGEST = computeSwmAuthorInventoryScopeDigestV1(SCOPE);

const ROW_A = row('7', 'draft-a', 'share-a', '11', '22');
const ROW_B = row('8', 'draft-b', 'share-b', '33', '44');
const directories: string[] = [];
const foundations: Rfc64InventoryV1Foundation[] = [];

afterEach(() => {
  for (const foundation of foundations.splice(0)) foundation.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 restart-safe SWM author inventory persistence', () => {
  it('atomically initializes, advances, removes, rejects stale writers, and survives restart', async () => {
    const directory = temporaryDirectory();
    let inventory = await openInventoryV1(directory);
    foundations.push(inventory);

    const genesis = snapshot([ROW_A]);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    })).toEqual({ status: 'applied', snapshot: genesis });
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    }).status).toBe('existing');

    const successor = snapshot([ROW_A, ROW_B], genesis);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: successor,
      mutation: { kind: 'upsert', row: ROW_B },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    }).status).toBe('applied');
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: snapshot([ROW_A], genesis),
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-cas-conflict' }));

    const afterRemoval = snapshot([ROW_A], successor);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: afterRemoval,
      mutation: { kind: 'remove', kaUal: ROW_B.kaUal },
      expectedCurrentHeadDigest: successor.head.objectDigest as `0x${string}`,
    }).status).toBe('applied');

    inventory.close();
    foundations.splice(foundations.indexOf(inventory), 1);
    inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toEqual(
      afterRemoval,
    );
  });

  it('rejects a signed head whose exact rows are not the requested one-row mutation', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const wrong = snapshot([ROW_A, ROW_B]);
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: wrong,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toBeNull();
  });

  it('migrates an exact v2 inventory before committing SWM shadow state', async () => {
    const directory = temporaryDirectory();
    const initialized = await openInventoryV1(directory);
    initialized.close();
    const path = join(directory, INVENTORY_V1_RELATIVE_PATH);
    const v2 = new DatabaseSync(path);
    v2.exec(`
      PRAGMA journal_mode = DELETE;
      DROP TABLE rfc64_swm_author_inventory_rows_v1;
      DROP TABLE rfc64_swm_author_inventory_heads_v1;
      PRAGMA user_version = ${INVENTORY_V1_V2_USER_VERSION};
    `);
    v2.close();
    chmodSync(dirname(path), INVENTORY_V1_DIRECTORY_MODE);
    chmodSync(path, INVENTORY_V1_FILE_MODE);

    const migrated = await openInventoryV1(directory);
    foundations.push(migrated);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(database.prepare('PRAGMA user_version').get()?.user_version)
        .toBe(INVENTORY_V1_USER_VERSION);
      expect(database.prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'rfc64_swm_author_inventory_%_v1'",
      ).get()?.count).toBe(2);
    } finally {
      database.close();
    }
    const genesis = snapshot([ROW_A]);
    expect(migrated.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    }).status).toBe('applied');
  });

  it('stores the exact canonical signed head bytes rather than a mutable caller object', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const genesis = snapshot([ROW_A]);
    const expectedBytes = canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(genesis.head);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });
    const read = inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)!;
    expect(canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(read.head))
      .toEqual(expectedBytes);
    expect(Object.isFrozen(read.rows)).toBe(true);
  });

  it('rejects accessor-backed CAS fields without invoking them', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    let reads = 0;
    const hostile = {
      get snapshot() {
        reads += 1;
        return snapshot([ROW_A]);
      },
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    };
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1(
      hostile as unknown as Parameters<
        typeof inventory.compareAndSwapSwmAuthorInventoryV1
      >[0],
    )).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
    expect(reads).toBe(0);
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toBeNull();
  });

  it('fails closed when durable rows no longer match the signed head', async () => {
    const directory = temporaryDirectory();
    const inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    const genesis = snapshot([ROW_A]);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });

    const database = new DatabaseSync(join(directory, INVENTORY_V1_RELATIVE_PATH));
    try {
      database.exec(`
        UPDATE rfc64_swm_author_inventory_rows_v1
        SET projection_digest = zeroblob(32);
      `);
    } finally {
      database.close();
    }

    expect(() => inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR))
      .toThrowError(expect.objectContaining({ code: 'swm-inventory-database-corrupt' }));
  });
});

function row(
  kaNumber: string,
  assertionCoordinate: string,
  shareOperationId: string,
  projectionByte: string,
  sealByte: string,
): SwmAuthorInventoryRowV1 {
  return Object.freeze({
    assertionCoordinate,
    assertionVersion: '1',
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${kaNumber}`,
    shareOperationId,
    projectionDigest: `0x${projectionByte.repeat(32)}`,
    publicTripleCount: '17',
    privateTripleCount: '0',
    sealDigest: `0x${sealByte.repeat(32)}`,
    sharedAt: '1700000000000',
    expiresAt: null,
  }) as SwmAuthorInventoryRowV1;
}

function snapshot(
  rows: readonly SwmAuthorInventoryRowV1[],
  previous?: SwmAuthorInventorySnapshotV1,
): SwmAuthorInventorySnapshotV1 {
  const version = previous === undefined ? '0' : (BigInt(previous.head.payload.version) + 1n).toString();
  const payload = Object.freeze({
    ...SCOPE,
    version,
    previousHeadDigest: previous?.head.objectDigest ?? null,
    totalRows: rows.length.toString(),
    rowsDigest: computeSwmAuthorInventoryRowsDigestV1(rows),
    issuedAt: '1700000000200',
  }) as SwmAuthorInventoryHeadV1;
  const unsigned = Object.freeze({
    issuer: AUTHOR,
    objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
  const head = Object.freeze({
    ...unsigned,
    objectDigest: computeSwmAuthorInventoryHeadObjectDigestV1(unsigned),
    signature: SIGNATURE,
  }) as SignedSwmAuthorInventoryHeadEnvelopeV1;
  return Object.freeze({ head, rows: Object.freeze([...rows]) });
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-swm-inventory-')));
  directories.push(directory);
  return directory;
}
