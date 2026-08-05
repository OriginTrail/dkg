import { describe, expect, it } from 'vitest';

import {
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  SwmAuthorInventoryCodecErrorV1,
  assertSignedSwmAuthorInventoryHeadEnvelopeV1,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  computeSwmAuthorInventoryRowsDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryHeadV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
} from '../src/swm-author-inventory-v1.js';
import {
  computeControlObjectDigestHex,
  type UnsignedControlEnvelopeV1,
} from '../src/sync-control-object.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const OTHER_AUTHOR = '0x5555555555555555555555555555555555555555';
const SIGNATURE = `0x${'77'.repeat(65)}`;

const SCOPE = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: 'public-swm-fixture',
  governanceChainId: '20430',
  governanceContractAddress: '0x2222222222222222222222222222222222222222',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
}) as SwmAuthorInventoryScopeV1;

const ROW_A = Object.freeze({
  assertionCoordinate: 'draft-a',
  assertionVersion: '1',
  kaUal: `did:dkg:otp:20430/${AUTHOR}/7`,
  shareOperationId: 'swm-operation-a',
  projectionDigest: `0x${'11'.repeat(32)}`,
  publicTripleCount: '17',
  privateTripleCount: '0',
  sealDigest: `0x${'22'.repeat(32)}`,
  sharedAt: '1700000000000',
  expiresAt: '1700003600000',
}) as SwmAuthorInventoryRowV1;

const ROW_B = Object.freeze({
  assertionCoordinate: 'draft-b',
  assertionVersion: '2',
  kaUal: `did:dkg:otp:20430/${AUTHOR}/8`,
  shareOperationId: 'swm-operation-b',
  projectionDigest: `0x${'33'.repeat(32)}`,
  publicTripleCount: '29',
  privateTripleCount: '3',
  sealDigest: `0x${'44'.repeat(32)}`,
  sharedAt: '1700000000100',
  expiresAt: null,
}) as SwmAuthorInventoryRowV1;

function signedHead(
  rows: readonly SwmAuthorInventoryRowV1[],
  overrides: Partial<SwmAuthorInventoryHeadV1> = {},
  issuer = AUTHOR,
): SignedSwmAuthorInventoryHeadEnvelopeV1 {
  const payload = Object.freeze({
    ...SCOPE,
    version: '0',
    previousHeadDigest: null,
    totalRows: rows.length.toString(),
    rowsDigest: computeSwmAuthorInventoryRowsDigestV1(rows),
    issuedAt: '1700000000200',
    ...overrides,
  }) as SwmAuthorInventoryHeadV1;
  const unsigned = Object.freeze({
    issuer,
    objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedControlEnvelopeV1;
  return Object.freeze({
    ...unsigned,
    objectDigest: computeControlObjectDigestHex(unsigned),
    signature: SIGNATURE,
  }) as SignedSwmAuthorInventoryHeadEnvelopeV1;
}

describe('SWM author inventory v1', () => {
  it('commits a domain-separated signed head to one canonical exact row set', () => {
    const rows = Object.freeze([ROW_A, ROW_B]);
    const head = signedHead(rows);
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({ head, rows })).not.toThrow();
    expect(computeSwmAuthorInventoryScopeDigestV1(SCOPE)).toBe(
      '0xa800a7ca2211c3b9c7061d088ccbbcab26c6043a87e2c0f96e3526154c2a015d',
    );
    expect(head.payload.rowsDigest).toBe(
      '0xeb09f41f4283d16eb30c23412979bad975e59fb04e8eccd07335c46303d0269e',
    );
    expect(head.objectDigest).toBe(
      '0xfe169b0aae3336138b32cd368c5ff33a1ccb30f3147085a80f29cba017fa0c7a',
    );
    expect(new TextDecoder().decode(canonicalizeSwmAuthorInventoryRowsBytesV1(rows)))
      .toBe(new TextDecoder().decode(canonicalizeSwmAuthorInventoryRowsBytesV1(
        parseCanonicalSwmAuthorInventoryRowsV1(
          canonicalizeSwmAuthorInventoryRowsBytesV1(rows),
        ),
      )));
    expect(parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1(
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(head),
    )).toEqual(head);
  });

  it('rejects row reordering and duplicate active identities', () => {
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([ROW_B, ROW_A]))
      .toThrow(/strictly ordered/);
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([
      ROW_A,
      { ...ROW_A, assertionCoordinate: 'different', shareOperationId: 'different' },
    ] as SwmAuthorInventoryRowV1[])).toThrow(/duplicate/);
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([
      ROW_A,
      { ...ROW_B, shareOperationId: ROW_A.shareOperationId },
    ] as SwmAuthorInventoryRowV1[])).toThrow(/shareOperationId must be unique/);
  });

  it('rejects count, digest, author, and temporal binding failures', () => {
    const rows = Object.freeze([ROW_A, ROW_B]);
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({
      head: signedHead(rows, { totalRows: '1' }),
      rows,
    })).toThrow(/totalRows/);
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({
      head: signedHead(rows, { rowsDigest: `0x${'99'.repeat(32)}` }),
      rows,
    })).toThrow(/rowsDigest/);
    const foreignRow = Object.freeze({
      ...ROW_A,
      kaUal: `did:dkg:otp:20430/${OTHER_AUTHOR}/7`,
    }) as SwmAuthorInventoryRowV1;
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({
      head: signedHead([foreignRow]),
      rows: [foreignRow],
    })).toThrow(/row kaUal author/);
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({
      head: signedHead([ROW_A], { issuedAt: '1699999999999' }),
      rows: [ROW_A],
    })).toThrow(/sharedAt/);
  });

  it('keeps SWM authority distinct and chains every non-genesis head', () => {
    const rows = [ROW_A];
    const head = signedHead(rows);
    expect(head.objectType).toBe('SwmAuthorInventoryHeadV1');
    expect(() => assertSignedSwmAuthorInventoryHeadEnvelopeV1(
      signedHead(rows, {}, OTHER_AUTHOR),
    )).toThrow(/issuer must equal/);
    expect(() => assertSignedSwmAuthorInventoryHeadEnvelopeV1(
      signedHead(rows, { version: '1', previousHeadDigest: null }),
    ))
      .toThrowError(SwmAuthorInventoryCodecErrorV1);
    expect(() => assertSignedSwmAuthorInventoryHeadEnvelopeV1(signedHead(rows, {
      version: '0',
      previousHeadDigest: `0x${'55'.repeat(32)}`,
    }))).toThrow(/only version 0/);
  });

  it('rejects noncanonical wire JSON and invalid expiry', () => {
    const canonical = canonicalizeSwmAuthorInventoryRowsBytesV1([ROW_A]);
    expect(() => parseCanonicalSwmAuthorInventoryRowsV1(
      ` ${new TextDecoder().decode(canonical)}`,
    )).toThrow(/canonical/);
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([{
      ...ROW_A,
      expiresAt: ROW_A.sharedAt,
    } as SwmAuthorInventoryRowV1])).toThrow(/expiresAt must be later/);
  });
});
