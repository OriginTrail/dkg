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

const SWM_AUTHOR_INVENTORY_ERROR_CODES_V1 = new Set<SwmAuthorInventoryErrorCodeV1>([
  'swm-inventory-input',
  'swm-inventory-cas-conflict',
  'swm-inventory-database-corrupt',
]);

export function isSwmAuthorInventoryErrorCodeV1(
  value: unknown,
): value is SwmAuthorInventoryErrorCodeV1 {
  return typeof value === 'string'
    && SWM_AUTHOR_INVENTORY_ERROR_CODES_V1.has(value as SwmAuthorInventoryErrorCodeV1);
}

export function isSwmAuthorInventoryErrorV1(
  value: unknown,
  code?: SwmAuthorInventoryErrorCodeV1,
): value is Error & { readonly code: SwmAuthorInventoryErrorCodeV1 } {
  if (!(value instanceof Error) || !('code' in value)) return false;
  const actual = (value as Error & { readonly code?: unknown }).code;
  return isSwmAuthorInventoryErrorCodeV1(actual)
    && (code === undefined || actual === code);
}

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
