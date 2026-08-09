import { types as utilTypes } from 'node:util';
import type {
  SystemRecordMaterializationEpochRotationV1,
  SystemRecordMaterializationEpochRotationSnapshotV1,
} from './system-record-materialization-epoch-contract-v1.js';

const ABSENT = Object.freeze({ kind: 'absent' } as const);
const MALFORMED = Object.freeze({ kind: 'malformed' } as const);

/**
 * Snapshot the structural handoff result without invoking caller code.
 *
 * The public contract permits class instances and extra metadata, so this reads
 * only the two required own data descriptors. Proxies and accessors are
 * rejected. Absence and malformed input remain distinct modeled states.
 */
export function snapshotSystemRecordMaterializationEpochRotationV1(
  value: unknown,
): SystemRecordMaterializationEpochRotationSnapshotV1 {
  if (value === undefined) return ABSENT;
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return MALFORMED;
  }
  const epoch = Object.getOwnPropertyDescriptor(value, 'epoch');
  const childGeneration = Object.getOwnPropertyDescriptor(value, 'childGeneration');
  if (
    !epoch ||
    !childGeneration ||
    !Object.prototype.hasOwnProperty.call(epoch, 'value') ||
    !Object.prototype.hasOwnProperty.call(childGeneration, 'value') ||
    typeof epoch.value !== 'string' ||
    typeof childGeneration.value !== 'string'
  ) {
    return MALFORMED;
  }
  return Object.freeze({
    kind: 'rotation',
    value: Object.freeze({
      epoch: epoch.value,
      childGeneration: childGeneration.value,
    }),
  });
}
