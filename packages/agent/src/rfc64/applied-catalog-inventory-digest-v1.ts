// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalDigest,
  parseCanonicalDecimalU64,
  type CountV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';
import { sha256 } from '@noble/hashes/sha2.js';
import { ethers } from 'ethers';

import {
  computeRfc64AppliedInventoryDigestV1,
  type ComputeRfc64AppliedInventoryDigestInputV1,
} from './public-catalog-inventory-completeness-v1.js';

const UTF8 = new TextEncoder();
const DIRECTORY_INVENTORY_DIGEST_DOMAIN_V1 = 'dkg-rfc64-applied-inventory-directory-v1\n';

/** The signed head fields a catalog of more than one bucket commits to its inventory with. */
export interface AppliedCatalogDirectoryV1 {
  readonly bucketCount: CountV1;
  readonly directoryRootDigest: Digest32V1;
  readonly totalRows: CountV1;
}

/**
 * GH#3134 — the applied-inventory commitment of an author catalog head.
 *
 * A one-bucket catalog keeps the flat commitment of {@link computeRfc64AppliedInventoryDigestV1},
 * byte for byte: a hash over every row's row, content and seal digests, UAL and triple count.
 * Each of those is bound by the catalog's signed rows (the seal digest binds the UAL and the
 * counts), and a signed head's directory root commits to every bucket of rows. A catalog of more
 * than one bucket therefore commits to its inventory through its head: a successor does not hash
 * every row again, and a move to more buckets reads no row's bundle. The commitment is local (the
 * applied-head record and completion diagnostics); it is never sent to a peer.
 */
export function computeRfc64CatalogAppliedInventoryDigestV1(
  input: ComputeRfc64AppliedInventoryDigestInputV1 & Readonly<{ directory: AppliedCatalogDirectoryV1 }>,
): Digest32V1 {
  const { bucketCount, directoryRootDigest, totalRows } = input.directory;
  if (bucketCount === '1') {
    return computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: input.catalogScopeDigest,
      rows: input.rows,
    });
  }
  assertCanonicalDigest(input.catalogScopeDigest, 'catalogScopeDigest');
  assertCanonicalDigest(directoryRootDigest, 'directoryRootDigest');
  const rowCount = parseCanonicalDecimalU64(totalRows, 'totalRows');
  const hasher = sha256.create();
  hasher.update(UTF8.encode(DIRECTORY_INVENTORY_DIGEST_DOMAIN_V1));
  hasher.update(ethers.getBytes(input.catalogScopeDigest));
  hasher.update(ethers.getBytes(directoryRootDigest));
  const count = new Uint8Array(8);
  new DataView(count.buffer).setBigUint64(0, rowCount, false);
  hasher.update(count);
  return ethers.hexlify(hasher.digest()) as Digest32V1;
}
