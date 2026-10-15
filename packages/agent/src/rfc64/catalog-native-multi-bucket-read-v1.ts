// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3134 — provider-side reads under a signed head of more than one bucket.
 *
 * A one-bucket head is closed eagerly by the scoped read provider: its root, its bucket and every
 * row's bundle are proven before the first read. A head of up to 131,072 rows is not: its whole
 * directory is read and checked against the head up front (one node up to 256 buckets), and a
 * bucket is proven, with one row-authorship proof over its path, the first time it or a bundle in
 * it is asked for. A bundle names no bucket, so it is placed by the KA its seal names: the bucket
 * of that KA must hold a row whose bundle digest and length are the bundle's. Proven buckets are
 * kept for a few reads only, so the memory of a read capability stays bounded.
 */

import {
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogBucketScopeBindingV1,
  assertAuthorCatalogDirectoryNodeScopeBindingV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  catalogKeyToBucketIdV1,
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogScopeV1,
  type DecimalU64V1,
  type Digest32V1,
  type KaIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import type { VerifiedControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { verifyAuthorCatalogRowAuthorshipV1 } from './catalog-row-authorship.js';
import type { Rfc64ControlObjectOperationsV1 } from './control-object-store-v1.js';
import type { Rfc64KaBundleOperationsV1 } from './ka-bundle-store-v1.js';
import type { Rfc64CatalogNativeScopedReadCapabilityV1 } from './public-catalog-native-transport-v1.js';

/** Proven buckets kept by one read capability: a bucket outside them is proven again. */
const PROVEN_BUCKETS_KEPT_V1 = 16;

interface StoredV1<T extends SignedControlEnvelopeV1> {
  readonly envelope: T;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

interface ProvenBucketV1 {
  readonly envelope: SignedAuthorCatalogBucketEnvelopeV1;
  /** Bundle digest to its signed byte length. */
  readonly bundles: ReadonlyMap<string, number>;
}

export interface MultiBucketHeadReadsInputV1 {
  readonly controlObjects: Pick<Rfc64ControlObjectOperationsV1, 'getVerifiedObjectByDigest'>;
  readonly kaBundles: Pick<Rfc64KaBundleOperationsV1, 'readKaBundleByDigest'>;
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
  readonly head: StoredV1<SignedAuthorCatalogHeadEnvelopeV1>;
  readonly delegation: StoredV1<SignedAuthorCatalogIssuerDelegationEnvelopeV1>;
  readonly catalogScope: Readonly<AuthorCatalogScopeV1>;
  /** The accepted-current policy check every read repeats first. */
  readonly requireCurrent: () => Promise<void>;
  readonly onAuthorCatalogBucketProof?: () => void;
}

/** The two reads of a scoped read capability under a head of more than one bucket. */
export async function openMultiBucketHeadReadsV1(
  input: MultiBucketHeadReadsInputV1,
): Promise<Pick<Rfc64CatalogNativeScopedReadCapabilityV1, 'readCatalogObjectByDigest' | 'readKaBundleByDigest'>> {
  const head = input.head.envelope;
  const { bucketCount } = head.payload;
  const nodes = new Map<string, StoredV1<SignedAuthorCatalogDirectoryNodeEnvelopeV1>>();
  /** Every non-empty bucket: its descriptor and the path from the root to it. */
  const buckets = new Map<string, Readonly<{
    descriptor: Readonly<AuthorCatalogBucketDescriptorV1>;
    path: readonly StoredV1<SignedAuthorCatalogDirectoryNodeEnvelopeV1>[];
  }>>();
  const bucketIdByDigest = new Map<string, DecimalU64V1>();
  let rows = 0n;
  const walk = async (
    objectDigest: Digest32V1,
    above: readonly StoredV1<SignedAuthorCatalogDirectoryNodeEnvelopeV1>[],
  ): Promise<void> => {
    if (above.length > 7) throw new Error('catalog directory is deeper than its head allows');
    const stored = await readNodeV1(input, objectDigest);
    nodes.set(objectDigest, stored);
    const path = [...above, stored];
    for (const entry of stored.envelope.payload.entries) {
      if (entry.rowCount === '0') continue;
      if (!('bucketId' in entry)) {
        await walk(entry.childDigest, path);
        continue;
      }
      rows += BigInt(entry.rowCount);
      buckets.set(entry.bucketId, Object.freeze({ descriptor: entry, path: Object.freeze(path) }));
      bucketIdByDigest.set(entry.bucketDigest, entry.bucketId);
    }
  };
  await walk(head.payload.directoryRootDigest, []);
  if (rows.toString() !== head.payload.totalRows) {
    throw new Error('catalog directory row count differs from its head');
  }

  const proven = new Map<string, ProvenBucketV1>();
  const proveBucket = async (bucketId: DecimalU64V1): Promise<ProvenBucketV1 | null> => {
    const known = proven.get(bucketId);
    if (known !== undefined) {
      proven.delete(bucketId);
      proven.set(bucketId, known);
      return known;
    }
    const placed = buckets.get(bucketId);
    if (placed === undefined) return null;
    const pathEnvelopes = placed.path.map((node) => node.envelope);
    const proof = verifyAuthorCatalogDirectoryPathV1(head, pathEnvelopes, bucketId);
    const descriptor = readVerifiedAuthorCatalogBucketDescriptorV1(proof, head);
    if (descriptor.bucketDigest !== placed.descriptor.bucketDigest || descriptor.bucketDigest === ZERO_DIGEST32_V1) {
      throw new Error('catalog bucket descriptor differs from its verified path');
    }
    const stored = await input.controlObjects.getVerifiedObjectByDigest({
      objectDigest: descriptor.bucketDigest,
      verifyIssuerSignature: input.verifyIssuerSignature,
    });
    if (stored === null) return null;
    assertSignedAuthorCatalogBucketEnvelopeV1(stored.envelope);
    const bucket = stored.envelope;
    assertAuthorCatalogBucketScopeBindingV1(bucket.payload, input.catalogScope);
    if (
      bucket.objectDigest !== descriptor.bucketDigest
      || bucket.issuer !== head.issuer
      || bucket.payload.bucketId !== bucketId
      || bucket.payload.rows.length.toString() !== descriptor.rowCount
      || canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength.toString()
        !== descriptor.byteLength
    ) {
      throw new Error('stored bucket differs from the exact signed directory/head closure');
    }
    // One proof over the bucket's path authenticates the delegation, head, path and every row.
    verifyAuthorCatalogRowAuthorshipV1({
      catalogIssuerDelegation: input.delegation.envelope,
      catalogIssuerDelegationSignature: input.delegation.issuerSignature,
      parentAuthorAgentEvidence: null,
      catalogHead: head,
      catalogHeadSignature: input.head.issuerSignature,
      directoryPathEnvelopes: pathEnvelopes,
      directoryPathSignatures: placed.path.map((node) => node.issuerSignature),
      directoryPathProof: proof,
      catalogBucket: bucket,
      catalogBucketSignature: stored.issuerSignature,
      targetKaId: bucket.payload.rows[0]!.kaId,
    });
    input.onAuthorCatalogBucketProof?.();
    const bundles = new Map<string, number>();
    for (const row of bucket.payload.rows) {
      const byteLength = Number(BigInt(row.transfer.byteLength));
      const previous = bundles.get(row.transfer.blobDigest);
      if (previous !== undefined && previous !== byteLength) {
        throw new Error('one bundle digest is committed with conflicting byte lengths');
      }
      bundles.set(row.transfer.blobDigest, byteLength);
    }
    const result = Object.freeze({ envelope: bucket, bundles });
    proven.set(bucketId, result);
    if (proven.size > PROVEN_BUCKETS_KEPT_V1) proven.delete(proven.keys().next().value!);
    return result;
  };

  const fixed = new Map<string, Readonly<{ objectType: string; envelope: SignedControlEnvelopeV1 }>>([
    [head.objectDigest, { objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1, envelope: head }],
    [input.delegation.envelope.objectDigest, {
      objectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
      envelope: input.delegation.envelope,
    }],
  ]);
  return Object.freeze({
    readCatalogObjectByDigest: async (objectDigest: Digest32V1) => {
      await input.requireCurrent();
      const bucketId = bucketIdByDigest.get(objectDigest);
      if (bucketId !== undefined) return (await proveBucket(bucketId))?.envelope ?? null;
      const known = fixed.get(objectDigest) ?? (nodes.has(objectDigest)
        ? { objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1, envelope: nodes.get(objectDigest)!.envelope }
        : undefined);
      if (known === undefined) return null;
      const stored = await input.controlObjects.getVerifiedObjectByDigest({
        objectDigest,
        verifyIssuerSignature: input.verifyIssuerSignature,
      });
      if (
        stored === null
        || stored.envelope.objectDigest !== objectDigest
        || stored.envelope.objectType !== known.objectType
      ) {
        throw new Error('stored catalog closure changed after capability resolution');
      }
      return stored.envelope;
    },
    readKaBundleByDigest: async (blobDigest: Digest32V1) => {
      await input.requireCurrent();
      const bundle = await input.kaBundles.readKaBundleByDigest(blobDigest);
      if (bundle === null) return null;
      let kaId: KaIdV1;
      try {
        const decoded = decodeOpaqueKaBundleV1(bundle);
        if (decoded.blobDigest !== blobDigest) return null;
        kaId = parseCanonicalGraphScopedAuthorSealV1(decoded.sealBytes).reservedKaId as KaIdV1;
      } catch {
        // Not a bundle any catalog row can name.
        return null;
      }
      const bucket = await proveBucket(catalogKeyToBucketIdV1(kaId, bucketCount));
      const byteLength = bucket?.bundles.get(blobDigest);
      if (byteLength === undefined) return null;
      if (bundle.byteLength !== byteLength) {
        throw new Error('stored KA bundle differs from the exact signed catalog row');
      }
      return bundle;
    },
  });
}

async function readNodeV1(
  input: MultiBucketHeadReadsInputV1,
  objectDigest: Digest32V1,
): Promise<StoredV1<SignedAuthorCatalogDirectoryNodeEnvelopeV1>> {
  const head = input.head.envelope;
  const stored = await input.controlObjects.getVerifiedObjectByDigest({
    objectDigest,
    verifyIssuerSignature: input.verifyIssuerSignature,
  });
  if (stored === null) throw new Error('catalog directory node is not stored');
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(stored.envelope, head.payload.bucketCount);
  assertAuthorCatalogDirectoryNodeScopeBindingV1(stored.envelope.payload, input.catalogScope);
  if (stored.envelope.objectDigest !== objectDigest || stored.envelope.issuer !== head.issuer) {
    throw new Error('catalog directory identity or issuer differs from its head');
  }
  return stored as StoredV1<SignedAuthorCatalogDirectoryNodeEnvelopeV1>;
}
