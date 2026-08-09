import { snapshotSystemRecordDataRecordV1 } from './system-record-input-guards-v1-internal.js';
import type {
  SystemRecordMaterializationEpochRotationV1,
} from './system-record-materialization-epoch-contract-v1.js';

/**
 * Snapshot an untrusted epoch rotation result through the canonical plain-data
 * guard. Extra data fields are permitted by the structural handoff interface
 * and discarded here. `undefined` means no valid binding; callers distinguish
 * the legacy absent case from a malformed non-undefined value and fail the
 * latter closed.
 */
export function snapshotSystemRecordMaterializationEpochRotationV1(
  value: unknown,
): SystemRecordMaterializationEpochRotationV1 | undefined {
  let record: Readonly<Record<string, unknown>>;
  try {
    record = snapshotSystemRecordDataRecordV1(
      value,
      'system-record materialization epoch rotation',
    );
  } catch {
    return undefined;
  }
  if (typeof record.epoch !== 'string' || typeof record.childGeneration !== 'string') {
    return undefined;
  }
  return Object.freeze({
    epoch: record.epoch,
    childGeneration: record.childGeneration,
  });
}
