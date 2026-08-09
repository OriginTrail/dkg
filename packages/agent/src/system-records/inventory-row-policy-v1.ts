// SPDX-License-Identifier: Apache-2.0

import type {
  SystemRecordInventoryRowV1,
} from '@origintrail-official/dkg-core/system-record-v1';

export function isOrdinaryActiveInventoryRowV1(
  row: SystemRecordInventoryRowV1,
): boolean {
  return !row.tombstone
    && !row.quarantined
    && row.conflictEvidenceDigest === undefined;
}
