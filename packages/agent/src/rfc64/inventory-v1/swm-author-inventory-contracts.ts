import type {
  Digest32V1,
  SwmAuthorInventoryRowV1,
  SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';

/** Error codes owned by the durable SWM author-inventory boundary. */
export type SwmAuthorInventoryErrorCodeV1 =
  | 'swm-inventory-input'
  | 'swm-inventory-cas-conflict'
  | 'swm-inventory-database-corrupt';

export type SwmAuthorInventoryMutationV1 =
  | { readonly kind: 'upsert'; readonly row: SwmAuthorInventoryRowV1 }
  | { readonly kind: 'remove'; readonly kaUal: SwmAuthorInventoryRowV1['kaUal'] };

export interface CompareAndSwapSwmAuthorInventoryInputV1 {
  readonly snapshot: SwmAuthorInventorySnapshotV1;
  readonly mutation: SwmAuthorInventoryMutationV1;
  /** `null` initializes version 0; otherwise the exact current head must match. */
  readonly expectedCurrentHeadDigest: Digest32V1 | null;
}

export interface SwmAuthorInventoryCasResultV1 {
  readonly status: 'applied' | 'existing';
  readonly snapshot: SwmAuthorInventorySnapshotV1;
}
