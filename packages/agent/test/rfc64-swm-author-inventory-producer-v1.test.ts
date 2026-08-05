import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';

import {
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  computeSwmAuthorInventoryHeadObjectDigestV1,
  computeSwmAuthorInventoryRowsDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  type EvmAddressV1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryHeadV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type TimestampMsV1,
  type UnsignedSwmAuthorInventoryHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  InventoryV1CandidateError,
  openInventoryV1,
  type Rfc64InventoryV1Foundation,
  type Rfc64InventoryV1OperationsV1,
} from '../src/rfc64/inventory-v1/index.js';
import {
  maintainRfc64SwmAuthorInventoryV1,
  removeRfc64SwmAuthorInventoryRowV1,
  type MaintainRfc64SwmAuthorInventoryInputV1,
} from '../src/rfc64/swm-author-inventory-producer-v1.js';

const PRIVATE_KEY = `0x${'31'.repeat(32)}`;
const OTHER_PRIVATE_KEY = `0x${'42'.repeat(32)}`;
const wallet = new ethers.Wallet(PRIVATE_KEY);
const otherWallet = new ethers.Wallet(OTHER_PRIVATE_KEY);
const AUTHOR = wallet.address.toLowerCase() as EvmAddressV1;
const SCOPE = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: 'public-swm-producer-fixture',
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

describe('RFC-64 SWM author inventory producer', () => {
  it('signs genesis and successor heads, preserves both rows, and makes replay a no-op', async () => {
    const inventory = await createInventory();
    const first = await maintainRfc64SwmAuthorInventoryV1(inventory, input(ROW_A));
    expect(first.status).toBe('applied');
    expect(first.snapshot.head.payload).toMatchObject({ version: '0', totalRows: '1' });
    await expect(verifyControlEnvelopeIssuerSignatureV1(first.snapshot.head)).resolves.toBeDefined();

    const second = await maintainRfc64SwmAuthorInventoryV1(inventory, input(ROW_B));
    expect(second.snapshot.head.payload).toMatchObject({
      version: '1',
      previousHeadDigest: first.snapshot.head.objectDigest,
      totalRows: '2',
    });
    expect(second.snapshot.rows.map(({ kaUal }) => kaUal)).toEqual([
      ROW_A.kaUal,
      ROW_B.kaUal,
    ]);

    const replay = await maintainRfc64SwmAuthorInventoryV1(inventory, input(ROW_B));
    expect(replay).toMatchObject({
      status: 'existing',
      attempts: 1,
      snapshot: { head: { objectDigest: second.snapshot.head.objectDigest } },
    });
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)?.head.payload.version)
      .toBe('1');
  });

  it('re-reads and retries a bounded CAS conflict without losing the prior row', async () => {
    const inventory = await createInventory();
    await maintainRfc64SwmAuthorInventoryV1(inventory, input(ROW_A));
    let conflicts = 1;
    const conflictOnce: Pick<
      Rfc64InventoryV1OperationsV1,
      'readSwmAuthorInventorySnapshotV1' | 'compareAndSwapSwmAuthorInventoryV1'
    > = {
      readSwmAuthorInventorySnapshotV1:
        inventory.readSwmAuthorInventorySnapshotV1.bind(inventory),
      compareAndSwapSwmAuthorInventoryV1: (candidate) => {
        if (conflicts-- > 0) {
          throw new InventoryV1CandidateError(
            'swm-inventory-cas-conflict',
            'injected concurrent writer',
          );
        }
        return inventory.compareAndSwapSwmAuthorInventoryV1(candidate);
      },
    };

    const result = await maintainRfc64SwmAuthorInventoryV1(
      conflictOnce,
      input(ROW_B),
    );
    expect(result.attempts).toBe(2);
    expect(result.snapshot.rows).toEqual([ROW_A, ROW_B]);
  });

  it('removes a VM-confirmed row and makes duplicate confirmation idempotent', async () => {
    const inventory = await createInventory();
    await maintainRfc64SwmAuthorInventoryV1(inventory, input(ROW_A));
    await maintainRfc64SwmAuthorInventoryV1(inventory, input(ROW_B));
    const removal = await removeRfc64SwmAuthorInventoryRowV1(inventory, {
      scope: SCOPE,
      kaUal: ROW_A.kaUal,
      issuedAt: '1700000000300' as TimestampMsV1,
      signer: input(ROW_A).signer,
    });
    expect(removal.status).toBe('applied');
    expect(removal.snapshot?.rows).toEqual([ROW_B]);
    expect(removal.snapshot?.head.payload.version).toBe('2');

    const replay = await removeRfc64SwmAuthorInventoryRowV1(inventory, {
      scope: SCOPE,
      kaUal: ROW_A.kaUal,
      issuedAt: '1700000000300' as TimestampMsV1,
      signer: input(ROW_A).signer,
    });
    expect(replay).toMatchObject({ status: 'absent', attempts: 1 });
    expect(replay.snapshot?.head.objectDigest).toBe(removal.snapshot?.head.objectDigest);
  });

  it('rejects a signer that cannot recover to the scoped author before persistence', async () => {
    const inventory = await createInventory();
    await expect(maintainRfc64SwmAuthorInventoryV1(inventory, {
      ...input(ROW_A),
      signer: {
        issuer: AUTHOR,
        signDigest: (digest) => otherWallet.signMessage(digest),
      },
    })).rejects.toMatchObject({ code: 'swm-inventory-producer-signer' });
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toBeNull();
  });

  it('refuses to extend persisted history whose signature does not recover to the author', async () => {
    const inventory = await createInventory();
    const payload = Object.freeze({
      ...SCOPE,
      version: '0',
      previousHeadDigest: null,
      totalRows: '1',
      rowsDigest: computeSwmAuthorInventoryRowsDigestV1([ROW_A]),
      issuedAt: '1700000000200',
    }) as SwmAuthorInventoryHeadV1;
    const unsigned = Object.freeze({
      issuer: AUTHOR,
      objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
      payload,
      signatureEvidence: Object.freeze({ kind: 'none' }),
      signatureSuite: 'eip191-personal-sign-digest-v1',
    }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
    const invalidHead = Object.freeze({
      ...unsigned,
      objectDigest: computeSwmAuthorInventoryHeadObjectDigestV1(unsigned),
      signature: `0x${'77'.repeat(65)}`,
    }) as SignedSwmAuthorInventoryHeadEnvelopeV1;
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: Object.freeze({ head: invalidHead, rows: Object.freeze([ROW_A]) }),
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });

    await expect(maintainRfc64SwmAuthorInventoryV1(inventory, input(ROW_B)))
      .rejects.toMatchObject({ code: 'swm-inventory-producer-history' });
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)?.rows)
      .toEqual([ROW_A]);
  });
});

function input(rowValue: SwmAuthorInventoryRowV1): MaintainRfc64SwmAuthorInventoryInputV1 {
  return {
    scope: SCOPE,
    row: rowValue,
    issuedAt: '1700000000200' as TimestampMsV1,
    signer: {
      issuer: AUTHOR,
      signDigest: (digest) => wallet.signMessage(digest),
    },
  };
}

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

async function createInventory(): Promise<Rfc64InventoryV1Foundation> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-swm-producer-')));
  directories.push(directory);
  const inventory = await openInventoryV1(directory);
  foundations.push(inventory);
  return inventory;
}
