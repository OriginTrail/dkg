import {
  snapshotSwmAuthorInventoryRowV1,
  snapshotSwmAuthorInventoryRowsV1,
  type SwmAuthorInventoryRowV1,
} from '@origintrail-official/dkg-core';

export function validateInventoryInputs(rowInput: unknown, rowsInput: unknown): void {
  const row: SwmAuthorInventoryRowV1 = snapshotSwmAuthorInventoryRowV1(rowInput);
  const rows: readonly SwmAuthorInventoryRowV1[] = snapshotSwmAuthorInventoryRowsV1(rowsInput);
  // @ts-expect-error Validated snapshots remain immutable to callers.
  row.shareOperationId = 'changed';
  // @ts-expect-error Validated row sets remain immutable to callers.
  rows.push(row);
}
