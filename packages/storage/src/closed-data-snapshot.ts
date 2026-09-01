/** Storage policies over the canonical closed-data reflection primitives. */
import {
  isClosedDataRecord,
  readOwnEnumerableDataProperty,
  snapshotDenseDataArray,
  snapshotExactDataRecord,
  type ClosedDataReject,
} from '@origintrail-official/dkg-core/closed-data-snapshot';

export {
  readOwnEnumerableDataProperty,
  snapshotDenseDataArray,
  type ClosedDataReject,
};

export function isOrdinaryDataRecord(input: unknown): input is Record<string, unknown> {
  return isClosedDataRecord(input, 'ordinary-only');
}

/** Snapshot an exact plain data record through the same closed-data boundary. */
export function snapshotExactOrdinaryDataRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
  reject: ClosedDataReject,
): Readonly<Record<string, unknown>> {
  return snapshotExactDataRecord(input, expectedKeys, label, {
    prototypePolicy: 'ordinary-only',
    reject,
  });
}
