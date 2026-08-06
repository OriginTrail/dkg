import {
  assertCanonicalDigest,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  computeControlSignatureVariantDigestHex,
  computeSwmAuthorInventoryScopeDigestV1,
  deriveSwmAuthorInventoryScopeFromHeadV1,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type EvmAddressV1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';
import {
  readVerifiedControlEnvelopeIssuerSignatureV1,
  verifyEip191ControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  isSwmAuthorInventoryErrorV1,
  type CompareAndSwapSwmAuthorInventoryInputV1,
  type SwmAuthorInventoryErrorCodeV1,
  type SwmAuthorInventoryMutationV1,
} from './swm-author-inventory-contracts.js';
import {
  assertExactFieldSetV1,
  snapshotExactPlainDataRecordV1,
  snapshotPlainDataRecordV1,
} from './exact-record.js';
import {
  digest32ToSqlBlobV1,
  evmAddressToSqlBlobV1,
} from './scalars.js';
import {
  snapshotSwmAuthorInventoryMutationV1,
} from './swm-author-inventory-mutation.js';

export type SwmAuthorInventoryErrorFactoryV1 = (
  code: SwmAuthorInventoryErrorCodeV1,
  message: string,
  options?: ErrorOptions,
) => Error;

export interface EncodedSwmAuthorInventoryKeyV1 {
  readonly scope: Uint8Array;
  readonly author: Uint8Array;
}

/** Immutable plan observed once at the caller boundary and reused through recovery. */
export interface PreparedSwmAuthorInventoryCommitV1
  extends EncodedSwmAuthorInventoryKeyV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  readonly mutation: SwmAuthorInventoryMutationV1;
  readonly mutationKind: SwmAuthorInventoryMutationV1['kind'];
  readonly mutationKaUal: string;
  readonly expectedHead: Uint8Array | null;
  readonly signedHeadEnvelope: Uint8Array;
}

export function encodeSwmAuthorInventoryKeyV1(
  inventoryScopeDigest: unknown,
  authorAddress: unknown,
  error: SwmAuthorInventoryErrorFactoryV1,
): EncodedSwmAuthorInventoryKeyV1 {
  try {
    assertCanonicalDigest(inventoryScopeDigest, 'inventoryScopeDigest');
    return Object.freeze({
      scope: digest32ToSqlBlobV1(inventoryScopeDigest),
      author: evmAddressToSqlBlobV1(authorAddress as EvmAddressV1),
    });
  } catch (cause) {
    throw error('swm-inventory-input', 'SWM author inventory key is not canonical', { cause });
  }
}

export function prepareSwmAuthorInventoryCommitV1(
  input: CompareAndSwapSwmAuthorInventoryInputV1,
  error: SwmAuthorInventoryErrorFactoryV1,
): PreparedSwmAuthorInventoryCommitV1 {
  try {
    const candidateRecord = snapshotPlainDataRecordV1(input, 'SWM author inventory CAS input');
    const hasIssuerSignature = Object.keys(candidateRecord).includes('issuerSignature');
    assertExactFieldSetV1(
      candidateRecord,
      hasIssuerSignature
        ? ['snapshot', 'mutation', 'issuerSignature', 'expectedCurrentHeadDigest']
        : ['snapshot', 'mutation', 'expectedCurrentHeadDigest'],
      'SWM author inventory CAS input',
    );
    const candidate = candidateRecord as unknown as Readonly<
      CompareAndSwapSwmAuthorInventoryInputV1
    >;
    const candidateSnapshot = snapshotExactPlainDataRecordV1(
      candidate.snapshot,
      ['head', 'rows'],
      'SWM author inventory snapshot',
    );
    const head = parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1(
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(
        candidateSnapshot.head,
      ),
    );
    const rows = parseCanonicalSwmAuthorInventoryRowsV1(
      canonicalizeSwmAuthorInventoryRowsBytesV1(
        candidateSnapshot.rows,
      ),
    );
    const snapshot = Object.freeze({ head, rows });
    assertSwmAuthorInventorySnapshotBindingV1(snapshot);
    const issuerSignature = readVerifiedControlEnvelopeIssuerSignatureV1(
      hasIssuerSignature
        ? candidate.issuerSignature
        : verifyEip191ControlEnvelopeIssuerSignatureV1(head),
    );
    if (
      issuerSignature.objectDigest !== head.objectDigest
      || issuerSignature.signatureVariantDigest
        !== computeControlSignatureVariantDigestHex(head.objectDigest, head.signature)
      || issuerSignature.issuer !== head.issuer
      || issuerSignature.signatureSuite !== head.signatureSuite
    ) {
      throw new Error('issuer signature proof is not bound to the exact SWM inventory head');
    }
    const scope = deriveSwmAuthorInventoryScopeFromHeadV1(head.payload);
    const key = encodeSwmAuthorInventoryKeyV1(
      computeSwmAuthorInventoryScopeDigestV1(scope),
      head.payload.authorAddress,
      error,
    );
    let expectedHead: Uint8Array | null = null;
    if (candidate.expectedCurrentHeadDigest !== null) {
      assertCanonicalDigest(candidate.expectedCurrentHeadDigest, 'expectedCurrentHeadDigest');
      expectedHead = digest32ToSqlBlobV1(candidate.expectedCurrentHeadDigest);
    }
    const mutation = snapshotSwmAuthorInventoryMutationV1(candidate.mutation);
    return Object.freeze({
      ...key,
      snapshot,
      mutation,
      mutationKind: mutation.kind,
      mutationKaUal: mutation.kind === 'upsert' ? mutation.row.kaUal : mutation.kaUal,
      expectedHead,
      signedHeadEnvelope: canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(head),
    });
  } catch (cause) {
    if (isSwmAuthorInventoryErrorV1(cause)) throw cause;
    throw error(
      'swm-inventory-input',
      'SWM author inventory CAS input is not canonical or internally bound',
      { cause },
    );
  }
}
