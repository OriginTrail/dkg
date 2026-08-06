import {
  assertCanonicalDigest,
  assertSwmAuthorInventorySnapshotBindingV1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  canonicalizeSwmAuthorInventoryRowsBytesV1,
  computeControlSignatureVariantDigestHex,
  parseCanonicalSignedSwmAuthorInventoryHeadEnvelopeV1,
  parseCanonicalSwmAuthorInventoryRowsV1,
  type Digest32V1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';
import {
  assertVerifiedControlEnvelopeIssuerSignatureV1,
  readVerifiedControlEnvelopeIssuerSignatureV1,
  verifyEip191ControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

import {
  isSwmAuthorInventoryErrorV1,
  type CompareAndSwapSwmAuthorInventoryInputV1,
  type SwmAuthorInventoryErrorFactoryV1,
  type SwmAuthorInventoryMutationV1,
} from './swm-author-inventory-contracts.js';
import {
  assertExactFieldSetV1,
  snapshotExactPlainDataRecordV1,
  snapshotPlainDataRecordV1,
} from './exact-record.js';
import { snapshotSwmAuthorInventoryMutationV1 } from './swm-author-inventory-mutation.js';

/**
 * Canonical, authenticated CAS input. The required verifier-issued proof makes
 * the EIP-191/EIP-1271 admission invariant explicit before SQL planning begins.
 */
export interface VerifiedSwmAuthorInventoryCommitInputV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  readonly mutation: SwmAuthorInventoryMutationV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  readonly expectedCurrentHeadDigest: Digest32V1 | null;
}

/** Observe hostile input once, canonicalize it, and authenticate the exact head. */
export function prepareVerifiedSwmAuthorInventoryCommitInputV1(
  input: CompareAndSwapSwmAuthorInventoryInputV1,
  error: SwmAuthorInventoryErrorFactoryV1,
): VerifiedSwmAuthorInventoryCommitInputV1 {
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
      canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(candidateSnapshot.head),
    );
    const rows = parseCanonicalSwmAuthorInventoryRowsV1(
      canonicalizeSwmAuthorInventoryRowsBytesV1(candidateSnapshot.rows),
    );
    const snapshot = Object.freeze({ head, rows });
    assertSwmAuthorInventorySnapshotBindingV1(snapshot);

    let issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
    if (hasIssuerSignature) {
      assertVerifiedControlEnvelopeIssuerSignatureV1(candidate.issuerSignature);
      issuerSignature = candidate.issuerSignature;
    } else {
      issuerSignature = verifyEip191ControlEnvelopeIssuerSignatureV1(head);
    }
    const issuerSignatureProof = readVerifiedControlEnvelopeIssuerSignatureV1(
      issuerSignature,
    );
    if (
      issuerSignatureProof.objectDigest !== head.objectDigest
      || issuerSignatureProof.signatureVariantDigest
        !== computeControlSignatureVariantDigestHex(head.objectDigest, head.signature)
      || issuerSignatureProof.issuer !== head.issuer
      || issuerSignatureProof.signatureSuite !== head.signatureSuite
    ) {
      throw new Error('issuer signature proof is not bound to the exact SWM inventory head');
    }
    if (candidate.expectedCurrentHeadDigest !== null) {
      assertCanonicalDigest(
        candidate.expectedCurrentHeadDigest,
        'expectedCurrentHeadDigest',
      );
    }

    return Object.freeze({
      snapshot,
      mutation: snapshotSwmAuthorInventoryMutationV1(candidate.mutation),
      issuerSignature,
      expectedCurrentHeadDigest: candidate.expectedCurrentHeadDigest,
    });
  } catch (cause) {
    if (isSwmAuthorInventoryErrorV1(cause)) throw cause;
    throw error(
      'swm-inventory-input',
      'SWM author inventory CAS input is not canonical, authenticated, or internally bound',
      { cause },
    );
  }
}
