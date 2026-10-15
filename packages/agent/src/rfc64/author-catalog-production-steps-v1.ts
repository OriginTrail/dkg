// SPDX-License-Identifier: Apache-2.0

/**
 * Signing and snapshot steps shared by the author catalog producers: the sparse successor
 * producer (`author-catalog-producer.ts`) and the capacity transition producer
 * (`author-catalog-capacity-transition-v1.ts`). Internal to the package; the producer module
 * re-exports the production error.
 */
import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_FANOUT_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  MAX_DECIMAL_U64,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  parseCanonicalAuthorCatalogBucketPayloadV1,
  parseCanonicalAuthorCatalogRowV1,
  parseCanonicalSignedAuthorCatalogBucketEnvelopeV1,
  parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogBucketV1,
  type AuthorCatalogChildDescriptorV1,
  type AuthorCatalogDirectoryNodeV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import {
  Rfc64ControlEnvelopeSigningErrorV1,
  signAndVerifyRfc64ControlEnvelopeV1,
  type Rfc64ControlEnvelopeEip191SignerV1,
} from './control-envelope-signer-v1.js';

export const RFC64_AUTHOR_CATALOG_PRODUCTION_ERROR_CODES_V1 = Object.freeze([
  'catalog-production-input',
  'catalog-production-history',
  'catalog-production-path',
  'catalog-production-delta',
  'catalog-production-noop',
  'catalog-production-signer',
] as const);

export type Rfc64AuthorCatalogProductionErrorCodeV1 =
  (typeof RFC64_AUTHOR_CATALOG_PRODUCTION_ERROR_CODES_V1)[number];

export class Rfc64AuthorCatalogProductionErrorV1 extends Error {
  constructor(
    readonly code: Rfc64AuthorCatalogProductionErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    if (!RFC64_AUTHOR_CATALOG_PRODUCTION_ERROR_CODES_V1.includes(code)) {
      throw new TypeError(`Unsupported RFC-64 author catalog production error code: ${code}`);
    }
    this.name = 'Rfc64AuthorCatalogProductionErrorV1';
  }
}

export type SnapshotEip191SignerV1 = Rfc64ControlEnvelopeEip191SignerV1;

export type PreparedReplacementBucketV1 =
  | {
      readonly bucket: null;
      readonly descriptor: AuthorCatalogBucketDescriptorV1;
      readonly rows: readonly AuthorCatalogRowV1[];
    }
  | {
      readonly bucket: {
        readonly unsigned: UnsignedControlEnvelopeV1;
        readonly objectDigest: Digest32V1;
      };
      readonly descriptor: AuthorCatalogBucketDescriptorV1;
      readonly rows: readonly AuthorCatalogRowV1[];
    };

export function prepareReplacementBucket(
  scope: AuthorCatalogScopeV1,
  selectedBucketId: DecimalU64V1,
  rows: readonly AuthorCatalogRowV1[],
  issuer: EvmAddressV1,
): PreparedReplacementBucketV1 {
  if (rows.length === 0) {
    return Object.freeze({
      bucket: null,
      descriptor: emptyBucketDescriptor(selectedBucketId),
      rows: Object.freeze([]),
    });
  }

  let payload: AuthorCatalogBucketV1;
  try {
    const candidate: AuthorCatalogBucketV1 = {
      catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
      era: scope.era,
      bucketCount: scope.bucketCount,
      bucketId: selectedBucketId,
      rows,
    };
    payload = parseCanonicalAuthorCatalogBucketPayloadV1(
      canonicalizeAuthorCatalogBucketPayloadBytesV1(candidate),
    );
    assertAuthorCatalogBucketScopeBindingV1(payload, scope);
  } catch (cause) {
    fail('catalog-production-input', 'replacement bucket is not canonical for this scope', cause);
  }

  const unsigned = eip191Unsigned(
    issuer,
    AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    freezePlainSnapshot(payload),
  );
  const objectDigest = computeAuthorCatalogBucketObjectDigestV1(unsigned);
  return Object.freeze({
    bucket: Object.freeze({ unsigned, objectDigest }),
    descriptor: Object.freeze({
      bucketDigest: objectDigest,
      bucketId: selectedBucketId,
      byteLength: canonicalizeAuthorCatalogBucketPayloadBytesV1(payload)
        .byteLength.toString() as DecimalU64V1,
      rowCount: payload.rows.length.toString() as DecimalU64V1,
    }),
    rows: payload.rows,
  });
}

export async function signPreparedReplacementBucket(
  prepared: PreparedReplacementBucketV1,
  signer: SnapshotEip191SignerV1,
): Promise<SignedAuthorCatalogBucketEnvelopeV1 | null> {
  if (prepared.bucket === null) return null;
  const signed = await signEnvelope(
    prepared.bucket.unsigned,
    prepared.bucket.objectDigest,
    signer,
    (value) => {
      assertSignedAuthorCatalogBucketEnvelopeV1(value);
    },
  );
  return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogBucketEnvelopeV1(
    canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(signed),
  )) as SignedAuthorCatalogBucketEnvelopeV1;
}

export async function signDirectoryNode(
  payload: AuthorCatalogDirectoryNodeV1,
  bucketCount: AuthorCatalogScopeV1['bucketCount'],
  signer: SnapshotEip191SignerV1,
): Promise<SignedAuthorCatalogDirectoryNodeEnvelopeV1> {
  const unsigned = eip191Unsigned(
    signer.issuer,
    AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    freezePlainSnapshot(payload),
  );
  const digest = computeAuthorCatalogDirectoryNodeObjectDigestV1(unsigned, bucketCount);
  const signed = await signEnvelope(unsigned, digest, signer, (value) => {
    assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(value, bucketCount);
  });
  return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1(
    canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(signed, bucketCount),
    bucketCount,
  )) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
}

export async function signHead(
  payload: AuthorCatalogHeadV1,
  signer: SnapshotEip191SignerV1,
): Promise<SignedAuthorCatalogHeadEnvelopeV1> {
  const unsigned = eip191Unsigned(
    signer.issuer,
    AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    freezePlainSnapshot(payload),
  );
  const digest = computeAuthorCatalogHeadObjectDigestV1(unsigned);
  const signed = await signEnvelope(unsigned, digest, signer, (value) => {
    assertSignedAuthorCatalogHeadEnvelopeV1(value);
  });
  return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(
    canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(signed),
  )) as SignedAuthorCatalogHeadEnvelopeV1;
}

async function signEnvelope(
  unsigned: UnsignedControlEnvelopeV1,
  objectDigest: Digest32V1,
  signer: SnapshotEip191SignerV1,
  assertSpecific: (value: SignedControlEnvelopeV1) => void,
): Promise<SignedControlEnvelopeV1> {
  try {
    const signed = await signAndVerifyRfc64ControlEnvelopeV1(
      unsigned,
      objectDigest,
      signer,
    );
    assertSpecific(signed.envelope);
    return signed.envelope;
  } catch (cause) {
    if (
      cause instanceof Rfc64ControlEnvelopeSigningErrorV1
      && cause.phase === 'callback'
    ) {
      fail('catalog-production-signer', `signer failed for ${unsigned.objectType}`, cause);
    }
    fail(
      'catalog-production-signer',
      `signer did not produce a canonical ${unsigned.objectType} signature for ${signer.issuer}`,
      cause,
    );
  }
}

export function snapshotHead(
  input: SignedAuthorCatalogHeadEnvelopeV1,
): SignedAuthorCatalogHeadEnvelopeV1 {
  try {
    return freezePlainSnapshot(parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(
      canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(input),
    )) as SignedAuthorCatalogHeadEnvelopeV1;
  } catch (cause) {
    fail('catalog-production-input', 'previous head is not one canonical snapshot', cause);
  }
}

export function snapshotRows(input: readonly AuthorCatalogRowV1[]): readonly AuthorCatalogRowV1[] {
  const length = input.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > 1024) {
    fail('catalog-production-input', 'nextRows is outside the 0..1024 bucket-row bound');
  }
  const snapshot: AuthorCatalogRowV1[] = [];
  try {
    for (let index = 0; index < length; index += 1) {
      const rowInput = input[index];
      const transferInput = rowInput.transfer;
      const row = {
        kaId: rowInput.kaId,
        assertionCoordinate: rowInput.assertionCoordinate,
        assertionVersion: rowInput.assertionVersion,
        projectionId: rowInput.projectionId,
        projectionDigest: rowInput.projectionDigest,
        sealDigest: rowInput.sealDigest,
        transfer: {
          codec: transferInput.codec,
          projectionId: transferInput.projectionId,
          projectionDigest: transferInput.projectionDigest,
          byteLength: transferInput.byteLength,
          chunkSize: transferInput.chunkSize,
          chunkCount: transferInput.chunkCount,
          blobDigest: transferInput.blobDigest,
          chunkTreeRoot: transferInput.chunkTreeRoot,
        },
      } as AuthorCatalogRowV1;
      snapshot.push(freezePlainSnapshot(parseCanonicalAuthorCatalogRowV1(
        canonicalizeAuthorCatalogRowV1(row),
      )));
    }
  } catch (cause) {
    fail('catalog-production-input', 'nextRows is not one canonical row snapshot', cause);
  }
  return Object.freeze(snapshot);
}

export function snapshotSigner(input: Rfc64ControlEnvelopeEip191SignerV1): SnapshotEip191SignerV1 {
  const issuer = input.issuer;
  const signDigest = input.signDigest;
  if (typeof signDigest !== 'function') {
    fail('catalog-production-input', 'catalog signer must expose signDigest');
  }
  return Object.freeze({ issuer, signDigest });
}

export function assertEip191Issuer(
  envelope: SignedControlEnvelopeV1,
  issuer: EvmAddressV1,
  label: string,
): void {
  if (
    envelope.issuer !== issuer
    || envelope.signatureSuite !== 'eip191-personal-sign-digest-v1'
    || envelope.signatureEvidence.kind !== 'none'
  ) {
    fail(
      'catalog-production-history',
      `${label} must use the same EIP-191 catalog issuer as the successor signer`,
    );
  }
}

export async function verifyExistingSignature(
  envelope: SignedControlEnvelopeV1,
  label: string,
): Promise<void> {
  try {
    await verifyControlEnvelopeIssuerSignatureV1(envelope);
  } catch (cause) {
    fail('catalog-production-history', `${label} signature is not valid`, cause);
  }
}

function eip191Unsigned(
  issuer: EvmAddressV1,
  objectType: string,
  payload: unknown,
): UnsignedControlEnvelopeV1 {
  return freezePlainSnapshot({
    issuer,
    objectType,
    payload: payload as UnsignedControlEnvelopeV1['payload'],
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedControlEnvelopeV1;
}

function emptyBucketDescriptor(
  bucketId: DecimalU64V1,
): AuthorCatalogBucketDescriptorV1 {
  return Object.freeze({
    bucketDigest: ZERO_DIGEST32_V1,
    bucketId,
    byteLength: '0' as DecimalU64V1,
    rowCount: '0' as DecimalU64V1,
  });
}

export function childDescriptor(
  child: SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  bucketCount: AuthorCatalogScopeV1['bucketCount'],
): AuthorCatalogChildDescriptorV1 {
  let rowCount = 0n;
  for (let index = 0; index < child.payload.entries.length; index += 1) {
    rowCount += BigInt(child.payload.entries[index].rowCount);
    if (rowCount > MAX_DECIMAL_U64) {
      fail('catalog-production-path', 'rebuilt child rowCount exceeds DecimalU64V1');
    }
  }
  const firstBucketId = BigInt(child.payload.firstBucketId);
  const childCoverage = directoryPower(BigInt(child.payload.level) + 1n);
  const remaining = BigInt(bucketCount) - firstBucketId;
  const bucketSpan = remaining < childCoverage ? remaining : childCoverage;
  return Object.freeze({
    firstBucketId: child.payload.firstBucketId,
    bucketSpan: bucketSpan.toString() as DecimalU64V1,
    rowCount: rowCount.toString() as DecimalU64V1,
    byteLength: canonicalizeAuthorCatalogDirectoryNodePayloadBytesV1(
      child.payload,
      bucketCount,
    ).byteLength.toString() as DecimalU64V1,
    childDigest: child.objectDigest as Digest32V1,
  });
}

export function directoryPower(exponent: bigint): bigint {
  let result = 1n;
  for (let index = 0n; index < exponent; index += 1n) {
    result *= AUTHOR_CATALOG_DIRECTORY_FANOUT_V1;
  }
  return result;
}

export function freezePlainSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      freezePlainSnapshot(value[index]);
    }
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    freezePlainSnapshot((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export function normalizePublicError(message: string, cause: unknown): never {
  if (cause instanceof Rfc64AuthorCatalogProductionErrorV1) throw cause;
  fail('catalog-production-input', message, cause);
}

export function fail(
  code: Rfc64AuthorCatalogProductionErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64AuthorCatalogProductionErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
