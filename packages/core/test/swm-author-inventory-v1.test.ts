import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MAX_SWM_AUTHOR_INVENTORY_ROWS_V1,
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  SwmAuthorInventoryCodecErrorV1,
  assertSignedSwmAuthorInventoryHeadEnvelopeV1,
  assertSwmAuthorInventoryShareOperationIdV1,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  canonicalizeUnsignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  computeSwmAuthorInventoryHeadObjectDigestV1,
  computeSwmAuthorInventoryRowsDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryHeadV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventoryShareOperationIdV1,
  type UnsignedSwmAuthorInventoryHeadEnvelopeV1,
} from '../src/swm-author-inventory-v1.js';
import {
  MAX_SEAL_TRIPLE_COUNT_V1,
} from '../src/canonical-graph-scoped-author-seal.js';
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
  }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
  return Object.freeze({
    ...unsigned,
    objectDigest: computeSwmAuthorInventoryHeadObjectDigestV1(unsigned),
    signature: SIGNATURE,
  }) as SignedSwmAuthorInventoryHeadEnvelopeV1;
}

describe('SWM author inventory v1', () => {
  it('brands only canonical bounded share operation ids', () => {
    const candidate: unknown = 'swm-operation-typed';
    assertSwmAuthorInventoryShareOperationIdV1(candidate);
    expectTypeOf(candidate).toEqualTypeOf<SwmAuthorInventoryShareOperationIdV1>();
    expect(candidate).toBe('swm-operation-typed');
    expect(() => assertSwmAuthorInventoryShareOperationIdV1('bad\u0000operation'))
      .toThrow(/forbidden control character/);
  });

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
    expect(canonicalizeUnsignedSwmAuthorInventoryHeadEnvelopeBytesV1({
      issuer: head.issuer,
      objectType: head.objectType,
      payload: head.payload,
      signatureEvidence: head.signatureEvidence,
      signatureSuite: head.signatureSuite,
    })).toBeInstanceOf(Uint8Array);
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

  it('orders canonical KA identities by their numeric uint96 asset number', () => {
    const row2 = Object.freeze({
      ...ROW_A,
      kaUal: `did:dkg:otp:20430/${AUTHOR}/2`,
      shareOperationId: 'swm-operation-2',
    }) as SwmAuthorInventoryRowV1;
    const row10 = Object.freeze({
      ...ROW_B,
      kaUal: `did:dkg:otp:20430/${AUTHOR}/10`,
      shareOperationId: 'swm-operation-10',
    }) as SwmAuthorInventoryRowV1;

    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([row2, row10])).not.toThrow();
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([row10, row2]))
      .toThrow(/strictly ordered/);
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
    const foreignNetworkRow = Object.freeze({
      ...ROW_A,
      kaUal: `did:dkg:base:8453/${AUTHOR}/7`,
    }) as SwmAuthorInventoryRowV1;
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({
      head: signedHead([foreignNetworkRow]),
      rows: [foreignNetworkRow],
    })).toThrow(/row kaUal network/);
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({
      head: signedHead([ROW_A], { issuedAt: '1699999999999' }),
      rows: [ROW_A],
    })).toThrow(/sharedAt/);
    const expiredRow = Object.freeze({
      ...ROW_A,
      expiresAt: '1700000000100',
    }) as SwmAuthorInventoryRowV1;
    expect(() => assertSwmAuthorInventorySnapshotBindingV1({
      head: signedHead([expiredRow]),
      rows: [expiredRow],
    })).toThrow(/expiresAt/);
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
    const valid = signedHead(rows);
    const wrongTypeUnsigned = Object.freeze({
      issuer: valid.issuer,
      objectType: 'AuthorCatalogHeadV1',
      payload: valid.payload,
      signatureEvidence: valid.signatureEvidence,
      signatureSuite: valid.signatureSuite,
    }) as UnsignedControlEnvelopeV1;
    expect(() => assertSignedSwmAuthorInventoryHeadEnvelopeV1(Object.freeze({
      ...wrongTypeUnsigned,
      objectDigest: computeControlObjectDigestHex(wrongTypeUnsigned),
      signature: SIGNATURE,
    }))).toThrow(/wrong objectType/);
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

  it('keeps row counts within canonical author-seal bounds', () => {
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([{
      ...ROW_A,
      publicTripleCount: '0',
      privateTripleCount: '0',
    } as SwmAuthorInventoryRowV1])).toThrow(/at least one triple/);
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([{
      ...ROW_A,
      publicTripleCount: (MAX_SEAL_TRIPLE_COUNT_V1 + 1n).toString(),
    } as SwmAuthorInventoryRowV1])).toThrow(/canonical author seal bounds/);
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([{
      ...ROW_A,
      privateTripleCount: (MAX_SEAL_TRIPLE_COUNT_V1 + 1n).toString(),
    } as SwmAuthorInventoryRowV1])).toThrow(/canonical author seal bounds/);
  });

  it('rejects signed heads whose declared row count exceeds the protocol cap', () => {
    expect(() => assertSignedSwmAuthorInventoryHeadEnvelopeV1(
      signedHead([ROW_A], {
        totalRows: (MAX_SWM_AUTHOR_INVENTORY_ROWS_V1 + 1).toString(),
      }),
    )).toThrow(/totalRows must not exceed/);
    expect(() => assertSignedSwmAuthorInventoryHeadEnvelopeV1(
      signedHead([ROW_A], {
        totalRows: MAX_SWM_AUTHOR_INVENTORY_ROWS_V1.toString(),
      }),
    )).not.toThrow();
  });

  it('enforces SWM-specific row, scalar, and signed-head size limits', () => {
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1(
      new Array(MAX_SWM_AUTHOR_INVENTORY_ROWS_V1 + 1) as SwmAuthorInventoryRowV1[],
    )).toThrowError(expect.objectContaining({ code: 'swm-inventory-too-large' }));
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([{
      ...ROW_A,
      shareOperationId: 'x'.repeat(257),
    } as SwmAuthorInventoryRowV1])).toThrow(/byte limit/);
    expect(() => canonicalizeSwmAuthorInventoryRowsBytesV1([{
      ...ROW_A,
      kaUal: `did:dkg:otp:20430/${AUTHOR}/${'9'.repeat(1_000_000)}`,
    } as SwmAuthorInventoryRowV1])).toThrowError(expect.objectContaining({
      code: 'swm-inventory-scalar',
    }));

    const payload = signedHead([ROW_A]).payload;
    const oversizedUnsigned = Object.freeze({
      issuer: AUTHOR,
      objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
      payload,
      signatureEvidence: Object.freeze({
        kind: 'eip1271-current-finalized',
        chainId: '20430',
        contractAddress: AUTHOR,
      }),
      signatureSuite: 'eip1271-current-finalized-v1',
    }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
    expect(() => canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1({
      ...oversizedUnsigned,
      objectDigest: computeSwmAuthorInventoryHeadObjectDigestV1(oversizedUnsigned),
      signature: `0x${'77'.repeat(4096)}`,
    } as SignedSwmAuthorInventoryHeadEnvelopeV1)).toThrowError(
      expect.objectContaining({ code: 'swm-inventory-too-large' }),
    );
  });
});
