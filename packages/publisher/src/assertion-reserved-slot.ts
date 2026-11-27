// SPDX-License-Identifier: Apache-2.0
import { MAX_ROOTLESS_KA_NUMBER_V1 } from '@origintrail-official/dkg-core';
import type { AssertionLifecycleRecord } from './assertion-lifecycle-record.js';

/** The author is already bound by the lifecycle coordinate; validate its slot. */
export function assertExpectedKaSlotMatchesAllocation(expected: bigint | undefined, actual: bigint | undefined): void {
  if (expected !== undefined && (typeof expected !== 'bigint' || expected < 0n || expected > MAX_ROOTLESS_KA_NUMBER_V1 || expected !== actual)) {
    throw Object.assign(new Error('Requested KA reservation does not match the lifecycle slot'), { code: 'KA_RESERVED_ID_MISMATCH' });
  }
}

/** Consume the record loaded under the lifecycle write lock. */
export function assertExpectedKaSlotMatchesLifecycle(record: AssertionLifecycleRecord, expected: bigint | undefined): void {
  if (expected === undefined) return;
  assertExpectedKaSlotMatchesAllocation(expected, expected);
  if (record.bindings.length > 0) assertExpectedKaSlotMatchesAllocation(expected, record.number);
}
