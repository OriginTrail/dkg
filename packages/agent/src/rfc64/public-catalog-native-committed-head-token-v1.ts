// SPDX-License-Identifier: Apache-2.0

import type { Digest32V1 } from '@origintrail-official/dkg-core';

/** Exact durable-head evidence created only after the receiver's durable post-read. */
export interface Rfc64PublicCatalogNativeCommittedHeadTokenV1 {
  readonly kind: 'rfc64-public-catalog-native-committed-head-token-v1';
  readonly catalogHeadDigest: Digest32V1;
  readonly inventoryDigest: Digest32V1;
}
